import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {request} from 'node:https';
import {Readable} from 'node:stream';
import {createCommunicationService} from '../src/communication/service.js';
import {loadIdentity} from '../src/communication/identity.js';
const APP='example.messenger',CHANNEL='chat.v1';
async function fixture(t){
 const roots=await Promise.all([1,2].map(()=>mkdtemp(join(tmpdir(),'ksf-pairing-')))),callbacks=[],nodes=[];let time=Date.now();
 const apps={messageRoute:async(appId,channel)=>({enabled:appId===APP&&channel===CHANNEL,running:false}),deliverMessage:async()=>{}};
 for(let i=0;i<2;i++){nodes[i]=await createCommunicationService(roots[i],{applications:apps,now:()=>time,discoveryFactory:()=>({on(){},publish(){return {stop(){}};},find(_query,callback){callbacks[i]=callback;return {on(){},stop(){}};},destroy(callback){callback();}})});await nodes[i].configure({enabled:true,host:'127.0.0.1',port:0,discovery:true});}
 t.after(async()=>{await Promise.all(nodes.map(n=>n.close()));await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));});
 const states=await Promise.all(nodes.map(n=>n.snapshot()));
 const discover=(i,j,nodeId=states[j].identity.nodeId)=>callbacks[i]({name:'test',addresses:['127.0.0.1'],port:states[j].listener.port,txt:{nodeId,pairingPort:String(states[j].pairingListener.port),name:'Test '+j}});
 discover(0,1);discover(1,0);
 const input={requestId:randomUUID(),nodeId:states[1].identity.nodeId,appId:APP,channel:CHANNEL};
 return {a:nodes[0],b:nodes[1],nodes,roots,states,input,discover,advance:ms=>{time+=ms;}};
}
async function raw(root,target,action,input){const identity=await loadIdentity(root);return new Promise((resolve,reject)=>{const body=Buffer.from(JSON.stringify(input)),req=request({host:'127.0.0.1',port:target.pairingListener.port,path:'/pairing/v1/'+action,method:'POST',key:identity.privateKey,cert:identity.certificate,rejectUnauthorized:false,headers:{'content-type':'application/json','content-length':body.length}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(body);});}
test('one request and one approval mutually pin identities and grant only the selected application channel',async t=>{
 const f=await fixture(t);await f.a.setDevice({name:'设备 A'});await f.b.setDevice({name:'设备 B'});const out=await f.a.pairing.request(f.input);assert.equal(out.status,'pending');assert.deepEqual((await f.a.store.config()).peers,{});assert.deepEqual((await f.b.store.config()).peers,{});
 const received=(await f.b.pairing.list(APP))[0];assert.equal(received.name,'设备 A');assert.equal(received.requestId,out.requestId);assert.equal(received.code,out.code);assert.equal((await f.b.pairing.list('other.app')).length,0);
 assert.equal((await f.b.pairing.answer({requestId:out.requestId,accept:true,appId:APP})).status,'accepted');
 for(const [node,other] of [[f.a,f.states[1]],[f.b,f.states[0]]]){const cfg=await node.store.config();assert.equal(cfg.peers[other.identity.nodeId].fingerprint,other.identity.fingerprint);assert.equal(cfg.peers[other.identity.nodeId].name,node===f.a?'设备 B':'设备 A');assert.deepEqual(cfg.grants,{[APP+'|'+CHANNEL]:{peers:[other.identity.nodeId],activation:true}});}
 const material=await f.a.registerMaterial({kind:'app',id:APP},Readable.from(['paired message'])),op=await f.a.send({kind:'app',id:APP},{operationId:randomUUID(),to:{nodeId:f.states[1].identity.nodeId,endpoint:{kind:'app',id:APP}},channel:CHANNEL,payloadPartId:'body',parts:[{partId:'body',materialId:material.materialId}]});
 // Wait for the sender's durable confirmation, which is distinct from peer
 // acceptance and can take longer than one second on a Windows CI filesystem.
 const deadline=performance.now()+10000;let state;do{state=await f.a.getOperation({kind:'app',id:APP},op.operationId);if(['delivered','failed'].includes(state.status))break;await new Promise(r=>setTimeout(r,25));}while(performance.now()<deadline);assert.equal(state.status,'delivered',JSON.stringify(state));
});
test('rejecting and expiry never add trust or receive grants',async t=>{
 const f=await fixture(t);await f.a.pairing.request(f.input);await f.b.pairing.answer({requestId:f.input.requestId,accept:false,appId:APP});await f.a.pairing.poll();assert.equal((await f.a.pairing.list())[0].status,'rejected');
 const next={...f.input,requestId:randomUUID()};await f.a.pairing.request(next);f.advance(6*60000);await assert.rejects(f.b.pairing.answer({requestId:next.requestId,accept:true,appId:APP}),{code:'COMM_PAIRING_CLOSED'});for(const node of f.nodes){const cfg=await node.store.config();assert.deepEqual(cfg.peers,{});assert.deepEqual(cfg.grants,{});}
});
test('a forged discovery identity cannot exchange any pairing data with the actual node',async t=>{
 const f=await fixture(t),fake='f'.repeat(64);f.discover(0,1,fake);await assert.rejects(f.a.pairing.request({...f.input,nodeId:fake}),{code:'COMM_PAIRING_IDENTITY'});assert.equal((await f.b.pairing.list()).length,0);
});
test('unpaired clients cannot use the strict mutual TLS message listener',async t=>{
 const f=await fixture(t);await f.a.pairing.request(f.input);await assert.rejects(f.a.requestPeer({...f.states[1].identity,host:'127.0.0.1',port:f.states[1].listener.port},'/peer/v1/capabilities'));
 assert.deepEqual((await f.b.store.config()).peers,{});
});
test('duplicate requests are stable and premature completion or wrong app approval is rejected',async t=>{
 const f=await fixture(t);await f.a.pairing.request(f.input);await f.a.pairing.request(f.input);assert.equal((await f.b.pairing.list()).length,1);
 const result=await raw(f.roots[1],f.states[0],'complete',{requestId:f.input.requestId});assert.equal(result.status,409);assert.deepEqual((await f.a.store.config()).peers,{});
 await assert.rejects(f.b.pairing.answer({requestId:f.input.requestId,accept:true,appId:'other.app'}),{code:'COMM_FORBIDDEN'});
 await assert.rejects(f.a.pairing.request({...f.input,requestId:randomUUID(),channel:'other.v1'}),{code:'COMM_PAIRING_APP_UNAVAILABLE'});
});
test('body identity must equal the certificate whose private key authenticated the TLS client',async t=>{
 const f=await fixture(t),result=await raw(f.roots[0],f.states[1],'request',{protocol:'ksf-pairing-v1',requestId:randomUUID(),targetNodeId:f.states[1].identity.nodeId,identity:f.states[1].identity,name:'forged',appId:APP,channel:CHANNEL,port:f.states[0].listener.port,pairingPort:f.states[0].pairingListener.port,expiresAt:Date.now()+60000});assert.equal(result.status,403);assert.equal((await f.b.pairing.list()).length,0);
});
test('revocation cancels pairing records so replay cannot restore trust',async t=>{
 const f=await fixture(t);await f.a.pairing.request(f.input);await f.b.pairing.answer({requestId:f.input.requestId,accept:true,appId:APP});await f.a.untrust(f.states[1].identity.nodeId);
 const result=await raw(f.roots[1],await f.a.snapshot(),'complete',{requestId:f.input.requestId});assert.equal(result.status,409);assert.deepEqual((await f.a.store.config()).peers,{});await f.a.pairing.poll();assert.deepEqual((await f.a.store.config()).peers,{});
});
test('recovery completes both durable sides after interruption between local commit and final confirmation',async t=>{
 const f=await fixture(t);await f.a.pairing.request(f.input);
 const approved=await raw(f.roots[1],f.states[0],'approve',{requestId:f.input.requestId,identity:f.states[1].identity,name:'Test B'});assert.equal(approved.status,200);
 // Simulate B's committed local consent followed by process loss before its complete request.
 await f.b.store.update(cfg=>{const row=cfg.pairings[f.input.requestId];cfg.peers[row.remote.nodeId]={...row.remote.identity,host:row.remote.host,port:row.remote.port,name:row.remote.name};cfg.grants[APP+'|'+CHANNEL]={peers:[row.remote.nodeId],activation:true};row.status='confirming';});
 assert.deepEqual((await f.a.store.config()).peers,{});
 await f.a.pairing.poll();await f.b.pairing.poll();
 for(const node of f.nodes){assert.equal((await node.pairing.list())[0].status,'accepted');assert.equal(Object.keys((await node.store.config()).peers).length,1);assert.equal((await node.pairing.list()).length,1);}
 assert.equal((await f.b.pairing.answer({requestId:f.input.requestId,accept:true,appId:APP})).status,'accepted');
});
test('paired names refresh through authenticated capabilities and ignore forged discovery labels',async t=>{
 const f=await fixture(t);await f.a.pairing.request(f.input);await f.b.pairing.answer({requestId:f.input.requestId,accept:true,appId:APP});
 await f.b.setDevice({name:'超哥的 Windows'});await f.a.store.update(cfg=>{cfg.peers[f.states[1].identity.nodeId].deviceName='Test 1';});f.discover(0,1);f.advance(11000);await f.a.peerDirectory();
 let name;for(let n=0;n<100;n++){name=(await f.a.store.config()).peers[f.states[1].identity.nodeId].deviceName;if(name==='超哥的 Windows')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(name,'超哥的 Windows');assert.equal((await f.a.peerDirectory()).paired[0].name,'超哥的 Windows');assert.equal((await f.a.store.config()).peers[f.states[1].identity.nodeId].name!==name,true,'the old manually stored name is retained');
});
