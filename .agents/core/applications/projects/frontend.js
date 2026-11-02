import './projects.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createConversationPanel } from './conversation.js';
import { createProjectManagement } from './management.js';

const names={in_progress:'进行中',blocked:'受阻',paused:'已暂停',completed:'已完成',cancelled:'已取消',unknown:'未标注',active:'活跃',archived:'已归档'};
const icons={folder:'M3 7h6l2-3h9v16H3Z',search:'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',arrow:'M7 17 17 7M7 7h10v10',file:'M14 2H5v20h14V7ZM14 2v6h5M8 13h8M8 17h8',check:'m5 12 4 4L19 6',chat:'M3 3h18v14H8l-5 4Z',refresh:'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 7M4 12l2 7a8 8 0 0 0 13-3',back:'m14 5-7 7 7 7',link:'m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M14 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0'};
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');const p=document.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',icons[name]??icons.file);svg.append(p);return svg;}
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function btn(text,fn,cls=''){const n=el('button',cls,text);n.type='button';n.addEventListener('click',fn);return n;}
function badge(state){return el('span',`kp-badge state-${state}`,names[state]??state??'未标注');}
function date(value,full=false){if(!value)return '未记录时间';const d=new Date(value);if(Number.isNaN(d.getTime()))return value;return new Intl.DateTimeFormat('zh-CN',full?{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}:{year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
function deep(app,params={}){return '/?'+new URLSearchParams({app,...params});}
function link(text,href,cls=''){const a=el('a',cls,text);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;}
function docLink(text,path){return link(text,deep('markdown',{path,mode:'read'}),'kp-source-link');}
const textFile=path=>/\.(?:md|txt|json|ya?ml|js|mjs|ts|tsx|css|html|csv)$/i.test(path??'');
const imageFile=path=>/\.(?:png|jpe?g|gif|webp)$/i.test(path??'');
function resourceURL(ref){if(ref.url)return ref.url;if(/^\.agents\/(runtime-data|user-data)\//i.test(ref.path??''))return null;if(ref.path?.startsWith('知识/'))return deep('com.ksf.knowledge',{path:ref.path});if(ref.path?.startsWith('能力/')||ref.path?.startsWith('.agents/core/abilities/'))return deep('com.ksf.abilities',{path:ref.path});if(textFile(ref.path))return deep('markdown',{path:ref.path,mode:'read'});if(imageFile(ref.path))return '/api/workspace/media?'+new URLSearchParams({path:ref.path});return null;}
function markdown(body,refs=[]){
  const node=el('div','kp-markdown');
  node.innerHTML=DOMPurify.sanitize(marked.parse(body??'',{gfm:true,breaks:false}),{USE_PROFILES:{html:true},FORBID_TAGS:['img','style','input','form','iframe','object','video','audio'],FORBID_ATTR:['style','id','name']});
  for(const a of node.querySelectorAll('a')){const href=a.getAttribute('href')??'',ref=refs.find(r=>r.href===href);const target=/^https?:\/\//i.test(href)?href:ref?resourceURL(ref):null;if(target){a.href=target;a.target='_blank';a.rel='noopener noreferrer';}else{a.removeAttribute('href');a.title='请从项目的资料入口定位原件';}}
  return node;
}

export async function mount(container,sdk){
  container.classList.add('kp-projects-host');
  let alive=true,list=[],selected='',tab='overview',scope='current',query='',detail=null,taskQuery='',taskState='all',chatData=null,chatRecords=[],taskFile=null,openedTask=null;
  let request=0,fileRequest=0,listRequest=0,chatRequest=0,error='',listError='',notice='',loading=false,listLoading=true,chatLoading=false,fileLoading=false;
  const root=el('div','ksf-projects');container.append(root);
  const conversation=createConversationPanel(sdk,markdown);
  const management=createProjectManagement({sdk,docLink,onChange:()=>{},onPrepare:text=>{setTab('chats');void conversation.select(params()).then(()=>conversation.prefill(text));}});
  const sidebar=el('aside','kp-sidebar'),main=el('main','kp-main');sidebar.setAttribute('aria-label','项目目录');root.append(sidebar,main);
  const brand=el('div','kp-brand');brand.append(icon('folder'),el('strong','','项目'));sidebar.append(brand);
  const searchLabel=el('label','kp-search');searchLabel.append(icon('search'));const search=el('input');search.type='search';search.placeholder='搜索项目';search.setAttribute('aria-label','搜索项目');searchLabel.append(search);sidebar.append(searchLabel);
  const scopeRow=el('div','kp-scope');const projectList=el('nav','kp-project-list');projectList.setAttribute('aria-label','项目列表');sidebar.append(scopeRow,projectList);
  const sideFoot=el('div','kp-side-footer');const refresh=btn('刷新',()=>reload(),'kp-refresh');refresh.prepend(icon('refresh'));const count=el('span');sideFoot.append(count,refresh);sidebar.append(sideFoot);
  const domains=el('nav','kp-domain-nav');domains.setAttribute('aria-label','四个核心应用');for(const[id,name]of [['com.ksf.projects','项目'],['com.ksf.abilities','能力'],['com.ksf.knowledge','知识'],['com.ksf.conversations','飞轮']])domains.append(btn(name,()=>sdk.openApp(id),'kp-text-button'));sidebar.append(domains);
  const header=el('header','kp-heading'),tabs=el('div','kp-tabs'),message=el('div','kp-message'),content=el('div','kp-content');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','项目内容');message.setAttribute('role','status');content.setAttribute('role','tabpanel');content.id=`kp-panel-${sdk.instanceId}`;content.tabIndex=0;main.append(header,tabs,message,content);
  const tabButtons=[];
  for(const [id,title]of [['overview','总览'],['plan','目标与阶段'],['work','工作事项'],['governance','风险与决定'],['tasks','原始检查点'],['resources','资料'],['chats','项目对话']]){
    const b=btn(title,()=>setTab(id));b.setAttribute('role','tab');b.id=`kp-tab-${sdk.instanceId}-${id}`;b.setAttribute('aria-controls',content.id);tabs.append(b);tabButtons.push([id,b]);
    b.addEventListener('keydown',e=>{const at=tabButtons.findIndex(([key])=>key===id);const next=e.key==='ArrowRight'?(at+1)%tabButtons.length:e.key==='ArrowLeft'?(at+tabButtons.length-1)%tabButtons.length:e.key==='Home'?0:e.key==='End'?tabButtons.length-1:-1;if(next>=0){e.preventDefault();setTab(tabButtons[next][0]);tabButtons[next][1].focus();}});
  }
  function params(){const p=list.find(x=>`${x.scope}:${x.name}`===selected);return p?{name:p.name,scope:p.scope}:null;}
  function showMessage(){message.textContent=error||notice||listError;message.classList.toggle('is-error',!!(error||listError));message.hidden=!message.textContent;}
  function save(){if(!selected)return;void sdk.call('preferences.save',{selected,tab}).catch(e=>{if(alive){notice='显示设置未保存：'+e.message;showMessage();}});}
  function renderScope(){scopeRow.replaceChildren();for(const[id,title]of[['current','当前'],['archived','已归档'],['all','全部']]){const b=btn(title,()=>{scope=id;renderScope();renderList();});b.setAttribute('aria-pressed',String(scope===id));scopeRow.append(b);}}
  function renderList(ensureSelected=false){
    projectList.replaceChildren();const entries=list.filter(p=>(scope==='all'||p.scope===scope)&&`${p.title} ${p.name} ${p.description??''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));count.textContent=`${entries.length} 个项目`;
    for(const p of entries){const key=`${p.scope}:${p.name}`,b=btn('',()=>choose(key),'kp-project-item');b.setAttribute('aria-current',key===selected?'true':'false');b.setAttribute('aria-label',p.title+(p.scope==='archived'?'（已归档）':''));const row=el('span','kp-project-title');row.append(el('strong','',p.title),el('i',p.scope==='archived'?'is-archived':''));b.append(row,el('span','kp-project-description',p.description||p.name));projectList.append(b);}
    if(ensureSelected)projectList.querySelector('[aria-current=true]')?.scrollIntoView({block:'nearest'});
    if(!entries.length)projectList.append(el('p','kp-empty-small',listLoading&&!list.length?'正在读取项目…':query?'没有匹配的项目':scope==='archived'?'还没有归档项目':'没有可读取的项目记录'));
  }
  search.addEventListener('input',()=>{query=search.value;renderList();});
  async function reload(){
    const token=++listRequest;listLoading=true;refresh.disabled=true;listError='';renderList();showMessage();
    try{const result=await sdk.call('list');if(!alive||token!==listRequest)return;listLoading=false;list=result.projects.sort((a,b)=>a.scope.localeCompare(b.scope)||a.title.localeCompare(b.title,'zh-CN'));listError=result.warnings?.join('；')??'';renderList();const target=list.some(p=>`${p.scope}:${p.name}`===selected)?selected:list.find(p=>p.scope==='current')?`current:${list.find(p=>p.scope==='current').name}`:list[0]?`${list[0].scope}:${list[0].name}`:'';if(target)await choose(target,false);else{selected='';detail=null;render();}}
    catch(e){if(alive&&token===listRequest){listLoading=false;listError='项目目录读取失败：'+e.message;renderList();showMessage();if(!list.length){content.replaceChildren(el('p','kp-empty','无法读取项目。请点击左下角刷新重试。'));}}}
    finally{if(alive&&token===listRequest){refresh.disabled=false;showMessage();}}
  }
  async function choose(key,persist=true){
    selected=key;const token=++request;chatRequest++;fileRequest++;detail=null;taskFile=null;openedTask=null;chatData=null;chatRecords=[];taskQuery='';taskState='all';loading=true;error='';notice='';renderList(true);render();if(persist)save();
    try{const result=await sdk.call('detail',params());if(!alive||token!==request)return;detail=result;await management.select(params());if(!alive||token!==request)return;sdk.setTitle('KSF项目',result.title);}
    catch(e){if(alive&&token===request)error='项目读取失败：'+e.message;}
    finally{if(alive&&token===request){loading=false;render();if(tab==='chats')void loadChats();}}
  }
  function setTab(value){tab=value;error='';taskFile=null;openedTask=null;fileRequest++;render();content.scrollTop=0;save();if(tab==='chats'&&!chatData)void loadChats();}
  function render(){
    conversation.setActive(tab==='chats'&&!!detail);
    header.replaceChildren();const p=params();if(p){const title=el('div','kp-title-block');title.append(el('p','kp-eyebrow',p.scope==='archived'?'归档项目':'当前项目'),el('h1','',detail?.title??list.find(x=>x.name===p.name&&x.scope===p.scope)?.title??p.name));header.append(title);if(detail){const right=el('div','kp-heading-meta');right.append(badge(detail.scope==='archived'?'archived':detail.status||'unknown'),docLink('打开项目原文 ↗',detail.path));header.append(right);}}
    for(const[id,b]of tabButtons){b.setAttribute('aria-selected',String(tab===id));b.tabIndex=tab===id?0:-1;}content.setAttribute('aria-labelledby',tabButtons.find(([id])=>id===tab)[1].id);showMessage();content.replaceChildren();
    if(loading){content.append(el('p','kp-empty','正在读取项目记录…'));return;}if(!detail){const blank=el('div','kp-welcome');blank.append(icon('folder'),el('h2','','选择一个项目'),el('p','','从目标、任务和原始记录接上工作。'));content.append(blank);return;}
    if(detail.warnings?.length){const w=el('details','kp-warning');w.append(el('summary','',`${detail.warnings.length} 条记录未完整读取`),el('p','',detail.warnings.join('\n')));content.append(w);}
    if(['overview','plan','work','governance'].includes(tab))content.append(management.render(tab,detail));if(tab==='tasks')renderTasks();if(tab==='chats')renderChats();if(tab==='resources')renderResources();
  }
  function section(title,description){const s=el('section','kp-section'),h=el('header','kp-section-header');h.append(el('h2','',title));if(description)h.append(el('span','',description));s.append(h);return s;}
  function taskRow(t){const b=btn('',()=>{tab='tasks';void openTask(t);render();save();},'kp-task-row');b.append(badge(t.state),el('strong','',t.name),el('time','',t.updated?date(t.updated):'未记录时间'));return b;}
  function renderTasks(){
    if(openedTask){renderTaskFile();return;}
    const top=el('div','kp-filterbar');const input=el('input');input.type='search';input.placeholder='搜索任务名称';input.setAttribute('aria-label','搜索任务');input.value=taskQuery;input.addEventListener('input',()=>{taskQuery=input.value;renderTaskList(holder);});const select=el('select');select.setAttribute('aria-label','任务状态');for(const[value,label]of[['all','全部状态'],['in_progress','进行中'],['blocked','受阻'],['paused','已暂停'],['completed','已完成'],['cancelled','已取消'],['unknown','未标注']]){const o=el('option','',label);o.value=value;select.append(o);}select.value=taskState;select.addEventListener('change',()=>{taskState=select.value;renderTaskList(holder);});top.append(input,select);const holder=el('div','kp-task-list');content.append(top,holder);renderTaskList(holder);
  }
  function renderTaskList(holder){holder.replaceChildren();const tasks=detail.tasks.filter(t=>(taskState==='all'||t.state===taskState)&&t.name.toLocaleLowerCase().includes(taskQuery.toLocaleLowerCase()));holder.append(el('p','kp-list-count',`${tasks.length} 份任务记录`));for(const t of tasks){const b=taskRow(t);if(t.schema!=='checkpoint')b.append(el('small','',t.schema==='unsupported'?'未知检查点格式':'普通任务文档'));holder.append(b);}if(!tasks.length)holder.append(el('p','kp-empty','没有符合条件的任务记录。'));}
  async function openTask(t){openedTask=t;taskFile=null;fileLoading=true;const token=++fileRequest;render();try{const result=await sdk.call('file',{...params(),path:t.path});if(alive&&token===fileRequest)taskFile=result;}catch(e){if(alive&&token===fileRequest)error='任务原文读取失败：'+e.message;}finally{if(alive&&token===fileRequest){fileLoading=false;render();content.querySelector('h2')?.focus();}}}
  function renderTaskFile(){const t=openedTask;const bar=el('div','kp-filebar');bar.append(btn('返回任务',()=>{openedTask=null;taskFile=null;fileRequest++;render();},'kp-text-button'),docLink('在文档中打开 ↗',t.path));content.append(bar);const title=el('div','kp-task-heading'),heading=el('h2','',t.name);heading.tabIndex=-1;title.append(heading,badge(t.state),el('span','kp-muted',date(t.updated)));content.append(title);if(fileLoading)content.append(el('p','kp-empty','正在读取原文…'));else if(taskFile){content.append(markdown(taskFile.body,taskFile.links),el('p','kp-footnote',t.path));}else content.append(btn('重试读取',()=>openTask(t),'kp-text-button'));}
  async function loadChats(append=false){const token=++chatRequest;chatLoading=true;error='';render();try{const result=await sdk.call('chats',{...params(),offset:append?chatData?.nextOffset??0:0});if(!alive||token!==chatRequest)return;chatData=result;const map=new Map((append?chatRecords:[]).map(r=>[r.taskId,r]));result.records.forEach(r=>map.set(r.taskId,r));chatRecords=[...map.values()];if(result.warnings.length)notice=result.warnings.join('；');}catch(e){if(alive&&token===chatRequest)error='聊天目录读取失败：'+e.message;}finally{if(alive&&token===chatRequest){chatLoading=false;render();}}}
  function renderChats(){void conversation.select(params());content.append(conversation.node);const intro=el('div','kp-view-intro');intro.append(el('h2','','相关聊天'),el('p','','依据历史轮次中明确记录的项目归属；引用项目的聊天不计入。'));content.append(intro);for(const r of chatRecords){const card=el('article','kp-chat-row'),a=link(r.title||'未命名聊天',deep('conversations',{target:selected,task:r.taskId,...(r.turnId?{turn:r.turnId}:{})}));a.append(icon('arrow'));card.append(a,el('p','',r.summary||'该聊天尚未记录项目进展简述。'),el('span','kp-muted',`${r.turnCount} 个相关轮次 · ${date(r.updatedAt,true)}`),btn('在工作台接续',()=>void conversation.attach(r.taskId),'kp-text-button'));content.append(card);}if(chatLoading)content.append(el('p','kp-empty','正在读取聊天归属…'));else if(!chatRecords.length)content.append(el('p','kp-empty',error?'聊天目录暂不可用，可重试读取。':'还没有明确归属于这个项目的聊天。'));if(chatData?.nextOffset!==null&&chatData?.nextOffset!==undefined){const more=btn('加载更多聊天',()=>loadChats(true),'kp-text-button');more.disabled=chatLoading;content.append(more);}const retry=btn('刷新聊天',()=>loadChats(),'kp-text-button');retry.disabled=chatLoading;content.append(retry);}
  function renderResources(){const intro=el('div','kp-view-intro');intro.append(el('h2','','资料与成果'),el('p','','收录项目原文和任务检查点中的明确引用，每个入口都保留出处。'));content.append(intro);const filter=el('input','kp-resource-search');filter.type='search';filter.placeholder='搜索名称或路径';filter.setAttribute('aria-label','搜索资料与成果');const holder=el('div');const draw=()=>{holder.replaceChildren();const value=filter.value.toLocaleLowerCase(),refs=detail.resources.filter(r=>`${r.title} ${r.path??r.url}`.toLocaleLowerCase().includes(value));for(const r of refs){const row=el('article','kp-resource-row'),body=el('div'),url=resourceURL(r);body.append(url?link(r.title+' ↗',url):el('strong','',r.title),el('p','kp-resource-path',r.path??r.url),docLink('出处：'+r.source.split('/').at(-1),r.source));row.append(icon(r.url?'link':'file'),body);holder.append(row);}if(!refs.length)holder.append(el('p','kp-empty',filter.value?'没有匹配的资料。':'尚未记录资料或成果引用。'));};filter.addEventListener('input',draw);content.append(filter,holder);draw();if(detail.resourcesTruncated)content.append(el('p','kp-muted','引用较多，本次展示前 600 条；完整内容请查看原文。'));}
  renderScope();renderList();render();
  try{const p=await sdk.call('preferences.read');if(alive){selected=p.selected??'';if(selected.startsWith('archived:')){scope='archived';renderScope();}tab=['overview','plan','work','governance','tasks','chats','resources'].includes(p.tab)?p.tab:'overview';}}catch(e){notice='显示设置读取失败：'+e.message;showMessage();}
  async function followDeep(){const search=new URLSearchParams(sdk.getSnapshot().search),name=search.get('project');if(!name)return;const targetScope=search.get('scope')==='archived'?'archived':'current',key=targetScope+':'+name;if(key===selected)return;if(!list.some(p=>p.scope===targetScope&&p.name===name)){error='指定项目当前不可读取：'+name;showMessage();return;}scope=targetScope;tab='overview';renderScope();await choose(key);}
  const unsubscribe=sdk.subscribe(()=>{void followDeep();});
  if(alive){await reload();await followDeep();}
  return {dispose(){unsubscribe?.();management.dispose();conversation.dispose();alive=false;request++;fileRequest++;listRequest++;chatRequest++;root.remove();container.classList.remove('kp-projects-host');}};
}
