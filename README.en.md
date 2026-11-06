# dsh-vscode-breakpoints

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that **puts a VS Code breakpoint on every block your branch changed** against a base revision (default `master`), then restarts the editor for you.

Say "put breakpoints on everything that differs from master" and skip the clicking.

## Why this exists

- Breakpoints are not stored in the project. They live in `~/.config/Code/User/workspaceStorage/<hash>/state.vscdb` under `debug.breakpoint`, and no CLI can import them.
- That database is read **only at editor startup**: writing it while VS Code runs is pointless, because the in-memory state wins on exit. Hence: stop the editor → write → relaunch.
- Doing that by hand means clicking through the diff, or remembering to close VS Code first every single time.

## Install

Same shape as `dsh-kimi-code` — install straight from GitHub:

```bash
# inside your profile directory ($DSH_PROFILE_DIR, e.g. ~/.dsh/profiles/web)
npm install github:kangseung/dsh-vscode-breakpoints
```

Then add it to that `package.json`'s `dsh.profile.bundles` and `dependencies` and restart DSH. The package ships its own `cordis.patch.yml`, so the bundle mechanism mounts it without extra Cordis config.

Requirements: Node ≥ 22.5 (built-in `node:sqlite`), `git`, and `pgrep`/`ps` (Linux/macOS). No npm dependencies.

## Usage

Talk to DSH normally; the tool is `vscode_breakpoints`:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `action` | `set` | `set` regenerates all breakpoints, `list` reports the current ones, `clear` removes them |
| `base` | plugin config `base`, else `master` | Revision to diff against (`origin/main`, `HEAD~1`, a sha, …) |
| `cwd` | session working directory | Project directory |
| `includeUntracked` | `true` | Also mark files new in this branch (one breakpoint per top-level block) |
| `exclude` | `[]` | Path substrings to skip, e.g. `["migrations/", "third_party/"]` |
| `restart` | `true` | Stop the running editor, write, relaunch the same windows; pass `false` when it is already closed |
| `dryRun` | `false` | Compute and report without touching anything |

Optional plugin config: `base`, and `editorPattern` (a custom regex to recognise the editor process for unusual installs).

## How the breakpoints are chosen

1. `git diff <base> --unified=0`; each hunk contributes only its **added** lines (a pure deletion contributes the line it collapsed to).
2. Blank lines, comments, decorators (`@`), and anything inside a multi-line string or block comment (`"""..."""`, `/* ... */`) are skipped — those lines never run, so stopping there is pointless.
3. When a whole added block is a comment or docstring (the usual case: a file-header timestamp changed), the hunk is dropped instead of snapping to some far-away line.
4. A change on a `def` / `class` declaration **steps into the body** and stops on the first statement that actually runs (docstring skipped): stopping on the declaration fires before the function is even entered.
5. Files new in this branch: each top-level block is resolved the same way and gets one breakpoint; a file with neither functions nor classes (pure data/config) falls back to one breakpoint per top-level assignment / `if` / `assert`.
6. Only code extensions are considered; documentation, JSON and ignore files are skipped and reported.

`set` **replaces** the workspace's breakpoints; anything you added by hand is gone.

## What `restart` actually does

1. `pgrep -f` finds the editor's process family, then the root of it (the Electron main process, i.e. the one whose parent is outside the family) gets `SIGTERM` — a normal shutdown, so unsaved buffers are kept by VS Code's hot exit.
2. Wait for the processes to disappear (20s default). If they do not, nothing is written and the call fails loudly.
3. Back up `state.vscdb` to `state.vscdb.before-bp.bak`, write `debug.breakpoint`, and register the key in `__$__targetStorageMarker` (VS Code deletes the key when the list becomes empty, so this uses `INSERT OR REPLACE`, not `UPDATE`).
4. Reopen the windows listed in `globalStorage/storage.json` → `windowsState.openedWindows` (falling back to `lastActiveWindow`): **folders through `code --folder-uri`, `.code-workspace` files through `code --file-uri`** — a bare `file://` URI makes VS Code open a text file named after the folder. With nothing recorded, only the project folder is reopened (also via `--folder-uri`).

Steps 1–4 run in a **detached helper** (`lib/apply.mjs`), so if DSH itself runs in a VS Code terminal and dies with the editor, the write and relaunch still complete.

## Safety

- Only the `workspaceStorage/<hash>` of the matching project is touched.
- Every write is preceded by a `.before-bp.bak` backup and runs in a transaction.
- With the editor running and `restart=false` the tool errors out instead of writing something that will be overwritten.
- `dryRun=true` never touches the editor or the database.

## Known limits

- `debug.breakpoint` / `__$__targetStorageMarker` are not public API; a major VS Code upgrade may change the format. `action=list` fails loudly rather than guessing.
- On Windows the running state cannot be detected (no `pgrep`): the tool then refuses and asks for `restart=false` rather than writing blind, since a running editor would overwrite the result.
- Single-folder workspaces and multi-root `.code-workspace` files that include the project are supported; anything else is not.
- No conditional / logpoint / function breakpoints, and existing hand-made breakpoints are not preserved.

## Tests

```bash
node test/selftest.mjs   # temp repo + temp state.vscdb + fake editor process; never touches the real setup
```

## License

MIT
