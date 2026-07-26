/**
 * 源码里不得出现**字面控制字节**
 *
 * 起因是一个真实事故：`composerIntent.ts` 的模板字符串里，本该是空格的
 * 三个分隔符变成了 **NUL（0x00）**。功能上没崩（NUL 当分隔符也能用），
 * 但后果比崩了更麻烦：
 *
 * - **grep 会把含此类字节的文件当成二进制直接跳过。** 我用来查裸控制符的
 *   `grep -cP "[\x00-\x08...]"` 因此返回 0 —— **安全检查自己静默失效了**，
 *   而它恰恰是 AUTONOMOUS_PROMPT §6.6 里为这类问题准备的对策。
 * - 字面控制字节在编辑器里不可见，diff 里也看不出来，只能靠十六进制。
 *
 * 所以这条检查必须由**读文件内容**的测试来做，不能依赖 grep。
 *
 * 允许的例外只有一个方向：**用转义写法**（`'\\u001b[2m'`），它在运行时
 * 与字面字节完全等价，但源码保持纯文本。仓库里原有的 ANSI 颜色码与
 * 「故意造损坏数据」的用例都已按此改写。
 *
 * 运行：npx tsx scripts/test-no-stray-control-bytes.ts
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const ROOTS = ['packages', 'scripts', 'apps/desktop/src', 'docs']
const EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.md',
  '.json',
])

/** 允许的空白：换行、回车、制表 */
function isStrayControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false
  return code < 0x20 || code === 0x7f
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      yield* walk(full)
    } else if (EXTS.has(path.extname(e.name))) {
      yield full
    }
  }
}

async function main() {
  const offenders: Array<{ file: string; line: number; codes: string[] }> = []
  let scanned = 0

  for (const root of ROOTS) {
    for await (const file of walk(root)) {
      scanned++
      const text = await fs.readFile(file, 'utf8')
      // 快速跳过绝大多数干净文件
      let hit = false
      for (let i = 0; i < text.length; i++) {
        if (isStrayControl(text.charCodeAt(i))) {
          hit = true
          break
        }
      }
      if (!hit) continue

      text.split('\n').forEach((line, idx) => {
        const codes = [...line]
          .filter((c) => isStrayControl(c.charCodeAt(0)))
          .map((c) => `0x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        if (codes.length) {
          offenders.push({ file, line: idx + 1, codes: [...new Set(codes)] })
        }
      })
    }
  }

  assert(
    scanned > 100,
    `only scanned ${scanned} files — the walker is broken, and a broken walker makes this test vacuous`,
  )

  assert(
    offenders.length === 0,
    'source files contain literal control bytes:\n' +
      offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.codes.join(' ')}`)
        .join('\n') +
      '\nUse escape sequences instead ("\\u001b", "\\u0000"): they are identical at runtime, ' +
      'but literal bytes make the file binary to grep — which silently disables the very ' +
      'control-byte check meant to catch them.',
  )

  console.log(`  scanned ${scanned} files, no stray control bytes`)
  console.log('PASS: no stray control bytes')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
