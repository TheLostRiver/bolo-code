# Memory — 跨会话长期记忆（最小）

> 对照 HelsincyCode `memdir` / `MEMORY.md` **语义**重实现。  
> **MEMORY.md = 索引 + 行为说明**，不是会话 transcript。无遥测。  
> 规划：`docs/TODO_MEMORY.md`。

## 1. 路径

| 项 | 默认 |
|----|------|
| 根目录 | `~/.bolo/memory/` 或 `$BOLO_CONFIG_DIR/memory/` |
| 入口 | `MEMORY.md` |
| 覆盖根 | `BOLO_MEMORY_DIR`（绝对路径） |
| 关闭注入 | `BOLO_DISABLE_MEMORY=1` / `true` / `yes` / `on` |

Topic 文件（可选）：同目录下其它 `*.md`（非 `MEMORY.md`），由模型自行 Write；**本版不自动全量注入**。

## 2. 预算

| 常量 | 默认 | 含义 |
|------|------|------|
| `MAX_MEMORY_ENTRYPOINT_LINES` | 200 | 索引最大行数 |
| `MAX_MEMORY_ENTRYPOINT_BYTES` | 25000 | 索引最大字符数 |

超限截断并附 warning 行。

## 3. System 注入

volatile 段标题：`# auto memory`  

内容：目录路径 + 如何保存（索引一行指针 + topic 文件）+ 不该记什么 + 当前 `MEMORY.md` 正文（或「尚空」）。

## 4. Slash

```
/memory          # 路径、开关、是否存在、截断信息、预览
/memory path     # 仅路径
```

## 5. API

| 函数 | 作用 |
|------|------|
| `getMemoryDir` / `getMemoryEntrypoint` | 路径 |
| `isMemoryDisabled` | 环境熔断 |
| `ensureMemoryDir` | 建目录 |
| `loadMemoryEntrypoint` | 读 + 截断 |
| `buildMemorySystemSection` | system 段字符串 |
| `formatMemoryStatus` | `/memory` 文案 |

## 6. 测试

```bash
node --import tsx/esm scripts/test-memory.ts
```