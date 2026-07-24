# TODO / 路线图：跨会话 Memory（auto-memory 语义）

> **专项规划**（对照 HelsincyCode `src/memdir/*` 语义重实现；与 `docs/TODO.md` 衔接）。  
> 原则：无遥测；MEMORY.md = **长期记忆索引**，不是会话 transcript；有预算、fail-open。  
> 状态按代码行为写。

---

## 0. 产品目标

| 要 | 不要 |
|----|------|
| 跨会话记住偏好 / 项目事实 / 用户明确要求记住的内容 | 把完整 chat 写进 MEMORY.md |
| `MEMORY.md` 索引进 system（有行数/字节上限） | 默认把全部 topic 文件塞进 prompt |
| 模型用 Write/Edit 维护记忆文件 | 远程同步 / 团队 memory 全家桶（后置） |
| `/memory` 本地可见 | 遥测、GrowthBook |

**与 compact 的区别：** compact 管**本会话**上下文压力；memory 管**未来会话**仍有用的笔记。

---

## 1. 对照 HC（借鉴点）

| HC | Bolo 最小 |
|----|-----------|
| `memory/MEMORY.md` 入口 | `~/.bolo/memory/MEMORY.md`（可选 project 后置） |
| 索引截断 200 行 / ~25KB | 同语义常量 |
| 行为说明 + 索引内容进 prompt | `buildMemorySystemSection` |
| topic 文件 + 相关检索 | MEM-2 后置 |
| team memory | 明确后置 |
| daily log / dream | 明确后置 |

---

## 2. 目录布局

```text
~/.bolo/memory/                 # 或 $BOLO_CONFIG_DIR/memory
  MEMORY.md                     # 索引（常驻 system，有预算）
  user_preferences.md           # 可选 topic（模型自行创建）
  project_notes.md
  ...
```

环境：`BOLO_MEMORY_DIR` 可覆盖根目录（绝对路径）；`BOLO_DISABLE_MEMORY=1` 关闭注入。

---

## 3. 切片

| ID | 任务 | 验收 | 状态 |
|----|------|------|------|
| **MEM-0** | 本文 + `MEMORY.md` 契约文档 | 链接 TODO/ROADMAP | ✅ |
| **MEM-1** | 路径 + ensure `memory/` | `getMemoryDir` / `getMemoryEntrypoint` · config layout | ✅ |
| **MEM-2** | 读 `MEMORY.md` + 截断 | `loadMemoryEntrypoint` · 行/字节 cap | ✅ |
| **MEM-3** | system 注入行为段 + 索引正文 | volatile；`loadMemory !== false` | ✅ |
| **MEM-4** | `/memory` 显示路径/开关/预览 | slash `cmdMemory` | ✅ |
| **MEM-5** | 测试 | `scripts/test-memory.ts` | ✅ |
| **MEM-6** | topic 扫描 + 按需相关记忆 | 后置 | ⬜ |
| **MEM-7** | project-scoped memory | 后置 | ⬜ |
| **MEM-8** | team / daily log | 后置 | ⬜ |

**本刀交付：MEM-0 → MEM-5 最小闭环 ✅。**

---

## 4. 注入位置

```
… Environment → rules → BOLO.md → **Memory** → skill catalog → …
```

Memory 为 **volatile**（路径/内容随用户变，不进 cache-stable 前缀）。

---

## 5. 模块

```
packages/core/src/memory.ts     # 路径、加载、截断、prompt 段
packages/config paths/ensure    # memoryDir
packages/core systemPrompt      # getVolatileSections
packages/core slash             # /memory
docs/MEMORY.md                  # 契约
```

---

## 6. 明确不做（本专题最小）

- 远程 memory 云同步  
- 团队 MEMORY / 权限模型  
- 自动 nightly distill  
- 把 memory 当 compact 替代  
- 遥测  

---

## 7. 一句话

> **MEMORY.md 是跨会话笔记索引；进 system 有预算；明细 topic 文件后置按需加载。**

**已交付：MEM-0…5。下一刀可选：MEM-6 topic 相关检索，或其它 P1。**