import {repositoryExports} from './repository-exports.js';
import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import { isRevision } from './git-values.js';
import { managedPath, validRelative } from './paths.js';
import { sha256 } from '../shared/hash.js';
import { validateContributionManifest } from './manifests.js';
import { GitHubAPI } from './github.js';
import { download } from './network.js';

export const gitBlobID = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
export const baselinePath = path => managedPath(path) || path === '.agents/bin/ksf';
export const matchesBaseline = (file, record) => file === null ? record === null : record !== null &&
  file.mode === record.mode && (record.git_blob ? gitBlobID(file.bytes) === record.git_blob : sha256(file.bytes) === record.sha256);

// Only exact immutable Git objects are read. No main/latest lookup, local Git
// fallback, persistent snapshot or cache can substitute for the recorded commit.
export async function resolveBaseline(manifest, { api, fetcher } = {}) {
  validateContributionManifest(manifest);
  let github;
  const client = () => github ??= api ?? new GitHubAPI({ readOnly: true, fetcher });
  const repository = manifest.core.repository;
  let files = manifest.files, tree;
  async function originalTree() {
    if (tree) return tree;
    const commit = await client().request('GET', `/repos/${repository}/git/commits/${manifest.core.revision}`);
    if (commit?.sha !== manifest.core.revision || !isRevision(commit.tree?.sha)) fail('BASELINE_UNVERIFIED', 'Could not verify the recorded original Core commit.');
    const response = await client().request('GET', `/repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`);
    if (response?.sha !== commit.tree.sha || response.truncated !== false || !Array.isArray(response.tree)) fail('BASELINE_UNVERIFIED', 'Could not read the complete recorded Core tree.');
    const verified = new Map();
    for (const entry of response.tree) {
      if (!validRelative(entry?.path) || !isRevision(entry.sha) || verified.has(entry.path)) fail('BASELINE_UNVERIFIED', 'Invalid original Core tree entry.');
      verified.set(entry.path, entry);
    }
    tree = verified;
    return tree;
  }
  if (!files) {
    files = Object.create(null);
    for (const [path, entry] of await originalTree()) {
      if (entry.type === 'tree' || !baselinePath(path) || path === '.agents/core/manifest.yaml' || /\.tmp$/.test(path)) continue;
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('BASELINE_UNVERIFIED', `Unsupported original system entry: ${path}.`);
      files[path] = { source_path: path, mode: Number.parseInt(entry.mode, 8) & 0o777, git_blob: entry.sha };
    }
    for (const required of ['AGENTS.md', '.agents/core/build.json', '.agents/core/distribution.json']) {
      if (!Object.hasOwn(files, required)) fail('BASELINE_UNVERIFIED', `Recorded Core source lacks ${required}.`);
    }
    if (!['.agents/ksf', '.agents/bin/ksf'].some(path => files[path]?.mode === 0o755)) fail('BASELINE_UNVERIFIED', 'Recorded Core source has no executable launcher.');
  }
  const read = async path => {
    const record = files[path];
    if (!record) return null;
    if (record.baseline !== undefined) return Buffer.from(record.baseline, 'base64');
    const entry = (await originalTree()).get(record.source_path);
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) ||
        (Number.parseInt(entry.mode, 8) & 0o777) !== record.mode || (record.git_blob && record.git_blob !== entry.sha)) {
      fail('BASELINE_MISMATCH', `Original Core file or permissions differ: ${record.source_path}.`);
    }
    const reader = client();
    let bytes;
    if (reader instanceof GitHubAPI && !reader.token) {
      // Public original files need not consume one anonymous REST request per
      // changed file. Pin raw content to the same commit and verify its blob ID.
      const path = record.source_path.split('/').map(encodeURIComponent).join('/');
      bytes = (await download(`https://raw.githubusercontent.com/${repository}/${manifest.core.revision}/${path}`, { fetcher: reader.fetcher })).bytes;
    } else {
      const blob = await reader.request('GET', `/repos/${repository}/git/blobs/${entry.sha}`);
      if (blob?.encoding !== 'base64' || typeof blob.content !== 'string' || blob.sha !== entry.sha) fail('BASELINE_UNVERIFIED', 'Could not read the recorded original Core blob.');
      bytes = Buffer.from(blob.content, 'base64');
    }
    if (gitBlobID(bytes) !== entry.sha || (record.sha256 && sha256(bytes) !== record.sha256)) fail('BASELINE_MISMATCH', `Original Core content differs: ${record.source_path}.`);
    return bytes;
  };
  const readSource = async path => {
    if (!Object.values(repositoryExports).includes(path)) fail('BASELINE_PATH_INVALID', 'Only explicit Core repository exports can be read.');
    const entry = (await originalTree()).get(path);
    if (!entry) return null;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('BASELINE_UNVERIFIED', 'Invalid Core repository export.');
    const blob = await client().request('GET', `/repos/${repository}/git/blobs/${entry.sha}`);
    const bytes = Buffer.from(blob.content ?? '', 'base64');
    if (blob.encoding !== 'base64' || blob.sha !== entry.sha || gitBlobID(bytes) !== entry.sha) fail('BASELINE_UNVERIFIED', 'Core repository export identity differs.');
    return { bytes, mode: Number.parseInt(entry.mode, 8) & 0o777 };
  };
  return { ...manifest, files, read, readSource };
}
