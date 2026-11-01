import {platform,launcherInvocation,removePathSync as rmSync} from '../../src/platform/index.js';
export const fixtureTarget=platform.name==='win32'?'win32-x64':'darwin-arm64';
import {gitBinary,nullDevice,writeNodeExecutable,storedZip} from './platform.js';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildManifest } from '../../src/services/build-manifest.js';
import { buildRelease, inspectCoreArchive } from '../../src/distribution/release.js';
import { createArchive } from '../../src/distribution/archive.js';
import { sha256, stableJSON, writeAtomic, fileMode } from '../../src/distribution/common.js';
import { developmentPath } from '../../src/distribution/paths.js';

export const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const gitTiming = { ms: 0, calls: 0 };
export const contributionDescription = {
  title: 'fix(core): 修正选定系统文件的示例行为',
  body: '原因：\n选定系统文件与预期行为不符。\n\n变更：\n- 修正选定系统文件的示例行为。\n\n验证：\n- 未执行：这里只构造隔离的贡献测试数据，不代表真实系统验证。\n',
  prBody: '## 背景与目的\n选定系统文件与预期行为不符，需恢复约定行为。\n\n## 主要变更\n- 修正示例行为，并保留当前贡献边界。\n\n## 验证结果\n- 未执行：这里只构造隔离贡献数据，不代表真实系统验证。\n\n## 影响与兼容\n本例不更换 CLI 或数据格式；实际兼容性由测试场景核对。\n',
};
export function git(root, args) {
  const began = performance.now();
  const result = spawnSync(gitBinary, ['-C', root, ...args], { encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice, GIT_TERMINAL_PROMPT: '0',
  } });
  gitTiming.ms += performance.now() - began; gitTiming.calls++;
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
export function commitWorkspace(f, { paths = ['.agents/core', 'AGENTS.md', '.agents/ksf', '.agents/ksf.ps1'], message = 'Fictional local system checkpoint', modes={} } = {}) {
  if (!existsSync(join(f.workspace, '.git'))) {
    git(f.workspace, ['init', '--template=', '--initial-branch=main']);
    git(f.workspace, ['config', 'user.name', 'KSF Fixture']);
    git(f.workspace, ['config', 'user.email', 'fixture@example.invalid']);
    git(f.workspace, ['config', 'commit.gpgsign', 'false']);
  }
  git(f.workspace,['config','user.name','KSF Fixture']);git(f.workspace,['config','user.email','fixture@example.invalid']);git(f.workspace,['config','commit.gpgsign','false']);
  // This helper writes only the isolated test workspace, never a real instance.
  git(f.workspace, ['add', '--force', '--', ...paths]);
  if(existsSync(join(f.workspace,'.agents/ksf')))git(f.workspace,['update-index','--chmod=+x','.agents/ksf']);
  for(const [path,mode] of Object.entries(modes))git(f.workspace,['update-index',mode===0o755?'--chmod=+x':'--chmod=-x',path]);
  git(f.workspace, ['commit', '-m', message]);
  return git(f.workspace, ['rev-parse', 'HEAD']);
}
async function createFixtureBase(t, { legacyEntry = false, sourceRoot = repository, compact = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ksf distribution 测试 ')), root = join(directory, 'core');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(root);
  // Reconstruct Core sources without inheriting the source workspace's installed identity.
  const installedMarker = join(sourceRoot, '.agents/core/release.json');
  cpSync(join(sourceRoot, '.agents/core'), join(root, '.agents/core'), { recursive: true,
    // Component lifecycle tests use a synthetic runtime; application binaries
    // have independent native package/PTY acceptance. Do not recompress every
    // historical app release for each transaction fault injection.
    filter: path => {
      const rel=relative(sourceRoot,path).replaceAll('\\','/');
      if(path===installedMarker||developmentPath(rel)||/\/(?:runtime\/(?:packages|tests|web)|applications\/store\/media)(?:\/|$)/.test(rel)||path.endsWith('.ksfapp'))return false;
      // Transaction fixtures exercise the CLI, definitions and real archive /
      // Git machinery. UI bundles and application build inputs have separate
      // package/frontend acceptance and must not be copied per fault scenario.
      if(rel.startsWith('.agents/core/applications/')){
        const parts=rel.slice('.agents/core/applications/'.length).split('/');
        if(!['sdk','store'].includes(parts[0]))return false;
        if(parts[0]==='sdk'&&['tests','templates','build','scripts'].includes(parts[1]))return false;
      }
      return true;
    } });
  writeFileSync(join(root,'.agents/core/applications/store/index.json'),JSON.stringify({protocol:'ksf-app-registry-v1',name:'Lifecycle fixture',apps:[]}));
  for (const entry of ['ksf', 'ksf.ps1']) cpSync(join(sourceRoot, '.agents', entry), join(root, '.agents', entry));
  cpSync(join(sourceRoot, 'AGENTS.md'), join(root, 'AGENTS.md'));
  const definitionFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? definitionFiles(path) : path.endsWith('.md') ? [path] : [];
  });
  const originals = new Map();
  if (legacyEntry) {
    // Construct an older identity, not a claim to replay a historical release.
    for (const path of [join(root, 'AGENTS.md'), join(root, '.agents/core/runtime/src/objects/schema.js'), ...definitionFiles(join(root, '.agents/core/abilities'))]) {
      const bytes = readFileSync(path, 'utf8'); originals.set(path, bytes);
      writeFileSync(path, bytes.replaceAll('ksf-runtime', 'ksf-assistant').replaceAll('partner.ksf.runtime', 'partner.ksf.assistant').replaceAll('ability-route', 'task-route'));
    }
    renameSync(join(root, '.agents/core/abilities/partners/ksf-runtime'), join(root, '.agents/core/abilities/partners/ksf-assistant'));
    renameSync(join(root, '.agents/core/abilities/competencies/ability-route'), join(root, '.agents/core/abilities/competencies/task-route'));
  }
  writeFileSync(join(root, '.gitignore'), '/.agents/runtime-data/\n/.agents/user-data/\n/知识/\n/.agents/core/release.json\n');
  writeAtomic(join(root, '.agents/core/example.txt'), 'first\none\ntwo\nthree\nfour\nfive\nlast\n');
  const version = process.version.slice(1), archiveRoot = `node-v${version}-darwin-arm64`;
  const escapedNode = process.execPath.replace(/'/g, "'\\''");
  const node = Buffer.from(`#!/bin/sh\nif [ "$1" = '--version' ]; then printf 'v${version}\\n'; else exec '${escapedNode}' "$@"; fi\n`);
  let archive,archivePath;
  if(platform.name==='win32'){
    const shim=writeNodeExecutable(join(directory,'native-node.exe'),`const {spawnSync}=require('node:child_process');const r=spawnSync(${JSON.stringify(process.execPath)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);`);
    const prefix=`node-v${version}-win-x64`;
    archive=storedZip([{path:prefix+'/node.exe',bytes:readFileSync(shim)},{path:prefix+'/LICENSE',bytes:Buffer.from('Fictional runtime fixture license\n')}]);
    archivePath=`.agents/core/runtime/packages/${prefix}.zip`;
  }else{
    archive=createArchive([{path:`${archiveRoot}/bin/node`,bytes:node,mode:0o755},{path:`${archiveRoot}/LICENSE`,bytes:Buffer.from('Fictional runtime fixture license\n'),mode:0o644}]);
    archivePath=`.agents/core/runtime/packages/${archiveRoot}.tar.gz`;
  }
  writeAtomic(join(root, archivePath), archive);
  const build = { schema_version: 1, name: 'ksf-core', version: '0.1.0', runtime: { version, release_channel: 'lts', packages: {
    [fixtureTarget]: { archive_path: archivePath, archive_sha256: sha256(archive) },
  } } };
  writeAtomic(join(root, '.agents/core/build.json'), stableJSON(build));
  await buildManifest(root);
  git(root, ['init', '--template=', '--initial-branch=core-main']);
  git(root, ['config', 'user.name', 'KSF Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '.agents', 'AGENTS.md', '.gitignore']); git(root,['update-index','--chmod=+x','.agents/ksf']); git(root, ['commit', '-m', 'Fictional clean Core source']);
  const first = await buildRelease({ root, platform:fixtureTarget, output: join(directory, 'release-0.1.0') });
  const workspace = join(directory, 'ksf'); cpSync(first.template, workspace, { recursive: true });
  if (!compact) {
    // Existing suites exercise upgrades from the former schema-3 installation.
    // New compact-receipt suites opt in explicitly and use a read-only fake API.
    const { manifest, entries } = inspectCoreArchive(readFileSync(join(first.output, first.index.platforms[fixtureTarget].core.name)));
    delete manifest.instance_initialization;
    for (const [path, record] of Object.entries(manifest.files)) {
      const bytes = entries.get(path).bytes;
      if (!bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes) && path !== '.agents/core/manifest.yaml') record.baseline = bytes.toString('base64');
    }
    writeAtomic(join(workspace, '.agents/core/release.json'), stableJSON(manifest));
  }
  return { directory, root, workspace, first, build, originals, legacyEntry };
}

const seeds = new Map(), seedCleanup = [];
after(() => { for (const cleanup of seedCleanup.splice(0)) cleanup(); });
export async function distributionFixture(t, options = {}) {
  const began = performance.now(), priorGit = {...gitTiming}; let packageMs = 0, cleanupMs = 0;
  let base;
  if (options.legacyEntry || options.sourceRoot && options.sourceRoot !== repository) base = await createFixtureBase(t, options);
  else {
    const key = !!options.compact;
    if (!seeds.has(key)) seeds.set(key, createFixtureBase({ after: callback => seedCleanup.push(callback) }, options));
    const seed = await seeds.get(key), directory = mkdtempSync(join(tmpdir(), 'ksf isolated fixture '));
    t.after(() => {const start=performance.now();rmSync(directory, { recursive: true, force: true });cleanupMs=performance.now()-start;});
    const root = join(directory, 'core'), workspace = join(directory, 'ksf'), output = join(directory, 'release-0.1.0');
    // Seeds are never mutated. Copies are independent, including Git objects;
    // mutable fixtures must not share writable hardlinks with another scenario.
    cpSync(seed.root, root, { recursive: true });
    cpSync(seed.workspace, workspace, { recursive: true });
    cpSync(seed.first.output, output, { recursive: true });
    base = { directory, root, workspace, first: { ...structuredClone(seed.first), output, instance: join(output, 'ksf'), template: join(output, 'ksf') }, build: structuredClone(seed.build), originals: new Map(), legacyEntry: false };
  }
  const { directory, root, workspace, first, build, originals } = base;
  const fixtureMs = performance.now()-began;
  t.after(() => t.diagnostic(JSON.stringify({phase:'distribution-fixture',fixtureMs:Math.round(fixtureMs),gitMs:Math.round(gitTiming.ms-priorGit.ms),gitCalls:gitTiming.calls-priorGit.calls,packageMs:Math.round(packageMs),assertionAndOtherMs:Math.round(Math.max(0,performance.now()-began-fixtureMs-packageMs-cleanupMs)),cleanupMs:Math.round(cleanupMs)})));
  let legacyEntry = base.legacyEntry;
  const save = (path, value) => writeAtomic(join(root, path), value, existsSync(join(root, path)) ? fileMode(join(root, path)) : 0o644);
  const next = async (version = '0.1.1', changes = {}) => {
    if (legacyEntry) {
      renameSync(join(root, '.agents/core/abilities/partners/ksf-assistant'), join(root, '.agents/core/abilities/partners/ksf-runtime'));
      renameSync(join(root, '.agents/core/abilities/competencies/task-route'), join(root, '.agents/core/abilities/competencies/ability-route'));
      for (const [path, bytes] of originals) writeFileSync(path, bytes);
      legacyEntry = false;
    }
    build.version = version; save('.agents/core/build.json', stableJSON(build));
    for (const [path, bytes] of Object.entries(changes)) {
      if (bytes === null) rmSync(join(root, path)); else save(path, bytes);
    }
    git(root, ['add', '.agents', 'AGENTS.md']); git(root, ['commit', '-m', `Fictional Core ${version}`]);
    const packStarted=performance.now();
    const result = await buildRelease({ root, platform:fixtureTarget, output: join(directory, `release-${version}`) });
    packageMs+=performance.now()-packStarted;
    const index = JSON.parse(readFileSync(join(result.output, 'ksf-core-index.json'), 'utf8'));
    for (const item of Object.values(index.platforms[fixtureTarget])) item.url = pathToFileURL(join(result.output, item.name)).href;
    const source = join(directory, `feed-${version}.json`); writeAtomic(source, stableJSON(index));
    return { ...result, source, coreArchive: join(result.output, index.platforms[fixtureTarget].core.name), feed: index };
  };
  const launch = (args, options = {}) => { const invocation=launcherInvocation(workspace,args); return spawnSync(invocation.executable, invocation.args, {
    cwd: tmpdir(), encoding: 'utf8', timeout: options.timeoutMs ?? 20000,
    env: { ...process.env, PATH: '', KSF_SKIP_AUTO_UPDATE: '1', ...options.env },
  }); };
  return { directory, root, workspace, first, next, save, launch, build };
}

export function instanceEntries(root) {
  const entries = new Map();
  function visit(relativePath) {
    for (const entry of readdirSync(join(root, relativePath), { withFileTypes: true })) {
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else entries.set(path, { path, bytes: readFileSync(join(root, path)), mode: fileMode(join(root, path)) });
    }
  }
  visit(''); return entries;
}
