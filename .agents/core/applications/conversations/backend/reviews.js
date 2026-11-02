import { suggestionUpdate, suggestionHandoff } from './suggestion-delivery.js';
import { desktopRequest, desktopStep } from './review-desktop.js';
import { resolveReviewCapability } from './review-capability.js';
import { createReviewDB } from './review-db.js';
import { workPeriods } from './work-stats.js';
import { POLICY_VERSION, digest, problem, check, shiftDay, localClock, instant, validDate, extractionSchema, reportSchema, extractInstruction, reportInstruction, validateCitations, archiveBlockers } from './review-model.js';

const defaults = { enabled: false, profileId: '', executionKind: 'task', desktopProject: null, timeZone: 'Asia/Shanghai', time: '06:00', activatedDate: null };
const keyFor = t => `${t.taskId}/${t.turnId}`;
const sourceId = (turn, message) => 's-' + digest([turn.taskId, turn.turnId, turn.revision, message.id]).slice(0, 24);
const terminal = ['failed', 'cancelled', 'reconciling'];
const safeError = error => ({ code: error.code ?? 'REVIEW_FAILED', message: error.message ?? '工作回顾失败，已有记录已保留。' });

export function createReviews(context, { now = Date.now, timerMs = 2000, userDB, runtimeDB } = {}) {
  const user = userDB ?? createReviewDB(context.dataDirectory), runtime = runtimeDB ?? createReviewDB(context.runtimeDataDirectory, 'review-runs.sqlite');
  const call = (service, method, ...params) => context.services.call(service, method, params);
  let running = null, ticking = false, disposed = false, timer, scheduledAt = -Infinity;
  const stamp = () => new Date(now()).toISOString();
  const config = () => ({ ...defaults, ...user.get('config', 'main') });
  const metaCache=new Map();
  const reportMeta=r=>({id:r.id,date:r.date,edition:r.edition,revision:r.revision,state:r.state,reviewedAt:r.reviewedAt,createdAt:r.createdAt,supplementTo:r.supplementTo,workCount:r.workItems.length,suggestionCount:r.suggestionIds.length,...(r.scope?{scope:{taskId:r.scope.taskId}}:{})});
  function reportMetas(){
    const saved=new Map(user.list('report-meta').map(r=>[r.id,r]));
    for(const id of user.ids('report'))if(!saved.has(id)){if(!metaCache.has(id))metaCache.set(id,reportMeta(user.get('report',id)));saved.set(id,metaCache.get(id));}
    return [...saved.values()];
  }
  const bounds = (date, zone) => workPeriods(Date.parse(instant(date, '12:00', zone)), zone).today;
  async function sources(input = {}) {
    const records = [], chats = new Map(), errors = new Map(); let offset = 0, capture;
    do {
      const page = await call('tasks', 'reviewSources', { ...input, offset, limit: 100 });
      records.push(...page.records); for (const chat of page.chats) chats.set(chat.taskId, chat);
      for (const error of page.errors) errors.set(JSON.stringify(error), error); capture = page.capture; offset = page.nextOffset;
    } while (offset !== null);
    return { records, chats: [...chats.values()], errors: [...errors.values()], capture };
  }
  async function requireSuggestionSources(suggestion) {
    const snapshot = await sources(), allowed = new Set(snapshot.records.map(keyFor));
    check(suggestion.evidence?.length && suggestion.evidence.every(e => allowed.has(keyFor(e))), '建议引用的来源当前不允许读取。', 'REVIEW_SOURCE_UNAVAILABLE');
  }
  async function readTurn(turn) {
    const messages = []; let offset = 0, record;
    do { record = await call('tasks', 'readReviewTurn', { taskId: turn.taskId, turnId: turn.turnId, revision: turn.revision, offset, limit: 32 }); messages.push(...record.messages); offset = record.nextOffset; } while (offset !== null);
    check(record.digest === turn.digest, '原轮次已变化，需要重新生成回顾。', 'TASK_REVIEW_CONFLICT');
    return { ...record, messages };
  }
  async function configure(input) {
    check(typeof input.enabled === 'boolean' && typeof input.profileId === 'string' && input.profileId.length < 200 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time), '回顾设置无效。');
    localClock(now(), input.timeZone);
    const executionKind = input.executionKind ?? 'task';
    check(['task', 'desktop'].includes(executionKind), 'AI 路径无效。');
    let desktopProject = null;
    if (executionKind === 'desktop') {
      check(input.desktopProject && typeof input.desktopProject.name === 'string' && ['current','archived'].includes(input.desktopProject.scope), '请选择 Desktop 对话所属项目。', 'REVIEW_PROJECT_REQUIRED');
      desktopProject = { name: input.desktopProject.name, scope: input.desktopProject.scope };
      const selected = await call('projects', 'read', desktopProject);
      check(selected.data?.project && !selected.errors?.length, '所选项目当前不可读取。', 'REVIEW_PROJECT_REQUIRED');
      await resolveReviewCapability(call);
    } else {
      if (input.enabled) check(input.profileId, '请先选择 AI 执行配置。', 'REVIEW_PROFILE_REQUIRED');
      if (input.profileId) { const available = await call('ai', 'describe'); check(available.profiles.some(p => p.id === input.profileId), '所选 AI 执行配置当前不可用。', 'REVIEW_PROFILE_REQUIRED'); }
    }
    const previous = config(), next = { enabled: input.enabled, executionKind, desktopProject, profileId: executionKind === 'desktop' ? '' : input.profileId, timeZone: input.timeZone, time: input.time, activatedDate: previous.activatedDate ?? (input.enabled ? localClock(now(), input.timeZone).date : null) };
    user.put('config', 'main', next); return next;
  }
  async function step(run, id, instruction, input, schema) {
    const stepKey = run.id + ':' + id;
    let saved = runtime.get('step', stepKey);
    if (run.executionKind === 'desktop') {
      if (!saved) { saved = { id: stepKey, kind: 'desktop', request: desktopRequest(run, id, instruction, input, schema), state: 'prepared', output: null }; runtime.put('step', stepKey, saved); }
      try { return await desktopStep({ saved, persist: () => runtime.put('step', stepKey, saved), call, now }); }
      catch (error) {
        if (['REVIEW_DESKTOP_FAILED','REVIEW_DESKTOP_FORMAT','REVIEW_RECONCILING'].includes(error.code)) throw error;
        throw problem('REVIEW_RECONCILING', 'Desktop 原请求需核对：' + (error.message ?? String(error)));
      }
    }
    if (!saved) {
      const request = { contractVersion: 'ai-task-v1', idempotencyKey: 'review:' + digest([run.id, id, POLICY_VERSION]), profileId: run.profileId,
        instruction, inputs: [{ kind: 'text', name: id, text: JSON.stringify(input) }], outputSpec: { format: 'json', schema }, context: { businessRunId: run.id, stepId: id } };
      saved = { id: stepKey, request, aiTaskId: null, state: 'prepared', output: null }; runtime.put('step', stepKey, saved);
    }
    if (saved.state === 'succeeded') return saved.output;
    if (!saved.aiTaskId) {
      const accepted = await call('ai', 'submit', saved.request); saved.aiTaskId = accepted.aiTaskId; saved.state = accepted.status; runtime.put('step', stepKey, saved);
    }
    const task = await call('ai', 'get', saved.aiTaskId);
    saved.state = task.status; runtime.put('step', stepKey, saved);
    if (terminal.includes(task.status)) throw problem(task.status === 'reconciling' ? 'REVIEW_RECONCILING' : 'REVIEW_AI_FAILED', task.error?.message ?? '原 AI 任务需要核对，请检查执行记录。');
    if (task.status !== 'succeeded') return null;
    const result = await call('ai', 'readResult', saved.aiTaskId);
    saved.output = result.value; saved.state = 'succeeded'; saved.request = null; runtime.put('step', stepKey, saved); return saved.output;
  }
  function assembleChunks(turn, record, run) {
    const chunks = []; let messages = [], size = 0;
    for (const message of record.messages) {
      const id = sourceId(turn, message), day = message.at >= run.startAt && message.at < run.endAt;
      run.sourceMap[id] = { sourceId: id, taskId: turn.taskId, turnId: turn.turnId, revision: turn.revision, messageId: message.id, at: message.at,
        inDay: day, title: turn.title, excerpt: message.text.slice(0, 320), timeKnown: message.timeKnown };
      if (message.truncated) run.gaps.push({ taskId: turn.taskId, turnId: turn.turnId, code: 'REVIEW_CONTENT_LIMIT', message: '超长消息未完整进入本次审查，不能自动归档。' });
      // Split oversized messages without silently dropping their remaining visible text.
      const parts = message.text.match(/[\s\S]{1,22000}/g) ?? [''];
      for (const part of parts) {
        if (size + part.length > 26000 && messages.length) { chunks.push(messages); messages = []; size = 0; }
        messages.push({ sourceId: id, role: message.role, at: message.at, text: part }); size += part.length;
      }
    }
    if (messages.length) chunks.push(messages); return chunks;
  }
  async function prepare(date, manual, {force=false,operationId,taskId}={}) {
    const settings = config(); check(validDate(date), '需要有效的回顾日期。');
    check(date <= localClock(now(), settings.timeZone).date, '不能生成未来日期的回顾。');
    check(taskId === undefined || typeof taskId === 'string' && /^[a-f0-9]{64}$/.test(taskId), '需要查询返回的准确聊天编号。');
    const period = bounds(date, settings.timeZone), daily = await sources({ startAt: period.startAt, endAt: period.endAt, ...(taskId?{taskId}:{}) });
    if (taskId) check(daily.chats.some(c => c.taskId === taskId), '指定聊天当前没有允许回顾的来源。', 'REVIEW_SOURCE_UNAVAILABLE');
    const scope = taskId ? { taskId, title: daily.chats.find(c => c.taskId === taskId).title } : null;
    const capability = settings.executionKind === 'desktop' ? await resolveReviewCapability(call) : null;
    const inputDigest = digest([date, settings.timeZone, settings.executionKind === 'desktop' ? {kind:'desktop',project:settings.desktopProject,capability} : settings.profileId, POLICY_VERSION, daily.records.map(t => [t.taskId, t.turnId, t.digest]), daily.errors, ...(taskId?[{taskId}]:[])]);
    if(force)check(manual&&typeof operationId==='string'&&operationId.length>0&&operationId.length<160,'重新核对需要稳定操作编号。');
    const id = date + ':' + inputDigest.slice(0, 24)+(force?':refresh-'+digest(operationId).slice(0,12):''), existing = user.get('report', id), priorRun = runtime.get('run', id);
    if (existing || priorRun) return { id, state: existing ? 'ready' : priorRun.state, existing: true };
    const outstanding = runtime.list('run').find(r => r.date === date && (r.scope?.taskId??null) === (taskId??null) && ['preparing', 'extracting', 'synthesizing', 'reconciling'].includes(r.state));
    if (outstanding) return { id: outstanding.id, state: outstanding.state, existing: true };
    if (daily.records.length) check(settings.executionKind === 'desktop' ? settings.desktopProject : settings.profileId, '请先在回顾设置中选择 AI 执行配置。', 'REVIEW_PROFILE_REQUIRED');
    const run = { id, date, manual, inputDigest, ...(scope?{scope}:{}), profileId: settings.profileId, executionKind: settings.executionKind, desktopProject: settings.desktopProject, capability, timeZone: settings.timeZone, startAt: period.startAt, endAt: period.endAt,
      state: 'preparing', createdAt: stamp(), updatedAt: stamp(), chats: daily.chats, selectedTurns: daily.records.map(keyFor),
      turns: [], packets: [], sourceMap: {}, targets: {}, artifacts: [], gaps: daily.errors, capture: daily.capture, dayChatCount:daily.chats.length, error: null };
    runtime.put('run', id, run); return { id, state: run.state, existing: false };
  }
  async function collect(run) {
    run.turns = []; run.packets = []; run.sourceMap = {}; run.targets = {};
    const all = [], chats = [];
    for (const chat of run.chats) {
      try{
        const history = await sources({ taskId: chat.taskId }),current = history.chats[0];
        check(current?.fingerprint === chat.fingerprint,'此对话在读取期间变化，本版保留缺口，可重新核对补齐。','TASK_REVIEW_CONFLICT');
        all.push(...history.records); chats.push(current);run.gaps.push(...history.errors);
      }catch(error){run.gaps.push({taskId:chat.taskId,...safeError(error)});}
    }
    run.chats = chats;
    for (const chat of chats) run.targets['chat:' + chat.taskId] = { key:'chat:' + chat.taskId, name:chat.title, kind:'work', path:null, current:null, version:null };
    for (const turn of all) {
      let record;try{record=await readTurn(turn);}catch(error){run.gaps.push({taskId:turn.taskId,turnId:turn.turnId,...safeError(error)});continue;}
      const chunks = assembleChunks(turn, record, run);
      for (const target of [record.route?.ownership?.target, ...(record.route?.relatedTargets ?? []), ...(record.route?.abilities ?? [])].filter(Boolean)) {
        const key = target.targetId ?? target.path ?? target.ref; if (!key) continue;
        run.targets[key] ??= { key, name: target.name ?? key, kind: target.kind ?? 'ability', path: target.path, current: null, version: null, unavailable: null };
      }
      run.turns.push({ taskId: turn.taskId, turnId: turn.turnId, digest: turn.digest, revision: turn.revision });
      for (const [index, messages] of chunks.entries()) run.packets.push({ key: digest([POLICY_VERSION, run.executionKind === 'desktop' ? {kind:'desktop',project:run.desktopProject,...(run.capability?{capability:run.capability}:{})} : run.profileId, turn.digest, index, messages]), turnKey: keyFor(turn), taskId: turn.taskId, messages, route: record.route, status: record.status });
      if (!chunks.length || record.messages.some(m => !m.timeKnown)) run.gaps.push({ taskId: turn.taskId, turnId: turn.turnId, code: 'REVIEW_SOURCE_INCOMPLETE', message: '正文或消息时间缺失，保留日期不确定提示。' });
    }
    for (const target of Object.values(run.targets)) {
      if (!target.path) continue;
      try { const file = await call('workspace', 'read', target.path); target.current = file.text.slice(0, 18000); target.version = file.version; target.excerpt = file.text.length > 18000; }
      catch (error) { target.unavailable = safeError(error).message; }
    }
    const grouped = []; let group = [];
    const flush = () => { if (!group.length) return; grouped.push({ key: digest(group.map(p => p.key)), taskId: group[0].taskId, turnKey: group.map(p => p.turnKey).join(','),
      messages: group.flatMap(p => p.messages), routes: group.map(p => p.route), statuses: group.map(p => p.status) }); group = []; };
    for (const packet of run.packets) { if (group.length && (group.length >= 12 || group[0].taskId !== packet.taskId || JSON.stringify(group).length + JSON.stringify(packet).length > 29000)) flush(); group.push(packet); } flush();
    run.packets = grouped;
    run.collected = true; run.state = 'extracting'; run.updatedAt = stamp(); runtime.put('run', run.id, run);
  }
  async function advance(run) {
    if (run.state === 'preparing') await collect(run);
    const extracted = [];
    for (const packet of run.packets) {
      let output = runtime.get('extraction', packet.key);
      if (!output) {
        output = await step(run, 'extract-' + packet.key, extractInstruction, packet, extractionSchema);
        if (!output) { run.progress={completed:extracted.length,total:run.packets.length}; runtime.put('run',run.id,run); return; }
        validateCitations([...output.facts, ...output.artifacts], Object.fromEntries(packet.messages.map(m => [m.sourceId, true])));
        runtime.put('extraction', packet.key, output);
        const receipt = runtime.get('step', run.id + ':extract-' + packet.key)?.receipt;
        if (receipt) runtime.put('extraction-receipt', packet.key, receipt);
      }
      extracted.push({ taskId: packet.taskId, turnKey: packet.turnKey, ...output });
    }
    run.progress={completed:extracted.length,total:run.packets.length};runtime.put('run',run.id,run);
    if (!run.packets.length) {
      await publish(run, { summary: run.gaps.length ? '本日来源存在读取缺口，请核对采集。' : '本日没有已采集的工作记录。', workItems: [], findings: [], suggestions: [], chatClosures: [] }); return;
    }
    // Verify only explicitly cited workspace paths. Never follow arbitrary model-generated paths.
    if (!run.artifactsChecked) {
      for (const artifact of extracted.flatMap(p => p.artifacts)) {
        const path = artifact.path.replaceAll('\\', '/');
        if (!path || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.') || !artifact.citations.some(id => run.packets.some(p => p.messages.some(m => m.sourceId === id && m.text.includes(artifact.path))))) continue;
        if (run.artifacts.some(a => a.path === path)) continue;
        try { const file = await call('workspace', 'read', path); run.artifacts.push({ path, version: file.version, checkedAt: stamp(), state: 'current-file-readable', citations: artifact.citations }); }
        catch { run.artifacts.push({ path, checkedAt: stamp(), state: 'not-verified', citations: artifact.citations }); }
      }
      run.artifactsChecked = true; runtime.put('run', run.id, run);
    }
    run.state = 'synthesizing'; runtime.put('run', run.id, run);
    const compactSources = Object.fromEntries(Object.entries(run.sourceMap).map(([id, { taskId, inDay, at }]) => [id, { taskId, inDay, at }]));
    let summaries = extracted;
    for (let level = 0; JSON.stringify(summaries).length > 65000 && level < 5; level++) {
      const groups = []; let group = [], length = 0;
      for (const packet of summaries) { const size = JSON.stringify(packet).length; if (group.length && length + size > 28000) { groups.push(group); group = []; length = 0; } group.push(packet); length += size; } if (group.length) groups.push(group);
      const reduced = [];
      for (const [index, packets] of groups.entries()) {
        const output = await step(run, `reduce-${level}-${index}`, extractInstruction + ' 本批是带引用的事实提取结果。合并同一事项，保留不同目标、关键结果、未完成项与冲突，并原样保留必要 citations；不要新增事实。', { extracted: packets }, extractionSchema);
        if (!output) return; validateCitations([...output.facts, ...output.artifacts], run.sourceMap); reduced.push(output);
      }
      summaries = reduced;
    }
    const contextLimit = Math.max(300, Math.min(8000, Math.floor(35000 / Math.max(1, Object.keys(run.targets).length))));
    const compactTargets = Object.fromEntries(Object.entries(run.targets).map(([key, target]) => [key, { ...target, current: target.current?.slice(0, contextLimit), excerpt: true }]));
    const permittedSources = new Set(run.turns.map(keyFor));
    const input = { date: run.date, sourceMap: compactSources, extracted: summaries, targets: compactTargets, artifacts: run.artifacts, gaps: run.gaps,
      chats: run.chats.filter(c=>Object.values(run.sourceMap).some(s=>s.taskId===c.taskId)).map(c => ({ taskId: c.taskId, title: c.title })), priorSuggestions: user.list('suggestion').filter(s=>s.evidence?.length && s.evidence.every(e=>permittedSources.has(keyFor(e)))).map(({ id, key, status, problem, targetKey }) => ({ id, key, status, problem, targetKey })) };
    // The configured service enforces its material and context limits; never truncate evidence to fit.
    const output = await step(run, 'synthesis', reportInstruction, input, reportSchema); if (output) await publish(run, output);
  }
  async function publish(run, output) {
    // The source contract may have gained explicit gaps while an AI task was running.
    // Recheck metadata without replacing the historical evidence used by this edition.
    for(const chat of run.chats){
      try{
        const current=await sources({taskId:chat.taskId});
        if(current.chats[0]?.fingerprint!==chat.fingerprint)run.gaps.push({taskId:chat.taskId,code:'REVIEW_SOURCE_CHANGED',message:'生成期间来源变化，本版仍保留原引用，请补充回顾。'});
        for(const turn of current.records){
          const captured=run.turns.find(t=>keyFor(t)===keyFor(turn));if(!captured||captured.digest!==turn.digest)continue;
          for(const issue of turn.issues??[])run.gaps.push({taskId:turn.taskId,turnId:turn.turnId,code:issue.code,message:issue.message??'原始采集记录有待核对事项。',blocksArchive:issue.code!=='TASK_ROUTE_UNREPORTED'});
          const omitted=[...new Set(turn.messages.flatMap(m=>m.omittedContentTypes??[]))];
          if(omitted.length)run.gaps.push({taskId:turn.taskId,turnId:turn.turnId,code:'REVIEW_NON_TEXT_CONTENT',message:`原轮次包含未纳入文字审查的附件（${omitted.join('、')}），需人工核对。`});
        }
      }catch(error){run.gaps.push({taskId:chat.taskId,...safeError(error)});}
    }
    run.gaps=[...new Map(run.gaps.map(g=>[digest(g),g])).values()];
    validateCitations([...output.workItems, ...output.findings, ...output.suggestions, ...output.chatClosures], run.sourceMap);
    const dayIds = new Set(Object.values(run.sourceMap).filter(s => s.inDay).map(s => s.sourceId));
    check(output.workItems.every(w => w.citations.some(c => dayIds.has(c))), '工作事项没有当日证据。', 'REVIEW_CITATION_INVALID');
    const ids = new Set(run.chats.map(c => c.taskId));
    check(output.chatClosures.every(c => ids.has(c.taskId)) && new Set(output.chatClosures.map(c => c.taskId)).size === output.chatClosures.length, '收尾建议含有未知或重复聊天。');
    check(output.suggestions.every(s => s.targetKey === 'new' && s.type === 'capability' || Object.hasOwn(run.targets, s.targetKey)), '建议必须指向已知目标，新增仅用于能力候选。');
    const coverage = Object.fromEntries(run.turns.map(t => [keyFor(t), t.digest]));
    for (const gap of run.gaps) if (gap.taskId && gap.blocksArchive !== false) for (const turn of run.turns.filter(t => t.taskId === gap.taskId && (!gap.turnId || gap.turnId === t.turnId))) delete coverage[keyFor(turn)];
    const closures = run.chats.map(chat => {
      const proposed = output.chatClosures.find(c => c.taskId === chat.taskId), blockers = archiveBlockers(chat, coverage, run.endAt);
      if (!proposed?.closed) blockers.push(proposed?.reason ?? '没有足够证据确认聊天结束');
      if (proposed?.openItems.length || proposed?.unknownOperations.length) blockers.push('存在未交付事项或结果未知的操作');
      return { taskId: chat.taskId, title: chat.title, fingerprint: chat.fingerprint, eligible: !blockers.length, blockers: [...new Set(blockers)], reason: proposed?.reason ?? '', coverage };
    });
    const previous = reportMetas().filter(r => r.date === run.date && (r.scope?.taskId??null) === (run.scope?.taskId??null)).sort((a, b) => a.edition - b.edition);
    const report = { ...output, id: run.id, revision: 1, edition: previous.length + 1, supplementTo: previous.findLast(r => r.reviewedAt)?.id ?? null,
      execution: { kind: run.executionKind ?? 'task', profileId: run.profileId, project: run.desktopProject ?? null, ...(run.capability?{capability:run.capability}:{}) }, executionReceipts: [...new Map([...runtime.list('step').filter(s => s.id.startsWith(run.id + ':') && s.receipt).map(s => s.receipt), ...run.packets.map(p=>runtime.get('extraction-receipt',p.key)).filter(Boolean)].map(r=>[r.operationId,r])).values()],
      date: run.date, ...(run.scope?{scope:run.scope}:{}), createdAt: stamp(), reviewedAt: null, state: 'ready', startAt: run.startAt, endAt: run.endAt, inputDigest: run.inputDigest, policyVersion: POLICY_VERSION,
      sourceMap: run.sourceMap, turns: run.turns, chats: run.chats, coverage, closures, artifacts: run.artifacts, targets: run.targets, gaps: run.gaps, capture: run.capture, suggestionIds: [],
      activity: { chats: run.dayChatCount??run.chats.length, turns: run.selectedTurns.length },
      workItems: output.workItems.map(w => ({ ...w, evidenceBasis: 'reported' })) };
    user.transaction(() => {
      for (const suggestion of output.suggestions) {
        const id = 'suggestion-' + digest([suggestion.type, suggestion.targetKey, suggestion.key]).slice(0, 24), old = user.get('suggestion', id);
        const merged = { ...suggestion, targetLabel:run.targets[suggestion.targetKey]?.name ?? '新增能力候选', targetPath:run.targets[suggestion.targetKey]?.path ?? null, id, status: old?.status ?? 'pending', createdAt: old?.createdAt ?? stamp(), updatedAt: stamp(), revision: (old?.revision ?? 0) + 1,
          evidence: [...new Map([...(old?.evidence ?? []), ...suggestion.citations.map(c => run.sourceMap[c])].map(s => [s.sourceId, s])).values()], reportIds: [...new Set([...(old?.reportIds ?? []), report.id])], resolution: old?.resolution ?? null, ...(old?.delivery ? {delivery:old.delivery} : {}) };
        user.put('suggestion', id, merged); report.suggestionIds.push(id);
      }
      report.suggestionIds=[...new Set(report.suggestionIds)];
      user.put('report', report.id, report);user.put('report-meta',report.id,reportMeta(report));
    });
    run.state = 'ready'; run.updatedAt = stamp();run.packets=[];run.targets={};run.sourceMap={};run.turns=[]; runtime.put('run', run.id, run);
  }
  async function pump() {
    if (running || disposed) return running;
    const pending = runtime.list('run').filter(r => ['preparing', 'extracting', 'synthesizing'].includes(r.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const run = pending[0]; if (!run) return;
    const action = async () => {
      try { await advance(run); }
      catch (error) {
        const disconnected=['APP_PROCESS_EXITED','APP_HOST_CLOSED','SERVICE_STOPPING','AI_SERVICE_STOPPING','APP_BUSY','APP_CALL_TIMEOUT','APP_SERVICE_TIMEOUT'].includes(error.code);
        run.state = disconnected ? (run.collected?'extracting':'preparing') : error.code === 'REVIEW_RECONCILING' ? 'reconciling' : 'failed';
        run.error = safeError(error); run.updatedAt = stamp(); runtime.put('run', run.id, run);
      }
    };
    running = (context.tasks?.run ? context.tasks.run(action, { name: '每日工作回顾', cancellable: false }) : action()).catch(error=>{
      if(!disposed)try{runtime.put('diagnostic','last',{...safeError(error),at:stamp()});}catch{/* Keep a damaged store intact. Reads expose the storage error. */}
    }).finally(() => { running = null; }); return running;
  }
  async function tick() {
    if (ticking || disposed) return; ticking = true;
    try {
      const settings = config(), clock = localClock(now(), settings.timeZone);
      if (settings.enabled && (settings.executionKind === 'desktop' ? settings.desktopProject : settings.profileId) && settings.activatedDate && now()-scheduledAt>=30000) {
        scheduledAt=now();
        const through = shiftDay(clock.date, clock.time >= settings.time ? -1 : -2);
        // Queue one missing day per tick, oldest first, including empty days without AI calls.
        for (let date = settings.activatedDate; date <= through; date = shiftDay(date, 1)) {
          if (reportMetas().some(r => r.date === date && !r.scope) || runtime.list('run').some(r => r.date === date && !r.scope)) continue;
          await prepare(date, false); break;
        }
        // Detect delayed capture in recent reviewed days; same fingerprint recovers the same run.
        const recent = reportMetas().filter(r => !r.scope && r.date >= settings.activatedDate && r.date <= through);
        if (recent.length) await prepare(recent.sort((a, b) => a.date.localeCompare(b.date))[Number(now() / timerMs) % recent.length | 0].date, false);
      }
      await pump();
    } catch (error) { try{runtime.put('diagnostic', 'last', { ...safeError(error), at: stamp() });}catch{/* Preserve storage failures without an unhandled background rejection. */} }
    finally { ticking = false; }
  }
  async function confirm({ id, revision, archiveTaskIds = [], operationId }) {
    check(typeof operationId === 'string' && operationId.length > 0 && operationId.length < 160, '审阅需要稳定操作编号。');
    const requestDigest=digest([id,revision,[...archiveTaskIds].sort()]);
    const prior = user.get('operation', operationId); if (prior) { check(prior.id === id&&(!prior.requestDigest||prior.requestDigest===requestDigest), '操作编号已用于不同的审阅内容。','REVIEW_CONFLICT'); return prior; }
    const report = user.get('report', id); check(report && report.revision === revision, '报告已变化，请重新读取。', 'REVIEW_CONFLICT');
    check(!report.reviewedAt && Array.isArray(archiveTaskIds) && archiveTaskIds.every(t => report.closures.some(c => c.taskId === t && c.eligible)), '报告已审阅或包含不可归档聊天。');
    const archived = [], skipped = [];
    for (const taskId of archiveTaskIds) {
      const current = await sources({ taskId }), chat = current.chats[0], expected = report.closures.find(c => c.taskId === taskId);
      if (!chat || current.errors.length || chat.fingerprint !== expected.fingerprint || archiveBlockers(chat, report.coverage, report.endAt).length) skipped.push({ taskId, reason: '来源已变化或证据覆盖存在缺口' });
      else archived.push({ taskId, fingerprint: chat.fingerprint, latestMessageAt: chat.latestMessageAt });
    }
    // Check every source before approving this version, even when the user deselects archiving.
    const stale = [];
    for (const chat of report.chats) { const current = await sources({ taskId: chat.taskId }); if (current.chats[0]?.fingerprint !== chat.fingerprint || current.errors.length) stale.push(chat.taskId); }
    const receipt = { id, operationId, requestDigest, reviewedAt: stamp(), archived: archived.filter(a => !stale.includes(a.taskId)).map(a => a.taskId), skipped: [...skipped, ...stale.filter(t => !skipped.some(s => s.taskId === t)).map(taskId => ({ taskId, reason: '报告生成后来源已变化，请查看补充回顾' }))] };
    return user.transaction(() => {
      const already=user.get('operation',operationId);if(already){check(already.requestDigest===requestDigest,'操作编号已用于不同的审阅内容。','REVIEW_CONFLICT');return already;}
      const current = user.get('report', id); check(current.revision === revision && !current.reviewedAt, '报告已被另一窗口审阅。', 'REVIEW_CONFLICT');
      for (const turn of report.turns) if (report.coverage[keyFor(turn)] === turn.digest) user.put('reviewed-turn', keyFor(turn), { ...turn, reportId: id, reviewedAt: receipt.reviewedAt });
      for (const chat of archived.filter(a => receipt.archived.includes(a.taskId))) user.put('chat', chat.taskId, { ...user.get('chat', chat.taskId), ...chat, state: 'archived', archivedAt: receipt.reviewedAt, reportId: id });
      current.reviewedAt = receipt.reviewedAt; current.revision++; current.state = 'reviewed'; current.receipt = receipt; user.put('report', id, current);user.put('report-meta',id,reportMeta(current)); user.put('operation', operationId, receipt);return receipt;
    });
  }
  async function reconcileChats() {
    const archived = user.list('chat').filter(c => c.state === 'archived');
    for (const saved of archived) {
      const current = await sources({ taskId: saved.taskId }), chat = current.chats[0];
      if (!chat || current.errors.length || chat.fingerprint !== saved.fingerprint) user.put('chat', saved.taskId, { ...saved, state: 'active', reopenedAt: stamp(), reopenReason: '新增工作或来源变化' });
    }
  }
  async function chatReviewState({taskId}) {
    await reconcileChats();
    const snapshot=await sources({taskId}),chat=snapshot.chats[0];
    check(chat,'聊天不存在或当前不可读取。','TASK_REVIEW_UNAVAILABLE');
    const versions=chat.turns.filter(t=>t.allowed).map(turn=>{const reviewed=user.get('reviewed-turn',keyFor(turn));return{turnId:turn.turnId,revision:turn.revision,captureComplete:turn.status==='completed',reviewed:reviewed?.digest===turn.digest,reportId:reviewed?.digest===turn.digest?reviewed.reportId:null};});
    return{taskId,state:user.get('chat',taskId)?.state??'active',total:versions.length,captureComplete:versions.filter(t=>t.captureComplete).length,reviewed:versions.filter(t=>t.reviewed).length,versions,errors:snapshot.errors};
  }
  async function chatList({ target = '', q = '', state = 'active', limit = 30, offset = 0 } = {}) {
    check(['active', 'archived', 'all'].includes(state) && Number.isSafeInteger(limit) && limit > 0 && limit <= 10000 && Number.isSafeInteger(offset) && offset >= 0 && typeof q === 'string', '聊天筛选无效。');
    await reconcileChats();
    const snapshot = await sources(), records = [];
    for (const chat of snapshot.chats) {
      const turns = snapshot.records.filter(t => t.taskId === chat.taskId), match = turns.filter(t => !target || t.targets?.some(e => e.key === target) || targetFromRoute(t.route) === target);
      if (!match.length || q && !JSON.stringify([chat.title, ...turns.map(t => t.route)]).toLocaleLowerCase().includes(q.toLocaleLowerCase())) continue;
      const current = user.get('chat', chat.taskId)?.state ?? 'active'; if (state !== 'all' && state !== current) continue;
      records.push({ taskId: chat.taskId, title: chat.title, state: current, updatedAt: turns.at(-1)?.updatedAt, createdAt: turns[0]?.startedAt, turnCount: chat.turns.length,
        ownershipTargets: [...new Map(turns.flatMap(t => t.targets ?? []).map(e => [e.key, e])).values()],
        targetContexts: Object.fromEntries([...new Set(turns.flatMap(t => (t.targets ?? []).map(e => e.key)))].map(key => { const related = turns.filter(t => t.targets?.some(e => e.key === key)); return [key, { key, turnCount: related.length, latestTurnId: related.at(-1)?.turnId, latestReported: { reportedAt: related.at(-1)?.updatedAt } }]; })),
        lastTurn: turns.at(-1), latestReported: match.at(-1)?.route ? { turnId: match.at(-1).turnId, route: match.at(-1).route } : null,
        targetContext: target ? { turnCount: match.length, latestTurnId: match.at(-1)?.turnId, latestReported: { reportedAt: match.at(-1)?.updatedAt } } : undefined });
    }
    records.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { records: records.slice(offset, offset + limit), total: records.length, nextOffset: offset + limit < records.length ? offset + limit : null, capture: snapshot.capture, errors: snapshot.errors };
  }
  async function allChatRecords(params) {
    const records = []; let offset = 0, result;
    do { result = await chatList({ ...params, offset, limit: 100 }); records.push(...result.records); offset = result.nextOffset; } while (offset !== null);
    return { ...result, records, total: records.length, nextOffset: null };
  }
  async function catalog(params) {
    const list = await allChatRecords(params), targets = new Map();
    for (const record of list.records) for (const entry of record.ownershipTargets) {
      const previous = targets.get(entry.key) ?? { key: entry.key, kind: entry.target?.kind ?? 'state', label: entry.label, target: entry.target, chatCount: 0, turnCount: 0, aliases: [], lifecycle: entry.target?.lifecycle ?? null };
      previous.chatCount++; previous.turnCount += record.targetContexts[entry.key]?.turnCount ?? 0; targets.set(entry.key, previous);
    }
    return { targets: [...targets.values()], totalChats: list.total, capture: list.capture, errors: list.errors };
  }
  async function readableReport(id) {
    const report = user.get('report', id); if (!report) return null;
    const allowed = new Set();
    for (const chat of report.chats) {
      const current = await sources({ taskId: chat.taskId });
      for (const turn of current.chats[0]?.turns ?? []) if (turn.allowed) allowed.add(keyFor(turn));
    }
    const withdrawn = new Set(Object.values(report.sourceMap).filter(s => !allowed.has(keyFor(s))).map(s => s.sourceId));
    if (!withdrawn.size) return report;
    const permitted = item => item.citations.every(id => !withdrawn.has(id));
    const unavailableChats = new Set(Object.values(report.sourceMap).filter(s => withdrawn.has(s.sourceId)).map(s => s.taskId));
    return { ...report, ...(report.scope?{scope:{taskId:report.scope.taskId,title:'原始证据不可用的对话'}}:{}), summary: '部分原始证据已撤回或不可读取，相关派生内容已隐藏。',
      workItems: report.workItems.filter(permitted), findings: report.findings.filter(permitted), suggestions: report.suggestions.filter(permitted),
      sourceMap: Object.fromEntries(Object.entries(report.sourceMap).filter(([id]) => !withdrawn.has(id))),
      chatClosures: report.chatClosures.filter(c => !unavailableChats.has(c.taskId)), chats: report.chats.filter(c => !unavailableChats.has(c.taskId)),
      artifacts: report.artifacts.filter(a => (a.citations ?? []).every(id => !withdrawn.has(id))),
      closures: report.closures.map(c => ({ ...c, title: unavailableChats.has(c.taskId) ? '原始证据不可用的对话' : c.title, reason: '', eligible: false, blockers: ['原始证据当前不可用'] })), sourceUnavailable: true };
  }
  async function overview() {
    const settings = config(), today = localClock(now(), settings.timeZone).date, period = bounds(today, settings.timeZone), snapshot = await sources({ startAt: period.startAt, endAt: period.endAt });
    const reports = reportMetas().sort((a, b) => b.date.localeCompare(a.date) || b.edition - a.edition);
    return { config: settings, today, activity: { chats: snapshot.chats.length, turns: snapshot.records.length }, capture: snapshot.capture, errors: snapshot.errors,
      reports,
      runs: runtime.list('run').filter(r=>r.state!=='failed'||!reports.some(report=>report.id.startsWith(r.id+':retry-'))).map(r=>({id:r.id,date:r.date,...(r.scope?{scope:{taskId:r.scope.taskId}}:{}),state:r.state,error:r.error,createdAt:r.createdAt,progress:r.progress??{completed:0,total:r.packets.length}})).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      pendingSuggestions: ['pending','accepted','in_progress'].reduce((n,status)=>n+user.countStatus('suggestion',status),0), diagnostic: runtime.get('diagnostic', 'last') };
  }
  async function invoke(method, params = {}) {
    if (method === 'review.overview') return overview();
    if (method === 'review.profiles') {
      const [tasks, desktop, projects, capability] = await Promise.allSettled([call('ai', 'describe'), call('codex-conversations', 'check'), call('projects', 'list', {scope:'all'}), resolveReviewCapability(call)]);
      return { profiles: tasks.status === 'fulfilled' ? tasks.value.profiles : [], desktop: desktop.status === 'fulfilled' ? desktop.value : {available:false,message:desktop.reason.message}, capability: capability.status === 'fulfilled' ? capability.value : null, capabilityIssue: capability.status === 'rejected' ? safeError(capability.reason) : null, projects: projects.status === 'fulfilled' ? projects.value.data.projects : [], issues: [tasks, projects].filter(r=>r.status==='rejected').map(r=>safeError(r.reason)) };
    }
    if (method === 'review.configure') return configure(params);
    if (method === 'review.generate') { const accepted = await prepare(params.date, true, params); void pump(); return accepted; }
    if (method === 'review.read') return readableReport(params.id);
    if (method === 'review.confirm') return confirm(params);
    if (method === 'review.resume') { const run = runtime.get('run', params.id); check(run && !['ready'].includes(run.state), '没有可恢复的任务。'); run.state = run.collected ? 'extracting' : 'preparing'; run.error = null; runtime.put('run', run.id, run); void pump(); return { id: run.id, state: run.state }; }
    if (method === 'review.retry') {
      const original = runtime.get('run', params.id); check(original?.state === 'failed' && typeof params.operationId === 'string' && params.operationId.length > 0 && params.operationId.length < 160, '只能显式重试已确认失败的任务。');
      const recovering=runtime.list('run').find(r=>r.id.startsWith(original.id+':retry-')&&['preparing','extracting','synthesizing','reconciling','ready'].includes(r.state));
      if(recovering)return{id:recovering.id,state:recovering.state,existing:true};
      const id = original.id + ':retry-' + digest(params.operationId).slice(0, 12), prior = runtime.get('run', id); if (prior) return { id, state: prior.state };
      for (const step of runtime.list('step').filter(s => s.id.startsWith(original.id + ':') && s.aiTaskId && s.state !== 'succeeded')) {
        const current = await call('ai', 'get', step.aiTaskId); check(['failed','cancelled','succeeded'].includes(current.status) && !current.error?.outcomeUnknown, '原执行结果仍未知，不能重提。', 'REVIEW_RECONCILING');
      }
      for (const step of runtime.list('step').filter(s => s.id.startsWith(original.id + ':') && s.kind === 'desktop' && s.state !== 'succeeded')) {
        const operation = await call('codex-conversations', 'operation', {operationId:step.request.operationId});
        check(!operation.error?.outcomeUnknown && (operation.status === 'failed' || ['accepted','succeeded'].includes(operation.status) && (await call('codex-conversations','read',{threadId:operation.threadId})).status === 'idle' && step.state === 'failed'), 'Desktop 原执行仍运行或结果未知，请恢复原任务。', 'REVIEW_RECONCILING');
      }
      // Retrying the same frozen inputs must not resubmit successful reduction work.
      for(const saved of runtime.list('step').filter(s=>s.id.startsWith(original.id+':reduce-')&&s.state==='succeeded')){
        try{validateCitations([...saved.output.facts,...saved.output.artifacts],original.sourceMap);}catch{continue;}
        const inheritedId=id+saved.id.slice(original.id.length);runtime.put('step',inheritedId,{...saved,id:inheritedId,inheritedFrom:saved.id});
      }
      const run = { ...original, id, state: original.collected ? 'extracting' : 'preparing', error: null, createdAt: stamp(), updatedAt: stamp() }; runtime.put('run', id, run); void pump(); return {id,state:run.state};
    }
    if (method === 'suggestions.list') {
      const snapshot = await sources(), allowed = new Set(snapshot.records.map(keyFor));
      return user.list('suggestion').filter(s => s.evidence.every(e => allowed.has(keyFor(e))) && (!params.status || s.status === params.status) && (!params.type || s.type === params.type) && (!params.targetKey || s.targetKey === params.targetKey));
    }
    if (method === 'suggestions.handoff') {
      const old = user.get('suggestion', params.id); check(old && old.revision === params.revision, '建议已变化，请刷新。', 'REVIEW_CONFLICT');
      await requireSuggestionSources(old);
      check(user.get('suggestion', params.id)?.revision === params.revision, '建议已变化，请刷新。', 'REVIEW_CONFLICT');
      return { id: old.id, revision: old.revision, text: suggestionHandoff(old) };
    }
    if (method === 'suggestions.update') {
      const next = suggestionUpdate(user.get('suggestion', params.id), params, stamp());
      if (params.delivery) for (const path of next.delivery.evidence) {
        if (/^https?:\/\//i.test(path)) continue;
        check(!path.startsWith('/') && !path.startsWith('.agents/') && !path.split('/').some(v => !v || v === '.' || v === '..'), '证据须为普通业务原件的 KSF 内相对路径。');
        await call('workspace', 'read', path);
      }
      await requireSuggestionSources(next);
      // Evidence IO can yield; recheck before publication so another reviewer
      // cannot be overwritten while this result is being validated.
      check(user.get('suggestion', params.id)?.revision === params.revision, '建议已变化，请刷新。', 'REVIEW_CONFLICT');
      user.put('suggestion', next.id, next); return next;
    }
    if (method === 'chats.list') return chatList(params);
    if (method === 'chats.reviewState') return chatReviewState(params);
    if (method === 'chats.targets') return catalog(params);
    if (method === 'chats.search') {
      const list = await allChatRecords(params), groups = {};
      for (const record of list.records) for (const entry of record.ownershipTargets) {
        const group = groups[entry.key] ??= { ...list, records: [], total: 0, nextOffset: null };
        group.records.push({ ...record, targetContext: record.targetContexts[entry.key] }); group.total++;
      }
      return { groups, errors: list.errors };
    }
    if (method === 'chats.restore') { const old = user.get('chat', params.taskId); if (old) user.put('chat', params.taskId, { ...old, state: 'active', reopenedAt: stamp(), reopenReason: '用户恢复' }); return { taskId: params.taskId, state: 'active' }; }
    throw problem('APP_CALL_INVALID', '未知对话应用方法。');
  }
  return { call: invoke, tick, pump, async startBackground() { timer = setInterval(() => void tick(), timerMs); timer.unref?.(); void tick(); }, async dispose() { disposed = true; clearInterval(timer); await running; user.close(); runtime.close(); } };
}

function targetFromRoute(route) {
  const target = route?.ownership?.target;
  if (!target) return route?.ownership ? 'state:' + route.ownership.state : 'unreported';
  if (target.targetId) return 'target:' + target.targetId;
  if (target.kind === 'project') return `${target.scope}:${target.name}`;
  if (target.kind === 'ability') return `ability:${target.source}:${target.id}`;
  return `${target.kind}:${target.path}`;
}
