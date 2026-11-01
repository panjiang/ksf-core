import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cpSync,existsSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {distributionFixture,git,commitWorkspace,contributionDescription} from './helpers/distribution-fixture.js';
import {ForkAPI} from './helpers/contribution-api.js';
import {initializeInstance,needsInstanceInitialization} from '../src/distribution/instance.js';
import {contextEntry} from '../src/services/entry-context.js';
import {buildRelease} from '../src/distribution/release.js';
import {systemUpdate,systemCheck} from '../src/distribution/system.js';
import {installedManifest} from '../src/distribution/manifests.js';
import {writeAtomic,readRegular} from '../src/distribution/files.js';
import {prepareContribution,submitContribution} from '../src/distribution/contribute.js';
async function template(t) {
  const f = await distributionFixture(t), instance = join(f.directory, '新用户 独立实例');
  cpSync(f.root, instance, { recursive: true, filter: path => !path.endsWith('/.git') && !path.endsWith('\\.git') });
  git(instance, ['init','--template=','--initial-branch=core-main']);
  git(instance, ['config','user.name','Fixture']); git(instance, ['config','user.email','fixture@example.invalid']);
  git(instance, ['config','commit.gpgsign','false']); git(instance, ['add','--force','.']);
  git(instance, ['update-index','--chmod=+x','.agents/ksf']); git(instance,['commit','-m','Independent template initial commit']);
  assert.notEqual(git(instance,['rev-parse','HEAD']),f.first.coreRevision);
  const api = new ForkAPI({ coreRoot: f.root }), request = api.request.bind(api);
  api.request = async (method,path,...rest) => path.includes('/commits?sha=') ? [{ sha: f.first.coreRevision, commit: { tree: { sha: git(f.root,['rev-parse','HEAD^{tree}']) } } }] : request(method,path,...rest);
  return { ...f, instance, api };
}
test('independent Core template verifies its original tree, uses main, and enters incubation', async t => {
  const f = await template(t);
  assert.equal(needsInstanceInitialization(f.instance),true);
  assert.equal(contextEntry(f.instance).mode,'instance-setup');
  let preview; try { preview = await initializeInstance({root:f.instance,api:f.api,dryRun:true}); } catch (error) { t.diagnostic(JSON.stringify(error.data)); throw error; }
  assert.equal(preview.wouldChange,true); assert.equal(existsSync(join(f.instance,'USER.md')),false);
  writeAtomic(join(f.instance,'USER.md'),'My existing private preferences');
  const remote = 'https://github.com/example/my-private-ksf.git';git(f.instance,['remote','add','origin',remote]);
  const result = await initializeInstance({root:f.instance,api:f.api});
  assert.equal(result.changed,true); assert.equal(git(f.instance,['branch','--show-current']),'main');
  assert.equal(git(f.instance,['remote','get-url','origin']),remote);
  assert.equal(readRegular(f.instance,'USER.md').toString(),'My existing private preferences');
  assert.equal(installedManifest(f.instance).core.revision,f.first.coreRevision);
  assert.equal(contextEntry(f.instance).mode,'incubation');
  assert.equal((await initializeInstance({root:f.instance,api:f.api})).changed,false);
});
test('unverified source and modified system files fail before seeding or renaming', async t => {
  const f = await template(t);
  await assert.rejects(initializeInstance({root:f.instance,api:{request:async()=>[]}}),{code:'INSTANCE_SOURCE_UNVERIFIED'});
  writeAtomic(join(f.instance,'.agents/core/private.js'),'local edit');
  await assert.rejects(initializeInstance({root:f.instance,api:f.api}),{code:'INSTANCE_SOURCE_MODIFIED'});
  assert.equal(existsSync(join(f.instance,'USER.md')),false);
  assert.equal(git(f.instance,['branch','--show-current']),'core-main');
});
test('initialization failure restores files and branch, and can be retried', async t => {
  const f = await template(t), before = readFileSync(join(f.instance,'.gitignore'));
  await assert.rejects(initializeInstance({root:f.instance,api:f.api,fault:path=>{if(path==='BOT.md')throw new Error('controlled failure');}}),/controlled failure/);
  assert.equal(existsSync(join(f.instance,'USER.md')),false);assert.equal(existsSync(join(f.instance,'BOT.md')),false);
  assert.deepEqual(readFileSync(join(f.instance,'.gitignore')),before);
  assert.equal(git(f.instance,['branch','--show-current']),'core-main');
  assert.equal((await initializeInstance({root:f.instance,api:f.api})).changed,true);
});
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
  const f=await distributionFixture(t,{compact:true}),receipt=installedManifest(f.workspace),native=receipt.platform;
  receipt.platform=native==='win32-x64'?'darwin-arm64':'win32-x64';writeAtomic(join(f.workspace,'.agents/core/release.json'),JSON.stringify(receipt));
  const api=new ForkAPI({coreRoot:f.root}),source=join(f.first.output,'ksf-core-index.json');
  const check=await systemCheck({root:f.workspace,source,api});
  assert.equal(check.platform,native);assert.equal(check.available,true);assert.equal(check.platformSwitch,true);
  const item=f.first.index.platforms[native].core;
  await systemUpdate({root:f.workspace,from:join(f.first.output,item.name),api});
  assert.equal(installedManifest(f.workspace).platform,native);assert.equal(installedManifest(f.workspace).core.revision,receipt.core.revision);
});

test('a crash after writing the receipt still requires initialization recovery before incubation',async t=>{
  const f=await template(t),moduleURL=new URL('../src/distribution/instance.js',import.meta.url).href,apiURL=new URL('./helpers/contribution-api.js',import.meta.url).href;
  const code=`import {initializeInstance} from ${JSON.stringify(moduleURL)};import {ForkAPI} from ${JSON.stringify(apiURL)};await initializeInstance({root:${JSON.stringify(f.instance)},revision:${JSON.stringify(f.first.coreRevision)},api:new ForkAPI({coreRoot:${JSON.stringify(f.root)}}),fault:path=>{if(path==='.agents/core/release.json')process.exit(75);}});`;
  const crashed=spawnSync(process.execPath,['--input-type=module','--eval',code],{encoding:'utf8',timeout:60000});
  assert.equal(crashed.status,75,crashed.stderr+crashed.stdout);
  assert.equal(existsSync(join(f.instance,'.agents/core/release.json')),true);
  assert.equal(existsSync(join(f.instance,'.agents/runtime-data/instance-initialization/transaction.json')),true);
  assert.equal(contextEntry(f.instance).mode,'instance-setup');
  const result=await initializeInstance({root:f.instance,revision:f.first.coreRevision,api:f.api});
  assert.equal(result.initialized,true);assert.equal(result.changed,true);
  assert.equal(existsSync(join(f.instance,'.agents/runtime-data/instance-initialization/transaction.json')),false);
  assert.equal(contextEntry(f.instance).mode,'incubation');
});
