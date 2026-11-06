# dsh-vscode-breakpoints

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的插件：**把当前分支相对某个基线（默认 `master`）改过的每一处代码都打上 VS Code 断点**，打完自动重启编辑器的同一批窗口。

你只需要跟 DSH 说一句「把 diff 的地方都给我打上断点」，不用再对着 git diff 一个一个点。

## 为什么需要它

- VS Code 的断点不存在项目里，存在 `~/.config/Code/User/workspaceStorage/<hash>/state.vscdb` 的 `debug.breakpoint` 键里；扩展 API 之外没有 CLI 能导入断点。
- 那个数据库**只在编辑器启动时读一次**：运行中写它没用（退出时内存状态会覆盖），所以必须「先结束编辑器 → 写库 → 重开」。
- 手工做这件事要么点几十次断点，要么每次都要记得先关掉编辑器。这个插件把整套流程包成一次工具调用。

## 安装

和 `dsh-kimi-code` 一样，从 GitHub 装：

```bash
# 在 profile 目录（$DSH_PROFILE_DIR，例如 ~/.dsh/profiles/web）
npm install github:kangseung/dsh-vscode-breakpoints
```

然后把它加进该 `package.json` 的 `dsh.profile.bundles` 和 `dependencies`，重启 DSH 即可。插件自带 `cordis.patch.yml`，会被 bundle 机制自动挂载，不需要手写 Cordis 配置。

要求：Node ≥ 22.5（用到内置的 `node:sqlite`）、`git`、`pgrep`/`ps`（Linux/macOS）。无其它 npm 依赖。

## 用法

对 DSH 说人话即可，例如：

- 「把和 master 不一样的代码都打上断点」
- 「这些改动我看不过来，给每一处都加断点」
- 「清空这个工作区的断点」

对应的工具是 `vscode_breakpoints`：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `action` | `set` | `set` 重新生成全部断点；`list` 只报告现状；`clear` 全部清空 |
| `base` | 插件配置的 `base`，默认 `master` | 与哪个 git 版本比较，可写 `origin/main`、`HEAD~1`、某个 sha |
| `cwd` | 当前会话工作目录 | 项目目录 |
| `includeUntracked` | `true` | 本分支新增的文件要不要一起打（每个顶层代码块一个断点） |
| `exclude` | `[]` | 路径子串黑名单，例如 `["migrations/", "third_party/"]` |
| `restart` | `true` | 结束正在运行的编辑器 → 写库 → 重开同样的窗口；编辑器已经关着时可设 `false` |
| `dryRun` | `false` | 只算不打，先看看会打在哪些行 |

插件配置（可选）：

```yaml
- id: dsh-vscode-breakpoints
  name: dsh-vscode-breakpoints
  config:
    base: master            # 默认比较的基线
    editorPattern: '...'    # 自定义识别编辑器进程的正则（非常规安装/VSCodium 改名时用）
```

## 打点规则

1. `git diff <base> --unified=0`，每个 hunk 只看它**新增**的那些行（纯删除的 hunk 取被删位置那一行）。
2. 空行、注释、`@装饰器`、以及落在多行字符串/块注释里的行（`"""..."""`、`/* ... */`）一律跳过——这些行不会被执行，停在那里毫无意义。
3. 若某个 hunk 新增的**整块**都是注释或文档串（典型：只改了文件头的时间戳），这个 hunk 直接丢掉，不硬凑一条离得很远的行。
4. 改动落在 `def` / `class` 这类声明行时，**进入函数体**，停在body里第一条真正会执行的语句（跳过 docstring）——停在声明行等于函数还没进去就断一次，没有意义。
5. 本分支新增的文件：每个顶层代码块按上面的规则解析后各打一个点；整份文件没有函数也没有类（纯数据/配置模块）时，退化为每个顶层赋值 / `if` / `assert` 语句一个断点。
6. 只对代码扩展名生效（`.py` `.c/.cc/.cpp/.h/.hpp` `.js/.ts` `.go` `.rs` `.java` `.kt` `.cs` `.rb` `.php` `.sh` `.lua` 等），文档、JSON、忽略文件里的改动会被跳过并在结果里列出数量。

`set` 是**整体替换**：这个工作区原有的断点会被清掉，只保留本次算出来的。

## restart 是怎么做的

1. 用 `pgrep -f` 找到编辑器进程家族，再挑出父进程不在家族里的那个（= Electron 主进程），对它发 `SIGTERM` —— 走正常退出路径，未保存的编辑器内容由 VS Code 的 hot exit 保下来。
2. 等进程消失（默认最多 20s）。还没退干净就**不写库**，直接报错，避免被覆盖。
3. 备份 `state.vscdb` → `state.vscdb.before-bp.bak`，写入 `debug.breakpoint`，并把该 key 登记进 `__$__targetStorageMarker`（VS Code 清空断点时会连 key 一起删掉，所以必须 `INSERT OR REPLACE` 而不是 `UPDATE`）。
4. 从 `globalStorage/storage.json` 的 `windowsState.openedWindows`（空则退到 `lastActiveWindow`）读出原来开着哪些窗口，逐个重开：**文件夹窗口用 `code --folder-uri`，`.code-workspace` 用 `code --file-uri`**——裸 `file://` 会被 VS Code 当成一个同名文本文件打开。都读不到时只重开当前项目目录（同样带 `--folder-uri`）。

第 1–4 步在**独立的后台进程**（`lib/apply.mjs`）里跑：即使 DSH 自己也跑在 VS Code 的终端里、跟着被结束，这批断点照样会写完并重开编辑器。

## 安全边界

- 只碰**当前项目对应**的那个 `workspaceStorage/<hash>` 目录，不动别的工作区、不动 `settings.json`/`launch.json`。
- 每次写库前都有 `.before-bp.bak` 备份；写失败会回滚事务。
- 编辑器还在运行且 `restart=false` 时**直接报错**，不会写出一个会被覆盖的结果。
- `dryRun=true` 完全不碰编辑器、不写库。

## 已知限制

- `debug.breakpoint` / `__$__targetStorageMarker` 不是公开 API，VS Code 大版本升级可能改格式；`action=list` 读不出来时会明确报错而不是猜。
- Windows 上无法判断编辑器是否在运行（没有 `pgrep`）：此时工具会直接报错让你带上 `restart=false`，而不是盲写——因为写进去的断点会被运行中的编辑器覆盖。
- 只支持单根工作区和 `.code-workspace` 多根里包含当前项目的场景。
- 不做条件断点、日志断点、函数断点，也不保留原有断点。

## 自测

```bash
node test/selftest.mjs     # 沙箱里建临时仓库 + 临时 state.vscdb + 假编辑器进程，不碰真实环境
```

覆盖：dry-run 不写库、编辑器关闭时写入、`list` 回读、marker 登记、结束进程→写库→重开窗口全链路、`clear`、基线不存在时报错。

## License

MIT
