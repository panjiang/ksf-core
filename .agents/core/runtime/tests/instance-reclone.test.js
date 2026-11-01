import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {git} from './helpers/distribution-fixture.js';
import {initializeInstance} from '../src/distribution/instance.js';
import {contextEntry} from '../src/services/entry-context.js';
import {writeAtomic,readRegular} from '../src/distribution/files.js';
import {template,reclonedInstance} from './helpers/instance-fixture.js';
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
