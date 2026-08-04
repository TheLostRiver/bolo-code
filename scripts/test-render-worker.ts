/**
 * REN-3 路 瀛愯繘绋嬮殧绂绘覆鏌撲笉鍙俊鍐呭
 *
 * 瑕嗙洊锛? * - 姝ｅ父娓叉煋锛歸orker 缁撴灉涓庝富杩涚▼ wrapTerminalText 涓€鑷? * - 鎭舵剰杈撳叆锛氳秴闀?ANSI/鐗规畩瀛楃涓嶅穿涓昏繘绋嬩笖缁撴灉涓€鑷? * - 瓒呮椂 kill锛氭寕璧?worker 鈫?澧欓挓瓒呮椂鍥炴敹 + 闄嶇骇
 * - worker 澶辫触锛堥潪闆堕€€鍑猴級鈫?闄嶇骇锛坥k:false + error锛? * - worker 杈撳叆杩囧ぇ鎷掔粷
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  renderTextInWorker,
} from '../packages/cli/src/renderWorker.ts'
import { wrapTerminalText } from '../packages/cli/src/tui/terminalText.ts'

// --- 1. 姝ｅ父娓叉煋锛氫笌涓昏繘绋?wrapTerminalText 涓€鑷?---
{
  const text = 'hello world\nsecond line with some length that wraps around\nthird'
  const result = await renderTextInWorker({
    text,
    mode: 'terminal',
    width: 20,
  })
  assert(result.ok === true, 'worker renders ok')
  if (result.ok) {
    const expected = wrapTerminalText(text, 20)
    assert.deepEqual(result.lines, expected, 'worker lines match in-process render')
  }
}

// --- 2. 鎭舵剰杈撳叆锛氳秴闀?ANSI/鐗规畩瀛楃涓嶅穿涓昏繘绋?---
{
  const hostile = '\u001b[31mred\u001b[0m\n' + 'x'.repeat(50_000) + '\n' + '\\n\\t\u0000\u0007'
  const result = await renderTextInWorker({
    text: hostile,
    mode: 'terminal',
    width: 80,
  })
  assert(result.ok === true, 'hostile input does not crash worker')
  if (result.ok) {
    assert(
      result.lines.join('\n').length >= hostile.length - 50_000,
      'hostile content survives (no data loss beyond wrap)',
    )
  }
  // 鎺у埗瀛楃涓嶅穿锛圓NSI 杞箟琚綋浣滄枃鏈鐞嗏€斺€攚orker 涓嶈В鏋愯浆涔夛級
  const ctrl = await renderTextInWorker({
    text: '\u001b[<0;9999;9999M\u001b]11;rgb:ff/ff/ff\u0007',
    mode: 'terminal',
    width: 40,
  })
  assert(ctrl.ok === true, 'control sequences do not crash worker')
}

// --- 3. 瓒呮椂 kill锛氭寕璧?worker 鈫?鍥炴敹 + 闄嶇骇 ---
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-rw-'))
  const sleeper = path.join(tmp, 'sleeper.mjs')
  await fs.writeFile(
    sleeper,
    'process.stdin.on("data", () => {}); setInterval(() => {}, 1000);\n',
    'utf8',
  )
  const startedAt = Date.now()
  const result = await renderTextInWorker(
    { text: 'x', mode: 'terminal', width: 10 },
    {
      timeoutMs: 300,
      command: [process.execPath, sleeper],
    },
  )
  const elapsed = Date.now() - startedAt
  assert(result.ok === false, 'hung worker times out')
  assert(result.ok === false && result.error.includes('timed out'), 'timeout message')
  assert(elapsed < 3_000, `worker reclaimed in ${elapsed}ms (bounded)`)
  await fs.rm(tmp, { recursive: true, force: true })
}

// --- 4. worker 澶辫触锛堥潪闆堕€€鍑猴級鈫?闄嶇骇 ---
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-rw-'))
  const crasher = path.join(tmp, 'crasher.mjs')
  await fs.writeFile(crasher, 'process.exit(3)\n', 'utf8')
  const result = await renderTextInWorker(
    { text: 'x', mode: 'terminal', width: 10 },
    { command: [process.execPath, crasher] },
  )
  assert(result.ok === false, 'crashing worker degrades')
  assert(
    result.ok === false && /exited/.test(result.error),
    'degradation explains exit',
  )
  await fs.rm(tmp, { recursive: true, force: true })
}

// --- 5. worker 杈撳叆杩囧ぇ鎷掔粷锛坵orker 鍐呬繚鎶わ級---
{
  const result = await renderTextInWorker(
    {
      text: 'a'.repeat(2_500_000),
      mode: 'terminal',
      width: 10,
    },
    // 慢 CI 下 2.5MB 管道 + tsx 启动可能逼近默认 2s——放宽超时让「too large」
    // 分支（worker 侧）而非「timed out」分支（父进程侧）先触发
    { timeoutMs: 10_000 },
  )
  assert(result.ok === false, 'oversized input rejected by worker')
  assert(
    result.ok === false && result.error.includes('too large'),
    'rejection message',
  )
}

console.log('PASS: REN-3 subprocess-isolated rendering')
