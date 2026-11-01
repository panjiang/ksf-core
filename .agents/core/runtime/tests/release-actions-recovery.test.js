import {fixtureTarget} from './helpers/distribution-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectHandoff, recoverPublishedBundle, corePreflight, reportPublication } from '../src/distribution/release-actions.js';
import { inspectReleaseDirectory } from '../src/distribution/publish.js';
import { createArchive, readArchive } from '../src/distribution/archive.js';
import { sha256, stableJSON } from '../src/distribution/common.js';
import { distributionFixture, repository } from './helpers/distribution-fixture.js';
import { PublicationAPI } from './helpers/publication-api.js';
import YAML from '../src/vendor/yaml/dist/index.js';
function published(f) {
  const files = new Map(['ksf-core-index.json', 'ksf-core-release.json', ...Object.values(f.first.index.platforms[fixtureTarget]).map(d => d.name)]
    .map(name => [name, readFileSync(join(f.first.output, name))]));
  const base = 'https://github.com/yinbaiyuan/ksf-core/releases/download/v0.1.0/';
  const release = { draft: false, tag_name: 'v0.1.0', assets: [...files].map(([name, bytes]) => ({ name, size: bytes.length, digest: `sha256:${sha256(bytes)}`, browser_download_url: base + name })) };
  const calls = [], downloads = [];
  const api = { request: async (method, path) => {
    calls.push({ method, path }); assert.equal(method, 'GET');
    if (path.endsWith('/releases/tags/v0.1.0')) return release;
    if (path.endsWith('/git/ref/tags/v0.1.0')) return { object: { type: 'commit', sha: f.first.coreRevision } };
    throw new Error('Unexpected recovery call: ' + path);
  } };
  const fetcher = async url => { downloads.push(String(url)); return new Response(files.get(new URL(url).pathname.split('/').at(-1))); };
  return { files, release, calls, downloads, api, fetcher };
}
for (const kind of ['missing-tag', 'draft', 'wrong-source', 'wrong-index-hash', 'tampered-core', 'duplicate', 'unsafe-name', 'changed-tag']) {
  test(`Core recovery refuses ${kind} without publishing`, async t => {
    const f = await distributionFixture(t), p = published(f), output = join(f.directory, 'rejected');
    let tag = 'v0.1.0', expected = 'RELEASE_INVALID';
    if (kind === 'missing-tag') { tag = ''; expected = 'RELEASE_TAG_INVALID'; }
    if (kind === 'draft') p.release.draft = true;
    if (kind === 'wrong-source') {
      const index = { ...f.first.index, core_revision: 'f'.repeat(40) }, bytes = Buffer.from(stableJSON(index));
      p.files.set('ksf-core-index.json', bytes); Object.assign(p.release.assets[0], { size: bytes.length, digest: `sha256:${sha256(bytes)}` });
      expected = 'RELEASE_TAG_CONFLICT';
    }
    if (kind === 'wrong-index-hash') { p.release.assets[0].digest = 'sha256:' + 'f'.repeat(64); expected = 'CHECKSUM_MISMATCH'; }
    if (kind === 'tampered-core') { p.files.set(f.first.index.platforms[fixtureTarget].core.name, Buffer.from('bad')); expected = 'CHECKSUM_MISMATCH'; }
    if (kind === 'duplicate') p.release.assets.push(p.release.assets[1]);
    if (kind === 'unsafe-name') {
      const index = structuredClone(f.first.index); index.platforms[fixtureTarget].core.name = '../outside';
      const bytes = Buffer.from(stableJSON(index)); p.files.set('ksf-core-index.json', bytes);
      Object.assign(p.release.assets[0], { size: bytes.length, digest: `sha256:${sha256(bytes)}` });
    }
    if (kind === 'changed-tag') {
      const original = p.api.request; let tagReads = 0;
      p.api.request = async (method, path) => path.includes('/git/ref/tags/') && ++tagReads > 1 ?
        { object: { type: 'commit', sha: 'f'.repeat(40) } } : original(method, path);
      expected = 'RELEASE_TAG_CONFLICT';
    }
    await assert.rejects(recoverPublishedBundle({ root: f.root, directory: output, tag, ...p }), { code: expected });
    assert.ok(p.calls.every(call => call.method === 'GET'));
    if (!['changed-tag'].includes(kind)) assert.equal(existsSync(output), false);
  });
}
