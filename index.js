/**
 * dsh-vscode-breakpoints — put VS Code breakpoints on every block this branch
 * changed against a base revision, for the workspace that is already open.
 *
 * Why it restarts the editor: breakpoints live in the workspace-state SQLite
 * database (`state.vscdb`, key `debug.breakpoint`) and VS Code only reads it at
 * startup. Writing while it runs is pointless — the in-memory state wins on exit
 * — so the flow is: terminate the editor, write the database, relaunch the same
 * windows. That whole sequence runs in a detached helper (`lib/apply.mjs`) so it
 * still finishes even if the agent that spawned it is restarted with the editor.
 *
 * No npm dependencies: Node built-ins plus the Host services `tools` and
 * `subprocess`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-vscode-breakpoints'
export const inject = ['tools', 'subprocess']

const HELPER = fileURLToPath(new URL('./lib/apply.mjs', import.meta.url))
const require = createRequire(import.meta.url)

/** Code files worth putting breakpoints in. */
const CODE_EXTENSIONS = new Set([
  '.py', '.pyi',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.ipp',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.sh', '.lua',
])

/**
 * How to recognise the editor's own processes (never matches unrelated `code`
 * such as `opencode`). Plain POSIX extended regex: `pgrep -f` rejects `(?:...)`.
 */
export const EDITOR_PATTERN =
  '/usr/share/code/code|/snap/code/|/opt/visual-studio-code|/usr/share/code-insiders|code-insiders|VSCodium|vscodium'

/**
 * First line of a top-level block (new files only). Never used as a breakpoint
 * line itself — resolveLine() steps into the body.
 */
const BLOCK_OPENER_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|function|func|class|struct|impl|namespace|template|interface)\b/

const DOCSTRING_PREFIXES = ['"""', "'''", 'r"""', "r'''", 'R"""', "R'''"]

/**
 * Fallback for new files that define no function or class at all (data modules,
 * config tables): their top-level statements are the blocks worth stopping at.
 */
const TOP_LEVEL_STATEMENT_RE =
  /^(?:assert\s|if\s|for\s|while\s|with\s|try\s*:|raise\s|return\s|[A-Za-z_][\w.]*\s*(?::[^=]+)?=(?!=))/

const COMMENT_PREFIXES = ['#', '//', '/*', '*', '--']
const DEFAULT_TIMEOUT_MS = 20000
const STATUS_POLL_MS = 250

let sqliteCtor = null

function databaseSync() {
  if (sqliteCtor === null) {
    try {
      sqliteCtor = require('node:sqlite').DatabaseSync
    } catch (error) {
      throw new Error(
        'vscode_breakpoints: this Node runtime has no usable node:sqlite module (Node 22.5+ is required): ' +
          `${error.message}`,
      )
    }
  }
  return sqliteCtor
}

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['set', 'list', 'clear'],
      description:
        'set (default) replaces every breakpoint in this workspace with one per changed block; list reports what is there now; clear removes them all.',
    },
    base: {
      type: 'string',
      description: "Git revision to diff against. Defaults to the plugin config's base, else 'master'.",
    },
    cwd: {
      type: 'string',
      description: 'Project directory. Absolute, or relative to the session working directory.',
    },
    includeUntracked: {
      type: 'boolean',
      description: 'Also mark files that are new in this branch (one breakpoint per top-level block). Defaults to true.',
    },
    exclude: {
      type: 'array',
      items: { type: 'string' },
      description: 'Path substrings to skip, e.g. ["migrations/", "third_party/"].',
    },
    restart: {
      type: 'boolean',
      description:
        'Terminate the running editor, apply, then relaunch it with the same windows. Defaults to true; pass false when the editor is already closed.',
    },
    dryRun: {
      type: 'boolean',
      description: 'Compute and report the breakpoints without touching the editor or the database.',
    },
  },
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['set', 'list', 'clear'] },
    project: { type: 'string', description: 'Project directory the breakpoints belong to.' },
    storage: { type: 'string', description: 'VS Code workspace-state directory that was used.' },
    base: { type: 'string', description: 'Revision that was diffed against (empty for list/clear).' },
    total: { type: 'number', description: 'How many breakpoints this run produced.' },
    files: {
      type: 'array',
      description: 'Per-file breakpoint lines.',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          lines: { type: 'array', items: { type: 'number' } },
        },
        required: ['file', 'lines'],
        additionalProperties: false,
      },
    },
    applied: { type: 'boolean', description: 'Whether the database was actually written.' },
    killed: { type: 'boolean', description: 'Whether a running editor was terminated.' },
    relaunched: { type: 'number', description: 'How many editor windows were reopened.' },
    dryRun: { type: 'boolean' },
    backup: { type: 'string', description: 'Path of the state.vscdb backup taken before writing.' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Warnings and skipped files.' },
  },
  required: ['action', 'project', 'storage', 'base', 'total', 'files', 'applied', 'killed', 'relaunched', 'dryRun', 'backup', 'notes'],
  additionalProperties: false,
}

function normalizeConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-vscode-breakpoints: config must be an object')
  }
  const base = raw.base ?? 'master'
  if (typeof base !== 'string' || base.trim() === '') {
    throw new Error('dsh-vscode-breakpoints: config.base must be a non-empty string')
  }
  // Overridable so unusual installs (and the self test) can point at their own
  // editor process name instead of the default Code/Insiders/VSCodium set.
  const editorPattern = raw.editorPattern ?? EDITOR_PATTERN
  if (typeof editorPattern !== 'string' || editorPattern.trim() === '') {
    throw new Error('dsh-vscode-breakpoints: config.editorPattern must be a non-empty string')
  }
  return { base: base.trim(), editorPattern: editorPattern.trim() }
}

function requireAction(args) {
  const value = args?.action ?? 'set'
  if (!['set', 'list', 'clear'].includes(value)) {
    throw new Error(`vscode_breakpoints: "action" must be set, list or clear (got ${JSON.stringify(value)})`)
  }
  return value
}

function stringList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('vscode_breakpoints: "exclude" must be an array of strings')
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error('vscode_breakpoints: "exclude" must be an array of strings')
    return item
  })
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

async function runCapture(ctx, argv, cwd) {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
  })
  const outcome = await handle.done
  return {
    exitCode: outcome.exitCode,
    stdout: handle.collected.stdout?.readFrom(0)?.text ?? '',
    stderr: handle.collected.stderr?.readFrom(0)?.text ?? '',
  }
}

function git(ctx, cwd, args) {
  return runCapture(ctx, ['git', '-C', cwd, '-c', 'core.quotePath=false', ...args], cwd)
}

async function gitOrThrow(ctx, cwd, args, hint) {
  const result = await git(ctx, cwd, args)
  if (result.exitCode !== 0) {
    throw new Error(
      `vscode_breakpoints: git ${args.join(' ')} failed in ${cwd}: ` +
        `${result.stderr.trim() || `exit ${result.exitCode}`}` +
        (hint === undefined ? '' : `\n${hint}`),
    )
  }
  return result.stdout
}

async function resolveProject(ctx, exec, requested) {
  if (requested !== undefined) {
    const target = isAbsolute(requested) ? requested : resolve(process.cwd(), requested)
    if (!existsSync(target)) throw new Error(`vscode_breakpoints: cwd "${target}" does not exist`)
    return target
  }
  const workingDirectory = ctx.get('workingDirectory', false)
  if (workingDirectory === undefined || exec.agent === undefined) {
    throw new Error('vscode_breakpoints: cannot resolve the session working directory; pass `cwd` explicitly')
  }
  return await workingDirectory.ensure(exec.agent, exec.signal)
}

// ---------------------------------------------------------------------------
// Workspace state discovery
// ---------------------------------------------------------------------------

function candidateUserDirs() {
  const home = homedir()
  const apps = ['Code', 'Code - OSS', 'Code - Insiders', 'VSCodium']
  const dirs = []
  if (process.platform === 'darwin') {
    for (const app of apps) dirs.push(join(home, 'Library', 'Application Support', app, 'User'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    for (const app of apps) dirs.push(join(appData, app, 'User'))
  } else {
    for (const app of apps) {
      dirs.push(join(home, '.config', app, 'User'))
      dirs.push(join(home, '.var', 'app', app, 'config', app, 'User')) // flatpak
    }
  }
  return dirs.filter((dir) => existsSync(join(dir, 'workspaceStorage')))
}

/** Decode `file:///...` (or a plain path) into an absolute filesystem path. */
function uriToPath(value) {
  if (typeof value !== 'string' || value === '') return undefined
  if (!value.startsWith('file://')) return value
  try {
    return fileURLToPath(value)
  } catch {
    return undefined
  }
}

function workspaceMatches(entry, project) {
  const folder = uriToPath(entry?.folder)
  if (folder !== undefined && resolve(folder) === project) return true
  const workspaceFile = uriToPath(entry?.workspace)
  if (workspaceFile === undefined || !existsSync(workspaceFile)) return false
  try {
    const parsed = JSON.parse(readFileSync(workspaceFile, 'utf8'))
    for (const item of Array.isArray(parsed.folders) ? parsed.folders : []) {
      const raw = typeof item === 'string' ? item : item?.path
      if (typeof raw !== 'string') continue
      const abs = isAbsolute(raw) ? raw : resolve(workspaceFile, '..', raw)
      if (resolve(abs) === project) return true
    }
  } catch {
    return false
  }
  return false
}

function findWorkspaceStorage(project) {
  const searched = []
  for (const userDir of candidateUserDirs()) {
    const root = join(userDir, 'workspaceStorage')
    searched.push(root)
    for (const hash of readdirSync(root)) {
      const entryPath = join(root, hash, 'workspace.json')
      if (!existsSync(entryPath)) continue
      let entry
      try {
        entry = JSON.parse(readFileSync(entryPath, 'utf8'))
      } catch {
        continue
      }
      if (!workspaceMatches(entry, project)) continue
      return { dir: join(root, hash), db: join(root, hash, 'state.vscdb'), userDir }
    }
  }
  throw new Error(
    `vscode_breakpoints: no VS Code workspace matches ${project}. ` +
      `Open that folder in VS Code at least once, then retry. Searched: ${searched.join(', ')}`,
  )
}

function readBreakpoints(dbPath) {
  if (!existsSync(dbPath)) return []
  const DatabaseSync = databaseSync()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'debug.breakpoint'").get()
    if (row === undefined || row.value === null) return []
    const parsed = JSON.parse(String(row.value))
    return Array.isArray(parsed) ? parsed : []
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Diff -> breakpoint lines
// ---------------------------------------------------------------------------

function isCodeFile(path) {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase())
}

/**
 * One entry per hunk: `-U0` gives exactly one hunk per contiguous change.
 * The hunk keeps its new-side range so the caller can tell whether *any* of the
 * added lines can hold a breakpoint (a changed comment block cannot).
 */
function parseDiff(diffText) {
  const plan = new Map()
  let current = null
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const marker = line.slice(4)
      current = marker === '/dev/null' ? null : marker.replace(/^b\//, '')
      continue
    }
    if (current === null || !line.startsWith('@@')) continue
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (match === null) continue
    const start = Number(match[1])
    const length = match[2] === undefined ? 1 : Number(match[2])
    if (!plan.has(current)) plan.set(current, [])
    // A pure deletion has no new-side line: mark the line it collapsed to.
    plan.get(current).push({ start: Math.max(start, 1), length })
  }
  return plan
}

/**
 * Lines that lie entirely inside a multi-line string / block comment. A diff
 * hunk can land on a file header docstring, which never runs.
 */
function blockLineFlags(lines, path) {
  const flags = new Array(lines.length).fill(false)
  const isPython = ['.py', '.pyi'].includes(extname(path).toLowerCase())
  const triples = ['"""', "'''"]
  let pyOpen = null
  let cOpen = false
  lines.forEach((text, index) => {
    if (isPython) {
      if (pyOpen === null) {
        let opened = null
        let offset = -1
        for (const token of triples) {
          const at = text.indexOf(token)
          if (at >= 0 && (offset < 0 || at < offset)) {
            offset = at
            opened = token
          }
        }
        // `"""..."""` on a single line is a complete expression, not a block.
        if (opened !== null && text.indexOf(opened, offset + 3) < 0) pyOpen = opened
        flags[index] = false
      } else {
        flags[index] = true
        if (text.indexOf(pyOpen) >= 0) pyOpen = null
      }
      return
    }
    if (cOpen) {
      flags[index] = true
      if (text.indexOf('*/') >= 0) cOpen = false
      return
    }
    const open = text.indexOf('/*')
    if (open >= 0 && text.indexOf('*/', open + 2) < 0) cOpen = true
    flags[index] = false
  })
  return flags
}

function indentOf(text) {
  return text.length - text.trimStart().length
}

/**
 * A line can carry a breakpoint only if the interpreter would actually run it:
 * not blank, not a comment, not inside a docstring / block comment, not a
 * decorator, and not the `def` / `class` line itself — that line only runs the
 * declaration, so stopping on it happens before the body ever executes.
 */
function skippable(text, inBlock) {
  if (inBlock) return true
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true
  if (DOCSTRING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true
  if (trimmed.startsWith('@')) return true
  return false
}

/** Next runnable line at or after `line`; walks backwards past a trailing comment. */
function nextRunnable(lines, flags, line) {
  for (let index = Math.max(line, 1); index <= lines.length; index += 1) {
    if (!skippable(lines[index - 1], flags[index - 1])) return index
  }
  for (let index = Math.min(line - 1, lines.length); index >= 1; index -= 1) {
    if (!skippable(lines[index - 1], flags[index - 1])) return index
  }
  return null
}

/**
 * Resolve a changed line into the line the breakpoint should sit on. When the
 * change *is* a new function or class, step into its body — the first line that
 * actually runs — instead of the declaration line.
 */
function resolveLine(lines, flags, line) {
  let resolved = nextRunnable(lines, flags, line)
  for (let guard = 0; resolved !== null && guard < 32; guard += 1) {
    const text = lines[resolved - 1]
    if (!BLOCK_OPENER_RE.test(text.trim())) break
    const bodyLine = nextRunnable(lines, flags, resolved + 1)
    if (bodyLine === null || indentOf(lines[bodyLine - 1]) <= indentOf(text)) break
    resolved = bodyLine
  }
  return resolved
}

/**
 * Start lines of every top-level block, for files that are new in this branch.
 * Returned values are already resolved to runnable body lines.
 */
function segmentStarts(lines, flags) {
  const openers = []
  lines.forEach((text, index) => {
    if (BLOCK_OPENER_RE.test(text.trim())) openers.push(index + 1)
  })
  if (openers.length === 0) {
    // Data/config modules without any function: their top-level statements are
    // the only blocks worth stopping at.
    lines.forEach((text, index) => {
      if (TOP_LEVEL_STATEMENT_RE.test(text)) openers.push(index + 1)
    })
  }
  const resolved = new Set()
  for (const line of openers) {
    const target = resolveLine(lines, flags, line)
    if (target !== null) resolved.add(target)
  }
  return [...resolved].sort((left, right) => left - right)
}

/** absolute path -> Set<line> */
async function buildPlan(ctx, project, base, includeUntracked, exclude, notes) {
  const root = (
    await gitOrThrow(ctx, project, ['rev-parse', '--show-toplevel'], 'Run the tool inside a git repository.')
  ).trim()

  const verify = await git(ctx, project, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  if (verify.exitCode !== 0) {
    throw new Error(
      `vscode_breakpoints: base revision "${base}" does not exist in ${root}. ` +
        'Pass base="<branch-or-sha>" (for example "origin/main" or "HEAD~1").',
    )
  }

  const diffText = await gitOrThrow(ctx, project, ['diff', base, '--unified=0', '--no-color'])
  const plan = new Map()
  const skipped = []
  let dropped = 0
  for (const [relPath, hunks] of parseDiff(diffText)) {
    if (!isCodeFile(relPath)) {
      skipped.push(relPath)
      continue
    }
    if (exclude.some((needle) => relPath.includes(needle))) continue
    const absPath = resolve(root, relPath)
    if (!existsSync(absPath)) continue
    const source = readFileSync(absPath, 'utf8').split('\n')
    const flags = blockLineFlags(source, absPath)
    const resolved = new Set()
    for (const hunk of hunks) {
      const added = []
      for (let index = hunk.start; index < hunk.start + Math.max(hunk.length, 1); index += 1) {
        if (index <= source.length) added.push(index)
      }
      // 整块都是注释/文档串（例如只改了文件头的时间戳）→ 打点没有意义
      const anchor = added.find((index) => !skippable(source[index - 1], flags[index - 1]))
      if (anchor === undefined) {
        dropped += 1
        continue
      }
      const target = resolveLine(source, flags, anchor)
      if (target !== null) resolved.add(target)
    }
    if (resolved.size === 0) continue
    plan.set(absPath, resolved)
  }
  if (dropped > 0) notes.push(`跳过 ${dropped} 处只有注释/文档串改动的 hunk`)
  if (skipped.length > 0) notes.push(`跳过 ${skipped.length} 个非代码文件: ${skipped.slice(0, 5).join(', ')}`)

  if (includeUntracked) {
    const untracked = await gitOrThrow(ctx, project, ['ls-files', '--others', '--exclude-standard'])
    for (const relPath of untracked.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
      if (!isCodeFile(relPath)) continue
      if (exclude.some((needle) => relPath.includes(needle))) continue
      const absPath = resolve(root, relPath)
      if (!existsSync(absPath)) continue
      const source = readFileSync(absPath, 'utf8').split('\n')
      const starts = segmentStarts(source, blockLineFlags(source, absPath))
      if (starts.length === 0) {
        notes.push(`新文件里没有可识别的代码块起点，跳过: ${relPath}`)
        continue
      }
      plan.set(absPath, new Set(starts))
    }
  }

  return { root, plan }
}

function toBreakpoints(plan) {
  const entries = []
  for (const [absPath, lines] of plan) {
    for (const line of [...lines].sort((left, right) => left - right)) {
      entries.push({
        id: randomUUID(),
        enabled: true,
        uri: {
          $mid: 1,
          fsPath: absPath,
          external: pathToFileURL(absPath).href,
          path: absPath,
          scheme: 'file',
        },
        lineNumber: line,
      })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Editor process handling
// ---------------------------------------------------------------------------

async function resolveEditorBin(ctx) {
  for (const candidate of ['code', 'code-insiders', 'codium']) {
    try {
      return await ctx.subprocess.resolveExecutable(candidate)
    } catch {
      /* try the next one */
    }
  }
  return undefined
}

/**
 * true / false, or undefined when this system cannot tell us. Only a clean
 * "no match" (exit 1) may be reported as false: treating a pgrep error as
 * "not running" would make the write silently useless.
 */
function editorRunning(pattern) {
  if (process.platform === 'win32') return undefined
  const out = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
  if (out.error !== undefined) return undefined
  if (out.status === 0) return true
  if (out.status === 1) return false
  return undefined
}

/**
 * Windows that were open, so the relaunch puts the user back where they were.
 *
 * Each entry is `{kind: 'folder' | 'workspace', uri}` and gets launched through
 * `--folder-uri` / `--file-uri`. Passing a bare `file:///.../project` without the
 * flag makes VS Code open it as a *text file* named like the folder, which is
 * exactly the bug this shape prevents.
 */
function collectWindows(userDir, project) {
  const found = []
  const add = (kind, uri) => {
    if (typeof uri !== 'string' || uri === '') return
    if (found.some((item) => item.uri === uri)) return
    found.push({ kind, uri })
  }
  const asUri = (value) => {
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object') {
      if (typeof value.external === 'string') return value.external
      if (typeof value.fsPath === 'string') return pathToFileURL(value.fsPath).href
    }
    return undefined
  }

  const storagePath = join(userDir, 'globalStorage', 'storage.json')
  if (existsSync(storagePath)) {
    let opened = []
    try {
      const parsed = JSON.parse(readFileSync(storagePath, 'utf8'))
      const state = parsed?.windowsState ?? {}
      opened = Array.isArray(state.openedWindows) ? [...state.openedWindows] : []
      if (opened.length === 0 && state.lastActiveWindow !== null && state.lastActiveWindow !== undefined) {
        opened = [state.lastActiveWindow]
      }
    } catch {
      opened = []
    }
    for (const item of opened) {
      const configPath =
        asUri(item?.workspace?.configPath) ??
        asUri(item?.workspaceIdentifier?.configURIPath) ??
        asUri(item?.workspace?.configURIPath)
      if (configPath !== undefined) {
        add('workspace', configPath)
        continue
      }
      const rawWorkspace = asUri(item?.workspace)
      if (rawWorkspace !== undefined) {
        add(rawWorkspace.endsWith('.code-workspace') ? 'workspace' : 'folder', rawWorkspace)
        continue
      }
      const folder = asUri(item?.folder) ?? asUri(item?.folderUri)
      // A window started as `code <some file>` carries only a backupPath: it has
      // no folder to restore, so it is deliberately skipped.
      if (folder !== undefined) add('folder', folder)
    }
  }

  if (found.length === 0) found.push({ kind: 'folder', uri: pathToFileURL(project).href })
  return found
}

/** argv for the editor CLI: explicit flags remove the folder/file ambiguity. */
function relaunchArgv(bin, window) {
  return [bin, window.kind === 'workspace' ? '--file-uri' : '--folder-uri', window.uri]
}

/** Run the detached helper and wait for its status file. */
async function spawnHelper(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-breakpoints-'))
  const payloadPath = join(dir, 'payload.json')
  const statusPath = join(dir, 'status.json')
  writeFileSync(payloadPath, JSON.stringify({ ...payload, statusPath }))
  spawn(process.execPath, [HELPER, payloadPath], { detached: true, stdio: 'ignore' }).unref()

  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const deadline = Date.now() + (payload.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5000
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) return JSON.parse(readFileSync(statusPath, 'utf8'))
    await sleep(STATUS_POLL_MS)
  }
  return { ok: false, reason: `后台写入未在超时内完成，状态文件: ${statusPath}` }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

function groupByFile(entries, root) {
  const grouped = new Map()
  for (const entry of entries) {
    const fsPath = entry?.uri?.fsPath ?? '(unknown)'
    const rel = fsPath.startsWith(`${root}/`) ? fsPath.slice(root.length + 1) : fsPath
    if (!grouped.has(rel)) grouped.set(rel, [])
    grouped.get(rel).push(entry.lineNumber)
  }
  return [...grouped].map(([file, lines]) => ({ file, lines: lines.sort((left, right) => left - right) }))
}

function renderResult(value) {
  const facts = [`vscode · ${value.action}`, `${value.total} 个断点`]
  if (value.killed) facts.push('已结束原窗口')
  if (value.relaunched > 0) facts.push(`重开 ${value.relaunched} 个窗口`)
  if (value.dryRun) facts.push('dry-run（未写入）')
  const lines = [facts.join(' · ')]
  for (const item of value.files) lines.push(`  ${item.file}: ${item.lines.join(', ')}`)
  for (const note of value.notes) lines.push(`  ! ${note}`)
  return lines.join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  ctx.effect(() =>
    ctx.tools.register({
      name: 'vscode_breakpoints',
      description: [
        'Set, list or clear VS Code breakpoints for the workspace of this project — the way to "给 diff 的每一处都打上断点" without clicking through the diff.',
        'action=set diffs the working tree against `base` (default master) and puts one breakpoint on the first code line of every changed block;',
        'files that are new in this branch get one breakpoint per top-level block.',
        'By default the tool terminates the running editor, writes the workspace-state database and relaunches the same windows,',
        'because VS Code reads breakpoints only at startup (unsaved buffers survive through hot exit).',
        'Use dryRun=true to preview the list, restart=false when the editor is already closed.',
      ].join(' '),
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (args, value) => [{ type: 'text', text: renderResult(value) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `vscode 断点 · ${args?.action ?? 'set'}`,
        kind: 'execute',
        rawInput: args,
      }),
      async execute(args, exec) {
        const action = requireAction(args)
        const project = await resolveProject(ctx, exec, args?.cwd)
        const storage = findWorkspaceStorage(project)
        const notes = []
        const dryRun = args?.dryRun === true

        if (action === 'list') {
          const existing = readBreakpoints(storage.db)
          return {
            action,
            project,
            storage: storage.dir,
            base: '',
            total: existing.length,
            files: groupByFile(existing, project),
            applied: false,
            killed: false,
            relaunched: 0,
            dryRun,
            backup: '',
            notes,
          }
        }

        const base = action === 'set' ? (args?.base ?? cfg.base).trim() : ''
        let entries = []
        let root = project
        if (action === 'set') {
          const built = await buildPlan(
            ctx,
            project,
            base,
            args?.includeUntracked !== false,
            stringList(args?.exclude),
            notes,
          )
          root = built.root
          entries = toBreakpoints(built.plan)
          if (entries.length === 0) notes.push(`与 ${base} 相比没有需要打点的代码改动`)
        }
        const files = groupByFile(entries, root)

        const running = editorRunning(cfg.editorPattern)
        const restart = args?.restart !== false
        if (running === undefined) {
          throw new Error(
            'vscode_breakpoints: 无法判断 VS Code 是否在运行（这台机器没有可用的 pgrep，或正则被拒）。' +
              '为避免写进去的断点被运行中的编辑器覆盖：先手动退出 VS Code，再带 restart=false 重试。',
          )
        }
        if (running === true && !restart) {
          throw new Error(
            'vscode_breakpoints: VS Code is running and restart=false, so the write would be discarded when it exits. ' +
              'Close the editor first, or leave restart at its default to let the tool restart it.',
          )
        }
        if (running === true && restart && dryRun) {
          notes.push('VS Code 正在运行：真正执行时会先结束它再重开')
        }

        if (dryRun) {
          return {
            action,
            project,
            storage: storage.dir,
            base,
            total: entries.length,
            files,
            applied: false,
            killed: false,
            relaunched: 0,
            dryRun,
            backup: '',
            notes,
          }
        }

        const bin = await resolveEditorBin(ctx)
        const relaunch = []
        if (running === true) {
          if (bin === undefined) {
            notes.push('找不到 code 可执行文件：只结束原窗口，需要你手动重新打开')
          } else {
            for (const window of collectWindows(storage.userDir, project)) {
              relaunch.push(relaunchArgv(bin, window))
            }
          }
        }

        const status = await spawnHelper({
          db: storage.db,
          pattern: cfg.editorPattern,
          kill: restart,
          breakpoints: entries,
          relaunch,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        })
        if (status.ok !== true) {
          throw new Error(
            `vscode_breakpoints: 后台写入失败：${status.reason ?? '未知原因'}` +
              (status.killed ? '\n编辑器进程可能已被结束，请手动重新打开。' : ''),
          )
        }
        if (typeof status.reason === 'string' && status.reason !== '') notes.push(status.reason)

        return {
          action,
          project,
          storage: storage.dir,
          base,
          total: entries.length,
          files,
          applied: status.applied === true,
          killed: status.killed === true,
          relaunched: status.relaunched ?? 0,
          dryRun: false,
          backup: `${storage.db}.before-bp.bak`,
          notes,
        }
      },
    }),
  )
}
