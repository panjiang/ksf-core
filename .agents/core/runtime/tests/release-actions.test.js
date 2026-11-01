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
test('frozen single-Core handoff and read-only recovery retain the exact artifacts', async t => {
  const f = await distributionFixture(t), identity = inspectHandoff({ root: f.root, directory: f.first.output });
  assert.equal(identity.revision, f.first.coreRevision);
  assert.throws(() => inspectHandoff({ root: f.root, directory: f.first.output, indexHash: 'f'.repeat(64) }), { code: 'RELEASE_INPUT_CHANGED' });
  const p = published(f), directory = join(f.directory, 'recovered');
  const result = await recoverPublishedBundle({ root: f.root, directory, tag: 'v0.1.0', ...p });
  assert.deepEqual(result, identity); assert.equal(p.downloads.length, 3);
  for (const [name, bytes] of p.files) assert.deepEqual(readFileSync(join(directory, name)), bytes);
});
test('Core preflight requires its own template and stable default branch', async t => {
  const f = await distributionFixture(t);
  for (const [is_template, default_branch, succeeds] of [[true, 'core-main', true], [false, 'core-main', false], [true, 'main', false]]) {
    const api = { request: async (method, path) => { assert.equal(method, 'GET'); assert.equal(path, '/repos/yinbaiyuan/ksf-core'); return { full_name: 'yinbaiyuan/ksf-core', is_template, default_branch }; } };
    if (succeeds) assert.equal((await corePreflight({ root: f.root, api })).template, true);
    else await assert.rejects(corePreflight({ root: f.root, api }), { code: 'CORE_REPOSITORY_INVALID' });
  }
});

test('exact release recovery uses the frozen package targets rather than a newer publisher build',async t=>{
  const f=await distributionFixture(t),p=published(f),current=JSON.parse(readFileSync(join(f.root,'.agents/core/build.json')));
  current.runtime.packages['future-platform']={archive_path:'not-present',archive_sha256:'f'.repeat(64)};
  writeFileSync(join(f.root,'.agents/core/build.json'),JSON.stringify(current));
  const result=await recoverPublishedBundle({root:f.root,directory:join(f.directory,'old-frozen-release'),tag:'v0.1.0',...p});
  assert.equal(result.revision,f.first.coreRevision);assert.ok(p.calls.every(call=>call.method==='GET'));
});
