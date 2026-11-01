import {shellCommands,terminalText} from './helpers/platform.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApplicationManager } from '../src/applications/manager.js';
import { encodePackage, decodePackage, checksum,compareVersions } from '../src/applications/protocol.js';
import { startWebServer } from '../src/services/web.js';

const manifest = (version = '1.0.0') => ({ schemaVersion: 1, id: 'com.example.echo', version, name: 'Echo', description: 'Independent test application', minCoreVersion:'0.3.0',dataStores:[],sdkVersion: 1, window: { entry: 'frontend/main.js', styles: ['frontend/style.css'] }, backend: { runtime:'node',lifecycle:'on-demand', entry: 'backend/main.mjs' }, permissions: [] });
function file(text, mode = 0o644) { const data = Buffer.from(text); return { content: data.toString('base64'), sha256: checksum(data), mode }; }
function release(version = '1.0.0', extra = {}) {
  const m = { ...manifest(version), ...extra }, bytes = encodePackage(m, { 'frontend/main.js': file('export function mount(root,sdk){root.textContent="Loaded via ESM "+sdk.version;return{dispose(){root.replaceChildren()}}}'), 'frontend/style.css': file('.test-application{color:#234}'), 'backend/main.mjs': file(`export async function activate(ctx){return{call(method,input){if(method==='crash')process.exit(17);return{version:ctx.version,method,input}},dispose(){}}}`) });
  return { bytes, entry: { manifest: m, package: { url: `echo-${version}.ksfapp`, sha256: checksum(bytes), size: bytes.length } } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ksf-app-test-')), store = join(root, 'store'); await mkdir(store);
  const one = release();
  const writeIndex = async entries => writeFile(join(store, 'index.json'), JSON.stringify({ protocol: 'ksf-app-registry-v1', apps: entries }));
  await writeFile(join(store, one.entry.package.url), one.bytes); await writeIndex([one.entry]);
  const manager = createApplicationManager(root, { defaultSource: null, storeDirectory: store });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const install = async (item = one, sourceId = 'builtin') => manager.install({ trusted: true, sourceId, appId: item.entry.manifest.id, version: item.entry.manifest.version, digest: item.entry.package.sha256 });
  return { root, store, manager, one, writeIndex, install };
}
test('releasing a lease with no pending installation preserves registry bytes and file identity', async t => {
  const f = await fixture(t); await f.install();
  const path = join(f.root, '.agents/user-data/applications/state.json'), before = await readFile(path), identity = await stat(path);
  const instance = await f.manager.launch(f.one.entry.manifest.id, f.one.entry.package.sha256);
  await f.manager.release(instance.id);
  assert.deepEqual(await readFile(path), before);
  const after = await stat(path); assert.equal(after.ino, identity.ino); assert.equal(after.mtimeMs, identity.mtimeMs);
});

test('package validation rejects traversal, case collisions, missing entries and changed content', () => {
  const one = release(); assert.equal(decodePackage(one.bytes).manifest.id, 'com.example.echo');
  for (const files of [
    { '../outside': file('bad') },
    { 'frontend/main.js': file('one'), 'frontend/MAIN.js': file('two') },
    { 'frontend/main.js': { ...file('original'), content: Buffer.from('changed').toString('base64') } },
    { 'frontend/only.js': file('missing entry') },
  ]) assert.throws(() => decodePackage(encodePackage(manifest(), files)), /路径|校验|缺少/);
});
test('install is explicit, content-verified, persistent and exposes only frontend assets', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.snapshot()).installed.length, 0);
  await assert.rejects(f.manager.install({ sourceId: 'builtin', appId: 'com.example.echo', version: '1.0.0', digest: f.one.entry.package.sha256 }), { code: 'APP_TRUST_REQUIRED' });
  await f.install(); const snapshot = await f.manager.snapshot(); assert.equal(snapshot.installed.length, 1); assert.equal(snapshot.installed[0].active.digest, f.one.entry.package.sha256);
  assert.match((await f.manager.asset('com.example.echo', f.one.entry.package.sha256, 'frontend/main.js')).bytes.toString(), /mount/);
  await assert.rejects(f.manager.asset('com.example.echo', f.one.entry.package.sha256, 'backend/main.mjs'), { code: 'APP_ASSET_NOT_FOUND' });
  const fresh = createApplicationManager(f.root, { defaultSource: null, storeDirectory: f.store }); t.after(() => fresh.close()); assert.equal((await fresh.snapshot()).installed[0].id, 'com.example.echo');
  await writeFile(join(f.root, '.agents/user-data/applications/packages/com.example.echo', f.one.entry.package.sha256, 'frontend/main.js'), 'changed');
  await assert.rejects(f.manager.launch('com.example.echo', f.one.entry.package.sha256), { code: 'APP_PACKAGE_INTEGRITY' });
});
test('HTTP registry works independently; disabling and removing it preserve installed apps', async t => {
  const f = await fixture(t);
  const server = createServer(async (req, res) => { try { const bytes = await readFile(join(f.store, req.url.slice(1))); res.end(bytes); } catch { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const source = await f.manager.saveSource({ name: 'Independent source', url: `http://127.0.0.1:${server.address().port}/index.json`, enabled: true });
  assert.equal((await f.manager.catalog()).apps.filter(a => a.source.id === source.id).length, 1);
  await f.install(f.one, source.id); await f.manager.saveSource({ ...source, enabled: false });
  assert.equal((await f.manager.catalog()).apps.filter(a => a.source.id === source.id).length, 0);
  await f.manager.removeSource(source.id); assert.equal((await f.manager.snapshot()).installed[0].active.source.id, source.id);
  const instance = await f.manager.launch('com.example.echo', f.one.entry.package.sha256); assert.equal((await f.manager.call(instance.id, 'echo', { hello: '中文' })).input.hello, '中文'); await f.manager.release(instance.id);
});
test('failed checksums, unsupported platforms and changed source versions never replace active release', async t => {
  const f = await fixture(t); await f.install();
  const changed = release('2.0.0'); await writeFile(join(f.store, changed.entry.package.url), 'not the promised package'); await f.writeIndex([changed.entry]);
  await assert.rejects(f.install(changed), { code: 'APP_PACKAGE_INTEGRITY' });
  const unsupported = release('2.0.0', { target: 'unsupported-platform' }); await f.writeIndex([unsupported.entry]);
  await assert.rejects(f.install(unsupported), { code: 'APP_PLATFORM_UNSUPPORTED' });
  await assert.rejects(f.install(changed), { code: 'APP_RELEASE_CHANGED' });
  assert.equal((await f.manager.snapshot()).installed[0].active.manifest.version, '1.0.0');
});
test('unsupported SDK contracts are rejected and JSON key order remains immaterial',async t=>{
  const f=await fixture(t);assert.throws(()=>release('2.0.0',{sdkVersion:2}),{code:'APP_MANIFEST_INVALID'});
  const reordered={...f.one.entry,manifest:Object.fromEntries(Object.entries(f.one.entry.manifest).reverse())};await f.writeIndex([reordered]);
  const catalog=await f.manager.catalog();assert.equal(catalog.errors.length,0);assert.equal(catalog.apps.length,1);await f.install();
});
test('frontend-only applications use the same install, launch, asset and cleanup lifecycle', async t => {
  const f = await fixture(t), app = release('1.1.0', { backend: undefined }); await writeFile(join(f.store, app.entry.package.url), app.bytes); await f.writeIndex([app.entry]);
  await f.install(app); const instance = await f.manager.launch('com.example.echo', app.entry.package.sha256); assert.equal((await f.manager.snapshot()).installed[0].running, 1);
  assert.match((await f.manager.asset('com.example.echo', app.entry.package.sha256, 'frontend/main.js')).bytes.toString(), /mount/);
  await f.manager.release(instance.id); assert.equal((await f.manager.snapshot()).installed[0].running, 0);
});
test('upgrade pins running frontend/backend, switches after final close, rollback and uninstall retain data', async t => {
  const f = await fixture(t); await f.install();
  const a = await f.manager.launch('com.example.echo', f.one.entry.package.sha256), b = await f.manager.launch('com.example.echo', f.one.entry.package.sha256);
  const two = release('2.0.0'); await writeFile(join(f.store, two.entry.package.url), two.bytes); await f.writeIndex([two.entry]);
  assert.equal((await f.install(two)).pending, true);
  assert.equal((await f.manager.call(a.id, 'echo', {})).version, '1.0.0'); assert.equal((await f.manager.snapshot()).installed[0].pending.manifest.version, '2.0.0');
  await f.manager.release(a.id); assert.equal((await f.manager.snapshot()).installed[0].active.manifest.version, '1.0.0');
  await f.manager.release(b.id); assert.equal((await f.manager.snapshot()).installed[0].active.manifest.version, '2.0.0');
  await assert.rejects(f.manager.launch('com.example.echo', f.one.entry.package.sha256), { code: 'APP_RELEASE_CHANGED' });
  const next = await f.manager.launch('com.example.echo', two.entry.package.sha256); assert.equal((await f.manager.call(next.id, 'echo', {})).version, '2.0.0'); await f.manager.release(next.id);
  await f.manager.changeApp('com.example.echo', 'rollback'); assert.equal((await f.manager.snapshot()).installed[0].active.manifest.version, '1.0.0');
  const data = join(f.root, '.agents/user-data/applications/data/com.example.echo/keep.txt'); await writeFile(data, 'keep');
  await f.manager.changeApp('com.example.echo', 'disable'); await assert.rejects(f.manager.launch('com.example.echo', f.one.entry.package.sha256), { code: 'APP_RELEASE_CHANGED' });
  await f.manager.changeApp('com.example.echo', 'enable'); await f.manager.changeApp('com.example.echo', 'uninstall'); assert.equal((await f.manager.snapshot()).installed.length, 0); assert.equal(await readFile(data, 'utf8'), 'keep');
});
test('application process crash fails that instance and permits another launch', async t => {
  const f = await fixture(t); await f.install(); const instance = await f.manager.launch('com.example.echo', f.one.entry.package.sha256);
  await assert.rejects(f.manager.call(instance.id, 'crash', {}), { code: 'APP_PROCESS_EXITED' });
  await f.manager.release(instance.id); const next = await f.manager.launch('com.example.echo', f.one.entry.package.sha256); assert.equal((await f.manager.call(next.id, 'echo', {})).version, '1.0.0');
  await f.manager.close();
  const text=await readFile(join(f.root,'.agents/runtime-data/applications/logs/com.example.echo.log'),'utf8');
  assert.match(text,/code=17/);
  assert.match(text,/intentional=true/);
  // No late mkdir/append is allowed after shutdown has returned.
  await rm(f.root,{recursive:true,force:true});
});
test('a live or unknown lock is preserved and a provably dead owner is recovered', async t => {
  const f = await fixture(t), home = join(f.root, '.agents/user-data/applications'); await mkdir(home, { recursive: true }); const lock = join(home, '.lock');
  const active = JSON.stringify({ pid: process.pid, nonce: 'active' }); await writeFile(lock, active);
  await assert.rejects(f.install(), { code: 'APP_BUSY' }); assert.equal(await readFile(lock, 'utf8'), active);
  await writeFile(lock, 'unknown'); await assert.rejects(f.install(), { code: 'APP_BUSY' }); assert.equal(await readFile(lock, 'utf8'), 'unknown');
  await writeFile(lock, JSON.stringify({ pid: 2147483647, nonce: 'dead' })); await f.install(); assert.equal((await f.manager.snapshot()).installed.length, 1);
});
test('another application manager cannot switch a release or uninstall a live foreign instance', async t => {
  const f = await fixture(t); await f.install(); const instance = await f.manager.launch('com.example.echo', f.one.entry.package.sha256);
  const other = createApplicationManager(f.root, { defaultSource: null, storeDirectory: f.store }); t.after(() => other.close());
  assert.equal((await other.snapshot()).installed[0].running, 1);
  await assert.rejects(other.changeApp('com.example.echo', 'uninstall', true), { code: 'APP_OTHER_HOST_RUNNING' });
  const two = release('2.0.0'); await writeFile(join(f.store, two.entry.package.url), two.bytes); await f.writeIndex([two.entry]);
  await other.install({ trusted: true, sourceId: 'builtin', appId: 'com.example.echo', version: '2.0.0', digest: two.entry.package.sha256 });
  assert.equal((await other.snapshot()).installed[0].active.manifest.version, '1.0.0');
  await f.manager.release(instance.id); assert.equal((await other.snapshot()).installed[0].active.manifest.version, '2.0.0');
});
test('live HTTP server installs and runs an app without changing its health start identity', async t => {
  let server;
  t.after(() => server?.close());

  const f = await fixture(t);server = await startWebServer({ root: f.root, port: 0, capture: false, applications: { defaultSource: null, storeDirectory: f.store } });
  const origin = server.url.slice(0, -1), get = async path => (await fetch(origin + path)).json();
  const start = (await get('/api/health')).startedAt, auth = (await get('/api/workbench/session')).data;
  const post = async (path, input, token = auth.token) => { const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-KSF-Token': token }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await post('/api/apps/install', {}, 'bad')).status, 403);
  assert.equal((await post('/api/apps/install', { trusted: true, sourceId: 'builtin', appId: 'com.example.echo', version: '1.0.0', digest: f.one.entry.package.sha256 })).status, 200);
  const launch = await post('/api/apps/launch', { appId: 'com.example.echo', digest: f.one.entry.package.sha256 }); assert.ok(launch.body.data.id);
  const result = await post('/api/apps/call', { instanceId: launch.body.data.id, method: 'echo', params: { input: 'runtime' } }); assert.equal(result.body.data.input.input, 'runtime');
  assert.equal((await get('/api/health')).startedAt, start); assert.equal((await get('/api/apps/installed')).data.installed.length, 1);
  const asset = await fetch(origin + `/app-assets/com.example.echo/${f.one.entry.package.sha256}/frontend/main.js`); assert.equal(asset.status, 200); assert.match(asset.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(origin + `/app-assets/com.example.echo/${f.one.entry.package.sha256}/backend/main.mjs`)).status, 404);
  await post('/api/apps/release', { instanceId: launch.body.data.id });
});
test('distributed Terminal uses a real PTY with UTF-8 output, resizing, Ctrl-C and isolated sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ksf-terminal-test-')), manager = createApplicationManager(root); t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true,maxRetries:8,retryDelay:50 }); });
  const catalog = await manager.catalog(), app = catalog.apps.filter(a => a.manifest.id === 'com.ksf.terminal' && !a.incompatibility).sort((a,b)=>compareVersions(b.manifest.version,a.manifest.version))[0]; assert.ok(app, 'current platform needs a distributed Terminal package');
  await manager.install({ trusted: true, sourceId: 'builtin', appId: app.manifest.id, version: app.manifest.version, digest: app.package.sha256 });
  const instance = await manager.launch(app.manifest.id, app.package.sha256), session = await manager.call(instance.id, 'create', { cols: 80, rows: 24 }); let cursor = 0;
  async function until(pattern, timeout = 10000) { const until = Date.now() + timeout; let text = ''; while (Date.now() < until) { const out = await manager.call(instance.id, 'read', { id: session.id, after: cursor }); cursor = out.seq; text += out.chunks.map(c => c.data).join(''); if (pattern.test(terminalText(text))) return text; } assert.fail(`missing ${pattern} in terminal output: ${JSON.stringify(text.slice(-4096))}`); }
  await manager.call(instance.id, 'write', { id: session.id, data: shellCommands.echo('KSF_UTF8_中文') }); await until(/KSF_UTF8_中文\r?\n/);
  await manager.call(instance.id, 'resize', { id: session.id, cols: 101, rows: 33 }); await manager.call(instance.id, 'write', { id: session.id, data: shellCommands.size }); await until(process.platform==='win32'?/33[\s\S]*101|101[\s\S]*33/:/33 101/);
  await manager.call(instance.id, 'write', { id: session.id, data: shellCommands.wait }); await new Promise(resolve => setTimeout(resolve, 150)); await manager.call(instance.id, 'write', { id: session.id, data: '\x03' }); await manager.call(instance.id, 'write', { id: session.id, data: shellCommands.echo('KSF_INTERRUPT_OK') }); await until(/KSF_INTERRUPT_OK\r?\n/);
  if (process.platform === 'darwin') {
    await manager.call(instance.id, 'write', { id: session.id, data: '/usr/bin/vi -u NONE -i NONE -n\r' }); await until(/Vi IMproved/);
    await manager.call(instance.id, 'write', { id: session.id, data: ':q!\r' }); await until(/\x1b\[\?1049l/);
    await manager.call(instance.id, 'write', { id: session.id, data: "printf '\\113\\123\\106_INTERACTIVE_OK\\n'\r" }); await until(/KSF_INTERACTIVE_OK\r?\n/);
  }
  const second = await manager.call(instance.id, 'create', { cols: 60, rows: 20 }); assert.notEqual(second.pid, session.pid);
  await manager.release(instance.id); await assert.rejects(manager.call(instance.id, 'list', {}), { code: 'APP_PROCESS_EXITED' });
});

test('installation identity survives repeated install, upgrade, rollback and restart but changes after uninstall',async t=>{
 const f=await fixture(t);await f.install();const first=(await f.manager.snapshot()).installed[0].installationId;assert.match(first,/^[a-f0-9-]{36}$/);
 await f.install();assert.equal((await f.manager.snapshot()).installed[0].installationId,first);
 const two=release('2.0.0');await writeFile(join(f.store,two.entry.package.url),two.bytes);await f.writeIndex([two.entry]);await f.install(two);
 await f.manager.changeApp('com.example.echo','rollback');assert.equal((await f.manager.snapshot()).installed[0].installationId,first);
 const fresh=createApplicationManager(f.root,{defaultSource:null,storeDirectory:f.store});t.after(()=>fresh.close());assert.equal((await fresh.snapshot()).installed[0].installationId,first);
 await f.manager.changeApp('com.example.echo','uninstall');await f.install(two);assert.notEqual((await f.manager.snapshot()).installed[0].installationId,first);
});
test('legacy installation identity is stable across upgrades without mutating a read',async t=>{
 const f=await fixture(t);await f.install();const path=join(f.root,'.agents/user-data/applications/state.json'),state=JSON.parse(await readFile(path,'utf8'));delete state.installed['com.example.echo'].installationId;await writeFile(path,JSON.stringify(state));
 const before=await readFile(path,'utf8');assert.equal((await f.manager.snapshot()).installed[0].installationId,'legacy:com.example.echo');assert.equal(await readFile(path,'utf8'),before);
 const two=release('2.0.0');await writeFile(join(f.store,two.entry.package.url),two.bytes);await f.writeIndex([two.entry]);await f.install(two);assert.equal((await f.manager.snapshot()).installed[0].installationId,'legacy:com.example.echo');
});


test('persisted legacy installation identity must name this application or a controlled historical alias',async t=>{
 const f=await fixture(t);await f.install();const path=join(f.root,'.agents/user-data/applications/state.json'),state=JSON.parse(await readFile(path,'utf8'));
 state.installed['com.example.echo'].installationId='legacy:com.example.unrelated';await writeFile(path,JSON.stringify(state));await assert.rejects(f.manager.snapshot(),{code:'APP_STATE_INVALID'});
 state.installed['com.example.echo'].installationId='legacy:com.example.echo';await writeFile(path,JSON.stringify(state));assert.equal((await f.manager.snapshot()).installed[0].installationId,'legacy:com.example.echo');
});
