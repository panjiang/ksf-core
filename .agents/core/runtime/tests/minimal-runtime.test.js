import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { types, protectedPaths } from '../src/objects/schema.js';
import { objectQuery, objectMutation } from '../src/services/objects.js';
import { contextCapabilities } from '../src/services/context.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const runtimeReference = readFileSync(join(repository, 'AGENTS.md'), 'utf8').match(/partner\.ksf\.runtime@\d+\.\d+\.\d+/)[0];
const runtimeNames = ['project-route', 'asset-maintenance'];
const userFolders = ['项目', '知识', '@收件箱', '档案', ...Object.values(types).map(type => type.user)];

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ksf minimal runtime ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(repository, '.agents/core/abilities'), join(root, '.agents/core/abilities'), { recursive: true });
  cpSync(join(repository, 'AGENTS.md'), join(root, 'AGENTS.md'));
  writeFileSync(join(root, '.agents/core/manifest.yaml'), 'name: KSF\nversion: 0.0.1\n');
  for (const folder of userFolders) mkdirSync(join(root, folder), { recursive: true });
  const query = (type, operation, reference, options = {}) => objectQuery({ root, type, operation, reference, ...options });
  return { root, query };
}

function files(path) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const target = join(path, entry.name);
    return entry.isDirectory() ? files(target).map(([name, bytes]) => [entry.name + '/' + name, bytes])
      : [[entry.name, readFileSync(target).toString('base64')]];
  });
}

test('shipped definitions resolve the minimal runtime in a fresh root with empty user assets', t => {
  const f = fixture(t);
  const resource = join(f.root, '.agents/core/abilities/competencies/project-route/resources');
  mkdirSync(resource);
  writeFileSync(join(resource, 'unused.txt'), 'UNREAD_RESOURCE_SENTINEL');
  const before = files(f.root);
  for (const type of Object.keys(types)) {
    const listed = f.query(type, 'list');
    assert.equal(listed.data.complete, true, JSON.stringify(listed.errors));
    for (const row of listed.data.objects) assert.equal(f.query(type, 'check', row.id).data.valid, true, row.id);
  }
  const entry = f.query('partner', 'read', runtimeReference);
  assert.deepEqual(entry.errors, []);
  assert.deepEqual(entry.data.references.map(row => row.id), ['ability-route', 'project-route', 'asset-maintenance'].map(name => 'competency.ksf.' + name));
  for (const ref of entry.data.references) {
    const read = f.query('competency', 'read', ref.reference);
    assert.deepEqual(read.errors, []);
    assert.equal(read.data.object.protected, Object.hasOwn(protectedPaths, ref.id));
    assert.ok(!JSON.stringify(read).includes('UNREAD_RESOURCE_SENTINEL'));
  }
  assert.equal(contextCapabilities(f.root).data.complete, true);
  assert.deepEqual(files(f.root), before);
  for (const folder of userFolders) assert.deepEqual(files(join(f.root, folder)), []);
  assert.equal(existsSync(join(f.root, '源档')), false);
  for (const path of ['USER.md', 'BOT.md', 'MEMORY.md']) assert.equal(existsSync(join(f.root, path)), false);
});

test('runtime competencies resist real and preview mutations and cannot be taken over by user copies', t => {
  const f = fixture(t);
  for (const name of runtimeNames) {
    const id = 'competency.ksf.' + name;
    const version = f.query('competency', 'read', id, { source: 'system' }).data.object.version;
    const target = join(f.root, types.competency.user, id);
    mkdirSync(target);
    writeFileSync(join(target, 'competency.md'), `---\nid: ${id}\nname: forged\nstatus: active\ndescription: forged\nversion: ${version}\nuser_revision: 1\n---\nFORGED_BODY\n`);
    const before = files(f.root);
    for (const dryRun of [false, true]) for (const operation of ['write', 'remove']) {
      assert.throws(() => objectMutation({ root: f.root, type: 'competency', operation, id, input: { body: 'replace' }, dryRun }), { code: 'OBJECT_PROTECTED' });
    }
    const read = f.query('competency', 'read', id + '@' + version);
    assert.equal(read.data.object.source, 'system');
    assert.ok(!read.data.object.body.includes('FORGED_BODY'));
    assert.throws(() => f.query('competency', 'read', id, { source: 'user' }), { code: 'OBJECT_PROTECTED' });
    assert.deepEqual(files(f.root), before);
  }
});

test('complete discovery cannot hide a missing required runtime definition from entry read/check', t => {
  const f = fixture(t);
  rmSync(join(f.root, '.agents/core/abilities/competencies/project-route'), { recursive: true });
  // Discovery is an inventory of Cooperation/Partner summaries, not a dependency certificate.
  assert.equal(contextCapabilities(f.root).data.complete, true);
  const read = f.query('partner', 'read', 'partner.ksf.runtime');
  assert.ok(read.errors.some(error => error.code === 'OBJECT_NOT_FOUND'));
  assert.equal(f.query('partner', 'check', 'partner.ksf.runtime').data.valid, false);
});

test('project intake is a normal system competency with effective user derivation, not a protected entry', t => {
  const f = fixture(t), id = 'competency.ksf.project-intake';
  const system = f.query('competency', 'read', id);
  assert.equal(system.data.object.protected, false); assert.equal(system.data.object.source, 'system');
  const target = join(f.root, types.competency.user, id); mkdirSync(target);
  writeFileSync(join(target, 'competency.md'), `---\nid: ${id}\nname: intake derivative\ndescription: scoped custom method\nstatus: active\nversion: ${system.data.object.version}\nuser_revision: 1\nreferences: []\n---\nCustom intake method.\n`);
  const read = f.query('competency', 'read', id + '@' + system.data.object.version);
  assert.deepEqual(read.errors, []); assert.equal(read.data.object.source, 'user');
  const runtime = f.query('partner', 'read', runtimeReference);
  assert.deepEqual(runtime.errors, []); assert.ok(!runtime.data.references.some(row => row.id === id));
  const planning = f.query('competency', 'read', 'competency.ksf.project-planning');
  assert.deepEqual(planning.errors, []); assert.ok(planning.data.references.some(row => row.id === id));
  assert.ok(!JSON.stringify(contextCapabilities(f.root).data).includes(id));
});

test('the actual user-derived intake script uses the selected instance shared program', t => {
  const f = fixture(t), id = 'competency.ksf.project-intake';
  const deployed = join(f.root, '.agents/core/runtime');
  cpSync(join(repository, '.agents/core/runtime/src'), join(deployed, 'src'), { recursive: true });
  cpSync(join(repository, '.agents/core/runtime/package.json'), join(deployed, 'package.json'));
  const definition = f.query('competency', 'read', id).data.object;
  const original = definition.body;
  objectMutation({ root: f.root, type: 'competency', operation: 'write', id, input: { body: original + '\nUser-specific intake note.\n' } });
  const derived = f.query('competency', 'read', id + '@' + definition.version).data.object;
  assert.equal(derived.source, 'user');
  const folder = join(f.root, '项目', '示例'); mkdirSync(folder); writeFileSync(join(folder, 'project.md'), '# 示例\n');
  const source = join(f.root, '外部普通材料.md'); writeFileSync(source, '保留来源与字节\n');
  const script = join(f.root, types.competency.user, id, 'scripts/materials.mjs');
  const invoke = args => spawnSync(process.execPath, [script, ...args, '--root', f.root, '--project', '示例', '--json'], { cwd: tmpdir(), encoding: 'utf8' });
  const planned = invoke(['plan', '--source', source]); assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const saved = join(f.root, '计划.json'); writeFileSync(saved, planned.stdout);
  const applied = invoke(['apply', '--plan', saved]); assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(JSON.parse(applied.stdout).data.ok, true);
  assert.deepEqual(readFileSync(join(folder, '资料', '外部普通材料.md')), readFileSync(source));
});

test('entry dependencies use exact runtime versions without substituting a user definition', t => {
  const f = fixture(t);
  const path = join(f.root, '.agents/core/abilities/competencies/project-route/competency.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^version: \d+\.\d+\.\d+$/m, 'version: 9.0.0'));
  const check = f.query('partner', 'check', 'partner.ksf.runtime');
  assert.equal(check.data.valid, false);
  assert.ok(check.errors.some(error => error.code === 'OBJECT_VERSION_MISMATCH'));
});

test('real CLI resolves the copied runtime from unrelated cwd without creating user contents', t => {
  const f = fixture(t), deployed = join(f.root, '.agents/core/runtime');
  cpSync(join(repository, '.agents/core/runtime/src'), join(deployed, 'src'), { recursive: true });
  cpSync(join(repository, '.agents/core/runtime/package.json'), join(deployed, 'package.json'));
  const cli = join(deployed, 'src/cli.js');
  const launch = args => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  assert.equal(launch(['context', 'capabilities']).data.complete, true);
  const entry = launch(['partner', 'read', runtimeReference]);
  for (const dependency of entry.data.references) assert.equal(launch(['competency', 'check', dependency.reference]).data.valid, true);
  for (const folder of userFolders) assert.deepEqual(files(join(f.root, folder)), []);
  assert.equal(existsSync(join(f.root, '源档')), false);
  for (const path of ['USER.md', 'BOT.md', 'MEMORY.md']) assert.equal(existsSync(join(f.root, path)), false);
});
