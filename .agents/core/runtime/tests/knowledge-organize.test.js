import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkKnowledge } from '../src/services/knowledge-organize.js';
import { objectMutation, objectQuery } from '../src/services/objects.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ksf knowledge 中文 ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, text = '') => { const p = join(root, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
  mkdirSync(join(root, '知识'));
  return { root, put, check: (target = '知识', io) => checkKnowledge({ root, target }, io) };
}
function tree(folder) {
  return readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e =>
    e.isDirectory() ? tree(join(folder, e.name)).map(([name, value]) => [e.name + '/' + name, value]) : [[e.name, readFileSync(join(folder, e.name)).toString('base64')]]);
}

test('read-only audit accepts mixed models and explicitly named entries without imposing cognition folders', t => {
  const f = fixture(t);
  f.put('知识/knowledge.md', '[观察](认知-观察/cognition.md)\n[图谱](图谱-材料/start.md)');
  f.put('知识/认知-观察/cognition.md', '# 观察\n当前认识未形成。');
  f.put('知识/图谱-材料/start.md', '# 实体关系\n[实体](entities.md)');
  f.put('知识/图谱-材料/entities.md', '# 实体');
  const before = tree(f.root), first = f.check(), second = f.check();
  assert.equal(first.valid, true); assert.equal(first.complete, true); assert.equal(first.checkedLinks, 3);
  assert.deepEqual(first, second); assert.deepEqual(tree(f.root), before);
});

test('Markdown, images, balanced parentheses, encoded paths, reference and wiki links resolve; code is ignored', t => {
  const f = fixture(t);
  f.put('知识/说明 (中文).md', '# 内容'); f.put('知识/图.png', Buffer.from([0, 255, 1]));
  f.put('知识/knowledge.md', '[中文](<说明 (中文).md#内容>)\n[编码](说明%20(中文).md)\n![图](图.png)\n[引用][ref]\n[ref]: <说明 (中文).md>\n[[知识/说明 (中文)#内容|别名]]\n`[代码](不存在.md)`\n```sh\n[命令](也不存在.md)\n```');
  const result = f.check(); assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.checkedLinks, 5); assert.equal(result.anchorsUnchecked, 2);
});

test('missing link is an observable failure; external, cross-root and dynamic targets remain explicitly unchecked', t => {
  const f = fixture(t);
  f.put('知识/knowledge.md', '[缺失](missing.md)\n[外部](https://example.invalid/)\n[根外](/outside-ksf/notes.md)\n[模板]({{entry}})\n[锚点](#未核对)');
  const result = f.check(); assert.equal(result.valid, false); assert.equal(result.complete, true);
  assert.equal(result.errors[0].code, 'KNOWLEDGE_LINK_MISSING'); assert.equal(result.externalLinks, 1);
  assert.deepEqual(result.unchecked.map(r => r.reason), ['outside-root', 'dynamic-or-template']);
  assert.equal(result.anchorsUnchecked, 1);
});

test('native file URLs and line citations count as files while unknown schemes and outside-root URLs remain unchecked', t => {
  const f = fixture(t), target = f.put('知识/目标 文件.md', '# 原文');
  const url = pathToFileURL(target).href;
  f.put('知识/knowledge.md', `[文件](${url})\n[定位](${url}:12:3)\n[未知](custom:entry)\n[根外](${pathToFileURL(join(f.root, '..', 'outside.md')).href})`);
  const result = f.check();
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.complete, true);
  assert.equal(result.checkedLinks, 2);
  assert.deepEqual(result.unchecked.map(r => r.reason), ['unsupported-scheme', 'outside-root']);
});

test('missing directory and read error are incomplete discovery, never an empty successful inventory', t => {
  const f = fixture(t); const missing = f.check('知识/缺失');
  assert.equal(missing.complete, false); assert.equal(missing.valid, false);
  assert.equal(missing.errors[0].code, 'KNOWLEDGE_PATH_MISSING');
  f.put('知识/knowledge.md', '# 入口');
  const denied = f.check('知识', { readText: () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); } });
  assert.equal(denied.complete, false); assert.equal(denied.errors[0].code, 'EACCES');
});

test('symlink directories and linked targets are not followed; root traversal is rejected', t => {
  const f = fixture(t); f.put('其他/秘密.md', 'do not read');
  symlinkSync(join(f.root, '其他'), join(f.root, '知识/链接'), 'dir');
  f.put('知识/knowledge.md', '[跳转](链接/秘密.md)');
  const result = f.check(); assert.equal(result.complete, false);
  assert.ok(result.errors.every(e => e.code === 'KNOWLEDGE_SYMLINK'));
  assert.throws(() => f.check('../outside'), { code: 'KNOWLEDGE_TARGET_OUTSIDE_ROOT' });
});

test('historical working, cache and hidden resources do not become current navigation failures', t => {
  const f = fixture(t); f.put('知识/knowledge.md', '# 入口');
  for (const folder of ['_working', '_cache', '.upstream', '.git', 'node_modules']) f.put('知识/' + folder + '/history.md', '[旧提示](missing.md)');
  const result = f.check(); assert.equal(result.valid, true); assert.deepEqual(result.files, ['知识/knowledge.md']);
});

test('normal derived competency uses explicitly selected instance shared checker from unrelated cwd', t => {
  const f = fixture(t);
  cpSync(join(repository, '.agents/core/abilities'), join(f.root, '.agents/core/abilities'), { recursive: true });
  for (const name of ['协同', '搭档', '基本功', '数据包']) mkdirSync(join(f.root, '能力', name), { recursive: true });
  cpSync(join(repository, 'AGENTS.md'), join(f.root, 'AGENTS.md'));
  f.put('.agents/core/manifest.yaml', 'name: KSF\nversion: 0.0.1\n');
  f.put('.agents/core/runtime/package.json', '{"type":"module"}\n');
  f.put('.agents/core/runtime/src/shared/paths.js',readFileSync(join(repository,'.agents/core/runtime/src/shared/paths.js')));
  const program = '.agents/core/runtime/src/services/knowledge-organize.js'; f.put(program, readFileSync(join(repository, program)));
  f.put('知识/knowledge.md', '# 混合框架入口');
  const id = 'competency.ksf.knowledge-organize';
  const original = objectQuery({ root: f.root, type: 'competency', operation: 'read', reference: id }).data.object;
  assert.equal(original.protected, false);
  objectMutation({ root: f.root, type: 'competency', operation: 'write', id, input: { body: original.body + '\nScoped user note.\n' } });
  const derived = objectQuery({ root: f.root, type: 'competency', operation: 'read', reference: id + '@' + original.version });
  assert.equal(derived.data.object.source, 'user'); assert.deepEqual(derived.errors, []);
  const before = tree(join(f.root, '知识'));
  const script = join(f.root, derived.data.object.directory, 'scripts/check.mjs');
  const result = spawnSync(process.execPath, [script, '--root', f.root, '--json'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(JSON.parse(result.stdout).data.valid, true);
  assert.deepEqual(tree(join(f.root, '知识')), before);
  const bad = spawnSync(process.execPath, [script, '--root', f.root, '--write'], { encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.equal(JSON.parse(bad.stdout).errors[0].code, 'KNOWLEDGE_ARGUMENT_INVALID');
});
