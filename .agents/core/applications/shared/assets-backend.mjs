const objectMethods = new Set(['listObjects', 'readObject', 'checkObject', 'writeObject', 'links', 'related']);
const knowledgeMethods = new Set(['knowledgeTree', 'readKnowledge', 'saveKnowledge', 'createKnowledge', 'searchKnowledge', 'checkKnowledge', 'links', 'related']);
export function activateAssets(context, kind) {
  const methods = kind === 'abilities' ? objectMethods : knowledgeMethods;
  return { call(method, params = {}) {
    if (!methods.has(method)) throw Object.assign(new Error('未知资产操作。'), { code: 'ASSET_METHOD_UNKNOWN' });
    return context.services.call('assets', method, [params]);
  } };
}
