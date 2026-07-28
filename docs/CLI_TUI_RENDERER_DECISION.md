# CLI TUI retained renderer 选型决定

> **状态：** OI-14A `CLOSED`
>
> **日期：** 2026-07-28
>
> **Bolo 锚点：** `f132026`
>
> **交付：** `1ae9f53`（真实 VT 证据）· `f04f8de`（依赖与 Node 基线）
>
> **候选锚点：** Pi `c820aa26fe09` · `@earendil-works/pi-tui@0.82.1`

本文件保存 OI-14A 的可复核数据与选型结论。它只决定 renderer 基座和支持边界，
没有声称当前 legacy TUI 的可见故障已经修复。OI-14B 已完成纯 live view-state；
OI-14C `1798a7c` 已完成 opt-in retained 基座，OI-14D `8b060e5` 已迁 retained
transcript/Markdown，OI-14E `d0fb822` 已迁 retained Composer/activity/footer；
OI-14F `31384d4` 已迁 retained overlays；OI-14G `6f4764f`–`accc22c` 已完成默认
切换、可靠性、cleanup 与性能预算；当前进入 OI-14H 删除 legacy。

## 1. Legacy 真实 VT 证据

`scripts/test-cli-tui-vt-legacy.ts` 将真实 ANSI 输出送入
`@xterm/headless@5.5.0`，由终端执行 cell width、auto-wrap、scrollback 与 resize，
不再用逻辑行模拟物理屏幕。fixture 包含 ANSI Markdown、长 URL、中文、emoji、
整段/单字符/固定随机 chunk、running composer 和 56 -> 38 resize。

默认模式要求稳定捕获以下四项已知失败并保持 CI 绿色：

| 签名 | 证明的问题 |
|------|------------|
| `wrapped-continuation-lost-gutter` | 终端自动折出的续行回到第 0 列 |
| `dock-column-drift` | 历史不在行首时只写 LF，composer 偏列或从 buffer 消失 |
| `chunk-boundary-changes-screen` | 相同正文因 provider chunk 切分不同而得到不同屏幕 |
| `resize-breaks-composer` | resize 后旧物理行和 composer 没按当前宽度重排 |

```powershell
npm.cmd run test:cli-tui-vt

$env:BOLO_TUI_VT_EXPECT = 'fixed'
npm.cmd run test:cli-tui-vt
Remove-Item Env:BOLO_TUI_VT_EXPECT
```

第一条命令 `EXIT=0`，表示四项 legacy 缺陷都被捕获；第二条在 retained renderer
接入前必须 `EXIT=1`。后续切片用同一 fixture 逐项转为正常不变量。

## 2. Pi 候选实测

### 2.1 版本、API 与许可

| 项 | 结果 |
|----|------|
| 包 | `@earendil-works/pi-tui@0.82.1`，精确锁定 |
| 来源 | Pi commit `c820aa26fe09` |
| 许可 | MIT（package 与 registry 元数据一致） |
| Node 声明 | `>=22.19.0` |
| 传递依赖 | `marked@18.0.5`（MIT，Node >=20）· `get-east-asian-width@1.6.0`（MIT，Node >=18） |
| 所需公共面 | `TUI`、`Component.render(width)`、`Text`、`Markdown`、focus/`CURSOR_MARKER`、keys、`StdinBuffer`、width/wrap 与基础容器 |

不引入 `pi-coding-agent`，也不复用 Pi 的 provider、session、tool、权限、配置或品牌。

### 2.2 Node、esbuild 与 Windows

隔离 spike 使用 esbuild `platform=node`、`format=esm`、`target=node20`、
`packages=bundle`：

| 入口 | 单文件大小 | Windows Node 24.15 | Windows Node 20.18.3 |
|------|-----------:|--------------------|----------------------|
| `TUI + Text + Markdown` | 179,513 bytes | 通过 | 通过 |
| `ProcessTerminal + TUI + Text` | 178,715 bytes | 通过 | 通过 |

Node 20 复测使用 Electron 33.4.11 内置的真实 Node `v20.18.3` / V8
`13.0.245.25-electron.0`，通过同步子进程取得真实 stdout、stderr 与 exit code。
这说明 bundle 在该运行时技术上可执行，不等于上游承诺支持 Node 20。

### 2.3 体积与冷启动

当前 Bolo baseline `dist/bolo.mjs` 为 1,385,065 bytes。候选独立 bundle 约为
baseline 的 13%，低于 OI-14 的 +1.5 MB 软预算。OI-14C 的真实 Bolo 产物为
1,518,187 bytes / 185 modules，比 baseline 增加 133,122 bytes（约 9.6%）。
OI-14D 接入 Pi Markdown/marked 后为 1,611,976 bytes / 189 modules，较 C 增加
93,789 bytes（约 6.2%）。OI-14E 接入 keys/StdinBuffer 与 retained Composer 后为
1,641,896 bytes / 192 modules，较 D 增加 29,920 bytes（约 1.9%）。OI-14F 接入
OverlayHost、全部交互面板与 shared pager 后为 1,686,424 bytes / 199 modules，
较 E 增加 44,528 bytes（约 2.7%）。OI-14G 默认 retained 最终产物为
1,727,232 bytes / 200 modules，相对 1,385,065B baseline 增加 342,167B；完整串
cold p50 为 empty Node 79.9ms、Bolo `--help` 130.3ms，相对增量 50.4ms。500 blocks /
10,000 行 discard-writer fixture 为 CPU 422ms、render heap +21.0MB、cleanup
retained +1.5MB，均低于 +1.5MB bundle、+100ms cold、3s CPU、128MB heap 与 64MB
cleanup 预算。

Windows Node 24.15，去掉两次 warmup，`n=10`：

| 场景 | avg | p50 | p95 |
|------|----:|----:|----:|
| empty Node | 65.8 ms | 57.5 ms | 82.8 ms |
| `bolo --help` | 114.6 ms | 113.8 ms | 118.3 ms |
| Pi candidate | 151.8 ms | 145.8 ms | 162.4 ms |

candidate 相对空 Node 的 p50 增量约 88 ms，低于 +100 ms 软目标。

### 2.4 资产与副作用

- 静态和动态检查均未发现 fetch、遥测或 analytics。
- 正常 import、构造和 render 前后没有创建 `~/.pi/agent`。
- `TUI` 默认日志目录会回落到 Pi 目录；Bolo 构造时必须显式传入
  `~/.bolo/logs/tui` 一类 Bolo-owned 路径。
- `ProcessTerminal` 会动态寻找 Windows x64/arm64
  `win32-console-mode.node`，每个 3,072 bytes。esbuild 不会把它们嵌入单文件；
  缺失时会静默损失 Shift+Tab 等 modifier 完整性。

## 3. 决定

1. **采用 direct dependency。** `@earendil-works/pi-tui@0.82.1` 作为精确
   `devDependency`，由 esbuild 打入最终单文件；根 `dependencies: {}` 继续表示
   用户没有独立运行时安装树。
2. **Bolo 最低 Node 提升到 `>=22.19.0`。** Node 20 在当前日期已 EOL，上游也不
   支持；不把“实测碰巧能跑”写成产品承诺，也不为旧 Node 维护窄 fork。
3. **保留 Bolo terminal adapter 与输入业务层。** OI-14C 使用 Pi renderer 与基础
   组件，OI-14D 接入 Markdown；OI-14E 审计 Pi Editor 后没有采用它，因为私有
   autocomplete/render 无法保持 Bolo 全宽框、ghost hint、slash menu 与 footer。
   Bolo `RetainedComposer` 复用既有 reducer/renderer，只采用 Pi focus/
   `CURSOR_MARKER`、keys 与 `StdinBuffer`；不采用 `ProcessTerminal`。只有真实按键
   回归证明 adapter 无法满足 modifier 时，才另立有 MIT attribution 的 native 资产切片。
4. **不启动 OpenTUI spike。** Pi 路线已经通过 Node、esbuild、Windows、体积、
   副作用与许可门槛，备选准入条件没有发生。
5. **归属随首次产品 bundle 落地。** OI-14C 首次把 Pi 与
   `get-east-asian-width@1.6.0` 打入 `dist`；发布包现携带
   `THIRD_PARTY_NOTICES.md` 的完整 MIT 文本。OI-14D 首次把 `marked@18.0.5`
   打入精确子模块 bundle，NOTICE 同步加入 MarkedJS MIT 与 John Gruber Markdown
   BSD 条款。OI-14H 仍须复核最终 tarball 清单和版权文本。

## 4. 功能与视觉双基准

HelsincyCode 是用户自有私有仓库，可作为内部功能实现和复用来源；公开产物不得泄露
其私有源码、路径、品牌或其中未授权的第三方内容。它主要承担功能实用性基准。

Pi、Codex、OpenCode 与 oh-my-pi 承担 retained layout、渲染可靠性和视觉完成度基准：

| 维度 | 后续验收 |
|------|----------|
| 功能 | slash/skill/plugin、context、Thought、tool/search、权限详情、paste、history、resume 全部保留 |
| 布局 | user/agent/composer section gap 由父级拥有；正文不贴墙；用户块和 composer 全宽 |
| 状态 | stream 更新稳定 block id；每段 Thought 独立计时；running 时 Composer 不卸载 |
| 终端 | 24-220 列、CJK/emoji/ANSI/OSC 8、resize、scrollback、随机 chunk 不改变最终布局 |
| 视觉 | 信息层级、颜色、快捷键/model/usage footer 和水晶身份完整，但不复制其他产品品牌 |

功能可靠性和视觉完成度是并行硬门槛，不互相抵扣。

## 5. 后续进度

OI-14B `269b39c` 已在 `packages/shared` 建立无 I/O 的 `CliTuiViewState`、
action/reducer、stable block id、stream merge、segment/composer/overlay state；
随机 chunk、reasoning/tool/search/error/abort/resume 投影均已在纯测试中闭环。

OI-14C `1798a7c` 已建立 Bolo terminal adapter、稳定 retained root、
theme/viewport/resize、水晶 welcome、同步 render epoch 与 legacy panel
suspend/resume。24/38/56/80/120/160/220 列、resize、scrollback、single-writer、
new/resume、plain byte snapshot、dist clean install 与 126 项完整门禁全绿；
`dependencies` 仍为 `{}`。

OI-14D `8b060e5` 已按 stable block id 接入 User/Assistant/Thought/Tool/Search/
Error/Warning/Summary 与 Pi Markdown；whole/character/fixed-random chunk、
24–220 列、resize、resume、ANSI/OSC 8、CJK/emoji、list/table/code、dist install、
Desktop bundle/Electron launch 与 127 项完整门禁全绿。

OI-14E `d0fb822` 已接入 Bolo `RetainedComposer`、Pi keys/StdinBuffer/
`CURSOR_MARKER`、retained activity 与独立 footer；24–220 列、new/resume 真实
REPL、abort/raw rollback、burst/resize/paste、dist install、Desktop/Electron 与
128 项完整门禁全绿。单文件为 1,641,896 bytes / 192 modules；bundle 只含已审计的
keys/stdin-buffer，不含 Editor、ProcessTerminal、terminal/native loader。

OI-14F `31384d4` 已建立唯一 `RetainedOverlayHost`，把 permission、
AskUserQuestion、provider/effort、diff browse/approve 与 runtime pager 迁入同一
component tree；Composer identity/focus 与单一 stdin/writer owner 在面板往返中
保持。真实 xterm、new/resume、abort/resize、dist install、Desktop/Electron 与
129 项完整门禁全绿。单文件为 1,686,424 bytes / 199 modules；`dependencies` 仍为
`{}`，显式 retained runtime pager 不再发送 legacy `ESC[2J`。

OI-14G `6f4764f`–`accc22c` 已让双 TTY/raw-mode 缺省使用 retained，显式
`BOLO_TUI_ENGINE=legacy` 只作短期回滚；非法非空值 fail-safe 到 legacy，non-TTY、
pipe、JSON 与 `--print` 永远保持 plain。真实 xterm 已覆盖 500 blocks/10,000 行、
scrollback、24–220 列反复 resize、paste/overlay 往返与单 owner；final flush、
异常 acquisition/cleanup、Abort/SIGINT/raw Ctrl+C、dist/install、Desktop/Electron
与 133 项完整门禁全绿。单文件、cold、CPU/heap 与 cleanup 数据见 §2.3。

当前 OI-14H 负责删除 legacy surface/prefixer/tiny Markdown/兼容桥并建立最终静态
owner guard；non-TTY plain formatter 不在删除范围。真人 Windows Terminal 仍需
检查字体、颜色、动画与按键/鼠标手感。
