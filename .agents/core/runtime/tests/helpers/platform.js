import{crc32}from'node:zlib';
import {writeFileSync,copyFileSync,existsSync,linkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {platform} from '../../src/platform/index.js';
import {powershell,encodedCommand} from '../../src/platform/windows.js';
import {stripVTControlCharacters} from 'node:util';

export const gitBinary=platform.tool('git');
export const nullDevice=platform.name==='win32'?'NUL':'/dev/null';
export const testEndpoint=directory=>platform.name==='win32'?`\\\\.\\pipe\\ksf-test-${randomUUID()}`:directory+'/ipc.sock';
export function linkOrCopy(source,target){try{linkSync(source,target);}catch(error){if(error.code!=='EXDEV')throw error;copyFileSync(source,target,1);}}

// A real native executable on each OS, with the same Node fixture body. A CMD
// wrapper would change escaping, cancellation and stdin behavior under test.
export function writeNodeExecutable(path,source,{containChildren=false}={}){
  if(platform.name!=='win32'){writeFileSync(path,source,{mode:0o755});return path;}
  const script=path+'.fixture.js',executable=path.endsWith('.exe')?path:path+'.exe';writeFileSync(script,source);
  if(existsSync(executable))return executable;
  // A synthetic single-process CLI must not leave its extra Node body alive
  // when Windows kills only this PE wrapper (including spawn/taskkill races).
  // Opt in: runtime/launcher fixtures may deliberately start lasting services.
  // https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
  const code=String.raw`using System;using System.Text;using System.Diagnostics;using System.Runtime.InteropServices;using System.ComponentModel;
class Fixture{
 [StructLayout(LayoutKind.Sequential)]struct BasicLimits{public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorkingSet,MaxWorkingSet;public uint ActiveProcesses;public UIntPtr Affinity;public uint Priority,Scheduling;}
 [StructLayout(LayoutKind.Sequential)]struct Counters{public ulong ReadOperations,WriteOperations,OtherOperations,ReadBytes,WriteBytes,OtherBytes;}
 [StructLayout(LayoutKind.Sequential)]struct Limits{public BasicLimits Basic;public Counters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 // Keep the sole non-inheritable job handle until OS process teardown. Closing
 // it earlier would kill this wrapper before it can return the child's status.
 static IntPtr ownedJob;
 static bool contained=CONTAIN;
 static void Contain(){ownedJob=CreateJobObject(IntPtr.Zero,null);if(ownedJob==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());var limits=new Limits();limits.Basic.Flags=0x2000;if(!SetInformationJobObject(ownedJob,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))))throw new Win32Exception(Marshal.GetLastWin32Error());using(var current=Process.GetCurrentProcess()){if(!AssignProcessToJobObject(ownedJob,current.Handle))throw new Win32Exception(Marshal.GetLastWin32Error());}}
 static string Q(string value){var b=new StringBuilder();b.Append('"');int slashes=0;foreach(char c in value){if(c=='\\'){slashes++;continue;}if(c=='"'){b.Append('\\',slashes*2+1);b.Append('"');}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);b.Append('"');return b.ToString();}
 static int Main(string[] args){if(contained)Contain();var command=new StringBuilder(Q(SCRIPT));foreach(var arg in args)command.Append(" ").Append(Q(arg));var info=new ProcessStartInfo(NODE,command.ToString());info.UseShellExecute=false;using(var process=Process.Start(info)){process.WaitForExit();return process.ExitCode;}}
}`.replace('SCRIPT',JSON.stringify(script)).replace('NODE',JSON.stringify(process.execPath));
  const nativeCode=code.replace('CONTAIN',containChildren?'true':'false');
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const command=`$ErrorActionPreference='Stop';$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(nativeCode).toString('base64')}'));Add-Type -TypeDefinition $source -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`;
  const result=spawnSync(powershell(),encodedCommand(command),{encoding:'utf8',timeout:30000,windowsHide:true});
  if(result.status!==0)throw new Error(`Cannot build native test fixture: ${result.stderr}`);
  if(executable!==path)copyFileSync(executable,path);
  return executable;
}

export const shellCommands=platform.name==='win32'?{echo:marker=>`echo ${marker}\r`,wait:'ping -t 127.0.0.1\r',size:'mode con\r'}:{echo:marker=>`printf '${marker}\\n'\r`,wait:'sleep 30\r',size:'stty size\r'};

// ConPTY redraws console rows with absolute cursor addressing rather than
// literal CR/LF. Match visible line text while preserving POSIX VT checks.
export const terminalText=(value,name=platform.name)=>name==='win32'?stripVTControlCharacters(value.replace(/\x1b\[\d+;\d+[Hf]/g,'\n')):value;

// Minimal ZIP container for native lifecycle fixtures. Production bootstrap is
// tested separately against the actual pinned official Windows distribution.
export function storedZip(entries){
 const local=[],central=[];let offset=0;for(const entry of entries){const name=Buffer.from(entry.path),bytes=Buffer.from(entry.bytes),header=Buffer.alloc(30),record=Buffer.alloc(46),crc=crc32(bytes);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt32LE(crc,16);record.writeUInt32LE(bytes.length,20);record.writeUInt32LE(bytes.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);local.push(header,name,bytes);central.push(record,name);offset+=header.length+name.length+bytes.length;}const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
