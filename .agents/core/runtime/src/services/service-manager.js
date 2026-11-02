import {randomUUID} from 'node:crypto';
import {readWebHosts} from './web-hosts.js';
import {spawn} from 'node:child_process';
import {mkdir,readFile,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {platform,platformCapabilities,requirePlatformCapability} from '../platform/index.js';
import {readJSON,atomicJSON} from '../communication/contracts.js';
import {controlRequest} from '../communication/client.js';
import {acquireServiceLock,liveIdentity,serviceError,processIdentity} from './service-lock.js';
import {setLoginStartup,startWindowsService} from '../platform/service.js';
import {withConfigLock,readConfigFile,publishConfigFile,expectConfig} from '../configuration/storage.js';

export const SERVICE_PORT=1313;
const home=root=>join(root,'.agents/runtime-data/service');
export async function readServicePolicy(root){const value=await readJSON(join(home(root),'policy.json'),{schemaVersion:1,port:SERVICE_PORT,autostart:null});if(value.schemaVersion!==1||!Number.isInteger(value.port)||value.port<1||value.port>65535||![true,false,null].includes(value.autostart))throw serviceError('SERVICE_POLICY_INVALID','设备服务策略损坏，请保留 service/policy.json 并检查。');return value;}
export {redactLog} from '../shared/logs.js';
import {redactLog} from '../shared/logs.js';
export async function serviceStatus(root){
  const policy=await readServicePolicy(root),record=await readJSON(join(root,'.agents/runtime-data/web/control.json'),null);
  const deployment=await readJSON(join(home(root),'deployment.json'),null);
  const base={deployment,capabilities:platformCapabilities,state:'stopped',port:policy.port,autostart:policy.autostart,root,url:`http://ksf.ai:${policy.port}/`};
  const lock=await readJSON(join(home(root),'host.lock'),null),transition=liveIdentity(lock)?{...base,state:'busy',pid:lock.pid,code:'SERVICE_TRANSITIONING'}:base;
  if(!record)return transition;
  if(!record.processStart){let live=false;try{process.kill(record.pid,0);live=true;}catch{}return live?{...base,state:'upgrade-required',code:'SERVICE_UPGRADE_REQUIRED'}:transition;}
  if(!liveIdentity(record))return {...transition,stale:true};
  if(record.root!==await realpath(root))throw serviceError('SERVICE_IDENTITY_MISMATCH','控制入口不属于当前 KSF 实例。');
  let endpoint;try{endpoint=new URL(record.url);}catch{throw serviceError('SERVICE_CONTROL_INVALID','本机控制地址无效。');}if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw serviceError('SERVICE_CONTROL_INVALID','控制入口必须为本机回环 HTTP 地址。');
  try{const response=await fetch(new URL('api/health',endpoint),{signal:AbortSignal.timeout(1500)}),health=await response.json();
    if(!response.ok||health.nonce!==record.nonce||health.pid!==record.pid)throw Error('identity');
    return {...base,url:`http://ksf.ai:${new URL(record.url).port||80}/`,state:'running',pid:record.pid,port:new URL(record.url).port?Number(new URL(record.url).port):80,directUrl:record.url,startedAt:health.startedAt,reason:health.reason,frontend:health.frontend};
  }catch{return {...base,state:'unresponsive',pid:record.pid,code:'SERVICE_UNRESPONSIVE'};}
}

export async function ensureService(root,{port,reason='cli',timeoutMs=30000}={}){
  root=await realpath(root);if(await readJSON(join(home(root),'deployment.json'),null))throw serviceError('SERVICE_DEPLOYING','正在配套更新 Core 与应用，完成或回退部署后再启动。');let status=await waitForServiceTransition(root,timeoutMs);if(status.state==='running')return status;
  if(['upgrade-required','unresponsive'].includes(status.state))throw serviceError(status.code,'现有后台需要核对，请运行 ksf service doctor。');
  const release=await acquireServiceLock(join(home(root),'startup.lock'),{timeoutMs});
  try{status=await serviceStatus(root);if(status.state==='running')return status;
    if(status.state!=='stopped')throw serviceError(status.code,'后台状态异常，请先核对。');
    const policy=await readServicePolicy(root),selected=port??policy.port;
    if(!Number.isInteger(selected)||selected<1||selected>65535)throw serviceError('INVALID_ARGUMENTS','服务端口必须是 1—65535。');
    const attemptId=randomUUID();await atomicJSON(join(home(root),'start-request.json'),{id:attemptId,reason,port:selected,parent:processIdentity(),at:Date.now()});
    if(process.platform==='win32'&&port===undefined)startWindowsService(root,policy.autostart===true);
    else{const child=spawn(process.execPath,[fileURLToPath(new URL('./service-entry.js',import.meta.url)),root,String(selected),reason,attemptId],{cwd:dirname(process.execPath),detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,KSF_SERVICE_START_REASON:reason}});await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j);});child.unref();}
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){status=await serviceStatus(root);if(status.state==='running')return status;const failed=await readJSON(join(home(root),'last-start.json'),null);if(failed?.attemptId===attemptId)throw serviceError(failed.code,failed.message);await new Promise(r=>setTimeout(r,150));}
    const logs=await serviceLogs(root);throw serviceError('SERVICE_START_TIMEOUT','后台启动失败或超时，请检查 service logs。',{logs});
  }finally{await release();}
}
export async function serviceLogs(root){const result={};for(const name of ['service.log','service.err'])try{const b=await readFile(join(home(root),name));result[name]=redactLog(b.subarray(Math.max(0,b.length-32768)).toString());}catch(e){if(e.code!=='ENOENT')throw e;result[name]='';}return result;}
export async function configureAutostart(root,enabled,options={}){if(enabled!==null&&typeof enabled!=='boolean')throw serviceError('INVALID_ARGUMENTS','enabled 必须为布尔值。');if(enabled===true)requirePlatformCapability('loginStartup');return withConfigLock(root,'service',async()=>{const before=readConfigFile(root,'.agents/runtime-data/service/policy.json');if(options.ifMatch!==undefined)expectConfig(before,options.ifMatch);const value={...await readServicePolicy(root),autostart:enabled};if(before.document?.autostart!==enabled)publishConfigFile(root,before,value);try{await setLoginStartup(root,enabled===true);}catch(error){error.data={...error.data,saved:true};throw error;}return value;});}
export async function stopService(root,{force=false}={}){const status=await serviceStatus(root);if(status.state==='stopped')return status;if(status.state!=='running')throw serviceError(status.code,'现有后台无法安全停止，请先诊断。');const request=await readJSON(join(home(root),'start-request.json'),null);if(request)await atomicJSON(join(home(root),'start-request.json'),{...request,cancelled:true});try{await controlRequest(root,'/api/local/service',{operation:'stop',input:{force}});}catch(error){if(error.code==='APP_BUSY'&&request){const current=await readJSON(join(home(root),'start-request.json'),null);if(current?.id===request.id)await atomicJSON(join(home(root),'start-request.json'),request);}throw error;}const deadline=Date.now()+15000;while(Date.now()<deadline){const next=await serviceStatus(root);if(next.state==='stopped')return next;await new Promise(r=>setTimeout(r,100));}throw serviceError('SERVICE_STOP_TIMEOUT','后台仍在退出，请核对状态。');}
export async function openWorkbench(root){requirePlatformCapability('openURI');const status=await ensureService(root,{reason:'open'});const openedUrl=readWebHosts().state==='configured'?status.url:status.directUrl;const launch=platform.openURI(openedUrl);const child=spawn(launch.executable,launch.args,{detached:true,stdio:'ignore',windowsHide:true});await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j);});child.unref();return {...status,openedUrl};}

export async function serviceDoctor(root){
  const status=await serviceStatus(root),logs=await serviceLogs(root),data={...status,logs,health:status.state==='running'?'healthy':status.state,issues:[],recovery:'后台未运行时执行 ksf service start；配套部署中则先完成或回退；端口占用请先释放。'};
  if(status.frontend?.state==='unavailable')data.issues.push({service:'frontend',code:status.frontend.code??'WEB_FRONTEND_UNAVAILABLE'});
  if(status.state==='running'){
    const names=['applications','service','communication'],results=await Promise.allSettled([controlRequest(root,'/api/local/apps',{operation:'runtime',input:{action:'list'}}),controlRequest(root,'/api/local/service',{operation:'status'}),controlRequest(root,'/api/local/communication',{operation:'state'})]);
    for(let i=0;i<results.length;i++){const result=results[i];if(result.status==='rejected'){data.issues.push({service:names[i],code:result.reason.code??'SERVICE_PROBE_FAILED',message:redactLog(result.reason.message)});continue;}
      const value=result.value;if(i===0){data.applications=value.applications;data.accepting=value.accepting;for(const error of value.errors??[])data.issues.push({service:'applications',...error});for(const app of value.applications??[])for(const error of app.errors??[])data.issues.push({service:app.id,...error});}
      if(i===1){data.communicationRuntime=value.communication;if(value.communication?.error)data.issues.push({service:'communication',...value.communication.error});data.ai=value.ai;if(value.ai?.error)data.issues.push({service:'ai',...value.ai.error});}
      if(i===2){data.communication={enabled:value.config?.enabled,listener:value.listener};for(const error of [value.discoveryError,value.dispatchError])if(error)data.issues.push({service:'communication',code:error.code,message:redactLog(error.message)});}
    }
  }
  if(data.issues.length)data.health='degraded';return data;
}

export async function waitForServiceTransition(root,timeoutMs=30000){const deadline=Date.now()+timeoutMs;let status;do{status=await serviceStatus(root);if(status.state!=='busy')return status;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);throw serviceError('SERVICE_TRANSITION_TIMEOUT','主服务仍在建立或释放控制入口，请检查 service doctor。');}
