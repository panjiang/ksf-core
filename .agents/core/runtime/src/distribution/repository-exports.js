// Canonical public repository files live inside Core. A user's root CI and
// README remain personal; contribution previews explicitly project these files
// into the official repository without reading the user's versions.
export const repositoryExports = Object.freeze(Object.fromEntries([
  'README.md', '.gitignore', '.gitattributes', '.github/workflows/check.yml',
  '.github/workflows/verification.yml', '.github/workflows/release.yml',
].map(path => [`.agents/core/distribution/repository/${path}`, path])));
export const projectedPath = (workspacePath, sourcePath) => repositoryExports[workspacePath] === sourcePath;
