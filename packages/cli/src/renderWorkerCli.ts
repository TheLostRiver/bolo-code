/**
 * REN-3：渲染 worker 独立入口（轻量——不加载 main.ts 全树，
 * dev 下 tsx 冷启动 ~200ms，远低于墙钟超时）。
 */
import { runRenderWorker } from './renderWorker.ts'

await runRenderWorker()
