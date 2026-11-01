import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeNodeExecutable} from './helpers/platform.js';

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(check,ms){const end=Date.now()+ms;do{if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<end);}
test('contained native fixture stops its Node child when only the wrapper is killed',{skip:process.platform!=='win32'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'ksf-native-contained-')),marker=join(root,'started.json');let bodyPid;
 const executable=writeNodeExecutable(join(root,'fixture.exe'),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`,{containChildren:true});
 const child=spawn(executable,[],{cwd:root,stdio:'ignore',windowsHide:true});
 const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 t.after(async()=>{
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;
  if(bodyPid&&alive(bodyPid)){process.kill(bodyPid,'SIGKILL');await until(()=>!alive(bodyPid),3000);}
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 });
 await until(async()=>{try{bodyPid=JSON.parse(await readFile(marker,'utf8')).pid;return true;}catch{return false;}},10000);
 assert.ok(bodyPid,'The fixture body must start before the controlled crash.');assert.notEqual(bodyPid,child.pid);
 child.kill('SIGKILL');await exited;
 await until(()=>!alive(bodyPid),3000);
 assert.equal(alive(bodyPid),false,'A killed native wrapper must not orphan its Node body or retain its working directory.');
});
