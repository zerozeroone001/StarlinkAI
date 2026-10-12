import { createRequire } from 'node:module'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import type { Socket } from 'node:net'
import { URL } from 'node:url'

const require = createRequire(import.meta.url)

export function envProxy(): URL | null {
  const raw = (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '').trim()
  if (!raw) return null
  try {
    return new URL(/^\w+:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    return null
  }
}

async function fetchWithUndici(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  proxy: URL
): Promise<{ status: number; text: string } | null> {
  try {
    const undici = require('undici') as {
      fetch: (input: string, init?: Record<string, unknown>) => Promise<Response>
      ProxyAgent: new (uri: string) => unknown
    }
    const dispatcher = new undici.ProxyAgent(proxy.toString())
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), init.timeoutMs)
    try {
      const res = await undici.fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: ac.signal,
        dispatcher
      })
      return { status: res.status, text: await res.text() }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

export async function httpRequest(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  } = {}
): Promise<{ status: number; text: string }> {
  const target = new URL(url)
  const method = init.method || 'GET'
  const headers: Record<string, string> = { ...(init.headers || {}) }
  const timeoutMs = init.timeoutMs ?? 15000
  const proxy = envProxy()

  if (proxy) {
    const viaUndici = await fetchWithUndici(
      url,
      { method, headers, body: init.body, timeoutMs },
      proxy
    )
    if (viaUndici) return viaUndici
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let req: http.ClientRequest | undefined
    let connectReq: http.ClientRequest | undefined
    let tlsSocket: tls.TLSSocket | undefined

    const finish = (err?: Error, val?: { status: number; text: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(val!)
    }

    const timer = setTimeout(() => {
      req?.destroy()
      connectReq?.destroy()
      tlsSocket?.destroy()
      finish(new Error('timeout'))
    }, timeoutMs)

    const collect = (res: http.IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      res.on('end', () =>
        finish(undefined, { status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') })
      )
      res.on('error', (e) => finish(e))
    }

    const startHttps = (socket?: Socket) => {
      const nextHeaders: Record<string, string> = { ...headers, Host: target.host }
      if (init.body && !nextHeaders['Content-Length']) {
        nextHeaders['Content-Length'] = String(Buffer.byteLength(init.body))
      }
      const opts: https.RequestOptions = {
        hostname: target.hostname,
        servername: target.hostname,
        path: `${target.pathname}${target.search}`,
        method,
        headers: nextHeaders
      }
      if (socket) {
        tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
          if (settled) return
          req = http.request(
            { ...opts, createConnection: () => tlsSocket as unknown as Socket },
            collect
          )
          req.on('error', (e) => finish(e))
          if (init.body) req.write(init.body)
          req.end()
        })
        tlsSocket.on('error', (e) => finish(e))
        return
      }
      opts.port = target.port || 443
      req = https.request(opts, collect)
      req.on('error', (e) => finish(e))
      if (init.body) req.write(init.body)
      req.end()
    }

    if (proxy && target.protocol === 'https:') {
      connectReq = http.request({
        host: proxy.hostname,
        port: Number(proxy.port) || 80,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}` }
      })
      connectReq.on('connect', (res, socket) => {
        if ((res.statusCode || 0) !== 200) {
          finish(new Error(`proxy CONNECT ${res.statusCode}`))
          return
        }
        startHttps(socket)
      })
      connectReq.on('error', (e) => finish(e))
      connectReq.end()
      return
    }

    if (proxy) {
      req = http.request(
        {
          host: proxy.hostname,
          port: Number(proxy.port) || 80,
          method,
          path: url,
          headers: { ...headers, Host: target.host }
        },
        collect
      )
      req.on('error', (e) => finish(e))
      if (init.body) req.write(init.body)
      req.end()
      return
    }

    if (target.protocol === 'https:') {
      startHttps()
      return
    }

    req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method,
        headers: { ...headers, Host: target.host }
      },
      collect
    )
    req.on('error', (e) => finish(e))
    if (init.body) req.write(init.body)
    req.end()
  })
}

export async function httpJson(
  url: string,
  init?: Parameters<typeof httpRequest>[1]
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await httpRequest(url, init)
  let json: unknown = null
  try {
    json = JSON.parse(res.text) as unknown
  } catch {
    /* ignore */
  }
  return { status: res.status, text: res.text, json }
}
