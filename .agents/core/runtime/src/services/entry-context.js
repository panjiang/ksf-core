import {needsInstanceInitialization} from '../distribution/instance.js';
import {readUserData} from './user-data.js';
import {readConfigFile} from '../configuration/storage.js';
import {parseFrontmatter} from '../metadata/frontmatter.js';
import {incubationError} from '../incubation/schema.js';

export function incubationState(root) {
  const state = readUserData({root, namespace:'incubation'});
  if (state.state === 'present' && !['pending','completed','skipped'].includes(state.values.status)) throw incubationError('INCUBATION_INVALID','孵化状态缺少有效 status，请保留原件。');
  return state;
}
export function contextEntry(root) {
  const state = incubationState(root), mode = needsInstanceInitialization(root) ? 'instance-setup' : state.values.status === 'pending' ? 'incubation' : 'runtime';
  const path = mode === 'instance-setup' ? '.agents/core/docs/runtime/instance-setup.md' : mode === 'incubation' ? '.agents/core/docs/runtime/incubation.md' : '.agents/core/abilities/partners/ksf-runtime/partner.md';
  const source = readConfigFile(root,path,{text:true});
  if (source.state === 'missing') throw incubationError('ENTRY_DEFINITION_MISSING',`入口定义不可读：${path}。请核对当前实例的完整 Core。`);
  const parsed = parseFrontmatter(Buffer.from(source.document),path);
  if (typeof parsed.values.version !== 'string' || !source.document.trim()) throw incubationError('ENTRY_DEFINITION_INVALID','Core 入口定义缺少版本或正文。');
  return {complete:true, mode, stateVersion:{schemaVersion:state.schemaVersion,revision:state.revision,etag:state.etag},
    incubation:{state:state.state,status:state.values.status??null,...(mode==='incubation'?{draft:state.values.draft??{},operation:state.values.operation??null}:{})},
    entry:{source:'system',path,version:parsed.values.version,sha256:source.etag,content:source.document}};
}
