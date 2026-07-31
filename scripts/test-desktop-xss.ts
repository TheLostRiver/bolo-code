/**
 * XSS 门禁（方案 DESKTOP_GUI_PLAN §S3）：renderer 源码禁止 innerHTML 拼接。
 * 模型输出/会话内容是不可信输入，消息渲染必须全 DOM API（createElement + textContent）。
 * 守住：.innerHTML 赋值/读取、insertAdjacentHTML、document.write、eval/new Function。
 */
import { strict as assert } from 'node:assert'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const rendererDir = path.resolve(
  import.meta.dirname,
  '..',
  'apps',
  'desktop',
  'src',
  'renderer',
)

const FORBIDDEN = [
  /\.outerHTML\s*[+=]?=/,
  /insertAdjacentHTML\s*\(/,
  /document\.write\s*\(/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
]

// innerHTML 只允许清空（`= ''` / `= ""`）；禁止拼接任何内容
const INNER_HTML_ASSIGN = /\.innerHTML\s*(?:\+=|=)/

function isClearAssignment(text: string, match: RegExpExecArray): boolean {
  const rest = text.slice(match.index + match[0].length).trimStart()
  return /^(''|"")/.test(rest)
}

async function main() {
  const files = (await fs.readdir(rendererDir)).filter((f) => f.endsWith('.js'))
  assert.ok(files.length >= 2, `renderer has files, got ${files.length}`)
  let scanned = 0
  for (const file of files) {
    const text = await fs.readFile(path.join(rendererDir, file), 'utf8')
    scanned += 1
    for (const pattern of FORBIDDEN) {
      const m = pattern.exec(text)
      assert.ok(
        !m,
        `${file}: forbidden pattern ${pattern} at "${m?.[0]}"`,
      )
    }
    const inner = INNER_HTML_ASSIGN.exec(text)
    if (inner) {
      assert.ok(
        isClearAssignment(text, inner),
        `${file}: innerHTML must only be cleared (''), not assigned content`,
      )
    }
  }
  console.log(`PASS: renderer XSS guard (${scanned} files scanned)`)
}

await main()
