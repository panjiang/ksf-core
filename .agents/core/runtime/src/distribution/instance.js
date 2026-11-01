import {gitEnvironment} from './committed-source.js';
import {acquireServiceLock} from '../services/service-lock.js';
import { existsSync, mkdirSync, readFileSync, rmSync, openSync, closeSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configuration } from './configuration.js';
import { installedManifest, releaseReceipt, validateManifest } from './manifests.js';
import { gitExecutable } from '../platform/index.js';
import { GitHubAPI } from './github.js';
import { isRevision, isBranch } from './git-values.js';
import { resolveBaseline, matchesBaseline } from './baseline.js';
import { readRegular, checkedPath, fileMode, walkFiles, writeAtomic, readJSON } from './files.js';
import { developmentPath, managedPath } from './paths.js';
import { userDirectories, workspaceDocuments } from './release.js';
import { launcherFiles } from './products.js';
import { stableJSON, sha256 } from '../shared/hash.js';
import { fail } from './errors.js';

function git(root, args, required = true) {
  const result = spawnSync(gitExecutable, ['--no-replace-objects', '-C', root, ...args], { encoding: 'utf8', timeout: 30000,
    env: gitEnvironment() });
  if (required && result.status !== 0) fail('INSTANCE_GIT_INVALID', 'Cannot inspect the instance Git repository.');
  return result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : null;
}
function ownsGitRoot(root) {
  const top = git(root, ['rev-parse', '--show-toplevel'], false);
  return top !== null && realpathSync.native(top) === realpathSync.native(root);
}
function isCoreRemote(remote, config) {
  if (!remote) return false;
  let path;
  const scp = /^git@github\.com:(.+)$/i.exec(remote);
  if (scp) path = scp[1];
  else {
    try {
      const url = new URL(remote);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !['github.com', 'ssh.github.com'].includes(url.hostname.toLowerCase())) return false;
      path = decodeURIComponent(url.pathname);
    } catch { return false; }
  }
  return path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase() === config.core_repository.toLowerCase();
}
export function isCoreSource(root, config = configuration(root)) {
  if (!ownsGitRoot(root)) return false;
  const remote = git(root, ['remote', 'get-url', 'origin'], false);
  return isCoreRemote(remote, config);
}
export function needsInstanceInitialization(root) {
  if (existsSync(checkedPath(root, stateFile))) return true;
  const raw = readJSON(root, '.agents/core/distribution.json', true);
  if (!raw || raw.schema_version === 1) return false;
  const config = configuration(root), receipt = installedManifest(root, true);
  return config.schema_version === 2 && ((!receipt && !isCoreSource(root, config)) || receipt?.instance_initialization === 1);
}
async function templateRevision(root, config, api, revision) {
  if (!ownsGitRoot(root)) fail('INSTANCE_GIT_ROOT_INVALID', 'Initialize a template only at its own Git working-tree root.');
  const roots = git(root, ['rev-list', '--max-parents=0', 'HEAD']).split('\n');
  if (roots.length !== 1 || !isRevision(roots[0])) fail('INSTANCE_SOURCE_UNVERIFIED', 'A Core template instance must have one initial commit.');
  const originalTree = git(root, ['rev-parse', `${roots[0]}^{tree}`]);
  if (revision !== undefined) {
    if (!isRevision(revision)) fail('INSTANCE_SOURCE_UNVERIFIED', 'Supply an exact 40-character Core commit.');
    const source = await api.request('GET', `/repos/${config.core_repository}/git/commits/${revision}`);
    if (source.sha !== revision || source.tree?.sha !== originalTree) fail('INSTANCE_SOURCE_UNVERIFIED', 'The initial instance tree does not match the selected Core commit.');
    return revision;
  }
  // GitHub templates have independent histories, but preserve the original tree.
  // Match that tree before accepting a source SHA; never guess from latest/main.
  for (let page = 1; page <= 20; page++) {
    const commits = await api.request('GET', `/repos/${config.core_repository}/commits?sha=${encodeURIComponent(config.core_branch)}&per_page=100&page=${page}`);
    if (!Array.isArray(commits)) fail('INSTANCE_SOURCE_UNVERIFIED', 'Cannot inspect the official Core history.');
    const match = commits.find(commit => isRevision(commit.sha) && commit.commit?.tree?.sha === originalTree);
    if (match) return match.sha;
    if (commits.length < 100) break;
  }
  fail('INSTANCE_SOURCE_UNVERIFIED', 'The initial tree was not found on the Core stable line. Supply --revision for an older verified Core template; no files were changed.');
}
const stateFile = '.agents/runtime-data/instance-initialization/transaction.json';
const instanceGitConfig = [
  ['push.default', 'current'], ['branch.main.remote', 'origin'],
  ['branch.main.merge', 'refs/heads/main'], ['branch.main.pushRemote', 'origin'],
];
function configValues(root, key, local = true) {
  const raw = git(root, ['config', ...(local ? ['--local'] : []), '--null', '--get-all', key], false);
  return raw === null ? [] : raw.split('\0').slice(0, -1);
}
const sameValues = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function planInstanceGit(root, branch, target, { targetHead, resume = false } = {}) {
  if (branch === null) return null;
  if (branch === '') fail('INSTANCE_BRANCH_INVALID', 'Select a local branch before initializing the instance.');
  const existing = git(root, ['rev-parse', '--verify', `refs/heads/${target}`], false);
  if (branch !== target && existing && (!resume || existing !== targetHead)) fail('INSTANCE_BRANCH_CONFLICT', 'The personal main branch already exists; select it before initialization.');
  // An explicit push refspec or mirror overrides push.default. Preserve custom
  // settings and stop rather than accidentally sending personal data to Core.
  if (configValues(root, 'remote.origin.push', false).length || git(root, ['config', '--bool', '--get', 'remote.origin.mirror'], false) === 'true') {
    fail('INSTANCE_PUSH_CONFIG_CONFLICT', 'Review the origin push refspec or mirror setting before initializing; no Git settings were changed.');
  }
  const pushURLs = git(root, ['remote', 'get-url', '--push', '--all', 'origin'], false)?.split('\n') ?? [];
  if (pushURLs.some(url => isCoreRemote(url, configuration(root)))) fail('INSTANCE_PUSH_CONFIG_CONFLICT', 'The origin push destination includes the official Core; preserve the remote settings and select a personal repository.');
  const config = instanceGitConfig.map(([key, value]) => ({ key, before: configValues(root, key), after: [value] }));
  if (config.some(item => item.before.length > 1)) fail('INSTANCE_PUSH_CONFIG_CONFLICT', 'Preserve the multi-valued branch or push settings for review before initializing.');
  const head = git(root, ['rev-parse', 'HEAD']);
  return { branchBefore: branch, branchAfter: target, head, targetHead: targetHead ?? head, resume, created: branch !== target && !existing,
    refLogMessage: `ksf instance init ${randomUUID()}`, config };
}
function existingInstance(root, config) {
  if (!ownsGitRoot(root)) return null;
  const branch = git(root, ['branch', '--show-current']), target = config.instance_branch ?? 'main';
  if (!branch || branch === target) return null;
  const local = git(root, ['rev-parse', '--verify', `refs/heads/${target}`], false);
  const targetHead = local ?? git(root, ['rev-parse', '--verify', `refs/remotes/origin/${target}`], false);
  if (!targetHead) {
    const fetch = configValues(root, 'remote.origin.fetch', false);
    const fullFetch = 'refs/heads/*:refs/remotes/origin/*';
    if (configValues(root, 'remote.origin.url', false).length &&
        (!fetch.length || fetch.some(spec => spec !== fullFetch && spec !== `+${fullFetch}`))) {
      fail('INSTANCE_BRANCH_CONFLICT', 'The origin fetch mapping may hide an existing personal main. Fetch all origin branches or clone the existing main explicitly before initialization.');
    }
    return null;
  }
  let receipt;
  try { receipt = validateManifest(JSON.parse(git(root, ['show', `${targetHead}:.agents/core/release.json`], false))); }
  catch { fail('INSTANCE_BRANCH_CONFLICT', 'An existing personal main has no valid installed Core receipt; preserve it and select or repair that branch before initialization.'); }
  if (receipt.development || receipt.instance_initialization || receipt.core.repository !== config.core_repository ||
      git(root, ['merge-base', '--is-ancestor', 'HEAD', targetHead], false) === null) {
    fail('INSTANCE_BRANCH_CONFLICT', 'The existing main is not an initialized descendant of this template snapshot; preserve both branches for review.');
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=no']) !== '') fail('INSTANCE_BRANCH_CONFLICT', 'Save the tracked working-tree and index changes before restoring the existing personal main.');
  return { receipt, git: planInstanceGit(root, branch, target, { targetHead, resume: true }) };
}
function validateInstanceGit(state) {
  if (state === null) return;
  if (!state || !isBranch(state.branchBefore) || state.branchAfter !== 'main' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(state.head) || !/^ksf instance init [a-f0-9-]{36}$/.test(state.refLogMessage) ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(state.targetHead ?? state.head) || typeof state.created !== 'boolean' ||
      (state.resume !== undefined && typeof state.resume !== 'boolean') ||
      (state.resume ? state.branchBefore === state.branchAfter : state.created !== (state.branchBefore !== state.branchAfter) || (state.targetHead ?? state.head) !== state.head) ||
      !Array.isArray(state.config) || state.config.length !== instanceGitConfig.length ||
      state.config.some((item, index) => item.key !== instanceGitConfig[index][0] || !Array.isArray(item.before) || item.before.length > 1 || item.before.some(value => typeof value !== 'string' || value.includes('\0')) || !sameValues(item.after, [instanceGitConfig[index][1]]))) {
    fail('INSTANCE_RECOVERY_INVALID', 'Preserve the incomplete instance Git transaction for inspection.');
  }
}
function checkInstanceGitRecovery(root, state) {
  if (!state) return;
  const branch = git(root, ['branch', '--show-current'], false);
  const before = git(root, ['rev-parse', '--verify', `refs/heads/${state.branchBefore}`], false);
  const after = git(root, ['rev-parse', '--verify', `refs/heads/${state.branchAfter}`], false);
  if (!ownsGitRoot(root) || ![state.branchBefore, state.branchAfter].includes(branch) || before !== state.head ||
      (after !== null && after !== (state.targetHead ?? state.head)) || (branch === state.branchAfter && after === null) ||
      (!state.created && after === null) ||
      (state.resume && git(root, ['status', '--porcelain', '--untracked-files=no']) !== '') ||
      (state.created && after !== null && git(root, ['reflog', 'show', '-1', '--format=%gs', `refs/heads/${state.branchAfter}`], false) !== state.refLogMessage) ||
      state.config.some(item => { const actual = configValues(root, item.key); return !sameValues(actual, item.before) && !sameValues(actual, item.after); })) {
    fail('INSTANCE_RECOVERY_CONFLICT', 'The instance branch or Git settings changed during initialization; preserve the transaction and local commits.');
  }
}
function applyInstanceGit(root, state) {
  if (!state) return;
  if (git(root, ['branch', '--show-current']) !== state.branchBefore || git(root, ['rev-parse', 'HEAD']) !== state.head ||
      state.config.some(item => !sameValues(configValues(root, item.key), item.before))) fail('INSTANCE_INPUT_CHANGED', 'Git changed during initialization.');
  const target = git(root, ['rev-parse', '--verify', `refs/heads/${state.branchAfter}`], false);
  if (state.created ? target !== null : target !== (state.targetHead ?? state.head)) fail('INSTANCE_INPUT_CHANGED', 'The personal main reference changed during initialization.');
  if (state.created) {
    git(root, ['update-ref', '--create-reflog', '-m', state.refLogMessage, `refs/heads/${state.branchAfter}`, state.targetHead ?? state.head, '0'.repeat(state.head.length)]);
  }
  if (state.branchBefore !== state.branchAfter && git(root, ['switch', '--no-overwrite-ignore', state.branchAfter], false) === null) fail('INSTANCE_BRANCH_CONFLICT', 'Cannot switch to personal main without replacing local files; preserve tracked, untracked and ignored files before retrying.');
  if (git(root, ['rev-parse', 'HEAD']) !== (state.targetHead ?? state.head)) fail('INSTANCE_INPUT_CHANGED', 'The personal branch changed during initialization.');
  for (const item of state.config) git(root, ['config', '--local', '--replace-all', item.key, item.after[0]]);
  if (state.config.some(item => git(root, ['config', '--get', item.key], false) !== item.after[0])) fail('INSTANCE_PUSH_CONFIG_CONFLICT', 'Higher-priority Git settings override the personal main push target.');
}
function restoreInstanceGit(root, state) {
  if (!state) return;
  checkInstanceGitRecovery(root, state);
  for (const item of [...state.config].reverse()) {
    if (sameValues(configValues(root, item.key), item.before)) continue;
    git(root, ['config', '--local', ...(item.before.length ? ['--replace-all', item.key, item.before[0]] : ['--unset-all', item.key])]);
  }
  if (state.branchBefore !== state.branchAfter && git(root, ['branch', '--show-current']) === state.branchAfter) git(root, ['switch', '--no-overwrite-ignore', state.branchBefore]);
  if (state.created) {
    // Compare-and-delete only our untouched new ref; retain any pre-existing
    // branch settings instead of deleting the entire section with branch -d.
    if (git(root, ['rev-parse', '--verify', `refs/heads/${state.branchAfter}`], false) !== null) git(root, ['update-ref', '-d', `refs/heads/${state.branchAfter}`, state.targetHead ?? state.head]);
  }
}
function recoverInitialization(root) {
  const state = readJSON(root, stateFile, true);
  if (!state) return;
  const allowed = new Set(['README.md', '.gitignore', '.gitattributes', ...workspaceDocuments, ...userDirectories.map(path => `${path}/.gitkeep`), '.agents/core/release.json']);
  if (![1, 2, 3].includes(state.schema_version) || !Array.isArray(state.files) || state.files.some(file => !allowed.has(file.path) || !/^[a-f0-9]{64}$/.test(file.after_sha256) || !(file.before === null || typeof file.before === 'string')) || (state.branchBefore && !isBranch(state.branchBefore)) || state.branchAfter !== 'main') fail('INSTANCE_RECOVERY_INVALID', 'Preserve the incomplete initialization transaction for inspection.');
  if (state.schema_version >= 2) {
    validateInstanceGit(state.git);
    if (state.git?.branchBefore !== (state.branchBefore ?? undefined) || (state.git && state.git.branchAfter !== state.branchAfter)) fail('INSTANCE_RECOVERY_INVALID', 'The recorded instance branch transaction is inconsistent.');
    checkInstanceGitRecovery(root, state.git);
  } else if (state.branchBefore) {
    // Legacy rename records did not pin HEAD. Only the unchanged original
    // clone reference can prove that no personal commit would be renamed.
    const original = git(root, ['rev-parse', '--verify', `refs/remotes/origin/${state.branchBefore}`], false);
    const branch = git(root, ['branch', '--show-current'], false);
    if (!ownsGitRoot(root) || !original || git(root, ['rev-parse', 'HEAD'], false) !== original ||
        ![state.branchBefore, state.branchAfter].includes(branch)) {
      fail('INSTANCE_RECOVERY_CONFLICT', 'The legacy initialization did not record HEAD; preserve files and personal commits unless the original origin reference still matches.');
    }
  }
  // Only restore a file that still has the value this operation wrote.
  for (const file of [...state.files].reverse()) {
    const target = checkedPath(root, file.path), bytes = readRegular(root, file.path, true);
    const before = file.before === null ? null : Buffer.from(file.before, 'base64');
    if ((bytes === null && before === null) || (bytes && before && bytes.equals(before))) continue;
    if (!bytes || sha256(bytes) !== file.after_sha256) fail('INSTANCE_RECOVERY_CONFLICT', `Initialization encountered a concurrent edit: ${file.path}.`);
    if (before === null) rmSync(target); else writeAtomic(target, before, file.before_mode);
  }
  if (state.schema_version >= 2) restoreInstanceGit(root, state.git);
  else if (state.branchBefore && git(root, ['branch', '--show-current'], false) === state.branchAfter) git(root, ['branch', '-m', state.branchBefore]);
  rmSync(checkedPath(root, stateFile));
}
async function initializeInstanceOperation({ root, revision, dryRun = false, api, fetcher, fault }) {
  if (dryRun && existsSync(checkedPath(root, stateFile))) fail('INSTANCE_RECOVERY_REQUIRED', 'An incomplete initialization requires instance init without --dry-run.');
  recoverInitialization(root);
  const config = configuration(root), current = installedManifest(root, true);
  if (current && !current.instance_initialization) return { initialized: true, changed: false, core: current.core, version: current.version };
  if (current?.development) fail('DEVELOPMENT_PACKAGE', 'Use the local build instance directory for an explicit development trial; a development archive is not an official instance source.');
  if (isCoreSource(root, config)) fail('INSTANCE_CORE_SOURCE', 'The official Core checkout is a source repository; create a private repository from its template first.');
  const existing = !current && existingInstance(root, config);
  if (existing) {
    const result = { initialized: true, changed: false, dryRun, resumed: true, core: existing.receipt.core, version: existing.receipt.version,
      branch: existing.git.branchAfter, previousBranch: existing.git.branchBefore, createdBranch: existing.git.created, pushTarget: 'origin/main', files: [], preserved: [] };
    if (dryRun) return { ...result, wouldChange: true };
    return applyInitialization(root, result, [], existing.git, fault);
  }
  const github = api ?? new GitHubAPI({ readOnly: true, fetcher });
  const receipt = current ? releaseReceipt(current) : { schema_version: 5, origin: 'core-template', launcher_protocol: 1, name: 'ksf-core', product: 'ksf-core',
    version: JSON.parse(readRegular(root, '.agents/core/build.json')).version, platform: `${process.platform}-${process.arch}`,
    core: { repository: config.core_repository, branch: config.core_branch, revision: await templateRevision(root, config, github, revision) }, development: false };
  const baseline = await resolveBaseline(receipt, { api: github, fetcher });
  const differences = [];
  for (const [path, record] of Object.entries(baseline.files)) {
    const bytes = readRegular(root, path, true);
    if (!matchesBaseline(bytes === null ? null : { bytes, mode: fileMode(checkedPath(root, path), record.mode) }, record)) differences.push(path);
  }
  for (const path of [...walkFiles(root, '.agents/core', { exclude: developmentPath }), ...launcherFiles, 'AGENTS.md']) {
    if (managedPath(path) && !baseline.files[path] && path !== '.agents/core/manifest.yaml') differences.push(path);
  }
  if (differences.length) fail('INSTANCE_SOURCE_MODIFIED', 'Initialize before changing system files; preserve or restore the listed changes first.', { paths: differences });
  const files = [], preserved = [];
  function add(path, bytes) {
    const before = readRegular(root, path, true);
    if (before !== null) { preserved.push(path); return; }
    files.push({ path, bytes, before: null, before_mode: 0o644 });
  }
  for (const path of ['README.md', '.gitignore', '.gitattributes', ...workspaceDocuments]) {
    const bytes = readRegular(root, `.agents/core/distribution/template/${path}`);
    // Public Core root documents are owned by the new user after initialization.
    // Replace only the unchanged, verified source document; preserve custom text.
    const before = readRegular(root, path, true);
    const source = before && ['README.md', '.gitignore', '.gitattributes'].includes(path) ? await baseline.readSource(path) : null;
    if (before && source && before.equals(source.bytes)) files.push({ path, bytes, before: before.toString('base64'), before_mode: fileMode(checkedPath(root, path)) });
    else add(path, bytes);
  }
  for (const directory of userDirectories) add(`${directory}/.gitkeep`, Buffer.alloc(0));
  const receiptBytes = readRegular(root, '.agents/core/release.json', true);
  files.push({ path: '.agents/core/release.json', bytes: Buffer.from(stableJSON(receipt)), before: receiptBytes?.toString('base64') ?? null, before_mode: 0o644 });
  const branch = ownsGitRoot(root) ? git(root, ['branch', '--show-current'], false) : null, targetBranch = config.instance_branch ?? 'main';
  const instanceGit = planInstanceGit(root, branch, targetBranch);
  const result = { initialized: true, changed: false, dryRun, resumed: false, core: receipt.core, version: receipt.version,
    branch: targetBranch, previousBranch: branch, createdBranch: instanceGit?.created ?? false,
    pushTarget: instanceGit ? 'origin/main' : null, files: files.map(file => file.path), preserved };
  if (dryRun) return { ...result, wouldChange: true };
  return applyInitialization(root, result, files, instanceGit, fault);
}
function applyInitialization(root, result, files, instanceGit, fault) {
  const state = { schema_version: 3, branchBefore: result.previousBranch, branchAfter: result.branch, git: instanceGit,
    files: files.map(({ bytes, ...file }) => ({ ...file, after_sha256: sha256(bytes) })) };
  const transaction = checkedPath(root, stateFile);
  mkdirSync(join(root, '.agents/runtime-data/instance-initialization'), { recursive: true });
  let descriptor;
  try { descriptor = openSync(transaction, 'wx', 0o600); writeFileSync(descriptor, stableJSON(state)); }
  catch (error) { if (error.code === 'EEXIST') fail('INSTANCE_INITIALIZATION_BUSY', 'Another initialization transaction exists; preserve it and retry.'); throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  try {
    applyInstanceGit(root, instanceGit); fault?.('git:branch');
    for (const file of files) {
      const actual = readRegular(root, file.path, true), expected = file.before === null ? null : Buffer.from(file.before, 'base64');
      if (actual === null ? expected !== null : expected === null || !actual.equals(expected)) fail('INSTANCE_INPUT_CHANGED', `File changed during initialization: ${file.path}.`);
      writeAtomic(checkedPath(root, file.path), file.bytes, 0o644); fault?.(file.path); }
    rmSync(checkedPath(root, stateFile));
    return { ...result, changed: true };
  } catch (error) { recoverInitialization(root); throw error; }
}

export async function initializeInstance(options) {
  if (options.dryRun) return initializeInstanceOperation(options);
  const release = await acquireServiceLock(join(options.root, '.agents/runtime-data/instance-initialization/lock'));
  try { return await initializeInstanceOperation(options); }
  finally { await release(); }
}
