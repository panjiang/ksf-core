import {fixtureTarget} from './helpers/distribution-fixture.js';
import {gitBinary} from './helpers/platform.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { distributionFixture, instanceEntries } from './helpers/distribution-fixture.js';
import { readArchive } from '../src/distribution/archive.js';
import { buildRelease } from '../src/distribution/release.js';
import { abilitySource } from '../src/services/sources.js';
import { systemUpdate, systemRollback } from '../src/distribution/system.js';

function source(f) {
  let directory = join(f.directory, 'private-methods'); mkdirSync(directory); directory = realpathSync(directory);
  assert.equal(spawnSync(gitBinary, ['init', '--template=', '--initial-branch=main', directory]).status, 0);
  abilitySource({ root: f.workspace, operation: 'init', target: directory, id: 'private-methods', name: 'Private methods' });
  const method = join(directory, '能力/基本功/competency.author.private'); mkdirSync(method);
  const canary = 'PRIVATE_ABILITY_CONTENT_DO_NOT_PACKAGE';
  const routeVersion = readFileSync(join(f.root, '.agents/core/abilities/competencies/ability-route/competency.md'), 'utf8').match(/^version:\s*(\S+)/m)[1];
  writeFileSync(join(method, 'competency.md'), `---\nid: competency.author.private\nname: private\ndescription: private method\nstatus: active\nversion: 0.1.0\nreferences:\n  - competency.ksf.ability-route@${routeVersion}\n---\n${canary}\n`);
  abilitySource({ root: f.workspace, operation: 'link', target: directory });
  return { directory, canary };
}

test('real launcher works offline across cwd and keeps direct source content outside Core archives', async t => {
  const f = await distributionFixture(t), s = source(f);
  const read = f.launch(['competency', 'read', 'competency.author.private', '--source', 'private-methods', '--json']);
  assert.equal(read.status, 0, read.stderr + read.stdout);
  assert.equal(JSON.parse(read.stdout).data.object.path, join(s.directory, '能力/基本功/competency.author.private/competency.md'));
  assert.match(JSON.parse(read.stdout).data.object.body, /PRIVATE_ABILITY_CONTENT/);
  assert.equal(existsSync(join(f.workspace, '.agents/runtime-data/sources')), false);
  // Build must not parse even corrupt private source association data.
  mkdirSync(join(f.root, '.agents/user-data'), { recursive: true });
  writeFileSync(join(f.root, '.agents/user-data/sources.json'), s.canary);
  const release = await buildRelease({ root: f.root, platform:fixtureTarget, output: join(f.directory, 'source-isolation-release') });
  for (const archive of [readArchive(readFileSync(join(release.output, `ksf-core-0.1.0-${fixtureTarget}.tar.gz`))), instanceEntries(release.instance)]) {
    assert.ok([...archive.values()].every(file => !file.bytes.includes(Buffer.from(s.canary))));
    assert.ok([...archive.keys()].every(path => !path.includes('sources.json') && !path.startsWith('repositories/')));
  }
});

test('Core update and rollback retain source associations and reject incompatible source dependencies in previews', async t => {
  const f = await distributionFixture(t), s = source(f);
  const association = join(f.workspace, '.agents/user-data/sources.json'), before = readFileSync(association);
  const next = await f.next();
  await systemUpdate({ root: f.workspace, from: next.coreArchive });
  assert.deepEqual(readFileSync(association), before);
  await systemRollback({ root: f.workspace });
  assert.deepEqual(readFileSync(association), before);
  assert.ok(existsSync(s.directory));
  const route = '.agents/core/abilities/competencies/ability-route/competency.md';
  const incompatible = await f.next('0.1.2', { [route]: readFileSync(join(f.root, route), 'utf8').replace(/^version: \d+\.\d+\.\d+/m, 'version: 0.9.0'),
    '.agents/core/abilities/partners/ksf-runtime/partner.md': readFileSync(join(f.root, '.agents/core/abilities/partners/ksf-runtime/partner.md'), 'utf8').replace(/competency\.ksf\.ability-route@\d+\.\d+\.\d+/, 'competency.ksf.ability-route@0.9.0') });
  await assert.rejects(systemUpdate({ root: f.workspace, from: incompatible.coreArchive, dryRun: true }), { code: 'SOURCE_CORE_INCOMPATIBLE' });
  await assert.rejects(systemUpdate({ root: f.workspace, from: incompatible.coreArchive }), { code: 'SOURCE_CORE_INCOMPATIBLE' });
  assert.deepEqual(readFileSync(association), before);
});
