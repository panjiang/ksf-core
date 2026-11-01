import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {distributionFixture,fixtureTarget,instanceEntries} from './helpers/distribution-fixture.js';
import {buildRelease} from '../src/distribution/release.js';
import {publishRelease} from '../src/distribution/publish.js';
import {readArchive,createArchive} from '../src/distribution/archive.js';
import {systemUpdate,systemRollback,systemFingerprint} from '../src/distribution/system.js';
import {managedPath} from '../src/distribution/paths.js';
import {writeUserData,readUserData} from '../src/services/user-data.js';
import {contextEntry} from '../src/services/entry-context.js';
import {sha256} from '../src/shared/hash.js';

const statePath='.agents/user-data/incubation.json';
test('workspace ships only the exact generic pending seed; source instance data cannot leak into either product',async t=>{
  const f=await distributionFixture(t);
  f.save(statePath,'PRIVATE_INCUBATION_STATE_MUST_NEVER_SHIP');
  const built=await buildRelease({root:f.root,output:join(f.directory,'incubation-private-source')});
  const descriptor=built.index.platforms[fixtureTarget],core=readArchive(readFileSync(join(built.output,descriptor.core.name))),workspace=instanceEntries(built.instance);
  assert.equal(core.has(statePath),false);assert.equal(JSON.parse(workspace.get(statePath).bytes).values.status,'pending');
  for(const entries of [core,workspace])assert.ok([...entries.values()].every(file=>!file.bytes.includes(Buffer.from('PRIVATE_INCUBATION_STATE_MUST_NEVER_SHIP'))));
  assert.equal(managedPath(statePath),false);assert.equal(managedPath('.agents/core/distribution/template/'+statePath),true);
  assert.equal((await publishRelease({root:f.root,directory:built.output,dryRun:true})).dryRun,true);
  // The local convenience directory is not a published artifact; only the Core seed is uploaded.
  assert.deepEqual(Object.keys(descriptor),['core']);
});
test('lifecycle changes do not alter Core fingerprint and upgrade/rollback preserve state without incubating legacy instances',async t=>{
  const f=await distributionFixture(t),initial=systemFingerprint(f.workspace),entry=f.launch(['context','entry','--json']);
  assert.equal(entry.status,0,entry.stdout+entry.stderr);assert.equal(JSON.parse(entry.stdout).data.mode,'incubation');
  writeUserData({root:f.workspace,namespace:'incubation',ifMatch:readUserData({root:f.workspace,namespace:'incubation'}).etag,values:{status:'completed'}});
  assert.equal(systemFingerprint(f.workspace),initial);const before=readFileSync(join(f.workspace,statePath)),next=await f.next();
  await systemUpdate({root:f.workspace,from:next.coreArchive});assert.deepEqual(readFileSync(join(f.workspace,statePath)),before);assert.equal(contextEntry(f.workspace).mode,'runtime');
  await systemRollback({root:f.workspace});assert.deepEqual(readFileSync(join(f.workspace,statePath)),before);
  rmSync(join(f.workspace,statePath));await systemUpdate({root:f.workspace,from:next.coreArchive});assert.equal(readUserData({root:f.workspace,namespace:'incubation'}).state,'missing');assert.equal(contextEntry(f.workspace).mode,'runtime');
});
