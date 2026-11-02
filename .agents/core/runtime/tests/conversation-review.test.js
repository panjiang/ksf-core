import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createTaskReviewSource } from '../src/services/task-review.js';
import { PROTOCOL, turnPath, taskPath } from '../src/task-capture/storage.js';
import { createReviews } from '../../applications/conversations/backend/reviews.js';
import { createReviewDB } from '../../applications/conversations/backend/review-db.js';
import { createCLI } from '../../applications/conversations/cli/index.mjs';
import { localClock, instant } from '../../applications/conversations/backend/review-model.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const AT = '2026-10-28T03:00:00.000Z';
function fixture(t, { clock = Date.parse('2026-10-29T07:00:00+08:00'), aiStatus = 'succeeded', bulkFacts = false, failStepOnce = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ksf-review-'));
  const save = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value)); };
  const turn = (taskId = A, turnId = 'one', extra = {}) => {
    const record = { protocol: PROTOCOL, taskId, turnId, revision: 1, policy: 'capture', status: 'completed', startedAt: AT, updatedAt: AT, completedAt: AT,
      declarations: [], issues: [], routes: [{ eventId: 'e', at: AT, snapshot: { summary: '完成虚构事项', status: 'completed', ownership: { state: 'bound', target: { kind: 'project', name: '示例', scope: 'current', path: '项目/示例/project.md' } }, abilities: [], relatedTargets: [] } }],
      messages: [{ id: 'u', role: 'user', phase: 'user', at: AT, content: [{ type: 'input_text', text: '请核对示例文件' }], revisions: [] }, { id: 'f', role: 'assistant', phase: 'final_answer', at: '2026-10-28T04:00:00.000Z', content: [{ type: 'output_text', text: '对话中报告完成。项目/示例/project.md' }], revisions: [] }], ...extra };
    for (const message of record.messages) message.revisions ??= [];
    for (const event of record.routes) { event.snapshot.references ??= []; event.snapshot.project ??= { state: 'bound', primary: { name: '示例', scope: 'current', path: '项目/示例/project.md' } }; }
    if (record.policy !== 'capture') { record.messages = []; record.routes = []; }
    save(turnPath(taskId, turnId), record); save(`${taskPath(taskId)}/task.json`, { protocol: PROTOCOL, taskId, title: '示例聊天 ' + taskId[0] }); return record;
  };
  const source = createTaskReviewSource(root), requests = new Map(), submissions = [];
  let status = aiStatus, now = clock, forceInvalid = false, failedTaskId = null;
  const context = { appId: 'conversations', dataDirectory: join(root, 'user'), runtimeDataDirectory: join(root, 'runtime'), workspace: root,
    tasks: { run: action => action() }, services: { async call(service, method, args = []) {
      const input = args[0];
      if (service === 'tasks') return method === 'reviewSources' ? source.sources(input) : source.read(input);
      if (service === 'workspace') { if (method === 'read') return { text: '# 示例项目\n目标和当前事实', version: 'file-v1' }; throw Error(method); }
      if (service === 'ai') {
        if (method === 'describe') return { profiles: [{ id: 'fixture', capabilities: ['text', 'json'], limits: {} }] };
        if (method === 'submit') {
          const prior = [...requests.values()].find(r => r.idempotencyKey === input.idempotencyKey);
          if (prior) { assert.deepEqual(input, prior); return { aiTaskId: prior.id, status }; }
          const id = 'ai-' + requests.size; requests.set(id, { ...input, id }); submissions.push(input); if(!failedTaskId&&input.context.stepId===failStepOnce)failedTaskId=id;return { aiTaskId: id, status };
        }
        if (method === 'get') return input===failedTaskId?{status:'failed',error:{code:'AI_EXECUTION_TIMEOUT',message:'已确认超时',outcomeUnknown:false}}:{ status, error: status === 'reconciling' ? { message: '结果未知' } : null };
        if (method === 'readResult') {
          const request = requests.get(input), body = JSON.parse(request.inputs[0].text);
          if (request.context.stepId.startsWith('extract-')) {
            if(bulkFacts)return{value:{facts:Array.from({length:24},(_,i)=>({key:'核对'+i,title:'核对示例'+i,goal:'核对文件',result:'事实'.repeat(1500),stage:'tested',openItems:[],citations:[body.messages[0].sourceId]})),notes:'',artifacts:[]}};
            return { value: { facts: [{ key: '核对示例', title: '核对示例', goal: '核对文件', result: '对话报告完成', stage: 'tested', openItems: [], citations: [body.messages[0].sourceId] }], notes: '保留声明性质', artifacts: [] } };
          }
          if(request.context.stepId.startsWith('reduce-'))return{value:{facts:[{key:'核对示例',title:'核对示例',goal:'核对文件',result:'保留所有来源',stage:'tested',openItems:[],citations:[...new Set(body.extracted.flatMap(p=>p.facts.flatMap(f=>f.citations)))]}],notes:'',artifacts:[]}};
          const citations = Object.keys(body.sourceMap).filter(id => body.sourceMap[id].inDay), targetKey = Object.keys(body.targets).find(key=>body.targets[key].kind==='project')??Object.keys(body.targets)[0];
          return { value: { summary: '完成示例事项核对，测试结果仅有对话声明。', workItems: [{ key: '核对示例', title: '核对示例', goal: '核对文件', result: '对话报告完成', stage: 'tested', openItems: [], citations: forceInvalid ? ['invented-source'] : citations.slice(0, 1) }], findings: [],
            suggestions: [{ key: '完善验收证据', type: 'asset', targetKey, problem: '缺少可查证的验收记录', change: '补充实际验证入口', reason: '完成声明不能替代验收', validation: '核对真实回执', citations: citations.slice(0, 1), method: { scenario: '', input: '', steps: [], output: '', limits: '' } }],
            chatClosures: body.chats.map(chat => ({ taskId: chat.taskId, closed: true, reason: '原请求已完成', openItems: [], unknownOperations: [], citations: Object.keys(body.sourceMap).filter(id => body.sourceMap[id].taskId === chat.taskId).slice(0, 1) })) } };
        }
      }
      throw Error(service + '/' + method);
    } } };
  let app = createReviews(context, { now: () => now }); t.after(async () => { await app.dispose(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const configure = (extra = {}) => app.call('review.configure', { enabled: false, profileId: 'fixture', timeZone: 'Asia/Shanghai', time: '06:00', ...extra });
  async function generate(date = '2026-10-28') { const result = await app.call('review.generate', { date }); await app.pump(); return app.call('review.read', { id: result.id }); }
  return { root, save, turn, source, requests, submissions, configure, generate, get app() { return app; }, setClock(value) { now = Date.parse(value); }, setStatus(value) { status = value; }, invalid() { forceInvalid = true; }, async restart() { await app.dispose(); app = createReviews(context, { now: () => now }); } };
}

test('review source uses message time across midnight, provides exact versions and keeps original bytes', async t => {
  const f = fixture(t), turn = f.turn(A, 'overnight', { startedAt: '2026-10-27T15:59:00Z', messages: [{ id: 'u', role: 'user', at: '2026-10-27T15:59:00Z', content: [{ type: 'text', text: '昨天请求' }] }, { id: 'f', role: 'assistant', at: '2026-10-27T16:01:00Z', content: [{ type: 'text', text: '今天结果' }] }] });
  const before = readFileSync(join(f.root, turnPath(A, 'overnight')));
  const result = await f.source.sources({ startAt: '2026-10-27T16:00:00Z', endAt: '2026-10-28T16:00:00Z' });
  assert.equal(result.records.length, 1); assert.equal(result.records[0].messages[1].at, '2026-10-27T16:01:00.000Z');
  assert.equal(f.source.read({ taskId: A, turnId: 'overnight', revision: 1 }).messages[1].text, '今天结果');
  f.save(turnPath(A, 'overnight'), { ...turn, revision: 2 });
  assert.throws(() => f.source.read({ taskId: A, turnId: 'overnight', revision: 1 }), { code: 'TASK_REVIEW_CONFLICT' });
  f.save(turnPath(A, 'overnight'), turn); assert.deepEqual(readFileSync(join(f.root, turnPath(A, 'overnight'))), before);
});

test('privacy exclusions and held records never expose bodies, routes, or timestamps to AI', async t => {
  const f = fixture(t); f.turn(); f.turn(B, 'excluded', { policy: 'exclude', status: 'excluded' }); f.turn(B, 'held', { capturePolicyHeld: true });
  const result = await f.source.sources(); assert.equal(result.records.length, 1); assert.equal(result.chats.length, 1);
  assert.throws(() => f.source.read({ taskId: B, turnId: 'held' }), { code: 'TASK_REVIEW_UNAVAILABLE' });
  await f.configure(); await f.generate(); assert(f.submissions.every(r => !r.inputs[0].text.includes(B)));
});

test('read-only overview does not initialize application data or invoke AI; empty days need no profile', async t => {
  const f = fixture(t); await f.app.call('review.overview'); assert.equal(existsSync(join(f.root, 'user')), false); assert.equal(f.submissions.length, 0);
  const report = await f.generate(); assert.equal(report.workItems.length, 0); assert.equal(f.submissions.length, 0);
});

test('report separates claims, preserves pending suggestions on archive, filters before pagination and restores', async t => {
  const f = fixture(t); f.turn(); f.turn(B, 'one'); await f.configure(); const report = await f.generate();
  assert.equal(report.workItems[0].evidenceBasis, 'reported'); assert(report.closures.every(c => c.eligible));
  const receipt = await f.app.call('review.confirm', { id: report.id, revision: 1, archiveTaskIds: [A], operationId: 'confirm-1' });
  assert.deepEqual(receipt.archived, [A]);
  assert.deepEqual((await f.app.call('chats.list', { state: 'active', limit: 1 })).records.map(r => r.taskId), [B]);
  assert.equal((await f.app.call('chats.list', { state: 'archived' })).total, 1);
  assert.equal((await f.app.call('suggestions.list'))[0].status, 'pending');
  assert.deepEqual(await f.app.call('review.confirm', { id: report.id, revision: 1, archiveTaskIds: [A], operationId: 'confirm-1' }), receipt);
  await f.app.call('chats.restore', { taskId: A }); assert.equal((await f.app.call('chats.list')).total, 2);
});

test('late messages block archive, and new work reopens an archived chat', async t => {
  const f = fixture(t), turn = f.turn(); await f.configure(); let report = await f.generate();
  f.save(turnPath(A, 'one'), { ...turn, revision: 2 });
  let receipt = await f.app.call('review.confirm', { id: report.id, revision: 1, archiveTaskIds: [A], operationId: 'confirm-late' });
  assert.equal(receipt.archived.length, 0); assert.equal(receipt.skipped.length, 1);
  report = await f.generate(); receipt = await f.app.call('review.confirm', { id: report.id, revision: 1, archiveTaskIds: [A], operationId: 'confirm-new' }); assert.equal(receipt.archived.length, 1);
  f.turn(A, 'two', { startedAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', messages: [{ id: 'new', role: 'user', at: '2026-10-29T00:00:00Z', content: [{ type: 'text', text: '继续新工作' }] }] });
  assert.equal((await f.app.call('chats.list', { state: 'active' })).total, 1);
});

test('capture pending, missing history, unknown dates and later work deterministically prevent closure', async t => {
  const f = fixture(t); f.turn(A, 'pending', { status: 'pending' }); f.turn(A, 'future', { messages: [{ id: 'u2', role: 'user', at: '2026-10-29T00:00:00Z', content: [{ type: 'text', text: '新工作' }] }] });
  await f.configure(); const report = await f.generate(); assert.equal(report.closures[0].eligible, false); assert.match(report.closures[0].blockers.join(','), /范围后|待补采/);
});

test('same input is idempotent, cache reuses unchanged extraction, reviewed versions remain immutable', async t => {
  const f = fixture(t), a = f.turn(), b = f.turn(B); await f.configure(); const first = await f.generate(), calls = f.submissions.length;
  assert.equal((await f.generate()).id, first.id); assert.equal(f.submissions.length, calls);
  await f.app.call('review.confirm', { id: first.id, revision: 1, archiveTaskIds: [], operationId: 'review-only' });
  f.save(turnPath(A, 'one'), { ...a, revision: 2 }); const next = await f.generate();
  assert.equal(next.edition, 2); assert.equal(next.supplementTo, first.id); assert.equal(f.submissions.length - calls, 2, 'one changed extraction and one synthesis');
  assert.equal((await f.app.call('review.read', { id: first.id })).reviewedAt !== null, true); assert.equal(b.revision, 1);
});

test('unknown AI result resumes original task without duplicate submit across backend restart', async t => {
  const f = fixture(t, { aiStatus: 'running' }); f.turn(); await f.configure(); const accepted = await f.app.call('review.generate', { date: '2026-10-28' }); await f.app.pump();
  const first = f.submissions.length; await f.restart(); f.setStatus('reconciling'); await f.app.pump(); assert.equal(f.submissions.length, first);
  const run = (await f.app.call('review.overview')).runs.find(r => r.id === accepted.id); assert.equal(run.state, 'reconciling');
  f.setStatus('succeeded'); await f.app.call('review.resume', { id: accepted.id }); await f.app.pump(); assert(await f.app.call('review.read', { id: accepted.id })); assert.equal(f.submissions.filter(r => r.context.stepId.startsWith('extract')).length, 1);
});

test('confirmed synthesis failure retries without resubmitting successful extraction or reduction',async t=>{
  const f=fixture(t,{bulkFacts:true,failStepOnce:'synthesis'});f.turn();await f.configure();assert.equal(await f.generate(),null);
  const failed=(await f.app.call('review.overview')).runs[0];assert.equal(failed.state,'failed');
  assert.equal(f.submissions.filter(s=>s.context.stepId.startsWith('reduce-')).length,1);
  await f.restart();const retry=await f.app.call('review.retry',{id:failed.id,operationId:'retry-known-timeout'});await f.app.pump();assert(await f.app.call('review.read',{id:retry.id}));
  assert.equal(f.submissions.filter(s=>s.context.stepId.startsWith('extract-')).length,1);assert.equal(f.submissions.filter(s=>s.context.stepId.startsWith('reduce-')).length,1);assert.equal(f.submissions.filter(s=>s.context.stepId==='synthesis').length,2);
  assert.equal((await f.app.call('review.retry',{id:failed.id,operationId:'retry-known-timeout'})).id,retry.id);
  assert.equal((await f.app.call('review.retry',{id:failed.id,operationId:'a-second-click'})).id,retry.id);
  assert.equal((await f.app.call('review.overview')).runs.some(r=>r.id===failed.id),false);
});

test('invented citations are rejected before publishing or archiving', async t => {
  const f = fixture(t); f.turn(); f.invalid(); await f.configure(); const report = await f.generate(); assert.equal(report, null);
  const overview = await f.app.call('review.overview'); assert.equal(overview.runs[0].error.code, 'REVIEW_CITATION_INVALID'); assert.equal((await f.app.call('chats.list')).total, 1);
});

test('suggestion decisions survive deduplicated new evidence and concurrent stale updates fail', async t => {
  const f = fixture(t), a = f.turn(); await f.configure(); await f.generate(); const suggestion = (await f.app.call('suggestions.list'))[0];
  await f.app.call('suggestions.update', { id: suggestion.id, revision: suggestion.revision, status: 'ignored' });
  await assert.rejects(f.app.call('suggestions.update', { id: suggestion.id, revision: suggestion.revision, status: 'resolved' }), { code: 'REVIEW_CONFLICT' });
  f.save(turnPath(A, 'one'), { ...a, revision: 2 }); await f.generate(); const current = await f.app.call('suggestions.list'); assert.equal(current.length, 1); assert.equal(current[0].status, 'ignored'); assert.equal(current[0].reportIds.length, 2);
});

test('suggestions preserve the concrete asset path when ownership uses an opaque stable ID',async t=>{
  const f=fixture(t),turn=f.turn(),targetId='c'.repeat(64);Object.assign(turn.routes[0].snapshot.ownership.target,{targetId,targetVersion:2,lifecycle:'existing'});f.save(turnPath(A,'one'),turn);
  await f.configure();await f.generate();const suggestion=(await f.app.call('suggestions.list'))[0];assert.equal(suggestion.targetKey,targetId);assert.equal(suggestion.targetPath,'项目/示例/project.md');
});

test('scheduler begins on enable date, catches missed days sequentially and leaves old dates manual', async t => {
  const f = fixture(t); f.turn(); await f.configure({ enabled: true });
  await f.app.tick(); assert.equal((await f.app.call('review.overview')).reports.length, 0);
  f.setClock('2026-10-31T07:00:00+08:00'); await f.app.tick(); f.setClock('2026-10-31T07:00:31+08:00'); await f.app.tick();
  const dates = (await f.app.call('review.overview')).reports.map(r => r.date); assert.deepEqual(dates.sort(), ['2026-10-29', '2026-10-30']); assert.equal(f.submissions.length, 0);
  assert.equal((await f.generate('2026-10-28')).date, '2026-10-28');
});

test('database refuses unknown versions and symlinks without overwriting originals', t => {
  const f = fixture(t), directory = join(f.root, 'db'), db = createReviewDB(directory); db.put('test', 'one', { retained: true }); db.close();
  const path = join(directory, 'reviews.sqlite'), before = readFileSync(path); const link = join(f.root, 'link'); symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createReviewDB(link).get('test', 'one'), { code: 'REVIEW_DATA_INVALID' }); assert.deepEqual(readFileSync(path), before);
});

test('IANA scheduling uses the intended calendar date', () => {
  assert.equal(instant('2026-10-29', '06:00', 'Asia/Shanghai'), '2026-10-28T22:00:00.000Z');
  assert.equal(localClock('2026-10-29T00:00:00Z').date, '2026-10-29');
});

test('a selected-chat review excludes other sources and keeps its scope across refresh and reports', async t => {
  const f=fixture(t); f.turn(); f.turn(B,'other',{messages:[{id:'private',role:'user',at:AT,content:[{type:'text',text:'UNRELATED_PRIVATE_CANARY'}]}]}); await f.configure();
  const accepted=await f.app.call('review.generate',{date:'2026-10-28',taskId:A}); await f.app.pump();
  const report=await f.app.call('review.read',{id:accepted.id}); assert.equal(report.scope.taskId,A); assert.deepEqual(report.chats.map(c=>c.taskId),[A]);
  assert(f.submissions.every(r=>!r.inputs[0].text.includes('UNRELATED_PRIVATE_CANARY')&&!r.inputs[0].text.includes(B)));
  const refreshed=await f.app.call('review.generate',{date:report.date,taskId:A,force:true,operationId:'scope-refresh'}); await f.app.pump();
  assert.equal((await f.app.call('review.read',{id:refreshed.id})).scope.taskId,A);
  const full=await f.generate(); assert.notEqual(full.id,accepted.id); assert.equal(full.scope,undefined); assert.equal(full.chats.length,2); assert.equal(full.edition,1);
  await assert.rejects(f.app.call('review.generate',{date:report.date,taskId:'c'.repeat(64)}),{code:'REVIEW_SOURCE_UNAVAILABLE'});
  const overview=await f.app.call('review.overview'); assert.equal(overview.reports.find(r=>r.id===report.id).scope.taskId,A); assert.equal(overview.reports.find(r=>r.id===report.id).scope.title,undefined);
  f.turn(A,'one',{capturePolicyHeld:true});assert.equal((await f.app.call('review.read',{id:report.id})).scope.title,'原始证据不可用的对话');
});

test('outstanding reviews reconcile only their own source scope', async t => {
  const f=fixture(t,{aiStatus:'reconciling'});f.turn();f.turn(B,'one');await f.configure();
  const one=await f.app.call('review.generate',{date:'2026-10-28',taskId:A});await f.app.pump();
  const two=await f.app.call('review.generate',{date:'2026-10-28',taskId:B});await f.app.pump();
  const daily=await f.app.call('review.generate',{date:'2026-10-28'});assert.notEqual(two.id,one.id);assert.notEqual(daily.id,one.id);assert.notEqual(daily.id,two.id);
  assert.equal((await f.app.call('review.generate',{date:'2026-10-28',taskId:A})).id,one.id);
});
test('the installed-app CLI envelope preserves selected sources and legacy flat calls, rejecting mixed input',async t=>{
  const f=fixture(t);f.turn();f.turn(B,'other');await f.configure();const cli=createCLI({invoke:(method,params)=>f.app.call(method,params)});
  const accepted=await cli.execute('generate',{expectedPackageDigest:'fixture',operationId:'cli-scoped',params:{date:'2026-10-28',taskId:A}});await f.app.pump();
  const report=await cli.execute('report',{params:{id:accepted.id}});assert.equal(report.scope.taskId,A);assert.deepEqual(report.chats.map(c=>c.taskId),[A]);
  assert.equal((await cli.execute('generate',{date:'2026-10-28',taskId:A})).id,accepted.id);
  const suggestion=(await cli.execute('suggestions',{params:{}}))[0];assert.match((await cli.execute('handoff',{params:{id:suggestion.id,revision:suggestion.revision}})).text,/待发送草稿/);
  for(const input of [{params:{taskId:A},taskId:B},{params:[]},{params:'invalid'},{operationId:'one',params:{operationId:'two'}}])assert.throws(()=>cli.execute('generate',input),{code:'APP_CALL_INVALID'});
});

test('selected-chat runs do not block another scope or satisfy the automatic daily review', async t => {
  const f=fixture(t,{clock:Date.parse('2026-10-28T12:00:00+08:00')}); f.turn(); f.turn(B,'one'); await f.configure({enabled:true});
  const scoped=await f.app.call('review.generate',{date:'2026-10-28',taskId:A}); await f.app.pump();
  f.setClock('2026-10-29T07:00:00+08:00'); await f.app.tick();
  const reports=(await f.app.call('review.overview')).reports.filter(r=>r.date==='2026-10-28'); assert.equal(reports.length,2); assert(reports.some(r=>!r.scope));
  assert.equal(reports.find(r=>r.id===scoped.id).scope.taskId,A);
});

test('withdrawn and out-of-scope suggestions are not passed to the review model', async t => {
  const f=fixture(t);f.turn();f.turn(B,'other');await f.configure();
  const db=createReviewDB(join(f.root,'user'));
  try { db.put('suggestion','outside',{id:'outside',key:'outside',status:'ignored',problem:'OUTSIDE_SUGGESTION_CANARY',targetKey:'outside',evidence:[{taskId:B,turnId:'other'}]}); }
  finally { db.close(); }
  const result=await f.app.call('review.generate',{date:'2026-10-28',taskId:A});await f.app.pump();assert((await f.app.call('review.read',{id:result.id})).scope);
  assert(f.submissions.every(r=>!r.inputs[0].text.includes('OUTSIDE_SUGGESTION_CANARY')));
  f.turn(B,'other',{policy:'exclude',status:'excluded'});const count=f.submissions.length;await f.generate();assert(f.submissions.slice(count).every(r=>!r.inputs[0].text.includes('OUTSIDE_SUGGESTION_CANARY')));
});

test('withdrawn sources hide derived report content and suggestion evidence', async t => {
  const f=fixture(t);f.turn();await f.configure();const report=await f.generate();
  const suggestion=(await f.app.call('suggestions.list'))[0], request={id:suggestion.id,revision:suggestion.revision};
  assert.match((await f.app.call('suggestions.handoff',request)).text,/待发送草稿/);
  const db=createReviewDB(join(f.root,'user'));
  try {
    const before=db.get('suggestion',suggestion.id);
    for (const withdrawn of [{capturePolicyHeld:true},{policy:'exclude',status:'excluded'}]) {
      f.turn(A,'one',withdrawn);
      const current=await f.app.call('review.read',{id:report.id});assert.equal(current.sourceUnavailable,true);assert.equal(current.workItems.length,0);assert.equal(current.suggestions.length,0);assert.equal(Object.keys(current.sourceMap).length,0);
      assert.equal((await f.app.call('suggestions.list')).length,0);
      await assert.rejects(f.app.call('suggestions.handoff',request),{code:'REVIEW_SOURCE_UNAVAILABLE'});
      await assert.rejects(f.app.call('suggestions.update',{...request,status:'accepted'}),{code:'REVIEW_SOURCE_UNAVAILABLE'});
      assert.deepEqual(db.get('suggestion',suggestion.id),before);
      assert.equal(JSON.stringify((await f.app.call('review.overview')).reports).includes('缺少可查证'),false);
    }
  } finally { db.close(); }
});

test('history target membership survives switching the last route and catalog follows archive state', async t => {
  const f=fixture(t),turn=f.turn();const next=structuredClone(turn.routes[0]);next.eventId='switch';next.snapshot.ownership.target={kind:'knowledge',name:'示例认知',path:'知识/示例/cognition.md'};next.snapshot.project={state:'none'};
  f.save(turnPath(A,'one'),{...turn,routes:[...turn.routes,next]});
  assert.equal((await f.app.call('chats.list',{target:'current:示例'})).total,1);
  const targets=(await f.app.call('chats.targets')).targets;assert(targets.some(t=>t.key==='current:示例'));assert(targets.some(t=>t.kind==='knowledge'));
});

test('capture, reviewed source versions and archive visibility remain independent after new evidence', async t => {
  const f=fixture(t),turn=f.turn();await f.configure();const report=await f.generate();
  let state=await f.app.call('chats.reviewState',{taskId:A});assert.equal(state.captureComplete,1);assert.equal(state.reviewed,0);assert.equal(state.state,'active');
  await f.app.call('review.confirm',{id:report.id,revision:report.revision,archiveTaskIds:[A],operationId:'separate-states'});
  state=await f.app.call('chats.reviewState',{taskId:A});assert.equal(state.reviewed,1);assert.equal(state.state,'archived');assert.equal(state.versions[0].reportId,report.id);
  f.save(turnPath(A,'one'),{...turn,revision:2});
  state=await f.app.call('chats.reviewState',{taskId:A});assert.equal(state.captureComplete,1);assert.equal(state.reviewed,0);assert.equal(state.state,'active');assert.equal(state.versions[0].revision,2);
});

test('non-text evidence and unreported ownership remain explicit gaps with different archive rules', async t => {
  const f=fixture(t),turn=f.turn();
  turn.messages[0].content.push({type:'input_image',image_url:'private-image-reference'});f.save(turnPath(A,'one'),turn);
  f.turn(B,'one',{issues:[{code:'TASK_ROUTE_UNREPORTED',message:'本轮未上报归属'}],routes:[]});
  const sources=await f.source.sources();assert.deepEqual(sources.records.find(t=>t.taskId===A).messages[0].omittedContentTypes,['input_image']);
  const body=f.source.read({taskId:A,turnId:'one'});assert.deepEqual(body.messages[0].omittedContentTypes,['input_image']);assert(!JSON.stringify(body).includes('private-image-reference'));
  await f.configure();const report=await f.generate();assert(report.gaps.some(g=>g.code==='REVIEW_NON_TEXT_CONTENT'));assert(report.gaps.some(g=>g.code==='TASK_ROUTE_UNREPORTED'));
  assert.equal(report.closures.find(c=>c.taskId===A).eligible,false);assert.equal(report.closures.find(c=>c.taskId===B).eligible,true);
});

test('configuration alone does not establish the automatic baseline; pending input changes do not duplicate AI runs', async t => {
  const f=fixture(t,{aiStatus:'running'}),turn=f.turn();await f.configure();assert.equal((await f.app.call('review.overview')).config.activatedDate,null);
  const first=await f.app.call('review.generate',{date:'2026-10-28'});await f.app.pump();f.save(turnPath(A,'one'),{...turn,revision:2});
  assert.equal((await f.app.call('review.generate',{date:'2026-10-28'})).id,first.id);assert.equal(f.submissions.length,1);
});

test('concurrent replay returns one review receipt and rejects changed payload under the same operation ID', async t => {
  const f=fixture(t);f.turn();await f.configure();const report=await f.generate(),request={id:report.id,revision:1,archiveTaskIds:[A],operationId:'same-operation'};
  const [a,b]=await Promise.all([f.app.call('review.confirm',request),f.app.call('review.confirm',request)]);assert.deepEqual(a,b);
  await assert.rejects(f.app.call('review.confirm',{...request,archiveTaskIds:[]}),{code:'REVIEW_CONFLICT'});
});

test('explicit refresh produces a new version while reusing unchanged extraction and preserving the old report', async t => {
  const f=fixture(t);f.turn();await f.configure();const first=await f.generate(),calls=f.submissions.length;
  const accepted=await f.app.call('review.generate',{date:first.date,force:true,operationId:'explicit-refresh'});await f.app.pump();const next=await f.app.call('review.read',{id:accepted.id});
  assert.notEqual(first.id,next.id);assert.equal(next.edition,2);assert.equal(f.submissions.length,calls+1);
  assert.deepEqual(await f.app.call('review.read',{id:first.id}),first);
});

test('one unreadable turn leaves a source gap without blocking another chat report or archiving the missing chat', async t => {
  const f=fixture(t);f.turn();f.turn(B);await f.configure();const read=f.source.read;
  f.source.read=input=>{if(input.taskId===A)throw Object.assign(Error('模拟单处读取失败'),{code:'TASK_REVIEW_READ_FAILED'});return read(input);};
  const report=await f.generate();assert(report);assert(report.gaps.some(g=>g.code==='TASK_REVIEW_READ_FAILED'));assert.equal(report.activity.chats,2);assert.equal(report.closures.find(c=>c.taskId===A).eligible,false);assert(Object.values(report.sourceMap).every(s=>s.taskId===B));
});

test('unknown SQLite schema refuses access without modifying its contents', t => {
  const f=fixture(t),directory=join(f.root,'unknown-db'),store=createReviewDB(directory);store.put('test','one',{value:1});store.close();const path=join(directory,'reviews.sqlite'),db=new DatabaseSync(path);db.exec('PRAGMA user_version=99');db.close();const before=readFileSync(path);
  assert.throws(()=>createReviewDB(directory).get('test','one'),{code:'REVIEW_DATA_INCOMPATIBLE'});assert.deepEqual(readFileSync(path),before);
});

test('chat pagination and counts remain complete beyond the first hundred records', async t => {
  const f=fixture(t);for(let i=1;i<=105;i++)f.turn(i.toString(16).padStart(64,'0'));
  const first=await f.app.call('chats.list',{limit:100,offset:0}),second=await f.app.call('chats.list',{limit:100,offset:100});assert.equal(first.total,105);assert.equal(first.records.length,100);assert.equal(second.records.length,5);
  assert.equal((await f.app.call('chats.targets')).totalChats,105);
});
