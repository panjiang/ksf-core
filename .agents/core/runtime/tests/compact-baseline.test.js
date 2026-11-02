import {fixtureTarget} from './helpers/distribution-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { digestObject, installedManifest, releaseReceipt, stableJSON, writeAtomic } from '../src/distribution/common.js';
import { buildRelease, inspectCoreArchive } from '../src/distribution/release.js';
import { inspectReleaseDirectory } from '../src/distribution/publish.js';
import { gitBlobID, resolveBaseline } from '../src/distribution/baseline.js';
import { GitHubAPI } from '../src/distribution/github.js';
import { systemRead, systemUpdate, systemRollback, systemFingerprint } from '../src/distribution/system.js';
import { prepareContribution, readContribution, submitContribution } from '../src/distribution/contribute.js';
import { distributionFixture, commitWorkspace, git, contributionDescription } from './helpers/distribution-fixture.js';
import { ForkAPI } from './helpers/contribution-api.js';
const example = '.agents/core/example.txt';
const sample = 'first\none\ntwo\nthree\nfour\nfive\nlast\n';
const apiFor = f => new ForkAPI({ coreRoot: f.root });
const prepare = (f, api, options = {}) => prepareContribution({ ...contributionDescription, root: f.workspace, paths: [example], api, ...options });
const submit = (f, plan, api, options = {}) => submitContribution({ root: f.workspace, id: plan.id, reviewed: plan.digest, api, ...options });
async function published(t) {
  const f = await distributionFixture(t, { compact: true }), api = apiFor(f);
  writeAtomic(join(f.workspace, example), 'a reviewed fix\n'); commitWorkspace(f);
  const plan = await prepare(f, api); await submit(f, plan, api); api.calls = [];
  return { f, api, plan };
}

test('anonymous original reads use pinned raw content and verify blobs without one REST request per file', async () => {
  const commit = 'a'.repeat(40), treeSHA = 'b'.repeat(40), path = '.agents/core/中文 文件.txt', bytes = Buffer.from('original text\n'), calls = [];
  let tamper = false;
  const api = new GitHubAPI({ readOnly: true, token: '', fetcher: async (url, options) => {
    calls.push(String(url)); assert.equal(options.headers.Authorization, undefined);
    if (String(url).includes('/git/commits/')) return Response.json({ sha: commit, tree: { sha: treeSHA } });
    if (String(url).includes('/git/trees/')) return Response.json({ sha: treeSHA, truncated: false,
      tree: ['AGENTS.md', '.agents/core/build.json', '.agents/core/distribution.json', '.agents/ksf', path].map(path => ({ path,
        sha: gitBlobID(bytes), type: 'blob', mode: path === '.agents/ksf' ? '100755' : '100644' })) });
    assert.equal(String(url), `https://raw.githubusercontent.com/example/ksf-core/${commit}/.agents/core/${encodeURIComponent('中文 文件.txt')}`);
    return new Response(tamper ? 'wrong original' : bytes);
  } });
  const manifest = { schema_version: 4, launcher_protocol: 1, name: 'ksf-core', product: 'ksf-core', version: '0.1.0', platform: 'darwin-arm64',
    core: { repository: 'example/ksf-core', branch: 'main', revision: commit }, development: false };
  const resolved = await resolveBaseline(manifest, { api });
  assert.ok((await resolved.read(path)).equals(bytes)); assert.equal(calls.filter(url => url.startsWith('https://api.github.com')).length, 2);
  tamper = true; await assert.rejects(resolved.read(path), { code: 'BASELINE_MISMATCH' });
});

test('new templates contain only a small receipt; update archives retain checksums but no original text copies', async t => {
  const f = await distributionFixture(t, { compact: true }), receipt = installedManifest(f.workspace);
  assert.equal(receipt.schema_version, 4); assert.equal(receipt.files, undefined);
  assert.ok(readFileSync(join(f.workspace, '.agents/core/release.json')).length < 1024);
  const loaded = inspectReleaseDirectory(f.root, f.first.output);
  assert.equal(loaded.artifacts.length, 3);
  const core = inspectCoreArchive(readFileSync(join(f.first.output, f.first.index.platforms[fixtureTarget].core.name)));
  assert.ok(Object.values(core.manifest.files).every(record => record.baseline === undefined));
  assert.deepEqual(receipt, releaseReceipt(core.manifest));
});

test('ignored source files cannot silently enter an official package whose receipt names a clean commit', async t => {
  const f = await distributionFixture(t, { compact: true });
  const ignore = join(f.root, '.gitignore');
  writeAtomic(ignore, readFileSync(ignore, 'utf8') + '\n/.agents/core/ignored-source.txt\n');
  git(f.root, ['add', '.gitignore']); git(f.root, ['commit', '-m', 'Fictional ignored file policy']);
  f.save('.agents/core/ignored-source.txt', 'not in the recorded commit');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  await assert.rejects(buildRelease({ root: f.root, output: join(f.directory, 'wrong-official') }), { code: 'RELEASE_SOURCE_DIRTY' });
  assert.equal((await buildRelease({ root: f.root, output: join(f.directory, 'explicit-development'), allowDirty: true })).development, true);
});

test('unpublished development receipts report their identity without claiming a verified original baseline', async t => {
  const f = await distributionFixture(t, { compact: true }), receipt = installedManifest(f.workspace), api = apiFor(f);
  receipt.development = true; writeAtomic(join(f.workspace, '.agents/core/release.json'), stableJSON(receipt));
  const status = await systemRead({ root: f.workspace, api });
  assert.equal(status.version, '0.1.0'); assert.equal(status.baselineVerified, false); assert.equal(status.changes, null);
  assert.equal(status.baselineStatus, 'development-package'); assert.equal(api.calls.length, 0);
  commitWorkspace(f); await assert.rejects(prepare(f, api), { code: 'DEVELOPMENT_PACKAGE' });
});

test('compact baselines read the exact commit after main advances and fetch only required originals', async t => {
  const f = await distributionFixture(t, { compact: true }), api = apiFor(f), original = installedManifest(f.workspace).core.revision;
  await f.next('0.1.1', { [example]: 'a newer upstream file\n' });
  assert.notEqual(git(f.root, ['rev-parse', 'HEAD']), original);
  const before = systemFingerprint(f.workspace), status = await systemRead({ root: f.workspace, api });
  assert.deepEqual(status.changes, []); assert.equal(systemFingerprint(f.workspace), before);
  assert.ok(api.calls.some(c => c.path.endsWith(`/git/commits/${original}`)));
  const declaration=git(f.root,['rev-parse',`${original}:.agents/core/build.json`]);
  assert.deepEqual(api.calls.filter(c=>c.path.includes('/git/blobs/')).map(c=>c.path.split('/').at(-1)),[declaration]);
  const resolved = await resolveBaseline(installedManifest(f.workspace), { api });
  assert.equal((await resolved.read(example)).toString(), sample);
  assert.ok(api.calls.every(c => c.method === 'GET'));
  assert.ok(!api.calls.some(c => /latest|ref\/heads/.test(c.path)));
});

test('compact receipts for an older launcher source report both newly added fixed launchers', async t => {
  const f = await distributionFixture(t, { compact: true }), api = apiFor(f), receipt = installedManifest(f.workspace);
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(f.root, '.agents/bin'));
  git(f.root, ['mv', '.agents/ksf', '.agents/bin/ksf']); git(f.root, ['rm', '.agents/ksf.ps1']);
  git(f.root, ['commit', '-m', 'Fictional historical launcher layout']);
  receipt.core.revision = git(f.root, ['rev-parse', 'HEAD']);
  writeAtomic(join(f.workspace, '.agents/core/release.json'), stableJSON(receipt));
  const status = await systemRead({ root: f.workspace, api });
  assert.deepEqual(status.changes.map(c => `${c.state}:${c.path}`).sort(), ['deleted:.agents/bin/ksf', 'added:.agents/ksf', 'added:.agents/ksf.ps1'].sort());
});
