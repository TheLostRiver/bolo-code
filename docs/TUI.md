# CLI TUI

> 无遥测。品牌见 `docs/BRAND.md`。  
> **FULL 轨：** Ink 等价布局 · 箭头 picker · 主题/吉祥物（非 Electron）。

## 模式

| 条件 | 行为 |
|------|------|
| 默认 TTY | `renderInkLayout` 框式欢迎/状态/输入提示（`BOLO_TUI_LAYOUT=0` 关） |
| plain / `NO_COLOR` / `BOLO_PLAIN` / 窄终端 / `BOLO_THEME=plain` | 单行 banner |
| `BOLO_MASCOT=0` | 全量 banner 去掉 Bolot 行 |
| `--resume` 无 id | **箭头键 picker**（↑↓ Enter；`BOLO_ARROW_PICKER=0` 用编号） |
| 非 TTY resume | 表格式列表 + 要求 `--resume <id>` |

## 模块

- `tui/inkLayout.ts` — F-T8-INK  
- `tui/arrowPicker.ts` — F-T8-PICKER  
- `tui/theme.ts` — F-T9-THEME  
- `tui/banner.ts` · `statusLine.ts` · `formatSessionEvent.ts` · `askPermissionTty.ts`  
- `newSessionCli.ts` · `resumeCli.ts` · `main.ts`

## 测试

```bash
node --import tsx/esm scripts/test-full-track.ts
node --import tsx/esm scripts/test-product-track.ts
```

## 后置

- **Electron GUI**（`apps/desktop`）  
- 真·React Ink 依赖（当前为文本等价布局）  
- 多模态 / 完整主题包