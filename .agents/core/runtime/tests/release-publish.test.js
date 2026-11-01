import {fixtureTarget} from './helpers/distribution-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishRelease } from '../src/distribution/publish.js';
import { sha256, stableJSON } from '../src/distribution/common.js';
import { distributionFixture } from './helpers/distribution-fixture.js';
import { systemUpdate } from '../src/distribution/system.js';
import { workspaceDocuments } from '../src/distribution/release.js';

import { PublicationAPI } from './helpers/publication-api.js';

test('publication writes only Core assets and retries without duplicate uploads', async t => {
  const f = await distributionFixture(t), api = new PublicationAPI();
  const result = await publishRelease({ root: f.root, directory: f.first.output, api });
  assert.equal(result.published, true); assert.equal(api.release.draft, false);
  assert.equal(api.release.assets.length, 3); assert.equal(result.template, undefined);
  assert.ok(api.calls.every(call => !call.path.includes('ksf-workspace')));
  const uploads = api.calls.filter(call => call.options?.upload).length;
  await publishRelease({ root: f.root, directory: f.first.output, api });
  assert.equal(api.calls.filter(call => call.options?.upload).length, uploads);
});
test('an unknown asset upload response reuses its checksum-verified asset on retry', async t => {
  const f = await distributionFixture(t), api = new PublicationAPI({ failUpload: true });
  await assert.rejects(publishRelease({ root: f.root, directory: f.first.output, api }), { code: 'GITHUB_REQUEST_FAILED' });
  const result = await publishRelease({ root: f.root, directory: f.first.output, api });
  assert.equal(result.published, true); assert.equal(api.release.assets.length, 3);
  assert.equal(new Set(api.release.assets.map(a => a.name)).size, 3);
  assert.equal(api.calls.some(c => c.path === '/repos/yinbaiyuan/ksf-workspace'), false);
});
test('publication preview checks artifacts without authenticating or writing remote state', async t => {
  const f = await distributionFixture(t), api = new PublicationAPI();
  assert.equal((await publishRelease({ root: f.root, directory: f.first.output, dryRun: true, api })).wouldPublish, true);
  assert.equal(api.calls.length, 0);
});
test('published assets and existing version tags cannot be silently replaced', async t => {
  const f = await distributionFixture(t), api = new PublicationAPI();
  await publishRelease({ root: f.root, directory: f.first.output, api });
  api.release.assets.pop();
  await assert.rejects(publishRelease({ root: f.root, directory: f.first.output, api }), { code: 'RELEASE_IMMUTABLE' });
  api.tag.object.sha = 'f'.repeat(40);
  await assert.rejects(publishRelease({ root: f.root, directory: f.first.output, api }), { code: 'RELEASE_TAG_CONFLICT' });
});
