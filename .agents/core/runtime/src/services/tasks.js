import {readConfigFile,expectConfig,publishConfigFile} from '../configuration/storage.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { sessionKey } from '../routing/storage.js';
import { chatConfig, registerChatTurn, readChatContext } from './chat.js';
import { formatChatContext } from '../chat-state/context.js';
import { nativeTurnsSince } from '../task-capture/codex.js';
import { encode, fail, isToken } from '../routing/schema.js';
import { sha256 } from '../shared/hash.js';
import { declareTask, receipts } from '../task-capture/declarations.js';
import { discover, sourceMeta, belongsToRoot, isInternalSession, parseTranscript, titles, messageDigest, TRANSCRIPT_ADAPTER_VERSION } from '../task-capture/codex.js';
import { CAPTURE, ARCHIVE, PROTOCOL, config, locked, readJSON, writeJSON, taskPath, turnPath, readTurn, taskIds, turns, summarizeTurn, rebuildTask } from '../task-capture/storage.js';
import { definitionContext, decorateRecord, verifyTargetSnapshot } from '../routing/definitions.js';
import { turnProjects, ownedProjects, turnRelation, projectContext, historyText } from '../task-capture/projects.js';
import { capturePolicy } from '../task-capture/policy.js';
import { physicalTargetKey } from '../routing/target-identity.js';
import { targetRegistry, withTargetLock, acceptTargetChanges } from '../routing/target-registry.js';
import { readUserData } from './user-data.js';
import { ownershipOf } from '../routing/targets.js';
import { turnTargets, ownedTargets, targetRelation, targetContext, targetHistoryText } from '../task-capture/targets.js';
import { currentTargetKey } from '../objects/legacy.js';
import { platform } from '../platform/index.js';

export { declareTask };
const now = () => new Date().toISOString();
const capturePolicyVersion = 3;
const codexHome = env => env.CODEX_HOME || join(homedir(), '.codex');
const issue = error => ({ code: error.code ?? 'TASK_CAPTURE_FAILED', message: error.code ? error.message : 'Cannot capture the local transcript.' });
const hookCommand = root => platform.hookCommand(resolve(root));
function page(limit, offset) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('INVALID_ARGUMENTS', 'Use limit 1–100 and nonnegative offset.');
}
function decorate(root, snapshot, context = definitionContext(root)) {
  if (!snapshot) return null;
  context.snapshots ??= new Map();
  const key = encode(snapshot);
  if (!context.snapshots.has(key)) context.snapshots.set(key, decorateRecord(context, { current: snapshot, history: [] }).current);
  return context.snapshots.get(key);
}
function metadata(root, taskId, context, all = turns(root, taskId)) {
  if (!all.length) return null;
  const stored = readJSON(root, `${taskPath(taskId)}/task.json`);
  if (stored && (stored.protocol !== PROTOCOL || stored.taskId !== taskId)) fail('TASK_DATA_INVALID', 'Unsupported task metadata.');
  const route = all.at(-1).routes.at(-1);
  const reports = all.flatMap((turn, index) => turn.routes.map((event, eventIndex) => ({ turn, index, event, eventIndex })));
  reports.sort((a, b) => b.event.at.localeCompare(a.event.at) || b.index - a.index || b.eventIndex - a.eventIndex);
  const latest = reports[0];
  return { protocol: PROTOCOL, taskId, host: 'codex', title: (stored?.titleSource === 'host' ? stored.title : null) ?? all.map(summarizeTurn).find(t => t.preview)?.preview ?? 'Codex 任务',
    createdAt: all[0].startedAt, updatedAt: all.reduce((v, t) => v > t.updatedAt ? v : t.updatedAt, ''),
    turnCount: all.length, lastTurn: summarizeTurn(all.at(-1)), lastRouteAt: route?.at ?? null, route: decorate(root, route?.snapshot, context),
    latestReported: latest ? { turnId: latest.turn.turnId, roundId: latest.turn.roundId, turnNumber: latest.index + 1,
      eventId: latest.event.eventId, reportedAt: latest.event.at, route: decorate(root, latest.event.snapshot, context) } : null };
}
export function taskProjectKey(task) {
  const ownership = task.latestReported?.route && ownershipOf(task.latestReported.route);
  if (ownership?.state === 'bound' && (ownership.target.kind !== 'project' || ownership.target.lifecycle === 'planned')) return null;
  const project = task.latestReported?.route?.project;
  return !project ? 'unreported' : project.state !== 'bound' ? `state:${project.state}` : `${project.primary.scope}:${project.primary.name}`;
}
function queryArchive(root) {
  const records = [], errors = [], context = definitionContext(root);
  for (const id of taskIds(root)) {
    try {
      const all = turns(root, id, { onError(error, turnId) { errors.push({ taskId: id, turnId, ...issue(error) }); } });
      const task = metadata(root, id, context, all);
      if (task) records.push({ task, all });
    } catch (error) { errors.push({ taskId: id, ...issue(error) }); }
  }
  return { records, errors, context };
}
function contextualize(root, all, key, context) {
  const value = projectContext(all, key);
  if (value.latestReported) value.latestReported = { ...value.latestReported, route: decorate(root, value.latestReported.route, context) };
  return value;
}
function contextualizeTarget(root, all, key, context) {
  const value = targetContext(all, key);
  if (value.latestReported) value.latestReported = { ...value.latestReported, route: decorate(root, value.latestReported.route, context) };
  return value;
}
function projectArgument(value) {
  if (typeof value !== 'string' || value.length > 256) fail('INVALID_ARGUMENTS', 'Invalid project context.');
}
export function listTaskProjects({ root }) {
  const { records, errors } = queryArchive(root), projects = new Map();
  for (const { task, all } of records) {
    const entries = new Map(all.flatMap(ownedProjects).map(e => [e.key, e]));
    for (const e of entries.values()) {
      const c = projectContext(all, e.key);
      const p = projects.get(e.key) ?? { key: e.key, label: e.label, project: e.project ?? null, chatCount: 0, turnCount: 0, primaryTurnCount: 0, referenceTurnCount: 0, lastReportedAt: null };
      p.chatCount++; p.turnCount += c.turnCount; p.primaryTurnCount += c.primaryTurnCount; p.referenceTurnCount += c.referenceTurnCount;
      if (c.latestReported && (!p.lastReportedAt || c.latestReported.reportedAt > p.lastReportedAt)) p.lastReportedAt = c.latestReported.reportedAt;
      projects.set(e.key, p);
    }
  }
  return { enabled: config(root)?.enabled ?? false, projects: [...projects.values()].sort((a, b) =>
    Number(!a.project) - Number(!b.project) || (b.lastReportedAt ?? '').localeCompare(a.lastReportedAt ?? '') || a.label.localeCompare(b.label, 'zh-CN')), totalChats: records.length, errors };
}
function targetArgument(target, project) {
  if (typeof target !== 'string' || target.length > 4096 || /[\x00-\x1f\x7f]/.test(target) || (target && project)) fail('INVALID_ARGUMENTS', 'Supply one target or legacy project context.');
}
function targetContextKey(root, key, all, context) {
  key = currentTargetKey(key);
  if (!key || all.some(t => ownedTargets(t).some(e => e.key === key))) return key;
  const registry = context.registry ??= targetRegistry(root), id = registry.aliases.get(key);
  return id ? `target:${id}` : key;
}
export function listTaskTargets({ root }) {
  const { records, errors, context } = queryArchive(root), targets = new Map();
  for (const { task, all } of records) {
    const entries = new Map(all.flatMap(ownedTargets).map(e => [e.key, e]));
    for (const e of entries.values()) {
      const c = contextualizeTarget(root, all, e.key, context);
      const target = c.latestReported ? ownershipOf(c.latestReported.route).target : e.target;
      const row = targets.get(e.key) ?? { key: e.key, kind: e.target?.kind ?? 'state', label: e.label, target: target ?? null, chatCount: 0, turnCount: 0, lastReportedAt: null };
      row.chatCount++; row.turnCount += c.turnCount;
      if (c.latestReported && (!row.lastReportedAt || c.latestReported.reportedAt > row.lastReportedAt)) { row.lastReportedAt = c.latestReported.reportedAt; row.target = target ?? null; }
      targets.set(e.key, row);
    }
  }
  const rank = { project: 0, knowledge: 1, ability: 2, archive: 3, state: 4 };
  for (const row of targets.values()) {
    const current = row.target?.targetId ? (context.registry ??= targetRegistry(root)).records.get(row.target.targetId) : null;
    if (current && current.targetVersion > row.target.targetVersion) { row.target = decorate(root, { summary: '', status: 'working', ownership: { state: 'bound', target: current }, project: { state: 'none' }, references: [], relatedTargets: [], abilities: [] }, context).ownership.target; row.label = row.target.name; }
    row.aliases = row.target?.targetId && row.target.lifecycle !== 'planned' ? [physicalTargetKey(row.target)] : [];
    row.lifecycle = row.target?.lifecycle ?? (row.target ? 'existing' : null);
  }
  const uniqueErrors = [...new Map([...errors, ...(context.registry?.errors ?? [])].map(e => [encode(e), e])).values()];
  return { enabled: config(root)?.enabled ?? false, targets: [...targets.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || (b.lastReportedAt ?? '').localeCompare(a.lastReportedAt ?? '') || a.label.localeCompare(b.label, 'zh-CN')), totalChats: records.length, errors: uniqueErrors };
}
export function listTasks({ root, limit = 50, offset = 0, q = '', project = '', projectMatch = 'latest', target = '' }) {
  page(limit, offset); projectArgument(project);
  targetArgument(target, project);
  if (typeof q !== 'string' || q.length > 200 || !['latest', 'history'].includes(projectMatch)) fail('INVALID_ARGUMENTS', 'Invalid task search or project match mode.');
  const { records, errors, context } = queryArchive(root);
  const projects = [...new Map(records.map(({ task }) => {
    const key = taskProjectKey(task), value = task.latestReported?.route?.project;
    return key ? [[key, { value: key, label: value?.state === 'bound' ? value.primary.name + (value.primary.scope === 'archived' ? '（已归档）' : '')
      : value?.state === 'none' ? '无项目' : value?.state === 'unresolved' ? '待确定' : '未上报项目' }]] : [];
  }).flat()).values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  target = targetContextKey(root, target, records.flatMap(r => r.all), context);
  const query = q.trim().toLocaleLowerCase();
  const filtered = records.flatMap(({ task, all }) => {
    const selected = projectMatch === 'history' && project ? contextualize(root, all, project, context) : null;
    const selectedTarget = target ? contextualizeTarget(root, all, target, context) : null;
    if (target && !selectedTarget.turnCount) return [];
    if (project && (projectMatch === 'history' ? !selected.turnCount : taskProjectKey(task) !== project)) return [];
    const text = target ? targetHistoryText(task, all) : projectMatch === 'history' ? historyText(task, all) : [task.title, task.latestReported?.route?.summary, task.latestReported?.route?.project?.primary?.name,
      ...(task.latestReported?.route?.abilities?.map(a => a.name) ?? [])].filter(Boolean).join(' ').toLocaleLowerCase();
    return query && !text.includes(query) ? [] : [{ ...task, ...(selected ? { projectContext: selected } : {}), ...(selectedTarget ? { targetContext: selectedTarget } : {}) }];
  });
  filtered.sort((a, b) => (b.targetContext?.latestReported?.reportedAt ?? b.projectContext?.latestReported?.reportedAt ?? b.updatedAt).localeCompare(a.targetContext?.latestReported?.reportedAt ?? a.projectContext?.latestReported?.reportedAt ?? a.updatedAt) || a.taskId.localeCompare(b.taskId));
  return { enabled: config(root)?.enabled ?? false, total: filtered.length, unfilteredTotal: records.length, limit, offset, projects,
    nextOffset: offset + limit < filtered.length ? offset + limit : null, records: filtered.slice(offset, offset + limit), errors };
}
export function readTask({ root, taskId, turnId, limit = 20, offset = 0, includeMessages = true, project = '', target = '' }) {
  page(limit, offset); taskPath(taskId); projectArgument(project);
  targetArgument(target, project);
  if (turnId !== undefined) {
    const value = readTurn(root, taskId, turnId), context = definitionContext(root);
    const history = value ? turnProjects(value) : null;
    const targetHistory = value ? turnTargets(value) : null;
    if (value) target = targetContextKey(root, target, turns(root, taskId, { onError() {} }), context);
    return { state: value ? 'present' : 'missing', turn: value ? { ...value, turnNumber: turns(root, taskId, { onError() {} }).findIndex(t => t.turnId === turnId) + 1, projectHistory: history, ...(project ? { projectRelation: turnRelation(value, project, history) } : {}),
      targetHistory, ...(target ? { targetRelation: targetRelation(value, target, targetHistory) } : {}),
      ...(!includeMessages ? { messages: undefined } : {}), routes: value.routes.map(r => ({ ...r, snapshot: decorate(root, r.snapshot, context) })) } : null };
  }
  const errors = [], all = turns(root, taskId, { onError(error, turnId) { errors.push({ taskId, turnId, ...issue(error) }); } }), context = definitionContext(root);
  target = targetContextKey(root, target, all, context);
  const task = metadata(root, taskId, context, all);
  if (!task) return { state: errors.length ? 'partial' : 'missing', task: null, turns: [], total: 0, nextOffset: null, errors };
  return { state: 'present', task, ...(project ? { projectContext: contextualize(root, all, project, context) } : {}), ...(target ? { targetContext: contextualizeTarget(root, all, target, context) } : {}),
    turns: all.slice().reverse().slice(offset, offset + limit).map((turn, index) => {
      const history = turnProjects(turn);
      const targetHistory = turnTargets(turn);
      return { ...summarizeTurn(turn), turnNumber: all.length - offset - index, projectHistory: history, ...(project ? { projectRelation: turnRelation(turn, project, history) } : {}),
        targetHistory, ...(target ? { targetRelation: targetRelation(turn, target, targetHistory) } : {}) };
    }), total: all.length, limit, offset, nextOffset: offset + limit < all.length ? offset + limit : null, errors };
}
export function captureStatus({ root }) {
  const value = config(root), hooks = readJSON(root, '.codex/hooks.json');
  return { enabled: value?.enabled ?? false, activatedAt: value?.activatedAt ?? null, archive: ARCHIVE,
    hookConfigured: ['UserPromptSubmit', 'PreCompact', 'Stop', 'Interrupt'].every(event => hooks?.hooks?.[event]?.some(group => group.hooks?.some(h => h.command === hookCommand(root)))),
    trust: 'Codex must review and trust the exact hook definitions; KSF does not read or modify trust records.',
    lastSync: readJSON(root, `${CAPTURE}/last-sync.json`) };
}
export function configureCapture({root,enabled,ifMatch,at=now(),install=false}) {
  if(typeof enabled!=='boolean'||!Number.isFinite(Date.parse(at)))fail('INVALID_ARGUMENTS','采集开关或时间无效。');
  const result=locked(root,'configuration',()=>{
    const before=readConfigFile(root,`${CAPTURE}/config.json`),previous=config(root);
    if(ifMatch!==undefined)expectConfig(before,ifMatch);
    // An explicit initial opt-out must survive later initialization defaults.
    // Reads remain nonmutating; only this write operation records the choice.
    if(previous?.enabled===enabled)return captureStatus({root});
    const intervals=structuredClone(previous?.intervals??(previous?.enabled?[{from:previous.activatedAt,to:null}]:[]));
    // Keep the existing nonempty-interval format: an initial disabled policy
    // has a closed, zero-duration marker and never includes a captured instant.
    if(!previous&&!enabled)intervals.push({from:at,to:at});
    if(enabled&&!previous?.enabled)while(intervals.at(-1)?.to===null)intervals.pop();
    if(enabled){sessionKey(root,{host:'codex',sessionId:'identity-initialization'},true);intervals.push({from:at,to:null});}
    else if(intervals.at(-1)?.to===null)intervals.at(-1).to=at;
    publishConfigFile(root,before,{...(previous??{protocol:PROTOCOL,activatedAt:at}),enabled,intervals});
    return captureStatus({root});
  });
  if(enabled&&install)installTaskHooks({root,capture:false});
  return result;
}
export function enableCapture({root,at=now()}) {return configureCapture({root,enabled:true,at});}
export function installTaskHooks({ root, capture = true }) {
  if (capture) enableCapture({ root });
  return locked(root, 'configuration', () => {
    const old = readJSON(root, '.codex/hooks.json') ?? {};
    if (old.hooks !== undefined && (!old.hooks || typeof old.hooks !== 'object' || Array.isArray(old.hooks))) fail('TASK_HOOKS_INVALID', 'Preserve the unsupported Hooks configuration.');
    const next = structuredClone(old); next.hooks ??= {};
    // The launcher derives its root from its own location; quote the absolute path for spaces.
    const command = hookCommand(root);
    for (const event of ['UserPromptSubmit', 'PreCompact', 'Stop', 'Interrupt']) {
      const groups = next.hooks[event] ??= [];
      if (!Array.isArray(groups)) fail('TASK_HOOKS_INVALID', 'Preserve the unsupported Hooks event configuration.');
      if (!groups.some(group => group.hooks?.some(h => h.command === command))) groups.push({ hooks: [{ type: 'command', command, timeout: event === 'Interrupt' ? 3 : 15 }] });
    }
    if (encode(old) !== encode(next)) writeJSON(root, '.codex/hooks.json', next);
    return captureStatus({ root });
  });
}
function mergeTurn(root, taskId, source, paused, held, captureAllowed=true) {
  const old = readTurn(root, taskId, source.turnId);
  const routingAllowed = readUserData({ root, namespace: 'settings' }).values.routing?.enabled !== false;
  const changes = old?.targetFacts?.length || routingAllowed && source.outputs.some(output => receipts(root, output.output, taskId, source.turnId).some(d => d.targetChanges?.length));
  return changes ? withTargetLock(root, () => mergeTurnUnlocked(root, taskId, source, paused, held, captureAllowed)) : mergeTurnUnlocked(root, taskId, source, paused, held, captureAllowed);
}
function mergeTurnUnlocked(root, taskId, source, paused, held, captureAllowed=true) {
  const old = readTurn(root, taskId, source.turnId);
  const declarations = structuredClone(old?.declarations ?? []), issues = [...source.issues];
  for (const output of source.outputs) for (const body of receipts(root, output.output, taskId, source.turnId)) {
    const prior = declarations.find(d => d.eventId === body.eventId);
    const comparable = value => encode({ ...value, at: null });
    if (prior && (prior.fingerprint ? prior.fingerprint !== sha256(comparable(body)) : comparable(prior) !== comparable(body))) issues.push({ code: 'TASK_DECLARATION_CONFLICT', eventId: body.eventId });
    else if (!prior) declarations.push(body);
    else if (prior.fingerprint && old?.policy === 'pending') declarations[declarations.indexOf(prior)] = body;
  }
  const { policy:sourcePolicy, chatPaused, explicitExcluded, capturePolicyHeld, chatPolicyHeld } = capturePolicy({ old, messages: source.messages, declarations, paused, held });
  const policy=captureAllowed?sourcePolicy:'exclude';
  if(!captureAllowed)issues.push({code:'TASK_CAPTURE_DISABLED',message:'此轮开始于正文归档停用期间，不补采正文。'});
  if (policy === 'pending' && chatPolicyHeld) issues.push({ code: 'TASK_CAPTURE_POLICY_PENDING', message: '检测到对话记录限制，等待明确采集策略；正文尚未保存。' });
  const messages = policy === 'capture' ? structuredClone(old?.messages ?? []) : [];
  if (policy === 'capture') for (const message of source.messages) {
    const { sourceVersions = [], ...current } = message;
    const prior = messages.find(m => m.id === message.id);
    if (!prior) messages.push({ ...current, revisions: sourceVersions });
    else if (messageDigest(prior) !== messageDigest(message)) {
      const older = Date.parse(current.sourceAt) < Date.parse(prior.sourceAt);
      const variant = older ? current : prior;
      const version = { role: variant.role, phase: variant.phase, content: variant.content, at: variant.at, sourceAt: variant.sourceAt };
      const versions = prior.revisions;
      if (!versions.some(v => messageDigest(v) === messageDigest(version))) versions.push(version);
      if (!older) Object.assign(prior, current, { order: prior.order, revisions: versions });
    }
    const saved = messages.find(m => m.id === message.id);
    for (const version of sourceVersions) if (!saved.revisions.some(v => messageDigest(v) === messageDigest(version))) saved.revisions.push(version);
  }
  messages.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const routingAllowed = readUserData({ root, namespace: 'settings' }).values.routing?.enabled !== false;
  const targetFacts = policy === 'capture' ? structuredClone(old?.targetFacts ?? []) : [], rejected = new Set();
  if (policy === 'capture' && declarations.some(d => d.targetChanges?.length)) {
    const registry = targetRegistry(root);
    for (const d of declarations) if (d.targetChanges?.length) {
      if (!routingAllowed && !targetFacts.some(f => f.eventId === d.eventId)) { rejected.add(d.eventId); continue; }
      try {
        const fact = acceptTargetChanges(registry, d.targetChanges, { origin: `${taskId}:${source.turnId}`, eventId: d.eventId, verify: target => verifyTargetSnapshot(definitionContext(root), target) });
        if (!targetFacts.some(f => f.eventId === fact.eventId)) targetFacts.push(fact);
      } catch (error) { rejected.add(d.eventId); issues.push({ code: error.code ?? 'TARGET_CAPTURE_FAILED', eventId: d.eventId, message: error.message }); }
    }
  }
  const routes = policy === 'capture' ? declarations.filter(d => d.snapshot && !rejected.has(d.eventId) && (routingAllowed || old?.routes.some(r => r.eventId === d.eventId))).map(d => ({ eventId: d.eventId, roundId: d.roundId, at: d.at, reason: d.reason, snapshot: d.snapshot })) : [];
  if (policy === 'capture' && !routes.length) issues.push({ code: 'TASK_ROUTE_UNREPORTED' });
  const complete = source.complete || old?.completedAt;
  const interrupted = source.interrupted || old?.interrupted;
  const final = messages.some(m => m.role === 'assistant' && ['final_answer', 'final'].includes(m.phase));
  let status = policy === 'exclude' ? 'excluded' : policy === 'pending' ? 'pending' : interrupted ? 'interrupted' : complete && final ? 'completed' : 'pending';
  if (complete && !final && policy === 'capture') issues.push({ code: 'TASK_FINAL_PENDING' });
  if (issues.some(i => !['TASK_ROUTE_UNREPORTED', 'TASK_FINAL_PENDING'].includes(i.code)) && policy === 'capture') status = 'partial';
  const next = { protocol: PROTOCOL, taskId, turnId: source.turnId, roundId: declarations.find(d => d.roundId)?.roundId ?? old?.roundId ?? null,
    revision: old?.revision ?? 0, startedAt: old?.startedAt ?? source.startedAt, updatedAt: old?.updatedAt ?? source.startedAt,
    completedAt: source.completedAt ?? old?.completedAt ?? null, interrupted: Boolean(interrupted), status, policy, chatPaused, explicitExcluded, capturePolicyHeld, chatPolicyHeld,
    declarations: policy !== 'capture' ? declarations.map(d => ({ eventId: d.eventId, policy: d.policy, at: d.at, fingerprint: d.fingerprint ?? sha256(encode({ ...d, at: null })) })) : declarations,
    ...(targetFacts.length || old?.targetFacts ? { targetFacts } : {}), routes, messages, issues: [...new Map(issues.map(i => [encode(i), i])).values()] };
  if (encode({ ...old, revision: 0, updatedAt: null }) !== encode({ ...next, revision: 0, updatedAt: null })) {
    next.revision++; next.updatedAt = now(); writeJSON(root, turnPath(taskId, source.turnId), next);
  }
  return next;
}
export async function syncTasks({ root, transcriptPath, env = process.env, force = false, hook } = {}) {
  const settings = config(root);
  const configurationVersion=sha256(encode(settings));
  if (!settings?.enabled) return { skipped: true, reason: 'disabled', captured: 0, errors: [] };
  const home = codexHome(env), names = titles(home), files = transcriptPath ? [resolve(transcriptPath)] : discover(home);
  let captured = 0;
  const errors = [];
  for (const path of files) {
    try {
      const { meta, stat } = sourceMeta(path);
      if (!belongsToRoot(meta, root)) { if (transcriptPath) fail('TASK_SOURCE_WORKSPACE', 'Transcript does not explicitly belong to this KSF root.'); continue; }
      if (isInternalSession(meta)) { if (transcriptPath) fail('TASK_SOURCE_INTERNAL', 'Internal Codex workers are not user chat tasks.'); continue; }
      if (hook && hook.session_id !== meta.id) fail('TASK_SOURCE_IDENTITY', 'Hook identity does not match transcript metadata.');
      const taskId = sessionKey(root, { host: 'codex', sessionId: meta.id });
      if (!taskId) fail('TASK_KEY_INVALID', 'Missing task identity key.');
      const sourceId = sha256(path), indexPath = `${CAPTURE}/sources/${sourceId}.json`;
      const cursor = readJSON(root, indexPath);
      if (!force && !hook && cursor?.adapterVersion === TRANSCRIPT_ADAPTER_VERSION && cursor.policyVersion === capturePolicyVersion && cursor.configurationVersion===configurationVersion && cursor.size === stat.size && cursor.mtimeMs === stat.mtimeMs) continue;
      // Recheck the current native round; completed earlier rounds need not be read again.
      // Full CLI sync, source replacement or shrink rebuilds from the original boundary.
      const resume = !force && !hook && cursor?.adapterVersion === TRANSCRIPT_ADAPTER_VERSION && cursor.policyVersion === capturePolicyVersion && cursor.configurationVersion===configurationVersion && cursor.ino === stat.ino && stat.size > cursor.size && cursor.resumeOffset <= stat.size ? cursor.resumeOffset : 0;
      const parsed = await parseTranscript(path, settings.activatedAt, resume, {allowDelegatedInput:meta.thread_source === 'agent_created_thread'});
      if (hook && ['UserPromptSubmit', 'Interrupt'].includes(hook.hook_event_name) && isToken(hook.turn_id)) {
        const turn = parsed.turns.get(hook.turn_id);
        if (turn) turn.interrupted ||= hook.hook_event_name === 'Interrupt';
        else if (hook.hook_event_name === 'UserPromptSubmit') parsed.turns.set(hook.turn_id, { turnId: hook.turn_id, startedAt: now(), messages: [], outputs: [], issues: [], complete: false });
      }
      locked(root, taskId, () => {
        let paused = false, held = false;
        // All archived turns participate in chat pause state, including turns absent from a compacted source.
        const existing = turns(root, taskId), merged = new Map(existing.map(t => [t.turnId, t]));
        for (const t of parsed.turns.values()) merged.set(t.turnId, t);
        const pendingOffsets = [];
        for (const source of [...merged.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
          if (parsed.turns.has(source.turnId)) {
            const retained=readTurn(root,taskId,source.turnId);
            const allowed=retained?.messages?.length>0||!settings.intervals||settings.intervals.some(interval=>Date.parse(source.startedAt)>Date.parse(interval.from)&&(interval.to===null||Date.parse(source.startedAt)<Date.parse(interval.to)));
            const saved = mergeTurn(root, taskId, source, paused, held,allowed); paused = saved.chatPaused; held = saved.chatPolicyHeld; captured++;
            if (Number.isSafeInteger(source.startOffset) && ['pending', 'partial'].includes(saved.status)) pendingOffsets.push(source.startOffset);
          }
          else { paused = source.chatPaused; held = Boolean(source.chatPolicyHeld); }
        }
        rebuildTask(root, taskId, names.get(meta.id));
        const latest = [...parsed.turns.values()].at(-1)?.startOffset;
        const resumeOffset = pendingOffsets.length ? Math.min(...pendingOffsets) : latest ?? parsed.nextOffset;
        writeJSON(root, indexPath, { protocol: PROTOCOL, adapterVersion: TRANSCRIPT_ADAPTER_VERSION, policyVersion: capturePolicyVersion, configurationVersion, taskId, path, size: stat.size, ino: stat.ino, resumeOffset, mtimeMs: stat.mtimeMs, lastSync: now() });
      });
    } catch (error) { errors.push(issue(error)); }
  }
  const result = { skipped: false, captured, errors, at: now() };
  writeJSON(root, `${CAPTURE}/last-sync.json`, result);
  return result;
}
export async function taskHook({ root, input, env = process.env }) {
  let captureEnabled = false, captureError = '';
  try { captureEnabled = config(root)?.enabled; }
  catch (error) { captureError = `KSF task capture unavailable: ${error.code ?? 'TASK_FAILED'}. Dialogue capture has not been confirmed.`; }
  let chatEnabled = false, chatContext = '';
  try { chatEnabled = chatConfig(root)?.enabled; }
  catch (error) { chatContext = `KSF chat tracking unavailable: ${error.code ?? 'CHAT_FAILED'}. Do not guess the current turn number.`; }
  if (!captureEnabled && !chatEnabled && !chatContext && !captureError) return {};
  if (!input || !isToken(input.turn_id) || !['UserPromptSubmit', 'PreCompact', 'Stop', 'Interrupt'].includes(input.hook_event_name) || typeof input.session_id !== 'string') fail('INVALID_ARGUMENTS', 'Unsupported Codex hook payload.');
  let chatSourceValid = false, chatMeta = null;
  if (input.transcript_path) {
    try {
      const { meta } = sourceMeta(input.transcript_path);
      if (meta.id === input.session_id && belongsToRoot(meta, root) && isInternalSession(meta)) return {};
      chatSourceValid = meta.id === input.session_id && belongsToRoot(meta, root) && !isInternalSession(meta);
      if (chatSourceValid) chatMeta = meta;
    } catch { /* The ordinary sync path reports source failures without blocking the host. */ }
  }
  if (chatEnabled && input.hook_event_name === 'UserPromptSubmit') {
    try {
      if (!chatSourceValid) fail('CHAT_SOURCE_IDENTITY', 'Cannot verify the native chat and workspace identity.');
      const activated = Date.parse(chatConfig(root).activatedAt), created = Date.parse(chatMeta.timestamp);
      if (chatMeta.parent_thread_id && !Number.isFinite(created)) fail('CHAT_SOURCE_UNSUPPORTED', 'A fork needs a reliable native creation timestamp to exclude inherited turns.');
      const countingSince = new Date(Math.max(activated, Number.isFinite(created) ? created : activated)).toISOString();
      const observedTurnIds = await nativeTurnsSince(input.transcript_path, countingSince);
      const state = registerChatTurn({ root, identity: { host: 'codex', sessionId: input.session_id }, turnId: input.turn_id, observedTurnIds, countingSince });
      chatContext = `KSF chat: chatTurnNumber=${state.chatTurnNumber}; turnId=${state.turnId}; countingSince=${state.countingSince}. Counts native turns since activation, not earlier history. Before actually using a capability, call ksf chat use --object <full-id> --turn ${state.turnId} --json once this turn; it returns abilityTurnNumber and dynamic values. When Agent writes are prohibited, read only and report participation as unregistered. Variable names are chosen dynamically at runtime; no field registration is required.`;
      try {
        chatContext += '\n' + formatChatContext(readChatContext({ root, identity: { host: 'codex', sessionId: input.session_id } }));
      } catch (error) {
        chatContext += `\nKSF chat state unavailable: ${error.code ?? 'CHAT_CONTEXT_UNAVAILABLE'}. State is unknown, not empty; native counting above remains valid.`;
      }
    } catch (error) { chatContext = `KSF chat tracking unavailable: ${error.code ?? 'CHAT_FAILED'}. Do not guess the current turn number.`; }
  }
  if (!captureEnabled) {
    const context = [chatContext, captureError].filter(Boolean).join('\n');
    return context && input.hook_event_name === 'UserPromptSubmit' ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : captureError ? { systemMessage: captureError } : {};
  }
  const taskId = sessionKey(root, { host: 'codex', sessionId: input.session_id });
  let result = input.transcript_path ? await syncTasks({ root, env, transcriptPath: input.transcript_path, hook: input, force: true }) : { errors: [{ code: 'TASK_TRANSCRIPT_MISSING' }] };
  // Stop can precede the final transcript flush. Retry briefly; Web/CLI can recover later.
  if (input.hook_event_name === 'Stop' && input.transcript_path) for (let attempt = 0; attempt < 3; attempt++) {
    const turn = readTurn(root, taskId, input.turn_id);
    if (turn && ['completed', 'excluded'].includes(turn.status)) break;
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    result = await syncTasks({ root, env, transcriptPath: input.transcript_path, hook: input, force: true });
  }
  if (input.hook_event_name === 'UserPromptSubmit') return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
    `${chatContext ? chatContext + '\n' : ''}KSF task capture: native turnId=${input.turn_id}; taskId=${taskId}. Enabled capture automatically archives ordinary post-baseline dialogue even without a route report. Before substantive work call the read-only ksf task declare --from - --json with turnId, eventId, policy and reason, and the explicitly selected report when known. Policies: capture (ordinary discussion/read-only/no business saves still archives dialogue), exclude (this turn), pause (chat until resume), resume. Explicit 不记录对话 means pause; 本轮不记录 means exclude. A possible dialogue-recording restriction suspends automatic capture until a signed policy resolves it; an inherited hold requires resume. Do not infer project or abilities. Update declarations when routes change and before final delivery. This declaration writes no files, including in plan mode. Missing route stays unreported, independently of dialogue capture. Capture errors: ${result.errors.map(e => e.code).join(',') || 'none'}.` } };
  return result.errors.length ? { systemMessage: `KSF 对话待补采：${result.errors.map(e => e.code).join(', ')}。采集失败不阻断任务。` } : {};
}
// Compatibility projection. Turn archives retain every event; only this view keeps 50 changes.
export function taskRouteProjections(root) {
  const records = [], errors = [];
  for (const taskId of taskIds(root)) {
    try {
      const events = turns(root, taskId).flatMap(t => t.routes.map(r => ({ ...r, turnId: t.turnId }))).sort((a, b) => a.at.localeCompare(b.at));
      if (!events.length) continue;
      const last = events.at(-1), history = events.slice(-50).map((r, i) => ({ eventId: r.eventId, operation: 'write', revision: events.length - Math.min(50, events.length) + i + 1, roundId: r.roundId, turnId: r.turnId, at: r.at, snapshot: r.snapshot }));
      records.push({ protocol: 'ksf-routing-v1', host: 'codex', sessionKey: taskId, revision: events.length, roundId: last.roundId,
        turnId: last.turnId, updatedAt: last.at, current: last.snapshot, history, historyDropped: Math.max(0, events.length - 50), archive: 'task' });
    } catch (error) { errors.push({ sessionKey: taskId, ...issue(error) }); }
  }
  return { records, errors };
}
