import { createAssetService } from './assets.js';
import {createWorkflowService} from './workflows.js';
import {createCapabilities} from './capabilities.js';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {project as projectService} from './projects.js';
import {projectManagement} from './project-management.js';
import {listTasks} from './tasks.js';
import {createPersistedWorkbenchGit} from './workbench-git.js';
import {createApplicationStorage} from './application-storage.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {createCommunicationService} from '../communication/service.js';
import {createLocalControl} from '../communication/control.js';
import { createCoordinator, problem, assert } from './workbench-common.js';
import { createWorkspaceFiles } from './workspace-files.js';
import {createTaskActivitySource} from './task-activity.js';
import {createTaskReviewSource} from './task-review.js';
import { createApplicationManager } from '../applications/manager.js';
import { MAX_PACKAGE } from '../applications/protocol.js';
import { createWorkbenchAI } from './ai-tasks.js';
import { createCodexConversations, CONVERSATION_METHODS } from './codex-conversations.js';
import {createConfigurationService} from './configuration.js';
import {createRuntimeMonitor} from './runtime-monitor.js';

export function createCoreHost(root,options={}) {
  let draining=false,started=false,closed=false,backgroundReady=Promise.resolve(),communicationStart;let resolveCommunication,rejectCommunication;
  const coordinator = createCoordinator(), files = createWorkspaceFiles(root, coordinator),activity=createTaskActivitySource(files.root),reviewSource=createTaskReviewSource(files.root);
  const appStorage=createApplicationStorage(files.root);
  let gitReady;
  const hostGit=()=>gitReady??=createPersistedWorkbenchGit(files.root,files,coordinator,appStorage);
  const gitMethods=['list','owner','status','diff','history','commit','tree','refs','conflict','stashDetail','start','operation','settings','invalidate'];
  const gitService=Object.fromEntries(gitMethods.map(method=>[method,async(...params)=>(await hostGit())[method](...params)]));
  const ai=createWorkbenchAI(files.root,{...options.ai,autoStart:false});
  const codexConversations=createCodexConversations(files.root,options.codexConversations);
  let control;const communicationReady=new Promise((resolve,reject)=>{resolveCommunication=resolve;rejectCommunication=reject;});communicationReady.catch(()=>{});
  const appCaller=caller=>({kind:'app',id:caller.appId});
  const messages=Object.fromEntries(['send','getOperation','reconcile','cancel','inbox','readMessage','readPart'].map(method=>[({getOperation:'status',readMessage:'read'})[method]??method,async(caller,...args)=>(await communicationReady)[method](appCaller(caller),...args)]));
  messages.registerFile=(caller,input)=>control.registerFile(caller,input);
  messages.material=async(caller,id)=>(await communicationReady).store.material(appCaller(caller),id);
  let workflows;
  const workflowMethods=['list','describe','start','get','reconcile','cancel','signal'];
  const applications=createApplicationManager(files.root,{...options.applications,locks:coordinator,services:{assets:createAssetService(files.root,{files,reviewSource}),capabilities:createCapabilities(files.root),workflows:Object.fromEntries(workflowMethods.map(method=>[method,(...args)=>workflows[method](...args)])),cooperation:{request:(...args)=>workflows.request(...args)},projects:{...Object.fromEntries(['read','check','write'].map(operation=>['management'+operation[0].toUpperCase()+operation.slice(1),input=>projectManagement({...input,root:files.root,operation})])),list:input=>projectService({root:files.root,operation:'list',scope:input?.scope??'all'}),read:input=>projectService({root:files.root,operation:'read',name:input?.name,scope:input?.scope??'current'}),tasks:input=>{const {errors,...data}=listTasks({root:files.root,target:input?.target,limit:input?.limit??20,offset:input?.offset??0});return {data,errors};}},git:gitService,messages,peers:{list:async caller=>(await communicationReady).peerDirectory({appId:caller.appId})},'codex-conversations':Object.fromEntries(CONVERSATION_METHODS.map(method=>[method,(...params)=>codexConversations[method](...params)])),ai:Object.fromEntries(['describe','submit','get','readResult','cancel','events','register','executionRules','configureExecution'].map(method=>[method,(...params)=>ai[method](...params)])),tasks:{activity:()=>activity.read(),reviewSources:input=>reviewSource.sources(input),readReviewTurn:input=>reviewSource.read(input)},workspace:Object.fromEntries(['locate','tree','read','search','save','saveUnlocked','create','createUnlocked','move','unlock','upload'].map(method=>[method,(...params)=>files[method](...params)]))}});

  workflows=createWorkflowService(files.root,{applications,ai});
  const configuration=createConfigurationService(files.root,{ai,communication:communicationReady,service:options.service});
  const monitor=createRuntimeMonitor({applications,ai,conversations:codexConversations,service:options.service,...options.monitor});
  control=createLocalControl(files.root,{applications,communication:communicationReady,service:options.service,configuration});
  function start(){if(started||closed)return;started=true;communicationStart=createCommunicationService(files.root,{applications});communicationStart.then(resolveCommunication,rejectCommunication);backgroundReady=applications.startBackground().catch(()=>{});if(existsSync(join(files.root,'.agents/user-data/ai')))void ai.start().catch(()=>{});}
  const git=Object.fromEntries(['list','owner','status','diff','history','commit','tree','refs','conflict','stashDetail','start','operation','settings','invalidate'].map(method=>[method,(...params)=>method==='invalidate'?applications.notify('com.ksf.git',method,params):applications.invoke('com.ksf.git',method,params)]));
  async function quiesce({force=false,controlOffset=0}={}){
    assert(!draining,'SERVICE_STOPPING','后台已在停止。',409);draining=true;const deadline=Date.now()+10000;
    try{const communication=await communicationReady.catch(()=>null);communication?.pauseDispatch();await ai.pauseDispatch();await applications.quiesce({force});while(!force&&(ai.runtimeStatus().active>0||(communication?.runtimeStatus().active??0)>0||control.pendingCount()>controlOffset)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));assert(force||(ai.runtimeStatus().active===0&&(communication?.runtimeStatus().active??0)===0&&control.pendingCount()<=controlOffset),'APP_BUSY','仍有 AI 或通信工作在执行，请稍后重试或显式强制停止。',409);}
    catch(error){draining=false;applications.resume();ai.resumeDispatch();void communicationReady.then(service=>service.resumeDispatch(),()=>{});throw error;}
  }
  return {start,resume(){draining=false;applications.resume();ai.resumeDispatch();void communicationReady.then(service=>service.resumeDispatch(),()=>{});},quiesce,draining:()=>draining,files,activity,applications,ai,codexConversations,monitor,communication:communicationReady,control,configuration,git,backgroundReady,async close(){closed=true;monitor.close();if(!started)rejectCommunication(problem('SERVICE_STOPPED','主服务未激活。',503));await backgroundReady;await control.drain();await applications.close();if(gitReady)await (await gitReady).close();await (await communicationReady.catch(()=>null))?.close();await control.close();await ai.close();await codexConversations.close();}};
}
