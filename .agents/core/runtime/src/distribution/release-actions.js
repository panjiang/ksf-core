import {supportedTargets} from '../platform/catalog.js';
// Internal Actions bridge. Public maintenance commands remain release build/publish.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration } from './configuration.js';
import { compareVersions, versionParts } from './versions.js';
import { fail } from './errors.js';
import { isRevision } from './git-values.js';
import { parseJSON, readRegular, writeAtomic } from './files.js';
import { sha256, stableJSON } from '../shared/hash.js';
import { GitHubAPI } from './github.js';
import { inspectReleaseDirectory } from './publish.js';
import { artifactName, releaseIndexName, legacyReleaseIndexName } from './products.js';
import { download } from './network.js';
import { validateIndex } from './system.js';

export function inspectHandoff({ root, directory, revision, indexHash }) {
  const bundle = inspectReleaseDirectory(root, directory);
  if ((revision && bundle.index.core_revision !== revision) || !isRevision(bundle.index.core_revision)) fail('RELEASE_SOURCE_INVALID', 'The handoff differs from its frozen Core commit.');
  const hash = sha256(readRegular(directory, releaseIndexName));
  if (indexHash && hash !== indexHash) fail('RELEASE_INPUT_CHANGED', 'The handoff index differs from the prepared artifact.');
  return { version: bundle.index.version, revision: bundle.index.core_revision, tag: `v${bundle.index.version}`, index_sha256: hash };
}

export async function corePreflight({ root, api = new GitHubAPI({ readOnly: true }) }) {
  const config = configuration(root), repository = await api.request('GET', `/repos/${config.core_repository}`);
  if (repository.full_name !== config.core_repository || repository.is_template !== true || repository.default_branch !== config.core_branch) fail('CORE_REPOSITORY_INVALID', 'The Core repository must be a template with the configured stable default branch.');
  return { repository: config.core_repository, branch: config.core_branch, template: true };
}

async function tagRevision(api, repository, tag) {
  const ref = await api.request('GET', `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await api.request('GET', `/repos/${repository}/git/tags/${object.sha}`)).object;
  if (object?.type !== 'commit' || !isRevision(object.sha)) fail('RELEASE_TAG_CONFLICT', 'The requested release tag does not resolve to a Core commit.');
  return object.sha;
}

export async function recoverPublishedBundle({ root, directory, tag, api = new GitHubAPI(), fetcher }) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) fail('RELEASE_TAG_INVALID', 'Recovery requires an explicit v<version> release_tag.');
  versionParts(tag.slice(1));
  if (existsSync(directory)) fail('OUTPUT_EXISTS', 'Recovery requires a new output directory.');
  const config = configuration(root), repository = config.core_repository;
  const release = await api.request('GET', `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  if (release.draft !== false || release.tag_name !== tag) fail('RELEASE_INVALID', 'Recovery requires the exact, already published Release.');
  const revision = await tagRevision(api, repository, tag);
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const asset = name => {
    const matches = release.assets?.filter(item => item.name === name) ?? [];
    if (matches.length !== 1 || matches[0].browser_download_url !== base + name) fail('RELEASE_INVALID', `Missing, duplicated or unpinned Release asset: ${name}.`);
    return matches[0];
  };
  const fetchAsset = async (name, limit = 256 * 1024 * 1024) => {
    const descriptor = asset(name), result = await download(descriptor.browser_download_url, { fetcher, limit, timeout: 120000 });
    if (descriptor.size !== result.bytes.length || (descriptor.digest && descriptor.digest !== `sha256:${sha256(result.bytes)}`)) fail('CHECKSUM_MISMATCH', `Published asset differs from its metadata: ${name}.`);
    return result.bytes;
  };
  const indexBytes = await fetchAsset(releaseIndexName, 8 * 1024 * 1024), index = parseJSON(indexBytes, 'published release index');
  if (index.version !== tag.slice(1) || index.core_revision !== revision || index.development !== false) fail('RELEASE_TAG_CONFLICT', 'Release index, tag and Core source must identify exactly the same release.');
  const selected = Object.entries(index.platforms ?? {});
  if (!selected.length) fail('RELEASE_INVALID', 'The release index has no platforms.');
  // Validate all names, paths and identities before downloading any large artifact.
  const descriptors = [];
  for (const [platform, entries] of selected) {
    if (!supportedTargets.includes(platform)) fail('PLATFORM_UNSUPPORTED', 'Unsupported recovery platform.');
    validateIndex(index, { platform, core: { repository } });
    for (const kind of ['core']) {
      const item = entries[kind], name = artifactName(kind, index.version, platform);
      if (!item || item.name !== name || item.url !== base + name || asset(name).size !== item.size) fail('RELEASE_INVALID', 'Recovery asset identity differs from its pinned index.');
      descriptors.push(item);
    }
  }
  const bridge = await fetchAsset(legacyReleaseIndexName, 8 * 1024 * 1024);
  const files = [[releaseIndexName, indexBytes], [legacyReleaseIndexName, bridge]];
  for (const item of descriptors) {
    const bytes = await fetchAsset(item.name);
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) fail('CHECKSUM_MISMATCH', 'Recovery artifact failed index verification.');
    files.push([item.name, bytes]);
  }
  mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files) writeAtomic(resolve(directory, name), bytes);
  inspectReleaseDirectory(root, directory);
  // Detect tag movement during recovery without changing the published Release.
  if (await tagRevision(api, repository, tag) !== revision) fail('RELEASE_TAG_CONFLICT', 'The release tag changed during recovery.');
  return inspectHandoff({ root, directory, revision });
}

export function reportPublication({ root, phase, directory, result, revision, indexHash }) {
  const identity = inspectHandoff({ root, directory, revision, indexHash }), config = configuration(root);
  if (phase !== 'core' || !result.ok || result.data?.version !== identity.version || result.data.published !== true || result.data.repository !== config.core_repository) fail('RELEASE_VERIFY_FAILED', 'The publishing command did not confirm the frozen Core release.');
  return { phase, ...identity, repository: config.core_repository,
    url: `https://github.com/${config.core_repository}/releases/tag/${identity.tag}`, published: true };
}

async function main() {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url)), command = process.argv[2];
  const directory = process.env.KSF_RELEASE_DIRECTORY;
  let result;
  if (command === 'preflight') result = await corePreflight({ root });
  else if (command === 'recover') result = await recoverPublishedBundle({ root, directory, tag: process.env.KSF_RELEASE_TAG });
  else if (command === 'inspect') result = inspectHandoff({ root, directory, revision: process.env.KSF_EXPECTED_REVISION, indexHash: process.env.KSF_EXPECTED_INDEX });
  else if (command === 'report') result = reportPublication({ root, phase: process.env.KSF_RELEASE_PHASE, directory,
    revision: process.env.KSF_EXPECTED_REVISION, indexHash: process.env.KSF_EXPECTED_INDEX,
    result: parseJSON(readFileSync(process.env.KSF_RELEASE_RESULT), 'publication result') });
  else fail('INVALID_ARGUMENTS', 'Unknown internal release Actions operation.');
  if (process.env.GITHUB_OUTPUT && ['recover', 'inspect'].includes(command)) {
    for (const [key, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### ${command === 'report' ? 'Core Release published' : 'Release ' + command}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\n`);
  process.stdout.write(stableJSON(result));
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ ok: false, code: error.code ?? 'RELEASE_ACTIONS_FAILED', message: error.message }) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Release stage failed: ${error.code ?? 'RELEASE_ACTIONS_FAILED'}. Inspect the Core release result before retrying.\n`);
    process.exitCode = 1;
  });
}
