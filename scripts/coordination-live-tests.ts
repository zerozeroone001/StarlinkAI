// Explicit opt-in: calls the signed-in Grok account, only inside a disposable test directory.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRuntime } from '../src/main/runtime/service'
import { providers } from '../src/main/runtime/providers'
import { execute } from '../src/main/runtime/adapters'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-coordination-live-'))
const managed = process.argv.includes('--managed')
const controls: string[] = []
const runtime = createRuntime({ providers, execute: async (input) => {
  let control = ''
  await execute({ ...input, text: (delta) => { control += delta; input.text(delta) } })
  if (input.employee.id === 'Butler') controls.push(control)
}, directory: () => root })
let permissions = 0
try {
  const catalog = await providers(false, ['grok'])
  assert.ok(catalog[0]?.auth?.signedIn, 'Grok login required for live verification')
  const model = catalog[0].models.find((m) => m.isDefault) || catalog[0].models[0]
  assert.ok(model, 'Grok model catalog is unavailable')
  const employee = (id: string, role: string) => ({ id, name: id, provider: 'grok' as const, model: model.id,
    ...(model.efforts.includes('low') ? { effort: 'low' } : {}), role, persona: '简洁，只执行本人的职责。' })
  let snapshot = await runtime.api.start({ id: 'coordination-live', workspaceId: 'coordination-live',
    goal: '验证两个 agent 在同一临时工作目录中依次开发和验收。',
    prompt: 'Builder 创建 sum.mjs，导出 sum(values) 返回数字数组之和；在回复中说明文件和接口。Reviewer 根据前一员工交接读取该文件，创建 sum.test.mjs，使用 node:test 测试空数组、负数、[1,2,3]，运行测试后回复 REVIEW_OK。只操作当前临时目录，不读取其他项目或配置。',
    ...(managed ? { coordination: { leadId: 'Butler' } } : {}),
    employees: [...(managed ? [employee('Butler', '担任管家，根据需求实际分配 Builder 实现，再安排 Reviewer 验证；跟进两者结果并检查，不能亲自代替员工完成。只返回宿主要求的 JSON 调度指令。')] : []),
      employee('Builder', '只实现 sum.mjs，不创建测试；交给 Reviewer 验证。'), employee('Reviewer', '读取 Builder 的交接和实际源码，编写并运行测试，报告验证结果。')],
    artifacts: [], context: [] })
  const deadline = Date.now() + (managed ? 480000 : 180000)
  let progress = ''
  while (['queued', 'running', 'needs_permission'].includes(snapshot.status)) {
    assert.ok(Date.now() < deadline, 'live coordination timed out')
    for (const permission of snapshot.permissions) {
      const allow = permission.options.find((option) => /allow|accept/i.test(option.id))
      assert.ok(allow, `No one-time allow option for ${permission.title}`)
      await runtime.api.permission(snapshot.id, permission.id, allow.id)
      permissions++
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    snapshot = await runtime.api.run(snapshot.id)
    if (managed) {
      const next = JSON.stringify({ phase: snapshot.coordination?.phase, tasks: snapshot.coordination?.tasks.map((task) => ({ owner: task.owner, status: task.status })) })
      if (next !== progress) { console.log(`Live butler progress: ${next}`); progress = next }
    }
  }
  if (snapshot.status !== 'completed' && managed) console.log(`Rejected live butler responses: ${JSON.stringify(controls.slice(-3))}`)
  assert.equal(snapshot.status, 'completed', snapshot.error)
  if (managed) {
    assert.equal(snapshot.coordination?.phase, 'completed')
    assert.ok(snapshot.coordination?.tasks.length! >= 2)
    assert.ok(snapshot.coordination?.tasks.every((task) => task.status === 'completed' && !!task.review))
    assert.ok(snapshot.replies.some((reply) => reply.employeeId === 'Builder'))
    assert.ok(snapshot.replies.some((reply) => reply.employeeId === 'Reviewer' && /REVIEW_OK/.test(reply.text)))
    assert.ok(snapshot.replies.filter((reply) => reply.employeeId === 'Butler').length >= 3)
  } else {
    assert.equal(snapshot.replies.length, 2)
    assert.match(snapshot.replies[1].text, /REVIEW_OK/)
  }
  assert.ok(snapshot.replies.every((reply) => fs.realpathSync(reply.cwd!) === fs.realpathSync(root)))
  execFileSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd: root, windowsHide: true, stdio: 'pipe' })
  execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum([]),0); assert.equal(sum([-2,1]),-1); assert.equal(sum([1,2,3]),6)"], { cwd: root, windowsHide: true })
  console.log(`PASS live ${managed ? 'butler delegation and review' : 'coordination'}: shared files, independent Node checks, ${permissions} permission responses`)
} finally {
  await runtime.close()
  const target = path.resolve(root)
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('grok-coordination-live-'))
  fs.rmSync(target, { recursive: true, force: true })
  const sessionsRoot = path.resolve(os.homedir(), '.grok', 'sessions')
  const testSessions = path.resolve(sessionsRoot, encodeURIComponent(root))
  assert.ok(testSessions.startsWith(sessionsRoot + path.sep) && path.basename(testSessions) === encodeURIComponent(root))
  fs.rmSync(testSessions, { recursive: true, force: true })
}
