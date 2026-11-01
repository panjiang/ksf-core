import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cpSync,existsSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
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
  git(instance, ['config','core.autocrlf','false']);
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
async function reclonedInstance(t) {
  const f=await template(t),remote=join(f.directory,'个人备份.git'),clone=join(f.directory,'重新克隆的实例');mkdirSync(remote);
  git(remote,['init','--bare','--template=','--initial-branch=core-main']);
  git(f.instance,['remote','add','origin',remote]);git(f.instance,['push','--set-upstream','origin','core-main']);
  await initializeInstance({root:f.instance,api:f.api});
  writeAtomic(join(f.instance,'USER.md'),'Synthetic private identity retained after cloning');
  writeAtomic(join(f.instance,'知识/个人资料.md'),'Synthetic private knowledge');
  writeAtomic(join(f.instance,'.agents/core/example.txt'),'A committed local system customization\n');
  git(f.instance,['add','--force','--','.agents/core/release.json','.agents/core/example.txt','.agents/user-data/incubation.json','USER.md','BOT.md','README.md','.gitignore','.gitattributes','知识/个人资料.md']);
  git(f.instance,['commit','-m','Back up initialized personal instance']);git(f.instance,['push']);
  git(f.directory,['clone',remote,clone]);
  git(clone,['config','user.name','Fixture']);git(clone,['config','user.email','fixture@example.invalid']);git(clone,['config','commit.gpgsign','false']);
  git(clone,['config','core.autocrlf','false']);
  assert.equal(git(clone,['branch','--show-current']),'core-main');
  const offline={request:async()=>{throw new Error('Restoring an existing main must not query Core or restart initialization');}};
  return {...f,remote,clone,offline,personal:git(remote,['rev-parse','main']),initial:git(remote,['rev-parse','core-main'])};
}
test('recloning restores the existing personal main offline instead of reinitializing the template snapshot',async t=>{
  const f=await reclonedInstance(t),config=readFileSync(join(f.clone,'.git/config'));
  const preview=await initializeInstance({root:f.clone,api:f.offline,dryRun:true});
  assert.equal(preview.resumed,true);assert.deepEqual(preview.files,[]);
  assert.equal(git(f.clone,['branch','--show-current']),'core-main');assert.deepEqual(readFileSync(join(f.clone,'.git/config')),config);
  const result=await initializeInstance({root:f.clone,api:f.offline});
  assert.equal(result.resumed,true);assert.equal(git(f.clone,['rev-parse','main']),f.personal);
  assert.equal(git(f.clone,['rev-parse','core-main']),f.initial);assert.equal(git(f.remote,['symbolic-ref','HEAD']),'refs/heads/core-main');
  for(const path of ['USER.md','知识/个人资料.md','.agents/core/release.json','.agents/user-data/incubation.json','.agents/core/example.txt'])assert.deepEqual(readRegular(f.clone,path),readRegular(f.instance,path));
  assert.equal(contextEntry(f.clone).mode,contextEntry(f.instance).mode);
  writeAtomic(join(f.clone,'知识/个人资料.md'),'More synthetic private knowledge');git(f.clone,['add','知识/个人资料.md']);git(f.clone,['commit','-m','Continue personal work']);git(f.clone,['push']);
  assert.equal(git(f.remote,['rev-parse','main']),git(f.clone,['rev-parse','HEAD']));assert.equal(git(f.remote,['rev-parse','core-main']),f.initial);
});
test('recloning preserves dirty and ignored files instead of overwriting them during main restoration',async t=>{
  const f=await reclonedInstance(t),entry=readRegular(f.clone,'AGENTS.md'),config=readFileSync(join(f.clone,'.git/config'));
  writeAtomic(join(f.clone,'AGENTS.md'),'Uncommitted synthetic edit');
  await assert.rejects(initializeInstance({root:f.clone,api:f.offline}),{code:'INSTANCE_BRANCH_CONFLICT'});
  assert.equal(readRegular(f.clone,'AGENTS.md').toString(),'Uncommitted synthetic edit');writeAtomic(join(f.clone,'AGENTS.md'),entry);
  writeAtomic(join(f.clone,'USER.md'),'Ignored synthetic identity must survive');
  await assert.rejects(initializeInstance({root:f.clone,api:f.offline}),{code:'INSTANCE_BRANCH_CONFLICT'});
  assert.equal(readRegular(f.clone,'USER.md').toString(),'Ignored synthetic identity must survive');
  assert.equal(git(f.clone,['branch','--show-current']),'core-main');assert.deepEqual(readFileSync(join(f.clone,'.git/config')),config);
  assert.equal(git(f.clone,['for-each-ref','--format=%(refname)','refs/heads/main']),'');
  rmSync(join(f.clone,'USER.md'));
  // A main without a valid initialized receipt must not be replaced by a fresh main.
  git(f.clone,['update-ref','refs/remotes/origin/main',f.initial]);
  await assert.rejects(initializeInstance({root:f.clone,api:f.offline}),{code:'INSTANCE_BRANCH_CONFLICT'});
  assert.equal(git(f.clone,['branch','--show-current']),'core-main');assert.equal(existsSync(join(f.clone,'USER.md')),false);
});
test('recloning rolls back restoration and prefers an existing local main without resetting personal commits',async t=>{
  const f=await reclonedInstance(t);
  // Exercise Windows-style conversion without mixing the helper's isolated
  // global configuration and the initialization subprocess environment.
  git(f.clone,['config','core.autocrlf','true']);const config=readFileSync(join(f.clone,'.git/config'));
  await assert.rejects(initializeInstance({root:f.clone,api:f.offline,fault:path=>{if(path==='git:branch')throw new Error('controlled restore failure');}}),/controlled restore failure/);
  assert.equal(git(f.clone,['branch','--show-current']),'core-main');assert.deepEqual(readFileSync(join(f.clone,'.git/config')),config);
  assert.equal(git(f.clone,['for-each-ref','--format=%(refname)','refs/heads/main']),'');
  assert.equal(git(f.clone,['status','--porcelain']),'');
  git(f.clone,['switch','--track','-c','main','origin/main']);writeAtomic(join(f.clone,'local-only.txt'),'Synthetic unpushed work');
  git(f.clone,['add','local-only.txt']);git(f.clone,['commit','-m','Keep local personal commit']);const local=git(f.clone,['rev-parse','HEAD']);git(f.clone,['switch','core-main']);
  await initializeInstance({root:f.clone,api:f.offline});
  assert.equal(git(f.clone,['rev-parse','HEAD']),local);assert.equal(git(f.clone,['rev-parse','origin/main']),f.personal);
  assert.equal(readRegular(f.clone,'local-only.txt').toString(),'Synthetic unpushed work');assert.equal(git(f.clone,['rev-parse','core-main']),f.initial);
});
test('recloning retains commits made after a restoration process crash',async t=>{
  const f=await reclonedInstance(t),moduleURL=new URL('../src/distribution/instance.js',import.meta.url).href;
  const code=`import {initializeInstance} from ${JSON.stringify(moduleURL)};await initializeInstance({root:${JSON.stringify(f.clone)},fault:path=>{if(path==='git:branch')process.exit(75);}});`;
  const crashed=spawnSync(process.execPath,['--input-type=module','--eval',code],{encoding:'utf8',timeout:60000});
  assert.equal(crashed.status,75,crashed.stderr+crashed.stdout);
  writeAtomic(join(f.clone,'after-crash.txt'),'Synthetic personal work after crash');git(f.clone,['add','after-crash.txt']);git(f.clone,['commit','-m','Preserve work after restoration crash']);const personal=git(f.clone,['rev-parse','HEAD']);
  await assert.rejects(initializeInstance({root:f.clone,api:f.offline}),{code:'INSTANCE_RECOVERY_CONFLICT'});
  assert.equal(git(f.clone,['rev-parse','main']),personal);assert.equal(git(f.clone,['rev-parse','core-main']),f.initial);
  assert.equal(existsSync(join(f.clone,'.agents/runtime-data/instance-initialization/transaction.json')),true);
});
test('a single-branch clone cannot mistake an unfetched personal main for a new instance',async t=>{
  const f=await reclonedInstance(t),limited=join(f.directory,'仅默认分支的克隆');
  git(f.directory,['clone','--single-branch','--branch','core-main',f.remote,limited]);
  assert.equal(git(limited,['for-each-ref','--format=%(refname)','refs/remotes/origin/main']),'');
  const config=readFileSync(join(limited,'.git/config'));
  await assert.rejects(initializeInstance({root:limited,api:f.offline}),{code:'INSTANCE_BRANCH_CONFLICT'});
  assert.equal(git(limited,['branch','--show-current']),'core-main');assert.equal(existsSync(join(limited,'USER.md')),false);
  assert.equal(git(limited,['for-each-ref','--format=%(refname)','refs/heads/main']),'');assert.deepEqual(readFileSync(join(limited,'.git/config')),config);
});
test('legacy rename recovery requires the original Git reference and preserves later personal commits',async t=>{
  for(const personalCommit of [false,true]){
    const f=await template(t),remote=join(f.directory,'旧事务远程.git');mkdirSync(remote);git(remote,['init','--bare','--template=','--initial-branch=core-main']);
    git(f.instance,['remote','add','origin',remote]);git(f.instance,['push','--set-upstream','origin','core-main']);
    const initial=git(f.instance,['rev-parse','HEAD']);git(f.instance,['branch','-m','main']);
    const seed=Buffer.from('Synthetic legacy initialization seed');writeAtomic(join(f.instance,'USER.md'),seed);
    const state={schema_version:1,branchBefore:'core-main',branchAfter:'main',files:[{path:'USER.md',before:null,before_mode:0o644,after_sha256:createHash('sha256').update(seed).digest('hex')}]};
    const path='.agents/runtime-data/instance-initialization/transaction.json';writeAtomic(join(f.instance,path),JSON.stringify(state));
    if(personalCommit){
      git(f.instance,['add','--force','USER.md']);git(f.instance,['commit','-m','Preserve a personal commit after an old process crash']);const personal=git(f.instance,['rev-parse','HEAD']);
      await assert.rejects(initializeInstance({root:f.instance,api:f.api}),{code:'INSTANCE_RECOVERY_CONFLICT'});
      assert.equal(git(f.instance,['branch','--show-current']),'main');assert.equal(git(f.instance,['rev-parse','HEAD']),personal);
      assert.deepEqual(readRegular(f.instance,'USER.md'),seed);assert.equal(existsSync(join(f.instance,path)),true);
    }else{
      assert.equal((await initializeInstance({root:f.instance,api:f.api})).changed,true);
      assert.equal(git(f.instance,['rev-parse','core-main']),initial);assert.equal(git(f.instance,['rev-parse','main']),initial);
      assert.equal(existsSync(join(f.instance,path)),false);
    }
    assert.equal(git(remote,['rev-parse','core-main']),initial);
  }
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
test('recovery retains personal commits made on main after a process crash',async t=>{
  const f=await template(t),original=git(f.instance,['rev-parse','HEAD']);
  const moduleURL=new URL('../src/distribution/instance.js',import.meta.url).href,apiURL=new URL('./helpers/contribution-api.js',import.meta.url).href;
  const code=`import {initializeInstance} from ${JSON.stringify(moduleURL)};import {ForkAPI} from ${JSON.stringify(apiURL)};await initializeInstance({root:${JSON.stringify(f.instance)},revision:${JSON.stringify(f.first.coreRevision)},api:new ForkAPI({coreRoot:${JSON.stringify(f.root)}}),fault:path=>{if(path==='git:branch')process.exit(75);}});`;
  const crashed=spawnSync(process.execPath,['--input-type=module','--eval',code],{encoding:'utf8',timeout:60000});
  assert.equal(crashed.status,75,crashed.stderr+crashed.stdout);
  writeAtomic(join(f.instance,'personal.txt'),'Synthetic work after interruption');git(f.instance,['add','personal.txt']);git(f.instance,['commit','-m','Preserve personal work']);
  const personal=git(f.instance,['rev-parse','HEAD']);
  await assert.rejects(initializeInstance({root:f.instance,api:f.api}),{code:'INSTANCE_RECOVERY_CONFLICT'});
  assert.equal(git(f.instance,['rev-parse','main']),personal);assert.equal(git(f.instance,['rev-parse','core-main']),original);
  assert.equal(existsSync(join(f.instance,'.agents/runtime-data/instance-initialization/transaction.json')),true);
  assert.equal(readRegular(f.instance,'personal.txt').toString(),'Synthetic work after interruption');
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
