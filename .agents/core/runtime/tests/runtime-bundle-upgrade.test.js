import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {buildRelease} from '../src/distribution/release.js';
import {buildManifest} from '../src/services/build-manifest.js';
import {installedManifest} from '../src/distribution/manifests.js';
import {resolveBaseline} from '../src/distribution/baseline.js';
import {planUpdate,systemRead,systemUpdate,systemRollback,systemFingerprint} from '../src/distribution/system.js';
import {runtimeLayoutPath,runtimeLayoutBytes,runtimePackagesPath} from '../src/platform/runtime-bundle.js';
import {fixtureTarget} from './helpers/distribution-fixture.js';
import {ForkAPI} from './helpers/contribution-api.js';
import {multi,freeze,inspect} from './helpers/runtime-bundle-fixture.js';

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
