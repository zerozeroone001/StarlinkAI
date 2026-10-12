import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { seedWorkspace, waitForWorkspace, readWorkspace, failWorkspaceWrites, restoreWorkspaceWrites } from './desktop-test-storage.mjs'

// Records verified limitations of the installed 0.1.23 JSON backup. A passing
// baseline confirms the limitations exist; it is not portable-backup acceptance.
const args=process.argv.slice(2), require=createRequire(import.meta.url)
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback
const executablePath=path.resolve(option('--exe','release/20261011-quality-0.1.23/installed/Grok.exe'))
const output=path.resolve(option('--output-dir','.tmp/quality-0.1.24/backup-baseline'))
fs.mkdirSync(output,{recursive:true})
const root=fs.mkdtempSync(path.join(output,'baseline-'))
let entry=process.env.PLAYWRIGHT_PATH
if(!entry){try{entry=require.resolve('playwright')}catch{entry=path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')}}
if(fs.statSync(entry).isDirectory())entry=path.join(entry,'index.mjs')
const imported=await import(pathToFileURL(entry).href), {_electron}=imported._electron?imported:imported.default
const results=[],gaps=[],errors=[],applications=[]
const check=async(name,fn)=>{try{await fn();results.push({name,ok:true});console.error('PASS',name)}catch(error){results.push({name,ok:false,error:error.stack});console.error('FAIL',name,error.message)}}
const section=page=>page.getByRole('region',{name:'工作区数据',exact:true})
const openData=async page=>{
 await page.locator('.sidebar-foot').getByRole('button',{name:/Settings|设置/}).click()
 await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:/General|通用设置/}).click()
}
async function launch(name){
 const profile=path.join(root,name),home=path.join(profile,'home'),userData=path.join(profile,'user-data')
 fs.mkdirSync(home,{recursive:true})
 const env={...process.env,GROK_HOME:path.join(home,'.grok'),HOME:home,USERPROFILE:home,CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),GEMINI_CLI_HOME:home,
  APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),HTTP_PROXY:'http://127.0.0.1:9',HTTPS_PROXY:'http://127.0.0.1:9',ALL_PROXY:'http://127.0.0.1:9',
  http_proxy:'http://127.0.0.1:9',https_proxy:'http://127.0.0.1:9',all_proxy:'http://127.0.0.1:9',NO_PROXY:'localhost,127.0.0.1'}
 for(const key of Object.keys(env))if(/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|ELECTRON_RENDERER_URL|GROK_CONFIG(?:_PATH)?|GROK_BIN)$/.test(key)||/^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|GEMINI|GOOGLE|XAI|GROK)_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BASE_URL)$/.test(key))delete env[key]
 const app=await _electron.launch({executablePath,args:[`--user-data-dir=${userData}`],env,timeout:45000});applications.push(app)
 const page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message))
 await page.getByRole('textbox',{name:'对话消息',exact:true}).waitFor()
 await page.evaluate(()=>window.grok.savePrefs({locale:'zh-CN'}))
 await app.evaluate(({ipcMain})=>{
  globalThis.__baselineCalls={sends:0,logins:0}
  for(const channel of ['workspace:start','workspace:login']){ipcMain.removeHandler(channel);ipcMain.handle(channel,()=>{globalThis.__baselineCalls[channel==='workspace:start'?'sends':'logins']++;throw new Error('Offline baseline forbids real requests')})}
  ipcMain.removeHandler('workspace:providers');ipcMain.handle('workspace:providers',(_event,_refresh,ids=['claude','codex','grok','gemini'])=>ids.map(id=>({id,cli:{state:'not_found',version:null,path:null},auth:null,models:[],checkedAt:new Date().toISOString(),usage:null,loginCommand:`${id} login`})))
 })
 await page.reload();await page.getByRole('textbox',{name:'对话消息',exact:true}).waitFor()
 return {app,page,profile}
}
async function download(app,button){
 const file=path.join(root,`backup-${Date.now()}.json`)
 await app.evaluate(({session},destination)=>{
  globalThis.__baselineDownload='pending'
  session.defaultSession.once('will-download',(_event,item)=>{item.setSavePath(destination);item.once('done',(_event,state)=>{globalThis.__baselineDownload=state})})
 },file)
 await button.click()
 let state='pending';const deadline=Date.now()+10000
 while(state==='pending'&&Date.now()<deadline){state=await app.evaluate(()=>globalThis.__baselineDownload);if(state==='pending')await new Promise(resolve=>setTimeout(resolve,40))}
 assert.equal(state,'completed')
 return {file,text:fs.readFileSync(file,'utf8'),value:JSON.parse(fs.readFileSync(file,'utf8'))}
}
let source,target,exported,teamId,fixture
try{
 source=await launch('source')
 await check('source profile contains durable assistant identity, memory, reminder and readable media',async()=>{
  const saved=await waitForWorkspace(source.page,v=>v?.state.teams.length>0);teamId=saved.state.activeTeamId
  fixture=await source.page.evaluate(async id=>{
   const api=window.grok.workspace
   await api.updateAssistant(id,{name:'迁移基线助手',persona:'迁移后应继续保留的助手人格',addressing:'开发者',style:'professional'})
   await api.saveMemory(id,{content:'迁移基线记忆：保留用户偏好',kind:'preference'})
   const assistant=await api.saveCommitment(id,{title:'迁移基线提醒',dueAt:'2099-10-11T08:00:00.000Z'})
   const attachment=await api.upload(id,{name:'migration-note.txt',data:btoa('portable attachment bytes')})
   const image=await api.upload(id,{name:'generated-fixture.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8KgAAAABJRU5ErkJggg=='})
   const preview=await api.media(id,image.path)
   return {assistant,attachment,image,preview}
  },teamId)
  assert.equal(fixture.assistant.profile.name,'迁移基线助手');assert.equal(fixture.assistant.memories.length,1);assert.equal(fixture.assistant.commitments.length,1)
  assert.match(fixture.preview.dataUrl,/^data:image/)
  saved.state.drafts[teamId]='迁移基线草稿';saved.state.attachmentDrafts[teamId]=[fixture.attachment]
  const team=saved.state.teams.find(t=>t.id===teamId)
  team.name='跨资料目录迁移基线';team.messages=[{id:'baseline-image',author:team.members[0].id,to:'all',text:'离线生成图片历史',time:'10:00',kind:'message',sample:false,status:'completed',images:[{path:fixture.image.path,alt:'生成图片基线'}]}]
  await seedWorkspace(source.page,saved)
  const reread=await source.page.evaluate(id=>window.grok.workspace.assistant(id),teamId)
  assert.deepEqual(reread,fixture.assistant)
 })
 await check('legacy JSON export omits assistant records and file bytes while retaining path references',async()=>{
  await openData(source.page)
  exported=await download(source.app,section(source.page).getByRole('button',{name:'导出工作区备份',exact:true}))
  assert.equal(exported.value.format,'workspace-backup');assert.equal(exported.value.version,1)
  assert.equal(exported.value.state.drafts[teamId],'迁移基线草稿')
  assert.equal(exported.value.state.attachmentDrafts[teamId][0].path,fixture.attachment.path)
  assert.doesNotMatch(exported.text,/迁移基线助手|迁移基线记忆|迁移基线提醒|portable attachment bytes/)
  gaps.push('JSON v1 excludes assistant identity, memories, reminders and referenced media bytes.')
  await source.page.screenshot({path:path.join(root,'legacy-export-scope.png')})
 })
 target=await launch('target')
 await check('a separate profile restores conversation and draft but receives empty assistant state and unreadable image',async()=>{
  await openData(target.page)
  await target.page.getByLabel('导入工作区备份文件',{exact:true}).setInputFiles(exported.file)
  assert.equal(await section(target.page).getByRole('button',{name:'确认替换并恢复',exact:true}).isEnabled(),false)
  const previewText=await section(target.page).locator('.workspace-data-confirm').innerText()
  assert.doesNotMatch(previewText,/缺失文件|无法读取|图片.*[0-9]|附件.*[0-9]/)
  await section(target.page).locator('.workspace-data-confirm').scrollIntoViewIfNeeded()
  await target.page.screenshot({path:path.join(root,'legacy-preview-no-file-validation.png')})
  await section(target.page).getByRole('checkbox',{name:'我确认用此备份替换本地工作区'}).check()
  await section(target.page).getByRole('button',{name:'确认替换并恢复',exact:true}).click()
  await waitForWorkspace(target.page,v=>v?.state.drafts[teamId]==='迁移基线草稿')
  await section(target.page).getByRole('status').filter({hasText:'工作区已恢复并保存'}).waitFor()
  const restored=await target.page.evaluate(async({id,imagePath})=>{
   const assistant=await window.grok.workspace.assistant(id)
   let media
   try{media=await window.grok.workspace.media(id,imagePath)}catch(error){media={error:String(error)}}
   return {assistant,media}
  },{id:teamId,imagePath:fixture.image.path})
  assert.equal(restored.assistant.profile.name,'主 agent');assert.deepEqual(restored.assistant.memories,[]);assert.deepEqual(restored.assistant.commitments,[])
  assert.ok(restored.media.error);assert.equal(restored.media.dataUrl,undefined)
  gaps.push('Cross-profile restore reports saved workspace while assistant records are empty and image paths remain scoped to the source profile; no per-file warning exists in preview.')
  await target.page.screenshot({path:path.join(root,'legacy-restored-with-missing-data.png')})
 })
 await check('failed persistence leaves the imported workspace in memory without automatic rollback',async()=>{
  const altered=structuredClone(exported.value);altered.state.drafts[teamId]='未提交的导入草稿'
  await target.page.getByLabel('导入工作区备份文件',{exact:true}).setInputFiles({name:'failed-restore.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(altered))})
  await section(target.page).getByRole('checkbox',{name:'我确认用此备份替换本地工作区'}).check()
  await failWorkspaceWrites(target.page)
  await section(target.page).getByRole('button',{name:'确认替换并恢复',exact:true}).click()
  await section(target.page).getByRole('alert').filter({hasText:'本机保存失败'}).waitFor()
  assert.equal((await readWorkspace(target.page)).state.drafts[teamId],'迁移基线草稿')
  assert.equal(await section(target.page).getByRole('status').filter({hasText:'工作区已恢复并保存'}).count(),0)
  await target.page.screenshot({path:path.join(root,'legacy-restore-save-failure.png')})
  await target.page.locator('.settings-close').click()
  assert.equal(await target.page.getByRole('textbox',{name:'对话消息',exact:true}).inputValue(),'未提交的导入草稿')
  gaps.push('Persistence failure retains imported state in memory and old state on disk; rollback is a manual JSON download/import, not a durable complete-data transaction.')
  await restoreWorkspaceWrites(target.page)
  await target.page.getByRole('button',{name:'重试保存',exact:true}).click()
  await waitForWorkspace(target.page,v=>v?.state.drafts[teamId]==='未提交的导入草稿')
 })
 await check('offline fixtures cause no authorization, model request or renderer exceptions',async()=>{
  for(const app of applications)assert.deepEqual(await app.evaluate(()=>globalThis.__baselineCalls),{sends:0,logins:0})
  assert.deepEqual(errors,[])
 })
}catch(error){results.push({name:'harness',ok:false,error:error.stack})}
finally{
 for(const [index,app]of applications.entries())await check(`profile ${index+1} clean exit`,()=>app.close())
 const report={kind:'legacy-gap-baseline',ok:results.length>0&&results.every(item=>item.ok),executablePath,root,gaps,results,errors}
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1
}
