# Memory — 跨会话长期记忆

> 对照 HelsincyCode `memdir` / `MEMORY.md` **语义**重实现。  
> **MEMORY.md = 索引 + 行为说明**，不是会话 transcript。无遥测。  
> 规划：`docs/TODO_MEMORY.md` · 执行轨：`docs/TODO_AUTORUN.md`。

## 1. 路径

| 项 | 默认 |
|----|------|
| 用户根 | `~/.bolo/memory/` 或 `$BOLO_CONFIG_DIR/memory/` |
| 项目根 | `<cwd>/.bolo/memory/` |
| 入口 | 各根下 `MEMORY.md` |
| 覆盖用户根 | `BOLO_MEMORY_DIR`（绝对路径；**不**覆盖项目根） |
| 关闭注入 | `BOLO_DISABLE_MEMORY=1` / `true` / `yes` / `on` |

Topic 文件：同目录（可子目录）其它 `*.md`（非 `MEMORY.md`），由模型 Write。  
可选 frontmatter：`description:` / `title:`。

## 2. 预算

| 常量 | 默认 | 含义 |
|------|------|------|
| `MAX_MEMORY_ENTRYPOINT_LINES` | 200 | 索引最大行数 |
| `MAX_MEMORY_ENTRYPOINT_BYTES` | 25000 | 索引最大字符数 |
| `MAX_MEMORY_TOPIC_FILES` | 200 | 扫描 topic 上限 |
| `MAX_RELEVANT_MEMORY_TOPICS` | 5 | 相关 topic 条数 |
| `MAX_RELEVANT_MEMORY_BODY_CHARS` | 12000 | 相关正文合计 |
| `MAX_SINGLE_TOPIC_BODY_CHARS` | 4000 | 单文件正文 |

## 3. System 注入

volatile 段标题：`# auto memory`

1. 行为说明 + 目录列表  
2. **user** `MEMORY.md`（截断后）  
3. **project** `MEMORY.md`（有 cwd 时；段在后；冲突时提示优先 project）  
4. 可选 **Related memory topics**（仅当传入 `relevanceQuery` 或 `includeRelevantTopics`）

**相关挑选：** 确定性关键词重叠（文件名/标题/描述），**无** side-query LLM、**无**遥测。

默认 `getVolatileSections`：注入 user+project 索引；**不**默认塞相关正文（避免无 query 时烧 token）。会话侧若要相关段，调用 `buildMemorySystemSection({ relevanceQuery })`。

## 4. Slash

```
/memory            # 开关、user/project 路径、预览、topics 列表
/memory path       # user + project 路径
/memory topics     # 扫描 topic 列表
```

## 5. API（节选）

| 函数 | 作用 |
|------|------|
| `getMemoryDir` / `getProjectMemoryDir` | 路径 |
| `scanMemoryTopics` | topic 头扫描 |
| `selectRelevantMemoryTopics` | 确定性相关 |
| `buildMemorySystemSection` | system 段 |
| `formatMemoryStatus` / `formatMemoryTopicsList` | `/memory` |

## 6. 测试

```bash
node --import tsx/esm scripts/test-memory.ts
```

## 7. 不做

- team / daily / dream（MEM-8）  
- Sonnet 侧链检索  
- 远程同步 / 遥测