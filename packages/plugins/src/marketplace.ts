/**
 * 插件市场最小实现（PL-MKT）
 *
 * 对照 HelsincyCode marketplace 语义的**极简子集**：
 * - 本地/URL 目录清单（marketplace.json）
 * - 从清单安装到 user/project plugins 目录
 * - known_marketplaces + installed 记录
 *
 * **不做**：官方命名保留、企业策略、zip cache、npm、OAuth、自动更新守护。
 * 无遥测。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getProjectLayout, getUserLayout } from '../../config/src/paths.ts'
import type { PluginScope } from './index.ts'

export type MarketplacePluginSource =
  | { type: 'path'; path: string }
  | { type: 'url'; url: string }

export type MarketplacePluginEntry = {
  id: string
  name?: string
  version?: string
  description?: string
  source: MarketplacePluginSource
}

export type MarketplaceCatalog = {
  name: string
  description?: string
  plugins: MarketplacePluginEntry[]
}

export type KnownMarketplace = {
  name: string
  /** path 到本地目录或 marketplace.json；或 https URL */
  source: string
  /** 本地解析后的根目录（URL 源为 cache 目录） */
  installLocation: string
  registeredAt: string
}

export type InstalledPluginRecord = {
  id: string
  marketplace?: string
  version?: string
  scope: PluginScope
  installPath: string
  installedAt: string
  source: string
}

export type KnownMarketplacesFile = {
  version: 1
  marketplaces: Record<string, KnownMarketplace>
}

export type InstalledPluginsFile = {
  version: 1
  plugins: Record<string, InstalledPluginRecord>
}

function nowIso(): string {
  return new Date().toISOString()
}

export function marketplacesDir(boloRoot: string): string {
  return path.join(boloRoot, 'marketplaces')
}

export function knownMarketplacesPath(boloRoot: string): string {
  return path.join(marketplacesDir(boloRoot), 'known.json')
}

export function installedPluginsPath(boloRoot: string): string {
  return path.join(boloRoot, 'installed_plugins.json')
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  try {
    await fs.rename(tmp, file)
  } catch {
    await fs.unlink(file).catch(() => {})
    await fs.rename(tmp, file)
  }
}

export async function loadKnownMarketplaces(
  boloRoot: string,
): Promise<KnownMarketplacesFile> {
  const data = await readJsonFile<KnownMarketplacesFile>(
    knownMarketplacesPath(boloRoot),
  )
  if (data?.version === 1 && data.marketplaces) return data
  return { version: 1, marketplaces: {} }
}

export async function loadInstalledPlugins(
  boloRoot: string,
): Promise<InstalledPluginsFile> {
  const data = await readJsonFile<InstalledPluginsFile>(
    installedPluginsPath(boloRoot),
  )
  if (data?.version === 1 && data.plugins) return data
  return { version: 1, plugins: {} }
}

/**
 * 解析 marketplace 清单 JSON（文件内容）。
 * 兼容 name + plugins[]；插件 source 可为 path 字符串或 {type,path|url}。
 */
export function parseMarketplaceCatalog(raw: unknown): MarketplaceCatalog {
  if (!raw || typeof raw !== 'object') {
    throw new Error('marketplace: invalid JSON object')
  }
  const o = raw as Record<string, unknown>
  const name =
    typeof o.name === 'string' && o.name.trim()
      ? o.name.trim()
      : typeof o.id === 'string' && o.id.trim()
        ? o.id.trim()
        : ''
  if (!name) throw new Error('marketplace: missing name')
  if (!Array.isArray(o.plugins)) {
    throw new Error('marketplace: plugins must be an array')
  }
  const plugins: MarketplacePluginEntry[] = []
  for (const item of o.plugins) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const id =
      typeof p.id === 'string' && p.id.trim()
        ? p.id.trim()
        : typeof p.name === 'string' && p.name.trim()
          ? p.name.trim()
          : ''
    if (!id) continue
    const source = normalizeEntrySource(p.source)
    if (!source) {
      throw new Error(`marketplace: plugin ${id} missing source`)
    }
    plugins.push({
      id,
      name: typeof p.name === 'string' ? p.name : id,
      version: typeof p.version === 'string' ? p.version : undefined,
      description:
        typeof p.description === 'string' ? p.description : undefined,
      source,
    })
  }
  return {
    name,
    description:
      typeof o.description === 'string' ? o.description : undefined,
    plugins,
  }
}

function normalizeEntrySource(raw: unknown): MarketplacePluginSource | null {
  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim()
    if (/^https?:\/\//i.test(s)) return { type: 'url', url: s }
    return { type: 'path', path: s }
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.type === 'url' && typeof o.url === 'string' && o.url.trim()) {
    return { type: 'url', url: o.url.trim() }
  }
  if (o.type === 'path' && typeof o.path === 'string' && o.path.trim()) {
    return { type: 'path', path: o.path.trim() }
  }
  if (typeof o.path === 'string' && o.path.trim()) {
    return { type: 'path', path: o.path.trim() }
  }
  if (typeof o.url === 'string' && o.url.trim()) {
    return { type: 'url', url: o.url.trim() }
  }
  return null
}

/** 从本地路径加载 catalog（目录 → marketplace.json / bolo.marketplace.json） */
export async function loadMarketplaceCatalogFromPath(
  sourcePath: string,
): Promise<{ catalog: MarketplaceCatalog; root: string; manifestPath: string }> {
  const abs = path.resolve(sourcePath)
  let st: Awaited<ReturnType<typeof fs.stat>>
  try {
    st = await fs.stat(abs)
  } catch {
    throw new Error(`marketplace path not found: ${sourcePath}`)
  }

  let manifestPath: string
  let root: string
  if (st.isDirectory()) {
    root = abs
    const candidates = [
      path.join(abs, 'bolo.marketplace.json'),
      path.join(abs, 'marketplace.json'),
      path.join(abs, '.bolo-plugin', 'marketplace.json'),
      path.join(abs, '.claude-plugin', 'marketplace.json'),
    ]
    let found: string | undefined
    for (const c of candidates) {
      try {
        await fs.access(c)
        found = c
        break
      } catch {
        /* next */
      }
    }
    if (!found) {
      throw new Error(
        `marketplace: no marketplace.json in directory ${sourcePath}`,
      )
    }
    manifestPath = found
  } else {
    manifestPath = abs
    root = path.dirname(abs)
  }

  const data = await readJsonFile<unknown>(manifestPath)
  if (!data) throw new Error(`marketplace: cannot read ${manifestPath}`)
  const catalog = parseMarketplaceCatalog(data)
  return { catalog, root, manifestPath }
}

/** 从 http(s) URL 拉取 catalog JSON */
export async function loadMarketplaceCatalogFromUrl(
  url: string,
  cacheDir: string,
): Promise<{ catalog: MarketplaceCatalog; root: string; manifestPath: string }> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`marketplace URL HTTP ${res.status}: ${url}`)
  }
  const data = (await res.json()) as unknown
  const catalog = parseMarketplaceCatalog(data)
  await fs.mkdir(cacheDir, { recursive: true })
  const manifestPath = path.join(cacheDir, 'marketplace.json')
  await writeJsonAtomic(manifestPath, data)
  return { catalog, root: cacheDir, manifestPath }
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim())
}

/**
 * 注册 marketplace 到 known.json。
 * source：本地目录/json 路径，或 http(s) URL。
 */
export async function registerMarketplace(opts: {
  source: string
  /** 默认 user ~/.bolo */
  boloRoot?: string
  name?: string
}): Promise<{ known: KnownMarketplace; catalog: MarketplaceCatalog }> {
  const boloRoot = opts.boloRoot ?? getUserLayout().root
  const source = opts.source.trim()
  if (!source) throw new Error('marketplace: empty source')

  const mkDir = marketplacesDir(boloRoot)
  await fs.mkdir(mkDir, { recursive: true })

  let catalog: MarketplaceCatalog
  let installLocation: string

  if (isHttpUrl(source)) {
    const tmpName = opts.name?.trim() || `url-${Date.now().toString(36)}`
    const cache = path.join(mkDir, sanitizeName(tmpName))
    const loaded = await loadMarketplaceCatalogFromUrl(source, cache)
    catalog = loaded.catalog
    installLocation = loaded.root
  } else {
    const loaded = await loadMarketplaceCatalogFromPath(source)
    catalog = loaded.catalog
    installLocation = loaded.root
  }

  const name = sanitizeName(opts.name?.trim() || catalog.name)
  const known: KnownMarketplace = {
    name,
    source,
    installLocation,
    registeredAt: nowIso(),
  }

  const file = await loadKnownMarketplaces(boloRoot)
  file.marketplaces[name] = known
  await writeJsonAtomic(knownMarketplacesPath(boloRoot), file)

  // 缓存 catalog 副本
  const catPath = path.join(mkDir, name, 'marketplace.json')
  await fs.mkdir(path.dirname(catPath), { recursive: true })
  await writeJsonAtomic(catPath, {
    name: catalog.name,
    description: catalog.description,
    plugins: catalog.plugins,
  })

  return { known, catalog: { ...catalog, name } }
}

function sanitizeName(n: string): string {
  return n.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'market'
}

export async function listKnownMarketplaces(
  boloRoot?: string,
): Promise<KnownMarketplace[]> {
  const root = boloRoot ?? getUserLayout().root
  const file = await loadKnownMarketplaces(root)
  return Object.values(file.marketplaces).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
}

export async function loadCatalogForKnown(
  known: KnownMarketplace,
): Promise<MarketplaceCatalog> {
  if (isHttpUrl(known.source)) {
    try {
      const loaded = await loadMarketplaceCatalogFromUrl(
        known.source,
        known.installLocation,
      )
      return { ...loaded.catalog, name: known.name }
    } catch {
      /* fall through to cache */
    }
  }
  try {
    const loaded = await loadMarketplaceCatalogFromPath(
      known.installLocation,
    )
    return { ...loaded.catalog, name: known.name }
  } catch {
    const cached = path.join(
      path.dirname(known.installLocation),
      known.name,
      'marketplace.json',
    )
    const data = await readJsonFile<unknown>(cached)
    if (data) {
      const c = parseMarketplaceCatalog(data)
      return { ...c, name: known.name }
    }
    throw new Error(`marketplace ${known.name}: catalog unavailable`)
  }
}

export type MarketplaceSearchHit = {
  marketplace: string
  entry: MarketplacePluginEntry
}

export async function searchMarketplacePlugins(opts?: {
  query?: string
  boloRoot?: string
  marketplace?: string
}): Promise<MarketplaceSearchHit[]> {
  const root = opts?.boloRoot ?? getUserLayout().root
  const known = await listKnownMarketplaces(root)
  const q = opts?.query?.trim().toLowerCase()
  const hits: MarketplaceSearchHit[] = []
  for (const k of known) {
    if (opts?.marketplace && k.name !== opts.marketplace) continue
    let catalog: MarketplaceCatalog
    try {
      catalog = await loadCatalogForKnown(k)
    } catch {
      continue
    }
    for (const entry of catalog.plugins) {
      if (!q) {
        hits.push({ marketplace: k.name, entry })
        continue
      }
      const blob = [
        entry.id,
        entry.name,
        entry.description,
        entry.version,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (blob.includes(q)) hits.push({ marketplace: k.name, entry })
    }
  }
  return hits
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const from = path.join(src, e.name)
    const to = path.join(dest, e.name)
    if (e.isDirectory()) await copyDir(from, to)
    else if (e.isFile()) await fs.copyFile(from, to)
  }
}

/**
 * 从 marketplace 安装插件到 user 或 project plugins 目录。
 * 仅支持 source.type=path（相对 marketplace 根或绝对路径）。
 * url 源插件：仅当 URL 指向可 fetch 的 zip 时后置；当前报错提示用 path。
 */
export async function installPluginFromMarketplace(opts: {
  pluginId: string
  marketplace: string
  scope?: 'user' | 'project'
  cwd?: string
  boloRoot?: string
}): Promise<InstalledPluginRecord> {
  const scope = opts.scope ?? 'user'
  const userRoot = opts.boloRoot ?? getUserLayout().root
  const knownFile = await loadKnownMarketplaces(userRoot)
  const known = knownFile.marketplaces[opts.marketplace]
  if (!known) {
    throw new Error(
      `marketplace not registered: ${opts.marketplace} (use /plugins market add)`,
    )
  }
  const catalog = await loadCatalogForKnown(known)
  const entry = catalog.plugins.find(
    (p) => p.id === opts.pluginId || p.name === opts.pluginId,
  )
  if (!entry) {
    throw new Error(
      `plugin ${opts.pluginId} not found in marketplace ${opts.marketplace}`,
    )
  }

  let sourceDir: string
  if (entry.source.type === 'path') {
    sourceDir = path.isAbsolute(entry.source.path)
      ? entry.source.path
      : path.resolve(known.installLocation, entry.source.path)
  } else {
    throw new Error(
      `plugin ${entry.id}: url install not supported in minimal marketplace (use path source or copy plugin folder to plugins/)`,
    )
  }

  const st = await fs.stat(sourceDir).catch(() => null)
  if (!st?.isDirectory()) {
    throw new Error(`plugin source not a directory: ${sourceDir}`)
  }
  const manifestPath = path.join(sourceDir, 'bolo.plugin.json')
  const manifest = await readJsonFile<{ id?: string; version?: string }>(
    manifestPath,
  )
  if (!manifest?.id) {
    throw new Error(
      `plugin source missing bolo.plugin.json: ${sourceDir}`,
    )
  }

  const pluginsDir =
    scope === 'project'
      ? getProjectLayout(opts.cwd ?? process.cwd()).pluginsDir
      : path.join(userRoot, 'plugins')
  const dest = path.join(pluginsDir, manifest.id)
  await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
  await copyDir(sourceDir, dest)

  const record: InstalledPluginRecord = {
    id: manifest.id,
    marketplace: known.name,
    version: entry.version ?? manifest.version,
    scope,
    installPath: dest,
    installedAt: nowIso(),
    source: sourceDir,
  }

  // 安装记录写在 user root（全局账本）；project 安装也记一条
  const installed = await loadInstalledPlugins(userRoot)
  const key =
    scope === 'project'
      ? `${record.id}@${path.resolve(opts.cwd ?? process.cwd())}`
      : record.id
  installed.plugins[key] = record
  await writeJsonAtomic(installedPluginsPath(userRoot), installed)

  return record
}

/** 从本地目录直接安装（不经 marketplace） */
export async function installPluginFromPath(opts: {
  path: string
  scope?: 'user' | 'project'
  cwd?: string
  boloRoot?: string
}): Promise<InstalledPluginRecord> {
  const scope = opts.scope ?? 'user'
  const userRoot = opts.boloRoot ?? getUserLayout().root
  const sourceDir = path.resolve(opts.path)
  const manifestPath = path.join(sourceDir, 'bolo.plugin.json')
  const manifest = await readJsonFile<{ id?: string; version?: string }>(
    manifestPath,
  )
  if (!manifest?.id) {
    throw new Error(`not a plugin (need bolo.plugin.json): ${sourceDir}`)
  }
  const pluginsDir =
    scope === 'project'
      ? getProjectLayout(opts.cwd ?? process.cwd()).pluginsDir
      : path.join(userRoot, 'plugins')
  const dest = path.join(pluginsDir, manifest.id)
  await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
  await copyDir(sourceDir, dest)

  const record: InstalledPluginRecord = {
    id: manifest.id,
    version: manifest.version,
    scope,
    installPath: dest,
    installedAt: nowIso(),
    source: sourceDir,
  }
  const installed = await loadInstalledPlugins(userRoot)
  const key =
    scope === 'project'
      ? `${record.id}@${path.resolve(opts.cwd ?? process.cwd())}`
      : record.id
  installed.plugins[key] = record
  await writeJsonAtomic(installedPluginsPath(userRoot), installed)
  return record
}

export async function uninstallPlugin(opts: {
  id: string
  scope?: 'user' | 'project'
  cwd?: string
  boloRoot?: string
}): Promise<{ removedPath: string }> {
  const scope = opts.scope ?? 'user'
  const userRoot = opts.boloRoot ?? getUserLayout().root
  const pluginsDir =
    scope === 'project'
      ? getProjectLayout(opts.cwd ?? process.cwd()).pluginsDir
      : path.join(userRoot, 'plugins')
  const dest = path.join(pluginsDir, opts.id)
  await fs.rm(dest, { recursive: true, force: true })
  const installed = await loadInstalledPlugins(userRoot)
  const key =
    scope === 'project'
      ? `${opts.id}@${path.resolve(opts.cwd ?? process.cwd())}`
      : opts.id
  delete installed.plugins[key]
  // 也删纯 id 键
  delete installed.plugins[opts.id]
  await writeJsonAtomic(installedPluginsPath(userRoot), installed)
  return { removedPath: dest }
}

export async function listInstalledPlugins(
  boloRoot?: string,
): Promise<InstalledPluginRecord[]> {
  const root = boloRoot ?? getUserLayout().root
  const file = await loadInstalledPlugins(root)
  return Object.values(file.plugins).sort((a, b) => a.id.localeCompare(b.id))
}

export type { LoadedPlugin }