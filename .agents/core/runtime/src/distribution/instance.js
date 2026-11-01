import {gitEnvironment} from './committed-source.js';
import {acquireServiceLock} from '../services/service-lock.js';
import { existsSync, mkdirSync, readFileSync, rmSync, openSync, closeSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { configuration } from './configuration.js';
import { installedManifest, releaseReceipt } from './manifests.js';
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
  return result.status === 0 ? result.stdout.trim() : null;
}
function ownsGitRoot(root) {
  const top = git(root, ['rev-parse', '--show-toplevel'], false);
  return top !== null && realpathSync.native(top) === realpathSync.native(root);
}
export function isCoreSource(root, config = configuration(root)) {
  if (!ownsGitRoot(root)) return false;
  const remote = git(root, ['remote', 'get-url', 'origin'], false);
  return remote !== null && [ `git@github.com:${config.core_repository}.git`, `https://github.com/${config.core_repository}.git`, `https://github.com/${config.core_repository}` ].includes(remote);
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
function recoverInitialization(root) {
  const state = readJSON(root, stateFile, true);
  if (!state) return;
  const allowed = new Set(['README.md', '.gitignore', '.gitattributes', ...workspaceDocuments, ...userDirectories.map(path => `${path}/.gitkeep`), '.agents/core/release.json']);
  if (state.schema_version !== 1 || !Array.isArray(state.files) || state.files.some(file => !allowed.has(file.path) || !/^[a-f0-9]{64}$/.test(file.after_sha256) || !(file.before === null || typeof file.before === 'string')) || (state.branchBefore && !isBranch(state.branchBefore)) || state.branchAfter !== 'main') fail('INSTANCE_RECOVERY_INVALID', 'Preserve the incomplete initialization transaction for inspection.');
  // Only restore a file that still has the value this operation wrote.
  for (const file of [...state.files].reverse()) {
    const target = checkedPath(root, file.path), bytes = readRegular(root, file.path, true);
    const before = file.before === null ? null : Buffer.from(file.before, 'base64');
    if ((bytes === null && before === null) || (bytes && before && bytes.equals(before))) continue;
    if (!bytes || sha256(bytes) !== file.after_sha256) fail('INSTANCE_RECOVERY_CONFLICT', `Initialization encountered a concurrent edit: ${file.path}.`);
    if (before === null) rmSync(target); else writeAtomic(target, before, file.before_mode);
  }
  if (state.branchBefore && git(root, ['branch', '--show-current'], false) === state.branchAfter) git(root, ['branch', '-m', state.branchBefore]);
  rmSync(checkedPath(root, stateFile));
}
async function initializeInstanceOperation({ root, revision, dryRun = false, api, fetcher, fault }) {
  if (dryRun && existsSync(checkedPath(root, stateFile))) fail('INSTANCE_RECOVERY_REQUIRED', 'An incomplete initialization requires instance init without --dry-run.');
  recoverInitialization(root);
  const config = configuration(root), current = installedManifest(root, true);
  if (current && !current.instance_initialization) return { initialized: true, changed: false, core: current.core, version: current.version };
  if (current?.development) fail('DEVELOPMENT_PACKAGE', 'Use the local build instance directory for an explicit development trial; a development archive is not an official instance source.');
  if (isCoreSource(root, config)) fail('INSTANCE_CORE_SOURCE', 'The official Core checkout is a source repository; create a private repository from its template first.');
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
  if (branch && branch !== targetBranch && git(root, ['rev-parse', '--verify', `refs/heads/${targetBranch}`], false)) fail('INSTANCE_BRANCH_CONFLICT', 'The personal main branch already exists; select it before initialization.');
  if (branch === '') fail('INSTANCE_BRANCH_INVALID', 'Select a local branch before initializing the instance.');
  const result = { initialized: true, changed: false, dryRun, core: receipt.core, version: receipt.version,
    branch: targetBranch, previousBranch: branch, files: files.map(file => file.path), preserved };
  if (dryRun) return { ...result, wouldChange: true };
  const state = { schema_version: 1, branchBefore: branch, branchAfter: targetBranch,
    files: files.map(({ bytes, ...file }) => ({ ...file, after_sha256: sha256(bytes) })) };
  const transaction = checkedPath(root, stateFile);
  mkdirSync(join(root, '.agents/runtime-data/instance-initialization'), { recursive: true });
  let descriptor;
  try { descriptor = openSync(transaction, 'wx', 0o600); writeFileSync(descriptor, stableJSON(state)); }
  catch (error) { if (error.code === 'EEXIST') fail('INSTANCE_INITIALIZATION_BUSY', 'Another initialization transaction exists; preserve it and retry.'); throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  try {
    if (branch && branch !== targetBranch) git(root, ['branch', '-m', targetBranch]);
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
