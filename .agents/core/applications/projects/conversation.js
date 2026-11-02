import { randomId } from '@ksf/sdk/random-id';
const labels={queued:'等待创建',preparing:'准备会话',opening:'正在交给 Desktop',dispatching:'等待 Desktop 确认',accepted:'Desktop 已接收',succeeded:'已完成',unknown:'投递结果待核对',failed:'操作未完成',idle:'可继续聊天',running:'正在处理',question:'等待回答',approval:'请在 Desktop 处理审批'};
const final=op=>op&&['accepted','succeeded','failed','unknown'].includes(op.status);
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,action)=>{const n=el('button','kp-text-button',text);n.type='button';n.addEventListener('click',action);return n;};
function messageText(message){
  if(message.role!=='user')return message.text;
  let text=message.text.trim();
  if(text.startsWith('<send_user_message_question_reply>')&&text.endsWith('</send_user_message_question_reply>'))text=text.slice(34,-35).trim();
  try{
    const answers=JSON.parse(text);
    if(!Array.isArray(answers)||!answers.length||answers.length>20)return message.text;
    if(!answers.every(a=>typeof a.questionItemId==='string'&&typeof a.answer==='string'&&(()=>{try{return JSON.parse(a.questionItemId)[0]==='request_user_input_async';}catch{return false;}})()))return message.text;
    return answers.map(a=>`${a.question??'回答'}：${a.answer}`).join('\n\n');
  }catch{return message.text;}
}

export function createConversationPanel(sdk,renderMarkdown){
  const node=el('section','kp-conversation');node.setAttribute('aria-label','Codex Desktop 项目对话');
  let selected=null,selectedKey='',generation=0,alive=true,active=false,timer=null,threadId=null,snapshot=null,operation=null,draft='',issue='',availability=null,busy=false,polling=false,history=null,storagePrefix='',sending=null;
  const session=sdk.session??{get:()=>null,set:()=>{}},answerDrafts=new Map();
  const watching=()=>active&&document.visibilityState!=='hidden'&&(sdk.getSnapshot?.().active??true);
  const draftKey=()=>`codex-draft:${selectedKey}`;
  const call=(method,input={},target=selected)=>sdk.call('conversation.'+method,{...target,...input});
  function persistDraft(){if(!storagePrefix)return;try{const key=storagePrefix+draftKey();if(draft||sending)sessionStorage.setItem(key,JSON.stringify({text:draft,sending}));else sessionStorage.removeItem(key);}catch{issue='浏览器无法持久保留草稿，请在关闭页面前复制未发送内容。';}}
  function savedraft(value){draft=value;session.set(draftKey(),value);persistDraft();}
  function schedule(ms=2000){clearTimeout(timer);if(alive&&watching())timer=setTimeout(()=>void poll(),ms);}
  async function poll(){
    if(!alive||!watching()||!selected||polling)return;
    polling=true;const token=generation,target=selected;
    try{
      let nextOp=operation;
      if(operation&&!['accepted','succeeded','failed'].includes(operation.status))nextOp=await call('operation',{operationId:operation.operationId},target);
      if(!alive||token!==generation)return;
      if(nextOp){const changed=JSON.stringify(nextOp)!==JSON.stringify(operation);operation=nextOp;if(nextOp.threadId)threadId=nextOp.threadId;
        if(changed&&['accepted','succeeded'].includes(nextOp.status)&&sending?.operationId===nextOp.operationId){const original=sending.text;sending=null;if(draft===original)savedraft('');else persistDraft();}
        if(changed)render();
      }
      if(threadId&&(!operation||final(operation))){
        const result=await call('events',{threadId,afterVersion:snapshot?.version},target);
        if(!alive||token!==generation)return;
        if(result.changed){snapshot=result.snapshot;history=null;issue='';render();}
      }
      issue='';renderStatus();
    }catch(error){if(alive&&token===generation){issue=error.message;renderStatus();}}
    finally{polling=false;if(alive&&token===generation)schedule(snapshot?.status==='running'?1200:3000);else if(alive&&active)schedule(250);}
  }
  async function select(project){
    const key=`${project.scope}:${project.name}`;if(key===selectedKey)return;
    selected=project;selectedKey=key;const token=++generation;clearTimeout(timer);threadId=null;snapshot=null;operation=null;history=null;issue='';availability=null;draft=session.get(draftKey())??'';storagePrefix='';sending=null;busy=false;render();
    try{
      const initialDraft=draft,rootSession=await sdk.getSession?.();if(!alive||token!==generation)return;
      storagePrefix=`${sdk.appId}:codex-draft:${rootSession?.instanceId??location.origin}:${sdk.surfaceId??sdk.instanceId}:`;
      try{const saved=JSON.parse(sessionStorage.getItem(storagePrefix+draftKey())??'null');if(saved&&draft===initialDraft){draft=saved.text??draft;sending=saved.sending??null;session.set(draftKey(),draft);}}catch{}
      const [checked,resume]=await Promise.all([call('check'),call('resume')]);
      if(!alive||token!==generation)return;
      availability=checked;threadId=resume.threadId??null;
      // The browser may have lost a response before the backend saved its recent
      // selection. Reconcile the retained submission first, never a prior send.
      const pendingId=sending?.operationId??resume.operationId;
      if(pendingId)operation={operationId:pendingId,status:'queued'};
      render();schedule(50);
    }catch(error){if(alive&&token===generation){issue=error.message;render();}}
  }
  async function perform(action,input){
    if(busy)return;busy=true;issue='';const token=generation,target=selected;
    const operationId=randomId();session.set('codex-pending:'+selectedKey,operationId);
    if(action==='send'||action==='create'){sending={operationId,text:input.text};persistDraft();}
    operation={operationId,status:'queued'};render();
    try{const result=await call(action,{operationId,...input},target);if(!alive||token!==generation)return;operation=result;if(result.threadId)threadId=result.threadId;schedule(20);}
    catch(error){if(alive&&token===generation){issue=error.message;operation={...operation,status:['CODEX_ARGUMENT','CODEX_NOT_ATTACHED','CODEX_PLATFORM_UNSUPPORTED','CODEX_OPERATION_MISSING','APP_PERMISSION_REQUIRED'].includes(error.code)?'failed':'unknown'};schedule(500);}}
    finally{if(alive&&token===generation){busy=false;render();}}
  }
  async function attach(taskId){
    if(busy)return;busy=true;const token=generation;issue='';render();
    try{const result=await call('attach',{taskId});if(!alive||token!==generation)return;if(!result.attached)throw new Error(result.reason);threadId=result.threadId;operation=null;snapshot=null;history=null;schedule(10);}
    catch(error){if(alive&&token===generation)issue=error.message;}
    finally{if(alive&&token===generation){busy=false;render();}}
  }
  async function desktop(){try{await call('openDesktop',{threadId});schedule(1000);}catch(error){issue=error.message;renderStatus();}}
  function renderStatus(){
    const status=node.querySelector('[data-chat-status]');if(status)status.textContent=issue||operation&&!['accepted','succeeded'].includes(operation.status)?issue||labels[operation.status]:labels[snapshot?.status]??(availability?.available?'可新建 Desktop 对话':availability?.message??'正在检查 Desktop…');
    const error=node.querySelector('[data-chat-error]');if(error){error.textContent=operation?.error?.message??'';error.hidden=!error.textContent;}
    const send=node.querySelector('[data-chat-send]');if(send){send.disabled=busy||availability?.available!==true||operation&&!final(operation)||operation?.status==='unknown'||!!snapshot?.questions?.length||snapshot?.approvals;send.textContent=threadId?snapshot?.turnId?'补充本轮':'发送':'新建并发送';}
  }
  function render(){
    const focus=node.contains(document.activeElement)?document.activeElement?.dataset.chatFocus:null;
    const selection=focus==='draft'?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
    node.replaceChildren();
    const heading=el('header','kp-conversation-heading');heading.append(el('h2','',threadId?'继续项目对话':'发起项目对话'));
    if(threadId){heading.append(button('在 Desktop 打开',()=>void desktop()));const fresh=button('新建对话',()=>{threadId=null;snapshot=null;operation=null;history=null;render();});fresh.disabled=busy||operation&&!final(operation)||operation?.status==='unknown';heading.append(fresh);}
    node.append(heading);
    const status=el('p','kp-chat-status');status.dataset.chatStatus='';status.setAttribute('role','status');node.append(status);
    const error=el('p','kp-chat-error');error.dataset.chatError='';node.append(error);
    if(threadId&&!snapshot){node.append(el('p','kp-muted','正在读取原生聊天。若 Desktop 尚未持有此会话，可点击“在 Desktop 打开”。'));}
    if(snapshot){
      const route=snapshot.ksf?.route,owner=route?.ownership;
      node.append(el('p','kp-chat-route',owner?.state==='bound'?`KSF 归属：${owner.target.name??owner.target.path} · ${(route.abilities??[]).filter(a=>a.stage==='adopted'&&!a.fixed).map(a=>a.name).join('、')||'尚无已报告能力'}`:'等待 Agent 报告 KSF 归属；项目聊天统计以正式路由记录为准。'));
      if(snapshot.ksf?.hookState==='unconfirmed')node.append(el('p','kp-muted','尚未确认原生 KSF Hook 轮次；不会补造计数。'));
      const transcript=el('div','kp-chat-transcript');transcript.setAttribute('aria-label','原生对话消息');
      if(!history){const full=button('从头查看历史',async()=>{const token=generation;try{const result=await call('history',{threadId,offset:0,version:snapshot.version});if(alive&&token===generation){history=result;render();}}catch(error){issue=error.message;renderStatus();}});transcript.append(full);}
      for(const m of history?.records??snapshot.messages){const article=el('article',`kp-chat-message role-${m.role}`);article.append(el('strong','',m.role==='user'?'你':'Codex'),renderMarkdown(messageText(m)));if(m.truncated)article.append(el('p','kp-muted','此条内容较长，完整原文请在 Desktop 查看。'));transcript.append(article);}
      if(history?.nextOffset!==null&&history?.nextOffset!==undefined)transcript.append(button('继续加载历史',async()=>{const token=generation;try{const result=await call('history',{threadId,offset:history.nextOffset,version:history.version});if(alive&&token===generation){history={...result,records:[...history.records,...result.records]};render();}}catch(error){issue=error.message;renderStatus();}}));
      node.append(transcript);
      if(snapshot.approvals)node.append(el('p','kp-chat-prompt','命令、文件或权限审批请在 Desktop 处理。'));
      for(const pending of snapshot.questions??[]){
        const key=selectedKey+JSON.stringify(pending.request),form=el('form','kp-chat-question'),answers=answerDrafts.get(key)??{};answerDrafts.set(key,answers);form.append(el('h3','','Codex 需要你的回答'));
        for(const q of pending.questions){const label=el('label','kp-chat-question-field');label.append(el('span','',q.question));const value=el('input');value.type='text';value.value=answers[q.id]?.[0]??'';value.required=true;value.maxLength=8000;value.setAttribute('aria-label',q.question);value.addEventListener('input',()=>{answers[q.id]=[value.value];});
          const options=el('div','kp-chat-options');for(const option of q.options??[])options.append(button(option.label,()=>{value.value=option.label;answers[q.id]=[option.label];}));label.append(options,value);form.append(label);}
        const submit=el('button','kp-chat-submit','提交回答');submit.type='submit';submit.disabled=busy||operation&&!final(operation)||operation?.status==='unknown';form.append(submit);form.addEventListener('submit',e=>{e.preventDefault();void perform('answer',{threadId,version:snapshot.version,request:pending.request,answers});});node.append(form);
      }
      if(snapshot.plan){const plan=el('details','kp-chat-plan');plan.append(el('summary','','待执行计划'),renderMarkdown(snapshot.plan.text));const accept=button('执行此计划',()=>void perform('answer',{threadId,version:snapshot.version,planRevision:snapshot.plan.revision}));accept.disabled=busy||!!snapshot.turnId||operation&&!final(operation)||operation?.status==='unknown';plan.append(accept);node.append(plan);}
    }
    const form=el('form','kp-chat-composer'),textarea=el('textarea');textarea.rows=4;textarea.value=draft;textarea.placeholder=threadId?'继续这段对话…':'描述这次项目工作，可引用项目资料路径…';textarea.setAttribute('aria-label','项目对话输入');textarea.dataset.chatFocus='draft';textarea.addEventListener('input',()=>savedraft(textarea.value));
    const actions=el('div','kp-chat-actions'),send=el('button','kp-chat-submit');send.type='submit';send.dataset.chatSend='';actions.append(send);
    if(snapshot?.turnId){const stop=button('停止本轮',()=>void perform('interrupt',{threadId,expectedTurnId:snapshot.turnId}));stop.disabled=busy||operation&&!final(operation)||operation?.status==='unknown';actions.append(stop);}
    if(operation?.status==='unknown')actions.append(button('核对投递结果',()=>void poll()));
    form.append(textarea,actions);form.addEventListener('submit',e=>{e.preventDefault();if(send.disabled||!draft.trim())return;void perform(threadId?'send':'create',threadId?{threadId,text:draft,mode:snapshot?.turnId?'steer':'new',...(snapshot?.turnId?{expectedTurnId:snapshot.turnId}:{})}:{text:draft});});node.append(form);
    node.append(el('p','kp-footnote','Desktop 执行并保存原生对话。关闭此窗口不停止会话；投递结果不明时只核对，不自动重发。'));
    renderStatus();
    if(focus==='draft'){textarea.focus({preventScroll:true});if(selection)textarea.setSelectionRange(...selection);}
  }
  render();
  const changed=()=>schedule(10),unsubscribe=sdk.subscribe?.(changed);document.addEventListener('visibilitychange',changed);
  return {node,select,attach,prefill(text){savedraft(draft?draft+'\n\n'+text:text);render();node.querySelector('textarea')?.focus();},setActive(value){active=value;if(value)schedule(10);else clearTimeout(timer);},dispose(){alive=false;generation++;clearTimeout(timer);unsubscribe?.();document.removeEventListener('visibilitychange',changed);node.remove();}};
}
