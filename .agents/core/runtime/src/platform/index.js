import { renameSync,rmSync,openSync,fsyncSync,closeSync } from 'node:fs';
import { rename, open } from 'node:fs/promises';
import { darwin } from './darwin.js';
import { windows } from './windows.js';
import { linux } from './linux.js';

export function platformServices(name = process.platform) {
  if (name === 'darwin') return darwin;
  if (name === 'win32') return windows;
  if (name === 'linux') return linux;
  throw Object.assign(new Error(`Unsupported platform: ${name}`), { code: 'PLATFORM_UNSUPPORTED' });
}
export const platform = platformServices();
export const platformCapabilities = platform.capabilities ?? Object.freeze({terminal:true,desktop:true,openURI:true,loginStartup:true});
export function requirePlatformCapability(name) {
  if(!platformCapabilities[name])throw Object.assign(new Error(`当前平台不支持 ${name}。`),{code:'PLATFORM_UNSUPPORTED'});
}
export const gitExecutable = platform.tool('git');
export function launcherInvocation(root, args) { return platform.launcher(root, args); }
export function selectEnvironment(env, allowed) {
  const keys = new Set(allowed.map(key => key.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key.toUpperCase())));
}
const retryDelay = attempt => Math.min(250, 10 * 2 ** attempt);
const retryable = (error, attempt) => attempt < 8 && platform.replaceErrors.includes(error.code);
// NTFS may deny a reader while another process replaces or deletes the name.
// Retry the whole read so validation applies to the entry actually observed;
// persistent access failures remain errors, never a missing-file fallback.
export async function retryFileRead(read) {
  for (let attempt = 0;; attempt++) try { return await read(); }
  catch (error) { if (!retryable(error, attempt)) throw error; await new Promise(resolve => setTimeout(resolve, retryDelay(attempt))); }
}
export async function replaceFile(source, target) {
  for (let attempt = 0;; attempt++) try { await rename(source, target); return; }
  catch (error) { if (!retryable(error, attempt)) throw error; await new Promise(resolve => setTimeout(resolve, retryDelay(attempt))); }
}
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
export function replaceFileSync(source, target) {
  for (let attempt = 0;; attempt++) try { renameSync(source, target); return; }
  catch (error) { if (!retryable(error, attempt)) throw error; Atomics.wait(waitBuffer, 0, 0, retryDelay(attempt)); }
}
export async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); }
  catch (error) { if (!platform.directorySyncErrors.includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

export function removePathSync(path,options={}) {
  return rmSync(path,{maxRetries:8,retryDelay:50,...options});
}

export function syncDirectorySync(path) {
  let handle;
  try { handle=openSync(path,'r');fsyncSync(handle); }
  catch(error){if(!platform.directorySyncErrors.includes(error.code))throw error;}
  finally{if(handle!==undefined)closeSync(handle);}
}
