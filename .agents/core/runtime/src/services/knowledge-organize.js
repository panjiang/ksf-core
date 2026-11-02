import{portable}from'../shared/paths.js';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ignored = new Set(['node_modules', '_cache', '_working']);
const inside = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep); };

// Only visible prose participates. Historical commands and inline code are not links.
function prose(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line.replace(/(`+)[\s\S]*?\1/g, '');
  }).join('\n');
}

export function knowledgeLinks(text) {
  const clean = prose(text), links = [];
  const definitions = new Map([...clean.matchAll(/^\s{0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))/gm)]
    .map(m => [m[1].trim().toLowerCase(), m[2] ?? m[3]]));
  const add = (target, index, kind) => links.push({ target, line: clean.slice(0, index).split('\n').length, kind });
  for (const match of clean.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) add(match[1].split('|')[0], match.index, 'wiki');
  const starts = /!?\[(?!\[)([^\]\n]*)\]\s*\(/g;
  for (let match; (match = starts.exec(clean));) {
    let i = starts.lastIndex;
    while (/\s/.test(clean[i] ?? '') && i < clean.length) i++;
    let target = '';
    if (clean[i] === '<') {
      const end = clean.indexOf('>', i + 1);
      if (end < 0) continue;
      target = clean.slice(i + 1, end);
    } else {
      let depth = 0;
      for (; i < clean.length; i++) {
        const c = clean[i];
        if (c === '\\' && i + 1 < clean.length) { target += clean[++i]; continue; }
        if ((c === ')' && depth === 0) || (/\s/.test(c) && depth === 0)) break;
        if (c === '(') depth++;
        if (c === ')') depth--;
        target += c;
      }
    }
    if (target) add(target, match.index, 'markdown');
  }
  for (const m of clean.matchAll(/!?\[(?!\[)([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const target = definitions.get((m[2] || m[1]).trim().toLowerCase());
    if (target) add(target, m.index, 'markdown');
  }
  return links;
}

function noLinks(root, path) {
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root, stat = lstatSync(root);
  if (stat.isSymbolicLink()) throw Object.assign(new Error('Symbolic link is not followed.'), { code: 'KNOWLEDGE_SYMLINK' });
  for (const part of parts) {
    current = resolve(current, part); stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw Object.assign(new Error('Symbolic link is not followed.'), { code: 'KNOWLEDGE_SYMLINK' });
  }
  return stat;
}

export function checkKnowledge({ root, target = '知识' }, { readText = p => readFileSync(p, 'utf8') } = {}) {
  const base = realpathSync(root), folder = resolve(base, target);
  if (!inside(base, folder)) throw Object.assign(new Error('Target is outside the selected root.'), { code: 'KNOWLEDGE_TARGET_OUTSIDE_ROOT' });
  const errors = [], unchecked = [], files = [], links = [];
  let complete = true, anchorsUnchecked = 0;
  const issue = (error, path, extra = {}) => {
    errors.push({ code: error.code === 'ENOENT' ? 'KNOWLEDGE_PATH_MISSING' : error.code ?? 'KNOWLEDGE_READ_FAILED', path: portable(relative(base, path)), message: error.message, ...extra });
  };
  const walk = path => {
    try {
      const stat = noLinks(base, path);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
          walk(resolve(path, entry.name));
        }
      } else if (!stat.isFile()) {
        complete = false; issue({ code: 'KNOWLEDGE_SPECIAL_FILE', message: 'Special file is not read.' }, path);
      } else if (extname(path).toLowerCase() === '.md') {
        const body = readText(path); files.push(portable(relative(base, path)));
        for (const link of knowledgeLinks(body)) links.push({ ...link, from: path });
      }
    } catch (error) { complete = false; issue(error, path); }
  };
  walk(folder);
  let checked = 0, external = 0;
  for (const link of links) {
    const at = { from: portable(relative(base, link.from)), line: link.line, target: link.target };
    if (/^(?:https?:|mailto:|tel:|data:|plugin:|codex:|app:)/i.test(link.target)) { external++; continue; }
    if (link.target.includes('#')) anchorsUnchecked++;
    if (link.target.startsWith('#')) continue;
    if (/\{\{|\$[A-Za-z_{]|^<[^>]+>$/.test(link.target)) { unchecked.push({ ...at, reason: 'dynamic-or-template' }); continue; }
    let value;
    try { value = /^file:/i.test(link.target) ? fileURLToPath(link.target) : decodeURIComponent(link.target.split('#')[0].split('?')[0]); }
    catch (error) { issue({ code: 'KNOWLEDGE_LINK_INVALID', message: error.message }, link.from, at); continue; }
    // Codex local file citations may append a line (and optional column).
    // Validate file existence separately; a suffix does not prove that line exists.
    value = value.replace(/:(\d+)(?::\d+)?$/, '');
    if (!isAbsolute(value) && /^[a-z][a-z\d+.-]*:/i.test(value)) { unchecked.push({ ...at, reason: 'unsupported-scheme' }); continue; }
    // Obsidian paths are vault-root-relative; an explicitly relative path is local.
    const candidates = link.kind === 'wiki' && !isAbsolute(value) && !value.startsWith('.')
      ? [resolve(base, value), resolve(dirname(link.from), value)] : [resolve(dirname(link.from), value)];
    const expanded = candidates.flatMap(p => link.kind === 'wiki' && !extname(p) ? [p + '.md', p] : [p]);
    if (expanded.some(p => !inside(base, p))) { unchecked.push({ ...at, reason: 'outside-root' }); continue; }
    let found = false, failure;
    for (const path of expanded) {
      try { noLinks(base, path); found = true; break; }
      catch (error) { failure = error; if (error.code !== 'ENOENT') break; }
    }
    if (found) checked++;
    else {
      if (failure?.code !== 'ENOENT') complete = false;
      issue({ code: failure?.code === 'ENOENT' ? 'KNOWLEDGE_LINK_MISSING' : failure?.code ?? 'KNOWLEDGE_LINK_FAILED', message: failure?.message ?? 'Link target is missing.' }, link.from, at);
    }
  }
  return { valid: errors.length === 0, complete, root: base, target: portable(relative(base, folder)) || '.', files,
    checkedLinks: checked, externalLinks: external, anchorsUnchecked, unchecked, errors,
    limits: ['file existence only; anchors, semantics and external sources are not validated', 'no implicit directory model; no symbolic-link traversal', 'working/cache/hidden trees excluded', 'line and column suffixes are ignored; referenced positions are not validated'] };
}
