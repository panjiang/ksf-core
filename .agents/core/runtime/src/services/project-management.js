import { lstatSync, linkSync, unlinkSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { load, validateName, withProjectLock, stat } from '../projects/storage.js';
import { readSnapshot, publishFile } from '../metadata/files.js';
import { withTemporaryFile } from '../shared/files.js';
import { MetadataError, decodeUtf8 } from '../metadata/errors.js';
import { errorItem } from './projects.js';

const FILE = '项目管理.json', MAX = 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, details = {}) => { throw new MetadataError(code, message, details); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const states = ['backlog','ready','in_progress','blocked','paused','review','completed','cancelled'];
const timestamp = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) && Number.isFinite(Date.parse(x));
const portable = x => x.split(sep).join('/');
const stable = x => Array.isArray(x) ? x.map(stable) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;

export function emptyProjectPlan() {
  return {purpose:'',scope:'',summary:'',reviewedAt:'',currentStageId:'',wipLimit:2,goals:[],stages:[],items:[],risks:[],decisions:[]};
}

// References are workspace-relative. Never follow links or expose private runtime data.
function localReference(root, reference) {
  if (typeof reference !== 'string' || !reference || reference.length > 4096 || /[\\\x00-\x1f\x7f]/.test(reference) || isAbsolute(reference)) return null;
  const path = reference.split('#')[0];
  const parts = path.split('/');
  if (parts.some(p => !p || ['.','..','.git','node_modules'].includes(p)) || (parts[0] === '.agents' && !path.startsWith('.agents/core/docs/'))) return null;
  let cursor = root;
  try {
    for (const part of parts) { cursor = join(cursor,part); if (lstatSync(cursor).isSymbolicLink()) return null; }
    if (!lstatSync(cursor).isFile()) return null;
    const actual = relative(realpathSync(root), realpathSync(cursor));
    return actual && !actual.startsWith('..') && !isAbsolute(actual) ? cursor : null;
  } catch { return null; }
}
function validReference(root, value) {
  if (typeof value !== 'string') return false;
  if (/^https?:\/\//i.test(value)) { try { const u=new URL(value); return !!u.hostname && !u.username && !u.password; } catch { return false; } }
  return !!localReference(root,value);
}

export function checkProjectPlan(plan,options={}){
  try{return checkProjectPlanFields(plan,options);}
  catch(error){if(!(error instanceof TypeError))throw error;return{valid:false,errors:[{code:'PROJECT_PLAN_INVALID',path:'plan',message:'字段类型或嵌套结构不合法，请核对项目模型。'}],warnings:[]};}
}
function checkProjectPlanFields(plan, {root, directory, verifyReferences = true} = {}) {
  const errors=[],warnings=[];
  const err=(path,message)=>errors.push({code:'PROJECT_PLAN_INVALID',path,message});
  const warn=(path,message)=>warnings.push({path,message});
  const fields=(x,keys,path)=>{if(!object(x)){err(path,'应为字段集合。');return false;}for(const k of Object.keys(x))if(!keys.includes(k))err(path+'.'+k,'未知字段；请核对模型版本。');return true;};
  const text=(x,path,required=false)=>{if(typeof x!=='string'||x.length>20000||(required&&!x.trim()))err(path,required?'请填写非空文本（最多 20000 字符）。':'应为文本（最多 20000 字符）。');};
  const choice=(x,values,path)=>{if(!values.includes(x))err(path,'不支持的取值。');};
  const list=(x,path)=>{if(!Array.isArray(x)||x.length>500){err(path,'应为不超过 500 项的列表。');return [];}return x;};
  const ids=new Set(), group={};
  const identity=(x,path)=>{if(typeof x.id!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(x.id))err(path+'.id','使用字母开头的稳定 ID，最多 80 字符。');else if(ids.has(x.id))err(path+'.id','ID 重复。');else ids.add(x.id);text(x.title,path+'.title',true);};
  const refs=(x,path,known)=>{const a=list(x,path);for(const id of a)if(typeof id!=='string'||!known.has(id))err(path,'引用的对象不存在：'+String(id));if(new Set(a).size!==a.length)err(path,'引用不可重复。');};
  const criteria=(x,path,closed)=>{const a=list(x,path),seen=new Set();if(closed&&!a.length)err(path,'完成前至少需要一项验收条件。');a.forEach((c,i)=>{const p=path+'.'+i;if(!fields(c,['id','text','result','evidence','reviewer','reviewedAt'],p))return;text(c.id,p+'.id',true);if(seen.has(c.id))err(p+'.id','验收条件 ID 重复。');seen.add(c.id);text(c.text,p+'.text',true);choice(c.result,['pending','passed','failed'],p+'.result');text(c.reviewer,p+'.reviewer');text(c.reviewedAt,p+'.reviewedAt');const evidence=list(c.evidence,p+'.evidence');for(const v of evidence)if(verifyReferences&&!validReference(root,v))err(p+'.evidence','证据入口不存在、不安全或不是 HTTP(S) 地址：'+String(v));if(c.result==='passed'&&(!evidence.length||!c.reviewer?.trim()||!timestamp(c.reviewedAt)))err(p,'通过条件必须记录证据、复核者和实际复核时间。');if(closed&&c.result!=='passed')err(p,'完成前所有验收条件必须通过。');});};
  if(!fields(plan,['purpose','scope','summary','reviewedAt','currentStageId','wipLimit','goals','stages','items','risks','decisions'],'plan'))return {valid:false,errors,warnings};
  for(const k of ['purpose','scope','summary','reviewedAt','currentStageId'])text(plan[k],'plan.'+k);
  if(plan.reviewedAt&&!timestamp(plan.reviewedAt))err('plan.reviewedAt','复核时间应为 ISO 时间。');
  if(!Number.isSafeInteger(plan.wipLimit)||plan.wipLimit<1||plan.wipLimit>50)err('plan.wipLimit','在制上限应为 1 至 50 的整数。');
  for(const key of ['goals','stages','items','risks','decisions']){group[key]=list(plan[key],'plan.'+key);group[key].forEach((x,i)=>{if(object(x))identity(x,`plan.${key}.${i}`);else err(`plan.${key}.${i}`,'应为字段集合。');});}
  const known=key=>new Set(group[key].filter(object).map(x=>x.id));
  const goals=known('goals'),stages=known('stages'),items=known('items');
  if(plan.currentStageId&&!stages.has(plan.currentStageId))err('plan.currentStageId','当前阶段不存在。');
  group.goals.forEach((g,i)=>{const p='plan.goals.'+i;if(fields(g,['id','title','successCriteria'],p))text(g.successCriteria,p+'.successCriteria',true);});
  group.stages.forEach((s,i)=>{const p='plan.stages.'+i;if(!fields(s,['id','title','goalIds','description','criteria','state'],p))return;refs(s.goalIds,p+'.goalIds',goals);text(s.description,p+'.description');choice(s.state,['planned','active','completed','cancelled'],p+'.state');criteria(s.criteria,p+'.criteria',s.state==='completed');if(!s.goalIds?.length)warn(p,'阶段尚未关联目标。');if(s.state==='completed'&&group.items.some(x=>x?.stageId===s.id&&!['completed','cancelled'].includes(x.state)))err(p,'阶段仍有未结束事项，不能完成。');});
  group.items.forEach((x,i)=>{const p='plan.items.'+i;if(!fields(x,['id','title','goalIds','stageId','description','state','commitment','priority','priorityReason','owner','dueDate','dependsOn','blocker','nextAction','acceptance','links','source'],p))return;refs(x.goalIds,p+'.goalIds',goals);for(const k of ['stageId','description','priorityReason','owner','dueDate','blocker','nextAction'])text(x[k],p+'.'+k);if(x.stageId&&!stages.has(x.stageId))err(p+'.stageId','阶段不存在。');choice(x.state,states,p+'.state');choice(x.commitment,['candidate','next','now'],p+'.commitment');choice(x.priority,['high','normal','low'],p+'.priority');refs(x.dependsOn,p+'.dependsOn',items);if(x.dependsOn?.includes(x.id))err(p+'.dependsOn','不能依赖自身。');if(x.dueDate&&!/^\d{4}-\d\d-\d\d$/.test(x.dueDate))err(p+'.dueDate','日期使用 YYYY-MM-DD。');if(x.state==='blocked'&&!x.blocker?.trim())err(p+'.blocker','受阻事项必须说明阻塞原因。');criteria(x.acceptance,p+'.acceptance',x.state==='completed');for(const v of list(x.links,p+'.links'))if(verifyReferences&&!validReference(root,v))err(p+'.links','关联入口无效：'+String(v));if(x.source!==null&&fields(x.source,['path','taskId','digest','state'],p+'.source')){const src=x.source;for(const k of ['path','taskId','digest','state'])text(src[k],p+'.source.'+k);if(verifyReferences&&(!src.path?.startsWith(directory+'/任务/')||!localReference(root,src.path)))err(p+'.source.path','来源必须为本项目实际任务原文。');if(!/^[a-f0-9]{64}$/.test(src.digest??''))err(p+'.source.digest','来源需要 SHA256 快照。');}if(!x.goalIds?.length)warn(p,'事项尚未关联目标。');if(x.priority==='high'&&!x.priorityReason?.trim())warn(p,'高优先事项尚未说明理由。');if(['ready','in_progress'].includes(x.state)&&!x.nextAction?.trim())warn(p,'事项缺少明确下一行动。');});
  group.risks.forEach((x,i)=>{const p='plan.risks.'+i;if(!fields(x,['id','title','impact','response','owner','state','reviewTrigger'],p))return;for(const k of ['impact','response','owner','reviewTrigger'])text(x[k],p+'.'+k);choice(x.state,['open','mitigating','closed'],p+'.state');});
  group.decisions.forEach((x,i)=>{const p='plan.decisions.'+i;if(!fields(x,['id','title','rationale','impact','state','reviewTrigger'],p))return;for(const k of ['rationale','impact','reviewTrigger'])text(x[k],p+'.'+k);choice(x.state,['proposed','adopted','superseded'],p+'.state');});
  const map=new Map(group.items.filter(object).map(x=>[x.id,x])),seen=new Set(),visiting=new Set();
  function visit(id){if(visiting.has(id)){err('plan.items','硬依赖形成循环：'+id);return;}if(seen.has(id))return;visiting.add(id);for(const d of map.get(id)?.dependsOn??[])if(map.has(d))visit(d);visiting.delete(id);seen.add(id);}
  for(const id of map.keys())visit(id);
  for(const x of map.values())if(x.state==='completed'&&(x.dependsOn??[]).some(id=>map.get(id)?.state!=='completed'))err('plan.items.'+x.id,'完成事项仍有未完成的硬依赖。');
  for(const g of group.goals)if(g&&!group.items.some(x=>x?.goalIds?.includes(g.id))&&!group.stages.some(x=>x?.goalIds?.includes(g.id)))warn('plan.goals.'+g.id,'目标尚无阶段或事项覆盖。');
  return {valid:errors.length===0,errors,warnings};
}

export function projectPlanProjection(plan) {
  const byId=new Map(plan.items.map(x=>[x.id,x])),stages=new Map(plan.stages.map(x=>[x.id,x]));
  const activeCount=plan.items.filter(x=>['in_progress','review'].includes(x.state)).length;
  const readiness=plan.items.map(x=>{
    const reasons=[];
    if(!['backlog','ready'].includes(x.state))reasons.push('当前状态不可启动');
    if(x.commitment==='candidate')reasons.push('尚未纳入承诺');
    const pending=x.dependsOn.filter(id=>byId.get(id)?.state!=='completed');if(pending.length)reasons.push('等待依赖：'+pending.map(id=>byId.get(id)?.title??id).join('、'));
    if(x.blocker.trim())reasons.push('阻塞：'+x.blocker);
    if(x.stageId&&stages.get(x.stageId)?.state!=='active')reasons.push('所属阶段尚未开启或已结束');
    if(activeCount>=plan.wipLimit)reasons.push('在制容量已满');
    if(!x.nextAction.trim())reasons.push('缺少下一行动');
    return {id:x.id,ready:reasons.length===0,reasons};
  });
  const ready=readiness.filter(x=>x.ready).map(x=>x.id).sort((a,b)=>{const x=byId.get(a),y=byId.get(b);return (['high','normal','low'].indexOf(x.priority)-['high','normal','low'].indexOf(y.priority))||a.localeCompare(b);});
  return {activeCount,capacity:Math.max(0,plan.wipLimit-activeCount),overCapacity:activeCount>plan.wipLimit,readiness,ready,
    acceptanceGaps:plan.items.filter(x=>!['completed','cancelled'].includes(x.state)).map(x=>({id:x.id,pending:x.acceptance.filter(c=>c.result!=='passed').length,missing:x.acceptance.length===0})),
    counts:Object.fromEntries(states.map(s=>[s,plan.items.filter(x=>x.state===s).length]))};
}

function readState(root,name,scope) {
  validateName(name);if(!['current','archived'].includes(scope))fail('INVALID_ARGUMENTS','项目范围应为 current 或 archived。');
  const project=load(root,name,{scope}),readOnly=scope==='archived'||project.parsed.values.status==='archived',target=join(project.folder,FILE),directory=portable(relative(root,project.folder)),path=directory+'/'+FILE;
  if(!stat(target)){project.guard();return {project,target,directory,data:{state:'missing',readOnly,path,etag:'missing',revision:0,updatedAt:null,plan:emptyProjectPlan(),warnings:[],projection:projectPlanProjection(emptyProjectPlan())}};}
  if(stat(target)?.size>MAX)fail('PROJECT_PLAN_TOO_LARGE','项目管理文件超过 1 MB。');
  const snapshot=readSnapshot(target);if(snapshot.bytes.length>MAX)fail('PROJECT_PLAN_TOO_LARGE','项目管理文件超过 1 MB。');
  let value;try{value=JSON.parse(decodeUtf8(snapshot.bytes,target));}catch(error){if(error instanceof MetadataError)throw error;fail('PROJECT_PLAN_DAMAGED','项目管理 JSON 损坏；请保留原件并恢复。');}
  if(!object(value)||value.schemaVersion!==1)fail('PROJECT_PLAN_SCHEMA','不支持此项目管理格式，未修改原件。');
  if(Object.keys(value).some(k=>!['schemaVersion','revision','updatedAt','lastOperation','plan'].includes(k))||!Number.isSafeInteger(value.revision)||value.revision<1||!timestamp(value.updatedAt)||!object(value.lastOperation)||typeof value.lastOperation.id!=='string'||!/^[a-f0-9]{64}$/.test(value.lastOperation.digest??''))fail('PROJECT_PLAN_DAMAGED','项目管理信封损坏；请保留原件并恢复。');
  const checked=checkProjectPlan(value.plan,{root,directory,verifyReferences:false});
  if(!checked.valid)fail('PROJECT_PLAN_DAMAGED','项目管理内容未通过检查；未修改原件。',{issues:checked.errors});
  const warnings=[...checked.warnings];
  for(const x of value.plan.items){
    if(!x.source)continue;
    const source=localReference(root,x.source.path);
    if(!source)warnings.push({path:x.id,message:'来源已缺失或不可读取：'+x.source.path});
    else try{const current=readSnapshot(source);if(hash(current.bytes)!==x.source.digest)warnings.push({path:x.id,message:'来源已变化，请重读并复核：'+x.source.path});}
    catch{warnings.push({path:x.id,message:'来源读取失败，请核对原文。'});}
  }
  for(const row of [...value.plan.items.map(x=>({id:x.id,criteria:x.acceptance})),...value.plan.stages])
    for(const c of row.criteria??[])for(const ref of c.evidence)
      if(!validReference(root,ref))warnings.push({path:row.id,message:'验收证据入口已失效，请复核：'+ref});
  project.guard();return {project,target,snapshot,directory,value,data:{state:'present',readOnly,path,etag:hash(snapshot.bytes),revision:value.revision,updatedAt:value.updatedAt,plan:value.plan,warnings,projection:projectPlanProjection(value.plan)}};
}

export function projectManagement({root,name,scope='current',operation='read',data,dryRun=false}) {
  try {
    if(!['read','check','write'].includes(operation))fail('INVALID_ARGUMENTS','管理操作应为 read、check 或 write。');
    const run=()=>{
      const state=readState(root,name,scope);
      if(operation==='read'||operation==='check'&&data===undefined)return {data:{...state.data,...(operation==='check'?{valid:true}: {})},errors:[]};
      if(!object(data))fail('INVALID_ARGUMENTS','需要 JSON 字段集合。');
      if(operation==='check'){const plan=data.plan??data,result=checkProjectPlan(plan,{root,directory:state.directory});return {data:{...result,...(result.valid?{projection:projectPlanProjection(plan)}:{})},errors:result.errors};}
      if(state.data.readOnly)fail('PROJECT_PLAN_ARCHIVED','归档项目只读；恢复项目后再推进。');
      if(Object.keys(data).some(k=>!['plan','ifMatch','operationId'].includes(k))||typeof data.ifMatch!=='string'||typeof data.operationId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(data.operationId))fail('INVALID_ARGUMENTS','写入需要 plan、读取回执 ifMatch 和唯一 operationId（8 至 128 字符）。');
      const checked=checkProjectPlan(data.plan,{root,directory:state.directory});if(!checked.valid)return {data:checked,errors:checked.errors};
      const digest=hash(JSON.stringify(stable(data.plan)));
      if(state.value?.lastOperation.id===data.operationId){if(state.value.lastOperation.digest!==digest||hash(JSON.stringify(stable(state.value.plan)))!==digest)fail('PROJECT_PLAN_OPERATION_CONFLICT','同一操作 ID 已用于不同内容，或保存内容已在外部变化。');return {data:{...state.data,changed:false,replayed:true,dryRun},errors:[]};}
      if(data.ifMatch!==state.data.etag)fail('PROJECT_PLAN_CONFLICT','项目已被其他窗口修改。草稿保留，请读取最新版本后合并。',{etag:state.data.etag});
      const value={schemaVersion:1,revision:state.data.revision+1,updatedAt:new Date().toISOString(),lastOperation:{id:data.operationId,digest},plan:data.plan},bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
      if(bytes.length>MAX)fail('PROJECT_PLAN_TOO_LARGE','项目管理文件超过 1 MB。');
      if(dryRun)return {data:{...state.data,changed:true,dryRun:true,warnings:checked.warnings},errors:[]};
      state.project.guard();
      if(state.snapshot)publishFile(state.snapshot,bytes,{beforeCheck:()=>state.project.guard()});
      else {const temp=join(state.project.folder,`.ksf-project-plan-${randomUUID()}.tmp`);withTemporaryFile(temp,bytes,{permissions:0o644},()=>{state.project.guard();try{linkSync(temp,state.target);}catch(e){if(e.code==='EEXIST')fail('PROJECT_PLAN_CONFLICT','项目管理文件已创建，请重新读取。');throw e;}unlinkSync(temp);});}
      return {data:{...readState(root,name,scope).data,changed:true,dryRun:false},errors:[]};
    };
    return operation==='write'&&!dryRun?withProjectLock(root,run):run();
  } catch(error){return {data:null,errors:[errorItem(error)]};}
}
