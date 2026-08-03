/**
 * CBG-1 · 符号索引懒启动 + 门控
 *
 * 覆盖：
 * - 懒启动：不调用则不创建缓存
 * - 门控：BOLO_DISABLE_SYMBOLS 开关、git 仓库检测
 * - 构建：多语言定义模式提取（ts/rs/go/py）
 * - 缓存命中 / 版本戳重建（源文件修改）
 * - 并发锁：新鲜锁拒绝、陈旧锁清理
 * - /symbol slash 命令（命中/无匹配/非 git/开关关闭）
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  symbolsEnabled,
  isGitRepository,
  buildSymbolIndex,
  computeSymbolVersion,
  loadOrBuildSymbolIndex,
  LOCK_STALE_MS,
} from '../packages/core/src/symbolIndex.ts'
import { createSession, dispatchSlashCommand } from '../packages/core/src/index.ts'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bolo-sym-'))
const home = path.join(tmp, 'home')
await fs.mkdir(home, { recursive: true })
const prevConfigDir = process.env.BOLO_CONFIG_DIR
process.env.BOLO_CONFIG_DIR = home

async function makeRepo(name: string): Promise<string> {
  const repo = path.join(tmp, name)
  await fs.mkdir(path.join(repo, '.git', 'refs', 'heads'), { recursive: true })
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  await fs.writeFile(
    path.join(repo, '.git', 'refs', 'heads', 'main'),
    '0123456789abcdef0123456789abcdef01234567\n',
    'utf8',
  )
  return repo
}

// --- 1. 懒启动：不调用不创建缓存 ---
{
  const repo = await makeRepo('lazy')
  await fs.writeFile(path.join(repo, 'a.ts'), 'export function lazyFn() {}\n', 'utf8')
  const cacheDir = path.join(home, 'indexes')
  assert(
    !(await fs.stat(cacheDir).catch(() => null)),
    'no cache dir before first query',
  )
  await loadOrBuildSymbolIndex(repo)
  assert(
    await fs.stat(cacheDir).catch(() => null),
    'cache dir created after first query',
  )
}

// --- 2. 门控：开关 + git 检测 ---
{
  assert.equal(symbolsEnabled({}), true, 'enabled by default')
  assert.equal(symbolsEnabled({ BOLO_DISABLE_SYMBOLS: '1' }), false, 'disabled flag')
  assert.equal(
    symbolsEnabled({ BOLO_DISABLE_SYMBOLS: 'true' }),
    false,
    'disabled true',
  )
  const repo = await makeRepo('gate-repo')
  assert.equal(await isGitRepository(repo), true, 'git dir detected')
  const plain = path.join(tmp, 'plain')
  await fs.mkdir(plain, { recursive: true })
  assert.equal(await isGitRepository(plain), false, 'non-git rejected')
}

// --- 3. 构建：多语言定义提取 ---
{
  const repo = await makeRepo('build')
  await fs.writeFile(
    path.join(repo, 'lib.ts'),
    [
      'export function tsFn(a: number): number { return a }',
      'export class TsClass {}',
      'export interface TsIface {}',
      'export type TsType = string',
      'export const tsConst = 42',
      'const arrowFn = (x: number) => x',
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(repo, 'main.rs'),
    ['pub fn rs_fn() {}', 'pub struct RsStruct;', 'pub enum RsEnum {}'].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(repo, 'main.go'),
    ['func GoFn() {}', 'func (s *T) Method() {}'].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(repo, 'app.py'),
    ['def py_fn():', '    pass', 'class PyClass:', '    pass'].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(repo, 'cpp.cpp'),
    ['enum class Color { Red };', 'enum Old { A };'].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(repo, 'default.ts'),
    ['export default function defaultFn() {}', 'export default async function asyncDefaultFn() {}'].join('\n'),
    'utf8',
  )
  await fs.writeFile(
    path.join(repo, 'types.go'),
    ['type User struct { Name string }', 'type Reader interface { Read() }'].join('\n'),
    'utf8',
  )
  // 黑名单目录不扫描
  await fs.mkdir(path.join(repo, 'node_modules'), { recursive: true })
  await fs.writeFile(
    path.join(repo, 'node_modules', 'skip.ts'),
    'export function skipped() {}',
    'utf8',
  )
  const index = await buildSymbolIndex(repo)
  const names = index.symbols.map((s) => s.name)
  for (const expected of [
    'tsFn',
    'TsClass',
    'TsIface',
    'TsType',
    'tsConst',
    'arrowFn',
    'rs_fn',
    'RsStruct',
    'RsEnum',
    'GoFn',
    'Method',
    'py_fn',
    'PyClass',
    'Color',
    'Old',
    'defaultFn',
    'asyncDefaultFn',
    'User',
    'Reader',
  ]) {
    assert(names.includes(expected), `symbol extracted: ${expected}`)
  }
  const color = index.symbols.find((s) => s.name === 'Color')!
  assert.equal(color.kind, 'enum', 'scoped enum kind (not class)')
  const user = index.symbols.find((s) => s.name === 'User')!
  assert.equal(user.kind, 'type', 'go struct type kind')
  assert(!names.includes('skipped'), 'node_modules skipped')
  const tsFn = index.symbols.find((s) => s.name === 'tsFn')!
  assert.equal(tsFn.kind, 'function', 'ts fn kind')
  assert.equal(tsFn.file, 'lib.ts', 'ts fn file')
  assert.equal(tsFn.line, 1, 'ts fn line')
}

// --- 4. 缓存命中 / 版本戳重建 ---
{
  const repo = await makeRepo('cache')
  const src = path.join(repo, 'a.ts')
  await fs.writeFile(src, 'export function v1Fn() {}\n', 'utf8')
  const first = await loadOrBuildSymbolIndex(repo)
  assert.equal(first.rebuilt, true, 'first build rebuilds')
  const second = await loadOrBuildSymbolIndex(repo)
  assert.equal(second.rebuilt, false, 'second load hits cache')
  // 修改源文件（确保 mtime 变化）
  await new Promise((r) => setTimeout(r, 20))
  await fs.writeFile(src, 'export function v1Fn() {}\nexport function v2Fn() {}\n', 'utf8')
  const third = await loadOrBuildSymbolIndex(repo)
  assert.equal(third.rebuilt, true, 'source change triggers rebuild')
  assert(
    third.index.symbols.some((s) => s.name === 'v2Fn'),
    'rebuild picks up new symbol',
  )
  assert(
    first.index.version !== third.index.version,
    'version changed after edit',
  )
}

// --- 5. 并发锁：新鲜锁拒绝、陈旧锁清理 ---
{
  const repo = await makeRepo('lock')
  await fs.writeFile(path.join(repo, 'a.ts'), 'export function lockFn() {}\n', 'utf8')
  // 清空 indexes（让锁路径推导唯一）
  await fs.rm(path.join(home, 'indexes'), { recursive: true, force: true })
  // 预构建一次让缓存存在
  await loadOrBuildSymbolIndex(repo)
  const indexesDir = path.join(home, 'indexes')
  const files = await fs.readdir(indexesDir)
  const lockFile = files.find((f) => f.endsWith('.lock'))
  const jsonFile = files.find((f) => f.endsWith('.json'))!
  assert(lockFile === undefined, 'no lock after build')
  const lockPath = `${path.join(indexesDir, jsonFile)}.lock`
  // 先删缓存强制重建路径
  await fs.rm(path.join(indexesDir, jsonFile), { force: true })
  await fs.writeFile(lockPath, String(Date.now()), 'utf8')
  let inProgress = false
  try {
    await loadOrBuildSymbolIndex(repo)
  } catch (err) {
    inProgress = err instanceof Error && err.message.includes('in progress')
  }
  assert(inProgress, 'fresh lock rejects concurrent build')
  // 陈旧锁 → 清理并构建
  await fs.writeFile(lockPath, String(Date.now() - LOCK_STALE_MS - 1_000), 'utf8')
  const after = await loadOrBuildSymbolIndex(repo)
  assert.equal(after.rebuilt, true, 'stale lock cleared and rebuilt')
}

// --- 6. /symbol slash 命令 ---
{
  const repo = await makeRepo('slash')
  await fs.writeFile(
    path.join(repo, 'api.ts'),
    'export function findUser() {}\nexport function findPost() {}\n',
    'utf8',
  )
  const session = await createSession({
    cwd: repo,
    systemPrompt: false,
    provider: {
      id: 'mock',
      async *completeStream() {
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'done' }
      },
    },
  })
  const hit = await dispatchSlashCommand(session, 'symbol', 'findUser')
  assert(hit.ok === true, 'slash symbol ok')
  assert(
    hit.message.includes('api.ts:1') && hit.message.includes('findUser'),
    'slash symbol reports file:line',
  )
  const miss = await dispatchSlashCommand(session, 'symbol', 'noSuchSymbol')
  assert(miss.ok === true && miss.message.includes('No symbols'), 'slash miss')
  // 非 git → 拒绝
  const plain = path.join(tmp, 'plain2')
  await fs.mkdir(plain, { recursive: true })
  const plainSession = await createSession({
    cwd: plain,
    systemPrompt: false,
    provider: {
      id: 'mock',
      async *completeStream() {
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'done' }
      },
    },
  })
  const noGit = await dispatchSlashCommand(plainSession, 'symbol', 'findUser')
  assert(noGit.ok === false && noGit.message.includes('git repository'), 'non-git rejected')
  // 开关关闭
  const prevDisable = process.env.BOLO_DISABLE_SYMBOLS
  process.env.BOLO_DISABLE_SYMBOLS = '1'
  try {
    const off = await dispatchSlashCommand(session, 'symbol', 'findUser')
    assert(off.ok === false && off.message.includes('disabled'), 'disabled rejected')
  } finally {
    if (prevDisable === undefined) delete process.env.BOLO_DISABLE_SYMBOLS
    else process.env.BOLO_DISABLE_SYMBOLS = prevDisable
  }
}

// --- 7. computeSymbolVersion 直接验证 ---
{
  const repo = await makeRepo('ver')
  await fs.writeFile(path.join(repo, 'a.ts'), 'export function verFn() {}\n', 'utf8')
  const v1 = await computeSymbolVersion(repo)
  await new Promise((r) => setTimeout(r, 20))
  await fs.writeFile(path.join(repo, 'a.ts'), 'export function verFn() {}\n// comment\n', 'utf8')
  const v2 = await computeSymbolVersion(repo)
  assert(v1 !== v2, 'version changes when source mtime changes')
}

if (prevConfigDir === undefined) delete process.env.BOLO_CONFIG_DIR
else process.env.BOLO_CONFIG_DIR = prevConfigDir
await fs.rm(tmp, { recursive: true, force: true })
console.log('PASS: CBG-1 symbol index lazy build + gates')
