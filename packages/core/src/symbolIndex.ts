/**
 * CBG-1 · 符号索引（懒启动 + 门控）
 *
 * 仓库符号索引（定义）按需懒构建：仅 `/symbol` 显式请求时激活；
 * 四道门控（git 仓库 / BOLO_DISABLE_SYMBOLS 开关 / 显式请求 / 能力）。
 * 缓存放用户目录（`~/.bolo/indexes/`）不污染项目；版本戳（HEAD commit +
 * 最新源文件 mtime）驱动自动重建；锁文件防并发构建。
 *
 * 全部本地、零运行时依赖（纯正则扫描，不依赖 ripgrep/LSP）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getBoloHomeDir } from '../../config/src/paths.ts'

/** 符号条目 */
export type SymbolEntry = {
  name: string
  kind: SymbolKind
  file: string
  line: number
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'struct'
  | 'enum'
  | 'method'
  | 'def'

export type SymbolIndex = {
  /** 版本戳（HEAD commit + 最新源文件 mtime）；查询命中缓存则重建 */
  version: string
  /** 相对仓库根的源文件路径 → 符号列表 */
  symbols: SymbolEntry[]
}

/** 扫描的源文件扩展名 */
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.go',
  '.py',
  '.java',
  '.cs',
  '.cpp',
  '.cc',
  '.c',
  '.h',
  '.hpp',
  '.kt',
  '.swift',
])

/** 扫描时跳过的目录 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  'vendor',
  '.venv',
  '__pycache__',
  '.bolo',
])

/** 单文件大小上限（跳过超大文件） */
const MAX_FILE_BYTES = 1_000_000
/** 扫描文件数上限 */
const MAX_SCANNED_FILES = 5_000
/** 缓存锁超时（毫秒）：陈旧锁强制清理 */
export const LOCK_STALE_MS = 30_000

/** 定义模式表：pattern + kind（行级匹配） */
const DEFINITION_PATTERNS: Array<{ re: RegExp; kind: SymbolKind }> = [
  // C++ scoped enum 最前：`enum class Foo` 不被 Rust/Java 的 enum 分支误提取
  { re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed)\s+)*enum\s+class\s+([A-Za-z_][\w]*)/, kind: 'enum' },
  // TypeScript / JavaScript（export default function/async function 也覆盖）
  { re: /^\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type' },
  { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const' },
  { re: /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/, kind: 'const' },
  // Rust（pub(...) 可见性 + async fn 也覆盖）
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, kind: 'function' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, kind: 'struct' },
  // Go（导出函数 + type Foo struct/interface）
  { re: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Z][\w]*)/, kind: 'function' },
  { re: /^\s*type\s+([A-Z][\w]*)\s+(?:struct|interface)/, kind: 'type' },
  // Python
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, kind: 'def' },
  { re: /^\s*class\s+([A-Za-z_][\w]*)/, kind: 'class' },
  // Java / C# / C++
  { re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed)\s+)*(?:class|interface|enum|struct)\s+([A-Za-z_][\w]*)/, kind: 'class' },
]

/** 门控 1/2：能力开关（BOLO_DISABLE_SYMBOLS 熔断） */
export function symbolsEnabled(env?: NodeJS.ProcessEnv): boolean {
  const raw = (env ?? process.env).BOLO_DISABLE_SYMBOLS
  if (raw === undefined) return true
  return !['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

/** 门控 3：git 仓库检测（.git 目录或 worktree 文件） */
export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(cwd, '.git'))
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}

/** 版本戳：HEAD commit + 最新源文件 mtime（源文件变化 → 重建） */
export async function computeSymbolVersion(cwd: string): Promise<string> {
  let commit = ''
  try {
    const headRaw = await fs.readFile(path.join(cwd, '.git', 'HEAD'), 'utf8')
    const ref = headRaw.trim().match(/^ref:\s+(.+)$/)?.[1]
    if (ref) {
      // 安全：ref 只接受 `refs/...` 白名单形态（恶意 repo 的 `ref: ../../x`
      // 会让 readFile 越出 .git 读任意文件——拒绝并回退 mtime-only 版本）
      if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref)) {
        commit = 'badref'
      } else {
        commit = (
          await fs.readFile(path.join(cwd, '.git', ref), 'utf8')
        ).trim()
      }
    } else {
      commit = headRaw.trim()
    }
  } catch {
    commit = 'nogit'
  }
  let newestMtime = 0
  try {
    await walkSourceFiles(cwd, (_abs, _rel, st) => {
      if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs
    })
  } catch {
    /* mtime 收集失败不阻断 */
  }
  return `${commit.slice(0, 12)}:${newestMtime}`
}

/** 遍历源文件（跳过黑名单目录；回调不中断） */
async function walkSourceFiles(
  cwd: string,
  onFile: (
    abs: string,
    rel: string,
    st: { mtimeMs: number; size: number },
  ) => void | Promise<void>,
): Promise<void> {
  let scanned = 0
  async function walk(dir: string): Promise<void> {
    if (scanned >= MAX_SCANNED_FILES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (scanned >= MAX_SCANNED_FILES) break
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        await walk(path.join(dir, ent.name))
        continue
      }
      if (!ent.isFile()) continue
      const ext = path.extname(ent.name).toLowerCase()
      if (!SOURCE_EXTENSIONS.has(ext)) continue
      const abs = path.join(dir, ent.name)
      let st
      try {
        st = await fs.stat(abs)
      } catch {
        continue
      }
      if (st.size > MAX_FILE_BYTES) continue
      scanned += 1
      await onFile(abs, path.relative(cwd, abs).split(path.sep).join('/'), st)
    }
  }
  await walk(cwd)
}

/** 构建符号索引（懒触发；扫描 + 行级正则提取） */
export async function buildSymbolIndex(cwd: string): Promise<SymbolIndex> {
  const symbols: SymbolEntry[] = []
  await walkSourceFiles(cwd, async (abs, rel, _st) => {
    let raw: string
    try {
      raw = await fs.readFile(abs, 'utf8')
    } catch {
      return
    }
    const lines = raw.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      for (const { re, kind } of DEFINITION_PATTERNS) {
        const m = re.exec(line)
        if (m?.[1]) {
          symbols.push({ name: m[1], kind, file: rel, line: i + 1 })
          break // 一行只记第一个定义
        }
      }
    }
  })
  return { version: await computeSymbolVersion(cwd), symbols }
}

function repoKey(cwd: string): string {
  let h = 0
  const s = path.resolve(cwd)
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `repo${h >>> 0}`
}

function indexPath(cwd: string): string {
  return path.join(
    getBoloHomeDir(),
    'indexes',
    `${repoKey(cwd)}.json`,
  )
}

function lockPath(cwd: string): string {
  return `${indexPath(cwd)}.lock`
}

/**
 * 懒加载/构建符号索引：缓存命中（版本戳匹配）→ 读缓存；
 * 否则构建 + 原子写。并发构建用锁文件防重（陈旧锁强制清理）。
 * 返回 { index, rebuilt }——rebuilt=true 表示本次构建（缓存未命中）。
 */
export async function loadOrBuildSymbolIndex(
  cwd: string,
  opts?: { now?: () => number },
): Promise<{ index: SymbolIndex; rebuilt: boolean }> {
  const now = opts?.now ?? (() => Date.now())
  const cachePath = indexPath(cwd)
  const lock = lockPath(cwd)

  // 缓存命中：版本戳匹配直接返回
  try {
    const cached = JSON.parse(
      await fs.readFile(cachePath, 'utf8'),
    ) as SymbolIndex
    const current = await computeSymbolVersion(cwd)
    if (cached.version === current) {
      return { index: cached, rebuilt: false }
    }
  } catch {
    /* 无缓存/损坏 → 重建 */
  }

  // 锁：独占创建（open 'wx'）——并发构建防重的真实排除语义。
  // 锁内容 = `<ts>:<token>`（令牌归属：finally 只删自己的锁）。
  // 已存在 → 读内容时间戳判陈旧（>LOCK_STALE_MS 清理后**重新获取**）。
  const token = `${now()}:${Math.random().toString(36).slice(2, 10)}`
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 2) throw new Error('symbol index build in progress')
    try {
      const fh = await fs.open(lock, 'wx')
      await fh.writeFile(token, 'utf8')
      await fh.close()
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        if (code === 'ENOENT') {
          // 目录刚建好前的竞态：重试
          await fs.mkdir(path.dirname(cachePath), { recursive: true })
          continue
        }
        throw err
      }
      let stale = false
      try {
        const raw = await fs.readFile(lock, 'utf8')
        const ts = Number(raw.trim().split(':')[0])
        stale = !Number.isFinite(ts) || now() - ts >= LOCK_STALE_MS
      } catch {
        stale = true
      }
      if (!stale) {
        throw new Error('symbol index build in progress')
      }
      await fs.rm(lock, { force: true })
      // 清理后循环重新获取（不给并发者留空窗）
    }
  }

  try {
    const index = await buildSymbolIndex(cwd)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    const tmp = `${cachePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(index), 'utf8')
    await fs.rename(tmp, cachePath)
    return { index, rebuilt: true }
  } finally {
    // 只删自己的锁（内容令牌匹配——防删掉并发者刚创建的新锁）
    try {
      const raw = await fs.readFile(lock, 'utf8')
      if (raw.trim() === token) await fs.rm(lock, { force: true })
    } catch {
      /* 锁已被清理/不存在 */
    }
  }
}

/** 查询：名称包含匹配（大小写不敏感） */
export function querySymbols(
  index: SymbolIndex,
  query: string,
  limit = 50,
): SymbolEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return index.symbols
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, limit)
}
