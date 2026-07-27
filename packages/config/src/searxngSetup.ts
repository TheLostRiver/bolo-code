/**
 * OI-07C: deterministic files and config transaction for an optional,
 * user-selected SearXNG Docker deployment.
 *
 * This module does not run Docker. It owns the packages-first contract that
 * the CLI orchestration consumes later.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseJsonc } from './io.ts'
import type { SearxngSearchConfigJson } from './searxng.ts'
import type { BoloConfigJson } from './types.ts'

export const SEARXNG_DOCKER_IMAGE =
  'docker.io/searxng/searxng@sha256:d0aaeb14880e6e92bde1518fcc7261e995783367d63d95203383607bef9c6516'
export const SEARXNG_SETUP_VERSION = 1
export const SEARXNG_COMPOSE_PROJECT = 'bolo-searxng'
export const DEFAULT_SEARXNG_SETUP_PORT = 8888

export type SearxngSetupPaths = {
  root: string
  composeFile: string
  manifestFile: string
  configDir: string
  settingsFile: string
  dataDir: string
}

export type SearxngSetupPlan = {
  version: number
  port: number
  baseUrl: string
  image: string
  projectName: string
  paths: SearxngSetupPaths
  composeYaml: string
  settingsYaml: string
  manifestJson: string
}

export type CreateSearxngSetupPlanInput = {
  layoutRoot: string
  port?: number
  secretKey: string
}

export type CommitSearxngSearchConfigResult =
  | { ok: true; configPath: string; created: boolean }
  | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validatePort(raw: number | undefined): number {
  const port = raw ?? DEFAULT_SEARXNG_SETUP_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SearXNG setup port must be an integer from 1 to 65535')
  }
  return port
}

function validateSecretKey(secretKey: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secretKey)) {
    throw new Error(
      'SearXNG secret key must be 32-128 URL-safe characters',
    )
  }
  return secretKey
}

export function getSearxngSetupPaths(layoutRoot: string): SearxngSetupPaths {
  const root = path.join(path.resolve(layoutRoot), 'searxng')
  const configDir = path.join(root, 'config')
  return {
    root,
    composeFile: path.join(root, 'compose.yaml'),
    manifestFile: path.join(root, 'bolo-managed.json'),
    configDir,
    settingsFile: path.join(configDir, 'settings.yml'),
    dataDir: path.join(root, 'data'),
  }
}

export function createSearxngSetupPlan(
  input: CreateSearxngSetupPlanInput,
): SearxngSetupPlan {
  const port = validatePort(input.port)
  const secretKey = validateSecretKey(input.secretKey)
  const paths = getSearxngSetupPaths(input.layoutRoot)
  const baseUrl = 'http://127.0.0.1:' + port
  const composeYaml = [
    'name: ' + SEARXNG_COMPOSE_PROJECT,
    'services:',
    '  searxng:',
    '    image: ' + SEARXNG_DOCKER_IMAGE,
    '    ports:',
    '      - "127.0.0.1:' + port + ':8080"',
    '    volumes:',
    '      - "./config:/etc/searxng"',
    '      - "./data:/var/cache/searxng"',
    '    environment:',
    '      SEARXNG_BASE_URL: "' + baseUrl + '/"',
    '    restart: unless-stopped',
    '',
  ].join('\n')
  const settingsYaml = [
    'use_default_settings: true',
    '',
    'server:',
    '  secret_key: "' + secretKey + '"',
    '  bind_address: "0.0.0.0"',
    '  port: 8080',
    '  limiter: false',
    '',
    'search:',
    '  formats:',
    '    - html',
    '    - json',
    '',
  ].join('\n')
  const manifestJson =
    JSON.stringify(
      {
        version: SEARXNG_SETUP_VERSION,
        projectName: SEARXNG_COMPOSE_PROJECT,
        image: SEARXNG_DOCKER_IMAGE,
        port,
        baseUrl,
      },
      null,
      2,
    ) + '\n'

  return {
    version: SEARXNG_SETUP_VERSION,
    port,
    baseUrl,
    image: SEARXNG_DOCKER_IMAGE,
    projectName: SEARXNG_COMPOSE_PROJECT,
    paths,
    composeYaml,
    settingsYaml,
    manifestJson,
  }
}

type JsoncPropertyRange = {
  propertyStart: number
  valueStart: number
  valueEnd: number
}

type RootObjectScan = {
  closeIndex: number
  hasProperties: boolean
  trailingComma: boolean
  lastValueEnd?: number
  property?: JsoncPropertyRange
}

function skipTrivia(text: string, start: number): number {
  let index = start
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      index += 1
      continue
    }
    if (text[index] === '/' && text[index + 1] === '/') {
      index += 2
      while (index < text.length && text.charCodeAt(index) !== 10) index += 1
      continue
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) throw new Error('unterminated JSONC block comment')
      index = end + 2
      continue
    }
    break
  }
  return index
}

function scanStringEnd(text: string, start: number): number {
  let escaped = false
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') return index + 1
  }
  throw new Error('unterminated JSON string')
}

function scanCompositeEnd(text: string, start: number): number {
  const open = text[start]
  const close = open === '{' ? '}' : open === '[' ? ']' : ''
  if (!close) throw new Error('expected JSON object or array')
  let depth = 1
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      index = scanStringEnd(text, index)
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      index = skipTrivia(text, index)
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index = skipTrivia(text, index)
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  throw new Error('unterminated JSON object or array')
}

function scanValueEnd(text: string, start: number): number {
  const first = text[start]
  if (first === '"') return scanStringEnd(text, start)
  if (first === '{' || first === '[') return scanCompositeEnd(text, start)

  let index = start
  while (index < text.length) {
    const char = text[index]
    if (
      char === ',' ||
      char === '}' ||
      char === ']' ||
      (char === '/' &&
        (text[index + 1] === '/' || text[index + 1] === '*'))
    ) {
      break
    }
    index += 1
  }
  while (index > start) {
    const code = text.charCodeAt(index - 1)
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) break
    index -= 1
  }
  return index
}

function scanRootObject(text: string, wanted: string): RootObjectScan {
  let index = skipTrivia(text, text.charCodeAt(0) === 0xfeff ? 1 : 0)
  if (text[index] !== '{') throw new Error('Bolo config must be a JSON object')
  index += 1
  let hasProperties = false
  let trailingComma = false
  let lastValueEnd: number | undefined

  while (index < text.length) {
    index = skipTrivia(text, index)
    if (text[index] === '}') {
      return {
        closeIndex: index,
        hasProperties,
        trailingComma,
        ...(lastValueEnd === undefined ? {} : { lastValueEnd }),
      }
    }
    if (text[index] === ',') {
      trailingComma = true
      index += 1
      continue
    }
    if (text[index] !== '"') {
      throw new Error('Bolo config contains an invalid root property')
    }

    const propertyStart = index
    const nameEnd = scanStringEnd(text, index)
    const name = JSON.parse(text.slice(index, nameEnd)) as string
    index = skipTrivia(text, nameEnd)
    if (text[index] !== ':') {
      throw new Error('Bolo config contains a property without a value')
    }
    const valueStart = skipTrivia(text, index + 1)
    const valueEnd = scanValueEnd(text, valueStart)
    hasProperties = true
    lastValueEnd = valueEnd
    trailingComma = false
    if (name === wanted) {
      const rootEnd = scanCompositeEnd(
        text,
        skipTrivia(text, text.charCodeAt(0) === 0xfeff ? 1 : 0),
      )
      return {
        closeIndex: rootEnd - 1,
        hasProperties,
        trailingComma,
        lastValueEnd,
        property: { propertyStart, valueStart, valueEnd },
      }
    }
    index = skipTrivia(text, valueEnd)
    if (text[index] === ',') {
      trailingComma = true
      index += 1
    }
  }
  throw new Error('unterminated Bolo config object')
}

function indentJsonValue(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, '\n' + indent)
}

/**
 * Patch only the root search value so comments and formatting elsewhere in
 * config.json survive setup.
 */
export function patchSearxngConfigJsonc(
  raw: string,
  searxng: SearxngSearchConfigJson,
): string {
  let parsed: BoloConfigJson
  try {
    parsed = parseJsonc<BoloConfigJson>(raw)
  } catch (error) {
    throw new Error(
      'could not parse Bolo config JSONC: ' +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  if (!isRecord(parsed)) throw new Error('Bolo config must be a JSON object')
  const existingSearch = parsed.search
  if (existingSearch !== undefined && !isRecord(existingSearch)) {
    throw new Error('existing search config must be an object')
  }
  const existingSearxng = existingSearch?.searxng
  if (existingSearxng !== undefined && !isRecord(existingSearxng)) {
    throw new Error('existing search.searxng config must be an object')
  }
  const nextSearch = {
    ...(existingSearch ?? {}),
    searxng: {
      ...(existingSearxng ?? {}),
      ...searxng,
    },
  }
  const scan = scanRootObject(raw, 'search')
  if (scan.property) {
    const lineStart = raw.lastIndexOf('\n', scan.property.propertyStart - 1) + 1
    const candidateIndent = raw.slice(lineStart, scan.property.propertyStart)
    const indent = /^[ \t]*$/.test(candidateIndent) ? candidateIndent : '  '
    const replacement = indentJsonValue(nextSearch, indent)
    return (
      raw.slice(0, scan.property.valueStart) +
      replacement +
      raw.slice(scan.property.valueEnd)
    )
  }

  let beforeClose = raw.slice(0, scan.closeIndex)
  if (
    scan.hasProperties &&
    !scan.trailingComma &&
    scan.lastValueEnd !== undefined
  ) {
    beforeClose =
      raw.slice(0, scan.lastValueEnd) +
      ',' +
      raw.slice(scan.lastValueEnd, scan.closeIndex)
  }
  const insertion =
    '\n  "search": ' + indentJsonValue(nextSearch, '  ') + '\n'
  return beforeClose + insertion + raw.slice(scan.closeIndex)
}

async function atomicWriteText(filePath: string, body: string): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const tempPath = path.join(
    directory,
    '.' + path.basename(filePath) + '.tmp-' + randomUUID(),
  )
  try {
    await fs.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tempPath, filePath)
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

export async function commitSearxngSearchConfig(input: {
  configPath: string
  searxng: SearxngSearchConfigJson
}): Promise<CommitSearxngSearchConfigResult> {
  let raw: string
  let created = false
  try {
    raw = await fs.readFile(input.configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return {
        ok: false,
        reason:
          'could not read ' +
          input.configPath +
          ': ' +
          (error instanceof Error ? error.message : String(error)),
      }
    }
    raw = '{}\n'
    created = true
  }

  let next: string
  try {
    next = patchSearxngConfigJsonc(raw, input.searxng)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    await atomicWriteText(input.configPath, next)
  } catch (error) {
    return {
      ok: false,
      reason:
        'could not atomically write ' +
        input.configPath +
        ': ' +
        (error instanceof Error ? error.message : String(error)),
    }
  }
  return { ok: true, configPath: input.configPath, created }
}
