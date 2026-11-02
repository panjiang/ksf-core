// Isolated, fictional browser acceptance through the real Core HTTP/SDK bridge.
// Never packaged into application releases and never opens a real AI execution.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startWebServer } from '../../src/services/web.js';
import { emptyProjectPlan, projectManagement } from '../../src/services/project-management.js';
import { objectQuery } from '../../src/services/objects.js';
import { createReviewDB } from '../../../applications/conversations/backend/review-db.js';

const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const store = process.argv[2]; if (!store) throw Error('Pass the explicitly built candidate store.');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ksf-four-browser-')));
const save = (path, text) => { mkdirSync(join(root,path,'..'),{recursive:true}); writeFileSync(join(root,path),typeof text==='string'?text:JSON.stringify(text)); };
cpSync(join(repository,'.agents/core/abilities'),join(root,'.agents/core/abilities'),{recursive:true});
cpSync(join(repository,'.agents/core/docs'),join(root,'.agents/core/docs'),{recursive:true});
cpSync(join(repository,'AGENTS.md'),join(root,'AGENTS.md'));
cpSync(join(repository,'.agents/core/manifest.yaml'),join(root,'.agents/core/manifest.yaml'));
for (const dir of ['能力/协同','能力/搭档','能力/基本功','能力/数据包','项目/示例/任务','知识/示例','档案','repositories','@收件箱']) mkdirSync(join(root,dir),{recursive:true});
save('USER.md','# 虚构验收用户\n'); save('BOT.md','# 隔离验收\n');
save('知识/knowledge.md','# 知识\n\n[示例认识](示例/复核习惯.md)\n');
save('知识/示例/复核习惯.md','# 复核习惯\n\n一次检查通过，只证明对应范围。\n\n[项目来源](../../项目/示例/project.md)\n');
save('项目/其他/project.md','---\nname: 另一个事项\nstatus: active\n---\n# 另一个事项\n只有原始根卡，没有管理计划。\n');
save('项目/示例/project.md','---\nname: 社区工作坊\nstatus: active\ndescription: 虚构的四域闭环验收项目。\n---\n# 社区工作坊\n\n[知识依据](../../知识/示例/复核习惯.md)\n\n[采用方法](../../.agents/core/abilities/competencies/project-control/competency.md)\n\n[检查点](任务/演练.md)\n');
save('项目/示例/任务/演练.md','---\ncheckpoint_schema: 1\ntask_id: fictional-pilot\nname: 演练检查\nstate: in_progress\nupdated: "'+new Date().toISOString()+'"\n---\n# 演练检查\n先核对现行安排，再确认具体执行步骤。\n');
const plan=emptyProjectPlan();Object.assign(plan,{purpose:'完成一次可复用的社区工作坊演练',summary:'先核对演练脚本，再观察实际结果。',currentStageId:'pilot'});
plan.goals=[{id:'goal',title:'演练完整可用',successCriteria:'主持与参与流程实际走通'}];
plan.stages=[{id:'pilot',title:'演练准备与核对',description:'留下能回看的结果。',goalIds:['goal'],state:'active',criteria:[]}];
plan.items=[{id:'script',title:'核对主持脚本',goalIds:['goal'],stageId:'pilot',description:'完成可演练的脚本。',state:'ready',commitment:'now',priority:'normal',priorityReason:'演练的必要输入',owner:'活动负责人',dueDate:'',dependsOn:[],blocker:'',nextAction:'核对参与流程与时间安排。',acceptance:[],links:['知识/示例/复核习惯.md'],source:null}];
const initialized=projectManagement({root,name:'示例',operation:'write',data:{plan,ifMatch:'missing',operationId:'four-core-browser-init'}});if(initialized.errors.length)throw Error(JSON.stringify(initialized.errors));
const taskId='a'.repeat(64),turnId='fictional-one',at=new Date().toISOString();
const definition=objectQuery({root,type:'competency',operation:'read',reference:'competency.ksf.project-control'}).data.object;
const target={kind:'project',name:'示例',scope:'current',path:'项目/示例/project.md'};
save(`档案/对话/Codex/${taskId}/task.json`,{protocol:'ksf-task-archive-v1',taskId,title:'虚构演练复核'});
save(`档案/对话/Codex/${taskId}/turns/${turnId}.json`,{protocol:'ksf-task-archive-v1',taskId,turnId,revision:1,policy:'capture',status:'completed',startedAt:at,updatedAt:at,declarations:[],issues:[],routes:[{eventId:'fixture',at,snapshot:{summary:'虚构恢复检查',status:'completed',project:{state:'bound',primary:{name:'示例',scope:'current',path:target.path}},references:[],ownership:{state:'bound',target},relatedTargets:[{kind:'knowledge',name:'复核习惯',path:'知识/示例/复核习惯.md'}],abilities:[{ref:definition.id+'@'+definition.version,source:definition.source,stage:'adopted',definitionDigest:definition.definition_digest}]}}],messages:[{id:'fixture-user',role:'user',at,content:[{type:'input_text',text:'请核对演练恢复顺序。'}],revisions:[]},{id:'fixture-result',role:'assistant',phase:'final_answer',at,content:[{type:'output_text',text:'本虚构案例先读取现行计划，再核对演练检查点。知识/示例/复核习惯.md'}],revisions:[]}]});
const db=createReviewDB(join(root,'.agents/user-data/applications/data/com.ksf.conversations'));
db.put('suggestion','fixture-recovery',{id:'fixture-recovery',revision:1,key:'read-current-plan',type:'asset',targetKey:'知识/示例/复核习惯.md',targetLabel:'复核习惯',targetPath:'知识/示例/复核习惯.md',problem:'恢复时可能只看旧检查点',change:'补充先核对项目现行管理安排的适用条件',reason:'旧记录不代表当前承诺',validation:'读回知识原件并在演练恢复中核对；长期效果尚未观察',citations:['fixture-source'],method:{scenario:'',input:'',steps:[],output:'',limits:''},status:'pending',createdAt:at,updatedAt:at,evidence:[{sourceId:'fixture-source',taskId,turnId,revision:1,messageId:'fixture-result',at,inDay:true,title:'虚构演练复核',excerpt:'先读取现行计划',timeKnown:true}],reportIds:[],resolution:null});db.close();
const server=await startWebServer({root,port:18432,capture:false,applications:{defaultSource:null,storeDirectory:store}});
const session=(await fetch(server.url+'api/workbench/session').then(r=>r.json())).data;
const index=JSON.parse(readFileSync(join(store,'index.json'),'utf8'));
for(const entry of index.apps){const r=await fetch(server.url+'api/apps/install',{method:'POST',headers:{'content-type':'application/json',origin:server.url.slice(0,-1),'x-ksf-token':session.token},body:JSON.stringify({trusted:true,sourceId:'builtin',appId:entry.manifest.id,version:entry.manifest.version,digest:entry.package.sha256})});const result=await r.json();if(!result.ok)throw Error(JSON.stringify(result));}
console.log(JSON.stringify({url:server.url,root,installed:index.apps.map(e=>e.manifest.id+'@'+e.manifest.version)}));
process.on('SIGTERM',()=>void server.close().then(()=>{rmSync(root,{recursive:true,force:true});process.exit();}));
