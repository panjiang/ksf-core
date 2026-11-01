import { gitExecutable } from '../platform/index.js';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import { managedPath, validRelative } from './paths.js';
import { parseJSON } from './files.js';
import { sha256 } from '../shared/hash.js';
import { validateContributionManifest } from './manifests.js';

const gitBinary = gitExecutable;
export const gitEnvironment = () => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE', 'GIT_NAMESPACE']) delete env[name];
  return env;
};
export const isLocalCommit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export const contributionPath = path => (managedPath(path) || path === '.agents/bin/ksf') &&
  path !== '.agents/core/manifest.yaml' && !/\.tmp$/.test(path);

// Git plumbing reads immutable objects, never the index, filters or working files.
export function committedSource(root, { commit, binary = gitBinary } = {}) {
  const run = (args, options = {}) => {
    const result = spawnSync(binary, ['--no-replace-objects', '--literal-pathspecs', '-C', root, ...args], {
      env: gitEnvironment(), timeout: 30000, maxBuffer: 256 * 1024 * 1024, ...options,
    });
    if (result.error?.code === 'ENOENT') fail('CONTRIBUTION_GIT_REQUIRED', 'Git is required to contribute already committed system changes.');
    if (result.error) fail('CONTRIBUTION_GIT_FAILED', 'Could not read the local Git objects.');
    return result;
  };
  const top = run(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) fail('CONTRIBUTION_GIT_REQUIRED', 'Use a Git repository at the KSF root and commit the intended system changes first.');
  // Native resolution expands Windows 8.3 aliases, as Git and PowerShell do.
  const gitRoot = realpathSync.native(top.stdout.toString('utf8').replace(/\r?\n$/, ''));
  const selectedRoot = realpathSync.native(root);
  if (gitRoot !== selectedRoot) {
    fail('CONTRIBUTION_GIT_ROOT_MISMATCH', 'The KSF root must be the Git working-tree root.', { gitRoot, selectedRoot });
  }
  const head = run(['rev-parse', '--verify', 'HEAD^{commit}']);
  const headCommit = head.stdout.toString('utf8').trim();
  if (head.status !== 0 || !isLocalCommit(headCommit)) fail('CONTRIBUTION_HEAD_REQUIRED', 'The KSF repository has no readable HEAD commit.');
  if (commit !== undefined && !isLocalCommit(commit)) fail('CONTRIBUTION_INVALID', 'Invalid local contribution commit.');
  const sourceCommit = commit ?? headCommit;
  const listing = run(['ls-tree', '-r', '-z', sourceCommit, '--', 'AGENTS.md', '.agents/core', '.agents/bin/ksf', '.agents/ksf', '.agents/ksf.ps1']);
  if (listing.status !== 0) fail('CONTRIBUTION_SOURCE_MISSING', 'The recorded local contribution commit is unavailable.');
  const entries = new Map();
  for (const row of listing.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t'), [mode, type, object] = row.slice(0, tab).split(' '), path = row.slice(tab + 1);
    if (tab < 0 || !validRelative(path) || !isLocalCommit(object) || entries.has(path)) {
      fail('CONTRIBUTION_FILE_TYPE', 'The committed system tree contains an unsupported path or object.');
    }
    entries.set(path, { mode, type, object });
  }
  const read = path => {
    const entry = entries.get(path);
    if (!entry) return null;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      fail('CONTRIBUTION_FILE_TYPE', `Only regular committed system files may be contributed: ${path}.`);
    }
    const result = run(['cat-file', 'blob', entry.object]);
    if (result.status !== 0) fail('CONTRIBUTION_SOURCE_MISSING', 'Could not read a recorded system blob.');
    return { bytes: result.stdout, mode: entry.mode === '100755' ? 0o755 : 0o644 };
  };
  // One size query and bounded batches instead of one Git process per file.
  // Read only OIDs from the already pinned tree, never working files or filters.
  function* readBatches(paths) {
    const unique = [...new Set(paths)], present = unique.filter(path => entries.has(path));
    for (const path of present) { const e = entries.get(path); if (e.type !== 'blob' || !['100644', '100755'].includes(e.mode)) fail('CONTRIBUTION_FILE_TYPE', `Only regular committed system files may be contributed: ${path}.`); }
    const sizes = new Map();
    if (present.length) {
      const checked = run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: present.map(path => entries.get(path).object).join('\n') + '\n' });
      const rows = checked.stdout?.toString('utf8').trim().split('\n') ?? [];
      if (checked.status !== 0 || rows.length !== present.length) fail('CONTRIBUTION_SOURCE_MISSING', 'Could not inspect the recorded system blobs.');
      rows.forEach((row, index) => {
        const [oid, type, size] = row.split(' '), expected = entries.get(present[index]).object;
        if (oid !== expected || type !== 'blob' || !/^\d+$/.test(size) || +size > 256 * 1024 * 1024) fail('CONTRIBUTION_SOURCE_MISSING', 'Invalid or oversized recorded system blob.');
        sizes.set(present[index], +size);
      });
    }
    let batch = [], size = 0;
    const flush = function* () {
      if (!batch.length) return;
      const selected = batch.filter(path => entries.has(path)), files = new Map();
      if (selected.length) {
        const result = run(['cat-file', '--batch'], { input: selected.map(path => entries.get(path).object).join('\n') + '\n', maxBuffer: Math.max(1024, size + selected.length * 160) });
        if (result.status !== 0) fail('CONTRIBUTION_SOURCE_MISSING', 'Could not read a recorded system batch.');
        let offset = 0;
        for (const path of selected) {
          const entry = entries.get(path), end = result.stdout.indexOf(10, offset), header = result.stdout.subarray(offset, end).toString('utf8').split(' '), length = sizes.get(path);
          if (end < offset || header[0] !== entry.object || header[1] !== 'blob' || header[2] !== String(length)) fail('CONTRIBUTION_SOURCE_MISSING', 'Malformed recorded system batch.');
          const bytes = result.stdout.subarray(end + 1, end + 1 + length);
          const oid = createHash(entry.object.length === 64 ? 'sha256' : 'sha1').update(Buffer.from(`blob ${length}\0`)).update(bytes).digest('hex');
          if (bytes.length !== length || result.stdout[end + 1 + length] !== 10 || oid !== entry.object) fail('CONTRIBUTION_SOURCE_MISSING', 'Recorded blob identity does not match the pinned tree.');
          files.set(path, { bytes, mode: entry.mode === '100755' ? 0o755 : 0o644 }); offset = end + length + 2;
        }
        if (offset !== result.stdout.length) fail('CONTRIBUTION_SOURCE_MISSING', 'Unexpected data after the recorded system batch.');
      }
      yield batch.map(path => [path, files.get(path) ?? null]); batch = []; size = 0;
    };
    for (const path of unique) {
      const bytes = sizes.get(path) ?? 0;
      if (batch.length && (size + bytes > 8 * 1024 * 1024 || batch.length >= 128)) yield* flush();
      batch.push(path); size += bytes;
    }
    yield* flush();
  }
  return { sourceCommit, headCommit, entries, read, readBatches };
}

export function contributionBaseline(source) {
  const file = source.read('.agents/core/release.json');
  if (!file) fail('CONTRIBUTION_BASELINE_MISSING', 'HEAD has no release manifest; commit a verified installed release baseline before contributing.');
  let manifest;
  try { manifest = validateContributionManifest(parseJSON(file.bytes, 'committed Core release manifest')); }
  catch { fail('CONTRIBUTION_BASELINE_INVALID', 'The release baseline stored in the local commit is invalid.'); }
  if (manifest.development) fail('DEVELOPMENT_PACKAGE', 'HEAD contains a development-package baseline; a verified original Core baseline is required.');
  return { manifest, baseline: { schema_version: manifest.schema_version, manifest_sha256: sha256(file.bytes) } };
}
