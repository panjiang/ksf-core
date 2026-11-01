// CI receipts are evidence only when obtained from a successful trusted Actions
// run. Local result caches are never read by this module.
import {readFileSync,readdirSync,writeFileSync,appendFileSync,existsSync,lstatSync,realpathSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadCatalog,sha256,fail} from './catalog.js';
import {createTestPlan,parseTestOptions} from './planner.js';
import {gitExecutable} from '../platform/index.js';

// GNU tar can restore an NTFS junction as a plain directory. Recreate declared
// first-party file dependencies during CI preparation, before fingerprints or
// tests; Node must resolve TypeScript through its actual workspace source.
export function restorePreparedLinks(root){
 const catalog=loadCatalog(root),directories=new Set(Object.values(catalog.components).map(c=>resolve(root,c.directory)));
 for(const directory of directories){
  if(!existsSync(join(directory,'node_modules'))||!existsSync(join(directory,'package.json')))continue;
  const pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
  for(const [name,spec] of Object.entries({...pkg.dependencies,...pkg.devDependencies})){
   if(typeof spec!=='string'||!spec.startsWith('file:'))continue;
   const target=resolve(directory,spec.slice(5));
   if(!directories.has(target)||!existsSync(join(target,'package.json'))||!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))fail('TEST_CI_PREPARATION_INVALID','Local test dependencies must name a registered first-party component.');
   const link=join(directory,'node_modules',name);
   if(existsSync(link)&&lstatSync(link).isSymbolicLink()&&realpathSync(link)===realpathSync(target))continue;
   rmSync(link,{recursive:true,force:true});mkdirSync(dirname(link),{recursive:true});symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
  }
 }
}

export function sourceIdentity(root){
 const git=spawnSync(gitExecutable,['-C',root,'ls-files','-z','--','.agents/core','.agents/ksf','.agents/ksf.ps1','AGENTS.md','.github','.gitignore','.gitattributes'],{encoding:'utf8',maxBuffer:32*1024*1024});
 if(git.status!==0)fail('TEST_PROOF_INVALID','Cannot enumerate the final source.');
 const files=git.stdout.split('\0').filter(p=>p&&!p.endsWith('/manifest.yaml')&&!p.startsWith('.agents/core/runtime/web/dist/')).sort();
 // Generated manifests and web outputs are independently built and verified.
 const sourceDigest=sha256(JSON.stringify(files.map(p=>[p,sha256(readFileSync(join(root,p)))])));
 const build=JSON.parse(readFileSync(join(root,'.agents/core/build.json'),'utf8'));
 return {sourceDigest,catalogDigest:loadCatalog(root).digest,runtime:build.runtime};
}
export function validateCoverage(root, reports, {full=true}={}){
 const identity=sourceIdentity(root),platforms=['darwin','win32'];
 for(const platform of platforms){
  const selected=reports.filter(r=>r.platform===platform),expected=createTestPlan(root,parseTestOptions(['--suite',full?'full':'quick']),{platform}).selectedFiles,seen=new Set();
  for(const r of selected){
   if(!r.complete||r.status!=='passed'||r.suite!==(full?'full':'quick')||r.catalogDigest!==identity.catalogDigest||r.nodeVersion!=='v'+identity.runtime.version||r.changedInputs.length||r.summary.reused||r.sourceDigest!==identity.sourceDigest)fail('TEST_PROOF_INVALID','Incomplete, stale or reused CI coverage.');
   if(r.architecture!==(platform==='darwin'?'arm64':'x64'))fail('TEST_PROOF_INVALID','Native CI architecture does not match the runtime.');
   for(const result of r.results){if(result.status!=='passed'||seen.has(result.path))fail('TEST_PROOF_INVALID','Failed or duplicate CI file coverage.');seen.add(result.path);}
  }
  if(expected.length!==seen.size||expected.some(p=>!seen.has(p)))fail('TEST_PROOF_INVALID','CI has missing or unexpected platform coverage.',{platform});
 }
 return {schemaVersion:1,...identity,commit:process.env.GITHUB_SHA,repository:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,full,platforms,verifiedAt:new Date().toISOString()};
}
export function trustedRun(run,repo,sha){return run?.conclusion==='success'&&run.head_sha===sha&&run.head_branch==='core-main'&&run.head_repository?.full_name===repo&&run.path==='.github/workflows/check.yml'&&['push','workflow_dispatch'].includes(run.event);}
export function validateProof(root,proof,run){
 const identity=sourceIdentity(root),repo=process.env.GITHUB_REPOSITORY,sha=process.env.GITHUB_SHA;
 if(!trustedRun(run,repo,sha)||proof.schemaVersion!==1||!proof.full||proof.commit!==sha||proof.repository!==repo||String(proof.runId)!==String(run.id)||String(proof.runAttempt)!==String(run.run_attempt)||JSON.stringify(proof.platforms)!==JSON.stringify(['darwin','win32'])||proof.sourceDigest!==identity.sourceDigest||proof.catalogDigest!==identity.catalogDigest||JSON.stringify(proof.runtime)!==JSON.stringify(identity.runtime))fail('TEST_PROOF_INVALID','The trusted CI receipt does not match this final source and native runtimes.');
 return true;
}
async function findProof(root){
 const repo=process.env.GITHUB_REPOSITORY,sha=process.env.GITHUB_SHA,token=process.env.GITHUB_TOKEN;
 const request=async path=>{const response=await fetch('https://api.github.com'+path,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Actions API '+response.status);return response;};
 try{
  const runs=await(await request(`/repos/${repo}/actions/runs?head_sha=${sha}&status=success&per_page=30`)).json();
  for(const run of runs.workflow_runs??[]){
   if(!trustedRun(run,repo,sha))continue;
   const artifacts=await(await request(`/repos/${repo}/actions/runs/${run.id}/artifacts`)).json(),artifact=artifacts.artifacts?.find(a=>a.name==='suite-proof-'+sha&&!a.expired);
   if(!artifact)continue;
   // Artifact download is delegated to the official action by its numeric ID.
   appendFileSync(process.env.GITHUB_OUTPUT,`candidate=${artifact.id}\nrun=${run.id}\n`);return;
  }
 }catch(error){process.stderr.write('CI proof unavailable; native full verification is required: '+error.message+'\n');}
 appendFileSync(process.env.GITHUB_OUTPUT,'candidate=\nrun=\n');
}
function reportsIn(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?reportsIn(join(directory,e.name)):e.name.endsWith('.report.json')?[JSON.parse(readFileSync(join(directory,e.name),'utf8'))]:[]);}
async function main(){
 const root=process.cwd(),[command,...args]=process.argv.slice(2);
 if(command==='plan'){
  const plan=createTestPlan(root,parseTestOptions(args.length?['--changed','--base',args[0]]:[]));
  appendFileSync(process.env.GITHUB_OUTPUT,`full=${process.env.KSF_MANUAL_FULL==='true'||plan.requiredFullComponents.length>0}\n`);
 }else if(command==='restore-links'){
  if(process.env.GITHUB_ACTIONS!=='true')fail('TEST_CI_PREPARATION_INVALID','Prepared dependency repair is restricted to CI preparation.');
  restorePreparedLinks(root);
 }else if(command==='stamp'){
  const envelope=JSON.parse(readFileSync(args[0],'utf8'));if(!envelope.ok)fail('TEST_PROOF_INVALID','Test execution failed.');
  writeFileSync(args[1],JSON.stringify({...envelope.data,...sourceIdentity(root)},null,2)+'\n');
 }else if(command==='aggregate'){
  const proof=validateCoverage(root,reportsIn(args[0]),{full:args[1]==='full'});writeFileSync(args[2],JSON.stringify(proof,null,2)+'\n');
 }else if(command==='find-proof')await findProof(root);
 else if(command==='verify-proof'){
  try{const response=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${args[1]}`,{headers:{Authorization:'Bearer '+process.env.GITHUB_TOKEN},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Run unavailable');validateProof(root,JSON.parse(readFileSync(args[0],'utf8')),await response.json());appendFileSync(process.env.GITHUB_OUTPUT,'valid=true\n');}
  catch(error){process.stderr.write(error.message+'; running missing full verification.\n');appendFileSync(process.env.GITHUB_OUTPUT,'valid=false\n');}
 }else fail('INVALID_ARGUMENTS','Unknown CI test operation.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
