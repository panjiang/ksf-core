import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { distributionFixture, instanceEntries } from './helpers/distribution-fixture.js';
import { knowledgeFrameworkFiles } from '../src/distribution/release.js';
import { inspectReleaseDirectory } from '../src/distribution/publish.js';
import { systemUpdate, systemRollback } from '../src/distribution/system.js';
import { checkKnowledge } from '../src/services/knowledge-organize.js';

test('a shipped workspace has reachable optional rules and empty cognition paths, without real knowledge or user records', async t => {
  const f = await distributionFixture(t);
  const entries = instanceEntries(f.first.instance);
  for (const path of knowledgeFrameworkFiles) {
    assert.deepEqual(entries.get(path).bytes, entries.get(`.agents/core/distribution/template/${path}`).bytes, path);
    assert.equal(entries.get(path).mode, 0o644);
  }
  assert.deepEqual(readdirSync(join(f.workspace, '知识')).sort(), ['.gitkeep', 'knowledge.md', 'rules']);
  assert.deepEqual(readdirSync(join(f.workspace, '.agents/user-data')).sort(), ['.gitkeep', 'incubation.json']);
  const incubation=JSON.parse(readFileSync(join(f.workspace, '.agents/user-data/incubation.json'),'utf8'));
  assert.deepEqual(incubation.values,{status:'pending'});
  assert.equal(incubation.namespace,'incubation');
  assert.equal(existsSync(join(f.workspace, '能力/基本功/competency.yinbaiyuan.knowledge-extraction')), false);
  const result = checkKnowledge({ root: f.workspace });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.complete, true);
  assert.deepEqual(result.unchecked, []);
});

test('cognition skeleton instantiates at its final location and is usable by the shipped read-only checker', async t => {
  const f = await distributionFixture(t);
  const unit = join(f.workspace, '知识/认知-观察方法');
  cpSync(join(f.workspace, '知识/rules/templates/cognition'), unit, { recursive: true });
  for (const path of ['cognition.md', '3认知/认知说明.md']) {
    const target = join(unit, path);
    writeFileSync(target, readFileSync(target, 'utf8').replaceAll('{{主题名}}', '观察方法')
      .replace('{{简短定义；如只有来源材料，说明其性质，不写成用户已采纳的认识。}}', '本主题整理观察方法，当前没有已采纳的个人认识。')
      .replace('../../../认知.md', '../../rules/认知.md'));
  }
  const index = join(f.workspace, '知识/knowledge.md');
  writeFileSync(index, readFileSync(index, 'utf8') + '\n[认知-观察方法](认知-观察方法/cognition.md)：观察方法的理论、案例和待形成认识。\n');
  for (const path of ['1理论与模型/科学类比', '1理论与模型/提炼模型', '2事实与案例/定性定量', '2事实与案例/假设驱动']) {
    assert.deepEqual(readdirSync(join(unit, path)), ['.gitkeep']);
  }
  assert.equal((readFileSync(join(unit, '3认知/认知说明.md'), 'utf8').match(/待形成：/g) ?? []).length, 5);
  const before = readFileSync(index);
  const result = spawnSync(process.execPath, [join(f.workspace, '.agents/core/abilities/competencies/knowledge-organize/scripts/check.mjs'), '--root', f.workspace, '--json'], {
    cwd: f.directory, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).data.valid, true);
  assert.deepEqual(readFileSync(index), before);
});

test('Core updates and rollback preserve existing knowledge rules, custom framework and intentionally missing templates', async t => {
  const f = await distributionFixture(t);
  // Represent an existing instance with a different model and only its own rules.
  rmSync(join(f.workspace, '知识/rules'), { recursive: true });
  cpSync(join(f.root, '.agents/core/distribution/template/知识/rules'), join(f.workspace, '知识/rules'), { recursive: true });
  rmSync(join(f.workspace, '知识/rules/templates'), { recursive: true });
  rmSync(join(f.workspace, '知识/rules/认知.md'));
  const custom = '# 自定规则\n材料图谱使用自己的 start.md，不使用认知模板。\n';
  writeFileSync(join(f.workspace, '知识/rules/README.md'), custom);
  const rootIndex = '# 材料图谱\n[自定规则](rules/README.md)\n';
  writeFileSync(join(f.workspace, '知识/knowledge.md'), rootIndex);
  const source = '.agents/core/distribution/template/知识/rules/README.md';
  const nextBytes = readFileSync(join(f.root, source), 'utf8') + '\n示例更新：仅影响 Core 模板源。\n';
  const next = await f.next('0.1.1', { [source]: nextBytes });
  await systemUpdate({ root: f.workspace, from: next.coreArchive });
  assert.equal(readFileSync(join(f.workspace, source), 'utf8'), nextBytes);
  const preserved = () => {
    assert.equal(readFileSync(join(f.workspace, '知识/rules/README.md'), 'utf8'), custom);
    assert.equal(readFileSync(join(f.workspace, '知识/knowledge.md'), 'utf8'), rootIndex);
    assert.equal(existsSync(join(f.workspace, '知识/rules/认知.md')), false);
    assert.equal(existsSync(join(f.workspace, '知识/rules/templates')), false);
    assert.deepEqual(readdirSync(join(f.workspace, '知识')).sort(), ['.gitkeep', 'knowledge.md', 'rules']);
  };
  preserved();
  await systemRollback({ root: f.workspace });
  preserved();
});
