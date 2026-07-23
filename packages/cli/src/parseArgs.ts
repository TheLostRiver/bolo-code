/**
 * 最小 argv 解析（无 commander 依赖）
 *
 * 支持：
 *   --resume | --resume <id> | --resume=<id> | -r | -r <id>
 *   --continue | -c
 *   --print | -p [prompt]
 *   --cwd <path>
 *   --help | -h
 *   位置参数：拼成 prompt（在 --print 时或作为单轮输入）
 */

export type CliArgs = {
  help: boolean
  /**
   * session id / .json 路径；
   * `true` = `--resume` 无 id，进入项目会话列表选择
   */
  resume?: string | true
  /**
   * `true` = 恢复 listProjectSessions 第一条（最新）
   * 与 --resume 同时出现时 continue 优先
   */
  continue?: boolean
  /** 单轮 / 非交互：有 prompt 则 submit 后退出；无 prompt 则只打印摘要 */
  print: boolean
  /** 用户输入（-p 值、位置参数拼接、或后续由 stdin 填充） */
  prompt?: string
  cwd?: string
  /** 未识别的原始剩余（调试用） */
  rest: string[]
}

function takeValue(
  argv: string[],
  i: number,
  eqValue?: string,
): { value: string; next: number } {
  if (eqValue !== undefined && eqValue !== '') {
    return { value: eqValue, next: i }
  }
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('-')) {
    throw new Error(`missing value after ${argv[i]}`)
  }
  return { value: next, next: i + 1 }
}

/**
 * 解析 process.argv 风格参数（不含 node/tsx 与脚本路径，即 slice(2) 之后）
 */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    help: false,
    print: false,
    rest: [],
  }
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!

    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }

    if (a === '-h' || a === '--help') {
      out.help = true
      continue
    }

    // --continue / -c：resume 列表第一条（最新）
    if (a === '--continue' || a === '-c') {
      out.continue = true
      continue
    }

    if (a === '--print') {
      out.print = true
      continue
    }

    // -p / --prompt：可选紧跟值；单独 -p 只开 print
    if (a === '-p' || a === '--prompt') {
      out.print = true
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        out.prompt = next
        i++
      }
      continue
    }
    if (a.startsWith('-p=') || a.startsWith('--prompt=')) {
      out.print = true
      out.prompt = a.slice(a.indexOf('=') + 1)
      continue
    }

    // --resume / -r：可无 value → picker（true）
    if (a === '--resume' || a === '-r') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        out.resume = true
      } else {
        out.resume = next
        i++
      }
      continue
    }
    if (a.startsWith('--resume=')) {
      const v = a.slice('--resume='.length)
      out.resume = v === '' ? true : v
      continue
    }
    if (a.startsWith('-r=')) {
      const v = a.slice(3)
      out.resume = v === '' ? true : v
      continue
    }

    if (a === '--cwd') {
      const { value, next } = takeValue(argv, i)
      out.cwd = value
      i = next
      continue
    }
    if (a.startsWith('--cwd=')) {
      out.cwd = a.slice('--cwd='.length)
      continue
    }

    if (a.startsWith('-')) {
      throw new Error(`unknown option: ${a}`)
    }

    positionals.push(a)
  }

  if (positionals.length) {
    const joined = positionals.join(' ').trim()
    if (joined) {
      out.prompt = out.prompt ? `${out.prompt} ${joined}` : joined
    }
    out.rest = positionals
  }

  return out
}

/** 是否为「无 id → 列表选择」模式 */
export function isResumePicker(resume: CliArgs['resume']): resume is true {
  return resume === true
}

export function formatHelp(): string {
  return `bolo — Bolo Code 最小 CLI

用法:
  bolo                               新会话（TTY：欢迎 banner + REPL）
  bolo "question"                    新会话单轮 prompt
  bolo --continue                    恢复当前项目最新一条会话
  bolo -c                            同上（--continue 短选项）
  bolo --resume                      列出当前项目会话并选择进入
  bolo --resume <id>                 恢复会话并打印摘要
  bolo --resume <id> -p "prompt"     恢复后单轮 submit 并打印助手输出
  bolo --resume=<id> --print         仅摘要（非交互）
  bolo -r <id> "follow-up question"  位置参数作为 prompt

查找路径（纯 id）:
  1. <cwd>/.bolo/sessions/<id>.json
  2. ~/.bolo/sessions/<id>.json（或 $BOLO_CONFIG_DIR/sessions/）
  也可用绝对/相对 .json 路径作为 id。

REPL 斜杠命令（会话内）:
  /help  /clear  /compact  /context  /model  /effort  /plan  /permissions
  详见 docs/SLASH_COMMANDS.md

选项:
  -c, --continue           恢复 listProjectSessions 第一条（最新）
  -r, --resume [id|path]   恢复会话；无 id 时列项目 .bolo/sessions
  -p, --prompt [text]      单轮 prompt（隐含 --print）
      --print              非交互：有 prompt 则跑一轮，否则只摘要
      --cwd <dir>          解析 project sessions 的工作目录
  -h, --help               帮助

环境:
  NO_COLOR / BOLO_PLAIN=1  欢迎 banner 仅输出一行 BOLO

无 API key 时仍可加载快照 / 启动会话；真正 callModel 时会报错（除非 BOLO_PROVIDER=mock）。
`
}