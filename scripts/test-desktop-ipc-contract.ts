/**
 * Desktop 的 IPC 通道两侧必须对齐
 *
 * preload 是 renderer 唯一能碰到主进程的入口（contextBridge 白名单）。
 * 它调用的每个通道名都必须在主进程真有 handler，反之亦然——
 *
 * **对不上不会报错**：`ipcRenderer.invoke` 打到不存在的通道只会 reject，
 * 而 renderer 里那句 `await window.bolo.xxx()` 往往裹在 try/catch 里，
 * 结果就是「这个功能点了没反应」。与刚修掉的 `text_delta` 事件名漂移
 * （`test-desktop-event-contract.ts`）是同一类：**字符串两侧各写一遍，
 * 没有任何机制保证它们一致。**
 *
 * 这里守两个方向：
 * - preload 用到的通道，主进程必须有 handler（否则功能静默失效）
 * - 主进程注册的 handler，preload 必须暴露（否则是够不着的死代码）
 *
 * 运行：npx tsx scripts/test-desktop-ipc-contract.ts
 */
import { promises as fs } from 'node:fs'

/**
 * 文件读不到时给出**可诊断**的失败，而不是让 ENOENT 冒出来。
 * 这些测试按路径读源码，一旦文件被改名/移动，ENOENT 只会说
 * 「没这个文件」，不会说「契约测试失去了它要守的对象」——
 * 后者才是真正发生的事。（本刀就踩到了：index.mjs → index.ts。）
 */
async function readOrExplain(file: string, why: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    console.error(
      `FAIL: cannot read ${file} — ${why}. ` +
        'If the file moved, update this test rather than deleting the check.',
    )
    process.exit(1)
  }
}
import path from 'node:path'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const MAIN = path.join('apps', 'desktop', 'src', 'main', 'index.ts')
const PRELOAD = path.join('apps', 'desktop', 'src', 'preload', 'index.cjs')

function collect(source: string, re: RegExp): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(re)) out.add(m[1]!)
  return out
}

async function main() {
  const mainSrc = await readOrExplain(MAIN, 'the IPC handler side of the contract')
  const preloadSrc = await readOrExplain(PRELOAD, 'the renderer-facing side of the contract')

  const handlers = collect(
    mainSrc,
    /ipcMain\.handle\(\s*'([^']+)'/g,
  )
  const invoked = collect(
    preloadSrc,
    /ipcRenderer\.invoke\(\s*'([^']+)'/g,
  )
  // 主进程侧**不止一个文件**：桥模块（不 import electron，便于离线测）
  // 通过注入的 send 回调推送，通道名在它自己的常量里。
  // 只扫 index.ts 会漏掉那条通道，于是「preload 听着一个没人发的通道」
  // 这种断路正好从缝里漏过去——本刀接线时就是这样被漏掉的。
  const mainSideSrc = [
    mainSrc,
    await readOrExplain(
      path.join('apps', 'desktop', 'src', 'main', 'askUserQuestionBridge.ts'),
      'the main-side push channel for AskUserQuestion lives here, not in index.ts',
    ),
  ].join('\n')

  // 主进程用一个本地 send() 包装转发，不直接调 webContents.send，
  // 所以两种写法都要认 —— 只认后者会抽出 0 个通道，让下面的断言变成空的。
  // 第三种：以常量形式导出的通道名（桥用的是这种）。
  const sent = new Set([
    ...collect(mainSideSrc, /webContents\.send\(\s*'([^']+)'/g),
    ...collect(mainSideSrc, /\bsend\(\s*'([^']+)'/g),
    ...collect(mainSideSrc, /_CHANNEL\s*=\s*'([^']+)'/g),
  ])
  const listened = collect(preloadSrc, /ipcRenderer\.on\(\s*'([^']+)'/g)

  // 抽取器自身不能是空的，否则下面的包含判断永真
  assert(
    handlers.size >= 5,
    `extracted only ${handlers.size} ipcMain handlers — the extractor is broken, ` +
      'and a broken extractor makes this test vacuous',
  )
  assert(
    invoked.size >= 5,
    `extracted only ${invoked.size} preload invokes — extractor likely broken`,
  )
  // send 抽取器同样要有非空守卫：它抽出 0 个时，下面第 ③ 条断言会永真。
  // 这个坑真的踩到过——最初只匹配 webContents.send，结果报告 "0 push channels"。
  assert(
    sent.size >= 2,
    `extracted only ${sent.size} push channels — the extractor missed the local send() wrapper, ` +
      'which would make the push-channel assertion vacuous',
  )

  // ① preload 调的通道主进程必须有 —— 否则点了没反应
  const missing = [...invoked].filter((c) => !handlers.has(c))
  assert(
    missing.length === 0,
    `preload invokes channel(s) with no handler in the main process: ${missing.join(', ')} — ` +
      `the call rejects and the feature silently does nothing. main handles: ${[...handlers].sort().join(', ')}`,
  )

  // ② 主进程注册的 handler preload 必须暴露 —— 否则是够不着的死代码
  const unreachable = [...handlers].filter((c) => !invoked.has(c))
  assert(
    unreachable.length === 0,
    `main process registers handler(s) the renderer can never reach: ${unreachable.join(', ')} — ` +
      'contextBridge is the only way in, so an unexposed handler is dead code',
  )

  // ③ 推送通道同理
  const unheard = [...sent].filter((c) => !listened.has(c))
  assert(
    unheard.length === 0,
    `main process sends event(s) preload never listens for: ${unheard.join(', ')}`,
  )

  // ④ 反向：preload 听着的通道主进程必须真的会发。
  //
  // 这一条原本没有，而它挡的正是最不容易发现的一种断路——
  // renderer 装好了监听、UI 也写好了，只是那个事件**永远不来**。
  // 表现是「这个功能没反应」，而不是任何一处报错。
  const neverSent = [...listened].filter((c) => !sent.has(c))
  assert(
    neverSent.length === 0,
    `preload listens for event(s) the main process never sends: ${neverSent.join(', ')} — ` +
      `the renderer waits forever and the feature looks dead. main sends: ${[...sent].sort().join(', ')}`,
  )

  // OI-06：不能只靠“数量对得上”。三条 runtime 通道是 Desktop 消费
  // RuntimeClient 的生产入口，任一条缺失都会让 hello/query/command 链断开。
  for (const channel of [
    'bolo:runtimeHello',
    'bolo:runtimeQuery',
    'bolo:runtimeCommand',
    'bolo:selectSession',
  ]) {
    assert(
      handlers.has(channel) && invoked.has(channel),
      `${channel} is wired through main and preload for the production runtime client`,
    )
  }

  console.log(
    `  ${handlers.size} request channels + ${sent.size} push channels, both sides aligned`,
  )
  console.log('PASS: desktop ipc contract')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
