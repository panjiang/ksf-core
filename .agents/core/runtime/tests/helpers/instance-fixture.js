import assert from 'node:assert/strict';
import {cpSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {distributionFixture,git} from './distribution-fixture.js';
import {ForkAPI} from './contribution-api.js';
import {initializeInstance} from '../../src/distribution/instance.js';
import {writeAtomic} from '../../src/distribution/files.js';
export async function template(t) {
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
export async function reclonedInstance(t) {
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
