import {storedZip} from './helpers/platform.js';
import {buildManifest} from '../src/services/build-manifest.js';
import {launcherInvocation,platform as nativePlatform} from '../src/platform/index.js';
import {fileMode} from '../src/distribution/files.js';
import {fixtureTarget} from './helpers/distribution-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, lstatSync, readFileSync, writeFileSync, symlinkSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createArchive, readArchive } from '../src/distribution/archive.js';
import { compareVersions, configuration, installedManifest, releaseReceipt, isBranch, sha256, stableJSON, writeAtomic } from '../src/distribution/common.js';
import { buildRelease, inspectCoreArchive, workspaceDocuments, knowledgeFrameworkFiles } from '../src/distribution/release.js';
import { inspectReleaseDirectory } from '../src/distribution/publish.js';
import { parseDistributionArgs } from '../src/commands/distribution.js';
import { distributionFixture, git } from './helpers/distribution-fixture.js';
import { contextCapabilities } from '../src/services/context.js';
import { objectQuery } from '../src/services/objects.js';
import { systemUpdate } from '../src/distribution/system.js';
import { ForkAPI } from './helpers/contribution-api.js';

test('release archive round-trips UTF-8 paths, content and executable modes', () => {
  const path = '.agents/core/' + 'long-directory/'.repeat(10) + '中文.js';
  const bytes = createArchive([{ path, bytes: Buffer.from('hello\n'), mode: 0o755 }]);
  const file = readArchive(bytes).get(path);
  assert.equal(file.bytes.toString(), 'hello\n'); assert.equal(file.mode, 0o755);
});

for (const path of ['../outside', '/absolute', '.agents/core/../outside', '.agents/core//file', '.git/config', '.agents/core/evil\\path', 'C:/outside']) {
  test(`archive builder rejects escaping path ${JSON.stringify(path)}`, () => {
    assert.throws(() => createArchive([{ path, bytes: Buffer.alloc(0) }]), { code: 'ARCHIVE_INVALID' });
  });
}
test('archive reader rejects tampered checksums, links and duplicate members', () => {
  const good = createArchive([{ path: '.agents/core/test', bytes: Buffer.from('x') }]);
  const wrong = gunzipSync(good); wrong[0] ^= 1;
  assert.throws(() => readArchive(gzipSync(wrong)), { code: 'ARCHIVE_INVALID' });
  const link = gunzipSync(good); link[156] = 50; link.fill(32, 148, 156);
  const sum = link.subarray(0, 512).reduce((a, b) => a + b, 0);
  link.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  assert.throws(() => readArchive(gzipSync(link)), { code: 'ARCHIVE_INVALID' });
  const original = gunzipSync(good), duplicate = Buffer.concat([original.subarray(0, 1024), original]);
  assert.throws(() => readArchive(gzipSync(duplicate)), { code: 'ARCHIVE_INVALID' });
});
test('versions compare numerically and respect prerelease precedence', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.throws(() => compareVersions('01.2.3', '1.2.3'), { code: 'VERSION_INVALID' });
});
test('Core accepts ordinary branch names while rejecting invalid refs', () => {
  for (const branch of ['main', 'feature/project-cli', 'fix/修复', 'feature/nested/task']) assert.equal(isBranch(branch), true, branch);
  for (const branch of ['', '@', '-main', '../main', 'main..old', '/main', 'main/', 'main//fix', 'main.lock', '.hidden', 'main.', 'main@{1}', 'bad branch', 'bad\\branch', 'bad[branch']) assert.equal(isBranch(branch), false, branch);
});
test('complete release includes the system and empty user skeleton, excluding private data and history', async t => {
  const f = await distributionFixture(t);
  writeAtomic(join(f.root, '知识/fictional-private.md'), 'FICTIONAL_PRIVATE_SENTINEL');
  writeAtomic(join(f.root, '知识/rules/README.md'), 'FICTIONAL_PRIVATE_SENTINEL instance rules');
  for (const path of ['USER.md', 'BOT.md', 'MEMORY.md']) writeAtomic(join(f.root, path), 'FICTIONAL_PRIVATE_SENTINEL ' + path);
  const result = await buildRelease({ root: f.root, output: join(f.directory, 'another-build') });
  const loaded = inspectReleaseDirectory(f.root, result.output);
  const entries = new Map();
  const collect = directory => readdirSync(join(result.instance, directory), { withFileTypes: true }).forEach(item => { const path = directory ? `${directory}/${item.name}` : item.name; if (item.isDirectory()) collect(path); else entries.set(path, { bytes: readFileSync(join(result.instance, path)), mode: fileMode(join(result.instance, path)) }); });
  collect('');
  assert.equal(loaded.artifacts.length, 3);
  assert.equal(result.template, join(result.output, 'ksf'));
  assert.deepEqual(result.products, { core: 'ksf-core', instance: 'ksf' });
  assert.equal(result.index.schema_version, 2);
  assert.equal(result.index.platforms[fixtureTarget].workspace, undefined);
  assert.deepEqual(readdirSync(result.output).sort(), ['ksf', `ksf-core-0.1.0-${fixtureTarget}.tar.gz`, 'ksf-core-index.json', 'ksf-core-release.json'].sort());
  assert.ok(entries.has('知识/.gitkeep'));
  for (const path of [...workspaceDocuments, '档案/个人/.gitkeep', '档案/企业/.gitkeep', '档案/项目/.gitkeep']) assert.ok(entries.has(path), path);
  assert.equal(existsSync(join(result.template, '归档')), false);
  assert.ok(entries.has('能力/数据包/.gitkeep'));
  assert.ok(![...entries.keys()].some(path => path.startsWith('源档/')));
  assert.equal(existsSync(join(result.template, '源档')), false);
  assert.ok(!entries.has('知识/fictional-private.md'));
  assert.equal(entries.has('MEMORY.md'), false);
  assert.equal(entries.has('.agents/core/distribution/template/MEMORY.md'), false);
  for (const path of ['USER.md', 'BOT.md']) {
    assert.deepEqual(entries.get(path).bytes, readFileSync(join(f.root, '.agents/core/distribution/template', path)));
    assert.equal(entries.get(path).mode, 0o644);
    assert.equal(entries.has(path.toLowerCase()), false);
  }
  assert.ok([...entries.keys()].every(path => !path.startsWith('.git/') && (!path.startsWith('.agents/runtime-data/') || path.endsWith('/.gitkeep'))));
  assert.ok(!Buffer.concat([...entries.values()].map(e => e.bytes)).includes(Buffer.from('FICTIONAL_PRIVATE_SENTINEL')));
  assert.equal(installedManifest(result.template).core.revision, git(f.root, ['rev-parse', 'HEAD']));
  assert.equal(installedManifest(result.template).product, 'ksf-core');
  assert.equal(installedManifest(result.template).name, 'ksf-core');
  assert.equal(fileMode(join(result.template, '.agents/ksf')), 0o755);
  const coreEntries = inspectCoreArchive(readFileSync(join(result.output, result.index.platforms[fixtureTarget].core.name))).entries;
  assert.ok([...coreEntries.keys()].every(path => path === 'AGENTS.md' || path === '.agents/ksf' || path === '.agents/ksf.ps1' || path.startsWith('.agents/core/')));
});
test('a custom-named user instance starts and upgrades independently of its template name', async t => {
  const f = await distributionFixture(t), next = await f.next();
  const instance = join(f.directory, '我的个人资料 实例');
  cpSync(f.first.template, instance, { recursive: true });
  writeAtomic(join(instance, '知识/private.md'), 'FICTIONAL_PRIVATE');
  const invocation=launcherInvocation(instance,['hello','--json']);
  const launched = spawnSync(invocation.executable, invocation.args, {
    cwd: f.directory, encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: '', KSF_SKIP_AUTO_UPDATE: '1' },
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(JSON.parse(launched.stdout).runtime.ksfRoot.replace(/[\\/]$/, ''), realpathSync.native(instance));
  await systemUpdate({ root: instance, from: next.coreArchive, api: new ForkAPI({ coreRoot: f.root }) });
  assert.equal(installedManifest(instance).version, '0.1.1');
  assert.equal(readFileSync(join(instance, '知识/private.md'), 'utf8'), 'FICTIONAL_PRIVATE');
});
test('publication requires the exact system, template and instance product identities', async t => {
  const f = await distributionFixture(t), index = structuredClone(f.first.index);
  index.products.workspace = 'ksf';
  writeFileSync(join(f.first.output, 'ksf-core-index.json'), stableJSON(index));
  assert.throws(() => inspectReleaseDirectory(f.root, f.first.output), { code: 'RELEASE_INVALID' });
  delete index.products;
  writeFileSync(join(f.first.output, 'ksf-core-index.json'), stableJSON(index));
  assert.throws(() => inspectReleaseDirectory(f.root, f.first.output), { code: 'RELEASE_INVALID' });
});
test('a copied no-Git workspace starts through its fixed launcher from another cwd without global Node', async t => {
  const f = await distributionFixture(t);
  assert.equal(existsSync(join(f.workspace, '.git')), false);
  const result = f.launch(['hello', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).message, 'Hello, KSF!');
  const status = f.launch(['system', 'read', '--json']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).data.version, '0.1.0');
  const discovery = f.launch(['context', 'capabilities', '--json']);
  assert.equal(discovery.status, 0, discovery.stdout + discovery.stderr);
  assert.equal(JSON.parse(discovery.stdout).data.complete, true);
  assert.equal(existsSync(join(f.workspace, '源档')), false);
  for (const path of ['USER.md', 'BOT.md', 'MEMORY.md']) assert.equal(existsSync(join(f.root, path)), false);
});

test('single-Core publication rejects a second product and legacy build indexes', async t => {
  const f = await distributionFixture(t), index = structuredClone(f.first.index);
  index.platforms[fixtureTarget].workspace = index.platforms[fixtureTarget].core;
  writeFileSync(join(f.first.output, 'ksf-core-index.json'), stableJSON(index));
  assert.throws(() => inspectReleaseDirectory(f.root, f.first.output), { code: 'RELEASE_INVALID' });
  delete index.platforms[fixtureTarget].workspace; index.schema_version = 1;
  writeFileSync(join(f.first.output, 'ksf-core-index.json'), stableJSON(index));
  assert.throws(() => inspectReleaseDirectory(f.root, f.first.output), { code: 'RELEASE_INVALID' });
});
test('Core sources need no user directories while installed workspaces still validate their user scopes', async t => {
  const f = await distributionFixture(t);
  for (const name of ['项目', '知识', '能力', '@收件箱', '源档', '归档', '档案']) assert.equal(existsSync(join(f.root, name)), false);
  const discovery = contextCapabilities(f.root);
  assert.equal(discovery.data.complete, true, JSON.stringify(discovery.errors));
  assert.deepEqual(objectQuery({ root: f.root, type: 'partner', operation: 'check', reference: 'partner.ksf.object-designer' }).errors, []);
  assert.equal(installedManifest(f.workspace).core.branch, 'core-main');
  assert.equal(existsSync(join(f.root, '能力')), false);
  rmSync(join(f.workspace, '能力/协同'), { recursive: true });
  const incomplete = contextCapabilities(f.workspace);
  assert.equal(incomplete.data.cooperations.complete, false);
  assert.ok(incomplete.errors.some(error => error.target === '能力/协同'));
});
test('distribution fixture reconstructs Core sources from an installed workspace', async t => {
  const source = await distributionFixture(t);
  assert.equal(existsSync(join(source.workspace, '.agents/core/release.json')), true);
  const f = await distributionFixture(t, { sourceRoot: source.workspace });
  assert.equal(existsSync(join(f.root, '.agents/core/release.json')), false);
  const discovery = contextCapabilities(f.root);
  assert.equal(discovery.data.complete, true, JSON.stringify(discovery.errors));
  assert.equal(existsSync(join(source.workspace, '.agents/core/release.json')), true);
  assert.equal(f.launch(['context', 'capabilities', '--json']).status, 0);
});
test('release preview creates no output and dirty sources require an explicit development build', async t => {
  const f = await distributionFixture(t), output = join(f.directory, 'preview');
  const preview = await buildRelease({ root: f.root, output, dryRun: true });
  assert.equal(preview.dryRun, true); assert.equal(existsSync(output), false);
  f.save('.agents/core/example.txt', 'edited\n');
  await assert.rejects(buildRelease({ root: f.root, output }), { code: 'RELEASE_SOURCE_DIRTY' });
  const dev = await buildRelease({ root: f.root, output, allowDirty: true });
  assert.equal(dev.development, true);
  assert.throws(() => inspectReleaseDirectory(f.root, output), { code: 'RELEASE_INVALID' });
});
test('clean releases are byte-for-byte reproducible, so a fresh CI retry reuses the exact assets', async t => {
  const f = await distributionFixture(t);
  const second = await buildRelease({ root: f.root, output: join(f.directory, 'repeated-clean-build') });
  assert.deepEqual(second.index, f.first.index);
  for (const item of Object.values(second.index.platforms[fixtureTarget])) {
    assert.deepEqual(readFileSync(join(second.output, item.name)), readFileSync(join(f.first.output, item.name)));
  }
});
test('symlinked system inputs and tampered published artifacts are rejected', async t => {
  const f = await distributionFixture(t);
  symlinkSync(join(f.root, 'AGENTS.md'), join(f.root, '.agents/core/symlink'));
  await assert.rejects(buildRelease({ root: f.root, output: join(f.directory, 'unsafe'), allowDirty: true }), { code: 'UNSAFE_PATH' });
  const descriptor = f.first.index.platforms[fixtureTarget].core;
  writeFileSync(join(f.first.output, descriptor.name), 'tampered');
  assert.throws(() => inspectReleaseDirectory(f.root, f.first.output), { code: 'RELEASE_INVALID' });
});

for (const [command, args] of [
  ['system', ['check', '--dry-run']], ['system', ['update', '--source', 'a', '--from', 'b']],
  ['system', ['sync', '--quiet', '--json']], ['release', ['publish']],
  ['release', ['build', '--json', '--json']], ['contribute', ['prepare']],
  ['contribute', ['prepare', '--all', '--paths', '.agents/core/test']], ['contribute', ['submit', 'id']],
  ['system', ['read', '--help', '--json']],
  ['release', ['mirror']], ['release', ['template']], ['release', ['publish', 'out', '--release-only']],
]) {
  test(`strict CLI rejects ${command} ${args.join(' ')}`, () => {
    assert.throws(() => parseDistributionArgs(command, args), { code: 'INVALID_ARGUMENTS', exitCode: 2 });
  });
}

test('default release covers all declared platforms and publication refuses an incomplete feed',async t=>{
  const f=await distributionFixture(t),other=fixtureTarget==='win32-x64'?'darwin-arm64':'win32-x64',version=f.build.runtime.version;
  const archiveRoot=`node-v${version}-${other==='win32-x64'?'win-x64':'darwin-arm64'}`;
  const archivePath=`.agents/core/runtime/packages/${archiveRoot}.${other==='win32-x64'?'zip':'tar.gz'}`;
  const archive=other==='win32-x64'?storedZip([{path:`${archiveRoot}/node.exe`,bytes:Buffer.from('foreign runtime fixture; never executed')},{path:`${archiveRoot}/LICENSE`,bytes:Buffer.from('fixture license')}])
    :createArchive([{path:`${archiveRoot}/bin/node`,bytes:Buffer.from('foreign runtime fixture; never executed'),mode:0o755},{path:`${archiveRoot}/LICENSE`,bytes:Buffer.from('fixture license'),mode:0o644}]);
  f.save(archivePath,archive);f.build.runtime.packages[other]={archive_path:archivePath,archive_sha256:sha256(archive)};
  f.save('.agents/core/build.json',stableJSON(f.build));await buildManifest(f.root);
  git(f.root,['add','.agents']);git(f.root,['commit','-m','Fictional second platform']);
  const output=join(f.directory,'all-platforms'),built=await buildRelease({root:f.root,output});
  assert.deepEqual(built.platforms,['darwin-arm64','win32-x64']);
  assert.deepEqual(Object.keys(built.index.platforms).sort(),built.platforms);
  assert.equal(installedManifest(built.instance).platform,fixtureTarget);
  assert.equal(inspectReleaseDirectory(f.root,output).artifacts.length,4);
  const bridge=JSON.parse(readFileSync(join(output,'ksf-core-release.json')));
  assert.equal(bridge.schema_version,1);
  assert.deepEqual(bridge.products,{core:'ksf-core',workspace:'ksf-workspace',instance:'ksf'});
  assert.equal(bridge.core_revision,built.coreRevision);assert.deepEqual(bridge.platforms,built.index.platforms);
  assert.ok(Object.values(bridge.platforms).every(platform=>platform.workspace===undefined));

  for(const target of built.platforms){const item=built.index.platforms[target].core;const archive=inspectCoreArchive(readFileSync(join(output,item.name)));assert.equal(archive.manifest.platform,target);assert.equal(archive.manifest.core.revision,built.coreRevision);assert.deepEqual(Object.keys(built.index.platforms[target]),['core']);}
  const single=await buildRelease({root:f.root,platform:fixtureTarget,output:join(f.directory,'partial-platform')});
  assert.throws(()=>inspectReleaseDirectory(f.root,single.output),{code:'RELEASE_PLATFORM_MISSING'});
});

test('a tampered compatibility index cannot publish a second or different product',async t=>{
  const f=await distributionFixture(t),path=join(f.first.output,'ksf-core-release.json');
  const bridge=JSON.parse(readFileSync(path));bridge.platforms[fixtureTarget].workspace=bridge.platforms[fixtureTarget].core;
  writeFileSync(path,stableJSON(bridge));
  assert.throws(()=>inspectReleaseDirectory(f.root,f.first.output),{code:'RELEASE_INVALID'});
});
