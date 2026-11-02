import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { routingFixture } from './helpers/routing-fixture.js';
import { enableChat, registerChatTurn, readChat, mutateChat, chatConfig } from '../src/services/chat.js';
import { taskHook, enableCapture, declareTask } from '../src/services/tasks.js';
import { runChatCommand } from '../src/commands/chat.js';
import { syncChat } from '../src/services/chat-sync.js';
import { listUserData } from '../src/services/user-data.js';
import { DIRECTORY, CONFIG } from '../src/chat-state/storage.js';

function fixture(t, enabled = true) {
  const f = routingFixture(t), identity = { host: 'codex', sessionId: randomUUID() }, env = { CODEX_THREAD_ID: identity.sessionId };
  if (enabled) enableChat({ root: f.root, at: '2026-01-01T00:00:00Z' });
  const options = { root: f.root, identity, env };
  const start = turnId => registerChatTurn({ ...options, turnId });
  const read = extra => readChat({ ...options, ...extra });
  const mutate = extra => mutateChat({ ...options, ...extra });
  const use = (objectId, turnId = 'one') => mutate({ operation: 'use', objectId, turnId });
  return { ...f, identity, env, options, start, read, mutate, use };
}
function files(root) {
  const result = {};
  function visit(path) { for (const e of readdirSync(path, { withFileTypes: true })) { const p = join(path, e.name); if (e.isDirectory()) visit(p); else result[p.slice(root.length)] = readFileSync(p, 'utf8'); } }
  visit(root); return result;
}
function nativeSource(f,extra={}) {
  const home=join(f.root,'native'),path=join(home,'sessions','rollout-fixture-'+f.identity.sessionId+'.jsonl');mkdirSync(join(home,'sessions'),{recursive:true});
  const meta={id:f.identity.sessionId,cwd:f.root,timestamp:'2026-01-02T00:00:00Z',...extra};
  const save=(rows,override={})=>writeFileSync(path,[{type:'session_meta',payload:{...meta,...override}},...rows].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const start=(id,at='2026-01-02T00:00:01Z')=>({type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:id}});
  const env={...f.env,CODEX_HOME:home};return{path,home,save,start,env,sync:()=>syncChat({root:f.root,env})};
}
test('explicit native synchronization registers real active boundaries without capturing bodies or implying adoption',async t=>{
  const f=fixture(t),n=nativeSource(f);
  n.save([n.start('old','2025-12-31T00:00:00Z'),n.start('one'),{type:'event_msg',payload:{type:'task_complete',turn_id:'one'}},n.start('two','2026-01-02T00:01:00Z'),{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'PRIVATE_NATIVE_BODY_CANARY'}]}}]);
  const original=readFileSync(n.path);assert.equal(f.read().system.turnId,null);
  const result=await n.sync();assert.equal(result.registration,'native-transcript');assert.equal(result.context.system.turnId,'two');assert.equal(result.context.system.chatTurnNumber,2);assert.equal(result.context.abilities.length,0);
  const before=files(join(f.root,DIRECTORY));await n.sync();assert.deepEqual(files(join(f.root,DIRECTORY)),before);assert.doesNotMatch(JSON.stringify(before),/PRIVATE_NATIVE_BODY_CANARY/);assert.deepEqual(readFileSync(n.path),original);
  assert.equal(f.use('partner.test.a','two').system.abilityTurnNumber,1);
  const cli=JSON.parse((await runChatCommand(['sync','--json'],f.root,{env:n.env})).stdout);assert.equal(cli.data.context.system.turnId,'two');
});
test('native first-turn synchronization preserves envelope precision beyond rounded started_at',async t=>{
  const f=fixture(t),n=nativeSource(f,{timestamp:'2026-01-02T00:00:00.419Z'});
  n.save([{type:'event_msg',timestamp:'2026-01-02T00:00:00.584Z',payload:{type:'task_started',turn_id:'first',started_at:1767312000}}]);
  assert.equal((await n.sync()).context.system.chatTurnNumber,1);assert.equal(f.read().system.turnId,'first');
});
test('native synchronization rejects other roots, identity mismatch, internal workers and ambiguous sources without creating a ledger',async t=>{
  const f=fixture(t),n=nativeSource(f);
  for(const override of [{cwd:join(f.root,'other')},{id:'different-session'},{source:{subagent:'worker'}}]){n.save([n.start('one')],override);await assert.rejects(n.sync(),{code:'CHAT_SOURCE_IDENTITY'});assert.equal(f.read().system.turnId,null);}
  n.save([n.start('one')]);mkdirSync(join(n.home,'archived_sessions'));writeFileSync(join(n.home,'archived_sessions','rollout-copy-'+f.identity.sessionId+'.jsonl'),readFileSync(n.path));await assert.rejects(n.sync(),{code:'CHAT_SOURCE_AMBIGUOUS'});assert.equal(f.read().system.turnId,null);
});
test('native synchronization rejects terminal, partial and unsupported sources and never initializes disabled tracking',async t=>{
  const f=fixture(t),n=nativeSource(f);
  for(const event of ['task_complete','turn_aborted','task_interrupted']){n.save([n.start('one'),{type:'event_msg',payload:{type:event,turn_id:'one'}}]);await assert.rejects(n.sync(),{code:'CHAT_TURN_UNAVAILABLE'});}
  n.save([n.start('one')]);writeFileSync(n.path,readFileSync(n.path,'utf8')+'{"unfinished":');await assert.rejects(n.sync(),{code:'CHAT_SOURCE_PARTIAL'});
  n.save([n.start(undefined)]);await assert.rejects(n.sync(),{code:'CHAT_SOURCE_UNSUPPORTED'});assert.equal(f.read().system.turnId,null);
  const disabled=fixture(t,false),before=files(disabled.root);assert.equal((await syncChat({root:disabled.root,env:disabled.env})).reason,'disabled');assert.deepEqual(files(disabled.root),before);
  assert.equal((await runChatCommand(['sync','--turn','invented','--json'],f.root,{env:n.env})).exitCode,2);
});
test('native synchronization excludes inherited fork boundaries and preserves an established creation baseline',async t=>{
  const f=fixture(t),n=nativeSource(f,{parent_thread_id:'parent',timestamp:'2026-01-03T00:00:00Z'});n.save([n.start('inherited'),n.start('fresh','2026-01-04T00:00:00Z')]);
  assert.equal((await n.sync()).context.system.chatTurnNumber,1);const before=files(join(f.root,DIRECTORY));n.save([n.start('fresh','2026-01-04T00:00:00Z')],{timestamp:'2026-01-03T01:00:00Z'});await assert.rejects(n.sync(),{code:'CHAT_SOURCE_IDENTITY'});assert.deepEqual(files(join(f.root,DIRECTORY)),before);
});
test('missing reads are read-only and never invent an identity or native count', t => {
  const f = fixture(t, false), before = files(f.root);
  assert.equal(f.read().system.chatTurnNumber, null);
  assert.deepEqual(files(f.root), before);
  assert.throws(() => readChat({ root: f.root, env: {} }), { code: 'CHAT_IDENTITY_REQUIRED' });
  assert.throws(() => f.read({ objectId: '../bad' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => f.mutate({ operation: 'write', values: {}, ifMatch: 'missing' }), { code: 'CHAT_TURN_UNAVAILABLE' });
});
test('native turns count once across duplicate hooks, reopens and older replays; forks are isolated', t => {
  const f = fixture(t);
  assert.equal(f.start('one').chatTurnNumber, 1); assert.equal(f.start('one').replayed, true);
  f.start('two'); f.start('one');
  assert.equal(f.read().system.chatTurnNumber, 2); assert.equal(f.read().system.turnId, 'two');
  assert.equal(readChat(f.options).system.chatTurnNumber, 2);
  const other = { host: 'codex', sessionId: randomUUID() };
  assert.equal(registerChatTurn({ root: f.root, identity: other, turnId: 'fork-one' }).chatTurnNumber, 1);
  assert.deepEqual(readChat({ root: f.root, identity: other }).values, {});
  assert.doesNotMatch(JSON.stringify(files(join(f.root, DIRECTORY))), new RegExp(f.identity.sessionId));
  assert.equal(enableChat({ root: f.root, at: '2030-01-01T00:00:00Z' }).activatedAt, '2026-01-01T00:00:00Z');
});
test('all four capability types count only explicit participation and continue independently', t => {
  const f = fixture(t), a = 'partner.test.a', b = 'competency.test.b';
  f.start('one');
  assert.equal(f.read({ objectId: a }).system.abilityTurnNumber, 0);
  assert.equal(f.use(a).system.abilityTurnNumber, 1);
  const first = f.read({ objectId: a });
  assert.equal(f.use(a).etag, first.etag);
  f.start('two'); f.use(b, 'two');
  assert.equal(f.read({ objectId: a }).system.participatedInCurrentTurn, false);
  f.start('three'); f.use(a, 'three');
  assert.equal(f.read({ objectId: a }).system.abilityTurnNumber, 2);
  assert.equal(f.read({ objectId: b }).system.abilityTurnNumber, 1);
  for (const id of ['cooperation.test.w', 'data-package.test.d']) assert.equal(f.use(id, 'three').system.abilityTurnNumber, 1);
  assert.throws(() => f.use(a, 'one'), { code: 'CHAT_TURN_CONFLICT' });
});
test('variables use arbitrary runtime keys and types, preserve null and isolate scopes', t => {
  const f = fixture(t), key = `运行时-${randomUUID()}`, id = 'partner.test.dynamic'; f.start('one');
  const prototypeKeys = JSON.parse('{"__proto__":{"kept":true},"constructor":"data","toString":false}');
  let saved = f.mutate({ operation: 'write', values: { ...prototypeKeys, [key]: false, nil: null, 'a.b': { x: [1, true] } }, ifMatch: 'missing' });
  assert.equal(saved.system.chatTurnNumber, 1); assert.equal(saved.values[key], false); assert.equal(saved.values.__proto__.kept, true);
  const selected = f.read({ fields: [key, 'nil', 'absent', 'a.b'] });
  assert.deepEqual(selected.missingFields, ['absent']); assert.equal(selected.values.nil, null);
  assert.deepEqual(f.read({ objectId: id }).values, {});
  saved = f.mutate({ operation: 'write', values: { [key]: ['changed'], 'a.b': { replaced: true } }, ifMatch: saved.etag });
  assert.deepEqual(saved.values[key], ['changed']); assert.deepEqual(saved.values['a.b'], { replaced: true }); assert.equal(saved.values.nil, null);
  const privateState = f.mutate({ operation: 'write', objectId: id, values: { [key]: 42 }, ifMatch: 'missing' });
  assert.equal(privateState.system.abilityTurnNumber, 0); assert.equal(f.read({ objectId: id }).values[key], 42);
  assert.deepEqual(f.read().values[key], ['changed']);
  assert.equal(f.mutate({ operation: 'write', objectId: id, values: { [key]: 42 }, ifMatch: privateState.etag }).changed, false);
  assert.throws(() => f.mutate({ operation: 'write', values: { bad: Infinity }, ifMatch: saved.etag }), { code: 'INVALID_ARGUMENTS' });
});
test('remove retains counters; restart resets only one capability and rejects stale generations', t => {
  const f = fixture(t), a = 'partner.test.a', b = 'partner.test.b'; f.start('one'); f.use(a); f.use(b);
  let state = f.read({ objectId: a });
  state = f.mutate({ operation: 'write', objectId: a, values: { x: 1, y: 2 }, ifMatch: state.etag });
  const oldRun = state.system.runId;
  const partial = f.mutate({ operation: 'remove', objectId: a, fields: ['x', 'missing'], ifMatch: state.etag });
  assert.deepEqual(partial.values, { y: 2 }); assert.deepEqual(partial.missingFields, ['missing']);
  const empty = f.mutate({ operation: 'remove', objectId: a, all: true, ifMatch: partial.etag });
  assert.equal(empty.system.abilityTurnNumber, 1); assert.equal(empty.system.runId, oldRun);
  f.start('two'); f.use(a, 'two');
  const before = f.read({ objectId: a });
  const next = f.mutate({ operation: 'restart', objectId: a, turnId: 'two', ifMatch: before.etag });
  assert.notEqual(next.system.runId, oldRun); assert.equal(next.system.abilityTurnNumber, 1); assert.equal(next.system.chatTurnNumber, 2);
  assert.equal(f.use(a, 'two').etag, next.etag); assert.equal(f.read({ objectId: b }).system.abilityTurnNumber, 1);
  assert.throws(() => f.mutate({ operation: 'restart', objectId: a, turnId: 'two', ifMatch: before.etag }), { code: 'CHAT_CONFLICT' });
  assert.throws(() => f.use(a, 'one'), { code: 'CHAT_TURN_CONFLICT' });
});
test('previews and read-only work do not mutate files or register participation', t => {
  const f = fixture(t); f.start('one'); const before = files(f.root);
  const preview = f.mutate({ operation: 'write', values: { dynamic: true }, ifMatch: 'missing', dryRun: true });
  assert.equal(preview.changed, false); assert.equal(preview.wouldChange, true);
  f.mutate({ operation: 'use', objectId: 'partner.test.preview', turnId: 'one', dryRun: true });
  f.read({ objectId: 'partner.test.preview' });
  assert.deepEqual(files(f.root), before);
  assert.equal(f.read({ objectId: 'partner.test.preview' }).system.participatedInCurrentTurn, false);
  assert.throws(() => f.mutate({ operation: 'write', values: { big: 'a'.repeat(1024 * 1024) }, ifMatch: 'missing', dryRun: true }), { code: 'CHAT_CAPACITY' });
  assert.deepEqual(files(f.root), before);
});
test('CAS, publication races and live locks preserve current data', t => {
  const f = fixture(t); f.start('one');
  const saved = f.mutate({ operation: 'write', values: { x: 1 }, ifMatch: 'missing' });
  assert.throws(() => f.mutate({ operation: 'write', values: { x: 2 }, ifMatch: 'missing' }), { code: 'CHAT_CONFLICT' });
  const target = join(f.root, saved.path), replacement = JSON.parse(readFileSync(target)); replacement.values.x = 99; replacement.revision++;
  assert.throws(() => f.mutate({ operation: 'write', values: { x: 2 }, ifMatch: saved.etag, beforePublish() { writeFileSync(target, JSON.stringify(replacement)); } }), { code: 'CHAT_CONFLICT' });
  assert.equal(f.read().values.x, 99);
  const lock = join(f.root, '.agents/runtime-data/chat-state', `${saved.system.chatId}.lock`);
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => f.use('partner.test.lock'), { code: 'CHAT_LOCKED' });
  assert.ok(existsSync(lock));
});
test('corruption, unknown formats and symlinks are rejected without overwriting state', t => {
  const f = fixture(t); f.start('one');
  const state = f.mutate({ operation: 'write', values: { kept: 1 }, ifMatch: 'missing' }), target = join(f.root, state.path);
  writeFileSync(target, '{broken');
  assert.throws(() => f.read(), { code: 'CHAT_DATA_INVALID' });
  assert.throws(() => f.mutate({ operation: 'write', values: {}, ifMatch: 'missing' }), { code: 'CHAT_DATA_INVALID' });
  assert.equal(readFileSync(target, 'utf8'), '{broken');
  writeFileSync(target, JSON.stringify({ schemaVersion: 100 }));
  assert.throws(() => f.read(), { code: 'CHAT_VERSION_UNSUPPORTED' });
  rmSync(target); symlinkSync(join(f.root, CONFIG), target);
  assert.throws(() => f.read(), { code: 'USER_DATA_PATH_INVALID' });
});
test('chat data is recognized by inventory and a lost identity key cannot orphan it', t => {
  const f = fixture(t); f.start('one');
  assert.equal(listUserData({ root: f.root }).complete, true);
  rmSync(join(f.root, '.agents/runtime-data/routing/v1/identity.key'));
  assert.throws(() => enableChat({ root: f.root }), { code: 'ROUTE_KEY_INVALID' });
});
test('native dispatcher counts without body capture, validates identities and skips internal workers', async t => {
  const f = fixture(t), source = join(f.root, 'host.jsonl');
  const meta = (id, extra = {}) => writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.root, ...extra } }) + '\n');
  const hook = (id, event = 'UserPromptSubmit', session = f.identity.sessionId) => taskHook({ root: f.root, input: { session_id: session, turn_id: id, hook_event_name: event, transcript_path: source } });
  meta(f.identity.sessionId);
  assert.match((await hook('one')).hookSpecificOutput.additionalContext, /chatTurnNumber=1/);
  await hook('one'); await hook('one', 'PreCompact'); await hook('one', 'Interrupt'); await hook('one', 'Stop');
  assert.equal(f.read().system.chatTurnNumber, 1); assert.ok(!existsSync(join(f.root, '档案/对话')));
  await hook('two'); assert.equal(f.read().system.chatTurnNumber, 2);
  meta('mismatch'); assert.match((await hook('wrong')).hookSpecificOutput.additionalContext, /CHAT_SOURCE_IDENTITY/); assert.equal(f.read().system.chatTurnNumber, 2);
  meta('worker', { source: { subagent: 'review' } }); assert.deepEqual(await hook('worker-turn', 'UserPromptSubmit', 'worker'), {});
  meta('fork', { parent_thread_id: f.identity.sessionId, timestamp: '2026-01-02T00:00:00Z' }); await hook('fork-turn', 'UserPromptSubmit', 'fork');
  assert.equal(readChat({ root: f.root, identity: { host: 'codex', sessionId: 'fork' } }).system.chatTurnNumber, 1);
});
test('CLI validates inputs, reads stdin and literal fields, and keeps task declarations read-only', async t => {
  const f = fixture(t); f.start('one');
  const command = args => runChatCommand([...args, '--json'], f.root, { env: f.env });
  for (const args of [['write', '--data', '{}', '--from', '-'], ['remove', '--all', '--fields', 'x', '--if-match', 'missing'], ['use'], ['read', '--json'], ['read', '--unexpected']]) assert.equal((await command(args)).exitCode, 2);
  let result = await runChatCommand(['write', '--from', '-', '--if-match', 'missing', '--json'], f.root, { env: f.env, stdin: { 'runtime key': null } });
  assert.equal(result.exitCode, 0);
  result = await command(['read', '--fields', 'runtime key', 'unknown']);
  assert.deepEqual(JSON.parse(result.stdout).data.values, { 'runtime key': null });
  assert.deepEqual(JSON.parse(result.stdout).data.missingFields, ['unknown']);
  enableCapture({ root: f.root });
  const before = files(f.root);
  declareTask({ root: f.root, env: f.env, input: { turnId: 'one', eventId: 'declare', policy: 'capture', reason: '只读声明测试' } });
  assert.deepEqual(files(f.root), before); assert.equal(f.read().system.chatTurnNumber, 1);
});
test('hooks setup is idempotent, preserves other handlers and does not enable dialogue capture', async t => {
  const f = fixture(t, false); mkdirSync(join(f.root, '.codex'));
  writeFileSync(join(f.root, '.codex/hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-existing' }] }] } }));
  const run = () => runChatCommand(['hooks', '--json'], f.root, { env: f.env });
  assert.equal((await run()).exitCode, 0); const before = files(f.root);
  assert.equal((await run()).exitCode, 0); assert.deepEqual(files(f.root), before);
  assert.equal(chatConfig(f.root).enabled, true); assert.equal(readChat(f.options).system.chatTurnNumber, null);
  assert.ok(!existsSync(join(f.root, '.agents/runtime-data/task-capture/config.json')));
  assert.match(readFileSync(join(f.root, '.codex/hooks.json'), 'utf8'), /keep-existing/);
});
test('malformed capture configuration does not stop chat tracking', async t => {
  const f = fixture(t), source = join(f.root, 'native.jsonl');
  mkdirSync(join(f.root, '.agents/runtime-data/task-capture'), { recursive: true });
  writeFileSync(join(f.root, '.agents/runtime-data/task-capture/config.json'), '{broken');
  writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { id: f.identity.sessionId, cwd: f.root } }) + '\n');
  const output = await taskHook({ root: f.root, input: { session_id: f.identity.sessionId, turn_id: 'one', hook_event_name: 'UserPromptSubmit', transcript_path: source } });
  assert.match(output.hookSpecificOutput.additionalContext, /chatTurnNumber=1/);
  assert.match(output.hookSpecificOutput.additionalContext, /TASK_DATA_INVALID/);
  assert.equal(f.read().system.chatTurnNumber, 1);
});
test('malformed chat configuration does not stop dialogue capture', async t => {
  const f = fixture(t); enableCapture({ root: f.root, at: '2026-01-01T00:00:00Z' });
  writeFileSync(join(f.root, CONFIG), '{broken');
  const source = join(f.root, 'native.jsonl');
  writeFileSync(source, [
    { type: 'session_meta', payload: { id: f.identity.sessionId, cwd: f.root } },
    { type: 'event_msg', timestamp: '2026-01-02T00:00:00Z', payload: { type: 'task_started', turn_id: 'one' } },
    { type: 'response_item', timestamp: '2026-01-02T00:00:01Z', payload: { type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: '正文仍需采集' }] } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const output = await taskHook({ root: f.root, input: { session_id: f.identity.sessionId, turn_id: 'one', hook_event_name: 'UserPromptSubmit', transcript_path: source } });
  assert.match(output.hookSpecificOutput.additionalContext, /CHAT_DATA_INVALID/);
  assert.match(output.hookSpecificOutput.additionalContext, /KSF task capture:/);
  const archives = readdirSync(join(f.root, '档案/对话/Codex'));
  assert.match(readFileSync(join(f.root, '档案/对话/Codex', archives[0], 'turns/one.json'), 'utf8'), /正文仍需采集/);
});
test('native reconciliation recovers missed hooks after activation without saving historical bodies', async t => {
  const f = fixture(t), source = join(f.root, 'native.jsonl');
  const meta = { type: 'session_meta', payload: { id: f.identity.sessionId, cwd: f.root } };
  const start = (id, at) => ({ type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: id } });
  writeFileSync(source, [meta, start('old', '2025-12-31T00:00:00Z'), start('one', '2026-01-02T00:00:00Z'),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_BODY_NOT_CHAT_STATE' }] } },
    start('missed', '2026-01-03T00:00:00Z'), start('three', '2026-01-04T00:00:00Z')].map(JSON.stringify).join('\n') + '\n');
  f.start('one');
  const output = await taskHook({ root: f.root, input: { session_id: f.identity.sessionId, turn_id: 'three', hook_event_name: 'UserPromptSubmit', transcript_path: source } });
  assert.match(output.hookSpecificOutput.additionalContext, /chatTurnNumber=3/);
  assert.equal(f.read().system.chatTurnNumber, 3);
  assert.doesNotMatch(JSON.stringify(files(join(f.root, DIRECTORY))), /PRIVATE_BODY_NOT_CHAT_STATE|"old"/);
  writeFileSync(source, [meta, start('three', '2026-01-04T00:00:00Z')].map(JSON.stringify).join('\n') + '\n');
  await taskHook({ root: f.root, input: { session_id: f.identity.sessionId, turn_id: 'three', hook_event_name: 'UserPromptSubmit', transcript_path: source } });
  assert.equal(f.read().system.chatTurnNumber, 3);
});
test('late native boundaries insert before retained anchors and damaged metadata never guesses a count', async t => {
  const f = fixture(t); f.start('one'); f.start('three');
  // The current boundary may not yet have flushed into a compacted source.
  registerChatTurn({ ...f.options, turnId: 'three', observedTurnIds: ['two'] });
  assert.equal(f.read().system.chatTurnNumber, 3);
  assert.equal(f.read().system.turnId, 'three');
  registerChatTurn({ ...f.options, turnId: 'one', observedTurnIds: ['four'] });
  assert.equal(f.read().system.chatTurnNumber, 3); assert.equal(f.read().system.turnId, 'three');
  const source = join(f.root, 'bad.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { id: f.identity.sessionId, cwd: f.root } }) + '\n{broken}\n');
  const result = await taskHook({ root: f.root, input: { session_id: f.identity.sessionId, turn_id: 'four', hook_event_name: 'UserPromptSubmit', transcript_path: source } });
  assert.match(result.hookSpecificOutput.additionalContext, /CHAT_SOURCE_PARTIAL/);
  assert.equal(f.read().system.turnId, 'three');
});
test('a real native fork baseline excludes copied parent turns after global activation', async t => {
  const f = fixture(t), source = join(f.root, 'fork.jsonl'), identity = { host: 'codex', sessionId: 'child' };
  const rows = [
    { type: 'session_meta', payload: { id: 'child', cwd: f.root, parent_thread_id: f.identity.sessionId, timestamp: '2026-01-03T00:00:00Z' } },
    { type: 'event_msg', timestamp: '2026-01-02T00:00:00Z', payload: { type: 'task_started', turn_id: 'inherited-parent-turn' } },
    { type: 'event_msg', timestamp: '2026-01-04T00:00:00Z', payload: { type: 'task_started', turn_id: 'child-one' } },
  ];
  writeFileSync(source, rows.map(JSON.stringify).join('\n') + '\n');
  const output = await taskHook({ root: f.root, input: { session_id: 'child', turn_id: 'child-one', hook_event_name: 'UserPromptSubmit', transcript_path: source } });
  assert.match(output.hookSpecificOutput.additionalContext, /chatTurnNumber=1/);
  const state = readChat({ root: f.root, identity });
  assert.equal(state.system.chatTurnNumber, 1); assert.equal(state.system.countingSince, '2026-01-03T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(files(join(f.root, DIRECTORY))), /inherited-parent-turn/);
  delete rows[0].payload.timestamp;
  writeFileSync(source, rows.map(JSON.stringify).join('\n') + '\n');
  const invalid = await taskHook({ root: f.root, input: { session_id: 'child', turn_id: 'child-two', hook_event_name: 'UserPromptSubmit', transcript_path: source } });
  assert.match(invalid.hookSpecificOutput.additionalContext, /CHAT_SOURCE_UNSUPPORTED/);
  assert.equal(readChat({ root: f.root, identity }).system.chatTurnNumber, 1);
});
