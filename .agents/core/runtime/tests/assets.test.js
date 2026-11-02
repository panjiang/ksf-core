import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssetService } from '../src/services/assets.js';
import { createWorkspaceFiles } from '../src/services/workspace-files.js';
import { createCoordinator } from '../src/services/workbench-common.js';
import { objectMutation } from '../src/services/objects.js';
import { activateAssets } from '../../applications/shared/assets-backend.mjs';
import { suggestionUpdate, suggestionHandoff } from '../../applications/conversations/backend/suggestion-delivery.js';
import { createApplicationManager } from '../src/applications/manager.js';
import { encodePackage, checksum } from '../src/applications/protocol.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ksf-four-assets-')));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  cpSync(join(repository,'.agents/core/abilities'),join(root,'.agents/core/abilities'),{recursive:true});
  cpSync(join(repository,'AGENTS.md'),join(root,'AGENTS.md'));
  writeFileSync(join(root,'.agents/core/manifest.yaml'),'version: 0.5.1\n');
  for (const path of ['能力/协同','能力/搭档','能力/基本功','能力/数据包','知识/测试','项目/示例']) mkdirSync(join(root,path),{recursive:true});
  writeFileSync(join(root,'知识/knowledge.md'),'# 知识\n\n[测试](测试/原文.md)\n');
  writeFileSync(join(root,'知识/测试/原文.md'),'# 原文\n\n尚未验证的认识。\n[项目](../../项目/示例/project.md)\n');
  writeFileSync(join(root,'项目/示例/project.md'),'# 示例\n');
  const files = createWorkspaceFiles(root,createCoordinator()), api = createAssetService(root,{files});
  return {root,api,files};
}
test('能力写入沿现有用户派生、精确引用与锁内版本条件，旧草稿不能覆盖当前定义',t=>{
  const {root,api} = fixture(t), type='competency', ref='competency.ksf.project-control';
  const before = api.readObject({type,ref}).data.object;
  const systemBytes = readFileSync(join(root,before.path));
  const preview = api.writeObject({type,ref,ifMatch:before.definition_digest,dryRun:true,data:{body:before.body+'\n本地补充。\n'}});
  assert.equal(preview.data.derived,true); assert.equal(api.readObject({type,ref}).data.object.source,'system');
  api.writeObject({type,ref,ifMatch:before.definition_digest,dryRun:false,data:{body:before.body+'\n本地补充。\n'}});
  const derived = api.readObject({type,ref}).data.object; assert.equal(derived.source,'user'); assert.equal(derived.version,before.version);
  assert.deepEqual(readFileSync(join(root,before.path)),systemBytes); assert.equal(api.checkObject({type,ref}).data.valid,true);
  objectMutation({root,type,id:ref,operation:'write',input:{body:derived.body+'\n其他会话修改。\n'}});
  assert.throws(()=>api.writeObject({type,ref,ifMatch:derived.definition_digest,dryRun:false,data:{body:'过期覆盖'}}),{code:'OBJECT_CONFLICT'});
  assert.match(api.readObject({type,ref}).data.object.body,/其他会话修改/);
  const fixed=api.readObject({type,ref:'competency.ksf.project-route'}).data.object;
  assert.throws(()=>api.writeObject({type,ref:fixed.id,ifMatch:fixed.definition_digest,dryRun:false,data:{body:'覆盖固定入口'}}),{code:'OBJECT_PROTECTED'});
});
test('新能力只按显式内容创建，missing 不能覆盖已有身份，错误引用不落盘',t=>{
  const {api}=fixture(t), type='competency', ref='competency.example.method';
  const data={metadata:{name:'示例方法',description:'用于验证创建边界',version:'0.1.0',status:'draft',references:[]},body:'# 示例\n方法待真实验证。\n'};
  assert.equal(api.writeObject({type,ref,ifMatch:'missing',dryRun:false,data}).data.created,true);
  assert.throws(()=>api.writeObject({type,ref,ifMatch:'missing',dryRun:false,data}),{code:'OBJECT_CONFLICT'});
  assert.throws(()=>api.writeObject({type,ref:'competency.example.invalid',ifMatch:'missing',dryRun:false,data:{...data,metadata:{...data.metadata,references:['competency.missing.reference@0.1.0']}}}),{code:'OBJECT_DEPENDENCY_INVALID'});
  assert.throws(()=>api.writeObject({type,ref,source:'remote',ifMatch:'missing',dryRun:false,data}),{code:'ASSET_SOURCE_READONLY'});
});
test('知识与应用共用原件，搜索/显式创建/冲突重读不复制当前结论',async t=>{
  const {api,root}=fixture(t), path='知识/测试/原文.md';
  writeFileSync(join(root,'知识/.gitkeep'),'');
  assert(!(await api.knowledgeTree()).entries.some(entry => entry.name.startsWith('.')));
  assert.equal(readFileSync(join(root,'知识/.gitkeep'),'utf8'),'');
  const before=await api.readKnowledge({path});
  const saved=await api.saveKnowledge({path,version:before.version,text:before.text+'\n新增事实，来源待核对。\n'});
  assert.notEqual(saved.version,before.version);
  await assert.rejects(api.saveKnowledge({path,version:before.version,text:'过期全文'}),{code:'WORKSPACE_CONFLICT'});
  assert.equal((await api.readKnowledge({path})).text,saved.text);
  assert((await api.searchKnowledge({path:'知识',q:'新增事实'})).matches.some(r=>r.path===path));
  await api.createKnowledge({path:'知识/测试/新记录.md',text:'# 新记录\n内容待补充。\n'});
  await assert.rejects(api.createKnowledge({path:'知识/测试/新记录.md',text:'覆盖'}),{code:'WORKSPACE_EXISTS'});
  assert.equal(readFileSync(join(root,'知识/knowledge.md'),'utf8'),'# 知识\n\n[测试](测试/原文.md)\n');
  assert.throws(()=>api.readKnowledge({path:'知识/../USER.md'}),{code:'KNOWLEDGE_PATH_INVALID'});
  symlinkSync(join(root,'项目/示例/project.md'),join(root,'知识/测试/软链接.md'));
  await assert.rejects(api.readKnowledge({path:'知识/测试/软链接.md'}),{code:'WORKSPACE_SYMLINK'});
});
test('跨域关系仅来自明确链接，行号引用不冒充文件缺失或语义验证',async t=>{
  const {api,root}=fixture(t),path='知识/测试/原文.md';
  const links=await api.links({path});assert(links.links.some(l=>l.kind==='project'&&l.path==='项目/示例/project.md'));
  writeFileSync(join(root,'知识/测试/行号.md'),`[定位](${pathToFileURL(join(root,'项目/示例/project.md')).href}:1)\n`);
  const checked=api.checkKnowledge({path:'知识/测试/行号.md'});assert.equal(checked.valid,true);assert.equal(checked.checkedLinks,1);
  assert((await api.links({path:'知识/测试/行号.md'})).links.some(l=>l.path==='项目/示例/project.md'));
  writeFileSync(join(root,'知识/测试/Wiki.md'),'[[项目/示例/project.md]]\n');
  assert((await api.links({path:'知识/测试/Wiki.md'})).links.some(l=>l.path==='项目/示例/project.md'));
});
test('两个应用后端只转交各自已声明原子操作，不接受另一类资产写入',async()=>{
  const calls=[],context={services:{call:(...args)=>{calls.push(args);return 'ok';}}};
  const abilities=activateAssets(context,'abilities'),knowledge=activateAssets(context,'knowledge');
  assert.equal(abilities.call('writeObject',{type:'partner'}),'ok');assert.deepEqual(calls[0],['assets','writeObject',[{type:'partner'}]]);
  assert.throws(()=>abilities.call('saveKnowledge',{}),{code:'ASSET_METHOD_UNKNOWN'});
  assert.throws(()=>knowledge.call('writeObject',{}),{code:'ASSET_METHOD_UNKNOWN'});
});
test('真实应用进程缺少 filesystem 权限时不能调用新增公共资产服务',async t=>{
  const {root,api}=fixture(t),store=join(root,'fixture-store');mkdirSync(store);
  const manifest={schemaVersion:1,sdkVersion:1,id:'com.example.assets',name:'Assets fixture',version:'0.1.0',description:'Permission boundary fixture',minCoreVersion:'0.3.0',permissions:[],dataStores:[],backend:{runtime:'node',lifecycle:'on-demand',entry:'backend/index.mjs'}};
  const bytes=Buffer.from("export function activate(context){return{call(){return context.services.call('assets','knowledgeTree',[{}]);}}}");
  const packed=encodePackage(manifest,{'backend/index.mjs':{content:bytes.toString('base64'),sha256:checksum(bytes),mode:0o644}});
  const digest=checksum(packed);writeFileSync(join(store,'fixture.ksfapp'),packed);writeFileSync(join(store,'index.json'),JSON.stringify({protocol:'ksf-app-registry-v1',apps:[{manifest,package:{url:'fixture.ksfapp',sha256:digest,size:packed.length}}]}));
  const manager=createApplicationManager(root,{storeDirectory:store,defaultSource:null,services:{assets:api}});
  try{await manager.install({trusted:true,sourceId:'builtin',appId:manifest.id,version:manifest.version,digest});await assert.rejects(manager.invoke(manifest.id,'probe',{}),{code:'APP_PERMISSION_REQUIRED'});}finally{await manager.close();}
});
test('使用记录根据显式采用和目标关联区分，普通阅读不能冒充采用',async t=>{
  const {root,files}=fixture(t),path='知识/测试/原文.md';
  const sample=[{taskId:'a',turnId:'one',title:'明确知识关联',startedAt:'now',targets:[],route:{relatedTargets:[{path}],abilities:[]}},{taskId:'b',turnId:'two',title:'仅阅读候选',startedAt:'now',targets:[],route:{relatedTargets:[],abilities:[{ref:'competency.ksf.project-control@0.1.1',stage:'read'}]}},{taskId:'c',turnId:'three',title:'实际声明采用',startedAt:'now',targets:[],route:{relatedTargets:[],abilities:[{ref:'competency.ksf.project-control@0.1.1',source:'system',stage:'adopted'}]}}];
  const api=createAssetService(root,{files,reviewSource:{sources:async({limit,offset=0})=>({records:sample.slice(offset,offset+limit),total:sample.length,errors:[]})}});
  assert.equal((await api.related({path})).records[0].relation,'related');
  const object=api.readObject({type:'competency',ref:'competency.ksf.project-control'}).data.object;
  const result=await api.related({path:object.path,type:'competency',ref:object.id});assert.deepEqual(result.records.map(r=>r.taskId),['c']);assert.equal(result.records[0].relation,'adopted');
});
test('飞轮采纳、落实、验证与后续效果分开，历史标记保留，版本冲突拒绝覆盖',()=>{
  const old={id:'s1',revision:1,status:'pending',problem:'恢复遗漏',change:'先读管理主件',reason:'当前计划不在旧检查点中',validation:'实际恢复核对',evidence:[{taskId:'a',turnId:'b',messageId:'c',sourceId:'s-1'}],targetPath:'项目/示例/project.md'};
  const accepted=suggestionUpdate(old,{revision:1,status:'accepted'},'now');assert.equal(accepted.delivery,undefined);
  assert.throws(()=>suggestionUpdate(old,{revision:1,status:'resolved'},'now'),{code:'REVIEW_DELIVERY_REQUIRED'});
  const delivery={summary:'已更新唯一方法',actor:'测试者',evidence:['项目/示例/project.md'],validation:{result:'passed',detail:'本地恢复场景通过，长期效果未测'}};
  const resolved=suggestionUpdate(old,{revision:1,status:'resolved',delivery},'now');assert.equal(resolved.delivery.outcome,'not_observed');
  assert.throws(()=>suggestionUpdate(resolved,{revision:1,status:'ignored'},'later'),{code:'REVIEW_CONFLICT'});
  assert.throws(()=>suggestionUpdate(old,{revision:1,status:'resolved',delivery:{...delivery,outcome:'improved'}},'now'));
  assert.match(suggestionHandoff(old),/a\/b/);assert.match(suggestionHandoff(old),/待发送草稿/);
});
