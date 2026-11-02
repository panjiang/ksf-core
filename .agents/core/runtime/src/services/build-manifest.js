import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { products } from '../distribution/products.js';
import { developmentPath } from '../distribution/paths.js';
import { verifyWebBuild } from '../web/assets.js';
import { platform, gitExecutable, replaceFileSync } from '../platform/index.js';
import { supportedTargets, runtimePackage } from '../platform/catalog.js';
import { zipMembers } from '../platform/zip.js';
import { portable } from '../shared/paths.js';
import {installedManifest} from '../distribution/manifests.js';
import {runtimeLayoutPath,isPlatformRuntimeLayout,assertCanonicalRuntimePackages} from '../platform/runtime-bundle.js';

const digest = data => createHash('sha256').update(data).digest('hex');
const exactVersion = /^\d+\.\d+\.\d+$/;
const sha = /^[0-9a-f]{64}$/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    fail('BUILD_CONFIG_INVALID', `Unsupported ${name} fields.`);
  }
}

function readConfig(root) {
  const path = join(root, '.agents/core/build.json');
  let bytes, config;
  try {
    if (lstatSync(path).isSymbolicLink()) fail('BUILD_CONFIG_INVALID', 'Build configuration must be a regular file.');
    bytes = readFileSync(path);
    config = JSON.parse(bytes);
  } catch (error) {
    fail('BUILD_CONFIG_INVALID', `Cannot read build.json: ${error.message}`);
  }
  keys(config, ['schema_version', 'name', 'version', 'runtime'], 'build configuration');
  keys(config.runtime, ['version', 'release_channel', 'packages'], 'runtime');
  if (config.schema_version !== 1 || config.name !== products.core ||
      (config.version !== null && (typeof config.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(config.version))) ||
      typeof config.runtime.version !== 'string' || !exactVersion.test(config.runtime.version) ||
      config.runtime.release_channel !== 'lts') {
    fail('BUILD_CONFIG_INVALID', 'Invalid KSF version, Node.js version, or release channel.');
  }
  const packages = config.runtime.packages;
  keys(packages, supportedTargets, 'packages');
  if (Object.keys(packages).length === 0) fail('BUILD_CONFIG_INVALID', 'At least one package is required.');
  for (const [target, item] of Object.entries(packages)) {
    keys(item, ['archive_path', 'archive_sha256'], target);
    if (typeof item.archive_path !== 'string' || !/^\.agents\/core\/runtime\/packages\/[A-Za-z0-9_.-]+\.(?:tar\.gz|zip)$/.test(item.archive_path) ||
        item.archive_path.includes('..') || typeof item.archive_sha256 !== 'string' || !sha.test(item.archive_sha256)) {
      fail('BUILD_CONFIG_INVALID', `Invalid archive path or trusted SHA256 for ${target}.`);
    }
  }
  return { config, bytes };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function archiveFingerprint(path) {
  const stat = statSync(path, { bigint: true });
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function hashNodeMember(path, member) {
  const child = spawn(platform.tool('tar'), ['-xOzf', basename(path), member], { cwd: dirname(path), env: tarEnvironment() });
  const hash = createHash('sha256');
  let stderr = '';
  child.stdout.on('data', data => hash.update(data));
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => {
      clearTimeout(timer);
      if (status !== 0) reject(Object.assign(new Error(`Cannot read Node.js archive member: ${stderr.trim()}`), { code: 'ARCHIVE_INVALID' }));
      else resolve(hash.digest('hex'));
    });
  });
}

function tarEnvironment() {
  const env = { ...process.env, LC_ALL: platform.name === 'win32' ? 'C.UTF-8' : 'C' };
  if (platform.name === 'win32') {
    // Git's GNU tar launches its adjacent gzip executable. A fixed launcher
    // must also build with an empty caller PATH, without a global gzip setup.
    const previous = process.env.Path ?? process.env.PATH ?? '';
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = dirname(platform.tool('tar')) + (previous ? ';' + previous : '');
  }
  return env;
}

function gitInfo(root) {
  const run = args => spawnSync(gitExecutable, ['-C', root, ...args], { encoding: 'utf8' });
  const top = run(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || realpathSync.native(top.stdout.trim()) !== realpathSync.native(root)) return { source_revision: null, source_dirty: null };
  const revision = run(['rev-parse', '--verify', 'HEAD']);
  const status = run(['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).agents/core/manifest.yaml']);
  return { source_revision: revision.status === 0 ? revision.stdout.trim() : null,
    source_dirty: status.status === 0 ? status.stdout.length > 0 : null };
}

function sourceDigest(root, packages) {
  const files = [];
  function walk(path) {
    const rel = portable(relative(root, path));
    if (developmentPath(rel) || rel === '.agents/core/manifest.yaml' || rel === '.agents/core/release.json' || rel === '.agents/core/runtime/packages' || /^\.agents\/core\/\.manifest\.yaml\./.test(rel)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail('BUILD_SOURCE_INVALID', `System source must not be a symlink: ${rel}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
    else if (stat.isFile()) files.push(rel);
  }
  walk(join(root, '.agents/core'));
  for (const launcher of ['.agents/ksf', '.agents/ksf.ps1']) if (existsSync(join(root, launcher))) files.push(launcher);
  if (existsSync(join(root, 'AGENTS.md'))) files.push('AGENTS.md');
  const hash = createHash('sha256');
  for (const path of files.sort()) hash.update(JSON.stringify([path, digest(readFileSync(join(root, path)))]));
  hash.update(JSON.stringify(packages));
  return hash.digest('hex');
}

function yaml(value, depth = 0) {
  return Object.entries(value).map(([key, entry]) => {
    const pad = '  '.repeat(depth);
    if (entry !== null && typeof entry === 'object') return `${pad}${key}:\n${yaml(entry, depth + 1)}`;
    return `${pad}${key}: ${entry === null ? 'null' : JSON.stringify(entry)}\n`;
  }).join('');
}

export async function buildManifest(directory, { sourceRoot, builtAt, target:selectedTarget } = {}) {
  const root = realpathSync(directory);
  verifyWebBuild(join(root, '.agents/core/runtime/web'), { optional: true });
  const { config, bytes } = readConfig(root);
  const layout=join(root,runtimeLayoutPath);
  if(existsSync(layout)){
    if(lstatSync(layout).isSymbolicLink()||!isPlatformRuntimeLayout(readFileSync(layout)))fail('BUILD_CONFIG_INVALID','Unknown runtime bundle layout.');
    assertCanonicalRuntimePackages(config);
    const receipt=installedManifest(root,true);
    selectedTarget??=receipt&&receipt.schema_version!==5?receipt.platform:undefined;
  }else if(selectedTarget!==undefined)fail('BUILD_CONFIG_INVALID','A target-specific build requires the source runtime layout policy.');
  if(selectedTarget!==undefined&&!config.runtime.packages[selectedTarget])fail('BUILD_CONFIG_INVALID','The runtime target is not declared by build.json.');
  const packages = {};
  const fingerprints = new Map();
  for (const target of (selectedTarget===undefined?Object.keys(config.runtime.packages):[selectedTarget]).sort()) {
    const input = config.runtime.packages[target];
    const path = join(root, input.archive_path);
    if (!existsSync(path) || !lstatSync(path).isFile()) fail('ARCHIVE_MISSING', `Missing regular archive for ${target}.`);
    const before = archiveFingerprint(path);
    const archiveSha256 = await hashFile(path);
    if (archiveSha256 !== input.archive_sha256) fail('ARCHIVE_INVALID', `Archive SHA256 mismatch for ${target}.`);
    const spec = runtimePackage(target, config.runtime.version), archiveRoot = spec.archiveRoot;
    let nodeSha256;
    if (spec.format === 'zip') {
      if (!input.archive_path.endsWith('.zip')) fail('ARCHIVE_INVALID', 'Windows runtime requires its official ZIP.');
      const members = zipMembers(readFileSync(path), [spec.nodeMember, spec.licenseMember]);
      nodeSha256 = digest(members.get(spec.nodeMember));
    } else {
      const listing = spawnSync(platform.tool('tar'), ['-tvzf', basename(path), spec.nodeMember, spec.licenseMember], {
        cwd: dirname(path), encoding: 'utf8', env: tarEnvironment(), timeout: 30_000,
      });
      const entries = listing.stdout?.trim().split('\n') ?? [];
      if (listing.status !== 0 || entries.length !== 2 || entries.some(entry => !entry.startsWith('-'))) {
        const reason = listing.error?.message ?? listing.stderr?.trim();
        fail('ARCHIVE_INVALID', `Required regular Node.js and LICENSE entries missing for ${target}.${reason ? ' ' + reason.slice(0, 2000) : ''}`);
      }
      nodeSha256 = await hashNodeMember(path, spec.nodeMember);
    }
    if (before !== archiveFingerprint(path)) fail('BUILD_INPUT_CHANGED', `Archive changed while building: ${target}.`);
    fingerprints.set(path, before);
    packages[target] = { archive_path: input.archive_path, archive_root: archiveRoot,
      archive_sha256: archiveSha256, node_sha256: nodeSha256,
      distribution_url: spec.distributionURL };
  }
  const sourceSha256 = sourceDigest(root, packages);
  const manifest = {
    name: products.core, version: config.version,
    runtime: { bootstrap_protocol: 1, status: 'prototype', engine: 'nodejs',
      release_channel: config.runtime.release_channel, version: config.runtime.version,
      distribution: 'bundled', source_language: 'javascript', interface: 'cli', cli_path: '.agents/ksf',
      source_entry: '.agents/core/runtime/src/cli.js', packages },
    build: { generator: 'ksf build', built_at: builtAt ?? new Date().toISOString(), ...gitInfo(sourceRoot ?? root),
      source_sha256: sourceSha256, input_sha256: digest(bytes),
      toolchain: `Official prebuilt Node.js ${config.runtime.version} and JavaScript source`,
      generator_node: process.version, target: Object.keys(packages).join(',') },
  };
  const output = '# Generated by ksf build. Edit .agents/core/build.json; do not edit this file.\n' + yaml(manifest);
  const path = join(root, '.agents/core/manifest.yaml');
  if (existsSync(path) && !lstatSync(path).isFile()) fail('BUILD_OUTPUT_INVALID', 'manifest.yaml must be a regular file.');
  const temporary = join(root, `.agents/core/.manifest.yaml.${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o644);
    writeFileSync(fd, output);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    if (!readFileSync(join(root, '.agents/core/build.json')).equals(bytes) || sourceDigest(root, packages) !== sourceSha256 ||
        [...fingerprints].some(([archive, fingerprint]) => archiveFingerprint(archive) !== fingerprint)) {
      fail('BUILD_INPUT_CHANGED', 'Build inputs changed before manifest publication.');
    }
    replaceFileSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
  return { ok: true, command: 'build', manifestPath: path, manifest };
}
