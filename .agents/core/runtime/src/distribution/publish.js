import { configuration } from './configuration.js';
import { fail } from './errors.js';
import { parseJSON, readRegular } from './files.js';
import { sha256, stableJSON } from '../shared/hash.js';
import { validateProducts } from './manifests.js';
import { inspectCoreArchive } from './release.js';
import { GitHubAPI } from './github.js';
import { download } from './network.js';
import { products, artifactName, releaseIndexName, legacyReleaseIndexName, compatibilityIndex } from './products.js';
import {releaseTargets} from '../platform/catalog.js';

export function inspectReleaseDirectory(root, directory) {
  const config = configuration(root), bytes = readRegular(directory, releaseIndexName), index = parseJSON(bytes, 'Release index');
  if (index.schema_version !== 2 || index.core_repository !== config.core_repository || index.development !== false || !index.platforms || !Object.keys(index.platforms).length) fail('RELEASE_INVALID', 'Only a clean single-Core release can be published.');
  validateProducts(index.products);
  const artifacts = [];
  let targets;
  for (const [platform, selected] of Object.entries(index.platforms)) {
    if(!releaseTargets.includes(platform))fail('PLATFORM_UNSUPPORTED', `Official release is not supported for ${platform}.`);
    if (Object.keys(selected).length !== 1 || !selected.core) fail('RELEASE_INVALID', 'Only the Core artifact may be published.');
    const descriptor = selected.core;
    if (descriptor.name !== artifactName('core', index.version, platform) || descriptor.url !== `https://github.com/${config.core_repository}/releases/download/v${index.version}/${descriptor.name}`) fail('RELEASE_INVALID', 'Unexpected release asset identity.');
    const data = readRegular(directory, descriptor.name);
    if (data.length !== descriptor.size || sha256(data) !== descriptor.sha256) fail('RELEASE_INVALID', `Artifact changed after the build: ${descriptor.name}.`);
    const core = inspectCoreArchive(data, { expectedVersion: index.version, expectedPlatform: platform, expectedRepository: config.core_repository });
    const declared = Object.keys(parseJSON(core.entries.get('.agents/core/build.json').bytes, 'frozen build.json').runtime?.packages ?? {}).filter(target=>releaseTargets.includes(target)).sort();
    if (targets && targets.join('\n') !== declared.join('\n')) fail('RELEASE_INVALID', 'Platform packages declare different frozen targets.');
    targets = declared;
    if (core.manifest.core.revision !== index.core_revision || core.manifest.core.branch !== config.core_branch || core.manifest.development) fail('RELEASE_INVALID', 'Artifact source differs from the configured stable Core line.');
    artifacts.push({ ...descriptor, bytes: data });
  }
  if (!targets?.length || targets.join('\n') !== Object.keys(index.platforms).sort().join('\n')) fail('RELEASE_PLATFORM_MISSING', 'Publishing requires every platform declared by the frozen Core source.');
  artifacts.push({ name: releaseIndexName, bytes, sha256: sha256(bytes), size: bytes.length });
  const bridge = readRegular(directory, legacyReleaseIndexName);
  if (!bridge.equals(Buffer.from(stableJSON(compatibilityIndex(index))))) fail('RELEASE_INVALID', 'The legacy client bridge must describe the exact same Core assets.');
  artifacts.push({ name: legacyReleaseIndexName, bytes: bridge, sha256: sha256(bridge), size: bridge.length });
  return { config, index, artifacts };
}

export async function publishRelease({ root, directory, dryRun = false, api }) {
  const bundle = inspectReleaseDirectory(root, directory), { config, index, artifacts } = bundle;
  if (dryRun) return { dryRun, products, repository: config.core_repository, branch: config.core_branch,
    version: index.version, revision: index.core_revision, assets: artifacts.map(({ bytes, ...asset }) => asset), wouldPublish: true };
  const github = api ?? new GitHubAPI(), repository = config.core_repository, tag = `v${index.version}`;
  const source = await github.request('GET', `/repos/${repository}/git/commits/${index.core_revision}`);
  if (source.sha !== index.core_revision) fail('RELEASE_SOURCE_INVALID', 'The release Core commit is not available upstream.');
  const stable = await github.request('GET', `/repos/${repository}/git/ref/heads/${encodeURIComponent(config.core_branch)}`);
  if (!/^[a-f0-9]{40}$/.test(stable.object?.sha)) fail('RELEASE_SOURCE_INVALID', 'The stable Core branch is unavailable.');
  if (stable.object.sha !== index.core_revision) {
    const ancestry = await github.request('GET', `/repos/${repository}/compare/${index.core_revision}...${stable.object.sha}`);
    if (ancestry.base_commit?.sha !== index.core_revision || ancestry.merge_base_commit?.sha !== index.core_revision || !['ahead', 'identical'].includes(ancestry.status)) fail('RELEASE_SOURCE_INVALID', 'The release commit is not on the stable Core line.');
  }
  let ref = await github.request('GET', `/repos/${repository}/git/ref/tags/${tag}`, undefined, { optional: true });
  if (ref) {
    let object = ref.object;
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = (await github.request('GET', `/repos/${repository}/git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || object.sha !== index.core_revision) fail('RELEASE_TAG_CONFLICT', 'The release tag already points at another commit.');
  } else await github.request('POST', `/repos/${repository}/git/refs`, { ref: `refs/tags/${tag}`, sha: index.core_revision });
  let release = await github.request('GET', `/repos/${repository}/releases/tags/${tag}`, undefined, { optional: true });
  if (!release) release = await github.request('POST', `/repos/${repository}/releases`, { tag_name: tag, target_commitish: index.core_revision,
    name: `${products.core} ${index.version}`, body: 'KSF Core 系统更新包及版本索引。新用户直接从 Core 模板创建私有实例，个人数据在 main 分支维护。',
    draft: true, prerelease: index.version.includes('-') });
  for (const artifact of artifacts) {
    const matching = release.assets?.filter(a => a.name === artifact.name) ?? [];
    if (matching.length > 1) fail('RELEASE_ASSET_CONFLICT', 'A release contains duplicate asset names.');
    if (matching.length) {
      const asset = matching[0];
      let matches = asset.size === artifact.size && asset.digest === `sha256:${artifact.sha256}`;
      if (!matches && !release.draft && asset.browser_download_url) {
        const remote = await download(asset.browser_download_url);
        matches = remote.bytes.length === artifact.size && sha256(remote.bytes) === artifact.sha256;
      }
      if (!matches) fail('RELEASE_ASSET_CONFLICT', `Existing asset differs from the verified local build: ${artifact.name}.`);
    } else {
      if (!release.draft) fail('RELEASE_IMMUTABLE', 'A published release is incomplete; publish a new version instead of mutating it.');
      await github.request('POST', `/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(artifact.name)}`, artifact.bytes, { binary: true, upload: true });
    }
  }
  if (release.draft) release = await github.request('PATCH', `/repos/${repository}/releases/${release.id}`, { draft: false });
  return { products, version: index.version, repository, url: release.html_url, assets: artifacts.map(a => a.name), published: true };
}
