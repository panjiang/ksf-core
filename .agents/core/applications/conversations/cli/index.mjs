export function createCLI(context) {
  const methods = { overview:'review.overview',profiles:'review.profiles',configure:'review.configure',generate:'review.generate',report:'review.read',confirm:'review.confirm',resume:'review.resume',retry:'review.retry',suggestions:'suggestions.list',handoff:'suggestions.handoff',suggestion:'suggestions.update',chats:'chats.list',restore:'chats.restore' };
  return {execute(commandId,input){
    if(!Object.hasOwn(methods,commandId))throw Object.assign(Error('未知对话命令。'),{code:'APP_CALL_INVALID'});
    const {expectedPackageDigest,operationId,params:nested,...flat}=input??{};
    if(nested!==undefined&&(!nested||typeof nested!=='object'||Array.isArray(nested)||Object.keys(flat).length||operationId&&nested.operationId&&operationId!==nested.operationId))throw Object.assign(Error('使用 params 信封或顶层业务参数，不能混用或提供冲突操作编号。'),{code:'APP_CALL_INVALID'});
    return context.invoke(methods[commandId],{...(nested??flat),...(operationId?{operationId}:{})});
  }};
}
