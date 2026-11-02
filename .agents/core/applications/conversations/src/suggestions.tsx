import { useState } from 'react';
import { useApplicationSDK } from '@ksf/sdk/react';
import { Button } from '@ksf/sdk/components/ui/button';
import { copyText } from '@ksf/sdk/components/ui/context-menu';
import { useAppData } from './api';
import type { Evidence, Suggestion, SuggestionDelivery } from './review-types';

const statuses:Record<string,string> = { pending:'待判断', accepted:'已采纳 · 待落实', in_progress:'落实中', deferred:'稍后处理', ignored:'已忽略', resolved:'已落实' };
const types:Record<string,string> = { capability:'能力改进', asset:'资产修订', quality:'工作质量' };
const outcomes:Record<string,string> = { not_observed:'尚未观察', improved:'后续使用有改善', no_change:'未见改善', worse:'出现新问题' };
type Props = { busy:boolean; action:(method:string,params:unknown)=>Promise<any>; openEvidence:(e:Evidence)=>void; openAsset:(path:string)=>void };

export function Suggestions({busy,action,openEvidence,openAsset}:Props) {
  const sdk = useApplicationSDK();
  const [status,setStatus] = useState('open'), [type,setType] = useState(''), [target,setTarget] = useState('');
  const [draft,setDraft] = useState<{id:string;revision:number;value:SuggestionDelivery}|null>(null);
  const [handoff,setHandoff] = useState<{id:string;text:string}|null>(null);
  const data = useAppData<Suggestion[]>('suggestions.list',{},15000), all = data.data ?? [];
  const items = all.filter(s => (status === 'open' ? ['pending','accepted','in_progress'].includes(s.status) : !status || s.status === status) && (!type || s.type === type) && (!target || s.targetKey === target));
  const targets = [...new Set(all.map(s => s.targetKey))];
  const patch = (key:keyof SuggestionDelivery,value:any) => setDraft(old => old ? {...old,value:{...old.value,[key]:value}} : old);
  async function prepare(s:Suggestion) { const result = await action('suggestions.handoff',{id:s.id,revision:s.revision}); if (result) setHandoff({id:s.id,text:result.text}); }
  function start(s:Suggestion) {
    setDraft({id:s.id,revision:s.revision,value:s.delivery ?? {summary:'',actor:'',evidence:[],validation:{result:'pending',detail:''},outcome:'not_observed',followUp:''}});
  }
  async function saveDelivery(state:string) {
    if (!draft) return;
    const result = await action('suggestions.update',{id:draft.id,revision:draft.revision,status:state,delivery:{...draft.value,evidence:draft.value.evidence.map(v=>v.trim()).filter(Boolean)}});
    if (result) { setDraft(null); data.refresh(); }
  }
  function openTarget(s:Suggestion) {
    const path = s.targetPath;
    if (!path) return;
    if (path.startsWith('知识/')) sdk.openApp('com.ksf.knowledge',new URLSearchParams({path}).toString());
    else if (path.startsWith('能力/') || path.startsWith('.agents/core/abilities/')) sdk.openApp('com.ksf.abilities',new URLSearchParams({path}).toString());
    else if (path.startsWith('项目/')) sdk.openApp('com.ksf.projects',new URLSearchParams({project:path.split('/')[1]}).toString());
    else openAsset(path);
  }
  return <main className="review-suggestion-page">
    <header className="review-heading"><div><p className="review-eyebrow">从发现到实际改变</p><h1>改进事项</h1><p>先决定是否处理，再核对实际修改与验证。后续效果单独观察。</p></div></header>
    <div className="review-filters">
      <select aria-label="建议状态" value={status} onChange={e=>setStatus(e.target.value)}><option value="open">当前待推进</option><option value="">全部状态</option>{Object.entries(statuses).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
      <select aria-label="建议类型" value={type} onChange={e=>setType(e.target.value)}><option value="">全部类型</option>{Object.entries(types).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
      <select aria-label="建议关联对象" value={target} onChange={e=>setTarget(e.target.value)}><option value="">全部关联对象</option>{targets.map(t=><option key={t} value={t}>{all.find(s=>s.targetKey===t)?.targetLabel ?? t}</option>)}</select><span>{items.length} 条</span>
    </div>
    {data.error && <p className="review-error">{data.error}</p>}
    {!items.length && <div className="review-empty"><h2>当前没有待推进的改进</h2><p>有证据的候选会从工作回顾进入这里。可以切换状态调阅历史处理。</p><div><Button variant="outline" onClick={()=>sdk.openApp('com.ksf.projects')}>查看项目</Button><Button variant="outline" onClick={()=>sdk.openApp('com.ksf.abilities')}>查看能力</Button><Button variant="outline" onClick={()=>sdk.openApp('com.ksf.knowledge')}>查看知识</Button></div></div>}
    {items.map(s=><article className="review-suggestion" key={s.id}>
      <div className="review-suggestion-label"><span>{types[s.type] ?? s.type}</span><span>{statuses[s.status] ?? s.status}</span></div><h2>{s.problem}</h2>
      <p className="review-target">涉及：{s.targetLabel ?? s.targetKey}</p><dl><div><dt>建议差异</dt><dd>{s.change}</dd></div><div><dt>理由</dt><dd>{s.reason}</dd></div><div><dt>如何验证</dt><dd>{s.validation}</dd></div></dl>
      {s.type==='capability' && <details><summary>候选方法</summary><p>场景：{s.method.scenario}</p><p>输入：{s.method.input}</p><ol>{s.method.steps.map((v,i)=><li key={i}>{v}</li>)}</ol><p>输出：{s.method.output}</p><p>限制：{s.method.limits}</p></details>}
      <div className="review-evidence-links">{s.evidence.map(e=><button key={e.sourceId} onClick={()=>openEvidence(e)}>{e.title || e.sourceId} · 原文</button>)}</div>
      <div className="review-suggestion-actions">
        {s.targetPath && <Button size="sm" variant="outline" onClick={()=>openTarget(s)}>打开目标</Button>}
        <Button size="sm" variant="outline" disabled={busy} onClick={()=>void prepare(s)}>准备 Agent 处理草稿</Button>
        {Object.entries(statuses).filter(([k])=>k!==s.status && k!=='resolved').map(([k,v])=><button key={k} disabled={busy} onClick={()=>void action('suggestions.update',{id:s.id,revision:s.revision,status:k})}>{v}</button>)}
        <Button size="sm" variant="outline" onClick={()=>start(s)}>记录落实与验证</Button>
      </div>
      {handoff?.id===s.id && <div className="review-delivery-form"><label>待发送任务草稿<textarea aria-label="待发送任务草稿" readOnly value={handoff.text}/></label><p>准备草稿未启动执行。请在实际对话中明确处理范围。</p><Button size="sm" variant="outline" onClick={()=>void copyText(handoff.text)}>复制草稿</Button></div>}
      {draft?.id===s.id && <div className="review-delivery-form">
        <h3>实际做了什么</h3>
        <label>修改与结果<textarea aria-label="修改与结果" value={draft.value.summary} onChange={e=>patch('summary',e.target.value)}/></label>
        <label>成果与证据入口（每行一个）<textarea aria-label="成果与证据入口" value={draft.value.evidence.join('\n')} onChange={e=>patch('evidence',e.target.value.split('\n'))}/></label>
        <label>记录者<input aria-label="落实记录者" value={draft.value.actor} onChange={e=>patch('actor',e.target.value)}/></label>
        <label>本次验证结果<select aria-label="落实验证结果" value={draft.value.validation.result} onChange={e=>patch('validation',{...draft.value.validation,result:e.target.value})}><option value="pending">待核对</option><option value="passed">通过</option><option value="failed">未通过</option></select></label>
        <label>验证方法、实际结果与范围<textarea aria-label="验证方法与范围" value={draft.value.validation.detail} onChange={e=>patch('validation',{...draft.value.validation,detail:e.target.value})}/></label>
        <label>后续实际使用效果<select aria-label="后续使用效果" value={draft.value.outcome} onChange={e=>patch('outcome',e.target.value)}>{Object.entries(outcomes).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
        <label>后续观察或实际使用依据<textarea aria-label="后续观察依据" value={draft.value.followUp} onChange={e=>patch('followUp',e.target.value)}/></label>
        <p>文件可读与人工记录不能独立证明效果。外部网页只保存入口，不自动验证。</p>
        <div className="review-suggestion-actions"><Button disabled={busy} onClick={()=>void saveDelivery('in_progress')}>保存进展</Button><Button disabled={busy || draft.value.validation.result!=='passed'} onClick={()=>void saveDelivery('resolved')}>保存并标记已落实</Button><Button variant="outline" onClick={()=>setDraft(null)}>取消</Button></div>
      </div>}
      {s.delivery && <section className="review-delivery-receipt"><h3>落实记录</h3><p>{s.delivery.summary}</p><p>验证：{({passed:'通过',failed:'未通过',pending:'待核对'} as Record<string,string>)[s.delivery.validation.result] ?? s.delivery.validation.result} · {s.delivery.validation.detail}</p><p>后续效果：{outcomes[s.delivery.outcome] ?? '尚未观察'}{s.delivery.followUp && ' · '+s.delivery.followUp}</p><p className="review-muted">{s.delivery.actor} · {s.delivery.recordedAt}</p>{s.delivery.evidence.map(path=><button key={path} onClick={()=>/^https?:\/\//i.test(path)?window.open(path,'_blank','noopener,noreferrer'):openAsset(path)}>{path} ↗</button>)}</section>}
      {s.status==='resolved' && !s.delivery && <p className="review-muted">历史人工处理标记已保留；尚无修改与验证记录，不能据此认定已核验。</p>}
    </article>)}
  </main>;
}
