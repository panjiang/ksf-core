// Product identities are shared by build metadata, release artifacts and publishing.
// A user's instance directory/repository may use any name; it is not a release product.
export const products = Object.freeze({ core: 'ksf-core', instance: 'ksf' });
// Read-only compatibility for release indexes published before the single-Core model.
export const legacyProducts = Object.freeze({ core: 'ksf-core', workspace: 'ksf-workspace', instance: 'ksf' });
export const launcherFiles = Object.freeze(['.agents/ksf', '.agents/ksf.ps1']);
export const rootFiles = Object.freeze(['AGENTS.md', ...launcherFiles]);
export const launcherProtocol = 1;
export const releaseIndexName = 'ksf-core-index.json';
export const legacyReleaseIndexName = 'ksf-core-release.json';
export const compatibilityIndex = index => ({ ...index, schema_version: 1, products: legacyProducts });
export function artifactName(kind, version, platform) {
  return `${products[kind]}-${version}-${platform}.tar.gz`;
}
