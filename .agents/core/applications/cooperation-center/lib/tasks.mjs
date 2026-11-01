import {randomUUID} from 'node:crypto';
import {check,hash,id,nodeId} from './store.mjs';
import {fieldValues} from '../../sdk/server/workflow-contract.mjs';
import {manualOffer,checkedOffer} from './offers.mjs';
export const statuses=['pending','accepted','in_progress','waiting','ready_to_submit','completed','declined','cancelled'];
export const terminal=task=>['completed','declined','cancelled'].includes(task.status);
const text=(value,max=65536)=>typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=max;
export const contentDigest=t=>hash({goal:t.goal,materials:t.materials,contentVersion:t.contentVersion,...(t.offerInputs?{offerInputs:t.offerInputs}:{})});
const shared=t=>({id:t.id,status:t.status,paused:t.paused,progress:t.progress,waitReason:t.waitReason,nextActor:t.nextActor,deliveries:t.deliveries,plan:t.plan??null,contentVersion:t.contentVersion,publicSummary:t.publicSummary??'',terminationRequested:t.terminationRequested??false,offer:t.offer??null,offerBasis:t.offerBasis??'旧版请求：等待 B 处理'});
export function createTasks(store,{rules=()=>null,outgoingOffer,match=()=>({offer:manualOffer(),rule:null,basis:'手动处理：等待 B 判断和处理'})}={}){
  const {db}=store;
  function enqueueCallback(t){if(t.requester!==store.owner||!t.workflowOrigin||!terminal(t))return;const delivery=t.deliveries.at(-1),eventId=hash({taskId:t.id,outcome:t.status,delivery:delivery?.digest??null}),body={eventId,origin:t.workflowOrigin,taskId:t.id,sourcePeerId:t.assignee,outcome:t.status,...(delivery?{delivery}:{})};db.prepare("INSERT OR IGNORE INTO callbacks(id,taskId,state,body) VALUES (?,?,'queued',?)").run(eventId,t.id,JSON.stringify(body));}
  function sendState(t){store.event(t.requester,'task.state',shared(t));}
  function own(t){check(t.assignee===store.owner,'只有承接实例可以执行此操作。','COOP_NOT_ASSIGNEE');}
  function version(t,input){check(input.revision===t.revision,'任务已经变化，请重新读取。','COOP_REVISION_CONFLICT');}
  function materialList(list){check(Array.isArray(list)&&list.length<=64&&list.every(m=>/^[a-f0-9]{64}$/.test(m.digest)&&text(m.name,256)&&Number.isSafeInteger(m.size)&&m.size>=0),'材料列表无效。');for(const m of list)check(db.prepare('SELECT 1 FROM artifacts WHERE digest=?').get(m.digest),'材料尚未导入。','COOP_MATERIAL_MISSING');return list.map(({digest,name,size,mediaType})=>({digest,name,size,mediaType:mediaType??'application/octet-stream'}));}
  function create(input,caller){
    check(nodeId(input.peerId)&&input.peerId!==store.owner,'请选择另一个已配对的合作实例。');check(text(input.goal),'请填写任务目标（最多 64 KiB）。');
    if(input.parentId)store.task(input.parentId);if(input.relatedId){const previous=store.task(input.relatedId);check([previous.requester,previous.assignee].includes(input.peerId),'关联请求只能发送给原合作实例。');}
    const offerId=input.offerId??'manual',offerRevision=input.offerRevision??(offerId==='manual'?1:0);
    check(typeof offerId==='string'&&/^[a-zA-Z0-9-]{1,96}$/.test(offerId)&&Number.isSafeInteger(offerRevision)&&offerRevision>0,'请选择有效的承接声明版本。');
    const offer=outgoingOffer?outgoingOffer(input):(input.offer?checkedOffer(input.offer):(offerId==='manual'?manualOffer():null));
    check(!offer||offer.offerId===offerId&&offer.revision===offerRevision,'声明快照与编号或版本不符。');
    const offerInputs=fieldValues(offer?.inputFields??[],input.offerInputs??{});for(const field of offer?.inputFields??[])if(field.type==='materials'&&offerInputs[field.key])offerInputs[field.key]=materialList(offerInputs[field.key]);
    check(!input.workflowOrigin||caller?.source==='workflow'&&caller.requesterAppId===input.workflowOrigin.appId,'流程关联只能由宿主设置。','COOP_WORKFLOW_FORBIDDEN');
    const task={offerId,offerRevision,offer,requestedOffer:offer,...(Object.keys(offerInputs).length?{offerInputs}:{}),...(input.workflowOrigin?{workflowOrigin:input.workflowOrigin}:{}),offerBasis:'等待承接实例核对声明',id:input.taskId??randomUUID(),requester:store.owner,assignee:input.peerId,goal:input.goal.trim(),materials:materialList(input.materials??[]),contentVersion:1,status:'pending',paused:false,progress:'',nextActor:'B',waitReason:'等待承接实例处理',createdAt:new Date().toISOString(),revision:0,comments:[],deliveries:[],archived:false,origin:caller?.source==='surface'?'window':'cli',parentId:input.parentId??null,relatedId:input.relatedId??null,lastSyncAt:null};
    check(id(task.id)&&!db.prepare('SELECT 1 FROM tasks WHERE id=?').get(task.id),'任务编号已存在或无效。');
    store.save(task);const {parentId,archived,revision,workflowOrigin,...request}=task;store.event(task.assignee,'task.request',request);return task;
  }
  function mutate(method,input,caller){
    return store.operation(input.operationId,{method,...input},()=>{
      if(method==='task.create'||method==='task.rework')return create(input,caller);
      const t=store.task(input.taskId);version(t,input);
      if(method==='task.comment'){
        check(text(input.text,16384),'请填写评论（最多 16 KiB）。');const comment={id:randomUUID(),from:store.owner,text:input.text,at:new Date().toISOString(),origin:caller?.source==='surface'?'window':'cli'};t.comments.push(comment);store.event(t.assignee===store.owner?t.requester:t.assignee,'task.comment',{taskId:t.id,comment});
      }else if(method==='task.material'){
        check(t.requester===store.owner&&!terminal(t),'仅发起方可以在未结束的任务中更新目标和材料。');t.materials=materialList(input.materials);if(input.goal!==undefined){check(text(input.goal),'目标无效。');t.goal=input.goal;}if(input.offerInputs!==undefined)t.offerInputs=fieldValues(t.offer?.inputFields??[],input.offerInputs);t.contentVersion++;t.plan=null;t.waitReason='材料已变化，等待 B 重新处理';store.event(t.assignee,'task.content',{taskId:t.id,goal:t.goal,materials:t.materials,contentVersion:t.contentVersion,...(t.offerInputs?{offerInputs:t.offerInputs}:{})});
      }else if(method==='task.result'){
        check(['completed','waiting'].includes(input.status),'成果回执状态无效。');
        own(t);check(!terminal(t)&&!t.paused,'任务已结束或暂停。');const row=db.prepare('SELECT body FROM runs WHERE id=? AND taskId=?').get(input.runId,t.id),run=row&&JSON.parse(row.body),current=rules(t);
        check(run?.kind==='desktop'&&['running','unknown','submitting'].includes(run.state)&&run.resultTokenHash===hash(input.executionToken??'')&&run.contentDigest===contentDigest(t)&&current?.revision===run.ruleRevision&&current.published,'执行回执、内容或授权已失效。','COOP_RESULT_STALE');
        if(input.status==='waiting'){t.status='waiting';t.waitReason=String(input.reason??'Agent 需要协助').slice(0,2000);t.nextActor='B';run.state='waiting';}
        else if(run.phase==='plan'){check(text(input.summary),'方案内容无效。');t.plan={version:1,text:input.summary,contentDigest:contentDigest(t),ruleRevision:run.ruleRevision,approved:false};t.plan.digest=hash(t.plan);t.status='waiting';t.waitReason='方案已生成，等待 B 确认';t.nextActor='B';run.state='succeeded';}
        else{check(text(input.summary),'成果说明无效。');t.draft={summary:input.summary,materials:materialList(input.materials??[]),contentDigest:contentDigest(t)};t.status='ready_to_submit';t.waitReason=current.delivery==='confirm'?'等待 B 确认提交成果':'';t.nextActor=current.delivery==='confirm'?'B':'Agent';run.state='succeeded';}
        db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run),run.id);sendState(t);
      }else if(method==='task.deliver'){
        own(t);check(!terminal(t)&&!t.paused,'当前任务不能提交。');check(text(input.summary),'请填写成果说明。');const rule=t.automation,current=rules(t),currentRule=!rule||!current||current.id!==rule.id||current.revision!==rule.revision?rules({offerId:'manual'}):current;
        check(rule?.delivery!=='confirm'&&currentRule?.delivery!=='confirm'||caller?.source==='surface'&&caller?.kind==='window'&&input.confirmDigest===hash({summary:input.summary,materials:input.materials??[],content:contentDigest(t)}),'成果需要 B 在窗口确认具体版本。','COOP_HUMAN_REQUIRED');
        const delivery={id:randomUUID(),version:t.deliveries.length+1,summary:input.summary,materials:materialList(input.materials??[]),contentDigest:contentDigest(t),at:new Date().toISOString()};delivery.digest=hash(delivery);t.deliveries.push(delivery);t.status='completed';t.progress='成果已提交';t.waitReason='';t.nextActor=null;sendState(t);
      }else if(method==='task.action'){
        const action=input.action;
        if(action==='archive'){check(terminal(t),'任务结束后才能归档。');t.archived=input.archived!==false;return store.save(t);}
        check(!terminal(t),'任务已结束；后续工作请创建关联请求。');
        if(action==='cancel'&&t.requester===store.owner&&t.assignee!==store.owner){
          t.terminationRequested=true;t.waitReason='已请求终止，等待 B 决定';store.event(t.assignee,'task.terminate',{taskId:t.id});
        }else{
          own(t);
          if(['accept','start','wait','decline','cancel','ready'].includes(action))t.status={accept:'accepted',start:'in_progress',wait:'waiting',decline:'declined',cancel:'cancelled',ready:'ready_to_submit'}[action];
          else if(action==='pause')t.paused=true;
          else if(action==='resume'){t.paused=false;t.nextActor='B';t.waitReason='已恢复；可继续人工处理或重新安排 Agent，原运行回执保留。';}
          else if(action==='approve_plan'){
            check(caller?.source==='surface'&&caller?.kind==='window','方案需要 B 在窗口确认。','COOP_HUMAN_REQUIRED');check(t.plan&&input.confirmDigest===t.plan.digest&&t.plan.contentDigest===contentDigest(t),'方案或材料已变化。','COOP_APPROVAL_STALE');t.plan.approved=true;t.plan.approvedAt=new Date().toISOString();t.status='accepted';
          }else if(action==='publish_summary'){check(typeof input.summary==='string'&&input.summary.length<=4000,'公开摘要过长。');t.publicSummary=input.summary;}else if(action==='retry_agent'){check(caller?.source==='surface'&&caller?.kind==='window','重新安排执行需要 B 在窗口确认。','COOP_HUMAN_REQUIRED');check(!db.prepare('SELECT 1 FROM runs WHERE taskId=? AND json_extract(body,\'$.state\') IN (\'running\',\'unknown\',\'submitting\')').get(t.id),'原执行尚未对账。','COOP_RUN_UNKNOWN');const rule=rules({offerId:input.offerId??t.offerId});check(rule&&rule.handling!=='manual'&&rule.published,'请选择本实例已发布的 Agent 承接声明。');check(input.offerRevision===rule.revision,'声明已变化，请重新核对。','COOP_APPROVAL_STALE');t.manualRunNonce=randomUUID();t.status='accepted';t.offerId=rule.offerId;t.offerRevision=rule.revision;t.offer=checkedOffer(rule);t.offerBasis='B 在窗口重新安排声明处理';t.plan=null;t.draft=null;t.automation=structuredClone(rule);}
          else check(false,'未知任务动作。');
          if(input.progress!==undefined){check(typeof input.progress==='string'&&input.progress.length<=4000,'进展过长。');t.progress=input.progress;}
          t.waitReason=t.status==='waiting'?String(input.reason??'等待 B 处理').slice(0,2000):'';t.nextActor=terminal(t)?null:t.status==='ready_to_submit'?'B':t.status==='waiting'?'B':'B/Agent';sendState(t);
        }
      }else check(false,'未知写操作。');
      return store.save(t);
    });
  }
  function receive(peer,event){
    check(event?.protocol==='ksf-cooperation-v1'&&id(event.id)&&id(event.stream)&&Number.isSafeInteger(event.seq)&&event.seq>0,'合作事件格式无效。');
    const prior=db.prepare('SELECT body FROM events WHERE id=?').get(event.id);if(prior){check(hash(JSON.parse(prior.body))===hash(event),'事件编号冲突。','COOP_EVENT_CONFLICT');return {duplicate:true};}
    const stream=store.get('receive-stream:'+peer);check(!stream||stream===event.stream,'对方事件序列发生变化，请核对实例恢复记录。','COOP_STREAM_CHANGED');
    return store.tx(()=>{
      store.put('receive-stream:'+peer,event.stream);
      if(event.kind==='task.request')store.put('arrival-rule:'+event.id,match(event.payload));
      db.prepare('INSERT INTO events VALUES (?,?,?,?,0,?)').run(event.id,peer,event.seq,'in',JSON.stringify(event));
      let cursor=store.get('receive:'+peer)??0;
      while(true){const row=db.prepare("SELECT * FROM events WHERE peer=? AND direction='in' AND seq=?").get(peer,cursor+1);if(!row)break;apply(peer,JSON.parse(row.body));cursor++;db.prepare('UPDATE events SET applied=1 WHERE id=?').run(row.id);}
      store.put('receive:'+peer,cursor);return {through:cursor,gap:cursor<event.seq};
    });
  }
  function apply(peer,event){
    const p=event.payload;
    if(event.kind==='task.request'){
      check(id(p.id)&&p.requester===peer&&p.assignee===store.owner&&text(p.goal)&&p.contentVersion===1,'请求身份或内容无效。');check(!db.prepare('SELECT 1 FROM tasks WHERE id=?').get(p.id),'任务编号冲突。');
      if(p.relatedId){const previous=store.task(p.relatedId);check([previous.requester,previous.assignee].includes(peer),'关联任务不属于此合作实例。');}
      const selected=store.get('arrival-rule:'+event.id);const t={offerId:p.offerId??'manual',offerRevision:p.offerRevision??1,offer:selected?.offer??null,requestedOffer:selected?.offer??null,offerBasis:selected?.basis??'旧版请求：等待 B 处理',id:p.id,requester:peer,assignee:store.owner,goal:p.goal,materials:materialList(p.materials??[]),...(p.offerInputs?{offerInputs:fieldValues((selected?.offer??p.offer)?.inputFields??[],p.offerInputs)}:{}),contentVersion:1,origin:p.origin==='window'?'window':'cli',status:'pending',paused:false,progress:'',nextActor:'B',waitReason:'等待 B 处理',createdAt:p.createdAt,comments:[],deliveries:[],relatedId:p.relatedId??null,archived:false,revision:0,lastSyncAt:new Date().toISOString(),automation:selected?.rule?structuredClone(selected.rule):null};t.waitReason=selected?.rule&&selected.rule.handling!=='manual'?'等待 Agent 按声明处理':t.offerBasis;store.save(t);sendState(t);return;
    }
    const t=store.task(p.taskId??p.id);check([t.requester,t.assignee].includes(peer),'事件不属于此合作方。');
    if(event.kind==='task.state'){
      check(peer===t.assignee&&t.requester===store.owner&&statuses.includes(p.status),'仅承接方可以同步处理状态。');
      check(!terminal(t)||p.status===t.status,'结束状态不可重写。');
      for(const key of ['status','paused','progress','waitReason','nextActor','plan','publicSummary','terminationRequested','offerBasis'])if(Object.hasOwn(p,key))t[key]=p[key];
      if(p.offer)t.offer=checkedOffer(p.offer);
      check(Array.isArray(p.deliveries)&&p.deliveries.length>=t.deliveries.length,'成果版本不能回退。');
      for(let i=0;i<t.deliveries.length;i++)check(hash(t.deliveries[i])===hash(p.deliveries[i]),'已交付成果不能改写。');
      for(const d of p.deliveries){check(text(d.summary)&&/^[a-f0-9]{64}$/.test(d.digest),'成果格式无效。');materialList(d.materials??[]);const {digest,...body}=d;check(hash(body)===digest,'成果摘要无效。');}
      check(p.status!=='completed'||p.deliveries.length>0,'已完成任务必须有成果。');t.deliveries=p.deliveries;
    }else if(event.kind==='task.comment'){
      check(p.comment?.from===peer&&id(p.comment.id)&&text(p.comment.text,16384),'评论无效。');if(!t.comments.some(c=>c.id===p.comment.id))t.comments.push(p.comment);
    }else if(event.kind==='task.content'){
      check(peer===t.requester&&t.assignee===store.owner&&p.contentVersion===t.contentVersion+1&&text(p.goal),'材料版本无效。');if(terminal(t)){t.comments.push({id:event.id,from:peer,text:'收到内容变更时本任务已结束，请创建关联请求。',at:new Date().toISOString()});sendState(t);store.save(t);return;}t.goal=p.goal;t.materials=materialList(p.materials);if(p.offerInputs!==undefined)t.offerInputs=fieldValues(t.offer?.inputFields??[],p.offerInputs);t.contentVersion=p.contentVersion;t.plan=null;t.automation=null;t.status='waiting';t.waitReason='目标或材料变化，等待 B 重新确认执行范围';t.nextActor='B';sendState(t);
    }else if(event.kind==='task.terminate'){
      check(peer===t.requester&&t.assignee===store.owner,'终止请求身份无效。');if(!terminal(t)){t.terminationRequested=true;t.waitReason='A 请求终止，等待 B 决定';t.nextActor='B';sendState(t);}
    }else check(false,'不支持的合作事件。');
    t.lastSyncAt=new Date().toISOString();store.save(t);enqueueCallback(t);
  }
  function list(input={}){
    const limit=Math.min(100,Math.max(1,Number(input.limit)||30)),offset=Math.max(0,Number(input.offset)||0);check(Number.isSafeInteger(offset),'分页位置无效。');
    const clauses=[],params=[];
    const field=name=>"json_extract(body,'$."+name+"')";
    if(!input.archived)clauses.push(field('archived')+'=0');
    if(input.peerId){clauses.push('('+field('requester')+'=? OR '+field('assignee')+'=?)');params.push(input.peerId,input.peerId);}
    if(input.status){clauses.push(field('status')+'=?');params.push(input.status);}
    if(input.query){check(typeof input.query==='string'&&input.query.length<=512,'检索内容过长。');clauses.push('id IN (SELECT id FROM tasks_search WHERE text LIKE ?)');params.push('%'+input.query.toLocaleLowerCase().replaceAll('%','').replaceAll('_','')+'%');}
    const ended=field('status')+" IN ('completed','declined','cancelled')";
    // An unconfigured instance may read history, but cannot claim owned tasks.
    if(['attention','accepted'].includes(input.view)){clauses.push(field('assignee')+'=?','NOT ('+ended+')');params.push(store.owner??null);}
    if(input.view==='attention')clauses.push('('+field('nextActor')+"='B' OR "+field('paused')+'=1 OR '+field('terminationRequested')+'=1)');
    if(input.view==='sent'){clauses.push(field('requester')+'=?','NOT ('+ended+')');params.push(store.owner??null);}
    if(input.view==='history')clauses.push(ended);
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
    return {tasks:db.prepare('SELECT body FROM tasks'+where+' ORDER BY updated DESC,id LIMIT ? OFFSET ?').all(...params,limit,offset).map(r=>JSON.parse(r.body)),total:db.prepare('SELECT count(*) n FROM tasks'+where).get(...params).n,offset,limit};
  }
  return {mutate,receive,list,shared,sendState,enqueueCallback};
}
