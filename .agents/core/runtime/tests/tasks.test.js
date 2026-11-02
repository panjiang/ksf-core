import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { routingFixture } from './helpers/routing-fixture.js';
import { enableCapture, configureCapture, declareTask, syncTasks, listTasks, readTask, installTaskHooks, taskHook, taskRouteProjections } from '../src/services/tasks.js';
import { sessionKey } from '../src/routing/storage.js';
import { turnPath, CAPTURE, ARCHIVE } from '../src/task-capture/storage.js';
import { runTaskCommand } from '../src/commands/tasks.js';
import { listRoutes } from '../src/services/routes.js';
import { parseTranscript } from '../src/task-capture/codex.js';
import { spawn } from 'node:child_process';

function fixture(t) {
  const f = routingFixture(t), home = join(f.root, 'host'), path = join(home, 'sessions/rollout-test.jsonl');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const env = { CODEX_HOME: home, CODEX_THREAD_ID: 'codex-chat-one' };
  const append = row => appendFileSync(path, JSON.stringify(row) + '\n');
  append({ type: 'session_meta', payload: { id: env.CODEX_THREAD_ID, cwd: f.root } });
  enableCapture({ root: f.root, at: '2026-01-01T00:00:00Z' });
  const id = sessionKey(f.root, { host: 'codex', sessionId: env.CODEX_THREAD_ID });
  const start = (turnId, at = '2026-01-02T00:00:00Z') => append({ type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: turnId, started_at: at } });
  const message = (id, role, text, phase, extra = {}) => append({ type: 'response_item', timestamp: '2026-01-02T00:00:01Z', payload: { type: 'message', id, role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra } });
  const receipt = (turnId, eventId, policy = 'capture', overrides = {}) => declareTask({ root: f.root, env, input: { turnId, eventId, policy, reason: '明确的安排说明', report: f.report(), ...overrides } });
  const output = value => append({ type: 'response_item', timestamp: '2026-01-02T00:00:02Z', payload: { type: 'function_call_output', call_id: 'command', output: JSON.stringify(value) } });
  const sync = (extra = {}) => syncTasks({ root: f.root, env, force: true, ...extra });
  const read = turnId => readTask({ root: f.root, taskId: id, turnId }).turn;
  return { ...f, home, path, env, id, append, start, message, receipt, output, sync, read };
}
test('native app-created task input is captured with delegated origin and ordinary tool wrappers stay excluded',async t=>{
  const f=fixture(t),meta={id:f.env.CODEX_THREAD_ID,cwd:f.root,thread_source:'agent_created_thread'};
  writeFileSync(f.path,JSON.stringify({type:'session_meta',payload:meta})+'\n');
  f.append({type:'event_msg',timestamp:'2026-01-02T00:00:00Z',payload:{type:'task_started',turn_id:'one',turn_attribution:{turn_trigger:'app_tool_create_thread'}}});
  const wrapper='<codex_delegation>\n<source_thread_id>parent-thread</source_thread_id>\n<input>请核对真实项目\n原文保持。</input>\n</codex_delegation>';
  f.append({type:'response_item',timestamp:'2026-01-02T00:00:01Z',payload:{type:'function_call_output',id:'native-input',namespace:'codex_app',name:'create_thread',output:wrapper,internal_chat_message_metadata_passthrough:{turn_id:'one',create_time:1767312001}}});
  f.append({type:'response_item',timestamp:'2026-01-02T00:00:02Z',payload:{type:'function_call_output',id:'quoted',namespace:'other',name:'create_thread',output:wrapper}});
  f.message('answer','assistant','已核对','final_answer');f.append({type:'event_msg',timestamp:'2026-01-02T00:00:03Z',payload:{type:'task_complete',turn_id:'one'}});
  await f.sync();const turn=f.read('one');assert.equal(turn.status,'completed');assert.equal(turn.messages.filter(m=>m.role==='user').length,1);assert.equal(turn.messages[0].phase,'delegated_input');assert.equal(turn.messages[0].origin.kind,'codex-app-create-thread');assert.equal(turn.messages[0].content[0].text,'请核对真实项目\n原文保持。');
  f.start('two');f.append({type:'response_item',timestamp:'2026-01-02T00:00:02Z',payload:{type:'function_call_output',id:'ordinary-output',namespace:'codex_app',name:'create_thread',output:wrapper}});await f.sync();assert(!f.read('two').messages.some(m=>m.id==='ordinary-output'));
});
test('delegated inputs obey explicit capture exclusions and do not cross the activation baseline',async t=>{
  const f=fixture(t);writeFileSync(f.path,JSON.stringify({type:'session_meta',payload:{id:f.env.CODEX_THREAD_ID,cwd:f.root,thread_source:'agent_created_thread'}})+'\n');
  for(const [id,at]of [['old','2025-12-31T00:00:00Z'],['excluded','2026-01-02T00:00:00Z']]){
    f.append({type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:id,turn_attribution:{turn_trigger:'app_tool_create_thread'}}});
    f.append({type:'response_item',timestamp:at,payload:{type:'function_call_output',id:'native-'+id,namespace:'codex_app',name:'create_thread',output:'<codex_delegation><source_thread_id>parent</source_thread_id><input>PRIVATE_DELEGATED_CANARY</input></codex_delegation>'}});
  }
  f.output(f.receipt('excluded','exclude-this','exclude'));await f.sync();assert.equal(f.read('old'),null);assert.equal(f.read('excluded').messages.length,0);assert.doesNotMatch(readFileSync(join(f.root,turnPath(f.id,'excluded')),'utf8'),/PRIVATE_DELEGATED_CANARY/);
});
test('global archive pause never backfills disabled turns after restart and preserves chat privacy state',async t=>{
 const f=fixture(t);f.start('before','2026-01-02T00:00:00Z');f.message('before-u','user','保留旧正文');await f.sync();
 configureCapture({root:f.root,enabled:false,at:'2026-01-03T00:00:00Z'});
 f.start('disabled','2026-01-04T00:00:00Z');f.message('off-u','user','不能补采的正文');f.output(f.receipt('disabled','privacy-pause','pause'));
 assert.equal((await f.sync()).skipped,true);
 configureCapture({root:f.root,enabled:true,at:'2026-01-05T00:00:00Z'});
 f.start('after','2026-01-06T00:00:00Z');f.message('after-u','user','仍然遵守聊天暂停');await f.sync();
 assert.equal(f.read('before').messages[0].content[0].text,'保留旧正文');assert.equal(f.read('disabled').messages.length,0);assert.equal(f.read('after').messages.length,0);
 f.start('resumed','2026-01-07T00:00:00Z');f.message('resume-u','user','恢复后的正文');f.output(f.receipt('resumed','privacy-resume','resume'));await f.sync();assert.equal(f.read('resumed').messages[0].content[0].text,'恢复后的正文');
});
test('future native rounds, exact messages and route declarations survive restart without Web', async t => {
  const f = fixture(t);
  f.start('old', '2025-12-31T00:00:00Z'); f.message('old', 'user', '不可导入的历史');
  f.start('new'); f.message('u1', 'user', '只讨论，不保存业务文件');
  f.message('context', 'user', '自动注入不可保存', undefined, { internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] } });
  f.message('c1', 'assistant', '具体过程', 'commentary');
  f.output(f.receipt('new', 'route1'));
  f.message('f1', 'assistant', '<img src=x onerror=alert(1)> 最终答复', 'final_answer');
  f.append({ type: 'event_msg', timestamp: '2026-01-02T00:00:04Z', payload: { type: 'task_complete', turn_id: 'new' } });
  assert.deepEqual((await f.sync()).errors, []);
  const turn = f.read('new');
  assert.equal(turn.status, 'completed'); assert.equal(turn.messages.length, 3); assert.equal(turn.routes.length, 1);
  assert.equal(f.read('old'), null);
  const bytes = readFileSync(join(f.root, turnPath(f.id, 'new')));
  await f.sync(); assert.deepEqual(readFileSync(join(f.root, turnPath(f.id, 'new'))), bytes);
  assert.equal(listTasks({ root: f.root }).total, 1);
  assert.equal(readTask({ root: f.root, taskId: f.id }).turns[0].messageCount, 3);
  assert.equal(listRoutes({ root: f.root }).records[0].archive, 'task');
  assert.equal(taskRouteProjections(f.root).records[0].roundId, turn.roundId);
  assert.doesNotMatch(readFileSync(join(f.root, ARCHIVE, f.id, 'task.json'), 'utf8'), /codex-chat-one/);
});
test('enabled capture saves dialogue without declarations; delayed final flush and compaction recover losslessly', async t => {
  const f = fixture(t); f.start('new'); f.message('u', 'user', '只讨论、只读，不保存业务文件');
  await f.sync(); assert.equal(f.read('new').messages.length, 1); assert.equal(f.read('new').policy, 'capture');
  assert.equal(f.read('new').routes.length, 0); assert.equal(f.read('new').declarations.length, 0);
  f.append({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new' }, timestamp: '2026-01-02T00:00:04Z' });
  await f.sync(); assert.equal(f.read('new').status, 'pending'); assert.equal(f.read('new').messages.length, 1);
  f.append({ type: 'compacted', payload: { message: '隐藏压缩内容', replacement_history: [{ role: 'user', content: '不能当作新原话' }] } });
  f.message('final', 'assistant', '后来刷盘的答复', 'final_answer');
  await f.sync(); assert.equal(f.read('new').status, 'completed'); assert.equal(f.read('new').messages.length, 2);
  assert.ok(f.read('new').issues.some(i => i.code === 'TASK_ROUTE_UNREPORTED'));
  // Source shrink/rewrite never deletes archived messages.
  const rows = readFileSync(f.path, 'utf8').trim().split('\n'); writeFileSync(f.path, rows.slice(0, 2).join('\n') + '\n');
  await f.sync(); assert.equal(f.read('new').messages.length, 2);
});
test('explicit exclusion, chat pause and resume are body-free tombstones across catch-up', async t => {
  const f = fixture(t);
  for (const [id, policy] of [['one', 'exclude'], ['two', 'capture'], ['three', 'pause'], ['four', 'capture'], ['five', 'resume']]) {
    f.start(id, `2026-01-0${{ one:2,two:3,three:4,four:5,five:6 }[id]}T00:00:00Z`);
    f.message(`u-${id}`, 'user', `secret-${id}`); f.output(f.receipt(id, id, policy));
  }
  await f.sync();
  assert.equal(f.read('one').status, 'excluded'); assert.equal(f.read('two').messages.length, 1);
  assert.equal(f.read('four').messages.length, 0); assert.equal(f.read('five').messages.length, 1);
  for (const id of ['one', 'three', 'four']) assert.doesNotMatch(readFileSync(join(f.root, turnPath(f.id, id)), 'utf8'), /secret-/);
  await f.sync(); assert.equal(f.read('four').messages.length, 0);
});
test('a paused chat can explicitly resume its new turn after an early Hook placeholder', async t=>{
  const f=fixture(t);f.start('pause');f.output(f.receipt('pause','pause','pause'));await f.sync();
  f.start('resume','2026-01-03T00:00:00Z');f.message('u','user','恢复记录本轮对话');
  await f.sync();assert.equal(f.read('resume').policy,'exclude');assert.equal(f.read('resume').messages.length,0);
  f.output(f.receipt('resume','resume','resume'));await f.sync();assert.equal(f.read('resume').policy,'capture');assert.equal(f.read('resume').messages.length,1);
  assert.equal(f.read('pause').messages.length,0);await f.sync();assert.deepEqual(f.read('resume').issues,[]);
});
test('read-only signed receipts reject cross-turn, forged and quoted declarations; revisions persist', async t => {
  const f = fixture(t); f.start('one'); f.message('u', 'user', '输入');
  const before = readdirSync(join(f.root, CAPTURE));
  const receipt = f.receipt('one', 'event');
  assert.deepEqual(readdirSync(join(f.root, CAPTURE)), before);
  f.message('quoted', 'user', receipt.receipt); // A user quotation cannot become a route.
  await f.sync(); assert.equal(f.read('one').routes.length, 0);
  f.output(receipt); f.message('a', 'assistant', '初版', 'final_answer'); await f.sync();
  f.message('a', 'assistant', '修订版', 'final_answer'); await f.sync();
  assert.equal(f.read('one').messages.find(m => m.id === 'a').revisions[0].content[0].text, '初版');
  const bytes = readFileSync(join(f.root, turnPath(f.id, 'one'))); await f.sync();
  assert.deepEqual(readFileSync(join(f.root, turnPath(f.id, 'one'))), bytes);
  f.start('two', '2026-01-03T00:00:00Z'); f.output(receipt);
  await f.sync(); assert.equal(f.read('two').routes.length, 0); assert.equal(f.read('two').policy, 'pending'); // No visible user input in this turn.
});
test('observed numeric native timestamps, ambient wrappers, question answers and attachments are preserved', async t => {
  const f = fixture(t);
  f.append({ type:'event_msg', timestamp:'2026-01-02T00:00:00Z', payload:{type:'task_started',turn_id:'new',started_at:1767312000} });
  f.message('u', 'user', '\n<in-app-browser-context source="ambient-ui-state">automatic</in-app-browser-context>\n\n## My request:\n用户真正要求');
  f.message('attachment','user','附件',undefined,{content:[{type:'input_image',image_url:'file:///sample.png'}]});
  f.append({type:'response_item',timestamp:'2026-01-02T00:00:01Z',payload:{type:'function_call',name:'request_user_input',call_id:'ask',arguments:JSON.stringify({questions:[{id:'q',question:'真实问题'}]})}});
  f.append({type:'response_item',timestamp:'2026-01-02T00:00:02Z',payload:{type:'function_call_output',call_id:'ask',output:JSON.stringify({answers:{q:{answers:['用户选择']}}})}});
  f.output(f.receipt('new','policy'));
  f.append({type:'response_item',payload:{type:'reasoning',summary:[{text:'隐藏推理不采集'}]}});
  await f.sync();
  const turn=f.read('new'); assert.equal(turn.startedAt,'2026-01-02T00:00:00.000Z');
  assert.equal(turn.messages[0].content[0].text,'用户真正要求');
  assert.equal(turn.messages.filter(m=>m.phase==='answer').length,1);
  assert.equal(turn.messages.find(m=>m.id==='attachment').content[0].image_url,'file:///sample.png');
  assert.doesNotMatch(JSON.stringify(turn),/隐藏推理不采集|automatic/);
});
test('session isolation, native interruption, source movement, rebuild and unknown formats are explicit', async t => {
  const f=fixture(t);f.start('new');f.message('u','user','原文');f.output(f.receipt('new','route'));
  await taskHook({root:f.root,env:f.env,input:{session_id:f.env.CODEX_THREAD_ID,turn_id:'new',hook_event_name:'Interrupt',transcript_path:f.path}});
  assert.equal(f.read('new').status,'interrupted');
  const second=join(f.home,'sessions/rollout-two.jsonl');
  writeFileSync(second,JSON.stringify({type:'session_meta',payload:{id:'second-chat',cwd:f.root}})+'\n'+readFileSync(f.path,'utf8').split('\n').slice(1).join('\n'));
  await f.sync();const other=sessionKey(f.root,{host:'codex',sessionId:'second-chat'});
  const otherTurn = readTask({root:f.root,taskId:other,turnId:'new'}).turn;
  assert.equal(otherTurn.messages.length,1); assert.equal(otherTurn.routes.length,0); assert.equal(otherTurn.declarations.length,0);
  assert.equal(f.read('new').messages.length,1);
  rmSync(join(f.root,CAPTURE,'sources'),{recursive:true});rmSync(join(f.root,ARCHIVE,f.id,'task.json'));
  await f.sync();assert.equal(listTasks({root:f.root}).total,2);
  f.append({type:'response_item',payload:{type:'message',id:'unsupported',role:'user',content:{unknown:'shape'}}});
  assert.equal((await f.sync()).errors[0].code,'TASK_SOURCE_UNSUPPORTED');
  assert.equal(f.read('new').messages.length,1);
});
test('legacy pending placeholders are repaired on unchanged sources without crossing the activation baseline', async t => {
  const f = fixture(t);
  f.start('before', '2025-12-31T00:00:00Z'); f.message('old', 'user', '启用前正文不导入');
  f.start('unreported'); f.message('u', 'user', '第十二轮的提问'); f.message('a', 'assistant', '已有最终答复', 'final_answer');
  f.append({ type: 'event_msg', timestamp: '2026-01-02T00:00:04Z', payload: { type: 'task_complete', turn_id: 'unreported' } });
  await f.sync();
  const path = join(f.root, turnPath(f.id, 'unreported')), old = f.read('unreported');
  writeFileSync(path, JSON.stringify({ ...old, policy: 'pending', status: 'pending', messages: [], issues: [] }));
  const folder = join(f.root, CAPTURE, 'sources'), index = join(folder, readdirSync(folder)[0]);
  const cursor = JSON.parse(readFileSync(index)); delete cursor.policyVersion; writeFileSync(index, JSON.stringify(cursor));
  await syncTasks({ root: f.root, env: f.env });
  const repaired = f.read('unreported');
  assert.equal(repaired.status, 'completed'); assert.equal(repaired.messages.length, 2); assert.equal(repaired.routes.length, 0);
  assert.equal(repaired.messages[0].id, 'u'); assert.equal(repaired.messages[1].phase, 'final_answer');
  assert.equal(f.read('before'), null);
  const bytes = readFileSync(path); await f.sync(); assert.deepEqual(readFileSync(path), bytes);
});
test('recording restriction cues suspend automatic storage before a declaration, including later turns', async t => {
  for (const prompt of ['本轮不记录，这些是私密资料', '不记录对话，这些是私密资料', '不要记录这一轮', '暂停当前聊天的记录', '别记录我们的对话', "Do not record this conversation."]) {
    const f = fixture(t); f.start('restricted'); f.message('u', 'user', prompt);
    await f.sync();
    assert.equal(f.read('restricted').policy, 'pending'); assert.equal(f.read('restricted').messages.length, 0);
    assert.ok(f.read('restricted').issues.some(i => i.code === 'TASK_CAPTURE_POLICY_PENDING'));
    assert.doesNotMatch(readFileSync(join(f.root, turnPath(f.id, 'restricted')), 'utf8'), /私密资料|Do not record/);
    f.start('later', '2026-01-03T00:00:00Z'); f.message('later-u', 'user', '后续正文');
    f.output(f.receipt('later', 'capture', 'capture')); await f.sync();
    assert.equal(f.read('later').policy, 'pending'); assert.equal(f.read('later').messages.length, 0);
    assert.doesNotMatch(readFileSync(join(f.root, turnPath(f.id, 'later')), 'utf8'), /明确的安排说明/);
    f.output(f.receipt('later', 'resume', 'resume')); await f.sync();
    assert.equal(f.read('later').policy, 'capture'); assert.equal(f.read('later').messages.length, 1);
    assert.equal(f.read('later').routes.length, 2); // Earlier verified receipts rehydrate after a hold is resolved.
    assert.equal(f.read('restricted').messages.length, 0);
    await f.sync(); assert.equal(f.read('restricted').messages.length, 0);
  }
});
test('restriction examples need a policy, while signed exclusion and pause remain authoritative before catch-up', async t => {
  const f = fixture(t); f.start('example'); f.message('u', 'user', '解释“不记录对话”按钮的含义');
  await f.sync(); assert.equal(f.read('example').messages.length, 0);
  f.output(f.receipt('example', 'ordinary', 'capture', { report: undefined })); await f.sync();
  assert.equal(f.read('example').messages.length, 1); assert.equal(f.read('example').chatPolicyHeld, false);
  f.start('excluded', '2026-01-03T00:00:00Z'); f.message('private', 'user', '本轮不记录，私密正文');
  await f.sync(); assert.equal(f.read('excluded').messages.length, 0);
  f.output(f.receipt('excluded', 'exclude', 'exclude')); await f.sync();
  assert.equal(f.read('excluded').policy, 'exclude'); assert.equal(f.read('excluded').explicitExcluded, true);
  f.start('ordinary', '2026-01-04T00:00:00Z'); f.message('ordinary-u', 'user', '下一轮仍应自动归档');
  await f.sync(); assert.equal(f.read('ordinary').messages.length, 1); assert.equal(f.read('ordinary').routes.length, 0);
  f.start('pause', '2026-01-05T00:00:00Z'); f.message('pause-u', 'user', '不记录对话，暂停聊天采集');
  f.output(f.receipt('pause', 'pause', 'pause')); await f.sync();
  f.start('paused', '2026-01-06T00:00:00Z'); f.message('paused-u', 'user', '仍需排除的正文');
  await f.sync(); assert.equal(f.read('paused').policy, 'exclude'); assert.equal(f.read('paused').messages.length, 0);
  assert.equal(f.read('excluded').messages.length, 0); assert.equal(f.read('pause').messages.length, 0);
});
test('dead writer lock recovers, live lock conflicts, and disabled capture performs zero writes', async t => {
  const f=fixture(t);f.start('new');f.output(f.receipt('new','policy'));await f.sync();
  const lock=join(f.root,CAPTURE,'locks',f.id+'.lock');
  writeFileSync(lock,JSON.stringify({pid:process.pid}));assert.equal((await f.sync()).errors[0].code,'TASK_LOCKED');rmSync(lock);
  // Obtain a real exited PID instead of assuming an arbitrary number is unused.
  const child=spawn(process.execPath,['-e','']);await new Promise(resolve=>child.once('exit',resolve));
  writeFileSync(lock,JSON.stringify({pid:child.pid}));assert.deepEqual((await f.sync()).errors,[]);assert.equal(existsSync(lock),false);
  const cfg=join(f.root,CAPTURE,'config.json');const settings=JSON.parse(readFileSync(cfg));writeFileSync(cfg,JSON.stringify({...settings,enabled:false}));
  const before=readFileSync(join(f.root,CAPTURE,'last-sync.json'));
  assert.equal((await f.sync()).skipped,true);assert.deepEqual(readFileSync(join(f.root,CAPTURE,'last-sync.json')),before);
  assert.deepEqual(await taskHook({root:f.root,input:{}}),{});
});
test('route archive exceeds both v1 limits and preserves explicit selection reasons', async t => {
  const f = fixture(t); f.start('new'); f.message('u', 'user', '输入');
  for (let n = 0; n < 4100; n++) f.output(f.receipt('new', `event${n}`));
  await f.sync();
  assert.equal(f.read('new').routes.length, 4100);
  const projection = taskRouteProjections(f.root).records[0];
  assert.equal(projection.history.length, 50); assert.equal(projection.historyDropped, 4050);
  assert.equal(f.read('new').routes[0].reason, '明确的安排说明');
});
test('Hooks merge without replacing handlers, remain nonblocking and bind native IDs', async t => {
  const f = fixture(t); mkdirSync(join(f.root, '.codex'));
  writeFileSync(join(f.root, '.codex/hooks.json'), JSON.stringify({ description: 'keep', hooks: { Stop: [{ hooks: [{ type:'command', command:'other' }] }] } }));
  installTaskHooks({ root: f.root }); installTaskHooks({ root: f.root });
  const installed = JSON.parse(readFileSync(join(f.root, '.codex/hooks.json')));
  assert.equal(installed.hooks.Stop.length, 2); assert.equal(installed.description, 'keep');
  f.start('new');
  const output = await taskHook({ root: f.root, env: f.env, input: { hook_event_name:'UserPromptSubmit', session_id:f.env.CODEX_THREAD_ID, turn_id:'new', transcript_path:f.path } });
  assert.match(output.hookSpecificOutput.additionalContext, /turnId=new/);
  const bad = await runTaskCommand(['hook'], f.root, { env:f.env, stdin:{} });
  assert.equal(bad.exitCode, 0); assert.equal(JSON.parse(bad.stdout).continue, undefined);
});
test('queries never create files; disabled capture, corruption and path escape preserve originals', async t => {
  const f = routingFixture(t);
  assert.equal(listTasks({ root:f.root }).total, 0); assert.equal(existsSync(join(f.root, CAPTURE)), false);
  assert.equal((await syncTasks({ root:f.root })).skipped, true); assert.equal(existsSync(join(f.root, CAPTURE)), false);
  assert.throws(() => readTask({ root:f.root, taskId:'../bad' }), { code:'INVALID_ARGUMENTS' });
  const g = fixture(t); g.start('new'); g.output(g.receipt('new', 'event')); await g.sync();
  const path = join(g.root, turnPath(g.id, 'new')); writeFileSync(path, '{');
  assert.equal((await g.sync()).errors[0].code, 'TASK_DATA_INVALID'); assert.equal(readFileSync(path, 'utf8'), '{');
  rmSync(path); symlinkSync('/etc/passwd', path);
  assert.throws(() => g.read('new'), { code:'ROUTE_PATH_INVALID' });
});
test('independent collectors serialize the same native turn without losing or duplicating facts', async t => {
  const f=fixture(t);f.start('new');f.message('user','user','原话');f.output(f.receipt('new','event'));
  const service=new URL('../src/services/tasks.js',import.meta.url).href;
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',`import { syncTasks } from ${JSON.stringify(service)}; console.log(JSON.stringify(await syncTasks(JSON.parse(process.argv[1]))));`,JSON.stringify({root:f.root,env:f.env,force:true})]);
    let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);
    child.on('exit',code=>code?reject(new Error(stderr)):resolve(JSON.parse(stdout)));
  });
  const results=await Promise.all([run(),run()]);
  assert.ok(results.some(r=>r.errors.length===0));
  assert.ok(results.every(r=>r.errors.every(e=>e.code==='TASK_LOCKED')));
  await f.sync();assert.equal(f.read('new').messages.length,1);assert.equal(f.read('new').routes.length,1);
});
test('incremental append resumes at a native boundary and full repair recovers source revisions', async t=>{
  const f=fixture(t);f.start('one');f.message('u1','user','第一轮');f.output(f.receipt('one','one'));
  f.message('a1','assistant','答复','final_answer');f.append({type:'event_msg',timestamp:'2026-01-02T00:00:05Z',payload:{type:'task_complete',turn_id:'one'}});
  await f.sync();
  f.start('two','2026-01-03T00:00:00Z');f.message('u2','user','第二轮');f.output(f.receipt('two','two'));
  await syncTasks({root:f.root,env:f.env});assert.equal(f.read('two').messages.length,1);assert.equal(f.read('one').messages.length,2);
  const file=readFileSync(f.path,'utf8');writeFileSync(f.path,file.replace('第一轮','修订轮'));
  await f.sync();assert.equal(f.read('one').messages[0].content[0].text,'修订轮');assert.equal(f.read('one').messages[0].revisions[0].content[0].text,'第一轮');
});
test('real fragmented stdin produces a read-only declaration without exposing host identity',async t=>{
  const f=fixture(t),adapter=new URL('../src/commands/tasks.js',import.meta.url).href;
  const script=`import { runTaskCommand } from ${JSON.stringify(adapter)};const r=await runTaskCommand(['declare','--from','-','--json'],${JSON.stringify(f.root)},{env:${JSON.stringify(f.env)}});process.stdout.write(r.stdout);process.exitCode=r.exitCode;`;
  const before=readdirSync(join(f.root,'.agents/runtime-data'),{recursive:true}).sort();
  const child=spawn(process.execPath,['--input-type=module','-e',script]);let output='',stderr='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code))});
  const value=JSON.stringify({turnId:'new',eventId:'stdin',policy:'capture',reason:'只读任务仍归档对话'});
  child.stdin.write(value.slice(0,12));setTimeout(()=>child.stdin.end(value.slice(12)),30);
  assert.equal(await done,0,stderr);assert.equal(JSON.parse(output).data.readOnly,true);
  assert.doesNotMatch(output,/codex-chat-one/);
  assert.deepEqual(readdirSync(join(f.root,'.agents/runtime-data'),{recursive:true}).sort(),before);
});
test('lost identity key cannot silently reinitialize a task-only store',async t=>{
  const f=fixture(t);f.start('new');f.output(f.receipt('new','route'));await f.sync();
  rmSync(join(f.root,'.agents/runtime-data/routing/v1/identity.key'));
  rmSync(join(f.root,CAPTURE,'config.json'));
  assert.throws(()=>enableCapture({root:f.root}),{code:'ROUTE_KEY_INVALID'});
  assert.equal(existsSync(join(f.root,'.agents/runtime-data/routing/v1/identity.key')),false);
});

test('latestReported remains native-turn-bound when the newest turn is unreported; search precedes pagination', async t => {
  const f = fixture(t); f.addProject('实施项目');
  f.start('reported'); f.message('u1', 'user', '设计路由工作台');
  f.output(f.receipt('reported', 'r1', 'capture', { report: f.report({ project: { state: 'bound', primary: { name: '实施项目', scope: 'current' } } }) }));
  await f.sync();
  f.start('newest', '2026-01-03T00:00:00Z'); f.message('u2', 'user', '新轮次尚未报告');
  f.output(f.receipt('newest', 'policy', 'capture', { report: undefined })); await f.sync();
  const task = listTasks({ root: f.root }).records[0];
  assert.equal(task.route, null); assert.equal(task.lastRouteAt, null);
  assert.equal(task.lastTurn.turnId, 'newest');
  assert.equal(task.latestReported.turnId, 'reported'); assert.equal(task.latestReported.turnNumber, 1);
  assert.equal(task.latestReported.route.project.primary.name, '实施项目');
  assert.equal(listTasks({ root: f.root, q: '不存在', limit: 1 }).total, 0);
  assert.equal(listTasks({ root: f.root, q: '实施项目', project: 'current:实施项目', limit: 1 }).total, 1);
  assert.equal(listTasks({ root: f.root, project: 'state:none' }).total, 0);
  assert.equal(listTasks({ root: f.root }).projects[0].value, 'current:实施项目');
  assert.equal(readTask({ root: f.root, taskId: f.id }).turns[0].turnNumber, 2);
  assert.equal(readTask({ root: f.root, taskId: f.id, turnId: 'reported', includeMessages: false }).turn.messages, undefined);
  assert.equal(f.read('reported').messages.length, 1);
  for (const input of [{ q: 'x'.repeat(201) }, { project: 'x'.repeat(257) }]) assert.throws(() => listTasks({ root: f.root, ...input }), { code: 'INVALID_ARGUMENTS' });
});

test('multiple reports at the same timestamp retain the final declared arrangement', async t => {
  const f = fixture(t); f.start('one');
  f.output(f.receipt('one', 'first')); f.output(f.receipt('one', 'last', 'capture', { report: f.report({ status: 'completed' }) })); await f.sync();
  const path = join(f.root, turnPath(f.id, 'one')), turn = JSON.parse(readFileSync(path));
  for (const event of turn.routes) event.at = '2026-01-02T00:00:03Z'; writeFileSync(path, JSON.stringify(turn));
  assert.equal(listTasks({ root: f.root }).records[0].latestReported.eventId, 'last');
  assert.equal(listTasks({ root: f.root }).records[0].latestReported.route.status, 'completed');
});

test('native internal workers are skipped while user-created chat forks remain capturable', async t => {
  const f = fixture(t), child = join(f.home, 'sessions/rollout-child.jsonl');
  const childRows = [
    { type: 'session_meta', payload: { id: 'internal-worker', cwd: f.root, parent_thread_id: f.env.CODEX_THREAD_ID, source: { subagent: { thread_spawn: { parent_thread_id: f.env.CODEX_THREAD_ID, depth: 1 } } } } },
    { type: 'event_msg', timestamp: '2026-01-02T00:00:00Z', payload: { type: 'task_started', turn_id: 'child-turn' } },
    { type: 'response_item', timestamp: '2026-01-02T00:00:01Z', payload: { type: 'message', id: 'internal-input', role: 'user', content: [{ type: 'input_text', text: '内部审查指令不是用户聊天' }] } },
  ];
  writeFileSync(child, childRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual((await f.sync()).errors, []);
  assert.equal(listTasks({ root: f.root }).total, 0);
  assert.equal((await syncTasks({ root: f.root, env: f.env, transcriptPath: child, force: true })).errors[0].code, 'TASK_SOURCE_INTERNAL');
  assert.deepEqual(await taskHook({ root: f.root, input: { hook_event_name: 'UserPromptSubmit', turn_id: 'child-turn', session_id: 'internal-worker', transcript_path: child } }), {});
  assert.equal(listTasks({ root: f.root }).total, 0);
  const fork = join(f.home, 'sessions/rollout-fork.jsonl'), env = { ...f.env, CODEX_THREAD_ID: 'user-fork' };
  const receipt = declareTask({ root: f.root, env, input: { turnId: 'fork-turn', eventId: 'policy', policy: 'capture', reason: '用户创建的普通聊天分支' } });
  writeFileSync(fork, [
    { type: 'session_meta', payload: { id: env.CODEX_THREAD_ID, cwd: f.root, parent_thread_id: f.env.CODEX_THREAD_ID, source: 'desktop' } },
    { type: 'event_msg', timestamp: '2026-01-02T00:00:00Z', payload: { type: 'task_started', turn_id: 'fork-turn' } },
    { type: 'response_item', timestamp: '2026-01-02T00:00:01Z', payload: { type: 'message', id: 'fork-input', role: 'user', content: [{ type: 'input_text', text: '真实用户的聊天分支' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify(receipt) } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual((await f.sync()).errors, []);
  const tasks = listTasks({ root: f.root }); assert.equal(tasks.total, 1); assert.equal(tasks.records[0].title, '真实用户的聊天分支');
});
