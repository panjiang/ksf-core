import { products, legacyProducts, launcherFiles, launcherProtocol } from './products.js';
import { fail } from './errors.js';
import { sha256, isSHA } from '../shared/hash.js';
import { isRevision, isRepository, isBranch } from './git-values.js';
import { managedPath } from './paths.js';
import { textBytes, readJSON } from './files.js';
import { versionParts } from './versions.js';
import { supportedTargets } from '../platform/catalog.js';

export function validateProducts(value, { legacy = false } = {}) {
  const expected = legacy ? legacyProducts : products;
  if (!value || Array.isArray(value) ||
      Object.keys(value).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, name]) => value[key] !== name)) {
    fail('RELEASE_INVALID', 'Invalid release product identities.');
  }
}
function validateReleaseManifest(manifest, legacy) {
  const acceptsPath = path => managedPath(path) || (legacy && path === '.agents/bin/ksf');
  const launchers = legacy ? ['.agents/bin/ksf'] : launcherFiles;
  if (!manifest || manifest.schema_version !== (legacy ? 2 : 3) || (!legacy && manifest.launcher_protocol !== launcherProtocol) || manifest.name !== products.core || manifest.product !== products.core ||
      !isRepository(manifest.core?.repository) || !isRevision(manifest.core?.revision) ||
      !isBranch(manifest.core.branch) || typeof manifest.development !== 'boolean' ||
      !supportedTargets.includes(manifest.platform) || !manifest.files || Array.isArray(manifest.files)) {
    fail('RELEASE_INVALID', 'Invalid Core release manifest.');
  }
  versionParts(manifest.version);
  const entries = Object.entries(manifest.files);
  if (entries.length === 0 || entries.length > 20000) fail('RELEASE_INVALID', 'Invalid managed file count.');
  for (const [path, entry] of entries) {
    if (!acceptsPath(path) || !entry || !isSHA(entry.sha256) || ![0o644, 0o755].includes(entry.mode) || !acceptsPath(entry.source_path)) {
      fail('RELEASE_INVALID', `Invalid managed file: ${path}.`);
    }
    if (entry.baseline !== undefined) {
      if (typeof entry.baseline !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.baseline)) fail('RELEASE_INVALID', `Invalid text baseline: ${path}.`);
      const bytes = Buffer.from(entry.baseline, 'base64');
      if (!textBytes(bytes) || sha256(bytes) !== entry.sha256) fail('RELEASE_INVALID', `Baseline checksum mismatch: ${path}.`);
    }
  }
  const sorted = Object.keys(manifest.files).sort();
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i + 1].startsWith(`${sorted[i]}/`)) fail('RELEASE_INVALID', `File/directory collision: ${sorted[i]}.`);
  }
  for (const required of ['AGENTS.md', ...launchers, '.agents/core/build.json', '.agents/core/data-compatibility.json', '.agents/core/manifest.yaml', '.agents/core/distribution.json']) {
    if (!Object.hasOwn(manifest.files, required)) fail('RELEASE_INVALID', `Required file absent: ${required}.`);
  }
  if (manifest.files[launchers[0]].mode !== 0o755) fail('RELEASE_INVALID', 'Release launcher must be executable.');
  return manifest;
}
export function validateReceipt(manifest) {
  if (!manifest || ![4, 5].includes(manifest.schema_version) || (manifest.schema_version === 5 && manifest.origin !== 'core-template') || manifest.launcher_protocol !== launcherProtocol ||
      manifest.name !== products.core || manifest.product !== products.core ||
      !isRepository(manifest.core?.repository) || !isRevision(manifest.core?.revision) || !isBranch(manifest.core?.branch) ||
      Object.keys(manifest.core).some(key => !['repository', 'branch', 'revision'].includes(key)) ||
      typeof manifest.development !== 'boolean' || !supportedTargets.includes(manifest.platform) ||
      Object.keys(manifest).some(key => !['schema_version', 'launcher_protocol', 'name', 'product', 'version', 'platform', 'core', 'development', ...(manifest.schema_version === 5 ? ['origin'] : [])].includes(key))) {
    fail('RELEASE_INVALID', 'Invalid compact Core release receipt.');
  }
  versionParts(manifest.version);
  return manifest;
}
export function releaseReceipt(manifest) {
  validateContributionManifest(manifest);
  if (manifest.files && Object.entries(manifest.files).some(([path, file]) => path !== file.source_path)) {
    fail('RELEASE_INVALID', 'Compact receipts require identical workspace and Core source paths.');
  }
  return validateReceipt({ schema_version: 4, launcher_protocol: launcherProtocol, name: products.core, product: products.core,
    version: manifest.version, platform: manifest.platform,
    core: { repository: manifest.core.repository, branch: manifest.core.branch, revision: manifest.core.revision },
    development: manifest.development });
}
export function validateManifest(manifest) { return [4, 5].includes(manifest?.schema_version) ? validateReceipt(manifest) : validateReleaseManifest(manifest, false); }
// Compatibility is deliberately limited to reading a committed contribution baseline.
// Installation, upgrade and recovery still require the current launcher protocol.
export function validateContributionManifest(manifest) { return [4, 5].includes(manifest?.schema_version) ? validateReceipt(manifest) : validateReleaseManifest(manifest, manifest?.schema_version === 2); }
export function installedManifest(root, optional = false) {
  const data = readJSON(root, '.agents/core/release.json', optional);
  return data === null ? null : validateManifest(data);
}
