import {spawnSync} from 'node:child_process';
import {homedir,userInfo} from 'node:os';
import {join} from 'node:path';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {powershell,encodedCommand} from './windows.js';

export const SERVICE_LABEL='ai.ksf.core';
const xml=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const ps=v=>"'"+String(v).replaceAll("'","''")+"'";
function run(executable,args,{optional=false}={}){const r=spawnSync(executable,args,{encoding:'utf8',timeout:15000,windowsHide:true});if(!optional&&(r.error||r.status!==0))throw Object.assign(new Error((r.stderr||r.error?.message||'系统启动设置失败。').trim()),{code:'SERVICE_OS_FAILED'});return r;}
export function launchAgentPath(){return join(homedir(),'Library/LaunchAgents',SERVICE_LABEL+'.plist');}
export function serviceJob(root,enabled){
  const script=`$ErrorActionPreference='Stop'; & ${ps(join(root,'.agents/ksf.ps1'))} service run --reason login --json; exit $LASTEXITCODE`;
  const encoded=['-ExecutionPolicy','Bypass','-WindowStyle','Hidden',...encodedCommand(script)].join(' ');
  return `$ErrorActionPreference='Stop'; $who=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $action=New-ScheduledTaskAction -Execute ${ps(powershell())} -Argument ${ps(encoded)} -WorkingDirectory ${ps(root)}; $principal=New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited; $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew${enabled?' -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)':''}; $task=New-ScheduledTask -Action $action -Principal $principal -Settings $settings${enabled?' -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $who)':''}; Register-ScheduledTask -TaskName ${ps(SERVICE_LABEL)} -InputObject $task -Force | Out-Null`;
}
export function launchAgentBelongsToRoot(document,root){
  const directories=[...document.matchAll(/<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/g)];
  if(directories.length!==1)throw Object.assign(new Error('无法核实登录启动项的实例归属，请保留原件。'),{code:'SERVICE_OS_FAILED'});
  return directories[0][1]===xml(root);
}
export function windowsLoginStartupJob(root,enabled){
  if(enabled)return serviceJob(root,true);
  const guard=`$ErrorActionPreference='Stop'; $ksfStartupTask=$null; try { $ksfStartupTask=Get-ScheduledTask -TaskPath '\\' -TaskName ${ps(SERVICE_LABEL)} -ErrorAction Stop } catch { if($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound){throw} }; if($null -eq $ksfStartupTask){return}; $ksfStartupActions=@($ksfStartupTask.Actions); if($ksfStartupActions.Count -ne 1 -or [string]::IsNullOrWhiteSpace($ksfStartupActions[0].WorkingDirectory)){throw 'Cannot verify the startup task instance; preserve it.'}; $ksfStartupExpected=[IO.Path]::GetFullPath(${ps(root)}).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar); $ksfStartupActual=[IO.Path]::GetFullPath($ksfStartupActions[0].WorkingDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar); if(-not [string]::Equals($ksfStartupExpected,$ksfStartupActual,[StringComparison]::OrdinalIgnoreCase)){return}; `;
  return guard+serviceJob(root,false);
}
export async function setLoginStartup(root,enabled){
  if(process.platform==='darwin'){
    const path=launchAgentPath(),domain=`gui/${userInfo().uid}`;
    const loaded=run('/bin/launchctl',['print',`${domain}/${SERVICE_LABEL}`],{optional:true}).status===0;
    if(enabled){await mkdir(join(homedir(),'Library/LaunchAgents'),{recursive:true});const log=join(root,'.agents/runtime-data/service');
      const args=['/bin/sh',join(root,'.agents/ksf'),'service','run','--reason','login','--json'];
      await writeFile(path,`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${SERVICE_LABEL}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(join(log,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(log,'service.err'))}</string></dict></plist>`,{mode:0o600});
      if(!loaded)run('/bin/launchctl',['bootstrap',domain,path]);
    }else{
      let document;try{document=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(launchAgentBelongsToRoot(document,root))await rm(path,{force:true});
    }
  }else if(process.platform==='win32')run(powershell(),encodedCommand(windowsLoginStartupJob(root,enabled)));
  else throw Object.assign(new Error('登录自启动仅支持 macOS、Windows。'),{code:'PLATFORM_UNSUPPORTED'});
}
export function startWindowsService(root,enabled){run(powershell(),encodedCommand(serviceJob(root,enabled)+`; Start-ScheduledTask -TaskName ${ps(SERVICE_LABEL)}`));}
export function stopLoginJob(){
  if(process.platform==='darwin')run('/bin/launchctl',['bootout',`gui/${userInfo().uid}/${SERVICE_LABEL}`],{optional:true});
  // A clean Windows task exit does not trigger RestartOnFailure.
}
