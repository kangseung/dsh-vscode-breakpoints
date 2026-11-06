/**
 * Self test: exercises the plugin end to end against a throwaway git repo, a
 * throwaway VS Code workspace-state database, and a fake "editor" process, so it
 * never touches the real editor or the real profile.
 *
 * Run with: node test/selftest.mjs
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-bp-selftest-'))
const home = join(sandbox, 'home')
const repo = join(sandbox, 'repo')
const userDir = join(home, '.config', 'Code', 'User')
const storageDir = join(userDir, 'workspaceStorage', 'deadbeefdeadbeefdeadbeefdeadbeef')
const dbPath = join(storageDir, 'state.vscdb')
const fakeEditor = join(sandbox, 'fake-code')
const relaunchLog = join(sandbox, 'relaunch.log')
const fakeEditorMarker = 'dsh-bp-selftest-editor-marker'

process.env.HOME = home

function git(args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...options })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

function sh(cwd, ...args) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function buildFixtures() {
  mkdirSync(repo, { recursive: true })
  git(['init', '-q', '-b', 'master'])
  const tracked = Array.from({ length: 60 }, (_, index) => `line_${index + 1} = ${index + 1}`)
  writeFileSync(join(repo, 'trading.py'), `${tracked.join('\n')}\n`)
  writeFileSync(join(repo, 'notes.md'), '# readme\n')
  git(['config', 'user.email', 'selftest@example.com'])
  git(['config', 'user.name', 'selftest'])
  git(['add', '-A'])
  git(['commit', '-qm', 'base'])

  // Two changed blocks: a single edited line and a three line insertion.
  const edited = [...tracked]
  edited[9] = 'line_10 = 999  # changed'
  const inserted = ['def helper():', '    return 42', '']
  const body = [...edited.slice(0, 30), ...inserted, ...edited.slice(30)]
  // Comments on the changed line must be skipped by advanceToCode.
  const finalText = body
  writeFileSync(join(repo, 'trading.py'), `${finalText.join('\n')}\n`)
  writeFileSync(join(repo, 'new_module.py'), 'def alpha():\n    return 1\n\n\nclass Beta:\n    pass\n')
  // A new file with no function or class: the top-level statements are the blocks.
  writeFileSync(join(repo, 'settings_table.py'), 'policy_a = ["x"]\nweight_a = {"x": 1.0}\n')
  writeFileSync(join(repo, 'scratch.log'), 'not code\n')
}

function buildStorage() {
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(
    join(storageDir, 'workspace.json'),
    JSON.stringify({ folder: `file://${repo}` }, null, 2),
  )
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  db.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)').run(
    '__$__targetStorageMarker',
    JSON.stringify({ 'debug.exceptionbreakpoint': 1 }),
  )
  db.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)').run(
    'debug.breakpoint',
    JSON.stringify([]),
  )
  db.close()

  mkdirSync(join(userDir, 'globalStorage'), { recursive: true })
  writeFileSync(
    join(userDir, 'globalStorage', 'storage.json'),
    JSON.stringify({
      windowsState: {
        openedWindows: [{ folder: `file://${repo}` }, { folder: 'file:///tmp/other-window' }],
      },
    }),
  )

  writeFileSync(fakeEditor, `#!/bin/sh\necho "$@" >> ${relaunchLog}\n`)
  chmodSync(fakeEditor, 0o755)
}

/** Minimal stand-in for the Host services the plugin injects. */
function fakeContext(config) {
  const registered = {}
  const ctx = {
    effect: (fn) => fn(),
    get: () => undefined,
    tools: {
      register(tool) {
        registered[tool.name] = tool
      },
    },
    subprocess: {
      spawn({ argv, cwd }) {
        const child = spawn(argv[0], argv.slice(1), { cwd })
        const stdout = []
        const stderr = []
        child.stdout.on('data', (chunk) => stdout.push(chunk))
        child.stderr.on('data', (chunk) => stderr.push(chunk))
        const done = new Promise((done2) => {
          child.on('close', (code) => done2({ exitCode: code, signal: null }))
        })
        return {
          done,
          terminate: () => child.kill('SIGTERM'),
          collected: {
            stdout: { readFrom: () => ({ text: Buffer.concat(stdout).toString('utf8') }) },
            stderr: { readFrom: () => ({ text: Buffer.concat(stderr).toString('utf8') }) },
          },
        }
      },
      async resolveExecutable(name) {
        if (name === 'code') return fakeEditor
        throw new Error(`not found: ${name}`)
      },
    },
  }
  return { ctx, registered, config }
}

function readStoredBreakpoints() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'debug.breakpoint'").get()
    return JSON.parse(String(row.value))
  } finally {
    db.close()
  }
}

async function main() {
  buildFixtures()
  buildStorage()

  const { apply } = await import('../index.js')
  const { ctx, registered, config } = fakeContext({
    base: 'master',
    editorPattern: fakeEditorMarker,
  })
  apply(ctx, config)
  const tool = registered.vscode_breakpoints
  assert.ok(tool !== undefined, 'tool must be registered')

  const exec = { agent: undefined, signal: undefined }
  const baseArgs = { cwd: repo }

  // 1. dry run reports the plan and writes nothing.
  const dry = await tool.execute({ ...baseArgs, dryRun: true }, exec)
  assert.equal(dry.applied, false, 'dry run must not write')
  assert.equal(readStoredBreakpoints().length, 0, 'dry run must leave the database alone')
  assert.ok(dry.total > 0, 'dry run must find changed blocks')
  console.log('1 dry run            ok  (%d 个断点, %d 个文件)', dry.total, dry.files.length)

  // 2. a write with the editor closed.
  const written = await tool.execute({ ...baseArgs, restart: false }, exec)
  assert.equal(written.applied, true)
  assert.equal(written.killed, false)
  assert.equal(written.relaunched, 0)
  const stored = readStoredBreakpoints()
  assert.equal(stored.length, written.total, 'database must hold exactly the reported breakpoints')
  assert.ok(stored.every((item) => item.enabled === true && typeof item.id === 'string' && item.id.length === 36))
  assert.ok(stored.every((item) => item.uri.scheme === 'file' && item.uri.external.startsWith('file://')))
  assert.ok(existsSync(`${dbPath}.before-bp.bak`), 'a backup must be written first')
  console.log('2 write (editor off) ok  (%d 个断点)', stored.length)

  // 3. list reflects the database.
  const listed = await tool.execute({ ...baseArgs, action: 'list' }, exec)
  assert.equal(listed.total, stored.length)
  assert.deepEqual(
    listed.files.map((item) => item.file).sort(),
    ['new_module.py', 'settings_table.py', 'trading.py'],
    'the modified file and both kinds of new file must be covered',
  )
  console.log('3 list               ok  (%s)', listed.files.map((item) => `${item.file}:${item.lines.length}`).join(', '))

  // 4. the marker key is registered alongside the existing one.
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const marker = JSON.parse(
    String(db.prepare("SELECT value FROM ItemTable WHERE key = '__$__targetStorageMarker'").get().value),
  )
  db.close()
  assert.equal(marker['debug.breakpoint'], 1, 'marker must list the breakpoint key')
  assert.equal(marker['debug.exceptionbreakpoint'], 1, 'existing marker entries must survive')
  console.log('4 marker             ok')

  // 5. restart flow: kill a fake editor, write, relaunch the recorded windows.
  const fake = spawn('bash', ['-c', `exec -a ${fakeEditorMarker} sleep 60`], { stdio: 'ignore' })
  await new Promise((done) => setTimeout(done, 300))
  assert.equal(spawnSync('pgrep', ['-f', fakeEditorMarker]).status, 0, 'fake editor must be running')

  const restarted = await tool.execute(baseArgs, exec)
  assert.equal(restarted.applied, true)
  assert.equal(restarted.killed, true, 'the running editor must be terminated')
  assert.equal(restarted.relaunched, 2, 'both recorded windows must be reopened')
  assert.equal(spawnSync('pgrep', ['-f', fakeEditorMarker]).status, 1, 'fake editor must be gone')
  fake.kill('SIGKILL')
  const relaunched = readFileSync(relaunchLog, 'utf8').trim().split('\n')
  assert.equal(relaunched.length, 2)
  assert.ok(relaunched[0].includes(repo), 'the project window must be reopened first')
  console.log('5 restart + relaunch ok  (%d 个窗口)', relaunched.length)

  // 6. clear empties the list.
  const cleared = await tool.execute({ ...baseArgs, action: 'clear', restart: false }, exec)
  assert.equal(cleared.applied, true)
  assert.deepEqual(readStoredBreakpoints(), [], 'clear must store an empty list')
  console.log('6 clear              ok')

  // 7. a missing base revision fails loudly instead of silently doing nothing.
  await assert.rejects(
    () => tool.execute({ ...baseArgs, base: 'no-such-branch', dryRun: true }, exec),
    /does not exist/,
  )
  console.log('7 bad base           ok')

  console.log(`\n全部通过。沙箱: ${sandbox}`)
}

main().catch((error) => {
  console.error('\nFAILED:', error)
  console.error(`沙箱保留在 ${sandbox}`)
  process.exit(1)
})
