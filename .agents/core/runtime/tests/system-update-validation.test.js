import {fixtureTarget} from './helpers/distribution-fixture.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {stableJSON} from '../src/distribution/common.js';
import {systemCheck,systemUpdate,systemFingerprint} from '../src/distribution/system.js';
import {distributionFixture} from './helpers/distribution-fixture.js';
const sample = 'first\none\ntwo\nthree\nfour\nfive\nlast\n';

test('update preview verifies the candidate but changes no live system or personal file', async t => {
  const f = await distributionFixture(t), next = await f.next();
  const before = systemFingerprint(f.workspace);
  const result = await systemUpdate({ root: f.workspace, source: next.source, dryRun: true });
  assert.equal(result.wouldChange, true); assert.equal(result.changed, false);
  assert.equal(systemFingerprint(f.workspace), before);
  assert.equal(existsSync(join(f.workspace, '.agents/runtime-data/system/transaction')), false);
});


test('checksum failures, wrong source identity and invalid candidates cannot publish a partial system', async t => {
  const f = await distributionFixture(t), next = await f.next();
  const before = systemFingerprint(f.workspace), feed = structuredClone(next.feed);
  feed.platforms[fixtureTarget].core.sha256 = '0'.repeat(64);
  writeFileSync(next.source, stableJSON(feed));
  await assert.rejects(systemUpdate({ root: f.workspace, source: next.source }), { code: 'CHECKSUM_MISMATCH' });
  feed.core_repository = 'different/core'; writeFileSync(next.source, stableJSON(feed));
  await assert.rejects(systemCheck({ root: f.workspace, source: next.source }), { code: 'RELEASE_INVALID' });
  assert.equal(systemFingerprint(f.workspace), before);
});
