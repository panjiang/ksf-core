import { posix, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectQuery, objectMutation } from './objects.js';
import { types } from '../objects/schema.js';
import { knowledgeLinks, checkKnowledge } from './knowledge-organize.js';
import { assert } from './workbench-common.js';

// Root-bound primitives. Applications own editing, review and cross-domain handoff.
export function createAssetService(root, { files, reviewSource }) {
  const objectInput = input => {
    assert(input && Object.hasOwn(types, input.type), 'ASSET_TYPE_INVALID', '请选择四类能力对象。');
    return { root, type: input.type, reference: input.ref, source: input.source ?? 'effective' };
  };
  const knowledgePath = path => {
    assert(typeof path === 'string' && (path === '知识' || path.startsWith('知识/')) && !path.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')),
      'KNOWLEDGE_PATH_INVALID', '请选择知识目录中的可见路径。');
    return path;
  };
  const textPath = path => { knowledgePath(path); assert(/\.md$/i.test(path), 'KNOWLEDGE_FORMAT_INVALID', '知识正文使用 Markdown 文件。'); return path; };
  return {
    listObjects(input = {}) {
      const request = objectInput(input);
      return objectQuery({ ...request, operation: 'list' });
    },
    readObject(input) { return objectQuery({ ...objectInput(input), operation: 'read' }); },
    checkObject(input) { return objectQuery({ ...objectInput(input), operation: 'check' }); },
    writeObject(input) {
      const request = objectInput(input);
      assert(typeof input.ifMatch === 'string' && typeof input.dryRun === 'boolean', 'ASSET_VERSION_REQUIRED', '先读取版本，再预览或保存差异。');
      // Source libraries are read-only here. Normal system derivation continues
      // through objectMutation, including baseline/resource/dependent checks.
      assert(request.source === 'effective' || request.source === 'user' || request.source === 'system', 'ASSET_SOURCE_READONLY', '关联能力源请在其实际源工程中维护。');
      try {
        const selected = objectQuery({ ...request, operation: 'read' }).data.object;
        assert(['system', 'user'].includes(selected.source), 'ASSET_SOURCE_READONLY', '关联能力源请在其实际源工程中维护。');
      } catch (error) { if (error.code !== 'OBJECT_NOT_FOUND') throw error; }
      return objectMutation({ root, type: request.type, operation: 'write', id: input.ref, input: input.data,
        ifMatch: input.ifMatch, dryRun: input.dryRun });
    },
    async knowledgeTree(input = {}) {
      const tree = await files.tree(knowledgePath(input.path ?? '知识'));
      return { ...tree, entries: tree.entries.filter(entry => !entry.name.startsWith('.')) };
    },
    readKnowledge(input) { return files.read(textPath(input.path)); },
    saveKnowledge(input) { return files.save({ path: textPath(input.path), text: input.text, version: input.version }); },
    async createKnowledge(input) {
      const path = input.kind === 'directory' ? knowledgePath(input.path) : textPath(input.path);
      const result = await files.create({ path, kind: input.kind ?? 'file', text: input.text ?? '' });
      return result.kind === 'file' ? files.read(result.path) : result;
    },
    searchKnowledge(input) { return files.search({ q: input.q, path: knowledgePath(input.path ?? '知识') }); },
    checkKnowledge(input) { return checkKnowledge({ root, target: knowledgePath(input?.path ?? '知识') }); },
    async links(input) {
      assert(typeof input.path === 'string', 'ASSET_PATH_INVALID', '缺少正文来源位置。');
      const file = await files.read(input.path);
      const out = [];
      for (const link of knowledgeLinks(file.text).slice(0, 200)) {
        if (/^https?:\/\//i.test(link.target)) { out.push({ ...link, kind: 'web', url: link.target }); continue; }
        if (link.target.startsWith('#') || /^(?!file:)[a-z][a-z\d+.-]*:/i.test(link.target)) continue;
        let target;
        try { target = /^file:/i.test(link.target) ? fileURLToPath(link.target) : decodeURIComponent(link.target.split('#')[0].split('?')[0]); target = target.replace(/:\d+(?::\d+)?$/, ''); } catch { continue; }
        let candidates;
        if (isAbsolute(target)) {
          const path = relative(root, target).split(sep).join('/');
          if (path === '..' || path.startsWith('../') || isAbsolute(path)) { out.push({ ...link, kind: 'unverified', reason: 'outside-root' }); continue; }
          candidates = [path];
        } else candidates = link.kind === 'wiki' && !target.startsWith('.') ? [target, posix.join(posix.dirname(input.path), target)] : [posix.join(posix.dirname(input.path), target)];
        candidates = candidates.flatMap(p => link.kind === 'wiki' && !posix.extname(p) ? [p + '.md', p] : [p]).map(p => posix.normalize(p));
        let resolved, failure;
        for (const path of [...new Set(candidates)]) {
          try { const item = await files.locate(path); resolved = { path, directory: item.stat.isDirectory() }; break; }
          catch (error) { failure = error; if (error.code !== 'ENOENT') break; }
        }
        if (resolved) { const { path } = resolved; out.push({ ...link, kind: path === '知识' || path.startsWith('知识/') ? 'knowledge' : path.startsWith('能力/') || path.startsWith('.agents/core/abilities/') ? 'ability' : path.startsWith('项目/') ? 'project' : 'file', ...resolved }); }
        else out.push({ ...link, kind: 'unverified', reason: failure?.code ?? 'missing' });
      }
      return { path: input.path, version: file.version, links: out };
    },
    async related(input) {
      assert(typeof input?.path === 'string', 'ASSET_PATH_INVALID', '缺少实际目标。');
      if (input.ref) objectQuery({ ...objectInput(input), operation: 'read' });
      else { const item = await files.locate(input.path); assert(item.stat.isFile(), 'ASSET_PATH_INVALID', '请选择实际资产原件。'); }
      if (!reviewSource) return { records: [], complete: false, errors: [{ code: 'ASSET_HISTORY_UNAVAILABLE', message: '当前主机未提供采用历史。' }] };
      const count = await reviewSource.sources({ limit: 1 });
      const page = await reviewSource.sources({ limit: 100, offset: Math.max(0, count.total - 100) });
      const records = [];
      for (const record of page.records) {
        const route = record.route;
        if (!route) continue;
        const adopted = input.ref && (route.abilities ?? []).find(a => a.ref?.split('@')[0] === input.ref && a.stage === 'adopted');
        const primary = record.targets?.some(t => t.path === input.path || input.ref && (t.id === input.ref || t.objectId === input.ref));
        const related = (route.relatedTargets ?? []).some(t => t.path === input.path || input.ref && (t.id === input.ref || t.objectId === input.ref));
        if (adopted || primary || related) records.push({ taskId: record.taskId, turnId: record.turnId, title: record.title, at: record.startedAt,
          relation: adopted ? 'adopted' : primary ? 'primary' : 'related', ...(adopted ? { capability: adopted } : {}) });
      }
      return { records, complete: page.total <= 100 && page.errors.length === 0, checked: page.records.length, total: page.total, errors: page.errors };
    },
  };
}
