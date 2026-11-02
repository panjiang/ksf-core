import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './asset-library.css';

const typeNames = { cooperation: '协同', partner: '搭档', competency: '基本功', 'data-package': '数据包' };
const stateNames = { draft: '草稿', active: '参与使用', archived: '已归档' };
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const button = (text, action, cls = '') => { const node = el('button', 'ka-button ' + cls, text); node.type = 'button'; node.addEventListener('click', action); return node; };
const option = (value, text) => { const node = el('option', '', text); node.value = value; return node; };
const clone = value => JSON.parse(JSON.stringify(value));

export async function mountLibrary(container, sdk, kind) {
  const ability = kind === 'abilities';
  const root = el('div', 'ka-library'), side = el('aside', 'ka-sidebar'), main = el('main', 'ka-main');
  root.append(side, main); container.append(root); side.setAttribute('aria-label', ability ? '能力目录' : '知识目录');
  let alive = true, generation = 0, listGeneration = 0, rows = [], file = null, selected = '', type = 'partner', source = 'effective', folder = '知识';
  let query = '', editing = false, draft = null, creation = false, preview = null, message = '', error = '', busy = false, links = [], check = null, lookupPath = '', related = null, needsMerge = false, draftBaseVersion = null;
  let draftPrefix = sdk.appId + ':';
  try { draftPrefix += (await sdk.getSession()).instanceId + ':'; } catch { draftPrefix += location.origin + ':'; }
  const call = (method, params = {}) => sdk.call(method, params);
  const storageKey = () => draftPrefix + selected;
  const stash = () => { if (!draft) return; preview = null; try { sessionStorage.setItem(storageKey(), JSON.stringify({ draft, creation, conflict: needsMerge, version: draftBaseVersion ?? file?.definition_digest ?? file?.version ?? 'missing' })); } catch { message = '浏览器无法保留草稿，请复制后再关闭。'; } };
  const clearDraft = () => { try { sessionStorage.removeItem(storageKey()); } catch {} draft = null; editing = false; preview = null; needsMerge = false; draftBaseVersion = null; };
  const notify = (text, failed = false) => { error = failed ? text : ''; message = failed ? '' : text; render(); };
  const run = async action => { if (busy) return; busy = true; error='';message='';render(); try { await action(); } catch (e) { error = (e.code ? e.code + '：' : '') + e.message; } finally { busy = false; if (alive) { render(); const path=new URLSearchParams(sdk.getSnapshot().search).get('path');if(path&&path!==lookupPath)void openPath(path).catch(e=>notify(e.message,true)); } } };
  function navigate(path, targetKind) {
    if (targetKind === 'knowledge' || path.startsWith('知识/')) sdk.openApp('com.ksf.knowledge', new URLSearchParams({ path }).toString());
    else if (targetKind === 'ability' || path.startsWith('能力/') || path.startsWith('.agents/core/abilities/')) sdk.openApp('com.ksf.abilities', new URLSearchParams({ path }).toString());
    else if (path.startsWith('项目/')) sdk.openApp('com.ksf.projects', new URLSearchParams({ project: path.split('/')[1], scope: 'current' }).toString());
    else sdk.openApp('com.ksf.markdown', new URLSearchParams({ path, mode: 'read' }).toString());
  }
  function prose(text) {
    const article = el('article', 'ka-article');
    article.innerHTML = DOMPurify.sanitize(marked.parse(text ?? '', { gfm: true }), { USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'style', 'input', 'form', 'iframe', 'object', 'video', 'audio'], FORBID_ATTR: ['style', 'id', 'name'] });
    for (const a of article.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? ''; let decoded=href; try{decoded=decodeURIComponent(href);}catch{} const link = links.find(v => v.target === href || v.target === decoded);
      if (/^https?:\/\//i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      else if (link?.path) { a.href = '#'; a.addEventListener('click', e => { e.preventDefault(); navigate(link.path, link.kind); }); }
      else { a.removeAttribute('href'); a.title = '请在下方来源与引用中核对位置'; }
    }
    return article;
  }
  function label(text, value, update, multiline = false, inputType = 'text') {
    const wrapper = el('label', '', text), input = el(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = inputType; input.value = value ?? ''; input.setAttribute('aria-label', text);
    input.addEventListener('input', () => { update(input.value); stash(); }); wrapper.append(input); return wrapper;
  }
  function selectField(text, current, values, update) {
    const wrapper = el('label', '', text), select = el('select'); for (const [value, name] of values) select.append(option(value, name)); select.value = current;
    select.addEventListener('change', () => { update(select.value); stash(); }); wrapper.append(select); return wrapper;
  }
  function restoreDraft() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey()) ?? 'null');
      if (saved?.draft) { draft = saved.draft; creation = saved.creation; editing = true; draftBaseVersion=saved.version;needsMerge=!!saved.conflict||saved.version !== (file?.definition_digest ?? file?.version ?? 'missing');if (needsMerge) message = '已恢复未保存草稿，原件已变化。请比较差异，再决定合并内容。'; else message = '已恢复未保存草稿。'; }
    } catch { message = '保存的草稿无法读取，请保留原件后重新编辑。'; }
  }
  async function loadLinks(path, token) {
    try { const result = await call('links', { path }); if (alive && token === generation) links = result.links; }
    catch (e) { if (alive && token === generation) message = '正文已读取，引用未完整读取：' + e.message; }
  }
  async function readRow(row, { preserve = false } = {}) {
    if (draft) stash();
    const token = ++generation; selected = ability ? row.id + ':' + row.source : row.path; editing = false; creation = false; draft = null; check = null; related = null; needsMerge=false;draftBaseVersion=null;links = []; preview = null; error = ''; message = ''; file = null; render();
    try {
      const result = await call(ability ? 'readObject' : 'readKnowledge', ability ? { type: row.type ?? type, ref: row.ref ?? row.id, source: row.source } : { path: row.path });
      if (!alive || token !== generation) return;
      file = ability ? result.data.object : result;
      if (ability && result.errors.length) message = '部分依赖不可用：' + result.errors.map(e => e.message).join('；');
      if (ability) type = file.id.split('.')[0];
      lookupPath = file.path; sdk.navigate({ path: file.path }, true);
      if (!ability || ['user', 'system'].includes(file.source)) await loadLinks(file.path, token); if (token !== generation || !alive) return;
      if (!preserve) restoreDraft(); render(); renderList();
    } catch (e) { if (alive && token === generation) notify(e.message, true); }
  }
  async function reload() {
    const token = ++listGeneration; error = ''; renderList();
    try {
      if (ability) {
        const result = await call('listObjects', { type, source }); if (!alive || token !== listGeneration) return;
        rows = result.data.objects; if (!result.data.complete) message = '目录读取有缺口：' + result.errors.map(e => e.message).join('；');
      } else {
        const result = query ? await call('searchKnowledge', { path: folder, q: query }) : await call('knowledgeTree', { path: folder });
        if (!alive || token !== listGeneration) return;
        rows = query ? [...new Map(result.matches.map(r => [r.path, { ...r, name: r.path.split('/').at(-1), kind: 'file' }])).values()] : result.entries;
        if (result.truncated || result.errors?.length) message = '搜索仅显示已读取部分，请缩小范围核对。';
      }
      renderList(); render();
    } catch (e) { if (alive && token === listGeneration) notify(e.message, true); }
  }
  const brand = el('div'); brand.append(el('p', 'ka-eyebrow', ability ? 'Reusable methods' : 'Personal understanding'), el('h2', 'ka-brand', ability ? '能力' : '知识'), el('p', 'ka-subtitle', ability ? '找到能做事的方法' : '留下有依据的认识')); side.append(brand);
  const controls = el('div', 'ka-controls'), search = el('input'); search.type = 'search'; search.placeholder = ability ? '搜索名称、身份与说明' : '搜索此目录正文'; search.setAttribute('aria-label', ability ? '搜索能力' : '搜索知识'); controls.append(search);
  search.addEventListener('input', () => { query = search.value; if (ability) renderList(); });
  search.addEventListener('keydown', e => { if (e.key === 'Enter' && !ability) void reload(); });
  if (ability) {
    const typeSelect = el('select'); typeSelect.setAttribute('aria-label', '能力类型'); for (const [v, n] of Object.entries(typeNames)) typeSelect.append(option(v, n)); typeSelect.value = type;
    typeSelect.addEventListener('change', () => { type = typeSelect.value; void reload(); });
    const sources = el('select'); sources.setAttribute('aria-label', '能力来源'); for (const [v, n] of [['effective', '当前有效定义'], ['all', '全部来源'], ['user', '用户能力'], ['system', '系统能力']]) sources.append(option(v, n));
    sources.addEventListener('change', () => { source = sources.value; void reload(); }); controls.append(typeSelect, sources);
  } else controls.append(button('在此目录搜索', () => void reload()));
  side.append(controls);
  const list = el('nav', 'ka-list'), footer = el('div', 'ka-footer'); list.setAttribute('aria-label', ability ? '能力列表' : '知识文件'); side.append(list, footer);
  footer.append(button(ability ? '新建能力' : '新建记录', () => startNew()), button('刷新', () => void reload()));
  const domains = el('nav', 'ka-domain-nav'); domains.setAttribute('aria-label', '四个核心应用');
  for (const [id, name] of [['com.ksf.projects', '项目'], ['com.ksf.abilities', '能力'], ['com.ksf.knowledge', '知识'], ['com.ksf.conversations', '飞轮']]) domains.append(button(name, () => sdk.openApp(id), 'ka-quiet'));
  side.append(domains);
  function renderList() {
    list.replaceChildren();
    if (!ability && folder !== '知识') list.append(button('← 上一级', () => { folder = folder.split('/').slice(0, -1).join('/'); query = search.value = ''; void reload(); }, 'ka-quiet'));
    const filtered = ability ? rows.filter(r => [r.name, r.id, r.description].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase())) : rows;
    for (const row of filtered) {
      const id = ability ? row.id + ':' + row.source : row.path;
      const b = button('', () => { if (!ability && row.kind === 'directory') { folder = row.path; query = search.value = ''; void reload(); } else if (!ability && !/\.md$/i.test(row.path)) navigate(row.path, 'file'); else void readRow(row); }, 'ka-row');
      b.setAttribute('aria-current', String(id === selected)); b.append(el('strong', '', (!ability && row.kind === 'directory' ? '▸ ' : '') + (row.name ?? row.id)), el('small', '', ability ? `${row.source} · ${stateNames[row.status] ?? row.status} · ${row.version}` : row.line ? `第 ${row.line} 行 · ${row.text}` : row.kind === 'directory' ? '目录' : row.path.split('/').slice(1, -1).join('/')));
      list.append(b);
    }
    if (!filtered.length) list.append(el('p', 'ka-muted', '没有匹配的内容。')); list.append(el('p', 'ka-muted', `${filtered.length} 项${ability ? '' : ' · ' + folder}`));
  }
  function startNew() {
    if (draft) stash(); generation++; file = null; creation = true; editing = true; needsMerge=false;draftBaseVersion='missing';selected = 'new:' + (ability ? type : folder); links = []; check = null; preview = null; error = ''; message = '';
    draft = ability ? { id: `${type}.local.`, name: '', description: '', version: '0.1.0', status: 'draft', references: '', body: '' } : { path: folder + '/新记录.md', text: '# 新记录\n\n内容待补充。\n' }; restoreDraft(); render();
  }
  function startEdit() {
    if (!file) return;
    creation = false; editing = true; preview = null; needsMerge=false;draftBaseVersion=file.definition_digest ?? file.version;
    draft = ability ? { id: file.id, name: file.metadata.name, description: file.metadata.description, version: file.version, status: file.metadata.status, references: (file.metadata.references ?? []).join('\n'), body: file.body } : { path: file.path, text: file.text };
    stash(); render();
  }
  function objectData() { return { metadata: { name: draft.name, description: draft.description, version: draft.version, status: draft.status, references: draft.references.split('\n').map(s => s.trim()).filter(Boolean) }, body: draft.body }; }
  async function save(previewOnly = false) {
    if(needsMerge&&!previewOnly)throw Object.assign(Error('原件已变化，请先比较并合并，再保存当前草稿。'),{code:'ASSET_MERGE_REQUIRED'});
    const expected = file?.definition_digest ?? file?.version ?? 'missing';
    const current = clone(draft);
    if (ability) {
      const data=objectData();let result;
      try{result=await call('writeObject', { type: current.id.split('.')[0], ref: current.id, ifMatch: expected, dryRun: previewOnly, data });}
      catch(error){
        if(!previewOnly)try{const disk=(await call('readObject',{type:current.id.split('.')[0],ref:current.id,source:'user'})).data.object;if(disk.body===data.body&&Object.entries(data.metadata).every(([k,v])=>JSON.stringify(disk.metadata[k])===JSON.stringify(v))){clearDraft();await reload();await readRow({id:current.id,source:'user',type:current.id.split('.')[0]},{preserve:true});message='当前原件已与草稿一致，已读回核对，未重复写入。';return;}}catch{}
        throw error;
      }
      if (previewOnly) { preview = result.data; message = result.data.derived ? '检查通过。保存将建立用户派生，保留系统基线；不会改系统原件。' : '检查通过。请比较下方差异，再保存。'; return; }
      clearDraft(); message = '能力已保存，正在核对原件。'; await reload(); await readRow({ id: current.id, source: 'user', type: current.id.split('.')[0] }, { preserve: true }); message = '已保存并读回用户能力。结构通过仍需实际任务验证效果。';
    } else {
      if (previewOnly) { preview = { valid: true }; message = '请比较原件和草稿。来源与内容含义由你核对。'; return; }
      try {
        const result = await call(creation ? 'createKnowledge' : 'saveKnowledge', creation ? { path: current.path, text: current.text } : { path: current.path, text: current.text, version: expected });
        clearDraft(); file = result; selected = result.path; creation = false; message = '已保存并读回知识原件。'; folder = result.path.split('/').slice(0, -1).join('/'); await reload(); await loadLinks(result.path, generation);
      } catch (e) {
        // A transport failure may follow a successful write. Read the same
        // destination and compare content before offering a retry.
        try { const disk = await call('readKnowledge', { path: current.path }); if (disk.text === current.text) { clearDraft(); file = disk; selected = disk.path; creation = false; message = '已读回核对：内容已保存。'; await reload(); return; } } catch {}
        throw e;
      }
    }
  }
  function render() {
    if (!alive) return;for(const node of side.querySelectorAll('button,input,select'))node.disabled=busy;main.replaceChildren();
    if (message || error) { const banner = el('div', 'ka-banner' + (error ? ' ka-error' : ''), error || message); banner.setAttribute('role', error ? 'alert' : 'status'); main.append(banner); }
    const heading = el('header', 'ka-heading'), title = el('div'); title.append(el('p', 'ka-eyebrow', editing ? creation ? 'Create' : 'Revise' : ability ? 'Capability definition' : 'Knowledge original'), el('h1', '', editing ? creation ? ability ? '建立一项能力' : '写下一条记录' : '修订现有内容' : file ? ability ? file.metadata.name : file.text.match(/^#\s+(.+)$/m)?.[1] ?? file.path.split('/').at(-1).replace(/\.md$/i, '') : ability ? '方法有出处，使用有边界' : '从原文，走到自己的认识'));
    const actions = el('div', 'ka-actions'); heading.append(title, actions); main.append(heading);
    if (editing && draft) { renderEditor(actions); return; }
    if (!file) { main.append(el('p', 'ka-empty', ability ? '从左侧选择协同、搭档、基本功或数据包。查看有效来源、定义和依赖，也可以建立用户能力。' : '沿左侧目录打开知识原文，或搜索当前范围。内容、组织规则和来源仍保存在现有 Markdown 中。')); return; }
    const readonly = ability && (file.protected || !['user', 'system'].includes(file.source));
    actions.append(button('修订', startEdit)); actions.lastChild.disabled = readonly || busy;
    actions.append(button('核对', () => void run(async () => { check = await call(ability ? 'checkObject' : 'checkKnowledge', ability ? { type, ref: file.id, source: file.source } : { path: file.path }); })));
    if(!ability||['user','system'].includes(file.source))actions.append(button('查看原件', () => sdk.openApp('com.ksf.markdown', new URLSearchParams({ path: file.path, mode: 'read' }).toString())));else main.append(el('p','ka-muted','关联源原件位于：'+(file.source_root??file.source)+'/'+file.path));
    const meta = el('div', 'ka-meta'); if (ability) for (const text of [typeNames[type], file.source, file.version, file.user_revision ? `修订 ${file.user_revision}` : '', stateNames[file.metadata.status], file.protected ? '固定入口 · 只读' : ''].filter(Boolean)) meta.append(el('span', 'ka-pill', text));
    else meta.append(el('span', 'ka-pill', `${file.size} 字节`), el('span', 'ka-pill', new Date(file.modifiedAt).toLocaleString('zh-CN'))); main.append(meta, el('p', 'ka-muted', file.path));
    if (ability) main.append(el('p', 'ka-muted', file.metadata.description), el('p', 'ka-muted', '状态表示是否参与使用；效果以定义中的验证范围和真实任务证据判断。'));
    main.append(prose(ability ? file.body : file.text));
    if (ability && file.metadata.references?.length) { main.append(el('h2', '', '声明依赖')); for (const ref of file.metadata.references) main.append(button(ref + ' ↗', () => { const [id] = ref.split('@'); const t = id.split('.')[0]; type = t; controls.querySelector('select').value = t; void reload().then(() => readRow({ id, ref, type: t, source: 'effective' })); }, 'ka-quiet')); }
    main.append(el('h2', '', '来源与引用')); if (!links.length) main.append(el('p', 'ka-muted', '未发现显式正文链接；不根据名称推断关系。'));
    for (const link of links) { const row = el('div', 'ka-reference'); row.append(el('span', 'ka-muted', `L${link.line}`)); if (link.path) row.append(button(link.target + ' ↗', () => navigate(link.path, link.kind), 'ka-quiet')); else if (link.url) { const a = el('a', '', link.target + ' ↗'); a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a); } else row.append(el('span', 'ka-muted', link.target + ' · 未核验')); main.append(row); }
    main.append(el('h2', '', '使用与关联记录'));
    main.append(button('查看已采集记录', () => void run(async () => { related = await call('related', { path: file.path, ...(ability ? {type,ref:file.id,source:file.source} : {}) }); })));
    if (related) {
      main.append(el('p','ka-muted',`已核对最近 ${related.checked ?? 0} 条采集记录，共 ${related.total ?? 0} 条。关联和采用分别表达；没有记录不证明未使用。`));
      for (const r of related.records) {
        const row=el('div','ka-reference'); row.append(el('span','ka-pill',r.relation==='adopted'?'声明已采用':r.relation==='primary'?'主要工作':'明确关联'),button(r.title+' ↗',()=>sdk.openApp('com.ksf.conversations',new URLSearchParams({reviewView:'chats',task:r.taskId,turn:r.turnId,chatState:'all'}).toString()),'ka-quiet'));
        if(r.capability)row.append(el('small','ka-muted',r.capability.ref+' · '+r.capability.source)); main.append(row);
      }
      if(!related.complete) main.append(el('p','ka-muted','显示范围有限，完整历史请到飞轮按目标与对话核对。'));
    }
    const handoff = el('details'); handoff.append(el('summary', '', '准备给 Agent 的改进任务')); const text = `请审阅并完善 ${ability ? '能力' : '知识'} ${file.path}。先遵循当前 KSF 入口，读取最新原文及必要来源，保留已有有效内容。本次请先给出具体差异和验证办法；没有明确修改要求前不要写入。当前参考版本：${ability ? file.definition_digest : file.version}。`; const copy = label('任务草稿', text, () => {}, true); copy.querySelector('textarea').readOnly = true; copy.querySelector('textarea').classList.add('ka-draft-copy'); handoff.append(copy); main.append(handoff);
    if (check) { const data = check.data ?? check; main.append(el('div', 'ka-check', `${data.valid ? '检查通过' : '发现需要处理的问题'}\n${(check.errors ?? data.errors ?? []).map(e => `${e.code ?? ''} ${e.message ?? ''}`).join('\n')}\n${!ability ? `仅核对文件与链接；${data.externalLinks ?? 0} 项外部来源、${data.anchorsUnchecked ?? 0} 项锚点未验证。` : '引用和结构检查不代替方法效果验证。'}`)); }
  }
  function renderEditor(actions) {
    actions.append(button('取消编辑', () => { const current=file;clearDraft();creation=false;error='';message='';if(current)void readRow(ability?{id:current.id,type:current.id.split('.')[0],source:current.source}:{path:current.path},{preserve:true});else render(); }), button('比较与检查', () => void run(() => save(true))), button('保存', () => void run(() => save()), 'ka-primary'));
    for (const node of actions.querySelectorAll('button')) node.disabled = busy;
    const form = el('div', 'ka-form');
    if (ability) {
      const grid = el('div', 'ka-form-grid'); const idLabel = label('能力身份 ID', draft.id, v => draft.id = v); idLabel.querySelector('input').readOnly = !creation; grid.append(idLabel, label('名称', draft.name, v => draft.name = v));
      const versionLabel = label('版本', draft.version, v => draft.version = v); versionLabel.querySelector('input').readOnly = !creation && (file?.source === 'system' || file?.metadata.upstream);
      grid.append(versionLabel, selectField('状态', draft.status, Object.entries(stateNames), v => draft.status = v)); form.append(grid, label('用途说明', draft.description, v => draft.description = v), label('精确依赖（每行一个 ID@版本）', draft.references, v => draft.references = v, true), label('能力正文', draft.body, v => draft.body = v, true));
      form.querySelector('textarea').style.minHeight = '90px';
    } else { const pathLabel = label('保存位置', draft.path, v => draft.path = v); pathLabel.querySelector('input').readOnly = !creation; form.append(pathLabel, label('知识正文', draft.text, v => draft.text = v, true), el('p', 'ka-muted', creation ? '创建普通记录，不自动套用认知框架。新主题或结构整理请按当前知识规则由 Agent 处理，并核对必要导航。' : '保存到同一原件，保留来源、适用范围和未确认内容；不会自动提炼或建立能力。')); }
    main.append(form);
    const compare = el('details'); compare.open = !!preview || needsMerge; compare.append(el('summary', '', preview ? '检查结果与前后差异' : '查看原件与草稿')); const columns = el('div', 'ka-preview');
    for (const [name, value] of [['原件', file ? ability ? file.body : file.text : '尚未创建'], ['草稿', ability ? draft.body : draft.text]]) { const col = el('div'); col.append(el('h2', '', name), el('pre', '', value)); columns.append(col); }
    compare.append(columns); main.append(compare);
    if(needsMerge)main.append(el('p','ka-banner','原件与草稿基线不同。请在正文中合并需要保留的改动，再确认合并完成。'),button('已比较并完成合并',()=>{needsMerge=false;draftBaseVersion=file?.definition_digest??file?.version??'missing';stash();message='将按当前草稿保存；请核对上方差异。';error='';render();}));
    if (error) main.append(button('重新读取原件并保留草稿', () => { if (file) void readRow(ability ? { id: file.id, source: file.source, type } : { path: file.path }); }));
  }
  const initial = new URLSearchParams(sdk.getSnapshot().search).get('path');
  async function openPath(path) {
    if (busy || !path || path === lookupPath) return;
    if (!ability) { if(/\.md$/i.test(path)){folder = path.split('/').slice(0, -1).join('/') || '知识'; await reload(); await readRow({ path });}else{if(draft)stash();generation++;file=null;draft=null;editing=false;folder=path;lookupPath=path;sdk.navigate({path},true);await reload();} }
    else { for (const t of Object.keys(typeNames)) { const result = await call('listObjects', { type: t, source: 'all' }); const row = result.data.objects.find(row => row.path === path); if (row) { type = t; controls.querySelector('select').value = t; await reload(); await readRow({ ...row, type: t }); return; } } notify('此路径当前不在能力发现范围内，请核对原件与来源。', true); }
  }
  const unsubscribe = sdk.subscribe(() => { const path = new URLSearchParams(sdk.getSnapshot().search).get('path'); if (path && path !== lookupPath) void openPath(path).catch(e => notify(e.message, true)); });
  const beforeClose = sdk.onBeforeClose(() => { if (draft) stash(); return true; });
  render(); await reload();
  if (initial) await openPath(initial); else if (!ability && rows.some(r => r.path === '知识/knowledge.md')) await readRow({ path: '知识/knowledge.md' });
  return { dispose() { alive = false; generation++; listGeneration++; if (draft) stash(); unsubscribe?.(); beforeClose?.(); root.remove(); } };
}
