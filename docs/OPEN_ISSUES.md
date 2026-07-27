# 开放问题清单

> 首次盘点锚点：`a17e840`（2026-07-27）。  
> 本文只列当前仓库中有代码、测试、实测或互相矛盾文档支撑的问题。
> 历史 TODO、已关闭的候选和仅凭印象提出的功能不算开放问题。

## 0. 使用规则

- 每条问题必须有可复核证据和明确关闭条件。
- 状态只用：`OPEN`、`IN PROGRESS`、`BLOCKED: EXTERNAL`、
  `BLOCKED: HUMAN`、`CLOSED`。
- `BLOCKED` 不是“还没做”：它表示自动化无法替代外部端点或真人行为。
- 修复代码时先改 `packages/*` 契约和测试，再接 CLI/Desktop。
- 代码/测试与文档分批提交；文档同步完成前问题不算关闭。

## 1. Agent 可直接解决

### OI-01 · 状态真源与使用文档漂移

**状态：CLOSED（文档同步批次）**

关闭证据：

- ROADMAP §0/§13.11、handoff、README 与 autonomous prompt 使用同一队列，
  并在 OI-04 关闭后统一把 OI-06 标为当前，同时保留外部/人工阻塞标记。
- AR4 ADR 已按正文改为六个候选；RELEASE 与默认门禁现统一为 108 个脚本。
- USAGE 已补 `--allowed-tools`、`--disallowed-tools`、`AskUserQuestion`
  与 Web search 的最短入口。
- `test-dist-build.ts` 守住默认门禁条目和 package manager；
  `test-docs-config-snippets.ts` / `test-search-cli.ts` 守住配置片段与文案承诺的命令。

### OI-02 · 两个核心回归测试没有进入默认门禁

**状态：CLOSED（`5800f05`）**

证据：

- `scripts/test-ptl-retry.ts` 覆盖 PTL 识别、截断重试、query loop、
  session submit 与 full compact，但默认 `npm test` 不执行它。
- `scripts/test-desktop-launch.ts` 真正启动 Electron 并检查 renderer、preload
  与 CSS；命名脚本 `test:desktop-bundle` 会串联它，但默认门禁直接执行
  `test-desktop-bundle.ts` 文件，不会展开命名脚本。

关闭证据：

- 两项都已进入默认 `npm test`。
- `test-dist-build.ts` 会断言它们不能再次被移出。
- 完整门禁在 Windows 实际输出 `PASS: ptl-retry` 与
  `launched, renderer mounted ... PASS: desktop launch`，`EXIT=0`。

### OI-03 · 包管理器声明与仓库现实不一致

**状态：CLOSED（`5800f05`）**

证据：

- 根 `package.json` 声明 `pnpm@9.15.0`，仓库只有 `package-lock.json`，
  使用 npm workspaces，当前工具链为 npm 11.17.0。
- electron-builder 因根声明先选择 pnpm，失败后才回退 traversal。
- ARCHITECTURE、AGENT_HANDOFF、TUI、USAGE、README 等仍混用 pnpm 口径。

关闭证据：

- 根与 Desktop 均声明 `npm@11.17.0`，并保留唯一 `package-lock.json`。
- 发行契约断言 package manager、lockfile 与默认门禁。
- 开发文档已统一以 npm 为默认入口。
- NSIS 日志直接识别 `pm=npm config=npm@11.17.0` 并 exit 0；空生产依赖时的
  traversal 是 collector 的空树回退，不是包管理器误判。

### OI-04 · SearXNG 产品契约互相矛盾

**状态：CLOSED（`c058998`）**

证据：

- 关闭前 `packages/config/src/searchPresets.ts` 内置 `searxng` MCP preset，
  指向 `http://127.0.0.1:8080/mcp` 占位桥。
- `LOCAL_SEARCH_AND_FETCH.md` §3.1 明确说 Bolo 不内置任何 SearXNG 桥 preset。
- 同文 §3.3 声称“断网也应该能搜”，但 SearXNG 没有自有索引，查询仍需上游引擎。
- 文档 §5 已论证 Bolo 直连 SearXNG JSON API 可删除不受信任的桥，但尚未实现。

关闭条件：

- 删除误导性的第三方桥 preset。
- 提供零依赖、显式配置、fail-closed 的 SearXNG JSON 搜索工具。
- 本地 fixture 覆盖请求参数、响应解析、超时、错误与结果预算。
- 文档明确“本地服务”与“查询不出机器”不是一回事。

关闭证据：

- `search.searxng` 支持 user/project 深层合并与 `enabled: false`；畸形高优先级覆盖
  不会继续启用低优先级 endpoint。
- 内置 `WebSearch` 只接受显式配置的 endpoint；公开 HTTP、URL 凭据/query/fragment
  均 fail closed，并限制超时、响应体、结果字段和最终输出。
- `/websearch off` 会从模型请求移除 disabled schema；reload 保持唯一工具实例。
- `bolo search status` 同时列出 hosted、SearXNG direct 与 MCP 线路；配置 warning
  在 CLI 与 Desktop 都可见。
- `test-searxng-search.ts` 使用本地 HTTP fixture 覆盖请求、解析、错误、预算和生产
  接线，并已进入独立 script 与 108 项默认门禁；OI-X1 已另补真实实例证据。

### OI-05 · CLI 构建会吞掉 bundled skills 复制失败

**状态：CLOSED（`5800f05`）**

证据：

- `scripts/build-dist.ts` 对 `fs.cp(skillsSrc, skillsDst)` 使用
  `.catch(() => {})`。
- 发布 `prepack` 只跑 build；复制失败时可能 exit 0，随后发布缺技能资产的包。

关闭证据：

- `fs.cp` 错误会自然抛出并使 build 非零退出。
- 发行契约静态守住复制调用不能再挂空 catch。
- dist contract、真实 pack/install 与完整门禁全绿。

### OI-06 · Desktop 产品工作流接线

**状态：CLOSED（`74997ab` · `c76123e` · `c08254a` · `ce918ef` · `9f0f687`）**

证据：

- `packages/shared/src/runtimeClient.ts` 的 client/transport/store 已由 Desktop
  renderer 生产调用；core adapter 和 hello/query/command IPC 已接通。
- 会话侧栏已支持 click/Enter/Space resume；core active-session manager 串行化
  create/resume/recreate/close，忙态 fail-closed。
- composer 已显式提供 Send/Queue/Steer/Interrupt，并经 durable control 接入；
  queue terminal 后由 Desktop FIFO drain。
- 设置页已可修改 model/effort：model preset 只作建议且允许自定义名称，effort
  只显示当前 dialect/model 可选档；写盘失败恢复 model/effort/classifier/cache，
  renderer 保留原输入与错误提示。
- `projectSessionRuntimeEventView` 把 `control`、`tool_progress` 投成 renderer
  可直接显示的窄契约；renderer 事件覆盖从 6/17 提升到 8/17，不机械呈现全部事件。

关闭条件：

- packages 中先定义并测试 Desktop runtime transport/intent 契约。
- Desktop 接入 runtime client，能够切换/恢复会话并显示协议不兼容与读取失败。
- composer 明确区分 send、queue、steer、interrupt。
- model/effort 设置可用且 secret 不进入 renderer。
- control/tool progress 等 OI-06 关键运行态事件有稳定 packages 投影与 Desktop 呈现。
- 定向测试、IPC 契约、真实 Electron 启动与完整门禁全绿。

关闭证据：

- `createSessionRuntimeTransport` 统一协议 hello、当前 session snapshot、边界命令解析
  与 `executeRuntimeCommand`，没有另造 executor。
- Desktop 通过 19 request + 3 push IPC、browser ESM `RuntimeClient` 和单一 store
  显示 ready/incompatible/error；错误不会伪装成空会话。
- `test-session-selection.ts` 覆盖忙态、并发、load failure、candidate 清理与
  scoped approval id；旧 session 回包不能认领新实例。
- `composerIntentToControl` 为 queue 分配稳定的新 turn ID；core adapter 统一
  runner snapshot、意图翻译与 durable admission，拒绝未知 IPC action/text。
- `getSessionModelEffortSettings` 与 `updateSessionModelEffort` 统一 slash/Desktop
  suggestions、choosable、输入校验、即时持久化及失败回滚；secret 不进 snapshot。
- critical event projector 对无效事件 fail-closed，不把原始 steer prompt 字段传给
  renderer；tool progress 原位更新同一行，steer 只在 safe boundary 真正应用后呈现。
- 真实 Electron smoke 已返回 `runtime:"ready"`，自动点击 session row 恢复目标，
  并经真实 IPC 修改/回读 `desktop-smoke-model/high`；108 项默认门禁 EXIT=0。
- `test:desktop-runtime-events`、typecheck、IPC/event 契约、dist install、Desktop
  bundle/launch 与完整 `npm test` 全绿。真人点击与视觉验收仍单列 OI-H2。

## 2. 外部资源项（已关闭）

### OI-X1 · SearXNG 真实实例 live smoke

**状态：CLOSED（2026-07-27 真实实例）**

- 官方镜像 `SearXNG 2026.7.26-b060c780d`，digest
  `sha256:d0aaeb14880e6e92bde1518fcc7261e995783367d63d95203383607bef9c6516`，
  只绑定 `127.0.0.1:8888`，显式启用 JSON。
- 直接 JSON 搜索返回 20/26 条真实结果；生产 `bolo search status` 正确显示
  `/search` endpoint，session 注册 permission-gated `WebSearch`。
- 生产工具调用 2.32s 返回 5 条、6 个 URL，首条为
  `https://developers.openai.com/api/docs`，结果来自 Google CSE、DuckDuckGo、
  Bing；`/websearch off/on` 动态门控通过。
- 活体同时暴露默认引擎不稳定：Brave 429、Startpage CAPTCHA、DuckDuckGo /
  Google CSE / Wikipedia 超时曾令同一查询返回 0。启用当前网络可达的 Bing 后，
  默认 JSON 查询 1.94s 返回 37 条。部署验收必须要求**非空结果**，不能只看 200。
- `npm run test:searxng-search` 继续 EXIT=0；公网 live 不进入默认门禁。

## 3. 必须真人验证

### OI-H1 · CLI `AskUserQuestion` 真 TTY

**状态：BLOCKED: HUMAN**

自动测试注入 `readKey`，覆盖不到真人终端的 raw mode、方向键、多选、自由文本、
Ctrl-C/Esc 以及 REPL 是否抢占 stdin。需要人在真实终端按键确认。

### OI-H2 · Desktop 问答与视觉走查

**状态：BLOCKED: HUMAN**

自动化能确认窗口挂载、preload、CSS 和 IPC，但不能判断布局观感，也不能替代真人点击。
需要在真实窗口检查 AskUserQuestion、权限对话框、明暗主题、maximize、键盘导航、
长会话滚动与窄窗口文本溢出。

## 4. 已核实但不列为开放问题

| 候选 | 结论 |
|---|---|
| Windows NSIS 打包 | 2026-07-27 已用 `electron-builder@26.15.3` 成功生成约 80 MB 安装包和 blockmap；根工具链与文档已同步 |
| LSP | 有意暂缓；当前没有满足 ADR 中的重开证据，不因“重量级 agent 都有”自动立项 |
| 任意中段 compact | 契约保留、产品显式不启用；参考实现也没有可靠先例 |
| 远端 compaction | ADR 明确不实施，符合隐私与可恢复性边界 |
| token 启发式剩余高估 | 最差 +19.5%，方向安全且受门禁约束；零运行时依赖下属于已知精度边界 |
| 前台命令自动后台化 | 已把真实缺口收窄为可行动的超时提示；没有证据支持引入自动迁移状态机 |

## 5. 扫描范围

本轮检查了：

- ROADMAP、RELEASE、AGENT_HANDOFF、USAGE、ARCHITECTURE、AR4 ADR、
  Desktop 与本地搜索专题文档；
- 根与 Desktop package metadata、105 项默认测试串及 140 个 `test-*.ts` 的注册差集；
- 历史 SearXNG preset、WebFetch、工具注册、权限分类、runtime client、Desktop IPC/renderer；
- 代码中的 TODO/FIXME、空 catch 与未实现标记；
- 当前完整门禁、electron-builder registry 版本与真实 NSIS 构建。

没有当前证据、已经关闭或只是历史 TODO 标题的条目没有进入开放问题。
