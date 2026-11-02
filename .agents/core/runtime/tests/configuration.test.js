import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,cpSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {types} from '../src/objects/schema.js';
import {createConfigurationService} from '../src/services/configuration.js';
import {runConfigurationCommand} from '../src/commands/configuration.js';
import {defaultDesktop,defaultMaterialSettings} from '../../applications/sdk/src/shared/preferences-validation.js';
import {writeUserData} from '../src/services/user-data.js';
import {readConfigFile} from '../src/configuration/storage.js';
import {configureCapture} from '../src/services/tasks.js';
import {createAITaskService} from '../src/ai-tasks/service.js';
import {startWebServer} from '../src/services/web.js';
import {controlRequest} from '../src/communication/client.js';
import {publishConfigFile} from '../src/configuration/storage.js';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stopService,serviceStatus} from '../src/services/service-manager.js';

function fixture(t,options){const root=mkdtempSync(join(tmpdir(),'ksf-config-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const service=createConfigurationService(root,options);return {root,service,put(path,value){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);},async write(id,values,extra={}){const before=await service.read(id);return service.perform(id,'write',{values,ifMatch:before.etag,...extra});}};}
test('catalog and all static reads/checks/export leave a clean instance untouched',async t=>{
 const f=fixture(t),catalog=await f.service.list();
 for(const d of catalog.domains){const value=await f.service.read(d.id);assert.equal(value.etag,'missing');if(d.capabilities.includes('check')){if(d.id==='device')continue;await f.service.check(d.id);}}
 await f.service.export();assert.deepEqual(readdirSync(f.root),[]);
});
test('CLI preview, actual write and existing user-data writers share the same CAS source',async t=>{
 const f=fixture(t),args=['write','instance','--data','{"name":"我的 KSF"}','--if-match','missing','--json'];
 const preview=JSON.parse((await runConfigurationCommand([...args,'--dry-run'],f.root)).stdout);assert.equal(preview.ok,true);assert.deepEqual(readdirSync(f.root),[]);
 const first=JSON.parse((await runConfigurationCommand(args,f.root)).stdout);assert.equal(first.ok,true);
 writeUserData({root:f.root,namespace:'instance',values:{name:'另一个编辑器'},ifMatch:first.data.etag});
 await assert.rejects(f.service.perform('instance','write',{values:{name:'旧草稿'},ifMatch:first.data.etag}),{code:'CONFIG_CONFLICT'});
 const current=await f.service.read('instance');assert.equal(current.values.name,'另一个编辑器');
 const same=await f.write('instance',{name:'另一个编辑器'});assert.equal(same.etag,current.etag);assert.equal(same.changed,false);
});
test('USER/BOT preserve BOM, CRLF and arbitrary Markdown; stale writes and symlinks are rejected',async t=>{
 const f=fixture(t),body='\uFEFF# 设定\r\n\r\n保留 **原文**。\r\n';f.put('USER.md',body);
 const first=await f.service.read('collaboration.user');assert.equal(first.values.text,body);
 const same=await f.write('collaboration.user',{text:body});assert.equal(same.etag,first.etag);
 assert.equal(readFileSync(join(f.root,'USER.md'),'utf8'),body);
 f.put('USER.md',body+'手动修改\r\n');await assert.rejects(f.service.perform('collaboration.user','write',{values:{text:'覆盖'},ifMatch:first.etag}),{code:'CONFIG_CONFLICT'});
 assert.equal(existsSync(join(f.root,'BOT.md')),false);
 f.put('target.md','不得改动的目标');symlinkSync('target.md',join(f.root,'BOT.md'));
 await assert.rejects(f.service.read('collaboration.bot'),{code:'USER_DATA_PATH_INVALID'});assert.equal(readFileSync(join(f.root,'target.md'),'utf8'),'不得改动的目标');
 await assert.rejects(f.service.perform('collaboration.user','reset',{ifMatch:(await f.service.read('collaboration.user')).etag}),{code:'CONFIG_OPERATION_UNSUPPORTED'});
});
test('desktop and appearance are shared instance values with strict validation and preserved card configuration',async t=>{
 const f=fixture(t),preferences=defaultDesktop();preferences.groups[0].layout[0].config={project:'example',nested:{preserve:true}};
 await f.write('desktop',{preferences});await f.write('appearance',{settings:defaultMaterialSettings()});
 const another=createConfigurationService(f.root);assert.deepEqual((await another.read('desktop')).effective.preferences,preferences);
 const version=(await f.service.read('desktop')).etag;
 await assert.rejects(f.write('desktop',{preferences:{...preferences,version:99}}),{code:'PREFERENCES_INVALID'});
 assert.equal((await f.service.read('desktop')).etag,version);
});
test('reset removes only selected overrides; unsupported schema is preserved',async t=>{
 const f=fixture(t);await f.write('identity',{name:'作者',email:'author@example.com'});
 await f.service.perform('identity','reset',{fields:['email'],ifMatch:(await f.service.read('identity')).etag});
 assert.deepEqual((await f.service.read('identity')).values,{name:'作者'});
 f.put('.agents/user-data/instance.json','{"schema_version":99}');await assert.rejects(f.service.read('instance'),{code:'USER_DATA_VERSION_UNSUPPORTED'});
 assert.equal(readFileSync(join(f.root,'.agents/user-data/instance.json'),'utf8'),'{"schema_version":99}');
});
test('export excludes device identity, grants, secrets, arbitrary ability values and collaboration by default',async t=>{
 const f=fixture(t);await f.write('instance',{name:'示例'});f.put('USER.md','私人协作设定');
 f.put('.agents/runtime-data/communication/identity.json','{"privateKey":"PRIVATE"}');
 f.put('.agents/user-data/communication/config.json',JSON.stringify({schemaVersion:1,revision:1,peers:{x:{secret:'TRUST'}},grants:{x:'GRANT'}}));
 f.put('.agents/user-data/ai/connections.json',JSON.stringify({schemaVersion:1,revision:1,items:[{id:'codex',kind:'codex',enabled:true,concurrency:1,executablePath:'/private/bin/codex',codexHome:'/private/auth'}]}));
 const ordinary=JSON.stringify(await f.service.export());for(const value of ['PRIVATE','TRUST','GRANT','私人协作设定','/private/bin/codex','/private/auth'])assert.equal(ordinary.includes(value),false);
 const explicit=JSON.stringify(await f.service.export({includeDevice:true,includeCollaboration:true}));assert.equal(explicit.includes('私人协作设定'),true);assert.equal(explicit.includes('PRIVATE'),false);assert.equal(explicit.includes('GRANT'),false);
});
test('capture toggles preserve enabled intervals, history and original activation; preview is nonmutating',async t=>{
 const f=fixture(t);const start='2026-01-01T00:00:00.000Z',stop='2026-01-02T00:00:00.000Z',resume='2026-01-03T00:00:00.000Z';
 configureCapture({root:f.root,enabled:true,at:start});let current=await f.service.read('capture');
 configureCapture({root:f.root,enabled:false,ifMatch:current.etag,at:stop});current=await f.service.read('capture');
 configureCapture({root:f.root,enabled:true,ifMatch:current.etag,at:resume});
 const document=readConfigFile(f.root,'.agents/runtime-data/task-capture/config.json').document;
 assert.equal(document.activatedAt,start);assert.deepEqual(document.intervals,[{from:start,to:stop},{from:resume,to:null}]);
});
test('offline runtime reads are unknown; runtime write requires the owner rather than rewriting its files',async t=>{
 const f=fixture(t);assert.equal((await f.service.read('ai.connections')).application.state,'unknown');
 await assert.rejects(f.write('ai.connections',{items:[]}),{code:'CONFIG_BACKEND_REQUIRED'});assert.deepEqual(readdirSync(f.root),[]);
});
test('AI runtime configuration shares CAS and preserves no-op config revisions',async t=>{
 const f=fixture(t),ai=createAITaskService(f.root,{executors:{}});
 const center=createConfigurationService(f.root,{ai});
 const values={items:[{id:'example',kind:'api',enabled:true,concurrency:1,protocolId:'openai-responses-v1',baseURL:'https://example.invalid/v1',credentialRef:'env:EXAMPLE_KEY'}]};
 const first=await center.perform('ai.connections','write',{ifMatch:'missing',values});
 const second=await center.perform('ai.connections','write',{ifMatch:first.etag,values});assert.equal(second.etag,first.etag);assert.equal(second.revision,first.revision);
 await assert.rejects(center.perform('ai.connections','write',{ifMatch:'missing',values}),{code:'CONFIG_CONFLICT'});
 await ai.close();
});
test('program effective values follow the consumer defaults without changing top-level replacement semantics',async t=>{
 const f=fixture(t);await f.write('program',{updates:{check_interval_seconds:3600,request_timeout_seconds:20}});
 await f.write('program',{updates:{request_timeout_seconds:5}});const current=await f.service.read('program');
 assert.deepEqual(current.values.updates,{request_timeout_seconds:5});assert.deepEqual(current.effective.updates,{check_interval_seconds:86400,request_timeout_seconds:5});
 const preview=await f.service.perform('program','reset',{fields:['updates'],ifMatch:current.etag,dryRun:true});assert.deepEqual(preview.candidate.updates,{check_interval_seconds:86400,request_timeout_seconds:10});
});
test('HTTP and local CLI bridge use one service, enforce sessions and return conflicts without data loss',async t=>{
 const f=fixture(t),server=await startWebServer({root:f.root,port:0,capture:false});
 try{
  const origin=new URL(server.url).origin;
  const session=await fetch(new URL('/api/workbench/session',server.url)).then(r=>r.json());
  assert.ok(session.data.capabilities.includes('config-v1'));
  const url=new URL('/api/config/instance',server.url),body={operation:'write',values:{name:'浏览器保存'},ifMatch:'missing'};
  const blocked=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});assert.equal(blocked.status,403);
  const headers={'content-type':'application/json',origin,'x-ksf-token':session.data.token};
  const first=await fetch(url,{method:'POST',headers,body:JSON.stringify(body)}).then(r=>r.json());assert.equal(first.ok,true);
  const shared=await controlRequest(f.root,'/api/local/config',{operation:'read',input:{domain:'instance'}});assert.equal(shared.values.name,'浏览器保存');
  const stale=await fetch(url,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(stale.status,409);
  const invalid=await fetch(url,{method:'POST',headers,body:JSON.stringify({...body,operation:'export',ifMatch:first.data.etag,values:{name:'不可写'}})});assert.equal(invalid.status,400);
  assert.equal((await f.service.read('instance')).values.name,'浏览器保存');
 }finally{await server.close();}
});
test('saved-but-failed service application is visible and retry uses the saved version',{skip:process.platform==='linux'?'Linux rejects login startup before saving; linux.test.js covers this boundary.':false},async t=>{
 const f=fixture(t);let failed=true;
 const service={async autostart(input){const before=readConfigFile(f.root,'.agents/runtime-data/service/policy.json');if(before.document?.autostart!==input.enabled)publishConfigFile(f.root,before,{schemaVersion:1,port:1313,autostart:input.enabled});if(failed)throw Object.assign(Error('模拟登录启动权限拒绝'),{code:'FIXTURE_STARTUP_DENIED',data:{saved:true}});}};
 const center=createConfigurationService(f.root,{service});
 const result=await center.perform('service','write',{values:{autostart:true},ifMatch:'missing'});assert.equal(result.saved,true);assert.equal(result.application.state,'failed');assert.equal(result.values.autostart,true);
 failed=false;const retried=await center.perform('service','apply',{ifMatch:result.etag});assert.equal(retried.application.state,'immediate');assert.equal(retried.etag,result.etag);
});
test('real CLI starts a managed backend without frontend assets and round-trips AI configuration',{skip:!['darwin','linux'].includes(process.platform)},async t=>{
 const f=fixture(t),core=fileURLToPath(new URL('../../',import.meta.url));
 const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 f.put('.agents/runtime-data/service/policy.json',JSON.stringify({schemaVersion:1,port,autostart:false}));
 cpSync(join(core,'runtime/src'),join(f.root,'.agents/core/runtime/src'),{recursive:true});
 for(const name of ['build.json','data-compatibility.json'])cpSync(join(core,name),join(f.root,'.agents/core',name));cpSync(join(core,'runtime/package.json'),join(f.root,'.agents/core/runtime/package.json'));
 cpSync(join(core,'applications/sdk/src/shared'),join(f.root,'.agents/core/applications/sdk/src/shared'),{recursive:true});cpSync(join(core,'applications/sdk/package.json'),join(f.root,'.agents/core/applications/sdk/package.json'));
 f.put('.agents/core/applications/sdk/server/workflow-contract.mjs',readFileSync(join(core,'applications/sdk/server/workflow-contract.mjs')));
 const values={items:[{id:'headless',kind:'api',enabled:true,concurrency:1,protocolId:'openai-responses-v1',baseURL:'https://example.invalid/v1',credentialRef:'env:FIXTURE_ONLY'}]};
 try{
  const result=spawnSync(process.execPath,[join(f.root,'.agents/core/runtime/src/cli.js'),'config','write','ai.connections','--data',JSON.stringify(values),'--if-match','missing','--json'],{encoding:'utf8',timeout:45000});
  assert.equal(result.status,0,result.stdout+result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.ok,true);assert.equal(value.data.values.items[0].id,'headless');
  const status=await serviceStatus(f.root);assert.equal(status.state,'running');assert.equal((await fetch(new URL('/',status.directUrl))).status,503);
  const shared=await controlRequest(f.root,'/api/local/config',{operation:'read',input:{domain:'ai.connections'}});assert.equal(shared.etag,value.data.etag);
 }finally{await stopService(f.root);}
});

test('ability settings enumerate every effective type without reading personal values or creating configuration',async t=>{
 const f=fixture(t);
 for(const [type,paths] of Object.entries(types)){
  for(const source of ['system','user'])mkdirSync(join(f.root,paths[source]),{recursive:true});
  const id=type+'.example.available';
  f.put(paths.system+'/'+id+'/'+paths.entry,`---\nid: ${id}\nname: 系统能力\ndescription: 尚未配置的能力\nversion: 1.0.0\nstatus: active\n---\n能力正文\n`);
 }
 const partner='partner.example.available';
 f.put(types.partner.user+'/'+partner+'/partner.md',`---\nid: ${partner}\nname: 用户覆盖能力\ndescription: 使用有效来源\nversion: 1.0.0\nstatus: active\nuser_revision: 1\n---\n用户正文\n`);
 f.put('.agents/user-data/objects/corrupt.json','not a configuration');
 const catalog=await f.service.list();assert.equal(catalog.complete,true);assert.equal(catalog.abilities.length,4);
 assert.equal(catalog.abilities.find(item=>item.objectId===partner).label,'用户覆盖能力');
 assert.equal(catalog.abilities.find(item=>item.objectId===partner).source,'user');
 assert.equal(existsSync(join(f.root,'.agents/user-data/objects',partner+'.json')),false);
 const before=await f.service.read('ability:'+partner);assert.equal(before.etag,'missing');
 const first=await f.service.perform('ability:'+partner,'write',{ifMatch:before.etag,values:{enabled:true,nickname:'示例',complex:{steps:[1,2]}}});
 const updated=await f.service.perform('ability:'+partner,'write',{ifMatch:first.etag,values:{nickname:'已修改'}});
 assert.deepEqual(updated.values,{enabled:true,nickname:'已修改',complex:{steps:[1,2]}});
 await assert.rejects(f.service.perform('ability:'+partner,'write',{ifMatch:first.etag,values:{enabled:false}}),{code:'CONFIG_CONFLICT'});
 assert.equal(readFileSync(join(f.root,'.agents/user-data/objects/corrupt.json'),'utf8'),'not a configuration');
});

test('legacy desktop reads are non-mutating and shortcut writes publish the protected new format',async t=>{
 const f=fixture(t),preferences=defaultDesktop(),path='.agents/user-data/desktop.json';f.put(path,JSON.stringify({schema_version:1,namespace:'desktop',revision:4,values:{preferences}}));
 const before=readFileSync(join(f.root,path),'utf8');assert.deepEqual((await f.service.read('desktop')).values.preferences,preferences);assert.equal(readFileSync(join(f.root,path),'utf8'),before);
 preferences.shortcuts={initialized:true,homeGroupId:'home',installations:{'example.app':'install-1'}};preferences.groups[0].layout.push({i:'app-one',kind:'app',appId:'example.app',x:4,y:0,w:1,h:1});
 await f.write('desktop',{preferences});const saved=JSON.parse(readFileSync(join(f.root,path),'utf8'));assert.equal(saved.schema_version,2);assert.equal(saved.revision,5);assert.deepEqual(saved.values.preferences,preferences);
});
