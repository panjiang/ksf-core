import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareContribution, readContribution, submitContribution } from '../src/distribution/contribute.js';
import { committedSource } from '../src/distribution/committed-source.js';
import { digestObject, installedManifest, sha256, stableJSON, validateManifest, writeAtomic } from '../src/distribution/common.js';
import { GitHubAPI } from '../src/distribution/github.js';
import { commitWorkspace, distributionFixture, git, contributionDescription } from './helpers/distribution-fixture.js';
import { ForkAPI } from './helpers/contribution-api.js';
const example = '.agents/core/example.txt';
async function fixture(t) {
  const f = await distributionFixture(t); commitWorkspace(f); return f;
}
function edit(f) {
  writeAtomic(join(f.workspace, example), 'a useful fictional Core fix\n');
  return commitWorkspace(f, { paths: [example] });
}
const apiFor = (f, options = {}) => new ForkAPI({ coreRoot: f.root, ...options });
const publish = (f, plan, api, options = {}) => submitContribution({ root: f.workspace, id: plan.id, reviewed: plan.digest, api, ...options });
const prepare = (f, options = {}) => prepareContribution({ ...contributionDescription, root: f.workspace, paths: [example], ...options });
async function submitted(t) {
  const f = await fixture(t); edit(f); const plan = await prepare(f), api = apiFor(f), result = await publish(f, plan, api);
  api.calls = []; return { f, plan, api, result, retry: () => publish(f, plan, api) };
}
function makeLegacy(f, plan, schema = 1) {
  const { digest, prDescription, prBody, ...old } = readContribution({ root: f.workspace, id: plan.id });
  old.schema_version = schema;
  if (schema < 3) delete old.commitMessage;
  if (schema === 1) {
    delete old.sourceCommit; delete old.baseline;
    old.changes = old.changes.map(({ before_mode, ...change }) => change);
  }
  const legacy = { ...old, digest: digestObject(old) };
  writeAtomic(join(f.workspace, `.agents/runtime-data/contributions/${plan.id}/plan.json`), stableJSON(legacy));
  return legacy;
}

test('HEAD includes cumulative committed fixes even when the latest commit contains only private material', async t => {
  const f = await fixture(t); edit(f);
  const path = '.agents/core/中文 文件.txt';
  writeAtomic(join(f.workspace, path), 'another committed system fix\n'); commitWorkspace(f, { paths: [path] });
  writeAtomic(join(f.workspace, '知识/private.md'), 'FICTIONAL_PRIVATE_FILE');
  const head = commitWorkspace(f, { paths: ['知识/private.md'], message: 'FICTIONAL_PRIVATE_MESSAGE' });
  const plan = await prepareContribution({ ...contributionDescription, root: f.workspace, all: true });
  assert.equal(plan.schema_version, 5); assert.equal(plan.sourceCommit, head);
  assert.deepEqual(plan.changes.map(c => c.workspace_path), [example, path].sort());
  assert.ok(!JSON.stringify(plan).includes('FICTIONAL_PRIVATE_'));
  assert.equal(readContribution({ root: f.workspace, id: plan.id }).digest, plan.digest);
  assert.ok(existsSync(join(f.workspace, plan.reviewPath)));
});

test('index, working edits, untracked files and an uncommitted manifest do not enter or block a contribution', async t => {
  const f = await fixture(t), head = edit(f), api = apiFor(f);
  writeAtomic(join(f.workspace, example), 'FICTIONAL_INDEX_CONTENT\n'); git(f.workspace, ['add', '--', example]);
  writeAtomic(join(f.workspace, example), 'FICTIONAL_WORKING_CONTENT\n');
  writeAtomic(join(f.workspace, '.agents/core/untracked.txt'), 'FICTIONAL_UNTRACKED_CONTENT');
  writeAtomic(join(f.workspace, '.agents/core/release.json'), 'uncommitted broken development metadata');
  const beforeIndex = readFileSync(join(f.workspace, '.git/index'));
  const plan = await prepareContribution({ ...contributionDescription, root: f.workspace, all: true });
  assert.equal(plan.sourceCommit, head); assert.equal(plan.changes.length, 1);
  assert.equal(Buffer.from(plan.changes[0].content, 'base64').toString(), 'a useful fictional Core fix\n');
  const result = await publish(f, plan, api);
  assert.equal(result.draft, true); assert.ok(readFileSync(join(f.workspace, '.git/index')).equals(beforeIndex));
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']), head);
  assert.ok(!JSON.stringify(api.calls).includes('FICTIONAL_'));
});

test('working-tree-only changes produce an empty committed contribution and no plan', async t => {
  const f = await fixture(t);
  writeAtomic(join(f.workspace, example), 'only uncommitted content');
  writeAtomic(join(f.workspace, '.agents/core/new.txt'), 'only untracked content');
  await assert.rejects(() => prepareContribution({ ...contributionDescription, root: f.workspace, all: true }), error => {
    assert.equal(error.code, 'CONTRIBUTION_EMPTY'); assert.equal(error.data.changes.length, 0);
    assert.equal(error.data.sourceCommit, git(f.workspace, ['rev-parse', 'HEAD'])); return true;
  });
  assert.equal(existsSync(join(f.workspace, '.agents/runtime-data/contributions')), false);
});

test('real committed workspace still rejects private contribution paths', async t => {
  const f = await fixture(t);
  await assert.rejects(() => prepare(f, {paths:['知识/private.md']}), {code:'CONTRIBUTION_PATH_INVALID'});
});

test('committed additions, deletion, permissions, binary data and Chinese paths are exported from Git', async t => {
  const f = await fixture(t);
  const binary = '.agents/core/binary.bin', added = '.agents/core/新增 文件.txt';
  rmSync(join(f.workspace, example)); chmodSync(join(f.workspace, 'AGENTS.md'), 0o755);
  writeAtomic(join(f.workspace, binary), Buffer.from([0, 255, 10])); writeAtomic(join(f.workspace, added), 'committed new text\n');
  commitWorkspace(f, { paths: [example, 'AGENTS.md', binary, added], modes:{'AGENTS.md':0o755} });
  const plan = await prepareContribution({ ...contributionDescription, root: f.workspace, all: true, dryRun: true });
  assert.equal(plan.changes.find(c => c.workspace_path === example).operation, 'delete');
  assert.equal(plan.changes.find(c => c.workspace_path === 'AGENTS.md').mode, 0o755);
  assert.equal(plan.changes.find(c => c.workspace_path === binary).diff, `Binary change: ${binary}\n`);
  assert.equal(plan.changes.find(c => c.workspace_path === added).operation, 'add');
  assert.equal(existsSync(join(f.workspace, '.agents/runtime-data/contributions')), false);
  const saved = await prepareContribution({ ...contributionDescription, root: f.workspace, all: true }), api = apiFor(f);
  assert.equal((await publish(f, saved, api)).draft, true);
  assert.ok(api.calls.some(c => c.method === 'POST' && c.path.endsWith('/git/blobs')));
});

test('Git and an existing HEAD are required; a parent repository cannot silently supply the source', async t => {
  const f = await distributionFixture(t);
  await assert.rejects(() => prepare(f), { code: 'CONTRIBUTION_GIT_REQUIRED' });
  assert.throws(() => committedSource(f.workspace, { binary: join(f.directory, 'missing-git') }), { code: 'CONTRIBUTION_GIT_REQUIRED' });
  git(f.workspace, ['init', '--template=', '--initial-branch=main']);
  await assert.rejects(() => prepare(f), { code: 'CONTRIBUTION_HEAD_REQUIRED' });
  commitWorkspace(f);
  const nested = join(f.workspace, 'nested-ksf'); mkdirSync(nested);
  await assert.rejects(() => prepareContribution({ ...contributionDescription, root: nested, all: true }), { code: 'CONTRIBUTION_GIT_ROOT_MISMATCH' });
});
