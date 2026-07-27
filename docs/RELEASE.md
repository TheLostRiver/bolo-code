# 发布（CLI）

> **真源。** 改构建、改发布内容、改 bin，先改本文档。
> 进度水位见 [ROADMAP.md](./ROADMAP.md) §0 与 §15。

---

## 0. 形态

发布物是**一个自包含的单文件**：`dist/bolo.mjs`。

```
npm install -g bolo-code   →   bolo
npx bolo-code              →   bolo
```

| 性质 | 值 |
|------|-----|
| 运行时依赖 | **0**（`dependencies` 恒为 `{}`） |
| tarball 内容 | `dist/`（含 `bundled-skills/`）+ `README.md` + `LICENSE` + `package.json`，共 6 项 |
| Node 要求 | ≥ 20 |
| bin | `./dist/bolo.mjs`（产物自带 shebang，没有 wrapper 层） |
| 首次启动 | 安装后直接 `bolo`；自动准备用户状态，不创建项目 `.bolo/` |

---

## 1. 为什么是 bundle 而不是 `tsc`

全仓 **491 处**相对导入带显式 `.ts` 扩展名，而 TypeScript 的 `allowImportingTsExtensions`
**强制** `noEmit`。也就是说当前导入风格在结构上就不允许 `tsc` 产出 JS ——
这不是"还没做构建"，是"做不了 tsc 构建"。

| 备选 | 取舍 |
|------|------|
| **esbuild → 单文件**（选中） | esbuild 只进 devDependencies；产物零依赖；491 处导入一行不用改 |
| 把 `tsx` 提为 runtime dependency | 🚫 破坏零依赖红线；用户装个 CLI 却拖来一整套 TS 工具链 |
| codemod 491 处 `.ts` → `.js` 再 `tsc` | 🚫 风险高一个数量级，且产出多文件目录树 |

esbuild 是**构建期**工具。产物里不含它，用户也装不到它。

---

## 2. 构建

```bash
npm run build          # → dist/bolo.mjs (~1.1 MB, 125 模块)
```

`scripts/build-dist.ts` 做三件事：

1. esbuild bundle `packages/cli/src/main.ts`：`platform=node` · `target=node20` · `format=esm` · `packages: 'bundle'`
   （**不列任何 external**——列了就等于引入运行时依赖）
2. 加 `#!/usr/bin/env node` banner，`chmod 755`
3. 把 `packages/bundled-skills/` 拷到 `dist/bundled-skills/`

> 构建日志走 **stderr**。`prepack` 会调用它，stdout 要留给 `npm pack --json` 之类的消费者。

### 打包会踩的两个坑（已处理，改动时别踩回去）

**自身路径计算。** bundling 会把模块路径压平，任何 `import.meta.url` 自算路径的代码都会指错。
全仓只有一处：`packages/skills/src/index.ts` 的 `getBundledSkillsDir()`。它现在**按存在性探测**两种布局：

```
开发     packages/skills/src/  → ../../bundled-skills
发布产物 dist/                 → ./bundled-skills
```

新增任何「相对自己文件找资源」的代码，都必须同样处理，否则装完就找不到资源。

**动态 import。** 全仓的 `await import(...)` 目前**全是字面量相对路径**，esbuild 能静态打包。
一旦引入变量 specifier（`await import(someVar)`），bundle 会在运行时炸。

---

## 3. 发布前门禁

```bash
npm test               # 完整门禁，尾部含下面两个
npm run test:dist-build     # 产物契约
npm run test:dist-install   # 真实 pack → 安装 → 运行
```

`test:dist-build` 断言的是发布元数据与产物本身：

- `private !== true`、有 `name`/`version`/`files`
- `files` 不含 `.bolo-tmp` / `.planning` / `.bolo` / `.`
- **`dependencies` 为空**
- 有 `prepack`（保证 tarball 里不会是旧产物）
- bin 指向产物本身、产物带 shebang
- 产物不含 `tsx` 引用、不含 `.ts` 导入、能跑 `--help`
- `dist/bundled-skills/skill-creator/SKILL.md` 就位

`test:dist-install` 是**离开仓库**的证据：

- `npm pack` → 检查 tarball 清单不含源码/临时目录/密钥
- 装进一个干净项目（`--omit=dev`）
- 确认 `tsx` / `typescript` / `esbuild` **没有**被带进去
- 确认 npm 链接了 `bolo` bin
- 装完的产物能 `--help`，并能跑通一轮 mock provider

> 该测试会剥掉继承来的 `npm_config_*` 环境变量。原因：脚本常经 `npx` 启动，
> 而 npx 会把用户 `~/.npmrc` 的每一条注入成环境变量；其中 `npm_config_allow_scripts`
> 会让子 npm 的 project-scoped install 直接报 `EALLOWSCRIPTS`。
> 不剥的话，这个测试的成败取决于开发者个人的 npm 配置——正反两个方向都不该。
>
> staging 目录放在仓库 `.bolo-tmp/` 而非 `os.tmpdir()`：Windows 上后者位于
> `C:\Users\<user>\AppData\Local\Temp`，是家目录子目录，npm 会把 `~/.npmrc`
> 当成 **project** 配置读进来，那一级环境变量覆盖不掉。

---

## 4. 发布

```bash
npm version <patch|minor|major>
npm publish          # prepack 自动重建 dist
git push --follow-tags
```

`prepack` 保证 tarball 里的产物是当次构建的，不会是本地残留的旧文件。

**发布前自查：**

- [ ] `npm test` 全绿
- [ ] `npm pack --dry-run` 看清单只有那 6 项
- [ ] tarball 里没有密钥、`.bolo-tmp`、`.planning`、`.claude`
- [ ] `dependencies` 仍为 `{}`

---

## 5. 明确不做

| 项 | 原因 |
|----|------|
| 发布 `@bolo/*` 各子包 | 跨包导入用的是相对路径（`../../shared/src/index.ts`），workspace 包名目前是装饰性的；拆包发布是另一个工程 |
| 把 `tsx` 或 `esbuild` 放进 `dependencies` | 零依赖红线 |
| postinstall / preinstall 脚本 | 发布包不该靠生命周期脚本才能用；也会撞上收紧了脚本策略的用户环境 |
| 遥测 / 安装统计 | 项目红线，永不 |
| Electron 安装包 | 已交付 Windows NSIS；仍不自动发布、不伪造代码签名 |

---

## 6. AR5D · 发布门（性能预算 · SBOM · 安全 · 已知限制 · 恢复）

> 本节的判据是「**未参与者能独立执行**」。凡是需要口头补充才能做的步骤，
> 都算这节写得不合格。

### 6.1 SBOM（软件物料清单）

**运行时依赖：零。** `dependencies: {}` 是红线，且由
`test-desktop-bundle.ts` 与 `test-dist-install.ts` 在门禁里断言。
发布的 tarball 里除了自己的代码，没有第三方运行时代码。

构建期依赖共 **4** 个，都不进产物：

| 包 | 用途 | 为什么不进产物 |
|---|---|---|
| `esbuild` | 打 CLI 与桌面主进程单文件 | 打包器本身不随产物分发 |
| `typescript` | `npm run typecheck` | 仅类型检查，不产出 JS |
| `tsx` | 跑 `scripts/*.ts` 测试 | 只在开发/测试期 |
| `electron-builder` | Windows NSIS 安装包 | 构建工具 |

> 核对命令（任何人可跑）：
> ```bash
> node -e "console.log(JSON.stringify(require('./package.json').dependencies))"   # 必须是 {}
> npm pack --dry-run                                                              # 清单只应有 6 项
> ```

### 6.2 性能预算

本机实测（数值随机器浮动，**关注的是量级不是小数点**）：

| 指标 | 实测 | 预算（超出即需解释） |
|---|---|---|
| CLI 产物体积 | ~1.17 MB / 145 模块 | < 3 MB |
| 桌面主进程产物 | ~1.09 MB / 127 模块 | < 3 MB |
| compact 管道（20 轮 / 100 消息） | 2–3 ms · heap +0.1 MB | < 8 s · < 320 MB（灾难阈） |
| compact 压缩比 | ×12.9（20 轮）· ×51.9（80 轮） | ≥ ×3 |
| 规模伸缩 | 4× 输入 → 1.2× 耗时 | < 20×（超出即疑似二次行为） |

回归由 `test-compact-benchmark.ts` 与 `test-dist-build.ts` 在门禁里守。
**时延/内存只设灾难阈**：单机噪声大，卡太紧只会制造假红灯，
而假红灯会训练所有人无视红灯。

### 6.3 安全自查

以下每条都有门禁测试，不靠人工 review 记得：

| 面 | 保证 | 守它的测试 |
|---|---|---|
| 遥测 | **永不**。无任何数据外发 | 红线（`docs/ENGINEERING_PRINCIPLES.md`） |
| 密钥落盘 | 配置只写 `${ENV}` 引用，密钥不入文件 | `test-search-preset-privacy.ts` |
| 密钥过界 | 不回传 renderer/transcript；按**值**判断，`detail`/`message` 里回显的 key 同样抹除 | `test-desktop-secret-boundary.ts` |
| HTML 注入 | renderer 全程 `textContent`，模型输出绝不当 HTML | `test-timeline-cards.ts` |
| 工具越权 | MCP 工具可按 `allowTools`/`excludeTools` 限权；启用搜索不搭售远程抓取 | `test-mcp-tool-filter.ts` |
| 搜索 endpoint | SearXNG 只读显式配置；公开 HTTP、凭据/query/fragment 与畸形继承配置 fail closed；上游诊断 tuple 受清洗/去重/预算约束 | `test-searxng-search.ts` |
| 无人时的权限 | headless 下 `askPermission` 默认 `deny`（fail-closed） | `test-session-permission-boundary.ts` |
| 数据销毁 | 读不出旧文件时**中止**而非覆盖（写盘与迁移两条路径各自守） | `test-transcript-rewrite-preserve.ts` · `test-session-migration.ts` |

**未做代码签名。** 没有证书就不假装签了——Windows 用户会看到 SmartScreen 警告，
这是事实，写在这里而不是掩盖。

### 6.4 已知限制（发布时必须原样告知用户）

**不要在没有新证据的情况下删减这一节。** 它是这个项目对使用者的诚实交代。

| 限制 | 状态 | 详情 |
|---|---|---|
| **Windows 安装包（NSIS）** | ✅ 构建已验证 | Node 24 / npm 11.17.0 / electron-builder 26.15.3 已生成安装包与 blockmap；没有证书，用户仍会看到 SmartScreen 提示 → [DESKTOP_DESIGN §7c](./DESKTOP_DESIGN.md) |
| **桌面窗口的视觉呈现** | ❌ 未验证 | 应用**能启动**且 renderer 挂载已由 `test-desktop-launch.ts` 实证；但布局观感、Windows 主题切换与 maximize 渲染、键盘走查、长会话滚动**没有肉眼验证过** |
| **`AskUserQuestion` 的真 TTY 交互** | ❌ 未验证 | 控件逻辑测试注入 `readKey`，覆盖不到真实 raw-mode 与 REPL 抢 stdin |
| **`mcp-external` 搜索** | ⚠️ 仅验过 Exa | Exa 免密层已真连；其它 MCP 搜索服务仍取决于外部端点 |
| **SearXNG 直连** | ✅ 实例/诊断/可选 setup 已验证 | `2026.7.26-b060c780d` Docker 实例：JSON API、生产 status/session/`WebSearch`、真实 URL 与源码/dist doctor 全链通过；OI-07A 已区分正常空结果、全故障和部分成功，OI-07B doctor 检查版本/能力并要求非空 smoke，OI-07C 的源码/dist managed setup/status/logs/stop 已实跑。Docker 仍须用户预装且不是默认依赖；默认引擎仍可能 429/CAPTCHA/timeout |
| **中段 compact** | 🚫 显式不启用 | 契约就绪但产品代码零调用；两个参考实现都没真正跑过它 → §13.10.2 |
| **远端 compaction** | 🚫 显式不实施 | 见 [ADR_COMPACT_REMOTE.md](./ADR_COMPACT_REMOTE.md) |
| **token 估算对非 CJK 的高估** | ⚠️ 已收窄，仍有偏差 | 最差 **+19.5%**（JSON 工具 schema），英文散文已从 +41% 降到 +8.9%。做法：删掉前提被推翻的「密文」类，改分散文 4.5 / 其余 3.5 字符/token。剩余偏差是无依赖启发式的固有上限——JSON 真实 4.18 而日志 3.31，一个常量服务不了这个跨度，只能贴着最密的一类取。方向安全（提前压缩），代价是多花摘要调用 → `test-token-estimate-accuracy.ts` |

### 6.5 恢复手册

**前提：新 transcript 位于
`~/.bolo/sessions/workspaces/<workspace-hash>/*.jsonl`，旧项目
`.bolo/sessions/*.jsonl` 与旧用户 sessions 仍可能是兼容真源；它们都采用 append-only
语义。任何恢复动作都不要先删，也不要为了“统一路径”手工迁移或覆盖。**

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 启动报 `transcript too large` | 单份 transcript > 32 MiB | 该会话已超读取上限。**先复制一份备份**，再用 `bolo --resume <id>` 之外的方式（编辑器）截去早期行；或直接开新会话，旧文件留作存档 |
| compact 报 `transcript write failed, compaction rolled back` | 磁盘满 / 权限 / 超上限 | 内存已回退到压缩前，**数据未丢**。清理磁盘或修权限后重试 |
| `refusing to rewrite …: the existing transcript could not be read` | 旧文件存在但读不出 | **这是保护不是故障**：读不出就不知道会毁掉什么。先手动确认那个文件的状态，再决定备份还是删除 |
| resume 后历史看着变短 | 曾发生过 compact | 正常。摘要之前的原始消息仍在 jsonl 里（boundary 之前），只是不再进模型上下文 |
| 桌面端白屏 | preload / renderer 路径错 | 跑 `npx tsx scripts/test-desktop-launch.ts`，它会指出缺哪一项 |
| 配置改了不生效 | 层级优先级 | 顺序是 `defaults < ~/.bolo < .bolo < 环境变量`。**项目级会压过用户级**——先确认改的是哪一层 |

### 6.6 发布 checklist（逐项可执行）

```bash
npm test                              # typecheck + 112 个门禁脚本，必须 EXIT=0
node -e "console.log(JSON.stringify(require('./package.json').dependencies))"
                                      # 必须输出 {}
npm pack --dry-run                    # 清单只应有 6 项
git status --porcelain                # 必须干净
git rev-parse HEAD origin/main | uniq | wc -l   # 必须是 1
```

- [ ] 上述五条全过
- [ ] §6.4 已知限制**原样**出现在 release notes 里，未被删减
- [ ] 版本号已 bump，且 CHANGELOG 记录了本次的**行为变更**（不只是功能）
- [ ] 若本次动过 compact / transcript / 权限中任一处：确认 §6.3 表里对应的
      那条测试**确实跑过并且是绿的**，而不是只看总数

> 最后一条不是形式主义。本项目多次出现「测试通过但出于错误的理由」——
> 断言没有对象、保护来自别处、抽取器抽了个空。总数全绿不等于那一条在守。
