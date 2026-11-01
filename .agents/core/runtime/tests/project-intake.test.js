import{platform}from'../src/platform/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync, renameSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planMaterials, applyMaterials } from '../src/services/project-intake.js';

const tool = fileURLToPath(new URL('../../abilities/competencies/project-intake/scripts/materials.mjs', import.meta.url));
function fixture(t, { file = false } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ksf intake '))), root = join(temp, 'ksf');
  const project = '星河方案', folder = join(root, '项目', project), source = join(temp, file ? '需求.md' : '客户材料');
  mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'project.md'), '# 星河方案\n确认照明交付资料。\n');
  if (file) writeFileSync(source, '# 需求\n亮度可调，预算未确认。\n');
  else { mkdirSync(join(source, '需求'), { recursive: true }); writeFileSync(join(source, '需求', '说明.md'), '# 需求\n亮度可调，预算未确认。\n'); }
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const args = { root, project, source };
  return { temp, root, project, folder, source, args, plan: () => planMaterials(args), apply: (plan, hooks) => applyMaterials({ root, project, plan }, hooks), target: rel => join(folder, '资料', file ? '需求.md' : '客户材料', ...(rel ? [rel] : [])) };
}
function bytes(path) { return readFileSync(path).toString('base64'); }
function tree(path) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const p = join(path, entry.name), stat = lstatSync(p);
    if (stat.isSymbolicLink()) return [[entry.name, 'link']];
    return stat.isDirectory() ? [[entry.name + '/', 'directory'], ...tree(p).map(([name, value]) => [entry.name + '/' + name, value])] : [[entry.name, bytes(p)]];
  });
}

test('plan is read-only; copy preserves originals, binary bytes, hierarchy and empty directories', t => {
  const f = fixture(t); mkdirSync(join(f.source, '空目录')); writeFileSync(join(f.source, '图.bin'), Buffer.from([0, 255, 128, 13, 10, 0]));
  const before = tree(f.temp), plan = f.plan(); assert.deepEqual(tree(f.temp), before);
  const original = tree(f.source), result = f.apply(plan);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(tree(f.source), original); assert.deepEqual(tree(f.target()), original);
  const record = JSON.parse(readFileSync(join(f.root, result.record)));
  assert.equal(record.files.length, 2); assert.ok(record.files.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.equal(result.record.startsWith('项目/星河方案/资料/导入记录/'), true);
});

test('same source is a true no-op including receipt bytes and modification time', t => {
  const f = fixture(t); const first = f.apply(f.plan()); const path = join(f.root, first.record), before = tree(f.folder), mtime = lstatSync(path).mtimeMs;
  const second = f.apply(f.plan()); assert.equal(second.ok, true); assert.equal(second.changed, false);
  assert.deepEqual(tree(f.folder), before); assert.equal(lstatSync(path).mtimeMs, mtime);
});

test('changed source conflicts without creating another version; independent new material is copied', t => {
  const f = fixture(t); f.apply(f.plan()); const path = f.target('需求/说明.md'), old = bytes(path);
  writeFileSync(join(f.source, '需求', '说明.md'), '新版预算9万元，尚待确认。'); writeFileSync(join(f.source, '新增.md'), '补充材料');
  const result = f.apply(f.plan()); assert.equal(result.ok, false);
  assert.ok(result.results.some(row => row.status === 'conflict')); assert.equal(bytes(path), old);
  assert.equal(readFileSync(f.target('新增.md'), 'utf8'), '补充材料');
  assert.equal(readdirSync(f.target('需求')).length, 1);
});

test('manual local edits are preserved even when the source is unchanged', t => {
  const f = fixture(t); f.apply(f.plan()); const path = f.target('需求/说明.md'); writeFileSync(path, '用户在本地修改');
  const result = f.apply(f.plan()); assert.equal(result.ok, false); assert.equal(readFileSync(path, 'utf8'), '用户在本地修改');
});

test('repeating an unchanged conflict preserves receipt bytes and modification time', t => {
  const f = fixture(t); f.apply(f.plan()); writeFileSync(join(f.source, '需求', '说明.md'), '新版');
  const first = f.apply(f.plan()), path = join(f.root, first.record), before = bytes(path), mtime = lstatSync(path).mtimeMs;
  const second = f.apply(f.plan()); assert.equal(second.ok, false); assert.equal(second.changed, false);
  assert.equal(bytes(path), before); assert.equal(lstatSync(path).mtimeMs, mtime);
});

test('deleted or moved imported targets are not silently restored', t => {
  const f = fixture(t); f.apply(f.plan()); const path = f.target('需求/说明.md'); renameSync(path, path + '.保留');
  const result = f.apply(f.plan()); assert.equal(result.ok, false); assert.equal(lstatSync(path + '.保留').isFile(), true);
  assert.throws(() => lstatSync(path), { code: 'ENOENT' });
});

test('deleted imported directories are not rebuilt by a new incoming file', t => {
  const f = fixture(t); f.apply(f.plan()); rmSync(f.target('需求'), { recursive: true });
  writeFileSync(join(f.source, '需求', '新资料.md'), '新资料');
  const result = f.apply(f.plan()); assert.equal(result.ok, false); assert.throws(() => lstatSync(f.target('需求')), { code: 'ENOENT' });
});

test('removed source files retain the project copy and report the missing source', t => {
  const f = fixture(t), first = f.apply(f.plan()); assert.equal(first.ok, true, JSON.stringify(first)); rmSync(join(f.source, '需求', '说明.md'));
  const plan = f.plan(), result = f.apply(plan); assert.equal(result.ok, false); assert.equal(lstatSync(f.target('需求/说明.md')).isFile(), true);
  assert.ok(result.results.some(row => row.code === 'INTAKE_SOURCE_MISSING'), JSON.stringify({plan,result}));
});

test('Windows receipt replacement recovers a transient native sharing lock', {skip:platform.name!=='win32'&&'Native Windows file-sharing semantics'}, async t => {
  const f=fixture(t),first=f.apply(f.plan());assert.equal(first.ok,true,JSON.stringify(first));
  const receipt=join(f.root,first.record),ready=join(f.temp,'lock-ready'),attempt=join(f.temp,'publish-attempt');
  writeFileSync(join(f.source,'补充.md'),'补充材料');
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const script=`$ErrorActionPreference='Stop';$h=[IO.File]::Open(${quote(receipt)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[IO.File]::WriteAllText(${quote(ready)},'ready');$end=[DateTime]::UtcNow.AddSeconds(10);while(-not(Test-Path -LiteralPath ${quote(attempt)})){if([DateTime]::UtcNow -gt $end){throw 'Publication did not start'};Start-Sleep -Milliseconds 10};Start-Sleep -Milliseconds 250}finally{$h.Dispose()}`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  try{
    const deadline=Date.now()+10000;while(!existsSync(ready)&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(existsSync(ready),stderr||'Native sharing lock was not acquired');
    const result=f.apply(f.plan(),{beforeReceipt(){writeFileSync(attempt,'publish');}});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(await exited,0,stderr);
    assert.equal(readFileSync(f.target('补充.md'),'utf8'),'补充材料');assert.equal(f.apply(f.plan()).changed,false);
  }finally{if(child.exitCode===null)child.kill();await exited.catch(()=>{});}
});

test('a single external file is copied and repeat adoption skips it', t => {
  const f = fixture(t, { file: true }); assert.equal(f.apply(f.plan()).ok, true);
  assert.equal(bytes(f.target()), bytes(f.source)); assert.equal(f.apply(f.plan()).changed, false);
});

test('existing project material remains in place with no import record', t => {
  const f = fixture(t); const source = join(f.folder, '已有.md'); writeFileSync(source, '项目材料');
  const before = tree(f.folder), plan = planMaterials({ ...f.args, source });
  assert.equal(plan.mode, 'in-place'); assert.equal(f.apply(plan).changed, false); assert.deepEqual(tree(f.folder), before);
});

test('engineering roots are signaled for association and are never copied', t => {
  const f = fixture(t); mkdirSync(join(f.source, '.git'));
  const before = tree(f.folder), plan = f.plan(); assert.equal(plan.mode, 'engineering');
  assert.equal(f.apply(plan).ok, false); assert.deepEqual(tree(f.folder), before);
});

test('nested engineering directories are left intact while ordinary documents continue', t => {
  const f = fixture(t); mkdirSync(join(f.source, '工程', '.git'), { recursive: true }); writeFileSync(join(f.source, '工程', 'app.js'), 'code');
  const result = f.apply(f.plan()); assert.equal(result.ok, false);
  assert.ok(result.results.some(row => row.code === 'INTAKE_ENGINEERING_SOURCE'));
  assert.equal(lstatSync(f.target('需求/说明.md')).isFile(), true); assert.throws(() => lstatSync(f.target('工程')), { code: 'ENOENT' });
});

test('source links are not followed; independent files continue', t => {
  const f = fixture(t); const outside = join(f.temp, '外部.md'); writeFileSync(outside, 'outside'); symlinkSync(outside, join(f.source, '链接.md'));
  const result = f.apply(f.plan()); assert.equal(result.ok, false); assert.equal(readFileSync(outside, 'utf8'), 'outside');
  assert.throws(() => lstatSync(f.target('链接.md')), { code: 'ENOENT' }); assert.equal(lstatSync(f.target('需求/说明.md')).isFile(), true);
});

test('source parent links and overlapping paths are rejected before writes', t => {
  const f = fixture(t); symlinkSync(f.source, join(f.temp, '别名'));
  assert.throws(() => planMaterials({ ...f.args, source: join(f.temp, '别名', '需求') }), { code: 'INTAKE_UNSAFE_PATH' });
  assert.throws(() => planMaterials({ ...f.args, source: f.root }), { code: 'INTAKE_OVERLAP' });
  assert.throws(() => planMaterials({ ...f.args, destination: '../其他' }), { code: 'INTAKE_DESTINATION_INVALID' });
  assert.throws(() => planMaterials({ ...f.args, destination: '资料/导入记录/覆盖.json' }), { code: 'INTAKE_DESTINATION_INVALID' });
});

test('destination links cannot escape the project', t => {
  const f = fixture(t); const outside = join(f.temp, 'outside'); mkdirSync(outside); symlinkSync(outside, join(f.folder, '资料'));
  assert.throws(() => f.plan(), { code: 'INTAKE_UNSAFE_PATH' }); assert.deepEqual(readdirSync(outside), []);
});

test('damaged and unknown-schema receipts are preserved and block dependent application', t => {
  const f = fixture(t); const first = f.apply(f.plan()), path = join(f.root, first.record);
  for (const value of ['{damaged', JSON.stringify({ schemaVersion: 99 })]) {
    writeFileSync(path, value); assert.throws(() => f.plan(), { code: 'INTAKE_RECORD_INVALID' }); assert.equal(readFileSync(path, 'utf8'), value);
  }
});

test('stale receipt, replaced project and cross-project plan cannot be applied', t => {
  const f = fixture(t), plan = f.plan();
  assert.throws(() => applyMaterials({ root: f.root, project: '其他项目', plan }), { code: 'INTAKE_PLAN_INVALID' });
  f.apply(plan); assert.throws(() => f.apply(plan), { code: 'INTAKE_PLAN_STALE' });
  const next = f.plan(); renameSync(f.folder, f.folder + '-old'); mkdirSync(f.folder); writeFileSync(join(f.folder, 'project.md'), '# 新目录');
  assert.throws(() => f.apply(next), { code: 'INTAKE_PLAN_STALE' });
});

test('structurally corrupted receipt entries stop all dependent writes and preserve the record', t => {
  const f = fixture(t), first = f.apply(f.plan()), path = join(f.root, first.record), original = JSON.parse(readFileSync(path));
  writeFileSync(join(f.source, 'new.md'), 'new');
  for (const mutate of [v => v.issues.push(null), v => v.issues.push({ relativePath: '../outside', target: '../outside', code: 'BAD' }),
    v => v.directories.push(v.directories[0]), v => v.files[0].sha256 = 'invalid']) {
    const value = structuredClone(original); mutate(value); const bytes = JSON.stringify(value); writeFileSync(path, bytes);
    assert.throws(() => f.plan(), { code: 'INTAKE_RECORD_INVALID' }); assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.throws(() => lstatSync(f.target('new.md')), { code: 'ENOENT' });
  }
});

test('tampered traversal, duplicate and destination mappings are rejected before copying', t => {
  const f = fixture(t), original = f.plan(); const before = tree(f.folder);
  for (const change of [p => p.entries.push(p.entries[0]), p => p.entries[0].target = '../outside', p => p.entries[0].relativePath = '../outside']) {
    const plan = structuredClone(original); change(plan); assert.throws(() => f.apply(plan), { code: 'INTAKE_PLAN_INVALID' });
    assert.deepEqual(tree(f.folder), before);
  }
});

test('a changed source after planning conflicts while unrelated new copies still apply', t => {
  const f = fixture(t); writeFileSync(join(f.source, 'good.md'), 'good'); const plan = f.plan();
  writeFileSync(join(f.source, '需求', '说明.md'), 'unexpected change'); const result = f.apply(plan);
  assert.equal(result.ok, false); assert.equal(readFileSync(f.target('good.md'), 'utf8'), 'good');
  assert.throws(() => lstatSync(f.target('需求/说明.md')), { code: 'ENOENT' });
});

test('a destination appearing during publication is never overwritten', t => {
  const f = fixture(t); const result = f.apply(f.plan(), { beforePublish(row) { writeFileSync(join(f.folder, row.target), 'concurrent user edit'); } });
  assert.equal(result.ok, false); assert.equal(readFileSync(f.target('需求/说明.md'), 'utf8'), 'concurrent user edit');
  assert.ok(!tree(f.folder).some(([name]) => name.includes('.tmp')));
});

test('source changes at publication are detected without copying either version', t => {
  const f = fixture(t); const result = f.apply(f.plan(), { beforePublish() { writeFileSync(join(f.source, '需求', '说明.md'), 'changed again'); } });
  assert.equal(result.ok, false); assert.throws(() => lstatSync(f.target('需求/说明.md')), { code: 'ENOENT' });
});

test('concurrent receipt edits are preserved rather than replaced', t => {
  const f = fixture(t); const first = f.apply(f.plan()), path = join(f.root, first.record);
  writeFileSync(join(f.source, 'new.md'), 'new material');
  let once = true;
  const result = f.apply(f.plan(), { beforeReceipt() { if (once) { once = false; writeFileSync(path, '{concurrent broken record'); } } });
  assert.equal(result.ok, false); assert.equal(readFileSync(path, 'utf8'), '{concurrent broken record');
});

test('a parent replaced by a link before publication cannot receive copied bytes', t => {
  const f = fixture(t); const outside = join(f.temp, 'outside'); mkdirSync(outside);
  const result = f.apply(f.plan(), { beforePublish(row) { const parent = join(f.folder, row.target, '..'); renameSync(parent, parent + '-old'); symlinkSync(outside, parent); } });
  assert.equal(result.ok, false); assert.deepEqual(readdirSync(outside), []);
});

test('interruption after publication is reconciled without duplicate copies', t => {
  const f = fixture(t); let once = true;
  const result = f.apply(f.plan(), { afterPublish() { if (once) { once = false; throw Object.assign(new Error('interrupted'), { code: 'INTAKE_INTERRUPTED' }); } } });
  assert.equal(result.ok, false); assert.equal(bytes(f.target('需求/说明.md')), bytes(join(f.source, '需求', '说明.md')));
  const again = f.apply(f.plan()); assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(readdirSync(f.target('需求')).length, 1);
});

test('a killed writer preserves its lock and published bytes until its dead owner is inspected', t => {
  const f = fixture(t);
  const moduleUrl = new URL('../src/services/project-intake.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { planMaterials, applyMaterials } from ${JSON.stringify(moduleUrl)};
    const args = JSON.parse(process.argv[1]);
    applyMaterials({ ...args, plan: planMaterials(args) }, { afterPublish() { process.kill(process.pid, 'SIGKILL'); } });
  `, JSON.stringify(f.args)], { encoding: 'utf8', timeout: 10000 });
  if(platform.name==='win32')assert.equal(child.status,1,child.stderr);else assert.equal(child.signal, 'SIGKILL', child.stderr);
  const lock = join(f.folder, '资料', '导入记录', '.intake.lock');
  const owner = JSON.parse(readFileSync(lock, 'utf8'));
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0);
  assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' });
  assert.equal(bytes(f.target('需求/说明.md')), bytes(join(f.source, '需求', '说明.md')));
  const before = tree(f.folder);
  assert.throws(() => f.apply(f.plan()), { code: 'INTAKE_LOCKED' });
  assert.deepEqual(tree(f.folder), before);
  // The operator has established this exact writer is gone; unknown/live locks
  // are never automatically stolen by the intake tool.
  rmSync(lock);
  const recovered = f.apply(f.plan());
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(readdirSync(f.target('需求')).length, 1);
});

test('the support CLI accepts its own saved plan envelope and preserves partial plan results', t => {
  const f = fixture(t);
  const runtime = join(f.root, '.agents/core/runtime');
  mkdirSync(join(runtime, 'src/services'), { recursive: true }); mkdirSync(join(runtime, 'src/shared'), { recursive: true });
  cpSync(fileURLToPath(new URL('../src/services/project-intake.js', import.meta.url)), join(runtime, 'src/services/project-intake.js'));
  for(const entry of ['shared','platform'])cpSync(fileURLToPath(new URL('../src/'+entry,import.meta.url)),join(runtime,'src',entry),{recursive:true});
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}');
  const invoke = args => spawnSync(process.execPath, [tool, ...args, '--json'], { encoding: 'utf8' });
  const planned = invoke(['plan', '--root', f.root, '--project', f.project, '--source', f.source]);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const saved = join(f.temp, 'plan.json'); writeFileSync(saved, planned.stdout);
  const applied = invoke(['apply', '--root', f.root, '--project', f.project, '--plan', saved]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr); assert.equal(JSON.parse(applied.stdout).data.ok, true);
  assert.equal(invoke(['plan', '--root', f.root, '--root', f.root]).status, 2);
});
