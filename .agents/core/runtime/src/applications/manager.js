import {resolveInstalledApplicationId} from './identity-resolution.js';
import {redactLog} from '../shared/logs.js';
import {platform} from '../platform/index.js';
import {appendFile,stat as fileStat} from 'node:fs/promises';
import {createWorkbenchTerminal} from '../services/workbench-terminal.js';
import {createApplicationStorage} from '../services/application-storage.js';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, rm, lstat, open, readdir } from 'node:fs/promises';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname,relative } from 'node:path';
import {atomicJSON,replaceFile,readJSON as readDurableJSON,safeDirectory as ensureDirectory} from '../shared/durable-json.js';
import { fileURLToPath } from 'node:url';
import { assert, problem, createCoordinator } from '../services/workbench-common.js';
import { DEFAULT_APPLICATION_SOURCE, withDefaultApplicationSource, migrateApplicationOrigins } from './default-source.js';
import {createRegistryResolver} from './registry.js';
import {LEGACY_APPLICATION_IDS} from './identities.js';
import { assertCompatible, validateManifest, validId, validPath, checksum, decodePackage, MAX_PACKAGE, compareVersions, sameManifest, DEFAULT_APPLICATIONS, isOfficialApplicationId,validateStoreListing,groupStoreApplications,storeMediaPath,storeImageType,MAX_STORE_IMAGE,readCLIDocument } from './protocol.js';

const bundledStore = fileURLToPath(new URL('../../../applications/store/', import.meta.url));
const hostPath = fileURLToPath(new URL('./host.js', import.meta.url));
const invalidBackground=message=>{throw problem('APP_BACKGROUND_INVALID',message);};
const readJSON=(path,fallback)=>readDurableJSON(path,fallback,{invalid:invalidBackground});
const safeDirectory=(root,path)=>ensureDirectory(root,path,{invalid:invalidBackground});
const processMayLive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function sourceURL(value) {
  let url; try { url = new URL(value); } catch { throw problem('APP_SOURCE_INVALID', '请填写完整的 HTTP(S) 应用索引地址。'); }
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash, 'APP_SOURCE_INVALID', '应用源只支持不含账号密码的 HTTP(S) 地址。');
  return url.href;
}
async function boundedFetch(url, limit, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'application/json, application/octet-stream, image/png, image/jpeg, image/webp' } });
  assert(response.ok, 'APP_SOURCE_UNAVAILABLE', `应用源返回 HTTP ${response.status}。`, 502);
  assert(Number(response.headers.get('content-length') ?? 0) <= limit, 'APP_DOWNLOAD_TOO_LARGE', '下载内容超过大小上限。');
  const chunks = []; let length = 0;
  try { for await (const chunk of response.body) { length += chunk.length; assert(length <= limit, 'APP_DOWNLOAD_TOO_LARGE', '下载内容超过大小上限。'); chunks.push(Buffer.from(chunk)); } }
  catch (error) { await response.body?.cancel?.().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}
// Config and immutable installed packages belong to the workspace, outside Core updates.
export function createApplicationManager(root, { storeDirectory = bundledStore, fetcher = fetch, services = {}, locks = createCoordinator(), callTimeoutMs = 20000, now = Date.now, defaultSource = DEFAULT_APPLICATION_SOURCE, coreVersion=JSON.parse(readFileSync(new URL('../../../build.json',import.meta.url),'utf8')).version, prepareTimeoutMs=30000, activationTimeoutMs=10000, storageOptions={} } = {}) {
  const home = join(root, '.agents/user-data/applications'), statePath = join(home, 'state.json');
  const terminal=createWorkbenchTerminal(root),storage=createApplicationStorage(root,storageOptions);
  services={...services,terminal,storage};
  const runtimeHome = join(root, '.agents/runtime-data/applications/instances');
  const coordinator = createCoordinator(), instances = new Map(), runtimes = new Map(), logs = new Map();
  // Previewing never executes application code or adds an installation/source.
  const imports = new Map(), importSource = { id: 'local-import', name: '手动导入', url: 'local-import:' };
  const pruneImports = () => { for (const [id, item] of imports) if (item.expiresAt <= now()) imports.delete(id); };
  let disposed = false, bootstrap, backgroundReconcile, backgroundErrors=[];
  const starts=new Map(),startupPromises=new Set(),startupPending=new Map(),startupLocks=createCoordinator();
  const runtimeFinalizers=new Set();
  const taskHistory=[];
  const finishJob=(runtime,id,patch={})=>{const job=runtime.jobs.get(id);if(!job)return;runtime.jobs.delete(id);taskHistory.unshift({...job,...patch,status:patch.status??'succeeded',finishedAt:new Date().toISOString()});taskHistory.splice(100);};
  const parked=new Map(),compatible=manifest=>assertCompatible(manifest,{coreVersion});
  const dataCaller=release=>({appId:release.manifest.id,dataStores:release.manifest.dataStores,releaseDigest:release.digest});
  const dataCheck=async(release,{allowMigration=false}={})=>{compatible(release.manifest);const result=await storage.inspectAll(dataCaller(release));if(!allowMigration||!result.canPrepare)storage.checkReady(result);return result;};
  let accepting=true;const draining=new Set();
  const policyPath=join(root,'.agents/runtime-data/applications/policy.json');
  const runtimePolicy=async()=>{const value=await readJSON(policyPath,{schemaVersion:1,stopped:[],manual:[]});assert(value.schemaVersion===1&&['stopped','manual'].every(key=>Array.isArray(value[key])&&value[key].every(validId)),'APP_RUNTIME_POLICY_INVALID','设备应用运行策略损坏，请保留 policy.json 并检查。');return value;};
  const assertActive=async id=>{assert(accepting&&!draining.has(id),'APP_BUSY','后台正在停止接收新调用。',409);const policy=await runtimePolicy();assert(accepting&&!draining.has(id),'APP_BUSY','后台正在停止接收新调用。',409);assert(!policy.stopped.includes(id),'APP_RUNTIME_STOPPED','应用后台已由用户停止，请先执行 app runtime start。',409);};
  const backgroundPath=join(home,'background'),backgroundLocks=createCoordinator(),restartCounts=new Map();
  async function backgroundHolds(){const applications={};for(const name of await readdir(backgroundPath).catch(e=>{if(e.code==='ENOENT')return [];throw e;}))if(/^[a-z][a-z0-9.-]{1,79}\.json$/.test(name)){const value=await readJSON(join(backgroundPath,name));assert(value.schemaVersion===1&&value.holds&&typeof value.holds==='object'&&!Array.isArray(value.holds),'APP_BACKGROUND_INVALID','持久运行需求损坏，请保留原件。');applications[name.slice(0,-5)]=value.holds;}return {schemaVersion:1,applications};}
  const holdCount=async appId=>Object.keys((await backgroundHolds()).applications[appId]??{}).length;
  function reconcileBackground(){if(disposed)return;clearTimeout(backgroundReconcile);backgroundReconcile=setTimeout(()=>{void startBackground().catch(error=>{backgroundErrors=[{code:error.code??'APP_START_FAILED',message:'应用后台启动失败，请重试并检查诊断。'}];});},0);backgroundReconcile.unref();}
  const initial = () => ({ schemaVersion: 1, revision: 0, sources: withDefaultApplicationSource([], defaultSource), installed: {} });
  async function readState() {
    try {
      const stat = await lstat(statePath); assert(stat.isFile() && !stat.isSymbolicLink(), 'APP_STATE_INVALID', '应用配置必须是普通文件。');
      const value = JSON.parse(await readFile(statePath, 'utf8'));
      assert(value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && Array.isArray(value.sources) && value.installed && typeof value.installed === 'object', 'APP_STATE_INVALID', '应用配置损坏，请保留文件并恢复备份。');
      for (const [id,record] of Object.entries(value.installed)) { assert(record.legacyIds===undefined||Array.isArray(record.legacyIds)&&record.legacyIds.every(old=>Object.hasOwn(LEGACY_APPLICATION_IDS,old)&&(LEGACY_APPLICATION_IDS[old]===id||LEGACY_APPLICATION_IDS[old]===LEGACY_APPLICATION_IDS[id])),'APP_STATE_INVALID','应用历史身份关联无效。');assert(record.installationId===undefined||uuid(record.installationId)||record.installationId===`legacy:${id}`||record.legacyIds?.some(old=>record.installationId===`legacy:${old}`),'APP_STATE_INVALID','应用安装身份无效。'); for (const release of [record.active, record.pending, record.previous].filter(Boolean)) { validateManifest(release.manifest); assert(release.manifest.id===id&&/^[a-f0-9]{64}$/.test(release.digest), 'APP_STATE_INVALID', '已安装应用身份或路径无效。'); } }
      return migrateApplicationOrigins(value, defaultSource);
    } catch (error) { if (error.code === 'ENOENT') return initial(); throw error; }
  }
  async function withStateLock(action) {
    return coordinator.run('state', async () => {
      await mkdir(home, { recursive: true, mode: 0o700 });
      let lock; const lockPath = join(home, '.lock');
      for (let attempt = 0; attempt < 2; attempt++) {
        try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() })); break; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let stale = false, previous;
          try { previous = await readFile(lockPath, 'utf8'); const owner = JSON.parse(previous); if (Number.isSafeInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (probe) { stale = probe.code === 'ESRCH'; } } } catch {}
          if (attempt === 0 && stale && await readFile(lockPath, 'utf8').catch(() => '') === previous) { await rm(lockPath, { force: true }); continue; }
          throw problem('APP_BUSY', '另一个应用管理操作正在进行，或锁的归属无法确认，请稍后重试。', 409);
        }
      }
      try {
        return await action();
      } finally { await lock.close(); await rm(lockPath, { force: true }); }
    });
  }
  async function mutate(action) {
    return withStateLock(async () => {
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        const state = await readState(), before = JSON.stringify(state), result = await action(state);
        if (JSON.stringify(state) === before) return result;
        state.revision++; await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await replaceFile(temporary, statePath); reconcileBackground(); return result;
      }
      finally { await rm(temporary, { force: true }); }
    });
  }
  const directory = release => join(home, 'packages', release.manifest.id, release.digest);
  const running = id => {
    const local = [...instances.values()].filter(item => item.appId === id && !item.closed), known = new Set([...instances.keys(),...[...runtimes.values()].map(runtime=>runtime.id)]);
    let names = []; try { names = readdirSync(runtimeHome); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      if (known.has(name.slice(0, -5))) continue;
      let item; try { item = JSON.parse(readFileSync(join(runtimeHome, name), 'utf8')); } catch { continue; }
      if (item.appId !== id || !Number.isSafeInteger(item.ownerPid)) continue;
      if(processMayLive(item.ownerPid)||processMayLive(item.childPid))local.push({...item,foreign:true});
    }
    return local;
  };
  async function settlePending(state, id) {
    const item = state.installed[id];
    if (!item?.pending) return;
    await dataCheck(item.pending,{allowMigration:true});
    if(starts.has(id)||storage.pending(id))return;
    const active=running(id);
    if(active.some(lease=>lease.foreign||lease.kind!=='card')||[...runtimes.values()].some(runtime=>runtime.appId===id&&(runtime.phase!=='ready'||runtime.jobs.size||runtime.calls.size||storage.pending(runtime.appId))))return;
    // Cards are replaceable surfaces: drain together, then publish the new release.
    for(const lease of active)await stopInstance(lease.id);
    for(const runtime of [...runtimes.values()])if(runtime.appId===id)await stopRuntime(runtime);
    item.previous=item.active;item.active=item.pending;item.pending=null;
  }
  async function snapshot() {
    await ensureDefaults();
    const state = await readState();
    // If Core stopped while an upgrade waited, no old application instance survives it.
    if (Object.entries(state.installed).some(([id, app]) => app.pending)) await mutate(async next => { for (const id of Object.keys(next.installed)) try{await settlePending(next, id);}catch(error){backgroundErrors.push({appId:id,code:error.code??'APP_DATA_INVALID',message:error.message});} });
    const current = await readState();
    return { revision: current.revision, sources: current.sources, installed: Object.entries(current.installed).map(([id, item]) => ({ id, ...item, installationId:item.installationId??`legacy:${id}`, running: running(id).length, assetBase: `/app-assets/${id}/${item.active.digest}/` })), instances: [...instances.values()].map(item => ({ id: item.id, appId: item.appId, digest: item.release.digest, status: item.closed ? 'stopped' : 'running', kind:item.kind, pageId:item.pageId, error: item.error ?? null })) };
  }
  const canonicalSource=defaultSource??DEFAULT_APPLICATION_SOURCE;
  const sourceFreshness=new Map();
  const resolver=createRegistryResolver({directory:storeDirectory,cacheDirectory:join(root,'.agents/runtime-data/applications/registry'),now,offlineOnly:defaultSource===null,fetchIndex:()=>boundedFetch(sourceURL(canonicalSource.url),2*1024*1024,fetcher),validate:(bytes,local)=>parseIndex(bytes,canonicalSource,local)});
  async function parseIndex(bytes,source,local=false) {
    let value;try{value=JSON.parse(bytes);}catch{throw problem('APP_SOURCE_INVALID','应用源索引不是有效 JSON。');}
    assert(value.protocol==='ksf-app-registry-v1'&&Array.isArray(value.apps)&&value.apps.length<=500,'APP_SOURCE_INVALID','应用源索引格式无效。');
    const found=new Set();
    return Promise.all(value.apps.filter(item=>!Object.hasOwn(LEGACY_APPLICATION_IDS,item?.manifest?.id)).map(async item=>{
      validateManifest(item.manifest);validateStoreListing(item.listing);
      assert(!Object.hasOwn(LEGACY_APPLICATION_IDS,item.manifest.id),'APP_ID_RETIRED','此应用身份已经迁移，请使用新的应用 ID。');
      assert(!isOfficialApplicationId(item.manifest.id)||source.id===canonicalSource.id&&source.url===canonicalSource.url,'APP_ID_RESERVED','官方应用只接受 KSF 公用应用源。');
      assert(item.package&&/^[a-f0-9]{64}$/.test(item.package.sha256)&&typeof item.package.url==='string'&&Number.isSafeInteger(item.package.size)&&item.package.size>0&&item.package.size<=MAX_PACKAGE,'APP_SOURCE_INVALID','应用包地址、摘要或大小无效。');
      const key=`${item.manifest.id}@${item.manifest.version}:${item.manifest.target??'*'}:${item.manifest.nodeAbi??'*'}`;assert(!found.has(key),'APP_SOURCE_INVALID','应用源包含重复版本。');found.add(key);
      if(local)assert(/^[a-zA-Z0-9_.-]+\.ksfapp$/.test(item.package.url),'APP_SOURCE_INVALID','离线应用包地址无效。');else sourceURL(new URL(item.package.url,source.url).href);
      let incompatibility=null,dataCompatibility;
      try{compatible(item.manifest);dataCompatibility=await storage.inspectAll({appId:item.manifest.id,dataStores:item.manifest.dataStores});if(!dataCompatibility.canPrepare)incompatibility='当前数据无法用于此版本，请查看数据检查结果。';}catch(e){incompatibility=e.message;}
      return {...item,source:{...source},incompatibility,dataCompatibility};
    }));
  }
  async function index(source,{bundled=false}={}) {
    if(source.id===canonicalSource.id){const result=await resolver.resolve({bundled});sourceFreshness.set(source.id,result.freshness);return result.entries.map(e=>({...e,incompatibility:e.incompatibility??(result.freshness.kind!=='live'&&e.resource==='remote'?'离线时此版本的包尚未保存在本机，恢复连接后可安装。':null),directory:{...result.freshness,latestConfirmed:result.freshness.latestConfirmed&&e.publicationKnown!==false}}));}
    const result=await parseIndex(await boundedFetch(sourceURL(source.url),2*1024*1024,fetcher),source);sourceFreshness.set(source.id,{kind:'live',checkedAt:new Date(now()).toISOString(),latestConfirmed:true});return result;
  }
  async function catalog() {
    await ensureDefaults();
    const state = await readState(), apps = [], errors = [];
    await Promise.all(state.sources.filter(s => s.enabled).map(async source => { try { apps.push(...await index(source)); } catch (error) { errors.push({ sourceId: source.id, name: source.name, message: error.message }); } }));
    const variants = new Map();
    for (const item of apps) { const key = `${item.source.id}:${item.manifest.id}:${item.manifest.version}`, previous = variants.get(key); if (!previous || previous.incompatibility && !item.incompatibility || !previous.incompatibility && !item.incompatibility && (Number(!!item.manifest.target)*2+Number(!!item.manifest.nodeAbi))>(Number(!!previous.manifest.target)*2+Number(!!previous.manifest.nodeAbi))) variants.set(key, item); }
    const hasLegacyCooperation=Object.keys(state.installed).some(id=>['yinbaiyuan.lan-messenger','com.yinbaiyuan.lan-messenger'].includes(id));
    const selected = [...variants.values()].map(e=>hasLegacyCooperation&&e.manifest.id==='com.ksf.cooperation-center'?{...e,incompatibility:'需先通过配套迁移接续旧内网通信的消息与配对。'}:e); selected.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || compareVersions(b.manifest.version, a.manifest.version));
    const applications=groupStoreApplications(selected,state.sources,state.installed,errors).map(app=>({...app,directory:sourceFreshness.get(app.display.source.id)??null,latestPublishedVersion:sourceFreshness.get(app.display.source.id)?.latestConfirmed?app.latestPublishedVersion:null})).map(app=>state.installed[app.appId]?.active.source.id==='local-import'?{...app,candidate:null,latestPublishedVersion:null,unavailableReason:null}:app);
    return { apps: selected, applications,errors, directories:Object.fromEntries(sourceFreshness) };
  }
  async function saveSource(input) {
    assert(input.id !== canonicalSource.id, 'APP_SOURCE_LOCKED', 'KSF 公用应用源不可编辑或停用。', 403);
    return mutate(state => {
      assert(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.trim().length <= 80 && typeof input.enabled === 'boolean', 'APP_SOURCE_INVALID', '应用源名称或启用状态无效。');
      const url = sourceURL(input.url), id = input.id ?? randomUUID();
      assert(uuid(id) && !state.sources.some(s => s.url === url && s.id !== id), 'APP_SOURCE_INVALID', '应用源已存在或标识无效。');
      const item = { id, name: input.name.trim(), url, enabled: input.enabled }, at = state.sources.findIndex(s => s.id === id);
      if (at < 0) { assert(!input.id && state.sources.length < 32, 'APP_SOURCE_INVALID', '应用源不存在或已达到数量上限。'); state.sources.push(item); } else state.sources[at] = item;
      return item;
    });
  }
  async function removeSource(id) { assert(id !== canonicalSource.id, 'APP_SOURCE_LOCKED', 'KSF 公用应用源不可移除。', 403);return mutate(state => { assert(id !== 'builtin' && state.sources.some(s => s.id === id), 'APP_SOURCE_INVALID', '无法移除此应用源。'); state.sources = state.sources.filter(s => s.id !== id); }); }
  async function install(input, { bundled = false } = {}) {
    assert(input.trusted === true && /^[a-f0-9]{64}$/.test(input.digest), 'APP_TRUST_REQUIRED', '请先核对应用来源和权限，并确认信任此应用。');
    const before = await readState(), source = before.sources.find(s => s.id === (input.sourceId==='builtin'?canonicalSource.id:input.sourceId) && s.enabled);
    assert(input.appId!=='com.ksf.cooperation-center'||!Object.keys(before.installed).some(id=>['yinbaiyuan.lan-messenger','com.yinbaiyuan.lan-messenger'].includes(id)),'APP_ID_MIGRATION_REQUIRED','请先完成合作中心身份迁移，以保留现有消息、安装与配对，不能并列安装。',409);
    assert(source, 'APP_SOURCE_MISSING', '应用源已移除或停用，请刷新商店。', 409);
    const sourceEntries=await index(source,{bundled}),item = sourceEntries.find(i => i.manifest.id === input.appId && i.manifest.version === input.version && i.package.sha256 === input.digest);
    assert(item, 'APP_RELEASE_CHANGED', '应用源中的版本已变化，请刷新并重新核对。', 409); compatible(item.manifest);
    const installed=before.installed[input.appId];
    assert(!installed || installed.active.source.id===source.id,'APP_SOURCE_CHANGED','更新须使用原安装源；更换来源请先卸载并核对数据兼容。',409);
    const eligible=sourceEntries.filter(e=>e.manifest.id===input.appId&&!e.incompatibility).sort((a,b)=>compareVersions(b.manifest.version,a.manifest.version)||Number(!!b.manifest.target)-Number(!!a.manifest.target)||Number(!!b.manifest.nodeAbi)-Number(!!a.manifest.nodeAbi));
    assert(eligible[0]?.package.sha256===item.package.sha256 && (!installed||compareVersions(item.manifest.version,installed.pending?.manifest.version??installed.active.manifest.version)>=0),'APP_RELEASE_CHANGED','此版本已不是最新兼容版本，请刷新商店后重新核对。',409);
    if(!installed&&!bundled){const others=(await Promise.all(before.sources.filter(s=>s.enabled&&s.id!==source.id).map(s=>index(s).catch(()=>[])))).flat();assert(!others.some(e=>e.manifest.id===input.appId&&!e.incompatibility&&compareVersions(e.manifest.version,item.manifest.version)>0),'APP_RELEASE_CHANGED','已有更高的兼容版本，请刷新商店后重新核对来源。',409);}
    const bytes = item.resource === 'baseline' ? await readFile(join(storeDirectory, item.baselinePackage??item.package.url)) : await boundedFetch(sourceURL(new URL(item.package.url, source.url).href), MAX_PACKAGE, fetcher);
    assert(bytes.length === item.package.size && checksum(bytes) === item.package.sha256, 'APP_PACKAGE_INTEGRITY', '应用包大小或 SHA256 校验失败。');
    const decoded = decodePackage(bytes); assert(sameManifest(decoded.manifest, item.manifest), 'APP_PACKAGE_INTEGRITY', '应用包与安装前展示的声明不一致。');
    const latest=(await index(source,{bundled})).filter(e=>e.manifest.id===input.appId&&!e.incompatibility).sort((a,b)=>compareVersions(b.manifest.version,a.manifest.version));
    assert(latest.some(e=>e.package.sha256===item.package.sha256)&&latest[0]?.manifest.version===item.manifest.version,'APP_RELEASE_CHANGED','下载期间应用目录已更新，请重新核对最新版本。',409);
    return commitPackage(decoded,item.package.sha256,source,state=>{
      assert(state.sources.some(s => s.id === source.id && s.enabled && s.url === source.url), 'APP_SOURCE_CHANGED', '安装期间应用源配置已变化，请重试。', 409);
      const existing=state.installed[input.appId];
      assert(!existing || existing.active.source.id===source.id,'APP_SOURCE_CHANGED','安装期间应用来源已变化，请刷新后重试。',409);
    });
  }
  function history(manifest) {
    const parent=join(home,'packages',manifest.id);let names=[];
    try{names=readdirSync(parent);}catch(error){if(error.code!=='ENOENT')throw error;}
    return names.filter(name=>/^[a-f0-9]{64}$/.test(name)).map(name=>JSON.parse(readFileSync(join(parent,name,'release.json'),'utf8')).release);
  }
  function checkVersionHistory(manifest,digest,{latest=false}={}) {
    for(const prior of history(manifest)){
      const a=prior.manifest,b=manifest;
      assert(prior.digest===digest||a.version!==b.version||a.target!==b.target||a.nodeAbi!==b.nodeAbi,'APP_VERSION_REUSED','已安装过的同一版本对应不同内容，请让开发者发布新版本。',409);
      if(latest){let supported=true;try{compatible(a);}catch{supported=false;}
        assert(!supported||compareVersions(b.version,a.version)>=0,'APP_RELEASE_CHANGED','本机已安装过更高版本，请导入最新应用包；故障回退请使用高级管理。',409);
      }
    }
  }
  function importAction(state,manifest,digest) {
    assert(!Object.hasOwn(LEGACY_APPLICATION_IDS,manifest.id),'APP_ID_RETIRED','此应用身份已迁移，不能重复安装。');
    assert(!isOfficialApplicationId(manifest.id),'APP_ID_RESERVED','此应用标识仅供 KSF 随包应用使用，不能手动导入。');
    const local=state.installed[manifest.id];
    assert(!local||local.active.source.id==='local-import','APP_SOURCE_CHANGED',`此应用来自“${local?.active.source.name}”，请从原源更新；改为手动导入需先卸载并核对数据兼容。`,409);
    checkVersionHistory(manifest,digest,{latest:true});
    if(local?.pending){assert(local.pending.digest===digest,'APP_UPDATE_PENDING','此应用已有新版本等待切换，请关闭旧窗口并等待任务完成。',409);return 'pending';}
    assert(!local||compareVersions(manifest.version,local.active.manifest.version)>=0,'APP_RELEASE_CHANGED','不能通过导入安装旧版本，请使用最新应用包。',409);
    return !local?'install':local.active.digest===digest?'installed':'update';
  }
  async function prepareImport(bytes,fileName) {
    assert(!disposed,'APP_HOST_CLOSED','应用宿主已停止。',503);
    assert(typeof fileName==='string'&&fileName.length<=240&&/\.ksfapp$/i.test(fileName)&&!/[\\/\u0000-\u001f]/.test(fileName),'APP_IMPORT_INVALID','请选择 .ksfapp 应用包。');
    assert(Buffer.isBuffer(bytes)&&bytes.length>0,'APP_IMPORT_INVALID','应用包为空。');
    assert(bytes.length<=MAX_PACKAGE,'APP_PACKAGE_TOO_LARGE','应用包不能超过 32 MiB。',413);
    const {manifest}=decodePackage(bytes);compatible(manifest);
    const digest=checksum(bytes),state=await readState(),action=importAction(state,manifest,digest),dataCompatibility=await storage.inspectAll({appId:manifest.id,dataStores:manifest.dataStores});
    pruneImports();assert(imports.size<8&&[...imports.values()].reduce((size,item)=>size+item.bytes.length,bytes.length)<=64*1024*1024,'APP_IMPORT_LIMIT','待确认的应用包过多，请取消其他导入或稍后重试。',429);
    const importId=randomUUID(),expiresAt=now()+15*60*1000;
    imports.set(importId,{bytes:Buffer.from(bytes),digest,expiresAt,currentDigest:state.installed[manifest.id]?.active.digest??null,currentPending:state.installed[manifest.id]?.pending?.digest??null});
    return {importId,fileName,expiresAt,action,currentVersion:state.installed[manifest.id]?.active.manifest.version??null,manifest,source:{...importSource,enabled:true},package:{size:bytes.length,sha256:digest,url:fileName},dataCompatibility,incompatibility:dataCompatibility.canPrepare?null:'当前数据无法用于此版本。'};
  }
  async function discardImport(importId){assert(uuid(importId),'APP_IMPORT_INVALID','导入凭据无效。');imports.delete(importId);}
  async function installImport(input) {
    assert(input.trusted===true,'APP_TRUST_REQUIRED','请先核对应用来源和权限，并确认信任此应用。');
    pruneImports();const item=imports.get(input.importId);assert(item,'APP_IMPORT_EXPIRED','导入预览已过期或服务已重启，请重新选择应用包。',410);
    assert(input.digest===item.digest&&checksum(item.bytes)===item.digest,'APP_IMPORT_CHANGED','导入内容与确认信息不一致，请重新选择应用包。',409);
    const decoded=decodePackage(item.bytes);compatible(decoded.manifest);
    return commitPackage(decoded,item.digest,importSource,state=>{
      const local=state.installed[decoded.manifest.id],action=importAction(state,decoded.manifest,item.digest);
      assert(['installed','pending'].includes(action)||((local?.active.digest??null)===item.currentDigest&&(local?.pending?.digest??null)===item.currentPending),'APP_RELEASE_CHANGED','确认期间本机应用版本已变化，请重新选择应用包核对。',409);
    });
  }
  async function commitPackage(decoded,digest,source,checkState) {
    const appId=decoded.manifest.id,release = { manifest: decoded.manifest, digest, source: { id: source.id, name: source.name, url: source.url }, installedAt: new Date().toISOString() };
    const target = directory(release), staging = join(home, 'staging', randomUUID());
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      for (const [path, file] of decoded.files) { const out = join(staging, path); await mkdir(dirname(out), { recursive: true, mode: 0o700 }); await writeFile(out, file.data, { mode: file.mode }); }
      await writeFile(join(staging, 'release.json'), JSON.stringify({ release, files: Object.fromEntries([...decoded.files].map(([path, file]) => [path, { sha256: file.sha256, mode: file.mode }])) }), { mode: 0o600 });
      return await mutate(async state => {
        checkState(state);
        await dataCheck(release,{allowMigration:true});
        const existing = state.installed[appId];
        assert(!existing || compareVersions(release.manifest.version,existing.pending?.manifest.version??existing.active.manifest.version)>=0,'APP_RELEASE_CHANGED','已有更新版本正在使用或等待切换。',409);
        // Immutable versions include pending, rollback and retained uninstalled releases.
        checkVersionHistory(release.manifest,release.digest);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const present=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(present)await verifyRelease(release);
        else try { await rename(staging, target); } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; await verifyRelease(release); }
        const previous = existing ?? { installationId:randomUUID(), enabled: true, active: release, previous: null, pending: null };
        if (existing?.active.digest !== release.digest && (starts.has(appId)||running(appId).length||[...runtimes.values()].some(runtime=>runtime.appId===appId&&(runtime.phase!=='ready'||runtime.jobs.size||runtime.calls.size||storage.pending(runtime.appId))))) previous.pending = release;
        else { if (existing && existing.active.digest !== release.digest) {previous.previous = previous.active;for(const runtime of [...runtimes.values()])if(runtime.appId===appId)await stopRuntime(runtime);} previous.active = release; previous.pending = null; }
        state.installed[appId] = previous;
        await settlePending(state,appId);
        return { pending: !!previous.pending, release };
      });
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async function ensureDefaults(){
    if(bootstrap)return bootstrap;
    bootstrap=(async()=>{
      await withStateLock(async()=>{
        let bytes;try{bytes=await readFile(statePath);}catch(e){if(e.code==='ENOENT')return;throw e;}
        const original=JSON.parse(bytes),next=migrateApplicationOrigins(original,defaultSource);
        if(JSON.stringify(original)!==JSON.stringify(next)){
          const backup=join(home,'backups','source-unification-'+checksum(bytes)+'.json');await mkdir(dirname(backup),{recursive:true});await writeFile(backup,bytes,{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
          next.revision++;await atomicJSON(statePath,next);
        }
      });
      const state=await readState();
      const legacyCooperation=Object.keys(state.installed).some(id=>['yinbaiyuan.lan-messenger','com.yinbaiyuan.lan-messenger'].includes(id));
      const missing=DEFAULT_APPLICATIONS.filter(id=>!state.defaults?.includes(id)&&!(legacyCooperation&&id==='com.ksf.cooperation-center'));
      if(!missing.length)return;
      const source=state.sources.find(item=>item.id===canonicalSource.id);
      const entries=await index(source,{bundled:true});
      // Validate all candidates first. Test stores without bundled defaults are supported.
      const selected=missing.map(id=>entries.filter(item=>item.manifest.id===id&&!item.incompatibility).sort((a,b)=>compareVersions(b.manifest.version,a.manifest.version))[0]).filter(Boolean);
      for(const entry of selected){const bytes=await readFile(join(storeDirectory,entry.package.url));assert(bytes.length===entry.package.size&&checksum(bytes)===entry.package.sha256,'APP_PACKAGE_INTEGRITY','随包应用完整性校验失败。');decodePackage(bytes);}
      for(const entry of selected){
        if(!(await readState()).installed[entry.manifest.id])await install({appId:entry.manifest.id,sourceId:canonicalSource.id,version:entry.manifest.version,digest:entry.package.sha256,trusted:true},{bundled:true});
        await mutate(next=>{next.defaults=[...new Set([...(next.defaults??[]),entry.manifest.id])];});
      }
    })().catch(error=>{bootstrap=undefined;throw error;});
    return bootstrap;
  }
  async function verifyRelease(release) {
    const base = directory(release), info = JSON.parse(await readFile(join(base, 'release.json'), 'utf8'));
    assert(info.release.digest === release.digest && sameManifest(info.release.manifest, release.manifest), 'APP_PACKAGE_INTEGRITY', '已安装应用的声明已改变，请重新安装。');
    for (const [path, file] of Object.entries(info.files)) {
      assert(validPath(path), 'APP_PACKAGE_INTEGRITY', '已安装应用路径无效。');
      let current = base;
      for (const part of path.split('/')) { current = join(current, part); assert(!(await lstat(current)).isSymbolicLink(), 'APP_PACKAGE_INTEGRITY', '已安装应用不能包含符号链接。'); }
      assert(checksum(await readFile(current)) === file.sha256, 'APP_PACKAGE_INTEGRITY', '已安装应用的文件完整性校验失败。');
    }
    return info;
  }
  async function asset(id, digest, path) {
    assert(validPath(path) && path.startsWith('frontend/') && /\.(m?js|css|svg|png|jpe?g|woff2?|ttf|json|txt)$/.test(path), 'APP_ASSET_NOT_FOUND', '应用资源不存在。', 404);
    const state = await readState(), app = state.installed[id];
    const release = [app?.active, app?.pending, app?.previous, ...running(id).map(i => i.release)].find(r => r?.digest === digest);
    assert(release && app.enabled, 'APP_ASSET_NOT_FOUND', '应用资源不存在。', 404);
    const base = directory(release), info = JSON.parse(await readFile(join(base, 'release.json'), 'utf8'));
    assert(info.files[path], 'APP_ASSET_NOT_FOUND', '应用资源不在已安装清单中。', 404);
    let file = base; for (const part of path.split('/')) { file = join(file, part); assert(!(await lstat(file)).isSymbolicLink(), 'APP_PACKAGE_INTEGRITY', '应用资源路径无效。'); }
    const bytes = await readFile(file); assert(checksum(bytes) === info.files[path].sha256, 'APP_PACKAGE_INTEGRITY', '应用资源完整性校验失败。');
    const ext = path.split('.').at(-1), types = { js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', json: 'application/json', txt: 'text/plain' };
    return { bytes, type: types[ext] };
  }
  const serializeError=error=>({code:error.code??'APP_CALL_FAILED',message:error.message,status:error.status,data:error.data});
  async function runtimeService(runtime,message){
    const reply=(value,error)=>{if(runtime.child?.connected)runtime.child.send({type:'service-result',id:message.id,value,error});};
    try{
      let value;
      assert(!runtime.closed,'APP_PROCESS_EXITED','应用进程已经停止。',410);
      if(runtime.phase==='preparing')assert(message.service==='storage'&&['read','inspect','migrate','ready'].includes(message.method)||message.service==='runtime'&&['lock','unlock'].includes(message.method),'APP_DATA_PREPARE_RESTRICTED','数据准备阶段只能使用存储和锁。',403);
      if(message.service==='storage'&&message.method==='ready'){assert(runtime.phase==='preparing','APP_DATA_PREPARE_RESTRICTED','数据准备已经结束。');storage.checkReady(await storage.inspectAll(dataCaller(runtime.release)));runtime.phase='activating';reply(true);return;}
      if(message.service==='storage'&&message.method==='migrate')assert(runtime.phase==='preparing','APP_DATA_MIGRATION_PHASE','数据迁移只能在 prepareData 阶段执行。',409);
      if(message.service==='runtime'){
        const [argument]=message.params??[];
        if(message.method==='retain'){
          assert(accepting&&!draining.has(runtime.appId),'APP_BUSY','后台正在停止。',409);
          assert(argument===undefined||argument&&typeof argument==='object'&&!Array.isArray(argument)&&Object.keys(argument).every(k=>['name','cancellable'].includes(k)),'APP_CALL_INVALID','后台任务描述无效。');
          assert(argument?.name===undefined||typeof argument.name==='string'&&argument.name.trim().length>0&&argument.name.length<=200,'APP_CALL_INVALID','任务名称需要 1 至 200 个字符。');
          assert(argument?.cancellable===undefined||typeof argument.cancellable==='boolean','APP_CALL_INVALID','任务取消设置无效。');
          value=randomUUID();runtime.jobs.set(value,{id:'job:'+runtime.id+':'+value,token:value,kind:'background',appId:runtime.appId,runtimeId:runtime.id,name:argument?.name??'应用后台任务',status:'running',startedAt:new Date().toISOString(),cancellable:argument?.cancellable===true,revision:1});
        }
        else if(message.method==='release'){const id=typeof argument==='string'?argument:argument?.token;finishJob(runtime,id,typeof argument==='object'?{status:['succeeded','failed','cancelled'].includes(argument.status)?argument.status:'failed',...(argument.error?{error:{message:String(argument.error).slice(0,400)}}:{})}:{});}
        else if(message.method==='lock'){
          assert(typeof argument==='string'&&argument.length<=4096,'APP_CALL_INVALID','资源锁标识无效。');
          value=await new Promise((resolve,reject)=>{void locks.run(argument,()=>new Promise(done=>{const token=randomUUID();runtime.locks.set(token,done);resolve(token);})).catch(reject);});
          if(runtime.closed){runtime.locks.get(value)?.();runtime.locks.delete(value);throw problem('APP_PROCESS_EXITED','应用已停止。');}
        }else if(message.method==='unlock'){runtime.locks.get(argument)?.();runtime.locks.delete(argument);}
        else throw problem('APP_SERVICE_UNKNOWN','未知运行时服务。');
      }else if(message.service==='background'){
        assert(runtime.release.manifest.permissions.includes('background'),'APP_PERMISSION_REQUIRED','应用没有声明持久后台能力。',403);
        const [argument]=message.params??[];value=await backgroundLocks.run(runtime.appId,async()=>{
          const path=join(backgroundPath,runtime.appId+'.json'),record=await readJSON(path,{schemaVersion:1,holds:{}});
          if(message.method==='list')return record.holds;
          assert(['retain','release'].includes(message.method),'APP_SERVICE_UNKNOWN','未知后台操作。');
          const key=message.method==='retain'?argument?.key:argument;assert(typeof key==='string'&&key.length>0&&key.length<=128&&!/[\u0000-\u001f]/.test(key),'APP_BACKGROUND_INVALID','持久运行 key 无效。');
          if(message.method==='retain'){assert(typeof argument.reason==='string'&&argument.reason.length<=200,'APP_BACKGROUND_INVALID','运行原因无效。');Object.defineProperty(record.holds,key,{value:{reason:argument.reason},enumerable:true,writable:true,configurable:true});}else delete record.holds[key];
          await safeDirectory(root,backgroundPath);await atomicJSON(path,record);runtime.persistent=Object.keys(record.holds).length;return {key,retained:message.method==='retain'};
        });
      }else{
        const service=services[message.service], action=service?.[message.method];
        assert(typeof action==='function'&&Object.hasOwn(service,message.method),'APP_SERVICE_UNKNOWN','应用请求了未知公共服务。');
        if(message.service==='terminal'){assert(['create','list','read','write','resize','close'].includes(message.method)&&runtime.release.manifest.permissions.includes('shell'),'APP_PERMISSION_REQUIRED','此应用没有声明 shell 权限。',403);assert(runtime.clients.has(message.caller?.instanceId)&&!instances.get(message.caller.instanceId)?.closed,'APP_PROCESS_EXITED','终端窗口租约已失效。',410);}
        if(message.service==='storage')assert(['read','write','inspect','migrate'].includes(message.method),'APP_SERVICE_UNKNOWN','未知存储方法。');
        if(message.service==='capabilities')assert(message.method==='read'&&runtime.release.manifest.permissions.includes('filesystem'),'APP_PERMISSION_REQUIRED','此应用没有声明能力读取所需的 filesystem 权限。',403);
        if(message.service==='tasks'&&message.method!=='activity')assert(runtime.release.manifest.permissions.includes('filesystem'),'APP_PERMISSION_REQUIRED','此应用没有声明证据读取所需的 filesystem 权限。',403);
        if(message.service==='projects')assert(runtime.release.manifest.permissions.includes('filesystem')||runtime.release.manifest.permissions.includes('projects.read')&&['list','read'].includes(message.method),'APP_PERMISSION_REQUIRED','此应用没有声明 filesystem 权限。',403);
        if(message.service==='git')assert(runtime.release.manifest.permissions.includes('shell')&&runtime.release.manifest.permissions.includes('filesystem'),'APP_PERMISSION_REQUIRED','此应用没有声明 Git 所需权限。',403);
        if(message.service==='workflows')assert(runtime.release.manifest.permissions.includes('workflows.invoke'),'APP_PERMISSION_REQUIRED','此应用没有声明工作流调用权限。',403);
        if(message.service==='cooperation')assert(runtime.release.manifest.permissions.includes('cooperation.request')&&runtime.release.manifest.workflows?.contractVersion===1,'APP_PERMISSION_REQUIRED','此应用没有声明流程任务发起权限。',403);
        if(message.service==='codex-conversations')assert(runtime.release.manifest.permissions.includes('codex-conversations'),'APP_PERMISSION_REQUIRED','此应用没有声明 codex-conversations 权限。',403);
        if(['messages','peers'].includes(message.service))assert(runtime.release.manifest.permissions.includes(message.service==='peers'||['send','registerFile','material','status','reconcile','cancel'].includes(message.method)?'messages.send':'messages.receive'),'APP_PERMISSION_REQUIRED','此应用没有声明所需通信权限。',403);
        value=['ai','codex-conversations','messages','peers','terminal','storage','workflows','cooperation'].includes(message.service)
          ? await action(Object.freeze({appId:runtime.appId,version:runtime.release.manifest.version,releaseDigest:runtime.release.digest,dataStores:runtime.release.manifest.dataStores,runtimeId:runtime.id,instanceId:message.caller?.instanceId,source:message.caller?.source,humanWindow:message.caller?.source==='surface'&&instances.get(message.caller?.instanceId)?.kind==='window'&&runtime.clients.has(message.caller?.instanceId)}),...(message.params??[]))
          : await action(...(message.params??[]));
      }
      reply(value);if(!disposed&&['runtime','background'].includes(message.service)&&message.method==='release'){void idleRuntime(runtime);void mutate(state=>settlePending(state,runtime.appId)).catch(()=>{});}
    }catch(error){reply(undefined,serializeError(error));}
  }
  async function startRuntime(appId,release,key,reason='on-demand'){
    assert(!running(appId).some(item=>item.foreign),'APP_OTHER_HOST_RUNNING','此后台应用已在另一个工作台进程中运行。',409);
    try{await dataCheck(release,{allowMigration:true});}catch(error){if(error.code?.startsWith('APP_DATA_'))parked.set(appId,{digest:release.digest,code:error.code,message:error.message});throw error;}
    const runtime={id:randomUUID(),appId,release,reason,phase:'preparing',background:release.manifest.backend?.lifecycle==='resident',clients:new Set(),jobs:new Map(),locks:new Map(),calls:new Map(),next:0,closed:false};runtimes.set(key,runtime);runtime.key=key;runtime.persistent=await holdCount(appId);runtime.startedAt=Date.now();
    const dataDirectory=join(home,'data',appId),runtimeDataDirectory=join(root,'.agents/runtime-data/applications/data',appId);await safeDirectory(root,dataDirectory);await safeDirectory(root,runtimeDataDirectory);
    const env=release.manifest.permissions.includes('environment')?{...process.env}:Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR','TMP','TEMP','SYSTEMROOT','COMSPEC','PATHEXT','USERPROFILE','APPDATA','LOCALAPPDATA'].includes(key.toUpperCase())));
    const child=fork(hostPath,[],{execArgv:[],env,stdio:['ignore','pipe','pipe','ipc'],cwd:directory(release)});runtime.child=child;
    try{runtime.processStart=platform.processStart(child.pid);}catch{}
    const childClosed=new Promise(resolve=>child.once('close',resolve));
    await mkdir(runtimeHome,{recursive:true,mode:0o700});
    await writeFile(join(runtimeHome,`${runtime.id}.json`),JSON.stringify({id:runtime.id,appId,digest:release.digest,ownerPid:process.pid,childPid:child.pid,createdAt:new Date().toISOString(),kind:'runtime'}),{mode:0o600});
    let logQueue=Promise.resolve();const log=data=>{const text=redactLog(data);logs.set(appId,((logs.get(appId)??'')+text).slice(-16000));logQueue=logQueue.then(async()=>{const path=join(root,'.agents/runtime-data/applications/logs',appId+'.log');await mkdir(dirname(path),{recursive:true});if((await fileStat(path).catch(()=>({size:0}))).size>2*1024*1024)await rename(path,path+'.1');await appendFile(path,text,{mode:0o600});}).catch(()=>{});};child.stdout.on('data',log);child.stderr.on('data',log);
    // exit removes crashed runtimes from the live map before stdio and queued
    // log writes finish. Keep their finalizers until close has drained both.
    const finalized=childClosed.then(()=>logQueue);runtimeFinalizers.add(finalized);
    void finalized.finally(()=>runtimeFinalizers.delete(finalized));
    let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    let timer=setTimeout(()=>rejectReady(problem('APP_DATA_PREPARE_TIMEOUT','应用数据准备超时。',504)),prepareTimeoutMs);
    child.on('message',message=>{
      if(message.type==='phase'&&message.phase==='activating'){clearTimeout(timer);timer=setTimeout(()=>rejectReady(problem('APP_START_TIMEOUT','应用后端启动超时。',504)),activationTimeoutMs);}
      if(message.type==='ready'){runtime.phase='ready';parked.delete(appId);resolveReady();}
      if(message.type==='failed'){const e=message.error??{code:'APP_START_FAILED',message:message.message};runtime.preparationFailed=runtime.phase==='preparing'||e.code.startsWith('APP_DATA_');rejectReady(problem(e.code,e.message,e.status??502,e.data));}
      if(message.type==='service')void runtimeService(runtime,message);
      if(message.type==='result'){const pending=runtime.calls.get(message.id);if(pending){clearTimeout(pending.timer);runtime.calls.delete(message.id);message.error?pending.reject(Object.assign(new Error(message.error.message),message.error)):pending.resolve(message.value);void idleRuntime(runtime).then(async()=>{if(disposed)return;const state=await readState();if(!disposed&&state.installed[runtime.appId]?.pending)await mutate(next=>settlePending(next,runtime.appId));}).catch(()=>{});}}
    });
    child.on('error',error=>{runtime.error=error.message;rejectReady(problem('APP_START_FAILED',error.message,502));});
    child.on('exit',(code,signal)=>{
      log(`[${new Date().toISOString()}] EXIT pid=${child.pid} code=${code} signal=${signal??''} intentional=${!!runtime.stopping}\n`);
      void terminal.release({runtimeId:runtime.id}).catch(()=>{});
      const intentional=!!runtime.stopping;runtime.closed=true;runtime.error??='应用后端已退出，请重新启动。';try{unlinkSync(join(runtimeHome,`${runtime.id}.json`));}catch{}
      for(const id of runtime.clients){const item=instances.get(id);if(item){item.closed=true;item.error=runtime.error;}}
      for(const pending of runtime.calls.values()){clearTimeout(pending.timer);pending.reject(problem('APP_PROCESS_EXITED',runtime.error,502,{outcomeUnknown:true}));}runtime.calls.clear();
      for(const done of runtime.locks.values())done();runtime.locks.clear();for(const id of runtime.jobs.keys())finishJob(runtime,id,{status:intentional?'cancelled':'failed',error:{message:intentional?'所属应用后台已停止。':'应用后台异常退出。'}});if(runtimes.get(key)===runtime)runtimes.delete(key);rejectReady(problem('APP_PROCESS_EXITED',runtime.error,502));
      if(!disposed&&!intentional&&!runtime.preparationFailed&&runtime.phase!=='preparing'&&(runtime.manual||runtime.persistent||runtime.background)){const count=Date.now()-runtime.startedAt>60000?1:(restartCounts.get(appId)??0)+1;restartCounts.set(appId,count);if(count<=5){clearTimeout(backgroundReconcile);backgroundReconcile=setTimeout(()=>{void startBackground().catch(()=>{});},Math.min(60000,1000*2**count));backgroundReconcile.unref();}else backgroundErrors.push({appId,code:'APP_BACKGROUND_PARKED',message:'应用连续异常退出，自动恢复已停放，请检查后重试。'});}
    });
    child.send({type:'init',manifest:release.manifest,directory:directory(release),dataDirectory,runtimeDataDirectory,workspace:root,resumePersistent:runtime.persistent>0});
    try{await ready;}catch(error){if(runtime.phase==='preparing'||runtime.preparationFailed||error.code?.startsWith('APP_DATA_')){runtime.preparationFailed=true;parked.set(appId,{digest:release.digest,code:error.code,message:error.message});}await stopRuntime(runtime);throw error;}finally{clearTimeout(timer);}
    log(`[${new Date().toISOString()}] READY pid=${child.pid} lifecycle=${release.manifest.backend.lifecycle} reason=${reason}\n`);
    return runtime;
  }
  async function stopRuntime(runtime){
    if(runtime.stopping)return runtime.stopping;
    runtime.stopping=(async()=>{
      runtime.closed=true;await storage.wait(runtime.appId);await terminal.release({runtimeId:runtime.id});
      if(runtime.child&&runtime.child.exitCode===null&&runtime.child.signalCode===null)await new Promise(resolve=>{
        const timer=setTimeout(()=>runtime.child.kill('SIGKILL'),1500);runtime.child.once('exit',()=>{clearTimeout(timer);resolve();});
        if(runtime.child.connected)runtime.child.send({type:'close'},()=>{});else runtime.child.kill('SIGTERM');
      });
      if(runtimes.get(runtime.key)===runtime)runtimes.delete(runtime.key);await rm(join(runtimeHome,`${runtime.id}.json`),{force:true});
    })();return runtime.stopping;
  }
  async function idleRuntime(runtime){
    // A launch has reserved its instance before startup and policy revalidation
    // finish. That reservation pins the backend until the client lease attaches.
    const preparing=[...instances.values()].some(instance=>instance.preparing&&!instance.closed&&instance.appId===runtime.appId&&instance.release.digest===runtime.release.digest);
    if(!preparing&&runtime.phase==='ready'&&!storage.pending(runtime.appId)&&!runtime.manual&&!runtime.background&&!runtime.persistent&&!runtime.clients.size&&!runtime.jobs.size&&!runtime.calls.size&&!runtime.closed)await stopRuntime(runtime);
  }
  async function startBackground(){try{return await startBackgroundInternal();}catch(error){backgroundErrors=[{code:error.code??'APP_START_FAILED',message:'后台协调失败，请检查应用诊断并重试。'}];throw error;}}
  async function startBackgroundInternal(){
    assert(!disposed,'APP_HOST_CLOSED','应用宿主已停止。',503);
    // Boot only already-installed background applications. Merely opening the
    // workbench must not install defaults or create files in a fresh root.
    const installed=await readState(),holds=await backgroundHolds(),policy=await runtimePolicy();
    const eligibleApp=(id,app)=>parked.get(id)?.digest!==app.active.digest&&app.enabled&&!policy.stopped.includes(id)&&!draining.has(id)&&(restartCounts.get(id)??0)<=5&&(app.active.manifest.backend?.lifecycle==='resident'||Object.keys(holds.applications[id]??{}).length>0||policy.manual.includes(id));
    const foreign=Object.entries(installed.installed).filter(([id,app])=>eligibleApp(id,app)&&running(id).some(item=>item.foreign));
    const eligible=Object.entries(installed.installed).filter(([id,app])=>eligibleApp(id,app));if(foreign.length&&foreign.length===eligible.length)return {errors:backgroundErrors=foreign.map(([appId])=>({appId,code:'APP_OTHER_HOST_RUNNING',message:'此后台应用已在另一个工作台进程中运行。'}))};
    if(!eligible.length)return {errors:backgroundErrors=[...parked.entries()].map(([appId,e])=>({appId,...e}))};
    if(disposed)return {errors:[]};
    const selected=await withStateLock(async()=>{
      if(disposed)return {errors:[],pending:[]};const state=await readState(),errors=[],pending=[];
      for(const [appId,app] of Object.entries(state.installed))if(eligibleApp(appId,app)){
        if(foreign.some(([id])=>id===appId)){errors.push({appId,code:'APP_OTHER_HOST_RUNNING',message:'此后台应用已在另一个工作台进程中运行。'});continue;}const key=`${appId}@${app.active.digest}`;if(starts.has(appId)){const promise=startupPending.get(key);if(promise)pending.push({appId,promise});continue;}if(runtimes.get(key)&&!runtimes.get(key).closed)continue;
        try{compatible(app.active.manifest);await verifyRelease(app.active);pending.push({appId,promise:managedStart(appId,app.active,(restartCounts.get(appId)??0)>0?'crash-recovery':policy.manual.includes(appId)?'manual-resume':app.active.manifest.backend.lifecycle==='resident'?'resident':'persistent-resume')});}catch(error){errors.push({appId,code:error.code??'APP_START_FAILED',message:error.message});}
      }
      return {errors,pending};
    });
    const results=await Promise.allSettled(selected.pending.map(item=>item.promise));for(let i=0;i<results.length;i++){const result=results[i],{appId}=selected.pending[i];if(result.status==='fulfilled')result.value.manual=policy.manual.includes(appId);else selected.errors.push({appId,code:result.reason.code??'APP_START_FAILED',message:result.reason.message});}
    backgroundErrors=selected.errors;return {errors:selected.errors};
  }
  function managedStart(appId,release,reason){
    starts.set(appId,(starts.get(appId)??0)+1);
    const key=`${appId}@${release.digest}`;
    const pending=startupLocks.run(key,async()=>{
      assert(!disposed,'APP_HOST_CLOSED','应用宿主已停止。',503);
      const current=runtimes.get(key);return current&&!current.closed?current:startRuntime(appId,release,key,reason);
    }).finally(()=>{const count=starts.get(appId)-1;if(count)starts.set(appId,count);else starts.delete(appId);startupPromises.delete(pending);if(startupPending.get(key)===pending)startupPending.delete(key);});
    startupPromises.add(pending);startupPending.set(key,pending);void pending.catch(()=>{});return pending;
  }
  async function launch(appId,digest,surface={}){
    assert(!disposed,'APP_HOST_CLOSED','应用宿主已停止。',503);await assertActive(appId);await ensureDefaults();
    const {instance,pending}=await withStateLock(async()=>{
      const state=await readState(),app=state.installed[appId];
      assert(app?.enabled&&app.active.digest===digest,'APP_RELEASE_CHANGED','应用已更新或停用，请重新打开。',409);compatible(app.active.manifest);await verifyRelease(app.active);
      const kind=surface.kind??'window';assert(['window','card','service'].includes(kind),'APP_CALL_INVALID','应用界面类型无效。');
      if(kind==='card')assert(app.active.manifest.cards?.some(card=>card.id===surface.cardId),'APP_CARD_UNKNOWN','应用没有声明此卡片。');
      if(kind==='window')assert(app.active.manifest.window,'APP_WINDOW_UNAVAILABLE','此应用只提供桌面卡片。');
      for(const [id,item] of instances)if(item.closed)instances.delete(id);
      assert(instances.size<256,'APP_INSTANCE_LIMIT','应用实例已达到上限，请先关闭部分窗口或卡片。');
      const id=randomUUID(),instance={id,appId,release:app.active,kind,cardId:surface.cardId,pageId:typeof surface.pageId==='string'?surface.pageId.slice(0,100):undefined,surfaceId:typeof surface.surfaceId==='string'?surface.surfaceId.slice(0,512):id,closed:false,preparing:!!app.active.manifest.backend,lastSeen:Date.now()};
      instances.set(id,instance);
      return {instance,pending:app.active.manifest.backend?managedStart(appId,app.active,['cli','message'].includes(surface.reason)?surface.reason:kind):null};
    });
    let selectedRuntime;
    try{
      if(pending){const runtime=selectedRuntime=await pending;await assertActive(appId);assert(!instance.closed&&!disposed&&!runtime.closed,'APP_PROCESS_EXITED','应用启动期间租约已关闭。',410);runtime.clients.add(instance.id);instance.runtime=runtime;}
      instance.preparing=false;return {id:instance.id,appId,version:instance.release.manifest.version,digest};
    }catch(error){await stopInstance(instance.id);if(selectedRuntime&&!instance.runtime)await idleRuntime(selectedRuntime);if(!disposed)await mutate(state=>settlePending(state,appId));throw error;}
  }
  async function call(id,method,params,{maxBytes=1024*1024,messageType='call',waitForCompletion=false}={}){
    assert(uuid(id)&&typeof method==='string'&&/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(method),'APP_CALL_INVALID','应用调用参数无效。');
    const instance=instances.get(id),runtime=instance?.runtime;
    if(instance)await assertActive(instance.appId);
    assert(instance&&!instance.closed&&runtime&&!runtime.closed&&runtime.child?.connected,'APP_PROCESS_EXITED','应用后端已停止，请重新启动。',410);
    assert(Buffer.byteLength(JSON.stringify(params??null))<=maxBytes,'APP_CALL_INVALID','单次应用调用参数超过大小上限。',413);
    instance.lastSeen=Date.now();assert(runtime.calls.size<128,'APP_BUSY','应用请求过多，请稍后重试。',429);
    const next=++runtime.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(waitForCompletion){backgroundErrors.push({appId:runtime.appId,code:'APP_MESSAGE_TIMEOUT',message:'消息处理尚未返回，保留在途租约，避免并发重投。'});return;}reject(problem('APP_CALL_TIMEOUT','应用请求超时，后端执行结果尚待核对，请勿重复写操作。',504,{outcomeUnknown:true}));},callTimeoutMs);
      runtime.calls.set(next,{resolve,reject,timer});runtime.child.send({type:messageType,id:next,method,params,caller:{source:messageType==='cli'?'cli':messageType==='message'?'message':messageType==='workflow'?'workflow':'surface',appId:runtime.appId,version:runtime.release.manifest.version,packageDigest:runtime.release.digest,instanceId:id,surfaceId:instance.surfaceId,kind:instance.kind,cardId:instance.cardId,...(messageType==='workflow'?{requesterAppId:instance.workflowOrigin?.requesterAppId}: {})}},error=>{if(error){clearTimeout(timer);runtime.calls.delete(next);reject(problem('APP_PROCESS_EXITED','应用进程已退出，原请求执行结果需要核对。',410,{outcomeUnknown:true}));}});
    });
  }
  async function stopInstance(id){
    const instance=instances.get(id);if(!instance)return;
    instance.closed=true;instances.delete(id);if(instance.runtime)await terminal.release({runtimeId:instance.runtime.id,instanceId:id});if(instance.runtime){instance.runtime.clients.delete(id);await idleRuntime(instance.runtime);}
  }
  async function release(id){const appId=instances.get(id)?.appId;await stopInstance(id);if(appId&&!disposed)await mutate(state=>settlePending(state,appId));}
  const reaper=setInterval(()=>{pruneImports();for(const instance of instances.values())if(Date.now()-instance.lastSeen>90000)void release(instance.id).catch(()=>{});},15000);reaper.unref();
  async function heartbeat(ids){for(const id of ids??[]){const item=instances.get(id);if(item)item.lastSeen=Date.now();}return {};}
  async function invoke(appId,method,params){
    await ensureDefaults();const app=(await readState()).installed[appId];assert(app?.enabled,'APP_NOT_INSTALLED','所需应用尚未安装或已停用。',404);
    const instance=await launch(appId,app.active.digest,{kind:'service'});try{return await call(instance.id,method,params,{maxBytes:30*1024*1024});}finally{await release(instance.id);}
  }
  async function invokeWorkflow(appId,method,params,origin={}){
    assert(/^workflow\.(list|describe|start|get|reconcile|cancel|signal|request)$/.test(method),'APP_CALL_INVALID','工作流只接受固定接口。');
    const app=(await readState()).installed[appId];assert(app?.enabled,'APP_NOT_INSTALLED','工作流应用未安装或已停用。',404);
    assert(appId==='com.ksf.cooperation-center'&&method==='workflow.request'||app.active.manifest.workflows?.contractVersion===1,'APP_PERMISSION_REQUIRED','应用未提供工作流接口。',403);
    const instance=await launch(appId,app.active.digest,{kind:'service',reason:'workflow'});instances.get(instance.id).workflowOrigin=Object.freeze({...origin});
    try{return await call(instance.id,method,params,{messageType:'workflow'});}finally{await release(instance.id);}
  }
  async function notify(appId,method,params){
    const client=[...instances.values()].find(item=>item.appId===appId&&!item.closed&&item.runtime&&!item.runtime.closed);
    if(client)return call(client.id,method,params,{maxBytes:30*1024*1024});
  }
  async function listApplications(){const state=await readState();return Object.entries(state.installed).map(([id,app])=>({id,name:app.active.manifest.name,description:app.active.manifest.description,version:app.active.manifest.version,sdkVersion:app.active.manifest.sdkVersion,enabled:app.enabled,hasCLI:!!app.active.manifest.cli}));}
  async function cliDocs(appId,{path,expectedPackageDigest}={}){
    appId=await resolveApplicationId(appId);
    const app=(await readState()).installed[appId],release=app?.active;assert(release?.manifest.cli,'APP_CLI_UNAVAILABLE','应用未安装或未提供 CLI。',404);assert(!expectedPackageDigest||expectedPackageDigest===release.digest,'APP_RELEASE_CHANGED','应用版本已变化，请重新读取文档。',409);
    const target=path??release.manifest.cli.documentation;assert(validPath(target)&&/^(docs\/.*\.(md|txt|json)|cli\/schemas\/.*\.json)$/.test(target),'APP_CLI_DOCUMENT_INVALID','CLI 文档引用无效。');
    const info=await verifyRelease(release);assert(info.files[target],'APP_CLI_DOCUMENT_INVALID','文档不在当前应用包中。',404);const bytes=await readFile(join(directory(release),target));
    assert(checksum(bytes)===info.files[target].sha256,'APP_PACKAGE_INTEGRITY','CLI 文档完整性校验失败。');
    const text=readCLIDocument(bytes,{main:target===release.manifest.cli.documentation});
    assert((await readState()).installed[appId]?.active.digest===release.digest,'APP_RELEASE_CHANGED','应用版本已变化，请重新读取文档。',409);
    return {appId,name:release.manifest.name,version:release.manifest.version,packageDigest:release.digest,path:target,text,commands:release.manifest.cli.commands};
  }
  async function cliExec(appId,commandId,input){
    appId=await resolveApplicationId(appId);
    const app=(await readState()).installed[appId];assert(app?.enabled&&app.active.manifest.cli,'APP_CLI_UNAVAILABLE','应用未安装、停用或未提供 CLI。',404);assert(input?.expectedPackageDigest===app.active.digest,'APP_RELEASE_CHANGED','CLI 文档版本与应用不一致，请重新读取。',409);assert(app.active.manifest.cli.commands.some(command=>command.id===commandId),'APP_CLI_COMMAND_UNKNOWN','应用未声明此 CLI 命令。',404);
    const instance=await launch(appId,input.expectedPackageDigest,{kind:'service',reason:'cli'});try{const {expectedPackageDigest,...params}=input;return await call(instance.id,commandId,params,{messageType:'cli'});}finally{await release(instance.id);}
  }
  async function communicationPermission(appId,permission){const app=(await readState()).installed[appId];assert(app?.enabled&&app.active.manifest.permissions.includes(permission),'APP_PERMISSION_REQUIRED','应用没有声明所需通信能力。',403);}
  // Transport admission is paused separately by the host. Keep authorization valid
  // for already admitted transfers until commit; app execution still uses assertActive.
  async function resolveApplicationId(id){return resolveInstalledApplicationId((await readState()).installed,id);}
  async function applicationIdentityMap(){const state=await readState();return Object.fromEntries(Object.entries(state.installed).flatMap(([id,record])=>(record.legacyIds??[]).map(old=>[old,id])));}
  async function messageRoute(appId,channel){const app=(await readState()).installed[appId];return app&&{enabled:app.enabled&&parked.get(appId)?.digest!==app.active.digest&&!(await runtimePolicy()).stopped.includes(appId)&&!draining.has(appId)&&app.active.manifest.activation?.messages?.channels.includes(channel),running:[...runtimes.values()].some(runtime=>runtime.appId===appId&&!runtime.closed),digest:app.active.digest};}
  async function messageRoutes(){const state=await readState(),policy=await runtimePolicy();return Object.entries(state.installed).flatMap(([appId,app])=>(app.active.manifest.activation?.messages?.channels??[]).map(channel=>({appId,name:app.active.manifest.name,channel,enabled:app.enabled&&!policy.stopped.includes(appId)})));}
  async function deliverMessage(appId,event){
    const route=await messageRoute(appId,event.channel);assert(route?.enabled,'APP_MESSAGE_UNAVAILABLE','应用消息通道不可用。',403);
    const instance=await launch(appId,route.digest,{kind:'service',reason:'message'});try{return await call(instance.id,'onMessage',event,{messageType:'message',waitForCompletion:true});}finally{await release(instance.id);}
  }
  async function changeApp(id,action,force=false){
    return mutate(async state=>{
      const app=state.installed[id];assert(app,'APP_NOT_INSTALLED','应用尚未安装。',404);
      assert(['uninstall','rollback','enable','disable'].includes(action),'APP_ACTION_INVALID','未知应用管理操作。');
      const active=running(id);assert(!active.some(item=>item.foreign),'APP_OTHER_HOST_RUNNING','此应用仍在另一个工作台服务中运行，请先在那里关闭。',409);
      assert(!starts.has(id)&&!active.some(item=>item.preparing)&&![...runtimes.values()].some(runtime=>runtime.appId===id&&(runtime.phase!=='ready'||runtime.jobs.size||runtime.calls.size||storage.pending(runtime.appId))),'APP_BUSY','应用还有未完成的操作，请等待完成后重试。',409);
      if(active.some(item=>item.kind!=='card'))assert(force,'APP_RUNNING','请先关闭此应用的所有窗口。',409);
      if(action==='rollback'){assert(app.previous&&!app.pending,'APP_ROLLBACK_UNAVAILABLE','没有可回退版本，或已有升级等待切换。');await dataCheck(app.previous);}
      for(const item of active)await stopInstance(item.id);
      for(const runtime of [...runtimes.values()])if(runtime.appId===id)await stopRuntime(runtime);
      if(action==='uninstall')delete state.installed[id];
      else if(action==='rollback'){assert(app.previous&&!app.pending,'APP_ROLLBACK_UNAVAILABLE','没有可回退版本，或已有升级等待切换。');await verifyRelease(app.previous);const previous=app.previous;app.previous=app.active;app.active=previous;}
      else app.enabled=action==='enable';
    });
  }
  async function download(instanceId,params){
    const identity=caller(instanceId),instance=instances.get(instanceId);assert(instance.release.manifest.permissions.includes('data.export'),'APP_PERMISSION_REQUIRED','应用未声明文件导出能力。',403);
    const descriptor=await call(instanceId,'file.export',params),base=join(home,'data',identity.appId);
    assert(descriptor&&validPath(descriptor.path)&&typeof descriptor.name==='string'&&descriptor.name.length<=256&&/^[a-f0-9]{64}$/.test(descriptor.sha256),'APP_EXPORT_INVALID','应用导出描述无效。');
    let checked=root;for(const part of relative(root,base).split(/[\\/]/)){checked=join(checked,part);assert(!(await lstat(checked)).isSymbolicLink(),'APP_EXPORT_INVALID','应用数据目录不允许符号链接。');}
    let path=base;for(const part of descriptor.path.split('/')){path=join(path,part);assert(!(await lstat(path)).isSymbolicLink(),'APP_EXPORT_INVALID','导出不允许符号链接。');}
    const stat=await lstat(path);assert(stat.isFile()&&stat.size<=128*1024*1024,'APP_EXPORT_INVALID','导出必须是 128 MiB 内的普通文件。');const bytes=await readFile(path);assert(bytes.length<=128*1024*1024&&checksum(bytes)===descriptor.sha256,'APP_EXPORT_INVALID','导出文件大小或摘要不符。');
    return {bytes,name:descriptor.name};
  }
  async function storeAsset(name) { assert(name === 'index.json' || /^[a-zA-Z0-9_.-]+\.ksfapp$/.test(name) || storeMediaPath(name), 'APP_ASSET_NOT_FOUND', '应用源资源不存在。', 404); return readFile(join(storeDirectory, name)); }
  const mediaCache=new Map(),mediaPending=new Map();
  async function media({sourceId,appId,version,digest}){
    assert(/^[a-f0-9]{64}$/.test(digest??''),'APP_ASSET_NOT_FOUND','商店图片不存在。',404);
    const state=await readState(),source=state.sources.find(s=>s.id===(sourceId==='builtin'?canonicalSource.id:sourceId)&&s.enabled);assert(source,'APP_ASSET_NOT_FOUND','图片所属应用源不可用。',404);
    const key=source.id+':'+source.url+':'+appId+':'+version+':'+digest;
    if(mediaCache.has(key)){const value=mediaCache.get(key);mediaCache.delete(key);mediaCache.set(key,value);return value;}
    if(mediaPending.has(key))return mediaPending.get(key);
    const pending=(async()=>{
      const entries=await index(source),entry=entries.find(e=>e.manifest.id===appId&&e.manifest.version===version&&[e.listing?.icon,...(e.listing?.screenshots??[])].some(i=>i?.sha256===digest));
      const image=[entry?.listing?.icon,...(entry?.listing?.screenshots??[])].find(i=>i?.sha256===digest);assert(image&&storeMediaPath(image.url),'APP_ASSET_NOT_FOUND','图片未在应用源中声明。',404);
      const bytes=entry.resource==='baseline'&&[entry.baselineListing?.icon,...(entry.baselineListing?.screenshots??[]),...(entry.baselinePackage?[]:[entry.listing?.icon,...(entry.listing?.screenshots??[])])].some(i=>i?.sha256===digest)?await readFile(join(storeDirectory,image.url)):await boundedFetch(sourceURL(new URL(image.url,source.url).href),MAX_STORE_IMAGE,fetcher);
      assert(bytes.length===image.size&&bytes.length<=MAX_STORE_IMAGE&&checksum(bytes)===digest,'APP_PACKAGE_INTEGRITY','商店图片摘要或容量校验失败。',422);
      const value={bytes,type:storeImageType(bytes)};mediaCache.set(key,value);while([...mediaCache.values()].reduce((n,v)=>n+v.bytes.length,0)>32*1024*1024)mediaCache.delete(mediaCache.keys().next().value);return value;
    })().finally(()=>mediaPending.delete(key));mediaPending.set(key,pending);return pending;
  }
  const busy=id=>(id?starts.has(id):starts.size>0)||[...runtimes.values()].some(r=>(!id||r.appId===id)&&(r.phase!=='ready'||r.calls.size||r.jobs.size||storage.pending(r.appId)));
  async function waitIdle(id,force){if(force)return;const deadline=Date.now()+10000;while(busy(id)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));assert(!busy(id),'APP_BUSY','仍有在途调用或后台任务，请完成后重试，或显式使用 --force。',409);}
  async function quiesce({force=false}={}){accepting=false;try{await waitIdle(null,force);return {state:'drained'};}catch(error){accepting=true;throw error;}}
  async function runtimeSnapshot(appId){if(appId)appId=await resolveApplicationId(appId);const state=await readState(),policy=await runtimePolicy(),holds=await backgroundHolds();return {accepting,errors:backgroundErrors.filter(error=>!error.appId),applications:Object.entries(state.installed).filter(([id])=>!appId||id===appId).map(([id,app])=>{const live=[...runtimes.values()].filter(r=>r.appId===id&&!r.closed);return {id,name:app.active.manifest.name,enabled:app.enabled,version:app.active.manifest.version,lifecycle:app.active.manifest.backend?.lifecycle??'frontend',hasWindow:!!app.active.manifest.window,cards:app.active.manifest.cards?.length??0,stopped:policy.stopped.includes(id),manual:policy.manual.includes(id),state:policy.stopped.includes(id)?'stopped':parked.get(id)?.digest===app.active.digest?'blocked':live.length?'running':'idle',restarts:restartCounts.get(id)??0,holds:holds.applications[id]??{},runtimes:live.map(r=>({id:r.id,pid:r.child?.pid,startedAt:new Date(r.startedAt).toISOString(),reason:r.reason,clients:r.clients.size,calls:r.calls.size,jobs:r.jobs.size})),errors:[...new Map([...backgroundErrors.filter(e=>e.appId===id),...(parked.has(id)?[{appId:id,...parked.get(id)}]:[])].map(e=>[e.code+'\0'+e.message,e])).values()]};})};}
  const monitorAppVersion=app=>checksum(JSON.stringify([app.version,app.enabled,app.state,app.stopped,app.runtimes.map(r=>r.id).sort()]));
  async function runtimeManage({action='list',appId,force=false,expectedVersion}={}){
    if(appId)appId=await resolveApplicationId(appId);
    assert(['list','status','start','stop','restart','logs'].includes(action),'APP_ACTION_INVALID','未知后台管理操作。');
    if(action==='list'||action==='status')return runtimeSnapshot(appId);
    assert(typeof appId==='string'&&(await readState()).installed[appId],'APP_NOT_INSTALLED','应用尚未安装。',404);
    if(action==='logs'){const path=join(root,'.agents/runtime-data/applications/logs',appId+'.log');const bytes=await readFile(path).catch(e=>{if(e.code==='ENOENT')return Buffer.alloc(0);throw e;});return {appId,text:redactLog(bytes.subarray(Math.max(0,bytes.length-32768)).toString())};}
    const selected=await withStateLock(async()=>{
      const app=(await readState()).installed[appId];assert(app,'APP_NOT_INSTALLED','应用已卸载，请刷新。',404);assert(app.enabled,'APP_DISABLED','应用已禁用，请先启用。',409);assert(app.active.manifest.backend,'APP_BACKEND_UNAVAILABLE','纯界面应用没有后台。',409);
      if(expectedVersion)assert(monitorAppVersion((await runtimeSnapshot(appId)).applications[0])===expectedVersion,'MONITOR_STALE','应用运行状态已经变化，请刷新后重试。',409);
      draining.add(appId);try{
        if(action!=='start'){await waitIdle(appId,force);const policy=await runtimePolicy();policy.stopped=[...new Set([...policy.stopped,appId])];policy.manual=policy.manual.filter(id=>id!==appId);await mkdir(dirname(policyPath),{recursive:true});await atomicJSON(policyPath,policy);for(const item of [...instances.values()])if(item.appId===appId)await stopInstance(item.id);for(const runtime of [...runtimes.values()])if(runtime.appId===appId)await stopRuntime(runtime);}
        if(action!=='stop'){parked.delete(appId);draining.delete(appId);const policy=await runtimePolicy();policy.stopped=policy.stopped.filter(id=>id!==appId);policy.manual=[...new Set([...policy.manual,appId])];await mkdir(dirname(policyPath),{recursive:true});await atomicJSON(policyPath,policy);restartCounts.delete(appId);backgroundErrors=backgroundErrors.filter(e=>e.appId!==appId);await verifyRelease(app.active);return {pending:managedStart(appId,app.active,action==='restart'?'manual-restart':'manual')};}
      }finally{draining.delete(appId);}return {};
    });
    if(selected.pending)(await selected.pending).manual=true;return runtimeSnapshot(appId);
  }
  async function close() { disposed = true; imports.clear();clearInterval(reaper);clearTimeout(backgroundReconcile); await coordinator.run('state',async()=>{}); await Promise.allSettled([...startupPromises]); await Promise.all([...instances.keys()].map(stopInstance)); await Promise.all([...runtimes.values()].map(stopRuntime));await terminal.dispose();await Promise.all([...runtimeFinalizers]); }
  function caller(id) {
    const instance=instances.get(id);assert(instance&&!instance.closed,'APP_PROCESS_EXITED','应用租约已失效。',410);
    return Object.freeze({appId:instance.appId,version:instance.release.manifest.version,releaseDigest:instance.release.digest});
  }
  async function authorizeMonitor(instanceId,permission){
    const instance=instances.get(instanceId);assert(instance&&!instance.closed,'APP_PROCESS_EXITED','监视器窗口租约已失效，请重新打开。',410);
    const installed=(await readState()).installed[instance.appId];
    assert(installed?.enabled&&instance.release.manifest.permissions.includes(permission),'APP_PERMISSION_REQUIRED','此应用未声明 '+permission+' 权限。',403);
    return {appId:instance.appId,instanceId};
  }
  async function monitorSnapshot(){
    const value=await runtimeSnapshot();
    const applications=value.applications.map(app=>({...app,monitorVersion:monitorAppVersion(app),windows:[...instances.values()].filter(i=>!i.closed&&i.appId===app.id&&i.kind==='window').length,runtimes:app.runtimes.map(r=>({...r,processStart:[...runtimes.values()].find(live=>live.id===r.id)?.processStart}))}));
    const jobs=[...runtimes.values()].filter(r=>!r.closed).flatMap(r=>[...r.jobs.values()]);
    const tasks=[...jobs,...taskHistory].map(({token,...job})=>({...job,version:String(job.revision),actions:job.status==='running'&&job.cancellable?['stop']:[],historyScope:'本次主服务运行期间'}));
    return {...value,applications,tasks,terminals:await terminal.monitorSnapshot()};
  }
  async function monitorCancelTask(id,version){
    for(const runtime of runtimes.values())for(const [token,job] of runtime.jobs){if(job.id!==id)continue;
      assert(String(job.revision)===version&&job.status==='running','MONITOR_STALE','任务已经结束或状态已变化，请刷新。',409);
      assert(job.cancellable,'MONITOR_NOT_CANCELLABLE','此任务未提供单独取消，可停止所属应用。',409);
      assert(runtime.child?.connected&&!runtime.closed,'APP_PROCESS_EXITED','任务所属进程已经退出。',410);
      job.status='cancelling';job.revision++;runtime.child.send({type:'task-cancel',token});return {state:'cancelling'};
    }
    throw problem('MONITOR_STALE','任务已经结束，请刷新。',409);
  }
  return { resolveApplicationId,applicationIdentityMap,authorizeMonitor,monitorSnapshot,monitorCancelTask,monitorCloseTerminal:input=>terminal.monitorClose(input),resume:()=>{accepting=true;},quiesce,runtimeManage,runtimeSnapshot,snapshot, catalog, install, prepareImport,installImport,discardImport,invoke,invokeWorkflow, notify, ensureDefaults, startBackground,getBackgroundErrors:()=>structuredClone(backgroundErrors),saveSource, removeSource, asset, launch, call, release, heartbeat, changeApp, storeAsset, media,download,caller,listApplications,cliDocs,cliExec,messageRoute,messageRoutes,deliverMessage,backgroundHolds,communicationPermission,close };
}
