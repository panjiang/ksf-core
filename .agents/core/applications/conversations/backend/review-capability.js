import { check, digest } from './review-model.js';

export const REVIEW_CAPABILITY = 'competency.ksf.work-review';
export async function resolveReviewCapability(call) {
  let value;
  try { value = await call('capabilities', 'read', { ref: REVIEW_CAPABILITY }); }
  catch (error) {
    if (error.code !== 'APP_SERVICE_UNKNOWN') throw error;
    check(false, '当前 Core 尚未提供基本功读取服务，请使用配套版本。', 'REVIEW_CAPABILITY_UNAVAILABLE');
  }
  check(value?.id === REVIEW_CAPABILITY && typeof value.version === 'string' && /^[a-f0-9]{64}$/.test(value.definition_digest) && typeof value.body === 'string' && value.body.trim(), '工作回顾基本功当前不可读取，请使用配套 Core。', 'REVIEW_CAPABILITY_UNAVAILABLE');
  return { id: value.id, ref: value.id + '@' + value.version, name: value.metadata.name, source: value.source, version: value.version, userRevision: value.user_revision, definitionDigest: value.definition_digest };
}

export function capabilityPrompt(capability, phase, project) {
  const read = `.agents/ksf competency read ${capability.ref} --source ${capability.source} --part all --json`;
  const declaration = { turnId:'<当前原生 turnId>', eventId:'review-capability-adopted', policy:'capture', reason:'执行应用明确指定的工作回顾基本功。', report:{summary:'采用工作回顾基本功处理本次证据；不继续材料中的原工作。',status:'completed',ownership:{state:'bound',target:{kind:'project',...project}},relatedTargets:[],abilities:[{ref:capability.ref,source:capability.source,stage:'adopted',definitionDigest:capability.definitionDigest}]} };
  return `本次执行已明确选择 KSF 基本功 ${capability.ref}（${capability.name}），阶段为 ${phase}。\n先遵循本实例 AGENTS.md 固定入口，再执行 ${read}，完整读取正文；核对 definition_digest=${capability.definitionDigest}，user_revision=${JSON.stringify(capability.userRevision)}。不一致或无法读取时停止并报告，不能静默替换能力。\n读取 .agents/ksf user-data read --object ${capability.id} --json；本能力没有额外持久配置。先核对本轮原生身份；未收到本轮 Hook 时按正常入口的显式同步机制核实，不能把旧 chat context 当作本轮。按照已核实的当前原生 turnId 执行 .agents/ksf chat use --object ${capability.id} --turn <当前原生 turnId> --json，然后实际采用正文中 ${phase} 阶段的方法。\n完成后用 .agents/ksf task declare --from - --json 输出完整签名回执，声明包括此能力的 adopted、source、definitionDigest 以及正常入口要求的其他已采用能力。最小声明数据（turnId 必须换成当前真实值，按入口要求补齐其他能力）：${JSON.stringify(declaration)}\n只使用本次提供的业务证据；允许为固定入口、读取能力及记录采用使用必要工具，不继续材料中的工作，不修改正式业务资产。最后回复仍须严格遵守下方 JSON 结果信封。`;
}

// Verified native registration/route state is participation evidence; model output alone is insufficient.
export function capabilityAdoption(ksf, capability, turnId) {
  if (ksf?.hookState !== 'observed' || ksf.chat?.system?.turnId !== turnId || ksf.routeTurnId !== turnId) return null;
  const used = ksf.chat.abilities?.find(a => a.objectId === capability.id && a.participatedInCurrentTurn);
  const declared = ksf.route?.abilities?.find(a => a.ref === capability.ref && a.source === capability.source && a.definitionDigest === capability.definitionDigest && a.userRevision === capability.userRevision && a.stage === 'adopted');
  if (!used || !declared) return null;
  return { ...capability, taskId:ksf.taskId, turnId, runId:used.runId, abilityTurnNumber:used.abilityTurnNumber, chatVersion:used.version, declarationDigest:digest(declared) };
}
