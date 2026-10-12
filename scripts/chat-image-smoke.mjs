// Explicit live smoke test. Generates one image using the selected signed-in provider.
import fs from 'node:fs'
const provider = process.argv[2] || 'grok'
const base = 'http://127.0.0.1:5187/api/workspace/'
async function call(method, body) {
  const response = await fetch(base + method, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Client': '1' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result.result
}
const id = `image-smoke-${provider}-${Date.now()}`
fs.mkdirSync('.tmp', { recursive: true })
fs.writeFileSync(`.tmp/${provider}-image-smoke-run.json`, JSON.stringify({ id }))
await call('start', {
  id, workspaceId: `image-smoke-${provider}`, goal: '验证图片生成链路',
  prompt: '请实际生成一张简单图片：浅蓝背景上的一个黄色圆形。只生成一张，使用最小可用尺寸。调用已有图片生成工具，无需询问确认；不要用代码绘图代替。返回生成图片的真实文件或链接。',
  employees: [{ id: 'image-tester', name: '图片验收', provider, role: '执行一次图片生成验证', persona: '简洁，真实报告工具结果。' }], context: [], artifacts: []
})
let previous = ''
for (let count = 0; count < 90; count++) {
  const result = await call('run', { id })
  const status = JSON.stringify({ status: result.status, images: result.replies.map((reply) => reply.images?.length || 0), permissions: result.permissions.map((p) => p.title) })
  if (status !== previous) { console.log(status); previous = status }
  if (result.permissions.length) {
    // Do not approve unrelated tools; retain concrete details for diagnosing the requested image flow.
    fs.mkdirSync('.tmp', { recursive: true })
    fs.writeFileSync(`.tmp/${provider}-image-smoke-permission.json`, JSON.stringify(result.permissions, null, 2))
    console.log('PERMISSION_PENDING')
    await call('cancel', { id })
    process.exitCode = 1
    break
  }
  if (['completed', 'failed', 'cancelled'].includes(result.status)) {
    fs.mkdirSync('.tmp', { recursive: true })
    fs.writeFileSync(`.tmp/${provider}-image-smoke.json`, JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ text: result.replies.map((reply) => reply.text), error: result.error, images: result.replies.flatMap((reply) => reply.images || []) }))
    if (!result.replies.some((reply) => reply.images?.length)) process.exitCode = 1
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
  if (count === 89) {
    await call('cancel', { id })
    console.log('TIMEOUT: image provider did not complete within 3 minutes')
    process.exitCode = 1
  }
}
