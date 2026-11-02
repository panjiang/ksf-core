import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {platform,platformCapabilities} from '../src/platform/index.js';
import {runtimePackage} from '../src/platform/catalog.js';
import {configureAutostart,openWorkbench,serviceStatus,ensureService,stopService} from '../src/services/service-manager.js';
import {runServiceCommand} from '../src/commands/service.js';
import {createConfigurationService} from '../src/services/configuration.js';
import {createWorkbenchTerminal} from '../src/services/workbench-terminal.js';
import {createIncubationService} from '../src/services/incubation.js';
import {writeUserData} from '../src/services/user-data.js';
import {locateCLI} from '../src/codex-conversations/app-server.js';
import {buildRelease} from '../src/distribution/release.js';
import {inspectReleaseDirectory} from '../src/distribution/publish.js';
import {products,releaseIndexName} from '../src/distribution/products.js';
import {startWebServer} from '../src/services/web.js';

const repo=fileURLToPath(new URL('../../../../',import.meta.url));
function scratch(t){const root=mkdtempSync(join(tmpdir(),'ksf linux 中文 '));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('Linux uses POSIX tools and independent process identity, and excludes desktop features',()=>{
  assert.equal(platform.name,'linux');
  assert.deepEqual(platformCapabilities,{terminal:false,desktop:false,openURI:false,loginStartup:false});
  assert.ok(platform.processStart(process.pid));
  assert.equal(platform.processStart(process.pid),spawnSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}).stdout.trim().replace(/\s+/g,' '));
  assert.equal(runtimePackage('linux-x64','24.21.0').nodeMember,'node-v24.21.0-linux-x64/bin/node');
  assert.throws(()=>platform.tool('ksf-deliberately-absent'),{code:'PLATFORM_TOOL_MISSING'});
});
test('unsupported actions fail before config, process or native PTY side effects',async t=>{
  const root=scratch(t),config=createConfigurationService(root);
  const before=await config.read('service');assert.equal(before.defaults.autostart,false);
  await assert.rejects(config.perform('service','write',{ifMatch:before.etag,values:{autostart:true}}),{code:'PLATFORM_UNSUPPORTED'});
  await assert.rejects(config.check('service',{values:{autostart:true}}),{code:'PLATFORM_UNSUPPORTED'});
  await assert.rejects(configureAutostart(root,true),{code:'PLATFORM_UNSUPPORTED'});
  await assert.rejects(openWorkbench(root),{code:'PLATFORM_UNSUPPORTED'});
  await assert.rejects(locateCLI(),{code:'PLATFORM_UNSUPPORTED'});
  let loaded=false;const terminal=createWorkbenchTerminal(root,{loadPTY:async()=>{loaded=true;throw Error('native code must not load');}});
  await assert.rejects(terminal.create({runtimeId:'a',instanceId:'b'},{cols:80,rows:24}),{code:'PLATFORM_UNSUPPORTED'});
  assert.equal(loaded,false);await terminal.dispose();
  assert.equal((await config.read('service')).etag,before.etag);
  assert.equal(existsSync(join(root,'.agents/runtime-data/service/policy.json')),false);
  assert.equal((await serviceStatus(root)).state,'stopped');
  assert.equal(existsSync(join(root,'.agents/runtime-data/service/start-request.json')),false);
  await configureAutostart(root,false);assert.equal((await config.read('service')).values.autostart,false);
});
test('Linux incubation defaults permit core setup and reject unsupported explicit choices without writes',async t=>{
  const root=scratch(t);writeUserData({root,namespace:'incubation',ifMatch:'missing',values:{status:'pending'}});
  const incubation=createIncubationService(root),before=await incubation.read();
  assert.equal(before.candidate.autostart,false);
  for(const values of [{autostart:true},{openWorkbench:true}]){
    await assert.rejects(incubation.write({values,ifMatch:before.etag}),{code:'PLATFORM_UNSUPPORTED'});
    assert.equal((await incubation.read()).etag,before.etag);
  }
});
test('Linux incubation finishes with manual startup and no desktop opening',async t=>{
  const root=scratch(t),server=await startWebServer({root,port:0,capture:false});t.after(()=>server.close());
  writeUserData({root,namespace:'incubation',ifMatch:'missing',values:{status:'pending'}});
  let opened=false;
  const incubation=createIncubationService(root,{open:async()=>{opened=true;throw Error('must not open');}});
  const before=await incubation.read();
  const draft=await incubation.write({ifMatch:before.etag,values:{userLabel:'Linux 用户',instanceName:'Linux KSF',deviceName:'Linux PC'}});
  const result=await incubation.finish({ifMatch:draft.etag});
  assert.equal(result.values.status,'completed');assert.equal(result.values.operation.workbench.state,'suppressed');assert.equal(opened,false);
  assert.equal(JSON.parse(readFileSync(join(root,'.agents/runtime-data/service/policy.json'))).autostart,false);
});
test('Linux detached HTTP service starts, restarts and stops without desktop dependencies',async t=>{
  const root=scratch(t),listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  mkdirSync(join(root,'.agents/runtime-data/service'),{recursive:true});
  writeFileSync(join(root,'.agents/runtime-data/service/policy.json'),JSON.stringify({schemaVersion:1,port,autostart:false}));
  t.after(()=>stopService(root,{force:true}));
  const first=await ensureService(root);assert.equal(first.state,'running');assert.equal(new URL(first.directUrl).hostname,'127.0.0.1');
  const health=await fetch(new URL('api/health',first.directUrl));assert.equal(health.status,200);assert.equal((await health.json()).service,'ksf-core');
  const restarted=await runServiceCommand(['restart','--json'],root);assert.equal(restarted.exitCode,0,restarted.stdout);
  const second=await serviceStatus(root);assert.equal(second.state,'running');assert.notEqual(second.pid,first.pid);
  const diagnosis=await runServiceCommand(['doctor','--json'],root);assert.equal(diagnosis.exitCode,0,diagnosis.stdout);
  await stopService(root);assert.equal((await serviceStatus(root)).state,'stopped');
});
test('Linux release requests fail before creating artifacts',async t=>{
  const root=scratch(t);mkdirSync(join(root,'.agents/core'),{recursive:true});
  writeFileSync(join(root,'.agents/core/build.json'),JSON.stringify({runtime:{packages:{'linux-x64':{}}}}));
  await assert.rejects(buildRelease({root,platform:'linux-x64',dryRun:true}),{code:'PLATFORM_UNSUPPORTED'});
  assert.equal(existsSync(join(root,'.agents/runtime-data/releases')),false);
  copyFileSync(join(repo,'.agents/core/distribution.json'),join(root,'.agents/core/distribution.json'));
  writeFileSync(join(root,releaseIndexName),JSON.stringify({schema_version:2,core_repository:'yinbaiyuan/ksf-core',development:false,products,platforms:{'linux-x64':{core:{}}}}));
  assert.throws(()=>inspectReleaseDirectory(root,root),{code:'PLATFORM_UNSUPPORTED'});
});
test('flock recovery remains exclusive, releases after exit and protects an active transaction',async t=>{
  const root=scratch(t),system=join(root,'.agents/runtime-data/system'),transaction=join(system,'transaction');
  mkdirSync(transaction,{recursive:true});copyFileSync(join(repo,'.agents/ksf'),join(root,'.agents/ksf'));
  for(const [name,value] of Object.entries({protocol:'1',owner:String(process.pid),'owner.start':platform.processStart(process.pid),name:'linux-recovery'}))writeFileSync(join(transaction,name),value+'\n');
  const run=()=>spawnSync('/bin/sh',[join(root,'.agents/ksf'),'launcher','recover'],{encoding:'utf8',env:{...process.env,PATH:'',LC_ALL:'C'}});
  assert.match(run().stderr,/UPDATE_BUSY/);
  const lock=join(system,'recovery.lock');
  const holder=spawn('/usr/bin/flock',[lock,'/bin/sh','-c','printf ready; read answer'],{stdio:['pipe','pipe','pipe']});
  t.after(()=>holder.kill('SIGKILL'));
  await new Promise((resolve,reject)=>{holder.stdout.once('data',resolve);holder.once('error',reject);});
  assert.match(run().stderr,/RECOVERY_BUSY/);
  const closed=new Promise(resolve=>holder.once('close',resolve));holder.stdin.end('\n');await closed;
  writeFileSync(join(transaction,'owner'),'2147483647\n');
  const result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(existsSync(lock),true);assert.equal(run().status,0);
  assert.equal(spawnSync('/usr/bin/flock',['-n',lock,'/usr/bin/true']).status,0);
});
