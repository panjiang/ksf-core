import {fixtureTarget} from './helpers/distribution-fixture.js';
import {gitBinary} from './helpers/platform.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { distributionFixture, instanceEntries } from './helpers/distribution-fixture.js';
import { readUserData, writeUserData } from '../src/services/user-data.js';
import { recordDefinition } from '../src/user-data/records.js';
import { systemUpdate, systemRollback } from '../src/distribution/system.js';
import { buildRelease } from '../src/distribution/release.js';
import { readArchive } from '../src/distribution/archive.js';

test('real Core upgrade and rollback preserve object records byte-for-byte', async t => {
  const f = await distributionFixture(t), objectId = 'partner.test.portable';
  const saved = writeUserData({ root: f.workspace, objectId, values: { language: '中文', output: 'reports' }, ifMatch: 'missing' });
  const path = join(f.workspace, saved.path), bytes = readFileSync(path), next = await f.next();
  await systemUpdate({ root: f.workspace, from: next.coreArchive }); assert.deepEqual(readFileSync(path), bytes);
  await systemRollback({ root: f.workspace }); assert.deepEqual(readFileSync(path), bytes);
  assert.equal(readUserData({ root: f.workspace, objectId }).etag, saved.etag);
});

test('Core packages exclude even invalid object records; instance policies track JSON and ignore nested temporaries', async t => {
  const f = await distributionFixture(t), path = join(f.root, recordDefinition(undefined, 'partner.test.private').path);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'PRIVATE_OBJECT_DATA_CANARY');
  const built = await buildRelease({ root: f.root, output: join(f.directory, 'object-data-exclusion') });
  for (const archive of [readArchive(readFileSync(join(built.output, `ksf-core-0.1.0-${fixtureTarget}.tar.gz`))), instanceEntries(built.instance)]) {
    assert.ok([...archive.values()].every(file => !file.bytes.includes(Buffer.from('PRIVATE_OBJECT_DATA_CANARY'))));
    assert.ok(![...archive.keys()].some(name => name.startsWith('.agents/user-data/abilities/')));
  }
  const target = '.agents/user-data/abilities/' + 'a'.repeat(64) + '.json';
  assert.equal(spawnSync(gitBinary, ['-C', f.root, 'check-ignore', '-q', target]).status, 0);
  assert.equal(spawnSync(gitBinary, ['init', '--template=', f.workspace]).status, 0);
  assert.equal(spawnSync(gitBinary, ['-C', f.workspace, 'check-ignore', '-q', target]).status, 1);
  assert.equal(spawnSync(gitBinary, ['-C', f.workspace, 'check-ignore', '-q', target + '.x.tmp']).status, 0);
  const attrs = spawnSync(gitBinary, ['-C', f.workspace, 'check-attr', 'eol', '--', target], { encoding: 'utf8' });
  assert.equal(attrs.status, 0); assert.match(attrs.stdout, /eol: lf/);
});
