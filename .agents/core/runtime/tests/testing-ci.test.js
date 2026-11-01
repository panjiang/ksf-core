import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sourceIdentity,validateCoverage,validateProof,trustedRun,restorePreparedLinks} from '../src/testing/ci.js';
import {gitBinary,nullDevice} from './helpers/platform.js';
import {loadCatalog,catalogPath} from '../src/testing/catalog.js';
function proofFixture(t){
 const root=mkdtempSync(join(tmpdir(),'ksf-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'.agents/core/runtime/tests'),{recursive:true});mkdirSync(join(root,'.agents/core/runtime/testing'));
 writeFileSync(join(root,'.agents/core/runtime/tests/a.test.js'),'// fixture');writeFileSync(join(root,'.agents/core/build.json'),JSON.stringify({runtime:{version:process.version.slice(1),packages:{fixture:'locked'}}}));
 writeFileSync(join(root,catalogPath),JSON.stringify({schemaVersion:1,components:{core:{directory:'.agents/core/runtime',testRoots:['.agents/core/runtime/tests']}},risks:[],tests:[{id:'a',owner:'core',covers:['core'],path:'.agents/core/runtime/tests/a.test.js',suite:'quick',platforms:['darwin','win32'],inputs:[],requirements:[],timeoutMs:1000}]}));
 for(const args of [['init','--template='],['add','.']])assert.equal(spawnSync(gitBinary,['-C',root,...args],{env:{...process.env,GIT_CONFIG_GLOBAL:nullDevice,GIT_CONFIG_SYSTEM:nullDevice}}).status,0);
 return root;
}
test('CI proof requires complete disjoint native coverage and exact trusted source',t=>{
 const root=proofFixture(t);
 const identity=sourceIdentity(root),reports=['darwin','win32'].map(platform=>({complete:true,status:'passed',suite:'full',platform,architecture:platform==='darwin'?'arm64':'x64',nodeVersion:process.version,catalogDigest:loadCatalog(root).digest,sourceDigest:identity.sourceDigest,changedInputs:[],summary:{reused:0},results:[{status:'passed',path:'.agents/core/runtime/tests/a.test.js'}]}));
 assert.equal(validateCoverage(root,reports).full,true);
 assert.throws(()=>validateCoverage(root,[...reports,reports[0]]),{code:'TEST_PROOF_INVALID'});
 assert.throws(()=>validateCoverage(root,reports.slice(0,1)),{code:'TEST_PROOF_INVALID'});
 for(const override of [{summary:{reused:1}},{changedInputs:['x']},{catalogDigest:'stale'},{status:'cancelled'}])assert.throws(()=>validateCoverage(root,[{...reports[0],...override},reports[1]]),{code:'TEST_PROOF_INVALID'});
 writeFileSync(join(root,'.agents/core/runtime/tests/a.test.js'),'changed');assert.throws(()=>validateCoverage(root,reports),{code:'TEST_PROOF_INVALID'});
});
test('CRLF-enabled Git checkout preserves the exact bytes used by native source proofs',t=>{
 for(const attributesPath of [new URL('../../../../.gitattributes',import.meta.url),new URL('../../distribution/template/.gitattributes',import.meta.url)]){
 const root=proofFixture(t),clone=root+'-checkout';t.after(()=>rmSync(clone,{recursive:true,force:true}));
 mkdirSync(join(root,'.github/workflows'),{recursive:true});
 writeFileSync(join(root,'.gitattributes'),readFileSync(fileURLToPath(attributesPath)));
 writeFileSync(join(root,'.gitignore'),'.cache/\n');writeFileSync(join(root,'README.md'),'# UTF-8 source\n');writeFileSync(join(root,'.github/workflows/check.yml'),'name: UTF-8 proof\n');
 const git=args=>{const r=spawnSync(gitBinary,['-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:nullDevice,GIT_CONFIG_SYSTEM:nullDevice}});assert.equal(r.status,0,r.stderr);};
 git(['add','--','.gitattributes','.gitignore','README.md','.github']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
 git(['clone','--no-local','--template=','-c','core.autocrlf=true',root,clone]);
 for(const path of ['.gitattributes','.gitignore','README.md','.github/workflows/check.yml'])assert.deepEqual(readFileSync(join(clone,path)),readFileSync(join(root,path)),path);
 assert.deepEqual(sourceIdentity(clone),sourceIdentity(root));
 }
});
test('restored local SDK copies become workspace links before Node imports TypeScript',t=>{
 const root=proofFixture(t),sdk=join(root,'.agents/core/applications/sdk'),app=join(root,'.agents/core/applications/example');
 mkdirSync(join(app,'node_modules/@ksf/sdk'),{recursive:true});mkdirSync(sdk,{recursive:true});
 const sdkPackage={name:'@ksf/sdk',type:'module',exports:'./index.ts'};
 writeFileSync(join(sdk,'package.json'),JSON.stringify(sdkPackage));writeFileSync(join(sdk,'index.ts'),'export const ready: boolean = true;\n');
 writeFileSync(join(app,'node_modules/@ksf/sdk/package.json'),JSON.stringify(sdkPackage));writeFileSync(join(app,'node_modules/@ksf/sdk/index.ts'),'export const ready: boolean = true;\n');
 writeFileSync(join(app,'package.json'),JSON.stringify({type:'module',devDependencies:{'@ksf/sdk':'file:../sdk'}}));
 writeFileSync(join(app,'entry.mjs'),"import {ready} from '@ksf/sdk';if(!ready)process.exit(1);\n");
 const path=join(root,catalogPath),catalog=JSON.parse(readFileSync(path,'utf8'));catalog.components.sdk={directory:'.agents/core/applications/sdk',testRoots:[],noTestsReason:'Synthetic link target only.'};catalog.components.example={directory:'.agents/core/applications/example',testRoots:[],noTestsReason:'Synthetic import consumer only.'};writeFileSync(path,JSON.stringify(catalog));
 const before=spawnSync(process.execPath,[join(app,'entry.mjs')],{encoding:'utf8'});assert.notEqual(before.status,0);assert.match(before.stderr,/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
 restorePreparedLinks(root);assert.equal(realpathSync(join(app,'node_modules/@ksf/sdk')),realpathSync(sdk));
 const after=spawnSync(process.execPath,[join(app,'entry.mjs')],{encoding:'utf8'});assert.equal(after.status,0,after.stderr);
 writeFileSync(join(app,'package.json'),JSON.stringify({devDependencies:{'@ksf/sdk':'file:../../../outside'}}));assert.throws(()=>restorePreparedLinks(root),{code:'TEST_CI_PREPARATION_INVALID'});assert.equal(realpathSync(join(app,'node_modules/@ksf/sdk')),realpathSync(sdk));
});
test('release proof trust excludes PRs, foreign repositories, other workflows and failed attempts',()=>{
 const run={id:1,run_attempt:1,conclusion:'success',head_sha:'sha',head_branch:'core-main',head_repository:{full_name:'official/core'},path:'.github/workflows/check.yml',event:'push'};
 assert.equal(trustedRun(run,'official/core','sha'),true);
 for(const override of [{event:'pull_request'},{head_repository:{full_name:'fork/core'}},{head_branch:'feature'},{head_branch:'main'},{conclusion:'failure'},{head_sha:'old'},{path:'.github/workflows/release.yml'}])assert.equal(trustedRun({...run,...override},'official/core','sha'),false);
});
