# `.bolo-tmp/` — 本地临时输出

存放 agent / 手工调试产生的临时文件，例如：

- `.tmp*` 测试与 shell 重定向产物
- `_out*` 命令输出抓取
- `tmp-*` 根目录临时文件

**不要提交本目录内容。** 整个 `.bolo-tmp/` 已在 `.gitignore` 中忽略。

约定：新的临时输出请写到本目录，例如：

```bash
npx tsx scripts/test-foo.ts > .bolo-tmp/test-foo.out 2>&1
```