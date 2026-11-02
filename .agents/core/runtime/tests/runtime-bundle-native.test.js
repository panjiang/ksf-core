import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {existsSync,writeFileSync,rmSync} from 'node:fs';
import {buildRelease} from '../src/distribution/release.js';
import {buildManifest} from '../src/services/build-manifest.js';
import {systemRead,systemUpdate,systemRollback,systemFingerprint} from '../src/distribution/system.js';
import {runtimeLayoutPath,runtimeLayoutBytes} from '../src/platform/runtime-bundle.js';
import {fixtureTarget} from './helpers/distribution-fixture.js';
import {ForkAPI} from './helpers/contribution-api.js';
import {multi,freeze,inspect} from './helpers/runtime-bundle-fixture.js';

// These are full native transactions, including a cold fixture, two releases,
// durable file replacement and rollback. Emit each phase before awaiting it so
// a hard timeout retains the exact unfinished stage in the raw test log.
async function phase(name,run){
  const began=performance.now();
  process.stderr.write(JSON.stringify({phase:'runtime-bundle-native',step:name,event:'start'})+'\n');
  try{return await run();}
  finally{process.stderr.write(JSON.stringify({phase:'runtime-bundle-native',step:name,event:'end',durationMs:Math.round(performance.now()-began)})+'\n');}
}

test('native update and rollback preserve runtime scope and restore legacy archives',{skip:process.platform==='linux'?'Official Linux release remains unsupported; native Mac/Windows execute the update transaction.':false},async t=>{
  const f=await phase('fixture',()=>multi(t));
  rmSync(join(f.root,runtimeLayoutPath));await phase('legacy-source',()=>freeze(f,'Synthetic old bundle for native upgrade'));
  const old=await phase('legacy-build',()=>buildRelease({root:f.root,platform:fixtureTarget,output:join(f.directory,'native-old')})),before=systemFingerprint(old.instance);
  f.save(runtimeLayoutPath,runtimeLayoutBytes);f.build.version='0.1.1';await phase('target-source',()=>freeze(f,'Synthetic scoped native upgrade'));
  const next=await phase('target-build',()=>buildRelease({root:f.root,platform:fixtureTarget,output:join(f.directory,'native-next')})),api=new ForkAPI({coreRoot:f.root});
  await phase('update',()=>systemUpdate({root:old.instance,from:join(next.output,next.index.platforms[fixtureTarget].core.name),api}));
  assert.deepEqual((await phase('read-updated',()=>systemRead({root:old.instance,api}))).changes,[]);
  for(const [target,item]of Object.entries(f.build.runtime.packages))assert.equal(existsSync(join(old.instance,item.archive_path)),target===fixtureTarget);
  await phase('rebuild-updated',()=>buildManifest(old.instance));
  // Rebuild is generated metadata; restore the installed version before rollback fingerprint checks.
  const incoming=inspect(next,fixtureTarget);writeFileSync(join(old.instance,'.agents/core/manifest.yaml'),incoming.entries.get('.agents/core/manifest.yaml').bytes);
  await phase('rollback',()=>systemRollback({root:old.instance}));assert.equal(systemFingerprint(old.instance),before);
});
