import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {platformServices,platform,replaceFile,replaceFileSync,selectEnvironment,launcherInvocation,retryFileRead} from '../src/platform/index.js';
import {runtimePackage} from '../src/platform/catalog.js';
import {mergeText} from '../src/shared/merge-text.js';
import {createArchive,readArchive} from '../src/distribution/archive.js';
import {supportedCodexVersion} from '../src/ai-tasks/executors/codex-compatibility.js';
import {terminalText} from './helpers/platform.js';
import {launchAgentBelongsToRoot,windowsLoginStartupJob} from '../src/platform/service.js';
import {powershell,encodedCommand} from '../src/platform/windows.js';

test('both adapters implement the same native-operation contract',()=>{
  for(const name of ['darwin','win32']){
    const adapter=platformServices(name);
    for(const method of ['reserveDirectoryRename','validSegment','tool','launcher','hookCommand','desktopEndpoint','desktopCandidates','openURI','processStart','terminate'])assert.equal(typeof adapter[method],'function',`${name}.${method}`);
  }
  assert.throws(()=>platformServices('unknown'),{code:'PLATFORM_UNSUPPORTED'});
  assert.equal(platformServices('win32').desktopEndpoint('unused'),'\\\\.\\pipe\\codex-ipc');
  const hook=platformServices('win32').hookCommand("E:\\中文 工作区\\quote'file");
  const script=Buffer.from(hook.split('-EncodedCommand ')[1],'base64').toString('utf16le');
  assert.match(script,/quote''file/);assert.match(script,/ksf\.ps1.*task hook/);
});
test('distribution target and official Windows archive identity are deliberately distinct',()=>{
  const win=runtimePackage('win32-x64','24.21.0');
  assert.equal(win.archiveRoot,'node-v24.21.0-win-x64');assert.equal(win.nodeMember,win.archiveRoot+'/node.exe');assert.equal(win.format,'zip');
  assert.equal(runtimePackage('darwin-arm64','24.21.0').executable,'bin/node');
});
test('CLI compatibility includes only explicitly validated platform/version combinations',()=>{
  assert.equal(supportedCodexVersion('codex-cli 0.163.0','darwin'),true);
  assert.equal(supportedCodexVersion('codex-cli 0.165.0-alpha.1.2','win32'),true);
  assert.equal(supportedCodexVersion('codex-cli 0.165.0-alpha.1.2','darwin'),false);
  assert.equal(supportedCodexVersion('codex-cli 0.165.0-alpha.1.3','win32'),false);
  assert.equal(supportedCodexVersion('codex-cli 0.166.0-alpha.5.1','win32'),true);
  assert.equal(supportedCodexVersion('codex-cli 0.166.0-alpha.5.1','darwin'),false);
  assert.equal(supportedCodexVersion('codex-cli 0.166.0-alpha.5.2','win32'),false);
  assert.equal(supportedCodexVersion('codex-cli 0.130.0','win32'),false);
});
test('case-insensitive Windows environment selection retains Path and SystemRoot',()=>{
  assert.deepEqual(selectEnvironment({Path:'tools',SystemRoot:'windows',USERPROFILE:'user',SECRET:'omit'},['PATH','SYSTEMROOT','USERPROFILE']),{Path:'tools',SystemRoot:'windows',USERPROFILE:'user'});
});
test('Windows command sessions enable UTF-8 without changing custom command interpreters',()=>{
  const win=platformServices('win32');
  assert.deepEqual(win.terminalLaunch({COMSPEC:'C:\\Windows\\System32\\cmd.exe'}).args,['/d','/k','chcp 65001 >nul']);
  assert.deepEqual(win.terminalLaunch({ComSpec:'C:\\Tools\\custom.exe'}).args,[]);
});
test('ConPTY absolute row updates retain semantic UTF-8 output lines',()=>{
  const output='\x1b[?25lC:\\>echo KSF_UTF8_中文\x1b[4;1HKSF_UTF8_中文\x1b[6;1HC:\\>\x1b[?25h';
  assert.match(terminalText(output,'win32'),/KSF_UTF8_中文\n/);
  assert.equal(terminalText(output,'darwin'),output);
});
test('native adapter inspects its actual process identity and preserves argument arrays',()=>{
  assert.ok(platform.processStart(process.pid));
  const args=['metadata','--from','中文 space','quote"value','trailing\\',''];
  const dir=mkdtempSync(join(tmpdir(),'ksf args '));
  try{mkdirSync(join(dir,'.agents'),{recursive:true});
    if(platform.name==='win32')writeFileSync(join(dir,'.agents/ksf.ps1'),"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);ConvertTo-Json -InputObject @($args) -Compress");
    else writeFileSync(join(dir,'.agents/ksf'),"#!/bin/sh\nexec \"$KSF_TEST_NODE\" -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- \"$@\"\n");
    const invocation=launcherInvocation(dir,args),child=spawnSync(invocation.executable,invocation.args,{encoding:'utf8',env:{...process.env,KSF_TEST_NODE:process.execPath}});
    assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),args);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('shared replacement publishes complete bytes for synchronous and asynchronous writers',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ksf replace 中文 '));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const target=join(dir,'record');writeFileSync(target,'old');writeFileSync(join(dir,'new'),'完整内容');
  await replaceFile(join(dir,'new'),target);assert.equal(readFileSync(target,'utf8'),'完整内容');
  writeFileSync(join(dir,'new'),'second');replaceFileSync(join(dir,'new'),target);assert.equal(readFileSync(target,'utf8'),'second');
});
test('native read retries recover sharing conflicts but preserve permanent and unrelated errors',async()=>{
  const sharing=Object.assign(new Error('sharing conflict'),{code:'EPERM'});let attempts=0;
  const read=()=>{if(++attempts<3)throw sharing;return 'complete';};
  if(platform.name==='win32'){assert.equal(await retryFileRead(read),'complete');assert.equal(attempts,3);}
  else{await assert.rejects(retryFileRead(read),error=>error===sharing);assert.equal(attempts,1);}
  attempts=0;await assert.rejects(retryFileRead(()=>{attempts++;throw sharing;}),error=>error===sharing);
  assert.equal(attempts,platform.name==='win32'?9:1);
  const disk=Object.assign(new Error('disk error'),{code:'EIO'});attempts=0;
  await assert.rejects(retryFileRead(()=>{attempts++;throw disk;}),error=>error===disk);assert.equal(attempts,1);
});
test('shared three-way merge preserves independent edits, identical edits, CRLF and EOF',()=>{
  const merge=(base,a,b)=>mergeText(Buffer.from(base),Buffer.from(a),Buffer.from(b));
  let r=merge('a\r\nb\r\nc','A\r\nb\r\nc','a\r\nb\r\nC');assert.equal(r.conflict,false);assert.equal(r.bytes.toString(),'A\r\nb\r\nC');
  r=merge('a\n','same\n','same\n');assert.equal(r.conflict,false);assert.equal(r.bytes.toString(),'same\n');
  r=merge('base\n','left\n','right\n');assert.equal(r.conflict,true);assert.equal(r.bytes.toString(),'<<<<<<< local\nleft\n||||||| base\nbase\n=======\nright\n>>>>>>> release\n');
});
test('UTF-8 PAX archives round-trip through the shared reader and the native extractor',t=>{
  const root=mkdtempSync(join(tmpdir(),'ksf pax '));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const name='知识/中文 目录/原始资料.md',bytes=createArchive([{path:name,bytes:Buffer.from('中文内容\n')}]);
  assert.equal(readArchive(bytes).get(name).bytes.toString(),'中文内容\n');
  const archive=join(root,'fixture.tar.gz'),out=join(root,'out');writeFileSync(archive,bytes);mkdirSync(out);
  const result=spawnSync(platform.tool('tar'),['-xzf','../fixture.tar.gz'],{cwd:out,encoding:'utf8',env:{...process.env,LC_ALL:platform.name==='win32'?'C.UTF-8':process.env.LC_ALL}});assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(join(out,name),'utf8'),'中文内容\n');
});

test('native filename validation distinguishes ordinary spaces from Windows reserved names',()=>{const win=platformServices('win32');assert.equal(win.validSegment('中文 space'),true);for(const name of ['CON','aux.txt','末尾 ','末尾.','name:stream'])assert.equal(win.validSegment(name),false,name);assert.equal(platformServices('darwin').validSegment('末尾 '),true);});


test('login startup ownership distinguishes another instance and rejects ambiguous launch agents',()=>{
  const own='/Users/test/中文 & core',document='<plist><key>WorkingDirectory</key><string>/Users/test/中文 &amp; core</string></plist>';
  assert.equal(launchAgentBelongsToRoot(document,own),true);
  assert.equal(launchAgentBelongsToRoot(document,'/Users/test/other'),false);
  assert.throws(()=>launchAgentBelongsToRoot('<plist/>',own),{code:'SERVICE_OS_FAILED'});
  assert.throws(()=>launchAgentBelongsToRoot(document+document,own),{code:'SERVICE_OS_FAILED'});
});

test('native Windows startup disable preserves another instance and unknown task ownership',{skip:process.platform!=='win32'},()=>{
  const root="E:\\验收 工作区\\quote'core";
  for(const [kind,enabled,expected,failed] of [['other',false,0,false],['missing',false,0,false],['own',false,1,false],['unknown',false,0,true],['denied',false,0,true],['other',true,1,false]]){
    const workdir=kind==='own'?root.toLowerCase()+'\\':'E:\\daily-instance';
    const fixture=kind==='missing'||kind==='denied'
      ?`throw [System.Management.Automation.ErrorRecord]::new([Exception]::new('lookup'), 'lookup', [System.Management.Automation.ErrorCategory]::${kind==='missing'?'ObjectNotFound':'PermissionDenied'}, $null)`
      :`return [pscustomobject]@{Actions=@([pscustomobject]@{WorkingDirectory=${kind==='unknown'?"''":"'"+workdir.replaceAll("'","''")+"'"}})}`;
    const script=`$ErrorActionPreference='Stop'; $script:registered=0;
function Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction); ${fixture} }
function New-ScheduledTaskAction { [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { [pscustomobject]@{} }
function New-ScheduledTaskTrigger { [pscustomobject]@{} }
function New-ScheduledTask { [pscustomobject]@{} }
function Register-ScheduledTask { $script:registered++ }
$failed=$false; try { & { ${windowsLoginStartupJob(root,enabled)} } } catch { $failed=$true }; [pscustomobject]@{registered=$script:registered;failed=$failed} | ConvertTo-Json -Compress`;
    const child=spawnSync(powershell(),encodedCommand(script),{encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{registered:expected,failed},kind);
  }
});
