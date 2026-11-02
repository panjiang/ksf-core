// Distribution identities are portable. Native filenames stay at this boundary.
export const releaseTargets = Object.freeze(['darwin-arm64', 'darwin-x64', 'win32-x64']);
export const supportedTargets = Object.freeze([...releaseTargets, 'linux-x64']);

export function runtimePackage(target, version) {
  if (!supportedTargets.includes(target)) throw Object.assign(new Error(`Unsupported runtime target: ${target}`), { code: 'PLATFORM_UNSUPPORTED' });
  const windows = target === 'win32-x64';
  const archiveRoot = `node-v${version}-${windows ? 'win-x64' : target}`;
  const filename = archiveRoot + (windows ? '.zip' : '.tar.gz');
  return { target, archiveRoot, filename, format: windows ? 'zip' : 'tar.gz',
    nodeMember: `${archiveRoot}/${windows ? 'node.exe' : 'bin/node'}`,
    licenseMember: `${archiveRoot}/LICENSE`, executable: windows ? 'node.exe' : 'bin/node',
    distributionURL: `https://nodejs.org/dist/v${version}/${filename}` };
}
