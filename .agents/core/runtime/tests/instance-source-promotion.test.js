import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cpSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {distributionFixture,git,commitWorkspace,contributionDescription} from './helpers/distribution-fixture.js';
import {ForkAPI} from './helpers/contribution-api.js';
import {initializeInstance} from '../src/distribution/instance.js';
import {buildRelease} from '../src/distribution/release.js';
import {systemUpdate,systemCheck} from '../src/distribution/system.js';
import {installedManifest} from '../src/distribution/manifests.js';
import {writeAtomic,readRegular} from '../src/distribution/files.js';
import {prepareContribution,submitContribution} from '../src/distribution/contribute.js';
import {template} from './helpers/instance-fixture.js';
import {runtimeLayoutPath} from '../src/platform/runtime-bundle.js';
test('new plan targets core-main while keeping an old main baseline and projects only canonical CI', async t => {
  const f = await distributionFixture(t); commitWorkspace(f); const receipt=installedManifest(f.workspace);
  receipt.core.branch='main';writeAtomic(join(f.workspace,'.agents/core/release.json'),JSON.stringify(receipt));
  const canonical='.agents/core/distribution/repository/.github/workflows/release.yml';
  writeAtomic(join(f.workspace,canonical),readRegular(f.workspace,canonical).toString()+'\n# public improvement\n');
  writeAtomic(join(f.workspace,'.github/workflows/release.yml'),'PRIVATE_WORKFLOW_SENTINEL');
  commitWorkspace(f,{paths:['.agents/core/release.json',canonical,'.github/workflows/release.yml']});
  const api=new ForkAPI({coreRoot:f.root});
  const plan=await prepareContribution({...contributionDescription,root:f.workspace,paths:[canonical],api});
  assert.equal(plan.target.branch,'core-main');assert.equal(plan.core.branch,'main');
  assert.deepEqual(plan.changes.map(change=>change.source_path),[canonical,'.github/workflows/release.yml']);
  assert.ok(!JSON.stringify(plan).includes('PRIVATE_WORKFLOW_SENTINEL'));
  const preview=await submitContribution({root:f.workspace,id:plan.id,reviewed:plan.digest,dryRun:true});
  assert.equal(preview.base,'core-main');
  const result=await submitContribution({root:f.workspace,id:plan.id,reviewed:plan.digest,api});
  assert.equal(result.draft,true);assert.equal(api.pr.base.ref,'core-main');
  assert.equal(api.commit.parents[0].sha,receipt.core.revision);
});


test('same-version source promotion verifies exact ancestry while an old release remains immutable', async t => {
  const f=await distributionFixture(t,{compact:true}),receipt=installedManifest(f.workspace);
  receipt.schema_version=5;receipt.origin='core-template';
  writeAtomic(join(f.workspace,'.agents/core/release.json'),JSON.stringify(receipt));
  f.save('.agents/core/example.txt','final same-version release fix\n');git(f.root,['add','.agents/core/example.txt']);git(f.root,['commit','-m','Fictional stable source progression']);
  const built=await buildRelease({root:f.root,output:join(f.directory,'final-same-version')}),api=new ForkAPI({coreRoot:f.root});
  const request=api.request.bind(api);let valid=true;
  api.request=async(method,path,...args)=>path.includes('/compare/')?{status:'ahead',base_commit:{sha:receipt.core.revision},merge_base_commit:{sha:valid?receipt.core.revision:'f'.repeat(40)}}:request(method,path,...args);
  const source=join(built.output,'ksf-core-index.json'),archive=join(built.output,built.index.platforms[receipt.platform].core.name);
  assert.equal((await systemCheck({root:f.workspace,source,api})).sourcePromotion,true);
  const aheadAPI={request:async()=>({status:'behind',base_commit:{sha:receipt.core.revision},merge_base_commit:{sha:built.coreRevision}})};
  const ahead=await systemCheck({root:f.workspace,source,api:aheadAPI});
  assert.equal(ahead.available,false);assert.equal(ahead.sourceAhead,true);
  await assert.rejects(systemUpdate({root:f.workspace,from:archive,api:aheadAPI}),{code:'VERSION_NOT_NEWER'});

  valid=false;await assert.rejects(systemUpdate({root:f.workspace,from:archive,api}),{code:'RELEASE_REPLACED'});valid=true;
  const privateBytes=readRegular(f.workspace,'USER.md');
  assert.equal((await systemUpdate({root:f.workspace,from:archive,api})).changed,true);
  assert.equal(installedManifest(f.workspace).schema_version,4);assert.deepEqual(readRegular(f.workspace,'USER.md'),privateBytes);
  // Formal release receipts continue to reject a different same-version SHA.
  const formal={...receipt,schema_version:4};delete formal.origin;writeAtomic(join(f.workspace,'.agents/core/release.json'),JSON.stringify(formal));
  await assert.rejects(systemCheck({root:f.workspace,source,api}),{code:'RELEASE_REPLACED'});
});

test('a verified archive folder inside another Git repository never renames the parent branch',async t=>{
  const f=await distributionFixture(t),folder=join(f.root,'nested-extracted-instance');
  cpSync(f.workspace,folder,{recursive:true});
  const manifest=JSON.parse(readRegular(f.workspace,'.agents/core/release.json'));manifest.instance_initialization=1;
  writeAtomic(join(folder,'.agents/core/release.json'),JSON.stringify(manifest));
  for(const path of ['USER.md','BOT.md'])rmSync(join(folder,path));
  const branch=git(f.root,['branch','--show-current']);
  const result=await initializeInstance({root:folder,api:new ForkAPI({coreRoot:f.root})});
  assert.equal(result.changed,true);assert.equal(result.previousBranch,null);assert.equal(git(f.root,['branch','--show-current']),branch);
  assert.equal(existsSync(join(folder,'USER.md')),true);
});


test('legacy copied instances can correct a foreign platform using the same exact Core release',async t=>{
  const f=await distributionFixture(t,{compact:true}),native=installedManifest(f.workspace).platform;
  // A copied legacy release predates target-specific runtime bundles. Freeze
  // that source policy before building its receipt instead of relabelling a
  // new bundle as a platform absent from its immutable source declaration.
  rmSync(join(f.root,runtimeLayoutPath));git(f.root,['add','--',runtimeLayoutPath]);git(f.root,['commit','-m','Synthetic legacy runtime layout']);
  const legacy=await buildRelease({root:f.root,platform:native,output:join(f.directory,'legacy-copy')}),root=legacy.instance,receipt=installedManifest(root);
  receipt.platform=native==='win32-x64'?'darwin-arm64':'win32-x64';writeAtomic(join(root,'.agents/core/release.json'),JSON.stringify(receipt));
  const api=new ForkAPI({coreRoot:f.root}),source=join(legacy.output,'ksf-core-index.json');
  const check=await systemCheck({root,source,api});
  assert.equal(check.platform,native);assert.equal(check.available,true);assert.equal(check.platformSwitch,true);
  const item=legacy.index.platforms[native].core;
  await systemUpdate({root,from:join(legacy.output,item.name),api});
  assert.equal(installedManifest(root).platform,native);assert.equal(installedManifest(root).core.revision,receipt.core.revision);
});
