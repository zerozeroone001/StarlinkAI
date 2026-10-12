import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { seedWorkspace, waitForWorkspace } from './desktop-test-storage.mjs'

// Real renderer/preload/IPC with isolated provider diagnostics; never sends a prompt.
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const explicitExe = option('--exe', undefined)
const executablePath = path.resolve(explicitExe || require('electron'))
const output = path.resolve(option('--output-dir', '.tmp/iteration-0123/onboarding'))
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'journey-'))
const home = path.join(root, 'home'), userData = path.join(root, 'user-data')
fs.mkdirSync(home, { recursive: true })
const existingProjectDirectory = path.join(root, 'existing-project'), newProjectDirectory = path.join(root, 'new-project')
fs.mkdirSync(existingProjectDirectory);fs.mkdirSync(newProjectDirectory)
let entry = process.env.PLAYWRIGHT_PATH
if (!entry) { try { entry = require.resolve('playwright') } catch { entry = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs') } }
if (fs.statSync(entry).isDirectory()) entry = path.join(entry, 'index.mjs')
const imported = await import(pathToFileURL(entry).href)
const { _electron } = imported._electron ? imported : imported.default
const env = { ...process.env, GROK_HOME: path.join(home, '.grok'), HOME: home, USERPROFILE: home,
  CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GEMINI_CLI_HOME: home,
  APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN)$/.test(key) ||
  /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key)) delete env[key]

const results = [], errors = []
let app, page
const check = async (name, fn) => {
 try { await fn(); results.push({name,ok:true}); console.error('PASS',name); return true }
 catch(error){results.push({name,ok:false,error:error.stack}); console.error('FAIL',name,error.message); return false}
}
const composer = () => page.getByRole('textbox',{name:'对话消息',exact:true})
const connection = () => page.getByRole('dialog',{name:'连接模型账号',exact:true})
const application = () => page.getByRole('dialog',{name:'使用模型账号',exact:true})
const openWorkspaceConnection = async () => {
 const primary=page.locator('.workspace-empty').getByRole('button',{name:/选择可用模型|连接模型账号/})
 if(await primary.isVisible())await primary.click()
 else await page.locator('.composer-account-notice').getByRole('button',{name:'连接模型账号',exact:true}).click()
}
try {
 app=await _electron.launch({executablePath,args:[`--user-data-dir=${userData}`,...(!explicitExe?[process.cwd()]:[])],env,timeout:45000})
 page=await app.firstWindow();page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message))
 if(args.includes('--minimum-window'))await app.evaluate(({BrowserWindow})=>{
  const window=BrowserWindow.getAllWindows()[0];const [width,height]=window.getMinimumSize();window.setSize(width,height)
 })
 await composer().waitFor();await page.evaluate(()=>window.grok.savePrefs({locale:'zh-CN'}))
 await app.evaluate(({ipcMain})=>{
  globalThis.__onboardingFixture={authorized:[],pending:['grok','codex'],missingModels:[],sends:0,logins:0,calls:{}}
  globalThis.__onboardingWait=new Promise(resolve=>{globalThis.__releaseOnboarding=resolve})
  ipcMain.removeHandler('workspace:providers');ipcMain.handle('workspace:providers',async(_e,_refresh,ids=['claude','codex','grok','gemini'])=>Promise.all(ids.map(async id=>{
   const f=globalThis.__onboardingFixture; f.calls[id]=(f.calls[id]||0)+1
   if(f.pending.includes(id))await globalThis.__onboardingWait
   return {id,cli:{state:'installed',path:'offline-fixture',version:'1.0'},auth:{signedIn:f.authorized.includes(id),email:f.authorized.includes(id)?'offline@example.test':null,name:null,userId:null},
    models:f.authorized.includes(id)&&!f.missingModels.includes(id)?[{id:`${id}-offline`,name:`${id} offline model`,efforts:['low','high'],isDefault:true}]:[],checkedAt:new Date().toISOString(),usage:null,loginCommand:`${id} login`}
  })))
  ipcMain.removeHandler('workspace:login');ipcMain.handle('workspace:login',()=>{globalThis.__onboardingFixture.logins++;throw new Error('No real authorization in offline onboarding test')})
  ipcMain.removeHandler('workspace:loginStatus');ipcMain.handle('workspace:loginStatus',()=>null)
  ipcMain.removeHandler('workspace:start');ipcMain.handle('workspace:start',()=>{globalThis.__onboardingFixture.sends++;throw new Error('No model prompts in onboarding test')})
 })
 await page.reload();await composer().fill('授权前写好的草稿，不发送。')
 await check('pending inspection does not claim the user is signed out and exposes connection as the first action',async()=>{
  await page.getByRole('heading',{name:'正在检查本机模型',exact:true}).waitFor({timeout:1200})
  assert.equal(await page.getByRole('button',{name:'连接模型账号',exact:true}).isEnabled(),true)
  assert.doesNotMatch(await page.locator('.workspace-empty').innerText(),/未登录|没有已授权/)
  await page.screenshot({path:path.join(root,'checking.png')})
 })
 await app.evaluate(()=>{globalThis.__onboardingFixture.pending=[];globalThis.__releaseOnboarding()})
 await page.getByLabel('选择对话附件',{exact:true}).setInputFiles({name:'onboarding-note.txt',mimeType:'text/plain',buffer:Buffer.from('Keep this attachment while choosing the model.')})
 const initial=await waitForWorkspace(page,v=>v?.state.drafts[v.state.activeTeamId]==='授权前写好的草稿，不发送。'&&v.state.attachmentDrafts[v.state.activeTeamId]?.length===1)
 const originalId=initial.state.activeTeamId, originalDefault=initial.state.defaultProvider
 const entered=await check('two clicks reach the selected official login guide without opening settings first',async()=>{
  await page.getByRole('button',{name:'连接模型账号',exact:true}).click({timeout:1200})
  await connection().getByRole('button',{name:/Claude/}).click()
  await page.getByRole('dialog',{name:'授权登录 Claude',exact:true}).waitFor()
  await page.screenshot({path:path.join(root,'official-guide.png')})
 })
 if(entered){
  await check('keyboard focus stays in the guide and Escape returns to the unchanged draft and attachment',async()=>{
   assert.equal(await page.evaluate(()=>document.activeElement?.closest('dialog')?.getAttribute('aria-label')),'授权登录 Claude')
   await page.keyboard.press('Tab')
   assert.equal(await page.evaluate(()=>document.activeElement?.closest('dialog')?.getAttribute('aria-label')),'授权登录 Claude')
   await page.keyboard.press('Escape')
   await page.getByRole('dialog',{name:'授权登录 Claude',exact:true}).waitFor({state:'hidden'})
   assert.equal(await composer().inputValue(),'授权前写好的草稿，不发送。')
   assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),false)
   const launch=page.getByRole('button',{name:'连接模型账号',exact:true})
   await launch.focus();await page.keyboard.press('Enter')
   await connection().waitFor()
   await page.keyboard.press('Tab')
   assert.equal(await page.evaluate(()=>document.activeElement?.closest('dialog')?.getAttribute('aria-label')),'连接模型账号')
   await connection().getByRole('button',{name:/Claude/}).focus();await page.keyboard.press('Enter')
   await page.getByRole('dialog',{name:'授权登录 Claude',exact:true}).waitFor()
   const unchanged=await waitForWorkspace(page,v=>v?.state.activeTeamId===originalId)
   assert.deepEqual(unchanged.state.attachmentDrafts[originalId],initial.state.attachmentDrafts[originalId])
  })
  await check('authorization without a usable model catalog remains in the guide without a false success',async()=>{
   await app.evaluate(()=>{globalThis.__onboardingFixture.authorized=['claude'];globalThis.__onboardingFixture.missingModels=['claude']})
   const guide=page.getByRole('dialog',{name:'授权登录 Claude',exact:true})
   await guide.getByRole('button',{name:'已完成登录，刷新状态',exact:true}).click()
   await guide.getByText('尚未获取可用模型，请在“模型与账号”中刷新模型目录。',{exact:true}).waitFor()
   assert.equal(await application().count(),0)
   assert.doesNotMatch(await guide.innerText(),/已检测到授权，账号卡片已刷新/)
   await app.evaluate(()=>{globalThis.__onboardingFixture.missingModels=[]})
  })
  await check('successful authorization requires an explicit application scope and preserves the current draft',async()=>{
   await app.evaluate(()=>{globalThis.__onboardingFixture.authorized=['claude']})
   await page.getByRole('button',{name:'已完成登录，刷新状态',exact:true}).click()
   await application().waitFor()
   assert.equal(await application().getByRole('radio',{checked:true}).count(),0)
   assert.equal(await application().getByRole('button',{name:'确认并返回工作区',exact:true}).isEnabled(),false)
   await application().getByRole('combobox',{name:'具体型号',exact:true}).selectOption('claude-offline')
   await application().getByRole('radio',{name:'仅用于当前空会话',exact:true}).check()
   const layout=await application().evaluate(dialog=>{
    const box=dialog.getBoundingClientRect()
    return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:innerWidth,height:innerHeight,overflow:dialog.scrollWidth-dialog.clientWidth}
   })
   assert.ok(layout.left>=0&&layout.top>=0&&layout.right<=layout.width&&layout.bottom<=layout.height,JSON.stringify(layout))
   assert.ok(layout.overflow<=1,`dialog overflows horizontally: ${JSON.stringify(layout)}`)
   await page.screenshot({path:path.join(root,'apply-current.png')})
   await application().getByRole('button',{name:'确认并返回工作区',exact:true}).click()
   const saved=await waitForWorkspace(page,v=>v?.state.teams.find(t=>t.id===originalId)?.members[0].provider==='claude')
   assert.equal(saved.state.activeTeamId,originalId);assert.equal(saved.state.defaultProvider,originalDefault)
   assert.equal(saved.state.teams.find(t=>t.id===originalId).members[0].model,'claude-offline')
   assert.deepEqual(saved.state.attachmentDrafts[originalId],initial.state.attachmentDrafts[originalId])
   assert.equal(await composer().inputValue(),'授权前写好的草稿，不发送。')
   assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),true)
  })
  await check('a ready alternative can be chosen without waiting for another provider or repeating authorization',async()=>{
   const saved=await waitForWorkspace(page,v=>v?.state.teams.find(t=>t.id===originalId)?.members[0].provider==='claude')
   const team=saved.state.teams.find(t=>t.id===originalId);team.members[0].provider='grok';delete team.members[0].model;delete team.members[0].effort;team.defaultProvider='grok'
   saved.state.teams.push({...structuredClone(team),id:'onboarding-existing-project',name:'已有项目保留员工',kind:'project',parentId:null,directory:existingProjectDirectory,
    members:[{...team.members[0],id:'existing-project-lead',model:'legacy-grok-model',persona:'keep project lead'},
     {...team.members[0],id:'existing-project-worker',name:'project worker',isLead:false,provider:'gemini',model:'legacy-gemini-model',persona:'keep project worker'}]})
   await app.evaluate(()=>{globalThis.__onboardingFixture.pending=['codex'];globalThis.__onboardingWait=new Promise(resolve=>{globalThis.__releaseOnboarding=resolve})})
   await seedWorkspace(page,saved)
   await page.getByRole('button',{name:'选择可用模型',exact:true}).click()
   await connection().getByRole('button',{name:/Claude.*可直接使用/}).click()
   await application().waitFor()
   assert.equal(await page.getByRole('dialog',{name:'授权登录 Claude',exact:true}).count(),0)
   await application().getByRole('radio',{name:'仅用于当前空会话',exact:true}).check()
   await application().getByRole('button',{name:'确认并返回工作区',exact:true}).click()
   assert.equal(await composer().inputValue(),'授权前写好的草稿，不发送。')
   assert.equal(await page.getByRole('button',{name:'发送消息',exact:true}).isEnabled(),true)
   await app.evaluate(()=>{globalThis.__onboardingFixture.pending=[];globalThis.__releaseOnboarding()})
  })
  for(const scenario of ['history','multiple-members']) await check(`${scenario} is never silently changed and the default scope is explicit`,async()=>{
   const saved=await waitForWorkspace(page,v=>v?.state.teams.some(t=>t.id===originalId))
   saved.state.activeTeamId=originalId
   const team=saved.state.teams.find(t=>t.id===originalId);team.members=[{...team.members[0],provider:'grok',model:undefined,effort:undefined}];team.defaultProvider='grok';saved.state.defaultProvider='grok'
   team.messages=scenario==='history'?[{id:'existing-history',author:'you',to:'all',text:'已有历史不可修改模型配置',time:'10:00',kind:'message',sample:false,status:'completed'}]:[]
   if(scenario==='multiple-members')team.members.push({...team.members[0],id:'onboarding-second',name:'second',isLead:false})
   const protectedTeam=structuredClone(team)
   await seedWorkspace(page,saved);await openWorkspaceConnection()
   await connection().getByRole('button',{name:/Claude.*可直接使用/}).click()
   assert.equal(await application().getByRole('radio',{name:'仅用于当前空会话',exact:true}).isEnabled(),false)
   await application().getByRole('radio',{name:'设为新会话与项目默认',exact:true}).check()
   assert.match(await application().innerText(),/之后新建的独立会话和项目/)
   assert.match(await application().innerText(),/现有项目内的新子会话仍继承该项目员工/)
   await page.screenshot({path:path.join(root,`${scenario}-protected.png`)})
   await application().getByRole('button',{name:'确认并返回工作区',exact:true}).click()
   const persisted=await waitForWorkspace(page,v=>v?.state.defaultProvider==='claude')
   assert.deepEqual(persisted.state.teams.find(t=>t.id===originalId),JSON.parse(JSON.stringify(protectedTeam)))
   assert.deepEqual(persisted.state.attachmentDrafts[originalId],initial.state.attachmentDrafts[originalId])
   assert.equal(await composer().inputValue(),'授权前写好的草稿，不发送。')
   await page.getByRole('button',{name:'新建独立对话',exact:true}).click()
   const created=await waitForWorkspace(page,v=>v?.state.activeTeamId!==originalId)
   assert.equal(created.state.teams.find(t=>t.id===created.state.activeTeamId).members[0].provider,'claude')
  })
  await check('new projects use the chosen default while existing project children inherit their original employees',async()=>{
   const before=await waitForWorkspace(page,v=>v?.state.defaultProvider==='claude')
   const existing=before.state.teams.find(t=>t.id==='onboarding-existing-project')
   assert.ok(existing)
   await page.getByRole('button',{name:'新建项目',exact:true}).first().click()
   const editor=page.getByRole('dialog',{name:'新建项目',exact:true})
   await editor.getByRole('textbox',{name:'项目名称',exact:true}).fill('新默认模型项目')
   await editor.getByRole('textbox',{name:'项目目录',exact:true}).fill(newProjectDirectory)
   await editor.getByRole('button',{name:'创建项目',exact:true}).click()
   const created=await waitForWorkspace(page,v=>v?.state.teams.some(t=>t.name==='新默认模型项目'))
   const project=created.state.teams.find(t=>t.name==='新默认模型项目')
   assert.equal(project.members[0].provider,'claude');assert.equal(project.members[0].model,'claude-offline')
   assert.equal(project.directory,newProjectDirectory)
   await page.locator('.sidebar-team-main').filter({hasText:'已有项目保留员工'}).click()
   await page.getByRole('button',{name:'新建项目对话',exact:true}).click()
   const inherited=await waitForWorkspace(page,v=>v?.state.teams.some(t=>t.parentId===existing.id))
   const child=inherited.state.teams.find(t=>t.parentId===existing.id)
   assert.equal(child.directory,existingProjectDirectory);assert.equal(child.defaultProvider,'grok')
   const employeeConfiguration=members=>members.map(({id,...configuration})=>configuration)
   assert.deepEqual(employeeConfiguration(child.members),employeeConfiguration(existing.members))
   assert.deepEqual(inherited.state.teams.find(t=>t.id===existing.id),existing)
   await page.screenshot({path:path.join(root,'existing-project-inheritance.png')})
  })
  await check('the existing settings login entry refreshes account status without applying or closing the workspace',async()=>{
   const before=await waitForWorkspace(page,v=>v?.state.teams.length>0)
   await page.locator('.sidebar-foot').getByRole('button',{name:/Settings|设置/}).click()
   await page.getByRole('button',{name:'添加账号',exact:true}).first().click()
   await page.getByRole('dialog',{name:'添加模型账号',exact:true}).getByRole('button',{name:/Gemini/}).click()
   const login=page.getByRole('dialog',{name:'授权登录 Gemini',exact:true})
   await login.waitFor()
   await app.evaluate(()=>{globalThis.__onboardingFixture.authorized.push('gemini')})
   await login.getByRole('button',{name:'已完成登录，刷新状态',exact:true}).click()
   await login.getByText('已检测到授权，账号卡片已刷新。',{exact:true}).waitFor()
   assert.equal(await login.isVisible(),true)
   assert.equal(await application().count(),0)
   const after=await waitForWorkspace(page,v=>v?.state.teams.length>0)
   assert.deepEqual(after.state,before.state)
   await login.getByRole('button',{name:'关闭',exact:true}).click()
   await page.locator('.settings-close').click()
  })
 }
 await check('no real authorization, credentials mutation, model request, or renderer exception',async()=>{
  assert.deepEqual(await app.evaluate(()=>({sends:globalThis.__onboardingFixture.sends,logins:globalThis.__onboardingFixture.logins})),{sends:0,logins:0})
  assert.deepEqual(errors,[])
 })
} catch(error){results.push({name:'harness',ok:false,error:error.stack})}
finally {
 if(app)await check('clean exit',()=>app.close())
 const report={ok:results.length>0&&results.every(r=>r.ok),executablePath,root,results,errors}
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1
}
