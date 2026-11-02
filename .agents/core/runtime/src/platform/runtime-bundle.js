import {runtimePackage} from './catalog.js';

// Immutable source policy: compact release receipts can reconstruct the bundle
// from the pinned Git tree without changing the receipt protocol. Source
// templates (schema 5) keep the complete development tree.
export const runtimeLayoutPath='.agents/core/distribution/runtime-layout.json';
export const runtimeLayoutBytes=Buffer.from(JSON.stringify({schemaVersion:1,releaseRuntime:'target-platform'},null,2)+'\n');
export const isPlatformRuntimeLayout=bytes=>Buffer.isBuffer(bytes)&&bytes.equals(runtimeLayoutBytes);
export const runtimePackagesPath='.agents/core/runtime/packages/';
export function runtimePathForPlatform(path,target,build){
  if(!path.startsWith(runtimePackagesPath))return true;
  return path===build.runtime.packages[target]?.archive_path;
}
export function assertCanonicalRuntimePackages(build){
  if(!build?.runtime||typeof build.runtime.version!=='string'||!build.runtime.packages||typeof build.runtime.packages!=='object'||Array.isArray(build.runtime.packages)||!Object.keys(build.runtime.packages).length)
    throw Object.assign(new Error('Invalid runtime package declaration.'),{code:'BUILD_CONFIG_INVALID'});
  for(const [target,item]of Object.entries(build.runtime.packages)){
    if(!item||item.archive_path!==runtimePackagesPath+runtimePackage(target,build.runtime.version).filename)
      throw Object.assign(new Error('Platform runtime bundles require canonical official archive paths.'),{code:'BUILD_CONFIG_INVALID'});
  }
}
