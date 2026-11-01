import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {git} from './helpers/distribution-fixture.js';
import {initializeInstance,needsInstanceInitialization} from '../src/distribution/instance.js';
import {contextEntry} from '../src/services/entry-context.js';
import {installedManifest} from '../src/distribution/manifests.js';
import {writeAtomic,readRegular} from '../src/distribution/files.js';
import {template} from './helpers/instance-fixture.js';
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
  assert.equal(result.createdBranch,true); assert.equal(result.pushTarget,'origin/main');
  assert.equal(git(f.instance,['rev-parse','core-main']),git(f.instance,['rev-parse','main']));
  assert.equal(git(f.instance,['config','branch.main.merge']),'refs/heads/main');
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
  git(f.instance,['config','push.default','matching']);git(f.instance,['config','branch.main.remote','saved-remote']);
  await assert.rejects(initializeInstance({root:f.instance,api:f.api,fault:path=>{if(path==='BOT.md')throw new Error('controlled failure');}}),/controlled failure/);
  assert.equal(existsSync(join(f.instance,'USER.md')),false);assert.equal(existsSync(join(f.instance,'BOT.md')),false);
  assert.deepEqual(readFileSync(join(f.instance,'.gitignore')),before);
  assert.equal(git(f.instance,['branch','--show-current']),'core-main');
  assert.equal(git(f.instance,['config','push.default']),'matching');
  assert.equal(git(f.instance,['config','branch.main.remote']),'saved-remote');
  assert.equal(git(f.instance,['for-each-ref','--format=%(refname)','refs/heads/main']),'');
  assert.equal((await initializeInstance({root:f.instance,api:f.api})).changed,true);
});

test('a cloned core-main keeps its refs and tracking while ordinary personal pushes update only main',async t=>{
  const f=await template(t),remote=join(f.directory,'个人远程.git');mkdirSync(remote);
  git(remote,['init','--bare','--template=','--initial-branch=core-main']);
  git(f.instance,['remote','add','origin',remote]);git(f.instance,['push','--set-upstream','origin','core-main']);
  const original=git(remote,['rev-parse','refs/heads/core-main']);
  git(f.instance,['config','push.default','matching']);
  git(f.instance,['config','branch.autoSetupMerge','inherit']);
  const configBefore=readFileSync(join(f.instance,'.git/config'));
  await initializeInstance({root:f.instance,api:f.api,dryRun:true});
  assert.deepEqual(readFileSync(join(f.instance,'.git/config')),configBefore);
  assert.equal(git(f.instance,['for-each-ref','--format=%(refname)','refs/heads/main']),'');
  await initializeInstance({root:f.instance,api:f.api});
  assert.equal(git(f.instance,['config','branch.core-main.remote']),'origin');
  assert.equal(git(f.instance,['config','branch.core-main.merge']),'refs/heads/core-main');
  assert.equal(git(f.instance,['config','branch.main.remote']),'origin');
  assert.equal(git(f.instance,['config','branch.main.merge']),'refs/heads/main');
  assert.equal(git(f.instance,['config','branch.main.pushRemote']),'origin');
  assert.equal(git(f.instance,['config','push.default']),'current');
  assert.equal(git(remote,['symbolic-ref','HEAD']),'refs/heads/core-main');
  assert.equal(git(remote,['for-each-ref','--format=%(refname)','refs/heads/main']),'');
  const path='知识/个人资料.md';
  for(const text of ['仅个人实例保存的合成材料','再次更新个人资料']){
    writeAtomic(join(f.instance,path),text);git(f.instance,['add','--',path]);git(f.instance,['commit','-m','Synthetic personal change']);
    git(f.instance,['push']);
    assert.equal(git(remote,['rev-parse','refs/heads/main']),git(f.instance,['rev-parse','HEAD']));
    assert.equal(git(remote,['rev-parse','refs/heads/core-main']),original);
    assert.equal(git(f.instance,['rev-parse','refs/heads/core-main']),original);
    assert.equal(git(remote,['symbolic-ref','HEAD']),'refs/heads/core-main');
  }
  const after=readFileSync(join(f.instance,'.git/config'));
  assert.equal((await initializeInstance({root:f.instance,api:f.api})).changed,false);
  assert.deepEqual(readFileSync(join(f.instance,'.git/config')),after);
});

test('explicit origin push mappings, mirrors and an existing main stop before changing files or refs',async t=>{
  const f=await template(t),head=git(f.instance,['rev-parse','HEAD']);
  for(const [key,value] of [['remote.origin.push','refs/heads/main:refs/heads/core-main'],['remote.origin.mirror','true']]){
    git(f.instance,['config',key,value]);
    await assert.rejects(initializeInstance({root:f.instance,api:f.api}),{code:'INSTANCE_PUSH_CONFIG_CONFLICT'});
    assert.equal(existsSync(join(f.instance,'USER.md')),false);
    assert.equal(git(f.instance,['branch','--show-current']),'core-main');
    assert.equal(git(f.instance,['config',key]),value);git(f.instance,['config','--unset-all',key]);
  }
  git(f.instance,['branch','--no-track','main']);
  await assert.rejects(initializeInstance({root:f.instance,api:f.api}),{code:'INSTANCE_BRANCH_CONFLICT'});
  assert.equal(git(f.instance,['rev-parse','main']),head);assert.equal(git(f.instance,['branch','--show-current']),'core-main');
  git(f.instance,['switch','main']);
  assert.equal((await initializeInstance({root:f.instance,api:f.api})).createdBranch,false);
  assert.equal(git(f.instance,['rev-parse','core-main']),head);
});

test('official Core URL variants and hidden push destinations cannot initialize a personal main',async t=>{
  const f=await template(t),config=JSON.parse(readRegular(f.instance,'.agents/core/distribution.json')),repo=config.core_repository;
  const variants=[`ssh://git@github.com/${repo}.git`,`https://example-user@github.com/${repo.toUpperCase()}.git/`,`git@github.com:${repo.toUpperCase()}.git`];
  git(f.instance,['remote','add','origin',variants[0]]);
  for(const url of variants){
    git(f.instance,['remote','set-url','origin',url]);
    await assert.rejects(initializeInstance({root:f.instance,api:f.api}),{code:'INSTANCE_CORE_SOURCE'});
    assert.equal(existsSync(join(f.instance,'USER.md')),false);assert.equal(git(f.instance,['branch','--show-current']),'core-main');
  }
  git(f.instance,['remote','set-url','origin','https://github.com/example/private-instance.git']);
  git(f.instance,['config','--add','remote.origin.pushurl','https://github.com/example/private-instance.git']);
  git(f.instance,['config','--add','remote.origin.pushurl',variants[0]]);
  const before=readFileSync(join(f.instance,'.git/config'));
  await assert.rejects(initializeInstance({root:f.instance,api:f.api}),{code:'INSTANCE_PUSH_CONFIG_CONFLICT'});
  assert.deepEqual(readFileSync(join(f.instance,'.git/config')),before);assert.equal(existsSync(join(f.instance,'USER.md')),false);
  assert.equal(git(f.instance,['for-each-ref','--format=%(refname)','refs/heads/main']),'');
  git(f.instance,['config','--unset-all','remote.origin.pushurl']);
  git(f.instance,['config',`url.${variants[0]}.pushInsteadOf`,'https://github.com/example/private-instance.git']);
  const rewritten=readFileSync(join(f.instance,'.git/config'));
  await assert.rejects(initializeInstance({root:f.instance,api:f.api}),{code:'INSTANCE_PUSH_CONFIG_CONFLICT'});
  assert.deepEqual(readFileSync(join(f.instance,'.git/config')),rewritten);assert.equal(existsSync(join(f.instance,'USER.md')),false);
});
