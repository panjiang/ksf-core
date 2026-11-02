import {buildApplication} from '../sdk/build.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('.',import.meta.url));
const notices=[];
for(const name of ['marked','dompurify','yaml']){
  const base=join(root,'node_modules',name),pkg=JSON.parse(await readFile(join(base,'package.json'),'utf8'));
  let license;
  for(const file of ['LICENSE','LICENSE.md','LICENSE.txt'])try{license=await readFile(join(base,file),'utf8');break;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!license)throw Error('Missing license notice: '+name);
  notices.push(`## ${name}@${pkg.version}\n${license}`);
}
await writeFile(join(root,'THIRD_PARTY_NOTICES.txt'),notices.join('\n\n'));
await buildApplication(root,{entries:{window:'frontend.js'},...(process.env.KSF_PROJECTS_BUILD_STORE?{storeDirectory:process.env.KSF_PROJECTS_BUILD_STORE}:{})});
