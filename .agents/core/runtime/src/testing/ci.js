// CI receipts are evidence only when obtained from a successful trusted Actions
// run. Local result caches are never read by this module.
import {readFileSync,readdirSync,writeFileSync,appendFileSync,existsSync,lstatSync,realpathSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadCatalog,sha256,fail} from './catalog.js';
import {createTestPlan,parseTestOptions} from './planner.js';
import {gitExecutable} from '../platform/index.js';
import {runTestCommand} from '../commands/test.js';

// Persist the outcome before returning its nonzero exit status. Shell `-e`
// must never discard the failed shard's structured coverage and diagnostics.
export async function runVerification(root,args,reportPath){
 let before,report,exitCode=1;
 try{
  before=sourceIdentity(root);
  const command=await runTestCommand([...args,'--json'],root),envelope=JSON.parse(command.stdout),after=sourceIdentity(root);
  const changed=before.sourceDigest!==after.sourceDigest;
  report={schemaVersion:1,platform:process.platform,architecture:process.arch,nodeVersion:process.version,results:[],changedInputs:[],summary:{executed:0,reused:0,failed:0},...envelope.data,...before,commandExitCode:command.exitCode,errors:envelope.errors??[]};
  report.complete=command.exitCode===0&&envelope.ok===true&&report.complete===true&&!changed;
  if(changed)report.status='inputs-changed';
  else if(!report.complete&&!['failed','cancelled','inputs-changed'].includes(report.status))report.status='failed';
  if(changed)report.errors.push({code:'TEST_INPUT_CHANGED',message:'The CI source changed during verification.'});
  exitCode=report.complete?0:1;
 }catch(error){report={schemaVersion:1,platform:process.platform,...before,complete:false,status:'failed',commandExitCode:1,results:[],errors:[{code:error.code??'TEST_EXECUTION_FAILED',message:error.message}]};}
 writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
 return exitCode;
}

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
 const git=spawnSync(gitExecutable,['-C',root,'ls-files','-z','--','.agents/core','.agents/ksf','.agents/ksf.ps1','AGENTS.md','README.md','.github','.gitignore','.gitattributes'],{encoding:'utf8',maxBuffer:32*1024*1024});
 if(git.status!==0)fail('TEST_PROOF_INVALID','Cannot enumerate the final source.');
 const files=git.stdout.split('\0').filter(p=>p&&p!=='.agents/core/manifest.yaml'&&!p.startsWith('.agents/core/runtime/web/dist/')).sort();
 // Generated manifests and web outputs are independently built and verified.
 const sourceDigest=sha256(JSON.stringify(files.map(p=>[p,sha256(readFileSync(join(root,p)))])));
 const build=JSON.parse(readFileSync(join(root,'.agents/core/build.json'),'utf8'));
 return {sourceDigest,catalogDigest:loadCatalog(root).digest,runtime:build.runtime};
}
export function validateCoverage(root, reports, {full=true}={}){
 const identity=sourceIdentity(root),platforms=['darwin','win32'];
 if(reports.some(r=>!r||!platforms.includes(r.platform)))fail('TEST_PROOF_INVALID','Unexpected or malformed CI platform report.');
 for(const platform of platforms){
  const selected=reports.filter(r=>r.platform===platform),expected=createTestPlan(root,parseTestOptions(['--suite',full?'full':'quick']),{platform}).selectedFiles,seen=new Set();
  for(const r of selected){
   if(!r.complete||r.status!=='passed'||r.suite!==(full?'full':'quick')||r.scope!=='all'||r.component!==null||r.commandExitCode!==0||r.catalogDigest!==identity.catalogDigest||r.nodeVersion!=='v'+identity.runtime.version||!Array.isArray(r.changedInputs)||r.changedInputs.length||!r.summary||r.summary.reused||r.sourceDigest!==identity.sourceDigest||JSON.stringify(r.runtime)!==JSON.stringify(identity.runtime))fail('TEST_PROOF_INVALID','Incomplete, stale or reused CI coverage.');
   if(r.architecture!==(platform==='darwin'?'arm64':'x64'))fail('TEST_PROOF_INVALID','Native CI architecture does not match the runtime.');
   const sameFiles=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
   if(!Array.isArray(r.results)||r.results.some(result=>!result||typeof result.path!=='string')||!sameFiles(r.selectedFiles,expected)||!sameFiles(r.assignedFiles,r.results.map(result=>result.path)))fail('TEST_PROOF_INVALID','CI selected scope does not match the declared coverage.');
   for(const result of r.results){if(result.status!=='passed'||seen.has(result.path))fail('TEST_PROOF_INVALID','Failed or duplicate CI file coverage.');seen.add(result.path);}
  }
  if(expected.length!==seen.size||expected.some(p=>!seen.has(p)))fail('TEST_PROOF_INVALID','CI has missing or unexpected platform coverage.',{platform});
 }
 return {schemaVersion:1,...identity,commit:process.env.GITHUB_SHA,repository:process.env.GITHUB_REPOSITORY,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,full,platforms,verifiedAt:new Date().toISOString()};
}
export function aggregateReports(root,reports,{full=true,proofPath,summaryPath}){
 // A previous proof at this path must never survive a failed aggregation.
 rmSync(proofPath,{force:true});
 const summary={schemaVersion:1,complete:false,full,platforms:[],reports:reports.length,errors:reports.flatMap(r=>Array.isArray(r?.errors)?r.errors:[])};
 let proof;
 try{
 for(const platform of ['darwin','win32']){
  const expected=createTestPlan(root,parseTestOptions(['--suite',full?'full':'quick']),{platform}).selectedFiles;
  const selected=reports.filter(r=>r?.platform===platform),results=selected.flatMap(r=>Array.isArray(r.results)?r.results.filter(result=>result&&typeof result==='object'):[]),seen=new Set(results.map(r=>r.path));
  summary.platforms.push({platform,expected:expected.length,reported:results.length,passed:results.filter(r=>r.status==='passed').length,missing:expected.filter(path=>!seen.has(path)),failed:results.filter(r=>r.status!=='passed').map(r=>({path:r.path,status:r.status,durationMs:r.durationMs,timeoutMs:r.timeoutMs})),errors:selected.flatMap(r=>r.errors??[])});
 }
 proof=validateCoverage(root,reports,{full});summary.complete=true;}
 catch(error){summary.error={code:error.code??'TEST_PROOF_INVALID',message:error.message};throw error;}
 finally{
  writeFileSync(summaryPath,JSON.stringify(summary,null,2)+'\n');
  if(process.env.GITHUB_STEP_SUMMARY){
   const lines=['## Native test coverage','',...summary.platforms.map(p=>`- ${p.platform}: ${p.passed}/${p.expected} passed; ${p.failed.length} failed; ${p.missing.length} missing.`),...summary.platforms.flatMap(p=>p.failed.map(r=>`- ${r.status}: \`${r.path}\` (${r.durationMs} ms, limit ${r.timeoutMs} ms)`)),...(summary.error?['',summary.error.message]:[])];
   appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
  }
 }
 writeFileSync(proofPath,JSON.stringify(proof,null,2)+'\n');return proof;
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
function reportsIn(directory){
 return !existsSync(directory)?[]:readdirSync(directory,{withFileTypes:true}).flatMap(e=>{
  if(e.isDirectory())return reportsIn(join(directory,e.name));
  if(!e.name.endsWith('.report.json'))return [];
  try{return [JSON.parse(readFileSync(join(directory,e.name),'utf8'))];}
  catch(error){return [{platform:'invalid',complete:false,results:[],errors:[{code:'TEST_PROOF_INVALID',message:`Cannot parse ${e.name}: ${error.message}`}]}];}
 });
}
async function main(){
 const root=process.cwd(),[command,...args]=process.argv.slice(2);
 if(command==='plan'){
  const plan=createTestPlan(root,parseTestOptions(args.length?['--changed','--base',args[0]]:[]));
  appendFileSync(process.env.GITHUB_OUTPUT,`full=${process.env.KSF_MANUAL_FULL==='true'||plan.requiredFullComponents.length>0}\n`);
 }else if(command==='restore-links'){
  if(process.env.GITHUB_ACTIONS!=='true')fail('TEST_CI_PREPARATION_INVALID','Prepared dependency repair is restricted to CI preparation.');
  restorePreparedLinks(root);
 }else if(command==='run'){
  process.exitCode=await runVerification(root,args.slice(1),args[0]);
 }else if(command==='aggregate'){
  aggregateReports(root,reportsIn(args[0]),{full:args[1]==='full',proofPath:args[2],summaryPath:args[3]??'coverage.json'});
 }else if(command==='find-proof')await findProof(root);
 else if(command==='verify-proof'){
  try{const response=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${args[1]}`,{headers:{Authorization:'Bearer '+process.env.GITHUB_TOKEN},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Run unavailable');validateProof(root,JSON.parse(readFileSync(args[0],'utf8')),await response.json());appendFileSync(process.env.GITHUB_OUTPUT,'valid=true\n');}
  catch(error){process.stderr.write(error.message+'; running missing full verification.\n');appendFileSync(process.env.GITHUB_OUTPUT,'valid=false\n');}
 }else fail('INVALID_ARGUMENTS','Unknown CI test operation.');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
