import {hostname,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {readUserData,writeUserData,removeUserData} from './user-data.js';
import {catalog,summary,resolveObject,problems} from '../objects/catalog.js';
import {validateValues} from '../user-data/schema.js';
import {validateObjectValues} from '../user-data/records.js';
import {configurationDomains,configurationDomain} from '../configuration/catalog.js';
import {readConfigFile,expectConfig,valueVersion,canonical,publishConfigFile,withConfigLock,configError} from '../configuration/storage.js';
import {connectionContract,profileContract} from '../ai-tasks/profiles.js';
import {DEFAULTS as communicationDefaults,validateCommunicationConfiguration} from '../communication/contracts.js';
import {deviceName} from '../communication/device-profile.js';
import {readServicePolicy,configureAutostart} from './service-manager.js';
import {captureStatus,configureCapture} from './tasks.js';
import {chatConfig} from './chat.js';
import {atomicJSON,safeDirectory,readJSON} from '../shared/durable-json.js';
import {sha256} from '../shared/hash.js';
import {platformCapabilities,requirePlatformCapability} from '../platform/index.js';

const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const pick=(object,keys)=>Object.fromEntries(keys.filter(key=>own(object,key)).map(key=>[key,object[key]]));
export function createConfigurationService(root,{ai,communication,service}={}){
  const metadataPath=id=>join(root,'.agents/runtime-data/configuration/apply',sha256(id)+'.json');
  async function list(){
    const objects=catalog(root),errors=problems(objects),abilities=[];
    for(const id of new Set(objects.rows.filter(row=>row.id).map(row=>row.id))){
      try{const row=resolveObject(objects,{id});const item=summary(row);abilities.push({id:'ability:'+id,objectId:id,label:item.name,type:row.type,description:item.description,version:item.version,source:item.source});}
      catch(error){if(error.code!=='OBJECT_NOT_FOUND')errors.push({id,code:error.code,message:error.message});}
    }
    abilities.sort((a,b)=>a.objectId.localeCompare(b.objectId));
    return {domains:configurationDomains.map(item=>structuredClone(item)),abilities,complete:errors.length===0,errors};
  }
  function defaults(d){
    if(d.id==='service'&&!platformCapabilities.loginStartup)return {autostart:false};
    if(d.id==='program'){const core=readConfigFile(root,'.agents/core/distribution.json').document;return {...d.defaults,updates:core?pick(core,['check_interval_seconds','request_timeout_seconds']):d.defaults.updates};}
    if(d.id==='communication')return pick(communicationDefaults,d.fields.map(f=>f.name));
    if(d.id==='device')return {name:hostname()};
    return structuredClone(d.defaults??{});
  }
  function resolved(d,base,overrides){
    // Only this consumer declares nested defaults. Writes still replace a supplied
    // top-level updates mapping; omitted update fields return to Core defaults.
    if(d.id==='program')return {...base,...overrides,routing:{...base.routing,...overrides.routing},updates:{...base.updates,...overrides.updates}};
    return {...base,...overrides};
  }
  function snapshot(d){
    if(d.namespace||d.objectId)return readUserData({root,namespace:d.namespace,objectId:d.objectId});
    const raw=readConfigFile(root,d.path,{text:d.owner==='collaboration'}),document=raw.document;
    let values={};
    if(d.owner==='collaboration')values=raw.state==='missing'?{}:{text:document};
    else if(d.owner==='ai'){
      if(document && (document.schemaVersion!==1||!Number.isSafeInteger(document.revision)||document.revision<0||!Array.isArray(document.items)))throw configError('AI_STORAGE_VERSION','AI 配置损坏或格式未知，请保留原件。');
      if(document)document.items.forEach(d.id==='ai.connections'?connectionContract:profileContract);
      values=document?{items:document.items}:{};
    }else if(d.id==='communication'){
      if(document && (document.schemaVersion!==1||!Number.isSafeInteger(document.revision)))throw configError('COMM_STORAGE_INVALID','通信配置格式未知，请保留原件。');
      values=document?pick(document,d.fields.map(f=>f.name)):{};
    }else if(d.id==='service'){const policy=readServicePolicy(root);return policy.then(value=>({...raw,values:document?{autostart:value.autostart}:{},extra:{port:value.port,capabilities:platformCapabilities}}));}
    else if(d.id==='capture'){const status=captureStatus({root});values=document?{enabled:status.enabled}:{};return {...raw,values,extra:{...status,trackingEnabled:chatConfig(root)?.enabled??false}};}
    else if(d.id==='device'){
      if(document && (document.schemaVersion!==1||deviceName(document.name)!==document.name))throw configError('COMM_DEVICE_PROFILE_INVALID','本机名称配置无效，请保留原件。');
      values=document?{name:document.name}:{};
    }
    // Versions of editable communication fields must not conflict with background peer-name updates.
    return {...raw,values,etag:d.id==='communication'&&document?valueVersion(values):raw.etag};
  }
  async function read(id){
    const d=configurationDomain(id),stored=await snapshot(d),base=defaults(d),saved=resolved(d,base,stored.values);
    let application={state:d.runtime?'unknown':d.effect??'immediate'},effective=d.runtime?null:saved;
    if(d.runtime){
      let prior;try{prior=await readJSON(metadataPath(id),null);}catch{application={state:'unknown',error:{code:'CONFIG_STATUS_INVALID',message:'上次应用状态不可读；保存的配置仍保留。'}};}
      if((ai||communication||service)&&prior?.etag===stored.etag)application=prior.application;
      if(d.id==='communication'&&communication){try{const current=await (await communication).snapshot();effective={...pick(current.config,d.fields.map(f=>f.name)),listener:current.listener};if(application.state!=='failed')application={state:current.config.enabled&&!current.listener?'failed':'immediate'};}catch(error){application={state:'failed',error:{code:error.code??'COMM_START_FAILED',message:error.message}};}}
      else if(d.id==='device'&&communication){try{const current=await (await communication).snapshot();effective=current.device??null;}catch{}}
      else if(d.owner==='ai'&&ai){effective=saved;if(application.state!=='failed')application={state:'new-task'};}
      else if(d.id==='service'&&service&&prior?.etag===stored.etag&&application.state==='immediate')effective=saved;
    }
    return {id,label:d.label,owner:d.owner,scope:d.scope,description:d.description,fields:d.fields,capabilities:d.capabilities,path:stored.path,state:stored.state,etag:stored.etag,revision:stored.revision??stored.document?.revision??null,defaults:base,values:stored.values,effective,application,...(stored.extra?{details:stored.extra}:{}),...(id==='incubation'?{details:{root}}:{})};
  }
  function validate(d,values){
    if(!values||typeof values!=='object'||Array.isArray(values))throw configError('CONFIG_INVALID','配置需要 JSON 对象。');
    validateObjectValues(values);
    if(d.objectId)return;
    if(d.namespace){validateValues(d.namespace,values);return;}
    if(Object.keys(values).some(key=>!d.fields.some(field=>field.name===key)))throw configError('CONFIG_INVALID','配置包含不属于本领域的字段。');
    if(d.owner==='collaboration'){if(typeof values.text!=='string'||Buffer.byteLength(values.text)>1024*1024)throw configError('CONFIG_INVALID','原文需要不超过 1 MiB 的文本。');}
    else if(d.owner==='ai'){
      if(!Array.isArray(values.items)||values.items.length>64)throw configError('AI_REQUEST_INVALID','配置列表最多 64 项。');
      values.items.forEach(d.id==='ai.connections'?connectionContract:profileContract);
      if(new Set(values.items.map(item=>item.id)).size!==values.items.length)throw configError('AI_REQUEST_INVALID','配置标识重复。');
    }else if(d.id==='communication')validateCommunicationConfiguration(values);
    else if(d.id==='device')deviceName(values.name);
    else if(d.id==='service'){if(values.autostart!==null&&typeof values.autostart!=='boolean')throw configError('CONFIG_INVALID','登录启动需要布尔值。');if(values.autostart===true)requirePlatformCapability('loginStartup');}
    else if(d.id==='capture'&&typeof values.enabled!=='boolean')throw configError('CONFIG_INVALID','正文采集开关需要布尔值。');
  }
  async function check(id,input={}){
    const d=configurationDomain(id),before=await read(id),values=resolved(d,before.defaults,{...before.values,...(input.values??{})});
    if(input.ifMatch!==undefined)expectConfig(before,input.ifMatch);validate(d,values);
    if(d.namespace||d.objectId)writeUserData({root,namespace:d.namespace,objectId:d.objectId,values:input.values??{},ifMatch:before.etag,dryRun:true});
    return {...before,valid:true,candidate:values,wouldChange:canonical(values)!==canonical(resolved(d,before.defaults,before.values)),dryRun:true};
  }
  async function remember(id,result,application){await safeDirectory(root,join(root,'.agents/runtime-data/configuration/apply'));await atomicJSON(metadataPath(id),{etag:result.etag,application});}
  async function perform(id,operation,input={}){
    const d=configurationDomain(id);
    if(!['read','check','write','reset','apply'].includes(operation))throw configError('CONFIG_OPERATION_UNSUPPORTED','未知配置操作。');
    if(operation==='apply'&&input.values!==undefined)throw configError('CONFIG_INVALID','apply 只应用已保存配置，不接受新的 values。');
    if(input.fields!==undefined&&(!Array.isArray(input.fields)||!input.fields.length||input.fields.some(key=>typeof key!=='string'||!key.length||key.length>256)))throw configError('CONFIG_INVALID','fields 需要非空顶层字段名列表。');
    if(input.dryRun!==undefined&&typeof input.dryRun!=='boolean')throw configError('CONFIG_INVALID','dryRun 需要布尔值。');
    if(!d.capabilities.includes(operation))throw configError('CONFIG_OPERATION_UNSUPPORTED','此配置不支持该操作。');
    if(operation==='read')return read(id);
    if(operation==='check')return check(id,input);
    const before=await read(id);expectConfig(before,input.ifMatch);
    let patch=input.values??{};
    if(operation==='reset'&&!d.namespace&&!d.objectId){
      if(input.fields?.length)patch=Object.fromEntries(input.fields.map(key=>{if(!own(before.defaults,key))throw configError('CONFIG_OPERATION_UNSUPPORTED','字段没有可恢复的默认值。');return [key,before.defaults[key]];}));
      else patch=before.defaults;
    }
    const retained=operation==='reset'&&(d.namespace||d.objectId)?Object.fromEntries(Object.entries(before.values).filter(([key])=>input.fields?.length&&!input.fields.includes(key))):before.values;
    const candidate=resolved(d,before.defaults,{...retained,...patch});validate(d,candidate);
    const changed=operation==='reset'?(input.fields?.length?input.fields.some(key=>own(before.values,key)):before.state==='present'):canonical(candidate)!==canonical(resolved(d,before.defaults,before.values));
    if(input.dryRun){
      if(d.namespace||d.objectId){
        if(operation==='reset'&&!input.fields?.length)removeUserData({root,namespace:d.namespace,objectId:d.objectId,ifMatch:before.etag,dryRun:true});
        else writeUserData({root,namespace:d.namespace,objectId:d.objectId,values:operation==='reset'?{}:patch,removeFields:operation==='reset'?input.fields:[],ifMatch:before.etag,dryRun:true});
      }
      return {...before,dryRun:true,changed:false,wouldChange:changed,candidate};
    }
    if(d.namespace||d.objectId){
      let result;
      if(operation==='reset'&&!input.fields?.length)result=removeUserData({root,namespace:d.namespace,objectId:d.objectId,ifMatch:before.etag});
      else result=writeUserData({root,namespace:d.namespace,objectId:d.objectId,values:operation==='reset'?{}:patch,removeFields:operation==='reset'?input.fields:[],ifMatch:before.etag});
      return {...await read(id),changed:result.changed, saved:true};
    }
    if(d.owner==='collaboration')return withConfigLock(root,d.id,async()=>{
      const raw=readConfigFile(root,d.path,{text:true});expectConfig(raw,input.ifMatch);
      if(changed||raw.state==='missing')publishConfigFile(root,raw,candidate.text,{text:true});
      return {...await read(id),changed:changed||raw.state==='missing',saved:true};
    });
    if(d.id==='capture'){
      configureCapture({root,enabled:candidate.enabled,ifMatch:input.ifMatch,install:true});const result=await read(id);return {...result,changed:result.etag!==before.etag,saved:true};
    }
    // Runtime domains are mutated only by their owning managed service.
    if(d.owner==='ai'&&!ai||['communication','device'].includes(id)&&!communication)throw configError('CONFIG_BACKEND_REQUIRED','此操作需要 KSF 后台。',503);
    let application;
    try{
      if(d.owner==='ai')await ai.config(id.slice(3),{items:candidate.items,revision:(await snapshot(d)).document?.revision??0},{ifMatch:input.ifMatch,applyOnly:operation==='apply'});
      else if(id==='communication')await (await communication).configure(operation==='apply'?{}:patch,{ifMatch:input.ifMatch,applyOnly:operation==='apply'});
      else if(id==='device')await (await communication).setDevice({name:candidate.name,ifMatch:input.ifMatch});
      else if(id==='service'){const options={ifMatch:input.ifMatch,applyOnly:operation==='apply'};if(service?.autostart)await service.autostart({enabled:candidate.autostart,...options});else await configureAutostart(root,candidate.autostart,options);}
      application={state:d.effect??'immediate'};
    }catch(error){
      if(!error.data?.saved)throw error;
      application={state:'failed',error:{code:error.code??'CONFIG_APPLY_FAILED',message:error.message}};
    }
    const result=await read(id);let warnings=[];try{await remember(id,result,application);}catch{warnings=[{code:'CONFIG_STATUS_UNSAVED',message:'配置已保存，但应用状态未能持久记录；请读回核对。'}];}
    return {...result,application,changed:operation==='apply'?false:result.etag!==before.etag,saved:true,...(warnings.length?{warnings}:{})};
  }
  async function exportConfiguration({includeDevice=false,includeCollaboration=false}={}){
    const entries=[],omitted=[];
    for(const d of configurationDomains){
      if(d.owner==='collaboration'&&!includeCollaboration){omitted.push({id:d.id,reason:'协作原文需显式选择'});continue;}
      if(!d.capabilities.includes('export')&&d.owner!=='collaboration'){omitted.push({id:d.id,reason:'由所属模块管理，不作为普通配置导出'});continue;}
      if(d.scope==='device'&&!includeDevice){omitted.push({id:d.id,reason:'本机配置默认排除'});continue;}
      const saved=await read(d.id),values=structuredClone(saved.values);
      if(d.id==='ai.connections'&&!includeDevice&&values.items){for(const item of values.items)for(const key of d.deviceFields)if(own(item,key)){delete item[key];omitted.push({id:d.id,itemId:item.id,field:key,reason:'本机路径；恢复时需重新配置'});}}
      entries.push({id:d.id,scope:d.scope,values});
    }
    return {format:'ksf-configuration',schemaVersion:1,createdAt:new Date().toISOString(),entries,omitted,notes:['不包含凭据、通信身份/授权、运行队列、聊天正文或未声明敏感性的能力配置。','这是配置导出，不是完整备份或可直接恢复的数据包。']};
  }
  const boundary=method=>async(...args)=>{try{return await method(...args);}catch(error){
    if(!error.status)error.status=/CONFLICT|LOCKED|ALREADY_RUNNING/.test(error.code??'')?409:/INVALID|UNKNOWN|UNSUPPORTED|VERSION/.test(error.code??'')?400:500;
    throw error;
  }};
  return {list:boundary(list),read:boundary(read),check:boundary(check),perform:boundary(perform),export:boundary(exportConfiguration)};
}
