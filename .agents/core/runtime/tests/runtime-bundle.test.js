import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {buildRelease,inspectCoreArchive} from '../src/distribution/release.js';
import {createArchive} from '../src/distribution/archive.js';
import {buildManifest} from '../src/services/build-manifest.js';
import {inspectReleaseDirectory} from '../src/distribution/publish.js';
import {installedManifest} from '../src/distribution/manifests.js';
import {resolveBaseline} from '../src/distribution/baseline.js';
import {planUpdate,systemRead,systemUpdate,systemRollback,systemFingerprint} from '../src/distribution/system.js';
import {runtimePackage} from '../src/platform/catalog.js';
import {runtimeLayoutPath,runtimeLayoutBytes,runtimePackagesPath} from '../src/platform/runtime-bundle.js';
import {sha256,stableJSON} from '../src/shared/hash.js';
import {distributionFixture,fixtureTarget,git,commitWorkspace,contributionDescription} from './helpers/distribution-fixture.js';
import {storedZip} from './helpers/platform.js';
import {ForkAPI} from './helpers/contribution-api.js';
import {prepareContribution} from '../src/distribution/contribute.js';
import YAML from '../src/vendor/yaml/dist/index.js';

function addTarget(f,target){
  if(f.build.runtime.packages[target])return;
  const spec=runtimePackage(target,f.build.runtime.version),bytes=Buffer.from('Synthetic '+target+' runtime\n');
  const entries=[{path:spec.nodeMember,bytes,mode:0o755},{path:spec.licenseMember,bytes:Buffer.from('fixture license'),mode:0o644}];
  const archive=spec.format==='zip'?storedZip(entries):createArchive(entries),path=runtimePackagesPath+spec.filename;
  f.save(path,archive);f.build.runtime.packages[target]={archive_path:path,archive_sha256:sha256(archive)};
}
async function freeze(f,message){f.save('.agents/core/build.json',stableJSON(f.build));await buildManifest(f.root);git(f.root,['add','.agents']);git(f.root,['commit','-m',message]);}
async function multi(t){const f=await distributionFixture(t,{compact:true});for(const target of ['darwin-arm64','win32-x64','linux-x64'])addTarget(f,target);await freeze(f,'Synthetic multi-platform runtime inputs');return f;}
const inspect=(result,target)=>inspectCoreArchive(readFileSync(join(result.output,result.index.platforms[target].core.name)));

test('each platform artifact contains one runtime; source inputs and complete publication targets remain intact',async t=>{
  const f=await multi(t),sourceBuild=readFileSync(join(f.root,'.agents/core/build.json'));
  // Retaining previous Node archives in source must not expand release scope.
  const previous=runtimePackagesPath+runtimePackage(fixtureTarget,'24.20.0').filename;
  f.save(previous,Buffer.from('retained previous runtime'));await freeze(f,'Retain an older runtime archive');
  const result=await buildRelease({root:f.root,output:join(f.directory,'target-bundles')});
  assert.deepEqual(result.platforms,['darwin-arm64','win32-x64']);
  for(const target of result.platforms){
    const {entries,manifest}=inspect(result,target),archive=f.build.runtime.packages[target].archive_path;
    assert.deepEqual([...entries.keys()].filter(path=>path.startsWith(runtimePackagesPath)),[archive]);
    assert.deepEqual(entries.get('.agents/core/build.json').bytes,sourceBuild);
    assert.deepEqual(Object.keys(YAML.parse(entries.get('.agents/core/manifest.yaml').bytes.toString()).runtime.packages),[target]);
    assert.equal(manifest.core.revision,result.coreRevision);
    assert.equal(sha256(entries.get(archive).bytes),f.build.runtime.packages[target].archive_sha256);
  }
  assert.equal(inspectReleaseDirectory(f.root,result.output).artifacts.length,4);
  assert.deepEqual(readFileSync(join(f.root,'.agents/core/build.json')),sourceBuild);
  for(const item of Object.values(f.build.runtime.packages))assert.ok(existsSync(join(f.root,item.archive_path)));
  // A release can regenerate its manifest without any foreign runtime archives.
  rmSync(join(result.instance,'.agents/core/manifest.yaml'));
  const rebuilt=await buildManifest(result.instance);
  assert.deepEqual(Object.keys(rebuilt.manifest.runtime.packages),[installedManifest(result.instance).platform]);
  const api=new ForkAPI({coreRoot:f.root}),status=await systemRead({root:result.instance,api});
  assert.deepEqual(status.changes,[]);
  const compact=await resolveBaseline(installedManifest(result.instance),{api});
  assert.deepEqual(Object.keys(compact.files).filter(path=>path.startsWith(runtimePackagesPath)),[f.build.runtime.packages[installedManifest(result.instance).platform].archive_path]);
  const templateReceipt={...installedManifest(result.instance),schema_version:5,origin:'core-template'};
  const template=await resolveBaseline(templateReceipt,{api});
  assert.equal(Object.keys(template.files).filter(path=>path.startsWith(runtimePackagesPath)).length,4);
  assert.ok(template.files[previous]);
  // Baseline selection uses the pinned source declaration, not mutable local data.
  const localBuild=JSON.parse(readFileSync(join(result.instance,'.agents/core/build.json')));
  localBuild.runtime.version='24.20.0';
  writeFileSync(join(result.instance,'.agents/core/build.json'),stableJSON(localBuild));
  assert.deepEqual(Object.keys((await resolveBaseline(installedManifest(result.instance),{api})).files).filter(path=>path.startsWith(runtimePackagesPath)),[f.build.runtime.packages[installedManifest(result.instance).platform].archive_path]);
  writeFileSync(join(result.instance,'.agents/core/build.json'),sourceBuild);
  const originalRequest=api.request.bind(api);
  api.request=async(method,path,body)=>{
    const response=await originalRequest(method,path,body);
    if(path.includes('/git/blobs/'))return {...response,content:Buffer.from('tampered declaration').toString('base64')};
    return response;
  };
  await assert.rejects(resolveBaseline(installedManifest(result.instance),{api}),{code:'BASELINE_MISMATCH'});
  api.request=originalRequest;
  commitWorkspace({...f,workspace:result.instance});
  await assert.rejects(prepareContribution({...contributionDescription,root:result.instance,all:true,api}),{code:'CONTRIBUTION_EMPTY'});
});

test('bundle inspection rejects foreign archives, missing archives and expanded runtime manifests even with refreshed checksums',async t=>{
  const f=await multi(t),result=await buildRelease({root:f.root,platform:fixtureTarget,output:join(f.directory,'inspect-one')});
  const good=inspect(result,fixtureTarget),native=f.build.runtime.packages[fixtureTarget].archive_path;
  const other=fixtureTarget==='win32-x64'?'darwin-arm64':'win32-x64',foreign=f.build.runtime.packages[other].archive_path;
  function changed(mutate){const manifest=structuredClone(good.manifest),entries=new Map([...good.entries].map(([path,file])=>[path,{...file,bytes:Buffer.from(file.bytes)}]));mutate(entries,manifest);entries.set('.agents/core/release.json',{bytes:Buffer.from(stableJSON(manifest)),mode:0o644});return createArchive([...entries].map(([path,file])=>({path,...file})));}
  const addForeign=changed((entries,manifest)=>{const bytes=readFileSync(join(f.root,foreign));entries.set(foreign,{bytes,mode:0o644});manifest.files[foreign]={sha256:sha256(bytes),mode:0o644,source_path:foreign};});
  assert.throws(()=>inspectCoreArchive(addForeign),{code:'RELEASE_INVALID'});
  assert.throws(()=>inspectCoreArchive(changed((entries,manifest)=>{entries.delete(native);delete manifest.files[native];})),{code:'RELEASE_INVALID'});
  assert.throws(()=>inspectCoreArchive(changed((entries,manifest)=>{const path='.agents/core/manifest.yaml',value=YAML.parse(entries.get(path).bytes.toString());value.runtime.packages[other]=value.runtime.packages[fixtureTarget];const bytes=Buffer.from(YAML.stringify(value));entries.set(path,{bytes,mode:0o644});manifest.files[path].sha256=sha256(bytes);})),{code:'RELEASE_INVALID'});
  assert.throws(()=>inspectCoreArchive(changed((entries,manifest)=>{const path='.agents/core/manifest.yaml',value=YAML.parse(entries.get(path).bytes.toString());value.runtime.packages[fixtureTarget]=null;const bytes=Buffer.from(YAML.stringify(value));entries.set(path,{bytes,mode:0o644});manifest.files[path].sha256=sha256(bytes);})),{code:'RELEASE_INVALID'});
});

test('old all-runtime baselines upgrade by removing unchanged foreign archives and protect modified files',async t=>{
  const f=await multi(t);rmSync(join(f.root,runtimeLayoutPath));await freeze(f,'Synthetic legacy full-runtime source');
  const legacy=await buildRelease({root:f.root,platform:fixtureTarget,output:join(f.directory,'legacy-full')});
  assert.equal([...inspect(legacy,fixtureTarget).entries.keys()].filter(path=>path.startsWith(runtimePackagesPath)).length,3);
  const api=new ForkAPI({coreRoot:f.root}),baseline=await resolveBaseline(installedManifest(legacy.instance),{api});
  assert.equal(Object.keys(baseline.files).filter(path=>path.startsWith(runtimePackagesPath)).length,3);
  f.save(runtimeLayoutPath,runtimeLayoutBytes);f.build.version='0.1.1';await freeze(f,'Synthetic target-only runtime source');
  const next=await buildRelease({root:f.root,platform:fixtureTarget,output:join(f.directory,'narrow-next')}),incoming=inspect(next,fixtureTarget);
  const plan=await planUpdate(legacy.instance,baseline,incoming.manifest,incoming.entries);
  assert.deepEqual(plan.conflicts,[]);
  const foreign=Object.entries(f.build.runtime.packages).filter(([target])=>target!==fixtureTarget).map(([,item])=>item.archive_path).sort();
  assert.deepEqual(plan.changes.filter(change=>change.operation==='delete'&&change.path.startsWith(runtimePackagesPath)).map(change=>change.path).sort(),foreign);
  writeFileSync(join(legacy.instance,foreign[0]),'preserve a local edit');
  const conflict=await planUpdate(legacy.instance,baseline,incoming.manifest,incoming.entries);
  assert.ok(conflict.conflicts.some(item=>item.path===foreign[0]));
  assert.equal(readFileSync(join(legacy.instance,foreign[0]),'utf8'),'preserve a local edit');
});

test('native update and rollback preserve runtime scope and restore legacy archives',{skip:process.platform==='linux'?'Official Linux release remains unsupported; native Mac/Windows execute the update transaction.':false},async t=>{
  const f=await multi(t);rmSync(join(f.root,runtimeLayoutPath));await freeze(f,'Synthetic old bundle for native upgrade');
  const old=await buildRelease({root:f.root,platform:fixtureTarget,output:join(f.directory,'native-old')}),before=systemFingerprint(old.instance);
  f.save(runtimeLayoutPath,runtimeLayoutBytes);f.build.version='0.1.1';await freeze(f,'Synthetic scoped native upgrade');
  const next=await buildRelease({root:f.root,platform:fixtureTarget,output:join(f.directory,'native-next')}),api=new ForkAPI({coreRoot:f.root});
  await systemUpdate({root:old.instance,from:join(next.output,next.index.platforms[fixtureTarget].core.name),api});
  assert.deepEqual((await systemRead({root:old.instance,api})).changes,[]);
  for(const [target,item]of Object.entries(f.build.runtime.packages))assert.equal(existsSync(join(old.instance,item.archive_path)),target===fixtureTarget);
  await buildManifest(old.instance); // Rebuild remains possible with one archive.
  // Rebuild is generated metadata; restore the installed version before rollback fingerprint checks.
  const incoming=inspect(next,fixtureTarget);writeFileSync(join(old.instance,'.agents/core/manifest.yaml'),incoming.entries.get('.agents/core/manifest.yaml').bytes);
  await systemRollback({root:old.instance});assert.equal(systemFingerprint(old.instance),before);
});
