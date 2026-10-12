import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { seedWorkspace, waitForWorkspace, readWorkspace, failWorkspaceWrites, restoreWorkspaceWrites } from './desktop-test-storage.mjs'

// Real portable backup UI, filesystem, IPC and IndexedDB across isolated profiles.
// Model and authorization calls are forbidden; archive file dialogs select test paths.
const args=process.argv.slice(2), require=createRequire(import.meta.url)
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback
const explicitExe=option('--exe',undefined)
const executablePath=path.resolve(explicitExe||require('electron'))
const output=path.resolve(option('--output-dir','.tmp/quality-0.1.24/portable-interaction'))
fs.mkdirSync(output,{recursive:true})
const root=fs.mkdtempSync(path.join(output,'journey-'))
let entry=process.env.PLAYWRIGHT_PATH
if(!entry){try{entry=require.resolve('playwright')}catch{entry=path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')}}
if(fs.statSync(entry).isDirectory())entry=path.join(entry,'index.mjs')
const imported=await import(pathToFileURL(entry).href), {_electron}=imported._electron?imported:imported.default
const results=[],errors=[],applications=[],evidence={}
const check=async(name,fn)=>{try{await fn();results.push({name,ok:true});console.error('PASS',name)}catch(error){results.push({name,ok:false,error:error.stack});console.error('FAIL',name,error.message);const page=target?.page||source?.page;if(page&&!page.isClosed()){await page.screenshot({path:path.join(root,'failure.png')});fs.writeFileSync(path.join(root,'failure-ui.txt'),await page.locator('body').innerText())}throw error}}
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
 const app=await _electron.launch({executablePath,args:[`--user-data-dir=${userData}`,...(!explicitExe?[process.cwd()]:[])],env,timeout:45000});applications.push(app)
 const page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message))
 await page.getByRole('textbox',{name:'对话消息',exact:true}).waitFor()
 await page.evaluate(()=>window.grok.savePrefs({locale:'zh-CN'}))
 await app.evaluate(({ipcMain,dialog},testRoot)=>{
  globalThis.__portableArchive=testRoot+'\\portable.zip';globalThis.__portableDirectory=testRoot+'\\source-code';globalThis.__portableDirectoryCalls=0
  dialog.showSaveDialog=async()=>({canceled:false,filePath:globalThis.__portableArchive})
  dialog.showOpenDialog=async(...args)=>{const options=args.at(-1);if(options.properties?.includes('openDirectory'))globalThis.__portableDirectoryCalls++;if(options.properties?.includes('openDirectory')&&globalThis.__holdDirectory){globalThis.__directoryWaiting=true;return new Promise(resolve=>{globalThis.__releaseDirectory=()=>resolve({canceled:true,filePaths:[]})})}return {canceled:false,filePaths:[options.properties?.includes('openDirectory')?globalThis.__portableDirectory:globalThis.__portableArchive]}}
  globalThis.__baselineCalls={sends:0,logins:0}
  for(const channel of ['workspace:start','workspace:login']){ipcMain.removeHandler(channel);ipcMain.handle(channel,()=>{globalThis.__baselineCalls[channel==='workspace:start'?'sends':'logins']++;throw new Error('Offline baseline forbids real requests')})}
  ipcMain.removeHandler('workspace:providers');ipcMain.handle('workspace:providers',(_event,_refresh,ids=['claude','codex','grok','gemini'])=>ids.map(id=>({id,cli:{state:'not_found',version:null,path:null},auth:null,models:[],checkedAt:new Date().toISOString(),usage:null,loginCommand:`${id} login`})))
 },root)
 await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setSize(...window.getMinimumSize())})
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
const portableDialog=page=>page.getByRole('dialog',{name:'预览并恢复便携备份',exact:true})
const exportDialog=page=>page.getByRole('dialog',{name:'导出便携备份',exact:true})
const closeApp=async app=>{assert.deepEqual(await app.evaluate(()=>globalThis.__baselineCalls),{sends:0,logins:0});await app.close();applications.splice(applications.indexOf(app),1)}
const projectDirectory=path.join(root,'source-code'), archive=path.join(root,'portable.zip')
fs.mkdirSync(projectDirectory);fs.writeFileSync(path.join(projectDirectory,'excluded-project-source.ts'),'source code must never be automatically archived')
let source,target,beforeTarget,sourceState,sourceAssistant,sourceAttachment,sourceImage,managedAttachment,managedImage
const waitMain=async(app,predicate)=>{const deadline=Date.now()+6000;while(Date.now()<deadline){if(await app.evaluate(predicate))return;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Main-process test checkpoint did not arrive')}
const readManifest=file=>new Promise((resolve,reject)=>require('yauzl').open(file,{lazyEntries:true},(error,zip)=>{
 if(error){reject(error);return}let found=false
 zip.on('error',reject);zip.on('end',()=>{if(!found)reject(new Error('Manifest missing'))})
 zip.on('entry',entry=>{if(entry.fileName!=='manifest.json'){zip.readEntry();return}found=true;zip.openReadStream(entry,(error,stream)=>{
  if(error){reject(error);return}const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('error',reject);stream.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString()))}catch(error){reject(error)}finally{zip.close()}})
 })});zip.readEntry()
}))
const chooseImport=async()=>{
 await section(target.page).getByRole('button',{name:'选择便携备份并预览',exact:true}).click()
 await portableDialog(target.page).getByRole('checkbox',{name:'我确认用此备份替换工作区及助手资料',exact:true}).waitFor()
}
const confirmImport=async()=>{
 await portableDialog(target.page).getByRole('checkbox',{name:'我确认用此备份替换工作区及助手资料',exact:true}).check()
 await portableDialog(target.page).getByRole('button',{name:'确认替换并恢复便携备份',exact:true}).click()
}
try{
 source=await launch('source')
 await check('source profile contains independent and project assistant scopes, drafts, a real attachment and image',async()=>{
  sourceState=await waitForWorkspace(source.page,v=>v?.state.teams.length>0)
  const standalone=sourceState.state.teams[0];standalone.name='便携独立会话'
  const project={...structuredClone(standalone),id:'portable-source-project',kind:'project',name:'便携项目',parentId:null,directory:projectDirectory}
  const child={...structuredClone(standalone),id:'portable-source-child',name:'便携项目子会话',parentId:project.id,directory:projectDirectory}
  sourceState.state.teams=[standalone,project,child];sourceState.state.activeTeamId=child.id
  sourceState.state.drafts={[standalone.id]:'独立草稿保留',[child.id]:'项目草稿保留'}
  await seedWorkspace(source.page,sourceState)
  const fixture=await source.page.evaluate(async({standaloneId,projectId,directory})=>{
   const api=window.grok.workspace
   await api.updateAssistant(standaloneId,{name:'独立助手身份',persona:'独立偏好',addressing:'开发者',style:'professional'})
   await api.saveMemory(standaloneId,{kind:'fact',content:'独立记忆保留'})
   await api.updateAssistant(projectId,{name:'项目助手身份',persona:'项目偏好',addressing:'协作者',style:'warm'})
   await api.saveMemory(projectId,{kind:'preference',content:'项目记忆保留'})
   const assistant=await api.saveCommitment(projectId,{title:'项目提醒保留',dueAt:'2099-10-11T08:00:00.000Z'})
   const attachment=await api.upload(projectId,{name:'portable-note.txt',data:btoa('portable attachment exact bytes')},directory)
   const image=await api.upload(projectId,{name:'generated-fixture.png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8KgAAAABJRU5ErkJggg=='},directory)
   return {assistant,attachment,image}
  },{standaloneId:standalone.id,projectId:project.id,directory:projectDirectory})
  sourceAssistant=fixture.assistant;managedAttachment=fixture.attachment;managedImage=fixture.image
  // Upload now deliberately stores all new files in the app-managed scope.
  // Legacy projects may still reference files in their source tree: create
  // explicit isolated copies so native source authorization remains exercised.
  fs.mkdirSync(path.join(projectDirectory,'attachments'),{recursive:true})
  fs.mkdirSync(path.join(projectDirectory,'images'),{recursive:true})
  sourceAttachment={...managedAttachment,path:path.join(projectDirectory,'attachments','legacy-portable-note.txt')}
  sourceImage={...managedImage,path:path.join(projectDirectory,'images','legacy-generated-fixture.png')}
  fs.copyFileSync(managedAttachment.path,sourceAttachment.path)
  fs.copyFileSync(managedImage.path,sourceImage.path)
  sourceState.state.attachmentDrafts={[child.id]:[sourceAttachment]}
  child.messages=[{id:'portable-image-message',author:child.members[0].id,to:'all',text:'已生成的图片历史',time:'10:00',kind:'message',sample:false,status:'completed',images:[{path:sourceImage.path,alt:'便携图片'}]}]
  await seedWorkspace(source.page,sourceState)
 })
 await check('cancelling collection waits for cleanup and preserves the source workspace',async()=>{
  await openData(source.page)
  const before=(await readWorkspace(source.page)).state
  const staging=path.join(source.profile,'home','.grok','desktop','portable-backups')
  const jobs=()=>fs.existsSync(staging)?fs.readdirSync(staging).filter(name=>name.startsWith('job-')).sort():[]
  const jobsBefore=jobs(),dialogsBefore=await source.app.evaluate(()=>globalThis.__portableDirectoryCalls)
  await source.app.evaluate(()=>{globalThis.__holdDirectory=true;globalThis.__directoryWaiting=false})
  await section(source.page).getByRole('button',{name:'导出便携 ZIP',exact:true}).click()
  await waitMain(source.app,()=>globalThis.__directoryWaiting)
  assert.equal(await source.app.evaluate(()=>globalThis.__portableDirectoryCalls),dialogsBefore+1)
  assert.equal(jobs().length,jobsBefore.length+1)
  await source.page.waitForFunction(()=>document.querySelector('dialog[aria-label="导出便携备份"] button[aria-label="关闭弹窗"]')?.disabled===false)
  await source.page.keyboard.press('Escape')
  await exportDialog(source.page).getByText('正在取消，请稍候…',{exact:true}).waitFor()
  await source.page.screenshot({path:path.join(root,'cancel-external-source-collection.png')})
  await source.app.evaluate(()=>{globalThis.__holdDirectory=false;globalThis.__releaseDirectory()})
  await exportDialog(source.page).waitFor({state:'hidden'})
  assert.deepEqual((await readWorkspace(source.page)).state,before)
  assert.equal(fs.existsSync(archive),false)
  assert.deepEqual(jobs(),jobsBefore)
  evidence.externalCancellation={nativeSourceDialogs:1,stagingCreated:true,stagingCleaned:true,workspaceUnchanged:true}
 })
 await check('export previews all data and writes a portable ZIP with explicit source directory confirmation',async()=>{
  const dialogsBefore=await source.app.evaluate(()=>globalThis.__portableDirectoryCalls)
  await section(source.page).getByRole('button',{name:'导出便携 ZIP',exact:true}).click()
  await exportDialog(source.page).getByRole('button',{name:'选择位置并导出 ZIP',exact:true}).waitFor()
  assert.equal(await source.app.evaluate(()=>globalThis.__portableDirectoryCalls),dialogsBefore+1)
  const text=await exportDialog(source.page).innerText()
  assert.match(text,/助手资料/);assert.match(text,/记忆/);assert.match(text,/提醒/);assert.match(text,/已包含文件/)
  assert.equal(await exportDialog(source.page).getByRole('region',{name:'未包含的文件'}).count(),0)
  await source.page.screenshot({path:path.join(root,'export-preview.png')})
  await exportDialog(source.page).getByRole('button',{name:'选择位置并导出 ZIP',exact:true}).click()
  await exportDialog(source.page).waitFor({state:'hidden'})
  await section(source.page).getByRole('status').filter({hasText:'便携备份已保存'}).waitFor()
  assert.equal(fs.readFileSync(archive).subarray(0,2).toString(),'PK')
 })
 await check('managed-only references export complete bytes without asking for a source directory',async()=>{
  const managed=structuredClone(sourceState),child=managed.state.teams.find(team=>team.id==='portable-source-child')
  managed.state.attachmentDrafts[child.id]=[managedAttachment]
  child.messages[0].images=[{path:managedImage.path,alt:'便携图片'}]
  await seedWorkspace(source.page,managed);await openData(source.page)
  await source.app.evaluate((_electron,directory)=>{globalThis.__portableArchive=directory+'\\managed-only.zip'},root)
  const dialogsBefore=await source.app.evaluate(()=>globalThis.__portableDirectoryCalls)
  await section(source.page).getByRole('button',{name:'导出便携 ZIP',exact:true}).click()
  await exportDialog(source.page).getByRole('button',{name:'选择位置并导出 ZIP',exact:true}).waitFor()
  assert.equal(await exportDialog(source.page).getByRole('region',{name:'未包含的文件'}).count(),0)
  await source.page.screenshot({path:path.join(root,'export-managed-without-source-dialog.png')})
  await exportDialog(source.page).getByRole('button',{name:'选择位置并导出 ZIP',exact:true}).click()
  await exportDialog(source.page).waitFor({state:'hidden'})
  await section(source.page).getByRole('status').filter({hasText:'便携备份已保存'}).waitFor()
  assert.equal(await source.app.evaluate(()=>globalThis.__portableDirectoryCalls),dialogsBefore)
  const manifest=await readManifest(path.join(root,'managed-only.zip'))
  assert.equal(manifest.resources.length,2)
  assert.ok(manifest.resources.every(item=>typeof item.hash==='string'&&!item.missing&&item.size>0))
  assert.equal(manifest.resources.reduce((sum,item)=>sum+item.size,0),fs.statSync(managedAttachment.path).size+fs.statSync(managedImage.path).size)
  evidence.managedExport={nativeSourceDialogs:0,includedResources:manifest.resources.length,missingResources:0}
  await seedWorkspace(source.page,sourceState);await openData(source.page)
  await source.app.evaluate((_electron,directory)=>{globalThis.__portableArchive=directory+'\\portable.zip'},root)
 })
 await check('portable export rescues the latest in-memory draft while IndexedDB writes fail',async()=>{
  await source.page.locator('.settings-close').click();await failWorkspaceWrites(source.page)
  await source.page.getByRole('textbox',{name:'对话消息',exact:true}).fill('仅内存的新草稿')
  await source.page.getByRole('alert').filter({hasText:'本机存储写入失败'}).waitFor()
  assert.equal((await readWorkspace(source.page)).state.drafts['portable-source-child'],'项目草稿保留')
  await source.app.evaluate((_electron,directory)=>{globalThis.__portableArchive=directory+'\\unsaved.zip'},root)
  await openData(source.page);await section(source.page).getByRole('button',{name:'导出便携 ZIP',exact:true}).click()
  await exportDialog(source.page).getByRole('button',{name:'选择位置并导出 ZIP',exact:true}).click()
  await exportDialog(source.page).waitFor({state:'hidden'})
  const manifest=await readManifest(path.join(root,'unsaved.zip'))
  assert.equal(manifest.workspace.state.drafts['portable-source-child'],'仅内存的新草稿')
  assert.equal(manifest.assistants.length,2)
  await source.page.screenshot({path:path.join(root,'export-unsaved-memory.png')})
  await restoreWorkspaceWrites(source.page)
  await section(source.page).getByRole('button',{name:'重试保存',exact:true}).click()
  await waitForWorkspace(source.page,v=>v?.state.drafts['portable-source-child']==='仅内存的新草稿')
 })
 await check('missing files are listed and exporting an incomplete backup requires separate acknowledgement',async()=>{
  const altered=structuredClone(sourceState),child=altered.state.teams.find(team=>team.id==='portable-source-child')
  child.messages.push({id:'missing-image-message',author:child.members[0].id,to:'all',text:'缺失图片历史',time:'10:01',kind:'message',sample:false,status:'completed',images:[{path:path.join(projectDirectory,'missing-image.png'),alt:'缺失图片'}]})
  await seedWorkspace(source.page,altered);await openData(source.page)
  await source.app.evaluate((_electron,directory)=>{globalThis.__portableArchive=directory+'\\incomplete.zip'},root)
  await section(source.page).getByRole('button',{name:'导出便携 ZIP',exact:true}).click()
  const acknowledge=exportDialog(source.page).getByRole('checkbox',{name:'我已了解缺失文件，仍继续导出',exact:true})
  await acknowledge.waitFor()
  assert.equal(await exportDialog(source.page).getByRole('button',{name:'选择位置并导出 ZIP',exact:true}).isEnabled(),false)
  assert.match(await exportDialog(source.page).innerText(),/1 项文件未包含/)
  await acknowledge.check();await source.page.screenshot({path:path.join(root,'export-missing-file.png')})
  await exportDialog(source.page).getByRole('button',{name:'选择位置并导出 ZIP',exact:true}).click();await exportDialog(source.page).waitFor({state:'hidden'})
  await section(source.page).getByRole('status').filter({hasText:'1 项文件未包含'}).waitFor()
 })
 await closeApp(source.app)
 target=await launch('target')
 await check('preview and keyboard cancellation do not replace an existing target workspace',async()=>{
  beforeTarget=await waitForWorkspace(target.page,v=>v?.state.teams.length>0)
  const team=beforeTarget.state.teams[0];team.id='portable-source-project';team.name='目标原工作区';team.parentId=null;beforeTarget.state.activeTeamId=team.id
  beforeTarget.state.drafts={[team.id]:'目标原草稿'};await seedWorkspace(target.page,beforeTarget)
  await target.page.evaluate(async id=>{await window.grok.workspace.updateAssistant(id,{name:'目标原助手'});await window.grok.workspace.saveMemory(id,{kind:'fact',content:'目标原记忆'})},team.id)
  beforeTarget=await readWorkspace(target.page)
  await openData(target.page);await chooseImport()
  assert.equal(await portableDialog(target.page).getByRole('button',{name:'确认替换并恢复便携备份',exact:true}).isEnabled(),false)
  assert.deepEqual((await readWorkspace(target.page)).state,beforeTarget.state)
  await target.page.keyboard.press('Tab');assert.equal(await target.page.evaluate(()=>document.activeElement?.closest('dialog')?.getAttribute('aria-label')),'预览并恢复便携备份')
  await target.page.screenshot({path:path.join(root,'import-preview-minimum.png')})
  await target.page.keyboard.press('Escape');await portableDialog(target.page).waitFor({state:'hidden'})
  assert.deepEqual((await readWorkspace(target.page)).state,beforeTarget.state)
 })
 await check('an IndexedDB commit failure retains the original durable and visible workspace without a success message',async()=>{
  await chooseImport();await failWorkspaceWrites(target.page);await confirmImport()
  await portableDialog(target.page).getByRole('alert').waitFor()
  assert.deepEqual((await readWorkspace(target.page)).state,beforeTarget.state)
  assert.equal(await section(target.page).getByRole('status').filter({hasText:'便携备份已恢复并保存'}).count(),0)
  await target.page.screenshot({path:path.join(root,'restore-commit-failure.png')})
  await restoreWorkspaceWrites(target.page)
  await portableDialog(target.page).getByRole('button',{name:'关闭',exact:true}).click()
  await target.page.locator('.settings-close').click()
  assert.equal(await target.page.getByRole('textbox',{name:'对话消息',exact:true}).inputValue(),'目标原草稿')
  await openData(target.page)
 })
 await check('cross-profile restore remaps scopes, preserves bytes and assistant data, and excludes project source code',async()=>{
  await chooseImport()
  await target.app.evaluate(({ipcMain})=>{
   const acknowledge=ipcMain._invokeHandlers.get('backup:reconcile'),prepare=ipcMain._invokeHandlers.get('backup:prepareRestore')
   globalThis.__restorePrepareCalls=0;globalThis.__ackWaiting=false;globalThis.__holdAckOnce=true
   ipcMain.removeHandler('backup:prepareRestore');ipcMain.handle('backup:prepareRestore',(...args)=>{globalThis.__restorePrepareCalls++;return prepare(...args)})
   ipcMain.removeHandler('backup:reconcile');ipcMain.handle('backup:reconcile',async(...args)=>{if(args[1]&&globalThis.__holdAckOnce){globalThis.__holdAckOnce=false;globalThis.__ackWaiting=true;await new Promise(resolve=>{globalThis.__releaseAck=resolve})}return acknowledge(...args)})
  })
  await portableDialog(target.page).getByRole('checkbox',{name:'我确认用此备份替换工作区及助手资料',exact:true}).check()
  await portableDialog(target.page).getByRole('button',{name:'确认替换并恢复便携备份',exact:true}).evaluate(button=>{button.click();button.click()})
  await waitMain(target.app,()=>globalThis.__ackWaiting)
  await portableDialog(target.page).getByText('正在提交并保存工作区…',{exact:true}).waitFor()
  assert.equal(await portableDialog(target.page).getByRole('button',{name:'关闭弹窗',exact:true}).isEnabled(),false)
  await target.page.keyboard.press('Escape');assert.equal(await portableDialog(target.page).isVisible(),true)
  assert.equal(await target.app.evaluate(()=>globalThis.__restorePrepareCalls),1)
  await target.page.screenshot({path:path.join(root,'commit-awaits-ack.png')})
  await target.app.evaluate(()=>globalThis.__releaseAck())
  await portableDialog(target.page).waitFor({state:'hidden'})
  await section(target.page).getByRole('status').filter({hasText:'便携备份已恢复并保存'}).waitFor()
  const saved=await waitForWorkspace(target.page,v=>v?.state.teams.some(team=>team.name==='便携项目子会话'))
  const project=saved.state.teams.find(team=>team.name==='便携项目'), child=saved.state.teams.find(team=>team.name==='便携项目子会话')
  assert.notEqual(project.id,'portable-source-project');assert.equal(child.parentId,project.id)
  assert.equal(saved.state.drafts[child.id],'项目草稿保留');assert.equal(child.directory,project.directory)
  assert.ok(project.directory.startsWith(target.profile));assert.notEqual(project.directory,projectDirectory)
  assert.equal(fs.existsSync(path.join(project.directory,'excluded-project-source.ts')),false)
  const attachment=saved.state.attachmentDrafts[child.id][0],image=child.messages[0].images[0]
  assert.deepEqual(fs.readFileSync(attachment.path),fs.readFileSync(sourceAttachment.path))
  assert.deepEqual(fs.readFileSync(image.path),fs.readFileSync(sourceImage.path))
  const assistant=await target.page.evaluate(id=>window.grok.workspace.assistant(id),project.id)
  assert.equal(assistant.profile.name,sourceAssistant.profile.name);assert.equal(assistant.profile.persona,sourceAssistant.profile.persona)
  assert.deepEqual(assistant.memories.map(({content,kind})=>({content,kind})),sourceAssistant.memories.map(({content,kind})=>({content,kind})))
  assert.equal(assistant.commitments[0].title,'项目提醒保留');assert.equal(assistant.remindersPaused,true)
  const preview=await target.page.evaluate(async({id,source,directory})=>window.grok.workspace.media(id,source,directory),{id:project.id,source:image.path,directory:child.directory})
  assert.match(preview.dataUrl,/^data:image/)
  await target.page.screenshot({path:path.join(root,'restore-success.png')})
 })
 await check('restored reminders remain paused until the user explicitly resumes notifications',async()=>{
  await target.page.locator('.settings-close').click()
  await target.page.getByRole('button',{name:'主 agent 档案与记忆',exact:true}).click()
  const panel=target.page.getByRole('dialog',{name:'项目主 agent',exact:true})
  await panel.getByRole('tab',{name:'承诺与提醒',exact:true}).click()
  await panel.getByText('项目提醒保留',{exact:true}).waitFor()
  await panel.getByRole('button',{name:'恢复此助手的提醒通知',exact:true}).waitFor()
  await target.page.screenshot({path:path.join(root,'restored-reminders-paused.png')})
  await panel.getByRole('button',{name:'恢复此助手的提醒通知',exact:true}).click()
  await panel.getByRole('button',{name:'恢复此助手的提醒通知',exact:true}).waitFor({state:'hidden'})
  const state=(await readWorkspace(target.page)).state,project=state.teams.find(team=>team.name==='便携项目')
  const assistant=await target.page.evaluate(id=>window.grok.workspace.assistant(id),project.id)
  assert.equal(assistant.remindersPaused,false);assert.equal(assistant.commitments.length,1)
  await panel.getByRole('button',{name:'关闭弹窗',exact:true}).click()
 })
 await closeApp(target.app);target=await launch('target')
 await check('the full rollback point survives a restart and restores the target original assistant and draft',async()=>{
  await openData(target.page)
  await section(target.page).getByRole('button',{name:'回退到替换前的工作区',exact:true}).click()
  const rollback=target.page.getByRole('dialog',{name:'回退到替换前的工作区',exact:true})
  assert.equal(await rollback.getByRole('button',{name:'确认回退',exact:true}).isEnabled(),false)
  await rollback.getByRole('checkbox',{name:'我确认回退并替换当前工作区及助手资料',exact:true}).check()
  await target.page.screenshot({path:path.join(root,'rollback-confirm.png')})
  await rollback.getByRole('button',{name:'确认回退',exact:true}).click();await rollback.waitFor({state:'hidden'})
  await section(target.page).getByRole('status').filter({hasText:'已回退并保存'}).waitFor()
  const restored=await waitForWorkspace(target.page,v=>v?.state.drafts['portable-source-project']==='目标原草稿')
  assert.equal(restored.state.teams.find(team=>team.id==='portable-source-project').name,'目标原工作区')
  const assistant=await target.page.evaluate(()=>window.grok.workspace.assistant('portable-source-project'))
  assert.equal(assistant.profile.name,'目标原助手');assert.equal(assistant.memories[0].content,'目标原记忆')
 })
 await check('legacy emergency JSON export remains available and warns that assistant and media bytes are excluded',async()=>{
  const json=await download(target.app,section(target.page).getByRole('button',{name:'导出工作区备份',exact:true}))
  assert.equal(json.value.format,'workspace-backup');assert.equal(json.value.state.drafts['portable-source-project'],'目标原草稿')
  assert.match(await section(target.page).innerText(),/不含.*附件与图片原文件.*独立记忆/)
 })
 await check('restoring an incomplete archive requires both warnings and replacement acknowledgement and reports its limitation',async()=>{
  await target.app.evaluate((_electron,directory)=>{globalThis.__portableArchive=directory+'\\incomplete.zip'},root)
  await chooseImport()
  await portableDialog(target.page).getByRole('checkbox',{name:'我确认用此备份替换工作区及助手资料',exact:true}).check()
  assert.equal(await portableDialog(target.page).getByRole('button',{name:'确认替换并恢复便携备份',exact:true}).isEnabled(),false)
  await portableDialog(target.page).getByRole('checkbox',{name:'我已了解缺失文件，仍继续恢复',exact:true}).check()
  await target.page.screenshot({path:path.join(root,'import-missing-file.png')})
  await portableDialog(target.page).getByRole('button',{name:'确认替换并恢复便携备份',exact:true}).click();await portableDialog(target.page).waitFor({state:'hidden'})
  await section(target.page).getByRole('status').filter({hasText:'1 项文件缺失'}).waitFor()
  const saved=await waitForWorkspace(target.page,v=>v?.state.teams.some(team=>team.name==='便携项目子会话'))
  assert.equal(saved.state.teams.find(team=>team.name==='便携项目子会话').messages.length,2)
 })
 await check('no model request, real authorization or renderer errors occur',async()=>{
  for(const app of applications)assert.deepEqual(await app.evaluate(()=>globalThis.__baselineCalls),{sends:0,logins:0})
  assert.deepEqual(errors,[])
 })
}catch(error){results.push({name:'harness',ok:false,error:error.stack})}
finally{
 for(const [index,app]of applications.entries())await check(`profile ${index+1} clean exit`,async()=>{await app.evaluate(()=>{globalThis.__releaseAck?.();globalThis.__releaseDirectory?.()});await app.close()})
 const report={ok:results.length>0&&results.every(item=>item.ok),executablePath,root,results,errors,evidence}
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1
}
