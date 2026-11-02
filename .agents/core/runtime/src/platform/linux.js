import {existsSync} from 'node:fs';
import {mkdir,lstat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

const unsupported = () => { throw Object.assign(new Error('Linux 核心运行暂不支持此桌面或原生终端能力。'), {code:'PLATFORM_UNSUPPORTED'}); };
export const linux = {
  name:'linux', capabilities:Object.freeze({terminal:false,desktop:false,openURI:false,loginStartup:false}),
  reserveDirectoryRename:async path=>{await mkdir(path);return lstat(path);},
  validSegment:()=>true, supervisorOptions:{detached:false}, supportsPosixModes:true,
  fileMode:(_path,mode)=>mode&0o111?0o755:0o644, detachedChildren:true,
  directorySyncErrors:[], replaceErrors:[], hostsPath:()=>'/etc/hosts',
  tool(name) {
    const path=['/usr/bin','/bin'].map(directory=>join(directory,name)).find(existsSync);
    if(!path)throw Object.assign(new Error(`Linux 系统工具缺失：${name}`),{code:'PLATFORM_TOOL_MISSING'});
    return path;
  },
  launcher:(root,args)=>({executable:'/bin/sh',args:[join(root,'.agents/ksf'),...args]}),
  hookCommand:root=>`'${join(root,'.agents/ksf').replaceAll("'","'\\''")}' task hook`,
  terminalLaunch:unsupported, desktopEndpoint:unsupported, desktopCandidates:unsupported, openURI:unsupported,
  processStart(pid) {
    const result=spawnSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,LC_ALL:'C'},timeout:5000});
    if(result.status!==0||!result.stdout.trim())throw new Error('Cannot inspect process start identity.');
    return result.stdout.trim().replace(/\s+/g,' ');
  },
  terminate(child,signal){process.kill(-child.pid,signal);},
};
