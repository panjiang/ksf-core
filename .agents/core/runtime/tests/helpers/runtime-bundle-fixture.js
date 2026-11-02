import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {inspectCoreArchive} from '../../src/distribution/release.js';
import {createArchive} from '../../src/distribution/archive.js';
import {buildManifest} from '../../src/services/build-manifest.js';
import {runtimePackage} from '../../src/platform/catalog.js';
import {runtimePackagesPath} from '../../src/platform/runtime-bundle.js';
import {sha256,stableJSON} from '../../src/shared/hash.js';
import {distributionFixture,fixtureTarget,git} from './distribution-fixture.js';
import {storedZip} from './platform.js';

function addTarget(f,target){
  if(f.build.runtime.packages[target])return;
  const spec=runtimePackage(target,f.build.runtime.version),bytes=Buffer.from('Synthetic '+target+' runtime\n');
  const entries=[{path:spec.nodeMember,bytes,mode:0o755},{path:spec.licenseMember,bytes:Buffer.from('fixture license'),mode:0o644}];
  const archive=spec.format==='zip'?storedZip(entries):createArchive(entries),path=runtimePackagesPath+spec.filename;
  f.save(path,archive);f.build.runtime.packages[target]={archive_path:path,archive_sha256:sha256(archive)};
}
export async function freeze(f,message){f.save('.agents/core/build.json',stableJSON(f.build));await buildManifest(f.root);git(f.root,['add','.agents']);git(f.root,['commit','-m',message]);}
export async function multi(t){const f=await distributionFixture(t,{compact:true});for(const target of ['darwin-arm64','win32-x64','linux-x64'])addTarget(f,target);await freeze(f,'Synthetic multi-platform runtime inputs');return f;}
export const inspect=(result,target)=>inspectCoreArchive(readFileSync(join(result.output,result.index.platforms[target].core.name)));
