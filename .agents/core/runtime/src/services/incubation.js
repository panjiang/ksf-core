import {randomUUID} from 'node:crypto';
import {writeUserData} from './user-data.js';
import {incubationState} from './entry-context.js';
import {incubationDomains,incubationError,validateIncubationDraft} from '../incubation/schema.js';
import {createConfigurationService} from './configuration.js';
import {canonical,expectConfig,withConfigLock} from '../configuration/storage.js';
import {ensureService,openWorkbench,serviceStatus} from './service-manager.js';
import {controlRequest} from '../communication/client.js';
import {platformCapabilities,requirePlatformCapability} from '../platform/index.js';

const subset=(current,desired)=>Object.entries(desired).every(([key,value])=>canonical(current.values[key])===canonical(value));
const errorReceipt=error=>({code:error.code??'INCUBATION_APPLY_FAILED',message:error.message??'配置应用失败。'});
const short=value=>[...value].slice(0,48).join('');

// Preserve arbitrary prose, BOM and line endings. Ambiguous custom documents
// require an explicit, versioned full-text patch rather than a guessed rewrite.
export function userWithLabel(text,name) {
  const eol=text.includes('\r\n')?'\r\n':'\n';
  const matches=[...text.matchAll(/^([ \t]*[-*][ \t]+)常用称呼[：:][^\r\n]*$/gm)];
  if(matches.length>1)throw incubationError('INCUBATION_USER_AMBIGUOUS','USER 中有多个常用称呼，请提供基于最新版本的 userText 和 userEtag。');
  const line=`- 常用称呼：${name}。`;
  if(matches.length===1)return text.slice(0,matches[0].index)+matches[0][1]+line.slice(2)+text.slice(matches[0].index+matches[0][0].length);
  const heading=/^##[ \t]+身份与称呼[ \t]*(?=\r?$)/m.exec(text);
  if(heading){const end=heading.index+heading[0].length;return text.slice(0,end)+eol+eol+line+text.slice(end);}
  return (text||'# 用户说明'+eol).replace(/(?:\r?\n)*$/,'')+eol+eol+'## 身份与称呼'+eol+eol+line+eol;
}

export function createIncubationService(root,adapters={}) {
  const configuration=adapters.configuration??createConfigurationService(root);
  const apply=adapters.apply??(async(domain,operation,input)=>{
    if(domain==='device'){
      await ensureService(root,{reason:'incubation'});
      return controlRequest(root,'/api/local/config',{operation,input:{domain,...input}});
    }
    return configuration.perform(domain,operation,input);
  });
  const open=adapters.open??(()=>openWorkbench(root));
  const workbenchStatus=adapters.workbenchStatus??(()=>serviceStatus(root));
  const now=adapters.now??(()=>new Date().toISOString());
  const readState=()=>incubationState(root);
  const lock=action=>withConfigLock(root,'incubation-operation',action);
  async function configs(){return Object.fromEntries(await Promise.all(incubationDomains.map(async id=>[id,await configuration.read(id)])));}
  function candidate(state,actual){
    const draft=state.values.draft??{},label=draft.userLabel;
    return {userLabel:label??null,instanceName:draft.instanceName??actual.instance.values.name??(label?`${short(label)}的 KSF`:null),
      deviceName:draft.deviceName??(actual.device.state==='present'?actual.device.values.name:label?`${short(label)}的 ${process.platform==='darwin'?'Mac':process.platform==='win32'?'Windows 电脑':'电脑'}`:null),
      autostart:draft.autostart??actual.service.values.autostart??platformCapabilities.loginStartup};
  }
  async function read(){
    const state=readState(),actual=await configs(),proposed=candidate(state,actual);
    return {...state,candidate:proposed,actual,missing:state.values.status==='pending'?Object.entries(proposed).filter(([,value])=>value===null).map(([key])=>key):[],
      capabilities:platformCapabilities,workbenchUrl:state.values.operation?.workbench.url??`http://127.0.0.1:${actual.service.details.port}/`,root,handoff:'ksf context entry --json'};
  }
  function requirePending(state){if(state.values.status!=='pending')throw incubationError('INCUBATION_NOT_PENDING','当前实例未处于孵化中；保留现有配置，不自动重新孵化。');}
  function save(state,patch){
    const result=writeUserData({root,namespace:'incubation',ifMatch:state.etag,values:patch});
    return {...state,...result,state:'present',values:result.values};
  }
  async function write({values,ifMatch,dryRun=false}){
    validateIncubationDraft(values);
    if(values.autostart===true)requirePlatformCapability('loginStartup');
    if(values.openWorkbench===true)requirePlatformCapability('openURI');
    const action=async()=>{
      const state=readState();expectConfig(state,ifMatch);requirePending(state);
      const draft={...state.values.draft,...values};validateIncubationDraft(draft);
      const actual=await configs();if(draft.userText!==undefined)expectConfig(actual['collaboration.user'],draft.userEtag);
      const patch={draft,baselines:Object.fromEntries(incubationDomains.map(id=>[id,actual[id].etag])),operation:null};
      if(dryRun)return {...state,dryRun:true,candidate:candidate({values:patch},actual),wouldChange:true};
      return save(state,patch);
    };
    return dryRun?action():lock(action);
  }
  async function prepare(state,kind){
    const actual=await configs(),draft=state.values.draft??{},values=candidate(state,actual),targets=[];
    const target=(domain,patch)=>{
      const expected=kind==='finish'?state.values.baselines?.[domain]:undefined;
      if(expected!==undefined)expectConfig(actual[domain],expected);
      targets.push({domain,values:patch,beforeEtag:actual[domain].etag});
    };
    if(kind==='finish'){
      if(values.autostart===true)requirePlatformCapability('loginStartup');
      if(draft.openWorkbench===true)requirePlatformCapability('openURI');
      if(!values.userLabel||!values.instanceName||!values.deviceName)throw incubationError('INCUBATION_INCOMPLETE','请提供用户称呼，并确定实例名称和本机名称。');
      if(draft.userText!==undefined)expectConfig(actual['collaboration.user'],draft.userEtag);
      const text=draft.userText??userWithLabel(actual['collaboration.user'].values.text??'',values.userLabel);
      if(!text.includes(values.userLabel))throw incubationError('INCUBATION_INCOMPLETE','USER 原文未包含已确认的用户称呼。');
      target('collaboration.user',{text});target('instance',{name:values.instanceName});target('device',{name:values.deviceName});target('service',{autostart:values.autostart});
    }else if(!actual.instance.values.name)target('instance',{name:'我的 KSF'});
    // Explicit saved capture choices win; only a new instance gets this default.
    if(draft.captureEnabled!==undefined||actual.capture.state==='missing')target('capture',{enabled:draft.captureEnabled??true});
    for(const item of targets)await configuration.check(item.domain,{values:item.values,ifMatch:item.beforeEtag});
    return {id:randomUUID(),kind,targets,steps:{},workbench:{state:kind==='skip'||draft.openWorkbench===false||!platformCapabilities.openURI?'suppressed':'pending'}};
  }
  function checkState(state){expectConfig(readState(),state.etag);}
  async function runTargets(state){
    const operation=structuredClone(state.values.operation);
    for(const item of operation.targets){
      checkState(state);
      let current=await configuration.read(item.domain);const step=operation.steps[item.domain],matches=subset(current,item.values);
      if(step?.state==='saved'){
        if(!matches)throw incubationError('INCUBATION_CONFIG_CONFLICT',`${item.domain} 在步骤完成后被修改，请保留草稿并重新核对。`,{domain:item.domain});
        continue;
      }
      if(step?.state==='deferred'&&matches)continue;
      if(!matches)expectConfig(current,item.beforeEtag);
      try{
        // Reconcile static writes after a crash. Runtime settings go through
        // their owner with the current CAS version, never direct file edits.
        const runtime=['device','service','capture'].includes(item.domain);
        const result=!matches||runtime?await apply(item.domain,item.domain==='service'&&matches?'apply':'write',{values:item.domain==='service'&&matches?undefined:item.values,ifMatch:current.etag}):current;
        current=await configuration.read(item.domain);
        if(!subset(current,item.values))throw incubationError('INCUBATION_VERIFY_FAILED',`${item.domain} 保存后的读回值不一致。`);
        if(result.application?.state==='failed')throw Object.assign(new Error(result.application.error?.message??'配置已保存，应用失败。'),{code:result.application.error?.code??'CONFIG_APPLY_FAILED'});
        operation.steps[item.domain]={state:'saved',etag:current.etag};
      }catch(error){
        const fresh=await configuration.read(item.domain);
        const deferred=item.domain==='service'&&state.values.draft?.deferService===true&&subset(fresh,item.values);
        operation.steps[item.domain]={state:deferred?'deferred':'failed',etag:fresh.etag,error:errorReceipt(error)};
        state=save(state,{operation});
        if(!deferred)throw incubationError('INCUBATION_APPLY_FAILED',`${item.domain} 尚未完成：${error.message}`,{domain:item.domain,etag:state.etag,cause:errorReceipt(error)});
        continue;
      }
      state=save(state,{operation});
    }
    for(const item of operation.targets)if(!subset(await configuration.read(item.domain),item.values))throw incubationError('INCUBATION_CONFIG_CONFLICT',`${item.domain} 在完成前发生变化。`,{domain:item.domain});
    return state;
  }
  async function openOnce(state){
    const operation=structuredClone(state.values.operation);
    if(operation?.workbench.state!=='pending')return state;
    const policy=await configuration.read('service');
    let address=`http://127.0.0.1:${policy.details.port}/`;
    try{address=(await workbenchStatus()).directUrl??address;}catch{/* Keep the saved address available for recovery. */}
    operation.workbench={state:'requested',url:address};
    state=save(state,{operation}); // Unknown external outcomes never auto-reopen.
    try{const result=await open();operation.workbench={state:'opened',url:result.openedUrl??result.directUrl??operation.workbench.url};}
    catch(error){operation.workbench={...operation.workbench,state:'failed',error:error.message};}
    return save(state,{operation});
  }
  async function commit(kind,{ifMatch,dryRun=false}){
    const action=async()=>{
      let state=readState();expectConfig(state,ifMatch);const terminal=kind==='finish'?'completed':'skipped';
      if(state.values.status===terminal){
        if(!dryRun&&kind==='finish')state=await openOnce(state);
        return {...state,dryRun,alreadyFinished:true,handoff:'ksf context entry --json'};
      }
      requirePending(state);
      if(kind==='finish'){
        if(candidate(state,await configs()).autostart===true)requirePlatformCapability('loginStartup');
        if(state.values.draft?.openWorkbench===true)requirePlatformCapability('openURI');
      }
      let operation=state.values.operation;
      if(operation&&operation.kind!==kind){
        if(kind==='finish')throw incubationError('INCUBATION_OPERATION_CONFLICT','当前正在恢复跳过操作，请先继续 skip。');
        operation=null; // Explicit skip does not resume remaining finish steps.
      }
      operation??=await prepare(state,kind);
      if(dryRun){
        for(const item of operation.targets){const current=await configuration.read(item.domain);if(!subset(current,item.values))expectConfig(current,item.beforeEtag);await configuration.check(item.domain,{values:item.values,ifMatch:current.etag});}
        return {...state,dryRun:true,operation,wouldComplete:true};
      }
      if(!state.values.operation||state.values.operation.id!==operation.id)state=save(state,{operation});
      state=await runTargets(state);state=save(state,{status:terminal,[kind==='finish'?'completedAt':'skippedAt']:now()});
      if(kind==='finish')state=await openOnce(state);
      return {...state,handoff:'ksf context entry --json'};
    };
    return dryRun?action():lock(action);
  }
  return {read,write,finish:input=>commit('finish',input),skip:input=>commit('skip',input)};
}
