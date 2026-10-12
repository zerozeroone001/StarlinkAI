// Offline compatibility checks. Only loopback HTTP(S) and a short-lived Node PTY
// are used; no provider account, model request, or system proxy is touched.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const option = (name) => {
  const position = process.argv.indexOf(name)
  if (position < 0) return undefined
  assert(process.argv[position + 1] && !process.argv[position + 1].startsWith('--'), `Missing ${name}`)
  return process.argv[position + 1]
}
const root = path.resolve(option('--dependency-root') ?? path.join(import.meta.dirname, '..'))
const rootRequire = createRequire(path.join(root, 'package.json'))
const isWithinRoot = (file) => {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}
const withinRoot = (file) => {
  assert(isWithinRoot(file), 'Dependency resolved outside the requested fixture')
  return file
}
function providerRequire() {
  let entry
  try { entry = rootRequire.resolve('@google/gemini-cli/package.json') }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  return entry && isWithinRoot(entry) ? createRequire(entry) : rootRequire
}
function downloaderRequire() {
  let builder
  try { builder = rootRequire.resolve('app-builder-lib/package.json') }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  const resolver = builder && isWithinRoot(builder) ? createRequire(builder) : rootRequire
  return createRequire(withinRoot(resolver.resolve('@electron/get/package.json')))
}

// Deliberately public test identity, generated only for this localhost fixture.
// The certificate is trusted per request; system trust and TLS flags are unchanged.
const tlsFixture = {
  "key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDlHxHIGinzNSM1\nlQOpJH/yYjHlH8q6nrumQtjvjlwB0DVewNxBjW9rAvM/uJl8HtBfaJh3SkcPeYB9\nHDkfUlssjZCBdMPy+aSsLorSGf1Ldc6PHZQSxAOwys8BzS+3bWGp/G0OQGj2sHv+\ndd8waqeDLXJkqwhQeuaTKlQNSRjkBa6HtgMVIPOtRqfAHMPuKOHOrdRRdvV12nAg\nXjO5wO0grxP2v0JE/vWuOkZDio7woNmL8U8lWgsxqU8syFc0dsyly9FNsCwMSQDG\n/iEkx6LYoVDqApsyJqqCJHrX+gum1eFog7/eVwThorZLXYbpqgJ3OuQJCsLHwa6x\ntMfCFx3VAgMBAAECggEAMCr4uEZl2NMsQITAFQRPILQLlMV6/4JE5WZqyGv3hEsT\nGUU22NIk4Qyo+lWy8MDiohgxa2yyZTqwLD0tdhwAfmyRe2HCmxdoCumq9hIQKdfN\nsdEwUsSiGP3+CH0sQaXtcQjYHXWli20dWCjMH9fgOQfqI2dAc3ju9fPhYTyjjrYM\nOfaxIkOpN4F5AijalNLQhpiHIZqaHCRfRTYn0zo7JPrk57k5+73A+bm1Vk9BMuG/\nFThQJ37F+BMJ5/nI7eY1uNd9rqmY3ligfXwVfN8tHL1P57k3mKQm4sSvwIWS/MSg\nZ+99jzrk6x3vCCbUNtzxt+uHaEj0YoXOMYyFVyUuyQKBgQD2/hnmJ1mdVj22X3ol\ngNWZ21gTrRqe76rLDkuIu3lnSl36QXzgUs9pvJQbQQllIhBHJi8cKraEXUMrcvdK\noVZ6fZLN/IuFwdyp+TbYud4nV4c3LF6a2YXk81YGlrYC3iXELVGyDjZzZ0aUz4J0\n4/VzuNLKihXmN5rUT6ermFA1KQKBgQDteh/UZAG31smcQJTa+mtvISr5vh+E+dnn\n51ypAd+rH+s3Iz2VvrQbRDRMviA8rXzMS6eYDC9XozhtQjWNxaYxRxOdPutrpYBL\nCkj5/6lKhvX+31kuJ6UMpiWoU/0wzhVhXF0s1+GAr3rrvgPNPzk3ro6vgrGbCxsc\nVn1zbJ2szQKBgQCZtlXD6GVbB5rsbssDoARO9jUAOdDBbQJr0H+tno7Ve3C1GCBx\nMtgmQ9gghf8k02gx/09+Rg7EnY358lh4N6QsIw5D55GlMprzpUc+5Z2d+lkKOzC9\nSfaMH+w/uXeYnUv/pPycxT+Z3oIMhn/34w6UcEevCPTMC3rt+oysu+Pe0QKBgA23\nFOmGURcV/5TXogE3n0bOypWb5mQerfgXw6E7K3jNoh8QGPlyByLgAIlCHciDWIbQ\nA8DjS0Srd5HP1hn3BU8pRLe7L4uLBmrPEEHoAxX7z29F5PemcIDXg6tCFohgDpoN\n5I+3dB2jhNzin4OWGC7gFPuL98f1jz5GvH4TEtQtAoGAGrx6vYB5tFcthR65RG42\n44bunUTSg8ngIsx3L+0MgWI84SZ1X8yIS88Q9be5uFjb6gwOs1xEHlnJ/tOL9bk3\nEO5++qbkP1VrPmawKSS/58lJTTX0GlF8DGRats0JLVzT2+7F7NfivsW/dl5TrAeO\nrHIo/GwsmUM5GsFWT3BVMMk=\n-----END PRIVATE KEY-----\n",
  "cert": "-----BEGIN CERTIFICATE-----\nMIIC9DCCAdygAwIBAgIBATANBgkqhkiG9w0BAQsFADAnMSUwIwYDVQQDDBxsb2Nh\nbGhvc3QgZGVwZW5kZW5jeSBmaXh0dXJlMCAXDTIwMDEwMTAwMDAwMFoYDzIwNTAw\nMTAxMDAwMDAwWjAnMSUwIwYDVQQDDBxsb2NhbGhvc3QgZGVwZW5kZW5jeSBmaXh0\ndXJlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5R8RyBop8zUjNZUD\nqSR/8mIx5R/Kup67pkLY745cAdA1XsDcQY1vawLzP7iZfB7QX2iYd0pHD3mAfRw5\nH1JbLI2QgXTD8vmkrC6K0hn9S3XOjx2UEsQDsMrPAc0vt21hqfxtDkBo9rB7/nXf\nMGqngy1yZKsIUHrmkypUDUkY5AWuh7YDFSDzrUanwBzD7ijhzq3UUXb1ddpwIF4z\nucDtIK8T9r9CRP71rjpGQ4qO8KDZi/FPJVoLMalPLMhXNHbMpcvRTbAsDEkAxv4h\nJMei2KFQ6gKbMiaqgiR61/oLptXhaIO/3lcE4aK2S12G6aoCdzrkCQrCx8GusbTH\nwhcd1QIDAQABoykwJzAUBgNVHREEDTALgglsb2NhbGhvc3QwDwYDVR0TAQH/BAUw\nAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAZ6ZnlI4VhGuOVDRZuDP2jQc/0CtQXvAD\nrZvjthQeOiqfm2Lc8f1sdY/WvjmrR3552BxK8Fr1jwgXw8uFhYdDhL5viDakmjQJ\nJblxPE/7k6v5zH3iS7Tq3qoiubbHrLPV91vtiRbbjQiN1sZn/CZRXO/W6hs0fH9m\nCwIXu77f6ToUWJJBYbWSNaxajukCDTp5afFE55Wj2wpanCBYog2hwWFKLODOHJ3R\nOm0HsQ7Al/SBOCsio5/p13DB9lrr8nvIb7nVCwsrr2PuvxbcEEifhwKtR1J7Wk98\n7MbW9IeWWINvSOJZw+1ZcmtEdEPDDPj5eYC/+ZmEdiFvE03QvvZu6A==\n-----END CERTIFICATE-----\n"
}

async function probeProxy(prefixed) {
  const downloader = downloaderRequire()
  const proxyModule = withinRoot(downloader.resolve('global-agent'))
  const sockets = new Set()
  const track = (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) }
  let httpProxyRequests = 0
  let httpsTunnels = 0
  const plain = http.createServer((_request, response) => response.end('LOCAL_HTTP_OK'))
  const secure = https.createServer(tlsFixture, (_request, response) => response.end('LOCAL_HTTPS_OK'))
  const proxy = http.createServer((request, response) => {
    const destination = new URL(request.url)
    assert.equal(destination.hostname, '127.0.0.1')
    assert.equal(Number(destination.port), plain.address().port)
    httpProxyRequests++
    // Native net avoids sending this forwarding request through the proxy again.
    const upstream = net.connect(Number(destination.port), '127.0.0.1', () => {
      upstream.write(`GET ${destination.pathname} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`)
    })
    track(upstream)
    let body = ''
    upstream.setEncoding('utf8')
    upstream.on('data', (chunk) => { body += chunk })
    upstream.on('end', () => response.end(body.split('\r\n\r\n').slice(1).join('\r\n\r\n')))
    upstream.on('error', (error) => response.destroy(error))
  })
  proxy.on('connect', (request, socket, head) => {
    assert.equal(request.url, `localhost:${secure.address().port}`)
    httpsTunnels++
    const upstream = net.connect(secure.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    track(upstream)
    upstream.on('error', () => socket.destroy())
  })
  for (const server of [plain, secure, proxy]) {
    server.on('connection', track)
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  }
  try {
    const namespace = prefixed ? 'GLOBAL_AGENT_' : ''
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
    process.env[`${namespace}HTTP_PROXY`] = proxyUrl
    process.env[`${namespace}HTTPS_PROXY`] = proxyUrl
    process.env[`${namespace}NO_PROXY`] = ''
    if (prefixed) process.env.HTTP_PROXY = 'http://127.0.0.1:1'
    const get = downloader('./dist/cjs/index.js')
    get.initializeProxy()
    assert.equal(globalThis.GLOBAL_AGENT?.HTTP_PROXY, proxyUrl, 'initializeProxy silently failed or ignored env')
    assert.equal(globalThis.GLOBAL_AGENT?.HTTPS_PROXY, proxyUrl)
    assert.equal(downloader('global-agent').bootstrap(), false, 'Repeated initialization must remain idempotent')
    const request = (secureRequest) => new Promise((resolve, reject) => {
      const transport = secureRequest ? https : http
      const url = secureRequest ? `https://localhost:${secure.address().port}/check` : `http://127.0.0.1:${plain.address().port}/check`
      const req = transport.get(url, secureRequest ? { ca: tlsFixture.cert, family: 4 } : {}, (response) => {
        let data = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { data += chunk })
        response.on('end', () => resolve(data))
        response.on('error', reject)
      })
      req.setTimeout(5000, () => req.destroy(new Error('Loopback request timeout')))
      req.on('error', reject)
    })
    assert.equal(await request(false), 'LOCAL_HTTP_OK')
    assert.equal(await request(true), 'LOCAL_HTTPS_OK')
    assert.equal(httpProxyRequests, 1)
    assert.equal(httpsTunnels, 1)
    globalThis.GLOBAL_AGENT.NO_PROXY = '127.0.0.1,localhost'
    assert.equal(await request(false), 'LOCAL_HTTP_OK')
    assert.equal(await request(true), 'LOCAL_HTTPS_OK')
    assert.equal(httpProxyRequests, 1, 'NO_PROXY did not bypass the HTTP proxy')
    assert.equal(httpsTunnels, 1, 'NO_PROXY did not bypass the HTTPS proxy')
    return { proxyVersion: downloader('global-agent/package.json').version, proxyModule: path.relative(root, proxyModule), prefixed, httpProxyRequests, httpsTunnels, noProxyBypass: true }
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all([plain, secure, proxy].map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

async function probePty() {
  const resolver = providerRequire()
  const results = []
  for (const name of ['@lydell/node-pty', 'node-pty']) {
    const entry = withinRoot(resolver.resolve(name))
    const pty = resolver(name)
    const marker = `PTY_COMPATIBILITY_${name === 'node-pty' ? 'FALLBACK' : 'PRIMARY'}`
    let output = ''
    const terminal = pty.spawn(process.execPath, ['-e', `process.stdout.write('${marker}\\n')`], {
      name: 'xterm-color', cols: 80, rows: 24, cwd: root, env: process.env,
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { terminal.kill(); reject(new Error(`${name}: PTY child timeout`)) }, 10000)
      terminal.onData((chunk) => { output += chunk })
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer)
        try { assert.equal(exitCode, 0); assert(output.includes(marker), `${name}: PTY output lost`); resolve() }
        catch (error) { reject(error) }
      })
    })
    results.push({ name, entry: path.relative(root, entry), output: true, exitCode: 0 })
  }
  return results
}

function probeLogger() {
  process.env.ROARR_LOG = 'true'
  const downloader = downloaderRequire()
  const agent = createRequire(withinRoot(downloader.resolve('global-agent/package.json')))
  const loggerModule = agent('roarr')
  const logger = loggerModule.default ?? loggerModule.ROARR
  assert.equal(typeof logger?.child, 'function', 'Proxy logger API is incompatible')
  const messages = []
  globalThis.ROARR.write = (message) => messages.push(JSON.parse(message))
  logger.child({ package: 'build-dependency-fixture' }).info({ destination: 'http://localhost' }, 'request %s', 'ok')
  assert.equal(messages.at(-1)?.message, 'request ok')
  assert.equal(messages.at(-1)?.context.package, 'build-dependency-fixture')
  // Assessment only: report the known precision risk without treating an
  // audit-clean dependency substitution as a fix. Excluded from default checks.
  let precisionRisk = false
  try { logger.info('%.999f', 1) } catch (error) { precisionRisk = error instanceof RangeError; if (!precisionRisk) throw error }
  return { loggerVersion: agent('roarr/package.json').version, contextAndInterpolation: true,
    precisionRisk, assessment: precisionRisk ? 'Unbounded precision still throws; not fixed' : 'This precision probe did not throw' }
}

const probe = option('--probe')
if (probe) {
  const result = probe === 'logger' ? probeLogger() : probe === 'pty' ? await probePty() : await probeProxy(probe === 'proxy-prefixed')
  // node-pty's ConoutConnection worker can remain referenced after its child has
  // emitted onExit. The isolated probe owns that worker; flush evidence and end it.
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0))
} else {
  const env = { ...process.env }
  // The tested modules patch only these short-lived children, never the user's
  // terminal or global proxy configuration. No environment values are logged.
  for (const key of Object.keys(env)) if (/(?:PROXY|^ROARR_|^GLOBAL_AGENT_|^NODE_USE_ENV_PROXY$)/i.test(key)) delete env[key]
  const results = []
  const available = ['proxy-standard', 'proxy-prefixed', 'pty', 'logger']
  const selected = option('--only')?.split(',') ?? available.filter((name) => name !== 'logger')
  assert(selected.every((name) => available.includes(name)), 'Unknown --only probe')
  for (const name of selected) {
    const child = spawnSync(process.execPath, [import.meta.filename, '--dependency-root', root, '--probe', name], {
      env, windowsHide: true, encoding: 'utf8', timeout: 30000,
    })
    if (child.error || child.status !== 0) results.push({ test: name, passed: false, error: child.error?.message ?? child.stderr.trim() })
    else results.push({ test: name, passed: true, result: JSON.parse(child.stdout.trim()) })
  }
  const report = { passed: results.filter((item) => item.passed).length, failed: results.filter((item) => !item.passed).length, results }
  const output = option('--output')
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)) }
  console.log(JSON.stringify(report, null, 2))
  if (report.failed) process.exitCode = 1
}
