import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { catalogPath, loadCatalog } from '../src/testing/catalog.js';
import { parseTestOptions, createTestPlan, assignShards } from '../src/testing/planner.js';
import { executeTestPlan, testEnvironment, scheduleTests } from '../src/testing/runner.js';
import { runTestCommand } from '../src/commands/test.js';
import { gitBinary, nullDevice } from './helpers/platform.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'KSF test 中文 ')), runtime = '.agents/core/runtime';
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['tests', 'testing', 'src']) mkdirSync(join(root, runtime, directory), { recursive: true });
  writeFileSync(join(root, runtime, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, runtime, 'src/input.js'), 'export const value=1;');
  const make = (name, suite = 'quick', code = "import{test}from'node:test';test('owned case',()=>{});") => {
    const path = `${runtime}/tests/${name}.test.js`; writeFileSync(join(root, path), code);
    return { id: name, owner: 'core', covers: ['core'], path, suite, platforms: ['darwin', 'win32', 'linux'], cacheable: true, inputs: [`${runtime}/src`], requirements: [], timeoutMs: 10000, seconds: { darwin: 1, win32: 1 } };
  };
  const catalog = { schemaVersion: 1, components: { core: { directory: runtime, testRoots: [`${runtime}/tests`] } }, risks: [{ paths: [`${runtime}/src/shared`], components: ['core'], reason: 'shared mechanics' }], tests: [make('fast'), make('slow', 'full')] };
  const save = () => writeFileSync(join(root, catalogPath), JSON.stringify(catalog)); save();
  return { root, runtime, catalog, make, save };
}
test('test options select quick by default and reject ambiguous or inherited invocation', () => {
  assert.equal(parseTestOptions([]).suite, 'quick');
  for (const args of [['--suite','unit'],['--suite'],['--suite','quick','--suite','full'],['--base','main'],['--files'],['--files','x','--changed'],['--component','core','--files','x'],['--shard','0/4'],['--shard','5/4'],['--reuse','--suite','full'],['--help','--json']]) assert.throws(() => parseTestOptions(args), { code: 'INVALID_ARGUMENTS' });
  const env = testEnvironment({ NODE_OPTIONS: '--test-shard=4/4 --require=untrusted', NODE_TEST_CONTEXT: 'child-v8', NODE_V8_COVERAGE: 'outside', PATH: 'tools' });
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.NODE_TEST_CONTEXT, undefined); assert.equal(env.NODE_V8_COVERAGE, undefined);
});
test('catalog audits every owned file and rejects duplicates, stale and unregistered tests', t => {
  const f = fixture(t); assert.equal(loadCatalog(f.root).tests.length, 2);
  f.make('forgotten'); assert.throws(() => loadCatalog(f.root), { code: 'TEST_UNREGISTERED' }); rmSync(join(f.root, f.runtime, 'tests/forgotten.test.js'));
  f.catalog.tests.push(f.catalog.tests[0]); f.save(); assert.throws(() => loadCatalog(f.root), { code: 'TEST_CATALOG_INVALID' });
  f.catalog.tests.pop(); f.save(); rmSync(join(f.root, f.catalog.tests[0].path)); assert.throws(() => loadCatalog(f.root), { code: 'TEST_CATALOG_STALE' });
});
test('quick/full inclusion, file selection, platform exclusions and empty diffs are explicit', t => {
  const f = fixture(t), quick = createTestPlan(f.root, parseTestOptions([])); assert.deepEqual(quick.tests.map(t => t.id), ['fast']);
  assert.equal(createTestPlan(f.root, parseTestOptions(['--suite','full'])).tests.length, 2);
  assert.throws(() => createTestPlan(f.root, parseTestOptions(['--files', f.catalog.tests[1].path])), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => createTestPlan(f.root, parseTestOptions(['--files','../outside.js'])), { code: 'TEST_PATH_INVALID' });
  assert.equal(createTestPlan(f.root, parseTestOptions(['--changed']), { changes: { paths: [] } }).status, 'not-applicable');
  const affected = createTestPlan(f.root, parseTestOptions(['--changed']), { changes: { paths: [f.runtime+'/src/shared/locks.js'] } });
  assert.deepEqual(affected.requiredFullComponents, ['core']); assert.equal(affected.suite, 'quick');
  f.catalog.tests[0].platforms = ['win32']; f.save(); const mac = createTestPlan(f.root, parseTestOptions([]), { platform: 'darwin' }); assert.equal(mac.tests.length, 0); assert.equal(mac.excludedPlatform.length, 1);
});
test('shards are deterministic, complete, disjoint and duration-balanced', () => {
  const files = [10,9,8,7,6,5].map((cost, i) => ({ id:String(i),path:String(i),seconds:{darwin:cost} }));
  const bins = assignShards(files, 3, 'darwin'); assert.deepEqual(bins.map(b => b.reduce((n,t)=>n+t.seconds.darwin,0)), [15,15,15]);
  assert.deepEqual(bins, assignShards([...files].reverse(), 3, 'darwin')); assert.equal(new Set(bins.flat().map(t=>t.id)).size, files.length);
});
test('exclusive files drain shared work, block following files and release capacity after failure', async () => {
  const started=[],active=new Set(),gates=new Map(),files=['shared-a','shared-b','exclusive','shared-c'];
  const work=files.map(id=>({id,isolation:id==='exclusive'?'exclusive':'shared'}));
  const done=scheduleTests(work,2,async item=>{
    if(item.isolation==='exclusive')assert.equal(active.size,0);
    else assert.equal(active.has('exclusive'),false);
    active.add(item.id);started.push(item.id);
    await new Promise(resolve=>gates.set(item.id,resolve));active.delete(item.id);
    return {status:item.id==='exclusive'?'failed':'passed'};
  },()=>false);
  const flush=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
  assert.deepEqual(started,['shared-a','shared-b']);
  gates.get('shared-b')();await flush();assert.deepEqual(started,['shared-a','shared-b']);
  gates.get('shared-a')();await flush();assert.deepEqual(started,['shared-a','shared-b','exclusive']);
  gates.get('exclusive')();await flush();assert.deepEqual(started,files);
  gates.get('shared-c')();await done;assert.equal(active.size,0);
});
test('cancellation while an exclusive file waits does not launch queued files',async()=>{
  let cancelled=false,release;const started=[];
  const done=scheduleTests([{id:'shared'},{id:'exclusive',isolation:'exclusive'},{id:'later'}],2,async item=>{
    started.push(item.id);await new Promise(resolve=>release=resolve);
  },()=>cancelled);
  cancelled=true;release();await done;assert.deepEqual(started,['shared']);
});
test('catalog rejects unknown resource policies before starting a test',t=>{
  const f=fixture(t);f.catalog.tests[0].isolation='exlusive';f.save();
  assert.throws(()=>loadCatalog(f.root),{code:'TEST_CATALOG_INVALID'});
});
test('the plan and execution receipt expose the same exclusive resource budget',async t=>{
  const f=fixture(t);f.catalog.tests[0].isolation='exclusive';f.save();
  const args=['--json'],plan=JSON.parse((await runTestCommand(['--plan',...args],f.root)).stdout).data;
  assert.deepEqual(plan.execution.exclusiveFiles,[f.catalog.tests[0].path]);assert.ok(plan.execution.maxParallelFiles>=1);
  const result=JSON.parse((await runTestCommand(args,f.root)).stdout).data;
  assert.deepEqual(result.execution,plan.execution);assert.equal(result.results[0].isolation,'exclusive');assert.equal(result.results[0].timeoutMs,10000);
});
test('planning loads no test modules and JSON is one structured envelope', async t => {
  const f = fixture(t); writeFileSync(join(f.root, f.catalog.tests[0].path), 'throw Error("MUST_NOT_IMPORT_WHILE_PLANNING");');
  const response = await runTestCommand(['--plan','--json'], f.root), value = JSON.parse(response.stdout);
  assert.equal(response.exitCode, 0); assert.equal(value.ok, true); assert.equal(value.data.phase, 'plan');
});
test('runner reports fresh execution, explicit reuse, input invalidation and failure without pollution', async t => {
  const prior={CI:process.env.CI,GITHUB_ACTIONS:process.env.GITHUB_ACTIONS};process.env.CI='false';delete process.env.GITHUB_ACTIONS;t.after(()=>{for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const f = fixture(t), run = async options => executeTestPlan(f.root, createTestPlan(f.root, parseTestOptions(options)), { progress: () => {} });
  const first = await run([]); assert.equal(first.ok, true); assert.equal(existsSync(first.result.temporaryDirectory),false); assert.equal(first.result.summary.executed, 1); assert.ok(first.result.results[0].counts.tests >= 1);
  assert.equal((await run([])).result.summary.reused, 0);
  assert.equal((await run(['--reuse'])).result.summary.reused, 1);
  writeFileSync(join(f.root, f.runtime, 'src/input.js'), 'changed'); assert.equal((await run(['--reuse'])).result.summary.executed, 1);
  writeFileSync(join(f.root, f.catalog.tests[0].path), "import{test}from'node:test';test('expected failure',()=>{throw Error('EXPECTED_FAILURE')});");
  const failed = await run([]); assert.equal(failed.ok, false); assert.equal(failed.result.results[0].status, 'failed');
  assert.match(readFileSync(failed.result.results[0].log,'utf8'), /EXPECTED_FAILURE/);
});
test('runner bounds timeout and refuses to certify inputs changed by a test', async t => {
  const f = fixture(t); f.catalog.tests[0].timeoutMs = 150; f.save();
  writeFileSync(join(f.root, f.catalog.tests[0].path), "import{test}from'node:test';test('never',()=>new Promise(()=>{}));setInterval(()=>{},1000);");
  const timed = await executeTestPlan(f.root, createTestPlan(f.root, parseTestOptions([])), { progress:()=>{} }); assert.equal(timed.ok,false); assert.equal(timed.result.results[0].status,'timed-out');
  f.catalog.tests[0].timeoutMs = 10000; f.save();
  writeFileSync(join(f.root, f.catalog.tests[0].path), "import{test}from'node:test';import{writeFileSync}from'node:fs';test('mutate input',()=>writeFileSync('src/input.js','new'));");
  const changed = await executeTestPlan(f.root, createTestPlan(f.root, parseTestOptions([])), { progress:()=>{} }); assert.equal(changed.ok,false); assert.equal(changed.result.status,'inputs-changed');
});
test('changed selection includes working, staged, untracked, deletion and both rename paths', t => {
  const f = fixture(t), env={...process.env,GIT_CONFIG_GLOBAL:nullDevice,GIT_CONFIG_SYSTEM:nullDevice};
  const git = args => {const r=spawnSync(gitBinary,['-C',f.root,...args],{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','--template=','--initial-branch=main']);git(['config','user.name','KSF Test']);git(['config','user.email','fixture@example.invalid']);git(['config','commit.gpgsign','false']);git(['add','.']);git(['commit','-m','fictional baseline']);
  git(['mv',f.catalog.tests[1].path,f.runtime+'/tests/renamed.test.js']); f.catalog.tests[1].path=f.runtime+'/tests/renamed.test.js';f.save();
  writeFileSync(join(f.root,f.runtime,'src/input.js'),'working');writeFileSync(join(f.root,'new.txt'),'untracked');
  const plan=createTestPlan(f.root,parseTestOptions(['--changed']));assert.ok(plan.changes.paths.includes('new.txt'));assert.ok(plan.changes.paths.includes(f.runtime+'/tests/slow.test.js'));assert.ok(plan.changes.paths.includes(f.runtime+'/tests/renamed.test.js'));assert.ok(plan.changes.paths.includes(f.runtime+'/src/input.js'));
  assert.throws(()=>createTestPlan(f.root,parseTestOptions(['--changed','--base','missing-ref'])),{code:'TEST_DIFF_UNAVAILABLE'});
});

test('missing dependencies are visible during plan and cannot produce execution success', async t => {
  const f=fixture(t);f.catalog.tests[0].requirements=['ksf-deliberately-missing-fixture-module'];f.save();
  const plan=createTestPlan(f.root,parseTestOptions([]));assert.equal(plan.missingDependencies.length,1);
  await assert.rejects(executeTestPlan(f.root,plan),{code:'TEST_DEPENDENCIES_MISSING'});
  assert.equal(JSON.parse((await runTestCommand(['--plan','--json'],f.root)).stdout).data.missingDependencies.length,1);
  const previous=process.env.CI;try{process.env.CI='yes';assert.throws(()=>parseTestOptions(['--reuse']),{code:'INVALID_ARGUMENTS'});}finally{if(previous===undefined)delete process.env.CI;else process.env.CI=previous;}
});
test('cancellation reports unexecuted scope and kills this run’s children', async t => {
  const f=fixture(t),marker=join(f.root,'started.json');
  writeFileSync(join(f.root,f.catalog.tests[0].path),`import{test}from'node:test';import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';test('waiting',()=>{const grandchild=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});grandchild.unref();writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,grandchild:grandchild.pid}));return new Promise(()=>{setInterval(()=>{},1000)})});`);
  const url=new URL('../src/commands/test.js',import.meta.url).href,code=`import{runTestCommand}from ${JSON.stringify(url)};process.stdin.once('data',()=>{process.stdin.pause();process.emit('SIGINT')});const r=await runTestCommand(['--json'],${JSON.stringify(f.root)});process.stdin.pause();process.stdout.write(r.stdout);process.exitCode=r.exitCode;`;
  const child=spawn(process.execPath,['--input-type=module','--eval',code],{env:testEnvironment(),stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
  t.after(()=>{try{child.kill('SIGKILL');}catch{}});
  const closed=new Promise(resolve=>child.once('close',code=>resolve(code)));
  for(let i=0;i<400;i++){try{JSON.parse(readFileSync(marker,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,25));}}
  const pid=JSON.parse(readFileSync(marker,'utf8')).pid;if(process.platform==='win32')child.stdin.end('cancel');else child.kill('SIGTERM');assert.equal(await closed,1);
  const result=JSON.parse(output);assert.equal(result.ok,false);assert.equal(result.data.status,'cancelled');assert.equal(result.data.results[0].status,'cancelled');assert.equal(existsSync(result.data.temporaryDirectory),false);
  assert.throws(()=>process.kill(pid,0));
  const grandchild=JSON.parse(readFileSync(marker,'utf8')).grandchild;
  // Reaping an already killed grandchild may be asynchronous on POSIX.
  for(let i=0;i<40;i++){try{process.kill(grandchild,0);await new Promise(r=>setTimeout(r,25));}catch{break;}}
  assert.throws(()=>process.kill(grandchild,0));
});
