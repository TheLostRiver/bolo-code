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
没有声称当前 legacy TUI 的可见故障已经修复。产品迁移从 OI-14B 继续。

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
| 所需公共面 | `TUI`、`Component.render(width)`、`Text`、`Markdown`、`Editor`、width/wrap 与基础容器 |

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
baseline 的 13%，低于 OI-14 的 +1.5 MB 软预算。最终增量仍须在 OI-14C/G 对真实
Bolo 产物重测。

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
3. **首轮保留 Bolo terminal adapter。** OI-14C 使用 Pi renderer、Markdown、
   Editor 和组件，不直接采用 `ProcessTerminal`。只有真实按键回归证明 adapter
   无法满足 modifier 时，才另立有 MIT attribution 的 native 资产切片。
4. **不启动 OpenTUI spike。** Pi 路线已经通过 Node、esbuild、Windows、体积、
   副作用与许可门槛，备选准入条件没有发生。
5. **归属必须随首次产品 bundle 落地。** 当前 Pi 尚未被产品入口 import；OI-14C
   首次把第三方代码打入 `dist` 时，必须新增发布用第三方许可证/NOTICE，并由
   OI-14H 再核对 tarball 清单和版权文本。

## 4. 功能与视觉双基准

HelsincyCode 是用户自有私有仓库，可作为内部功能实现和复用来源；公开产物不得泄露
其私有源码、路径、品牌或其中未授权的第三方内容。它主要承担功能实用性基准。

Pi、Codex、OpenCode 与 oh-my-pi 承担 retained layout、渲染可靠性和视觉完成度基准：

| 维度 | 后续验收 |
|------|----------|
| 功能 | slash/skill/plugin、context、Thought、tool/search、权限详情、paste、history、resume 全部保留 |
| 布局 | user/agent/composer section gap 由父级拥有；正文不贴墙；用户块和 composer 全宽 |
| 状态 | stream 更新稳定 block id；每段 Thought 独立计时；running 时 Editor 不卸载 |
| 终端 | 24-220 列、CJK/emoji/ANSI/OSC 8、resize、scrollback、随机 chunk 不改变最终布局 |
| 视觉 | 信息层级、颜色、快捷键/model/usage footer 和水晶身份完整，但不复制其他产品品牌 |

功能可靠性和视觉完成度是并行硬门槛，不互相抵扣。

## 5. 下一刀

OI-14B 只在 `packages/shared` 建立无 I/O 的 `CliTuiViewState`、action/reducer、
stable block id、stream merge、segment/composer/overlay state。随机 chunk、
reasoning/tool/search/error/abort/resume 投影先在纯测试中闭环；OI-14C 才允许 terminal
adapter 与 retained tree 接入产品。
