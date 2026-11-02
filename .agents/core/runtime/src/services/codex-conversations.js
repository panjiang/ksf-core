import {prepareDesktopExecution} from '../codex-conversations/execution.js';
import {createExecutionGrants} from '../ai-tasks/execution-grants.js';
import {collectExecutionArtifacts} from '../ai-tasks/executors/execution-artifacts.js';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DesktopIPC, failure, sameRef, refValue } from '../codex-conversations/protocol.js';
import { createDraft, locateCLI, openDesktop, codexHome } from '../codex-conversations/app-server.js';
import { createStore } from '../codex-conversations/store.js';
import { workbenchPermissions } from '../codex-conversations/permissions.js';
import { digest, activeTurn, turnsOf, messagesOf, summaryOf, pageMessages, questionsOf, planOf } from '../codex-conversations/state.js';
import { sourceMeta, belongsToRoot, discover, isInternalSession } from '../task-capture/codex.js';
import { sessionKey } from '../routing/storage.js';
import { project } from './projects.js';
import { readRoute } from './routes.js';
import { readChatContext } from './chat.js';
import { readTask } from './tasks.js';
import { platform as nativePlatform,platformCapabilities,requirePlatformCapability } from '../platform/index.js';

export const CONVERSATION_METHODS = ['check', 'create', 'attach', 'read', 'history', 'send', 'events', 'interrupt', 'answer', 'openDesktop', 'operation','executionFiles'];
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);
const assert = (ok, code, text) => { if (!ok) throw failure(code, text); };
const keys = (value, allowed) => { assert(value && typeof value === 'object' && !Array.isArray(value), 'CODEX_ARGUMENT', '请求需要对象。'); assert(Object.keys(value).every(k => allowed.includes(k)), 'CODEX_ARGUMENT', '请求含有不支持的字段。'); };
const textInput = text => assert(typeof text === 'string' && text.trim().length && Buffer.byteLength(text) <= 128 * 1024, 'CODEX_ARGUMENT', '请输入 128 KB 以内的文本。');
const terminal = op => ['accepted', 'succeeded', 'failed', 'unknown'].includes(op.status);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const operationView = op => { const { hash, hashVersion, pid, instance, inputDigest, beforeItems, beforeTurnIds, owner, generation, ...view } = op; return view; };
const pool = new Map();

export function createCodexConversations(root, options = {}) {
  if(!platformCapabilities.desktop){
    const unsupported=async()=>requirePlatformCapability('desktop');
    return {...Object.fromEntries(CONVERSATION_METHODS.map(method=>[method,unsupported])),monitorInterrupt:unsupported,
      async monitorSnapshot(){return {tasks:[],owners:[],issues:[{source:'conversations',code:'PLATFORM_UNSUPPORTED',message:'当前平台暂不支持 Codex Desktop 联动。'}]};},async close(){}};
  }
  root = realpathSync(root);
  // A root has one bridge even if more than one HTTP surface is mounted.
  if (!options.isolated && pool.has(root)) { const item = pool.get(root); item.refs++; return item.service; }
  const ipc = options.ipc ?? new DesktopIPC(process.env.CODEX_DESKTOP_IPC_PATH || nativePlatform.desktopEndpoint(codexHome()));
  ipc.setMaxListeners?.(0);
  const store = createStore(root), instance = randomUUID(), observations = new Map(), subscriptions = new Map(), jobs = new Set(), serial = new Map(), refreshes = new Map();
  const platform = options.platform ?? process.platform, draft = options.createDraft ?? createDraft, open = options.openDesktop ?? openDesktop;
  let catalog, catalogAt = 0, closed = false;
  const monitored=new Map();let monitorIssues=[],monitorRefresh,monitorAt=0;
  function supported() { assert(['darwin','win32'].includes(platform), 'CODEX_PLATFORM_UNSUPPORTED', '当前平台没有受支持的 Codex Desktop 接入。'); assert(!closed, 'CODEX_SERVICE_CLOSED', '会话服务已关闭。'); }
  function callerOK(caller) { assert(caller?.appId && /^[a-z][a-z0-9.-]{1,79}$/.test(caller.appId), 'CODEX_CALLER', '调用需要受信任的应用身份。'); }
  function checkedProject(value) {
    keys(value, ['name', 'scope']); assert(['current', 'archived'].includes(value.scope), 'CODEX_ARGUMENT', '项目范围无效。');
    return project({ root, operation: 'read', name: value.name, scope: value.scope }).data.project;
  }
  function nativeCatalog(force = false) {
    if (!force && catalog && Date.now() - catalogAt < (options.catalogTtlMs??10000)) return catalog;
    catalog = (options.catalog ? options.catalog() : discover(codexHome())).flatMap(path => {
      try { const { meta } = sourceMeta(path); return (belongsToRoot(meta, root)||typeof meta.cwd==='string'&&store.read().bindings[meta.id]?.execution?.workingDirectory===meta.cwd) && !isInternalSession(meta) && validId(meta.id) ? [{ id: meta.id, path, meta }] : []; }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }); catalogAt = Date.now(); return catalog;
  }
  function binding(threadId) {
    assert(validId(threadId), 'CODEX_ARGUMENT', '原生线程标识无效。');
    const b = store.read().bindings[threadId]; assert(b, 'CODEX_NOT_ATTACHED', '请先核验并关联此聊天。');
    // Never route a valid-looking ID into a different workspace after restore or replacement.
    // Bound reads revalidate the exact original, rather than rescanning every
    // native chat whenever the discovery cache expires. Replaced metadata must
    // still match both the thread identity and this root before using IPC.
    let native=catalog?.find(item=>item.id===threadId);
    if(native){try{const {meta}=sourceMeta(native.path);assert(meta.id===threadId&&!isInternalSession(meta),'CODEX_WORKSPACE_MISMATCH','原生线程原件已被替换，接续已停止。');native={...native,meta};}catch(error){if(error.code!=='ENOENT')throw error;native=null;}}
    native??=nativeCatalog(true).find(item=>item.id===threadId);
    assert(native && typeof native.meta.cwd==='string' && resolve(native.meta.cwd) === (b.execution?.workingDirectory??root), 'CODEX_WORKSPACE_MISMATCH', '原生线程不属于当前 KSF 根，接续已停止。');
    return b;
  }
  const opKey = (caller, id) => { callerOK(caller); assert(validId(id), 'CODEX_ARGUMENT', '操作编号需要 8 至 128 个字母、数字、连字符或下划线。'); return caller.appId + '/' + id; };
  function update(key, patch) { return store.change(state => { const op = state.operations[key]; assert(op?.instance === instance, 'CODEX_OPERATION_OWNER', '操作已由其他服务接管。'); Object.assign(op, patch, { updatedAt: new Date().toISOString() }); return op; }); }
  function queue(caller, method, input, action) {
    supported(); const key = opKey(caller, input.operationId), hash = digest({ method, input });
    let created = false;
    const op = store.change(state => {
      const old = state.operations[key];
      if (old) { assert(old.hash === hash || !old.hashVersion && old.hash === digest(JSON.stringify({method,input})), 'CODEX_OPERATION_CONFLICT', '同一个操作编号不能用于不同请求。'); return old; }
      assert(Object.keys(state.operations).length < 10000, 'CODEX_STORE_CAPACITY', '操作回执数量达到上限，请保留并检查。');
      const now = new Date().toISOString(); created = true;
      return state.operations[key] = { operationId: input.operationId, method, appId: caller.appId, hash, hashVersion:2, status: 'queued', threadId: input.threadId ?? null, pid: process.pid, instance, createdAt: now, updatedAt: now };
    });
    if (created) {
      const lock = input.threadId ?? key, previous = serial.get(lock) ?? Promise.resolve();
      const job = previous.catch(() => {}).then(async () => {
        try {
          if(input.threadId)assert(!Object.entries(store.read().operations).some(([id,other])=>id!==key&&other.threadId===input.threadId&&['unknown','dispatching'].includes(other.status)), 'CODEX_OUTCOME_UNKNOWN', '此会话还有结果待核对的操作，请先核对原回执。');
          update(key, { status: 'preparing' }); await action(key);
        }
        catch (error) {
          const current = store.read().operations[key];
          update(key, { status: current.status === 'dispatching' || error.outcomeUnknown ? 'unknown' : 'failed', error: { code: error.code ?? 'CODEX_FAILED', message: error.message, outcomeUnknown: current.status === 'dispatching' || !!error.outcomeUnknown } });
        }
      }).finally(() => { jobs.delete(job); if (serial.get(lock) === job) serial.delete(lock); });
      serial.set(lock, job); jobs.add(job);
      job.catch(() => {}); // Storage failures remain visible to operation(); never crash the HTTP host.
    }
    return operationView(op);
  }
  function ksf(threadId, nativeTurnId) {
    const identity = { host: 'codex', sessionId: threadId }, taskId = sessionKey(root, identity);
    const route = readRoute({ root, identity }), chat = readChatContext({ root, identity });
    return { taskId, route: route.record?.current ?? null, routeTurnId: route.record?.turnId ?? null, chat, hookState: nativeTurnId && chat.system?.turnId === nativeTurnId ? 'observed' : 'unconfirmed' };
  }
  function acceptSnapshot(threadId, snapshot) {
    const normalized = summaryOf(snapshot), messages = messagesOf(snapshot.state), context = ksf(threadId, turnsOf(snapshot.state).at(-1)?.id);
    const version = digest({ normalized, messages, context });
    const prior = observations.get(threadId);
    const next = { snapshot, normalized, messages, context, version, seq: (prior?.seq ?? 0) + Number(prior?.version !== version) };
    observations.set(threadId, next); return next;
  }
  async function observe(threadId, fresh = false, renew = true) {
    supported(); binding(threadId); if(renew)subscriptions.set(threadId, Date.now());
    const snapshot = await ipc.load(threadId, { fresh }); return acceptSnapshot(threadId, snapshot);
  }
  const view = (threadId, observed) => ({ ...observed.normalized, threadId, version: observed.version, ksf: observed.context, messages: pageMessages(observed.messages, Math.max(0, observed.messages.length - 12), 12).records });
  function refresh(threadId) {
    if (closed || refreshes.has(threadId) || !subscriptions.has(threadId)) return;
    const promise = new Promise(resolve=>setTimeout(resolve,250)).then(()=>subscriptions.has(threadId)&&!closed?observe(threadId, true, false):undefined).catch(() => {}).finally(() => refreshes.delete(threadId)); refreshes.set(threadId, promise);
  }
  const onSnapshot = (threadId, snapshot) => { if (subscriptions.has(threadId)) { try { acceptSnapshot(threadId, snapshot); } catch {} } };
  const onInvalidate = threadId => refresh(threadId);
  ipc.on('snapshot', onSnapshot); ipc.on('invalidate', onInvalidate);
  const timer = setInterval(() => {
    for (const [id, at] of subscriptions) {
      if (Date.now() - at > 30000) { subscriptions.delete(id); observations.delete(id); ipc.unfollow(id); }
      else if (!observations.get(id) || Date.now() - observations.get(id).snapshot.at > 5000) refresh(id);
    }
  }, 5000); timer.unref();
  async function dispatch(key, threadId, snapshot, method, version, params, text, acknowledgedStatus = 'accepted') {
    const beforeItems = messagesOf(snapshot.state).map(m => m.id), beforeTurnIds = turnsOf(snapshot.state).map(t => t.id);
    const result = await ipc.request(method, params, { target: snapshot.owner, version, effectful: true, beforeWrite() {
      assert(snapshot.generation === ipc.generation && ipc.owners.get(threadId) === snapshot.owner, 'CODEX_OWNER_CHANGED', 'Desktop 持有者已变化，请重新读取。');
      update(key, { status: 'dispatching', threadId, owner: snapshot.owner, generation: snapshot.generation, beforeItems, beforeTurnIds, ...(text ? { inputDigest: digest(text) } : {}) });
    } });
    update(key, { status: acknowledgedStatus, turnId: result.turnId ?? result.turn?.id ?? result.result?.turnId ?? null });
    refresh(threadId);
  }
  const input = text => [{ type: 'text', text, text_elements: [] }];
  const startParams = (id, text) => ({ conversationId: id, turnStart: { request: { threadId: id, cwd: store.read().bindings[id]?.execution?.workingDirectory??root, ...(store.read().bindings[id]?.execution?{runtimeWorkspaceRoots:store.read().bindings[id].execution.workspaceRoots,permissions:store.read().bindings[id].execution.permissionProfile,approvalPolicy:'never'}:{}), input: input(text) }, context: { inheritThreadSettings: true } } });
  const steerParams = (id, text, messageId) => ({ conversationId: id, input: input(text), restoreMessage: { cwd: root, context: { workspaceRoots: [root], collaborationMode: null }, responsesapiClientMetadata: {} }, attachments: [], clientUserMessageId: messageId });
  const service = {
    async monitorSnapshot(){
      if(!closed&&!monitorRefresh&&Date.now()-monitorAt>=10000){
        const bindings=Object.values(store.read().bindings),issues=[];let cursor=0;
        const boundIds=new Set(bindings.map(b=>b.threadId));for(const id of monitored.keys())if(!boundIds.has(id))monitored.delete(id);
        if(!bindings.length){monitorAt=Date.now();monitorIssues=[];return {tasks:[],issues:[]};}
        monitorRefresh=Promise.all(Array.from({length:Math.min(4,bindings.length)},async()=>{while(!closed&&cursor<bindings.length){const b=bindings[cursor++];try{
          const observed=await observe(b.threadId,true),summary=observed.normalized;if(summary.status==='idle'&&!summary.turnId){monitored.delete(b.threadId);continue;}
          const turn=turnsOf(observed.snapshot.state).find(t=>t.id===summary.turnId),time=Number(turn?.turnStartedAtMs??turn?.startedAtMs);
          monitored.set(b.threadId,{id:'conversation:'+b.threadId,nativeId:b.threadId,kind:'conversation',appId:b.appId,name:summary.title||'KSF 对话',project:b.project?.name,status:['question','approval'].includes(summary.status)?'waiting':summary.status,version:observed.version,turnId:summary.turnId,startedAt:time>0?new Date(time).toISOString():null,actions:summary.turnId?['stop']:[],resourceNote:'共享的 Codex Desktop 资源不可分摊',historyScope:'已明确关联的活跃轮次'});
        }catch(error){issues.push({source:'conversations',code:error.code??'CODEX_OFFLINE',message:error.message});const previous=monitored.get(b.threadId);if(previous)monitored.set(b.threadId,{...previous,status:'unknown',actions:[],error:{message:error.message}});}}})).finally(()=>{monitorAt=Date.now();monitorIssues=[...new Map(issues.map(i=>[i.code,i])).values()];jobs.delete(monitorRefresh);monitorRefresh=null;});
        jobs.add(monitorRefresh);
      }
      return {tasks:[...monitored.values()],issues:[...monitorIssues,...(monitorRefresh?[{source:'conversations',code:'MONITOR_LOADING',message:'正在核实已关联的对话状态…'}]:[])]};
    },
    async monitorInterrupt(input){const b=binding(input.threadId),observed=await observe(input.threadId,true);assert(observed.version===input.version,'MONITOR_STALE','对话状态已经变化，请刷新。');return service.interrupt({appId:b.appId},{operationId:input.operationId,threadId:input.threadId,expectedTurnId:input.turnId});},
    async check(caller, params = {}) {
      callerOK(caller); keys(params, []);
      try { supported(); const permissions = workbenchPermissions(root), executable = await (options.locateCLI ?? locateCLI)(); await ipc.connect(); return { available: true, contractVersion: 'codex-conversations-v1', executable, platform, permissions }; }
      catch (error) { return { available: false, contractVersion: 'codex-conversations-v1', code: error.code ?? 'CODEX_OFFLINE', message: error.message, platform }; }
    },
    create(caller, params) {
      keys(params, ['operationId', 'project', 'text', 'title','executionGrant']); textInput(params.text);
      const p = checkedProject(params.project); const title = params.title ?? params.text.trim().split('\n')[0].slice(0, 80);
      assert(typeof title === 'string' && title.trim().length && title.length <= 200, 'CODEX_ARGUMENT', '对话名称需要 1 至 200 个字符。');
      return queue(caller, 'create', params, async key => {
        const execution=params.executionGrant?await (options.prepareDesktopExecution??prepareDesktopExecution)(root,caller,params.executionGrant,await (options.locateCLI??locateCLI)(),p):null;
        await ipc.connect();
        const threadId = await draft({ root, name: title,execution, async onCreated(id, metadata = {}) {
          update(key, { threadId: id });
          store.change(state => { state.bindings[id] = { schemaVersion: 1, threadId: id, project: { name: p.name, scope: p.scope, path: p.path }, desktopProjectId: metadata.desktopProjectId ?? null, appId: caller.appId, createdAt: new Date().toISOString(), pendingRoute: true,...(execution?{execution}:{}), permissionProfile: metadata.permissionProfile ?? null }; });
        } });
        update(key, { status: 'opening', threadId }); catalogAt = 0;
        await open(threadId); await ipc.owner(threadId, { waitMs: 10000 });
        const snapshot = await ipc.load(threadId, { fresh: true });
        assert(!turnsOf(snapshot.state).length, 'CODEX_DRAFT_CHANGED', '草稿已在 Desktop 开始，请在原会话接续。');
        const text = execution?params.text:`KSF 项目定位（不是另一套运行规则）：\n${JSON.stringify({ name: p.name, scope: p.scope, projectCard: p.path, workingDirectory: root })}\n本轮操作范围以以下用户原文为准；请通过当前 KSF 的 AGENTS.md 与 ksf-runtime 处理项目、能力路由和会话状态。\n\n--- 用户原文开始 ---\n${params.text}\n--- 用户原文结束 ---`;
        await dispatch(key, threadId, snapshot, 'thread-follower-start-turn', 2, startParams(threadId, text), text);
      });
    },
    async attach(caller, params) {
      supported(); callerOK(caller); keys(params, ['taskId', 'project']);
      assert(typeof params.taskId === 'string' && /^[a-f0-9]{64}$/.test(params.taskId), 'CODEX_ARGUMENT', '聊天档案标识无效。');
      const p = checkedProject(params.project), task = readTask({ root, taskId: params.taskId, includeMessages: false, target: `${p.scope}:${p.name}` });
      assert(task.targetContext?.turnCount > 0, 'CODEX_ATTACHMENT_MISMATCH', '档案没有该项目的明确归属记录。');
      const matches = nativeCatalog(true).filter(item => sessionKey(root, { host: 'codex', sessionId: item.id }) === params.taskId);
      if (matches.length !== 1 || resolve(matches[0].meta.cwd) !== root) return { attached: false, reason: '无法可靠对应当前 KSF 根的原生线程，保持只读。' };
      const threadId = matches[0].id;
      store.change(state => { state.bindings[threadId] ??= { schemaVersion: 1, threadId, project: { name: p.name, scope: p.scope, path: p.path }, appId: caller.appId, createdAt: new Date().toISOString() }; });
      return { attached: true, threadId, taskId: params.taskId };
    },
    async read(caller, params) {
      callerOK(caller); keys(params, ['threadId']); return view(params.threadId, await observe(params.threadId));
    },
    async history(caller, params) {
      callerOK(caller); keys(params, ['threadId', 'offset', 'limit', 'version']);
      const offset = params.offset ?? 0, limit = params.limit ?? 20;
      assert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'CODEX_ARGUMENT', '历史分页需要非负位置及 1 至 50 条上限。');
      const observed = await observe(params.threadId);
      assert(!params.version || params.version === observed.version, 'CODEX_HISTORY_CHANGED', '聊天历史已更新，请重新加载分页。');
      return { ...pageMessages(observed.messages, offset, limit), version: observed.version };
    },
    send(caller, params) {
      keys(params, ['operationId', 'threadId', 'text', 'mode', 'expectedTurnId','executionGrant']); textInput(params.text); binding(params.threadId);
      assert(['new', 'steer'].includes(params.mode), 'CODEX_ARGUMENT', '请选择新一轮或明确补充本轮。');
      if (params.mode === 'steer') assert(validId(params.expectedTurnId), 'CODEX_ARGUMENT', '补充本轮需要准确轮次。');
      return queue(caller, 'send', params, async key => {
        const linked=binding(params.threadId);if(linked.execution){assert(params.executionGrant?.taskId===linked.execution.grant.taskId&&linked.appId===caller.appId,'CODEX_EXECUTION_GRANT','受限会话必须提供原任务授权。');const execution=await (options.prepareDesktopExecution??prepareDesktopExecution)(root,caller,params.executionGrant,await (options.locateCLI??locateCLI)(),linked.project);store.change(state=>{state.bindings[params.threadId].execution=execution;});}
        const observed = await observe(params.threadId, true), turnId = activeTurn(observed.snapshot.state);
        assert(params.mode === 'steer' ? turnId && turnId === params.expectedTurnId : !turnId, 'CODEX_TURN_CHANGED', '轮次状态已改变，请重新读取后选择发送或补充本轮。');
        await dispatch(key, params.threadId, observed.snapshot, params.mode === 'steer' ? 'thread-follower-steer-turn' : 'thread-follower-start-turn', params.mode === 'steer' ? 1 : 2, params.mode === 'steer' ? steerParams(params.threadId, params.text, params.operationId) : startParams(params.threadId, params.text), params.text);
      });
    },
    async events(caller, params) {
      callerOK(caller); keys(params, ['threadId', 'afterVersion']);
      const observed = await observe(params.threadId), changed = observed.version !== params.afterVersion;
      return { version: observed.version, changed, events: changed ? [{ seq: observed.seq, type: 'snapshot' }] : [], snapshot: changed ? view(params.threadId, observed) : null };
    },
    interrupt(caller, params) {
      keys(params, ['operationId', 'threadId', 'expectedTurnId']); binding(params.threadId); assert(validId(params.expectedTurnId), 'CODEX_ARGUMENT', '停止需要准确轮次。');
      return queue(caller, 'interrupt', params, async key => {
        const observed = await observe(params.threadId, true);
        assert(activeTurn(observed.snapshot.state) === params.expectedTurnId, 'CODEX_TURN_CHANGED', '此轮已结束或已切换，未发送停止。');
        await dispatch(key, params.threadId, observed.snapshot, 'thread-follower-interrupt-turn', 4, { conversationId: params.threadId, mode: 'user-stop', expectedTurnId: params.expectedTurnId });
      });
    },
    answer(caller, params) {
      keys(params, ['operationId', 'threadId', 'version', 'request', 'answers', 'planRevision']); binding(params.threadId);
      assert(typeof params.version === 'string', 'CODEX_ARGUMENT', '回答需要当前快照版本。');
      return queue(caller, 'answer', params, async key => {
        const observed = await observe(params.threadId, true), snapshot = observed.snapshot;
        assert(observed.version === params.version, 'CODEX_QUESTION_STALE', '问题或计划已更新，请重新读取。');
        if (params.planRevision) {
          const plan = planOf(snapshot.state); assert(plan && plan.revision === params.planRevision && !activeTurn(snapshot.state), 'CODEX_QUESTION_STALE', '计划已过期或有新轮次。');
          const text = 'PLEASE IMPLEMENT THIS PLAN:\n' + plan.text;
          await dispatch(key, params.threadId, snapshot, 'thread-follower-start-turn', 2, startParams(params.threadId, text), text); return;
        }
        const matches = questionsOf(snapshot.state).filter(q => sameRef(q.request, params.request));
        assert(matches.length === 1, 'CODEX_QUESTION_STALE', '该问题已过期或需要在 Desktop 处理。');
        const pending = matches[0]; keys(params.answers, pending.questions.map(q => q.id));
        for (const q of pending.questions) { const answer = params.answers[q.id]; assert(Array.isArray(answer) && answer.length === 1 && typeof answer[0] === 'string' && answer[0].trim().length && answer[0].length <= 8000, 'CODEX_ARGUMENT', '每个问题需要一个有效回答。'); }
        if (pending.asyncId) {
          const text = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: pending.asyncId, question: pending.questions[0].question, answer: params.answers[pending.questions[0].id][0] }]) + '\n</send_user_message_question_reply>';
          const active = activeTurn(snapshot.state);
          await dispatch(key, params.threadId, snapshot, active ? 'thread-follower-steer-turn' : 'thread-follower-start-turn', active ? 1 : 2, active ? steerParams(params.threadId, text, params.operationId) : startParams(params.threadId, text), text, 'dispatching');
        } else await dispatch(key, params.threadId, snapshot, 'thread-follower-submit-user-input', 1, { conversationId: params.threadId, requestId: refValue(params.request), response: { answers: Object.fromEntries(Object.entries(params.answers).map(([id, answers]) => [id, { answers }])) } }, undefined, 'dispatching');
        // An IPC acknowledgement does not prove the exact question was consumed.
        const verified = await observe(params.threadId, true);
        const stillPending = questionsOf(verified.snapshot.state).some(q => sameRef(q.request, params.request));
        update(key, { status: !stillPending && verified.snapshot.revision !== snapshot.revision ? 'succeeded' : 'unknown', ...(stillPending ? { error: { code: 'CODEX_ANSWER_UNCONFIRMED', message: 'Desktop 已确认收件，问题是否已消费仍待核对；不会自动重发。', outcomeUnknown: true } } : {}) });
      });
    },
    async executionFiles(caller,params){
      callerOK(caller);keys(params,['threadId']);const b=binding(params.threadId);assert(b.appId===caller.appId&&b.execution,'CODEX_EXECUTION_GRANT','会话不属于本应用受限执行。');
      await createExecutionGrants(root).resolveGrant(caller,b.execution.grant);const observed=await observe(params.threadId,true);assert(!activeTurn(observed.snapshot.state),'CODEX_TURN_CHANGED','原运行仍在执行。');
      return collectExecutionArtifacts(b.execution.work,b.execution.before,join(root,'.agents/runtime-data/cooperation-desktop',b.execution.grant.taskId,'artifacts'));
    },
    async openDesktop(caller, params) { supported(); callerOK(caller); keys(params, ['threadId']); binding(params.threadId); await open(params.threadId); return { opened: true }; },
    async operation(caller, params) {
      keys(params, ['operationId']); const key = opKey(caller, params.operationId); let op = store.read().operations[key];
      assert(op, 'CODEX_OPERATION_MISSING', '没有找到此操作回执。');
      if (!terminal(op) && !alive(op.pid)) {
        op = store.change(state => { const value = state.operations[key]; value.status = 'unknown'; value.error = { code: 'CODEX_SERVICE_RESTARTED', message: '原服务已退出，保留原线程待核对；不会重新派发。', outcomeUnknown: true }; return value; });
      }
      // Reconcile only a new canonical native message with the exact dispatched text.
      if (op.status === 'unknown' && op.threadId && op.inputDigest) {
        try {
          const observed = await observe(op.threadId, true);
          const matches = observed.messages.filter(m => m.role === 'user' && !(op.beforeItems ?? []).includes(m.id) && digest(m.text) === op.inputDigest);
          if (matches.length === 1) op = store.change(state => { const value = state.operations[key]; value.status = 'accepted'; value.turnId = matches[0].turnId; value.error = null; return value; });
        } catch {} // Observation failure cannot authorize another dispatch.
      }
      return operationView(op);
    },
    async close() {
      const item = pool.get(root); if (item?.service === service && --item.refs > 0) return;
      pool.delete(root); closed = true; clearInterval(timer); ipc.off('snapshot', onSnapshot); ipc.off('invalidate', onInvalidate); ipc.close();
      await Promise.allSettled([...jobs, ...refreshes.values()]);
    },
  };
  if (!options.isolated) pool.set(root, { refs: 1, service });
  return service;
}
