/**
 * MCP OAuth 本地回调最小流（对照 HC oauth 语义，无遥测）
 *
 * 1) 打开授权 URL（redirect_uri=http://127.0.0.1:<port>/callback）
 * 2) 本地 HTTP 收 code
 * 3) POST token_url 换 token
 * 4) 写入 token 文件（供 maybeInjectMcpOAuthHeaders）
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'

export type OAuthLocalFlowOptions = {
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  scope?: string
  /** 落盘路径 */
  tokenFile: string
  /** 监听端口；0 = 系统分配 */
  port?: number
  /** 超时 ms */
  timeoutMs?: number
  /** 测试注入：不真正 listen，直接喂 code */
  exchangeCode?: (code: string) => Promise<Record<string, unknown>>
  fetchImpl?: typeof fetch
}

export type OAuthLocalFlowResult = {
  tokenFile: string
  accessToken: string
  raw: Record<string, unknown>
}

function htmlPage(body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;padding:2rem">${body}</body></html>`
}

/**
 * 用 code 换 token（标准 OAuth2 authorization_code）
 */
export async function exchangeAuthorizationCode(opts: {
  tokenUrl: string
  clientId: string
  clientSecret?: string
  code: string
  redirectUri: string
  fetchImpl?: typeof fetch
}): Promise<Record<string, unknown>> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch unavailable for token exchange')
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
  })
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret)
  const res = await fetchFn(opts.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  })
  const text = await res.text()
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`token response not JSON: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    throw new Error(
      `token exchange HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
    )
  }
  return json
}

export async function saveOAuthTokenFile(
  filePath: string,
  token: Record<string, unknown>,
): Promise<string> {
  const abs = path.resolve(filePath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const access =
    typeof token.access_token === 'string'
      ? token.access_token
      : typeof token.accessToken === 'string'
        ? token.accessToken
        : ''
  if (!access) throw new Error('token response missing access_token')
  const expiresIn =
    typeof token.expires_in === 'number' ? token.expires_in : undefined
  const out = {
    access_token: access,
    token_type:
      typeof token.token_type === 'string' ? token.token_type : 'Bearer',
    expires_at: expiresIn
      ? Date.now() + Math.floor(expiresIn * 1000)
      : undefined,
    refresh_token:
      typeof token.refresh_token === 'string' ? token.refresh_token : undefined,
    raw: token,
  }
  await fs.writeFile(abs, JSON.stringify(out, null, 2) + '\n', 'utf8')
  return abs
}

/**
 * 跑本地回调 OAuth（阻塞直到 code 或超时）。
 * 返回 token 文件路径。调用方负责打开浏览器到返回的 authorizeUrlWithRedirect。
 */
export async function runLocalOAuthCallbackFlow(
  opts: OAuthLocalFlowOptions,
): Promise<OAuthLocalFlowResult & { authorizeUrlWithRedirect: string }> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const port = opts.port ?? 0

  // 测试捷径：直接 exchange
  if (opts.exchangeCode) {
    const raw = await opts.exchangeCode('test-code')
    const tokenFile = await saveOAuthTokenFile(opts.tokenFile, raw)
    const access = String(raw.access_token ?? raw.accessToken ?? '')
    return {
      tokenFile,
      accessToken: access,
      raw,
      authorizeUrlWithRedirect: opts.authorizeUrl,
    }
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const u = new URL(req.url ?? '/', `http://127.0.0.1`)
        if (u.pathname !== '/callback') {
          res.writeHead(404)
          res.end(htmlPage('Not found'))
          return
        }
        const err = u.searchParams.get('error')
        const code = u.searchParams.get('code')
        if (err) {
          res.writeHead(400)
          res.end(htmlPage(`OAuth error: ${err}`))
          if (!settled) {
            settled = true
            clearTimeout(timer)
            server.close()
            reject(new Error(`oauth error: ${err}`))
          }
          return
        }
        if (!code) {
          res.writeHead(400)
          res.end(htmlPage('Missing code'))
          return
        }
        const addr = server.address()
        const p =
          addr && typeof addr === 'object' ? addr.port : port || 8765
        const redirectUri = `http://127.0.0.1:${p}/callback`
        const raw = await exchangeAuthorizationCode({
          tokenUrl: opts.tokenUrl,
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          code,
          redirectUri,
          fetchImpl: opts.fetchImpl,
        })
        const tokenFile = await saveOAuthTokenFile(opts.tokenFile, raw)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Bolo OAuth OK — you can close this tab.'))
        if (!settled) {
          settled = true
          clearTimeout(timer)
          server.close()
          resolve({
            tokenFile,
            accessToken: String(raw.access_token ?? ''),
            raw,
            authorizeUrlWithRedirect: authorizeUrlWithRedirect!,
          })
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        res.writeHead(500)
        res.end(htmlPage(`Token exchange failed: ${msg}`))
        if (!settled) {
          settled = true
          clearTimeout(timer)
          server.close()
          reject(e)
        }
      }
    })

    let authorizeUrlWithRedirect = opts.authorizeUrl
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        server.close()
        reject(new Error(`oauth callback timeout after ${timeoutMs}ms`))
      }
    }, timeoutMs)

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const p = addr && typeof addr === 'object' ? addr.port : 8765
      const redirectUri = `http://127.0.0.1:${p}/callback`
      const u = new URL(opts.authorizeUrl)
      u.searchParams.set('response_type', 'code')
      u.searchParams.set('client_id', opts.clientId)
      u.searchParams.set('redirect_uri', redirectUri)
      if (opts.scope) u.searchParams.set('scope', opts.scope)
      authorizeUrlWithRedirect = u.toString()
      // 不自动 open 浏览器（无 GUI 依赖）；调用方打印 URL
      // 将 URL 挂到 result 前通过闭包；这里触发 resolve 前先存
      void authorizeUrlWithRedirect
    })
    server.on('error', (e) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(e)
      }
    })
  })
}

/**
 * 仅构建带 redirect 的 authorize URL 并启动监听，返回 { url, wait }。
 * wait() 在收到 code 并换 token 后 resolve。
 */
export function startLocalOAuthListener(opts: OAuthLocalFlowOptions): {
  getAuthorizeUrl: () => string
  wait: () => Promise<OAuthLocalFlowResult>
  close: () => void
} {
  let authorizeUrl = opts.authorizeUrl
  let resolveWait: (v: OAuthLocalFlowResult) => void
  let rejectWait: (e: unknown) => void
  const waitPromise = new Promise<OAuthLocalFlowResult>((res, rej) => {
    resolveWait = res
    rejectWait = rej
  })
  let closed = false
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname !== '/callback') {
        res.writeHead(404)
        res.end(htmlPage('Not found'))
        return
      }
      const code = u.searchParams.get('code')
      if (!code) {
        res.writeHead(400)
        res.end(htmlPage('Missing code'))
        return
      }
      const addr = server.address()
      const p = addr && typeof addr === 'object' ? addr.port : 8765
      const redirectUri = `http://127.0.0.1:${p}/callback`
      const raw = await exchangeAuthorizationCode({
        tokenUrl: opts.tokenUrl,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        code,
        redirectUri,
        fetchImpl: opts.fetchImpl,
      })
      const tokenFile = await saveOAuthTokenFile(opts.tokenFile, raw)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(htmlPage('Bolo OAuth OK — close this tab.'))
      if (!closed) {
        closed = true
        server.close()
        resolveWait!({
          tokenFile,
          accessToken: String(raw.access_token ?? ''),
          raw,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      res.writeHead(500)
      res.end(htmlPage(msg))
      if (!closed) {
        closed = true
        server.close()
        rejectWait!(e)
      }
    }
  })
  server.listen(opts.port ?? 0, '127.0.0.1', () => {
    const addr = server.address()
    const p = addr && typeof addr === 'object' ? addr.port : 8765
    const redirectUri = `http://127.0.0.1:${p}/callback`
    const u = new URL(opts.authorizeUrl)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('client_id', opts.clientId)
    u.searchParams.set('redirect_uri', redirectUri)
    if (opts.scope) u.searchParams.set('scope', opts.scope)
    authorizeUrl = u.toString()
  })
  return {
    getAuthorizeUrl: () => authorizeUrl,
    wait: () => waitPromise,
    close: () => {
      if (!closed) {
        closed = true
        server.close()
        rejectWait?.(new Error('oauth listener closed'))
      }
    },
  }
}
