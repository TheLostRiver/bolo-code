/**
 * Tiny streaming inline Markdown renderer for interactive terminal output.
 *
 * It intentionally handles only emphasis and inline code. Block Markdown stays
 * textual so partial provider chunks can stream without buffering paragraphs.
 */

export type TerminalMarkdownStream = {
  push: (text: string) => string
  finish: () => string
  reset: () => void
}

export function createTerminalMarkdownStream(options?: {
  color?: boolean
}): TerminalMarkdownStream {
  const color = options?.color !== false
  const boldOn = color ? '\u001b[1m' : ''
  const codeOn = color ? '\u001b[38;5;215m' : ''
  const reset = color ? '\u001b[0m' : ''
  let bold = false
  let code = false
  let pending = ''

  const activeStyle = () => {
    if (!color) return ''
    if (code) return codeOn
    if (bold) return boldOn
    return ''
  }

  return {
    push(text) {
      const input = `${pending}${text}`
      pending = ''
      let out = ''
      for (let index = 0; index < input.length; index++) {
        const char = input[index]!
        if (char === '*') {
          if (index + 1 >= input.length) {
            pending = '*'
            break
          }
          if (input[index + 1] === '*') {
            bold = !bold
            out += color ? `${reset}${activeStyle()}` : ''
            index++
            continue
          }
        }
        if (char === '`') {
          code = !code
          out += color ? `${reset}${activeStyle()}` : ''
          continue
        }
        if (char === '\n' && color && (bold || code)) {
          out += `${reset}\n${activeStyle()}`
          continue
        }
        out += char
      }
      return out
    },
    finish() {
      const tail = pending
      pending = ''
      const suffix = color && (bold || code) ? reset : ''
      bold = false
      code = false
      return `${tail}${suffix}`
    },
    reset() {
      pending = ''
      bold = false
      code = false
    },
  }
}
