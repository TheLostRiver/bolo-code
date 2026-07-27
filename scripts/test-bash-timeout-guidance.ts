/**
 * 前台 Bash 超时后，错误必须**指出出路**
 *
 * ROADMAP §14.5 有一条「前台命令自动后台化」，注着「语义复杂，暂不做」。
 * 按 §13.10.2 的规则给它做证据门控时，先量了它到底在解决什么代价：
 *
 * 前台命令超时 → 进程被杀。**部分输出其实是保留的**（`err.stdout` / `err.stderr`
 * 都进了 output），所以损失不是「结果没了」，而是「跑到一半的活白跑了，
 * 而且模型不知道该怎么办」——错误里只有一句 execFile 的 ETIMEDOUT，
 * 没有任何一处提到 `run_in_background` 这条现成的路。
 *
 * 于是真正的缺口比「自动后台化」小得多，也具体得多：**错误信息不可行动**。
 * 自动把进程转后台会带来模型没要求的后台任务、一个它得开始追踪的 id、
 * 以及「这一轮到底完了没有」的歧义；而把出路写进错误里没有这些代价。
 *
 * 这条断言守的就是那句话别被人删掉或改跑偏。
 *
 * 运行：npx tsx scripts/test-bash-timeout-guidance.ts
 */
import { createBuiltinTools } from '../packages/tools/src/index.ts'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

/** 跨平台的「一定会超时」与「一定很快」——命令本身不能是变量 */
const SLEEP_CMD =
  process.platform === 'win32' ? 'ping -n 6 127.0.0.1' : 'sleep 5'
const ECHO_CMD = 'echo hi'
/** 一定失败、且不是超时 */
const FAIL_CMD = 'bolo-no-such-command-xyz'

async function main() {
  const bash = createBuiltinTools().find((t) => t.name === 'Bash')
  assert(bash, 'the Bash tool is registered')

  // 睡得比 timeout 久：一定超时。命令本身跨平台（node 一定在）。
  const res = await bash!.call(
    {
      command: SLEEP_CMD,
      timeout: 300,
    },
    { cwd: process.cwd() },
  )

  // 裁判自检：必须**真的**是超时，否则下面在验一个不存在的分支
  assert(
    res.ok === false && res.errorCode === 'timeout',
    `setup: the command really did time out (ok=${res.ok}, errorCode=${res.errorCode})`,
  )

  const out = String(res.output ?? '')
  assert(
    out.includes('run_in_background'),
    'the timeout error names the recovery path — a model that only sees ETIMEDOUT ' +
      'either retries the same way and times out again, or gives up on work that ' +
      `would have finished in the background. Got: ${out.slice(0, 200)}`,
  )
  assert(
    /timeout|timed out/i.test(out),
    'and it still says what went wrong, not only what to do next',
  )

  // 不是超时的失败也不该带这句话——把「换后台跑」贴到一个语法错误上，
  // 是在把模型往错误的方向推。
  {
    const failed = await bash!.call({ command: FAIL_CMD }, { cwd: process.cwd() })
    // 裁判自检：它必须**真的**失败了，且失败原因不是超时
    assert(
      failed.ok === false && failed.errorCode === 'exec_failed',
      `setup: the command fails for a reason other than timeout ` +
        `(ok=${failed.ok}, errorCode=${failed.errorCode})`,
    )
    assert(
      !String(failed.output ?? '').includes('run_in_background'),
      'a command that failed outright is not advised to try again in the background — ' +
        'it would fail there too, just later and out of sight',
    )
  }

  // 成功的命令不该被这句话污染
  const okRes = await bash!.call(
    { command: ECHO_CMD },
    { cwd: process.cwd() },
  )
  assert(okRes.ok === true, `setup: a fast command succeeds (${okRes.output})`)
  assert(
    !String(okRes.output ?? '').includes('run_in_background'),
    'a command that finished is not told how to survive a timeout it never hit',
  )

  console.log('PASS: bash timeout guidance')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
