import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildManifest } from '../services/build-manifest.js';
import { configuration } from './configuration.js';
import { fail } from './errors.js';
import { sha256, stableJSON } from '../shared/hash.js';
import { checkedPath, readRegular, walkFiles, fileMode, writeAtomic, parseJSON } from './files.js';
import { validateManifest, releaseReceipt } from './manifests.js';
import { versionParts } from './versions.js';
import { createArchive, readArchive } from './archive.js';
import { types } from '../objects/schema.js';
import { products, artifactName, releaseIndexName, legacyReleaseIndexName, compatibilityIndex, launcherFiles, launcherProtocol } from './products.js';
import { userDataRoot } from '../user-data/schema.js';
import { committedSource } from './committed-source.js';
import { gitBlobID, baselinePath } from './baseline.js';
import { developmentPath } from './paths.js';
import { gitExecutable } from '../platform/index.js';

export const userDirectories = ['项目', '知识', ...Object.values(types).map(type => type.user), '@收件箱', '档案', '档案/个人', '档案/企业', '档案/项目', userDataRoot];
// Explicit instance seed allowlist: never discover or package personal content.
export const knowledgeFrameworkFiles = [
  '知识/rules/README.md', '知识/rules/认知.md',
  '知识/rules/templates/cognition/cognition.md',
  '知识/rules/templates/cognition/3认知/认知说明.md',
  ...['1理论与模型/科学类比', '1理论与模型/提炼模型', '2事实与案例/定性定量', '2事实与案例/假设驱动']
    .map(path => `知识/rules/templates/cognition/${path}/.gitkeep`),
];
export const workspaceDocuments = ['知识/knowledge.md', '档案/archive.md', 'USER.md', 'BOT.md', '.agents/user-data/incubation.json', ...knowledgeFrameworkFiles];
function revisionInfo(root, allowDirty) {
  const git = args => spawnSync(gitExecutable, ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const rev = git(['rev-parse', '--verify', 'HEAD']);
  if (rev.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(rev.stdout)) fail('RELEASE_SOURCE_INVALID', 'Build a release from the Core source repository with an existing commit.');
  const state = git(['status', '--porcelain', '--untracked-files=all', '--', '.agents', 'AGENTS.md', '.gitignore', '.github', 'README.md', ':(exclude).agents/core/manifest.yaml']);
  if (state.status !== 0) fail('RELEASE_SOURCE_INVALID', 'Cannot inspect the Core source state.');
  const dirty = state.stdout.length > 0;
  if (dirty && !allowDirty) fail('RELEASE_SOURCE_DIRTY', 'Commit Core changes before building an official release; --allow-dirty creates a local development package.');
  const time = git(['show', '-s', '--format=%cI', 'HEAD']);
  if (time.status !== 0 || !Number.isFinite(Date.parse(time.stdout.trim()))) fail('RELEASE_SOURCE_INVALID', 'Cannot read the Core commit timestamp.');
  return { revision: rev.stdout.trim(), dirty, builtAt: new Date(time.stdout.trim()).toISOString() };
}
function excluded(path) {
  return developmentPath(path) || path === '.agents/core/release.json' || /(?:^|\/)\.DS_Store$/.test(path) ||
    /^\.agents\/core\/\.manifest\.yaml\..*\.tmp$/.test(path);
}
export function inspectCoreArchive(bytes, { expectedVersion, expectedPlatform, expectedRepository } = {}) {
  const entries = readArchive(bytes), metadata = entries.get('.agents/core/release.json');
  if (!metadata) fail('RELEASE_INVALID', 'Core archive has no release manifest.');
  const manifest = validateManifest(parseJSON(metadata.bytes, 'Core manifest'));
  if (!manifest.files) fail('RELEASE_INVALID', 'An update archive requires its verified file inventory.');
  if ((expectedVersion && manifest.version !== expectedVersion) || (expectedPlatform && manifest.platform !== expectedPlatform) ||
      (expectedRepository && manifest.core.repository !== expectedRepository)) fail('RELEASE_INVALID', 'Core archive identity does not match its release index.');
  if (entries.size !== Object.keys(manifest.files).length + 1) fail('RELEASE_INVALID', 'Archive and managed inventory differ.');
  for (const [path, record] of Object.entries(manifest.files)) {
    const file = entries.get(path);
    if (!file || file.mode !== record.mode || sha256(file.bytes) !== record.sha256) fail('RELEASE_INVALID', `Core file checksum or mode mismatch: ${path}.`);
  }
  return { entries, manifest };
}
async function buildPlatformRelease({ root, output, platform, allowDirty = false, dryRun = false }) {
  const config = configuration(root), build = parseJSON(readRegular(root, '.agents/core/build.json'), 'build.json');
  versionParts(build.version);
  if (!build.runtime?.packages?.[platform]) fail('PLATFORM_UNSUPPORTED', `No bundled runtime for ${platform}.`);
  if (!allowDirty) {
    const branch = spawnSync(gitExecutable, ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' });
    const stable = branch.stdout?.trim() === config.core_branch || ['', null].includes(branch.stdout?.trim()) &&
      ['refs/heads/', 'refs/remotes/origin/'].some(prefix => spawnSync(gitExecutable, ['-C', root, 'merge-base', '--is-ancestor', 'HEAD', prefix + config.core_branch]).status === 0);
    if (branch.status !== 0 || !stable) fail('RELEASE_BRANCH_INVALID', 'Official builds require the stable Core branch or its verified detached commit.');
  }
  const source = revisionInfo(root, allowDirty), paths = [...walkFiles(root, '.agents/core', { exclude: excluded }), ...launcherFiles].sort();
  const committed = source.dirty ? null : committedSource(root);
  const destination = resolve(root, output ?? `.agents/runtime-data/releases/${build.version}-${platform}`);
  const targetRoot = join(destination, products.instance);
  if (existsSync(destination)) fail('OUTPUT_EXISTS', 'Release output already exists; choose a new output directory.');
  const staging = mkdtempSync(join(tmpdir(), 'ksf-release-'));
  try {
    // Only explicit system files are read. User directories are never scanned.
    const sourceHashes = new Map(), sourceModes = new Map();
    for (const path of [...paths, 'AGENTS.md']) {
      const original = committed?.entries.get(path);
      const bytes = readRegular(root, path), mode = fileMode(checkedPath(root, path), original?.mode === '100755' ? 0o755 : original?.mode === '100644' ? 0o644 : undefined);
      sourceModes.set(path, mode);
      if (committed && path !== '.agents/core/manifest.yaml' && (!original || original.type !== 'blob' ||
          original.mode !== (mode === 0o755 ? '100755' : '100644') || gitBlobID(bytes) !== original.object)) source.dirty = true;
      sourceHashes.set(path, sha256(bytes));
      writeAtomic(checkedPath(staging, path), bytes, mode);
    }
    if (committed) {
      const expected = [...committed.entries.keys()].filter(path => baselinePath(path) && !excluded(path) && path !== '.agents/core/manifest.yaml').sort();
      const actual = [...paths, 'AGENTS.md'].filter(path => path !== '.agents/core/manifest.yaml').sort();
      if (expected.join('\n') !== actual.join('\n')) source.dirty = true;
      if (source.dirty && !allowDirty) fail('RELEASE_SOURCE_DIRTY', 'System files must exactly match the recorded Core commit; ignored or uncommitted files cannot enter an official release.');
    }
    await buildManifest(staging, { sourceRoot: root, builtAt: source.builtAt });
    const inventory = {}, coreEntries = [];
    for (const path of [...paths.filter(p => p !== '.agents/core/manifest.yaml'), '.agents/core/manifest.yaml', 'AGENTS.md'].sort()) {
      const bytes = readRegular(staging, path), mode = fileMode(checkedPath(staging, path), sourceModes.get(path));
      inventory[path] = { sha256: sha256(bytes), mode, source_path: path };
      coreEntries.push({ path, bytes, mode });
    }
    const manifest = validateManifest({ schema_version: 3, launcher_protocol: launcherProtocol, name: products.core, product: products.core, version: build.version, platform,
      core: { repository: config.core_repository, branch: config.core_branch, revision: source.revision },
      development: source.dirty, instance_initialization: 1, files: inventory });
    coreEntries.push({ path: '.agents/core/release.json', bytes: Buffer.from(stableJSON(manifest)), mode: 0o644 });
    const coreArchive = createArchive(coreEntries);
    inspectCoreArchive(coreArchive, { expectedVersion: build.version, expectedPlatform: platform, expectedRepository: config.core_repository });
    const extras = [];
    for (const file of ['README.md', '.gitignore', '.gitattributes', ...workspaceDocuments]) extras.push({ path: file, bytes: readRegular(root, `.agents/core/distribution/template/${file}`), mode: 0o644 });
    for (const directory of userDirectories) extras.push({ path: `${directory}/.gitkeep`, bytes: Buffer.alloc(0), mode: 0o644 });
    const receipt = Buffer.from(stableJSON(releaseReceipt(manifest)));
    const fullEntries = [...coreEntries.map(entry => entry.path === '.agents/core/release.json' ? { ...entry, bytes: receipt } : entry), ...extras];
    const coreName = artifactName('core', build.version, platform);
    const base = `https://github.com/${config.core_repository}/releases/download/v${build.version}/`;
    const artifact = (name, bytes) => ({ name, url: base + name, sha256: sha256(bytes), size: bytes.length });
    const index = { schema_version: 2, products, version: build.version, core_repository: config.core_repository,
      core_revision: source.revision, development: source.dirty, platforms: { [platform]: {
        core: artifact(coreName, coreArchive),
      } } };
    const current = revisionInfo(root, true);
    if (current.revision !== source.revision || [...sourceHashes].some(([p, hash]) => sha256(readRegular(root, p)) !== hash) ||
        paths.join('\n') !== [...walkFiles(root, '.agents/core', { exclude: excluded }), ...launcherFiles].sort().join('\n')) fail('RELEASE_INPUT_CHANGED', 'Core changed while building the release.');
    const result = { version: build.version, platform, development: source.dirty, coreRevision: source.revision,
      products, output: destination, instance: targetRoot, template: targetRoot, index, sourceDigest: sha256(stableJSON(inventory)), managedFiles: Object.keys(inventory).length, dryRun };
    if (!dryRun) {
      mkdirSync(destination, { recursive: true });
      for (const entry of fullEntries) writeAtomic(checkedPath(targetRoot, entry.path), entry.bytes, entry.mode);
      writeAtomic(join(destination, coreName), coreArchive);
      writeAtomic(join(destination, releaseIndexName), stableJSON(index));
      writeAtomic(join(destination, legacyReleaseIndexName), stableJSON(compatibilityIndex(index)));
    }
    return result;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

// The official feed must contain every declared platform. A Mac publisher can
// build a Windows archive without executing the Windows runtime.
export async function buildRelease(options) {
  const { root, output, platform, dryRun = false } = options;
  const build = parseJSON(readRegular(root, '.agents/core/build.json'), 'build.json');
  const targets = platform ? [platform] : Object.keys(build.runtime?.packages ?? {}).sort();
  if (!targets.length) fail('PLATFORM_UNSUPPORTED', 'No bundled release platforms are declared.');
  if (targets.length === 1) return buildPlatformRelease({ ...options, platform: targets[0] });
  const destination = resolve(root, output ?? `.agents/runtime-data/releases/${build.version}`);
  if (existsSync(destination)) fail('OUTPUT_EXISTS', 'Release output already exists; choose a new output directory.');
  const staging = mkdtempSync(join(tmpdir(), 'ksf-platform-releases-'));
  try {
    const results = [];
    for (const target of targets) results.push(await buildPlatformRelease({ ...options, platform: target, output: join(staging, target) }));
    const first = results[0];
    if (results.some(result => result.version !== first.version || result.coreRevision !== first.coreRevision || result.sourceDigest !== first.sourceDigest || result.development !== first.development)) fail('RELEASE_INPUT_CHANGED', 'All platform packages must come from the same frozen system source.');
    const index = { ...first.index, platforms: Object.assign({}, ...results.map(result => result.index.platforms)) };
    const native = results.find(result => result.platform === `${process.platform}-${process.arch}`) ?? first;
    const instance = join(destination, products.instance);
    if (!dryRun) {
      mkdirSync(destination, { recursive: true });
      for (const result of results) {
        const item = result.index.platforms[result.platform].core;
        renameSync(join(result.output, item.name), join(destination, item.name));
      }
      renameSync(native.instance, instance);
      writeAtomic(join(destination, releaseIndexName), stableJSON(index));
      writeAtomic(join(destination, legacyReleaseIndexName), stableJSON(compatibilityIndex(index)));
    }
    return { ...first, platform: null, platforms: targets, output: destination, instance, template: instance, index, dryRun };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
