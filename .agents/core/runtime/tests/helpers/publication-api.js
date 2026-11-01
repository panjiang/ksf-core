import { sha256, stableJSON } from '../../src/distribution/common.js';

export class PublicationAPI {
  constructor({ wrongTemplate = false, failUpload = false, provenance, concurrent = false, failRef = false, badReceipt = false } = {}) {
    this.calls = []; this.tag = null; this.release = null; this.head = 'd'.repeat(40);
    this.commits = new Map([[this.head, { sha: this.head, tree: { sha: 'e'.repeat(40) } }]]);
    this.wrongTemplate = wrongTemplate; this.failUpload = failUpload;
    this.provenance = provenance ?? { generated_from: 'yinbaiyuan/ksf-core', version: '0.0.0', revision: '0'.repeat(40) };
    this.concurrent = concurrent; this.headReads = 0; this.failRef = failRef; this.badReceipt = badReceipt;
  }
  async request(method, path, body, options) {
    this.calls.push({ method, path, body, options });
    if (path.includes('/git/commits/') && method === 'GET') { const sha = path.split('/').at(-1); this.sourceSHA = sha; return { sha, tree: { sha: 'a'.repeat(40) } }; }
    if (path.includes('/git/ref/heads/core-main') && method === 'GET') return { object: { sha: this.sourceSHA } };
    if (path.includes('/git/ref/tags/') && method === 'GET') return this.tag;
    if (path.endsWith('/git/refs') && method === 'POST') return this.tag = { object: { type: 'commit', sha: body.sha } };
    if (path.includes('/releases/tags/') && method === 'GET') return this.release;
    if (path.endsWith('/releases') && method === 'POST') return this.release = { id: 7, draft: true, html_url: 'https://github.com/yinbaiyuan/ksf-core/releases/tag/v0.1.0', assets: [] };
    if (options?.upload) {
      const name = new URL('https://uploads.github.com' + path).searchParams.get('name');
      const asset = { id: this.release.assets.length + 1, name, size: body.length, digest: `sha256:${sha256(body)}` };
      this.release.assets.push(asset);
      if (this.failUpload) { this.failUpload = false; throw Object.assign(new Error('unknown upload response'), { code: 'GITHUB_REQUEST_FAILED' }); }
      return asset;
    }
    if (path.endsWith('/releases/7') && method === 'PATCH') { this.release.draft = body.draft; return this.release; }
    throw new Error(`Unexpected publication fixture call: ${method} ${path}`);
  }
}
