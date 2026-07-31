/**
 * 自写 DOM Markdown 渲染器（方案 DESKTOP_GUI_PLAN §S3）。
 *
 * 红线：全部用 createElement + textContent 构建 DOM，**绝不使用 innerHTML
 * 拼接任何内容**（模型输出是不可信输入）。链接 href 白名单 http/https。
 * 支持：标题 / 引用 / 列表 / 代码块(fence) / 段落 / 行内码 / 粗体 / 斜体 / 链接。
 *
 * 用法：renderMarkdownInto(container, text) 或 renderMarkdown(text) → DocumentFragment。
 */

const URL_SAFE = /^(https?):\/\//i

function el(tag, className) {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/** 行内渲染：`code`、**bold**、*italic*、[text](url) */
function renderInline(text, parent) {
  // 依次处理：行内码 → 链接 → 粗体 → 斜体（简单顺序扫描，不做嵌套）
  const parts = splitInline(text)
  for (const part of parts) {
    if (part.type === 'code') {
      const code = el('code', 'md-inline-code')
      code.textContent = part.text
      parent.appendChild(code)
    } else if (part.type === 'link') {
      const safe = URL_SAFE.test(part.url)
      if (safe) {
        const a = el('a', 'md-link')
        a.href = part.url
        a.target = '_blank'
        a.rel = 'noreferrer noopener'
        a.textContent = part.text
        parent.appendChild(a)
      } else {
        parent.appendChild(document.createTextNode(`${part.text} (${part.url})`))
      }
    } else if (part.type === 'bold') {
      const strong = el('strong')
      renderInline(part.text, strong)
      parent.appendChild(strong)
    } else if (part.type === 'italic') {
      const em = el('em')
      renderInline(part.text, em)
      parent.appendChild(em)
    } else {
      parent.appendChild(document.createTextNode(part.text))
    }
  }
}

/** 行内切分：把文本切成 纯文本/code/link/bold/italic 段 */
function splitInline(text) {
  const parts = []
  let rest = text
  const token =
    /(`[^`]+`)|(\[[^\]]+\]\(([^)\s]+)\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g
  let last = 0
  let m
  while ((m = token.exec(rest)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'text', text: rest.slice(last, m.index) })
    }
    if (m[1]) {
      parts.push({ type: 'code', text: m[1].slice(1, -1) })
    } else if (m[2]) {
      parts.push({ type: 'link', text: m[2].slice(1, m[2].indexOf(']')), url: m[3] })
    } else if (m[4]) {
      parts.push({ type: 'bold', text: m[4].slice(2, -2) })
    } else if (m[5]) {
      parts.push({ type: 'italic', text: m[5].slice(1, -1) })
    }
    last = m.index + m[0].length
  }
  if (last < rest.length) {
    parts.push({ type: 'text', text: rest.slice(last) })
  }
  return parts
}

/** 块级渲染：把 markdown 文本渲染进 container */
export function renderMarkdownInto(container, text) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/u)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 代码块（fence）
    const fence = /^```(.*)$/.exec(trimmed)
    if (fence) {
      const lang = fence[1].trim()
      const buf = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i += 1
      }
      i += 1 // 跳过闭合 fence
      const pre = el('pre', 'md-code-block')
      if (lang) pre.dataset.lang = lang
      const code = el('code')
      code.textContent = buf.join('\n')
      pre.appendChild(code)
      container.appendChild(pre)
      continue
    }

    // 标题
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (heading) {
      const h = el(`h${heading[1].length}`)
      renderInline(heading[2], h)
      container.appendChild(h)
      i += 1
      continue
    }

    // 引用
    if (trimmed.startsWith('>')) {
      const block = el('blockquote', 'md-quote')
      renderInline(trimmed.replace(/^>\s?/u, ''), block)
      container.appendChild(block)
      i += 1
      continue
    }

    // 无序列表
    if (/^[-*]\s+/.test(trimmed)) {
      const list = el('ul', 'md-list')
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        const li = el('li')
        renderInline(lines[i].trim().replace(/^[-*]\s+/u, ''), li)
        list.appendChild(li)
        i += 1
      }
      container.appendChild(list)
      continue
    }

    // 有序列表
    if (/^\d+\.\s+/.test(trimmed)) {
      const list = el('ol', 'md-list')
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const li = el('li')
        renderInline(lines[i].trim().replace(/^\d+\.\s+/u, ''), li)
        list.appendChild(li)
        i += 1
      }
      container.appendChild(list)
      continue
    }

    // 空行
    if (trimmed === '') {
      i += 1
      continue
    }

    // 段落（合并到下一个空行）
    const para = el('p', 'md-para')
    const buf = []
    while (i < lines.length && lines[i].trim() !== '') {
      buf.push(lines[i].trim())
      i += 1
    }
    renderInline(buf.join(' '), para)
    container.appendChild(para)
  }
  return container
}

/** 渲染为 DocumentFragment（供消息气泡使用） */
export function renderMarkdown(text) {
  const frag = document.createDocumentFragment()
  return renderMarkdownInto(frag, text)
}
