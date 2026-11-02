import { parseOptions, optionSpecs, hasJsonFlag } from '../shared/options.js';
import { invalid, MetadataError } from '../metadata/errors.js';
import { parseInput } from '../metadata/input.js';
import { readInputFile } from '../services/metadata.js';
import { errorItem } from '../services/projects.js';
import { projectManagement } from '../services/project-management.js';

export function runProjectManagementCommand(args,root){
  const help='KSF project management\n\n  ksf project management read <name> [--scope current|archived] [--json]\n  ksf project management check <name> [--data <JSON> | --from <file>] [--json]\n  ksf project management write <name> (--data <JSON> | --from <file>) [--dry-run] [--json]\n\nwrite: {"ifMatch":"<read etag or missing>","operationId":"<unique ID>","plan":{...}}\ncheck/read never create project files. Archived projects are read-only.\n';
  const result={ok:false,command:'project',operation:'management',data:null,errors:[]};let exitCode=1;
  try{
    if(!args.length||args.length===1&&['--help','-h'].includes(args[0]))return {stdout:help,exitCode:0};
    const [operation,...rest]=args;if(!['read','check','write'].includes(operation))invalid('Expected management read, check or write.');
    const parsed={operation};const allowed=['scope','json','help',...(operation==='read'?[]:['data','from']),...(operation==='write'?['dry-run']:[])];
    parseOptions(rest,{result:parsed,options:optionSpecs(allowed),invalid,target:x=>{if(parsed.name!==undefined)invalid('Only one name is allowed.');parsed.name=x;}});
    if(parsed.help){if(rest.length!==1)invalid('Use --help alone.');return {stdout:help,exitCode:0};}
    if(parsed.name===undefined)invalid('A project name is required.');
    if(parsed.data!==undefined&&parsed.from!==undefined||operation==='write'&&parsed.data===undefined&&parsed.from===undefined)invalid('Specify exactly one of --data or --from.');
    const data=parsed.from!==undefined?readInputFile(root,parsed.from):parsed.data!==undefined?parseInput(parsed.data):undefined;
    const response=projectManagement({...parsed,root,data});result.data=response.data;result.errors=response.errors;result.ok=!result.errors.length;exitCode=result.ok?0:1;
  }catch(error){result.errors=[errorItem(error)];exitCode=error instanceof MetadataError?error.exitCode:1;}
  return {stdout:hasJsonFlag(args)?JSON.stringify(result)+'\n':JSON.stringify(result,null,2)+'\n',exitCode};
}
