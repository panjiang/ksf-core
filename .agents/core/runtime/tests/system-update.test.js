import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {installedManifest,writeAtomic} from '../src/distribution/common.js';
import {systemUpdate,systemFingerprint} from '../src/distribution/system.js';
import {distributionFixture} from './helpers/distribution-fixture.js';
const sample = 'first\none\ntwo\nthree\nfour\nfive\nlast\n';

test('three-way update preserves non-overlapping local edits and untracked Core additions', async t => {
  const f = await distributionFixture(t), next = await f.next('0.1.1', { '.agents/core/example.txt': sample.replace('last', 'release') });
  writeAtomic(join(f.workspace, '.agents/core/example.txt'), sample.replace('first', 'local'));
  writeAtomic(join(f.workspace, '.agents/core/my-extension.txt'), 'my local extension\n');
  const result = await systemUpdate({ root: f.workspace, from: next.coreArchive });
  assert.equal(result.changed, true);
  assert.equal(readFileSync(join(f.workspace, '.agents/core/example.txt'), 'utf8'), sample.replace('first', 'local').replace('last', 'release'));
  assert.equal(readFileSync(join(f.workspace, '.agents/core/my-extension.txt'), 'utf8'), 'my local extension\n');
});


test('text conflicts preserve the complete previous system and return reviewable conflict content', async t => {
  const f = await distributionFixture(t), next = await f.next('0.1.1', { '.agents/core/example.txt': 'release\n' });
  writeAtomic(join(f.workspace, '.agents/core/example.txt'), 'local\n');
  const before = systemFingerprint(f.workspace);
  await assert.rejects(systemUpdate({ root: f.workspace, source: next.source }), error => {
    assert.equal(error.code, 'UPDATE_CONFLICT'); assert.equal(error.data.conflicts[0].path, '.agents/core/example.txt');
    assert.match(error.data.conflicts[0].merged, /<<<<<<< local/); return true;
  });
  assert.equal(systemFingerprint(f.workspace), before); assert.equal(installedManifest(f.workspace).version, '0.1.0');
});


test('upstream deletion removes unchanged files but refuses to discard locally modified files', async t => {
  const f = await distributionFixture(t), next = await f.next('0.1.1', { '.agents/core/example.txt': null });
  writeAtomic(join(f.workspace, '.agents/core/example.txt'), 'local retained\n');
  await assert.rejects(systemUpdate({ root: f.workspace, from: next.coreArchive }), { code: 'UPDATE_CONFLICT' });
  writeAtomic(join(f.workspace, '.agents/core/example.txt'), sample);
  await systemUpdate({ root: f.workspace, from: next.coreArchive });
  assert.equal(existsSync(join(f.workspace, '.agents/core/example.txt')), false);
});
