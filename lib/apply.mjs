/**
 * Detached helper: wait for VS Code to exit, write the breakpoint memento, then
 * relaunch VS Code with the windows that were open before.
 *
 * It runs as its own process (`setsid node lib/apply.mjs <payload.json>`) so a
 * crash or restart inside the agent that spawned it cannot leave the editor
 * closed with the breakpoints half-applied.
 *
 * Exit code 0 means the payload was applied; 1 means it was refused or failed.
 * Either way the outcome is written to the payload's `statusPath`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const POLL_MS = 200
const DEFAULT_TIMEOUT_MS = 20000

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** `pgrep -f <pattern>` -> pids (Linux/macOS). Empty when nothing matches. */
function listProcesses(pattern) {
  const out = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
  if (out.error !== undefined || out.status === 127) {
    throw new Error('pgrep is not available; cannot tell whether the editor is running')
  }
  if (out.status !== 0) return []
  return out.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** pids whose parent is outside the matched family: the editor root process. */
function rootPids(pids) {
  const out = spawnSync('ps', ['-o', 'pid=,ppid=', '-p', pids.join(',')], { encoding: 'utf8' })
  const family = new Set(pids)
  const roots = []
  if (out.error === undefined && out.status === 0) {
    for (const row of out.stdout.split('\n')) {
      const parts = row.trim().split(/\s+/)
      if (parts.length < 2) continue
      const pid = Number(parts[0])
      const ppid = Number(parts[1])
      if (Number.isInteger(pid) && !family.has(ppid)) roots.push(pid)
    }
  }
  return roots.length > 0 ? roots : pids
}

async function waitUntilGone(pattern, deadline) {
  for (;;) {
    const left = listProcesses(pattern)
    if (left.length === 0) return { ok: true, left }
    if (Date.now() > deadline) return { ok: false, left }
    await sleep(POLL_MS)
  }
}

function writeBreakpoints(payload) {
  const dbPath = payload.db
  if (!existsSync(dbPath)) throw new Error(`state.vscdb not found: ${dbPath}`)
  copyFileSync(dbPath, `${dbPath}.before-bp.bak`)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('BEGIN')
    db.prepare('INSERT OR REPLACE INTO ItemTable(key, value) VALUES (?, ?)').run(
      'debug.breakpoint',
      JSON.stringify(payload.breakpoints),
    )
    // VS Code deletes the key when the list becomes empty, so it may be absent
    // from the sync marker too; mirror debug.exceptionbreakpoint and register it.
    const markerRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = '__$__targetStorageMarker'")
      .get()
    if (markerRow !== undefined && markerRow.value !== null) {
      const marker = JSON.parse(String(markerRow.value))
      if (!('debug.breakpoint' in marker)) {
        marker['debug.breakpoint'] = 1
        db.prepare("UPDATE ItemTable SET value = ? WHERE key = '__$__targetStorageMarker'").run(
          JSON.stringify(marker),
        )
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* transaction already gone */
    }
    throw error
  } finally {
    db.close()
  }
}

async function run(payload) {
  const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const status = {
    ok: false,
    killed: false,
    applied: false,
    relaunched: 0,
    reason: '',
    at: new Date().toISOString(),
  }

  const running = listProcesses(payload.pattern)
  if (running.length > 0) {
    if (payload.kill) {
      for (const pid of rootPids(running)) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch (error) {
          status.reason = `SIGTERM to ${pid} failed: ${error.message}`
        }
      }
      status.killed = true
    }
    const drained = await waitUntilGone(payload.pattern, Date.now() + timeoutMs)
    if (!drained.ok) {
      status.reason =
        `editor still running after ${Math.round(timeoutMs / 1000)}s ` +
        `(pids: ${drained.left.join(',')}); breakpoints NOT written`
      return status
    }
  }

  if (!payload.dryRun) writeBreakpoints(payload)
  status.applied = !payload.dryRun

  if (!payload.dryRun) {
    for (const argv of payload.relaunch) {
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' })
      child.unref()
      status.relaunched += 1
    }
  }

  status.ok = true
  return status
}

const payloadPath = process.argv[2]
if (payloadPath === undefined) {
  console.error('usage: node lib/apply.mjs <payload.json>')
  process.exit(2)
}

const payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
let status
try {
  status = await run(payload)
} catch (error) {
  status = {
    ok: false,
    killed: false,
    applied: false,
    relaunched: 0,
    reason: `error: ${error.message}`,
    at: new Date().toISOString(),
  }
}
writeFileSync(payload.statusPath, JSON.stringify(status, null, 2))
process.exit(status.ok ? 0 : 1)
