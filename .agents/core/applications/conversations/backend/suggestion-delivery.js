import { check } from './review-model.js';

export const suggestionStatuses = ['pending', 'accepted', 'in_progress', 'deferred', 'ignored', 'resolved'];
export function suggestionUpdate(old, input, at) {
  check(old && old.revision === input.revision, '建议已变化，请刷新后比较。', 'REVIEW_CONFLICT');
  check(suggestionStatuses.includes(input.status), '建议状态无效。');
  const next = { ...old, status: input.status, revision: old.revision + 1, resolution: input.resolution ?? old.resolution ?? null, updatedAt: at };
  if (input.delivery !== undefined) {
    const d = input.delivery;
    check(d && typeof d.summary === 'string' && d.summary.trim() && d.summary.length <= 8000, '需要说明实际完成的修改。');
    check(typeof d.actor === 'string' && d.actor.trim() && d.actor.length <= 200, '需要实际记录者。');
    check(Array.isArray(d.evidence) && d.evidence.length > 0 && d.evidence.length <= 20 && d.evidence.every(p => typeof p === 'string' && p.length > 0 && p.length <= 4096), '需要实际成果或验证证据入口。');
    check(['pending', 'passed', 'failed'].includes(d.validation?.result) && typeof d.validation?.detail === 'string' && d.validation.detail.trim() && d.validation.detail.length <= 8000, '需要说明验证方法、结果与范围。');
    check(['not_observed', 'improved', 'no_change', 'worse'].includes(d.outcome ?? 'not_observed'), '后续效果取值无效。');
    check(typeof (d.followUp ?? '') === 'string' && (d.followUp ?? '').length <= 8000, '后续观察内容无效。');
    if (d.outcome && d.outcome !== 'not_observed') check(d.followUp?.trim(), '实际效果判断需要后续使用依据。');
    next.delivery = { summary: d.summary.trim(), actor: d.actor.trim(), evidence: [...new Set(d.evidence)], validation: d.validation,
      outcome: d.outcome ?? 'not_observed', followUp: d.followUp ?? '', recordedAt: at };
  }
  if (input.status === 'resolved') check(next.delivery?.validation.result === 'passed', '已落实需要修改与通过的验证记录；仅采纳请标为“已采纳”。', 'REVIEW_DELIVERY_REQUIRED');
  return next;
}

export function suggestionHandoff(suggestion) {
  const evidence = suggestion.evidence.map(e => `${e.taskId}/${e.turnId} · ${e.messageId} · ${e.sourceId}`).join('\n');
  return `请核对并处理 KSF飞轮建议 ${suggestion.id}（修订 ${suggestion.revision}）。\n目标：${suggestion.targetLabel ?? suggestion.targetKey}\n位置：${suggestion.targetPath ?? '尚无正式原件，请先确定候选身份与落点'}\n发现：${suggestion.problem}\n建议差异：${suggestion.change}\n理由：${suggestion.reason}\n验证办法：${suggestion.validation}\n来源：\n${evidence}\n先遵循当前 KSF 固定入口，核对最新原件、版本、必要来源和本次实际授权。采用对应的项目、知识或能力专业方法；确认目标后优先完善现有原件，保留已有改动。应用的建议状态不替代授权，不自动创建新能力。只在本次明确授权内落实。完成后返回实际差异、成果入口、验证方法/结果/范围、未决与后续观察；飞轮的落实记录另行读回核对。本文是待发送草稿，不表示已启动执行，不包含提交、推送或公开发行。`;
}
