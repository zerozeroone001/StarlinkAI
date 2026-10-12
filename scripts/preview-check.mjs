const pages = await fetch('http://127.0.0.1:9229/json/list').then((r) => r.json())
const page = pages.find((p) => p.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await send('Runtime.enable')
const evalExpr = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails))
  }
  return res.result.value
}
await evalExpr(
  'new Promise((r) => { const i = setInterval(() => { if (window.__GROK_STORE?.getState().ready) { clearInterval(i); r(true) } }, 100) })'
)
const img = await evalExpr(`(async () => {
  await window.__GROK_STORE.getState().openPreview('I:\\\\code\\\\python\\\\grokDeskTop\\\\resources\\\\icon.png')
  await new Promise((r) => setTimeout(r, 250))
  const p = window.__GROK_STORE.getState().preview
  const el = document.querySelector('.preview-media img')
  return { kind: p?.kind, name: p?.name, size: p?.size, hasImg: Boolean(el), w: el?.naturalWidth, h: el?.naturalHeight }
})()`)
console.log('IMAGE', JSON.stringify(img))
const code = await evalExpr(`(async () => {
  await window.__GROK_STORE.getState().openPreview('I:\\\\code\\\\python\\\\grokDeskTop\\\\src\\\\renderer\\\\src\\\\components\\\\FilePreview.tsx')
  await new Promise((r) => setTimeout(r, 250))
  const p = window.__GROK_STORE.getState().preview
  return { kind: p?.kind, language: p?.language, lines: document.querySelectorAll('.preview-gutter div').length }
})()`)
console.log('CODE', JSON.stringify(code))
ws.close()
if (img.kind !== 'image' || !img.hasImg) process.exit(1)
if (code.kind !== 'text' || code.lines < 10) process.exit(1)
