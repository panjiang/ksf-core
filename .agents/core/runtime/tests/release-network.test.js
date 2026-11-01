import {fixtureTarget} from './helpers/distribution-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { download, releaseIndex, resourceURL } from '../src/distribution/network.js';
import { systemUpdate } from '../src/distribution/system.js';
import { configuration, installedManifest, stableJSON } from '../src/distribution/common.js';
import { distributionFixture } from './helpers/distribution-fixture.js';

test('new users check the public index asset without an anonymous REST API request', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url)), config = configuration(root);
  assert.equal(config.release_source, `https://github.com/${config.core_repository}/releases/latest/download/${config.index_asset}`);
  const requested = [], index = { schema_version: 1, version: '0.1.3' };
  const result = await releaseIndex(config.release_source, { fetcher: async url => {
    requested.push(url.href);
    assert.equal(url.hostname, 'github.com');
    return new Response(stableJSON(index));
  } });
  assert.deepEqual(result.index, index);
  assert.deepEqual(requested, [config.release_source]);
});

test('a real HTTP Release API/index/archive chain upgrades a copied workspace on loopback', async t => {
  const f = await distributionFixture(t), next = await f.next();
  const index = JSON.parse(readFileSync(join(next.output, 'ksf-core-index.json')));
  let origin;
  const server = createServer((request, response) => {
    if (request.url === '/latest') response.end(stableJSON({ draft: false, prerelease: false, assets: [{ name: 'ksf-core-index.json', browser_download_url: origin + '/index.json' }] }));
    else if (request.url === '/index.json') response.end(stableJSON(index));
    else if (request.url === '/core.tar.gz') response.end(readFileSync(next.coreArchive));
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  origin = `http://127.0.0.1:${server.address().port}`;
  index.platforms[fixtureTarget].core.url = origin + '/core.tar.gz';
  const result = await systemUpdate({ root: f.workspace, source: origin + '/latest' });
  assert.equal(result.to, '0.1.1'); assert.equal(installedManifest(f.workspace).version, '0.1.1');
});
test('release discovery requires one unambiguous ksf-core index asset', async () => {
  const base = 'https://example.invalid', index = { version: '0.1.2' };
  const assets = [{ name: 'ksf-core-index.json', browser_download_url: base + '/index' }];
  const fetcher = async url => new Response(stableJSON(url.pathname === '/latest' ? { assets } : index));
  assert.deepEqual((await releaseIndex(base + '/latest', { fetcher })).index, index);
  assets.length = 0;
  await assert.rejects(releaseIndex(base + '/latest', { fetcher }), { code: 'RELEASE_INVALID' });
  assets.unshift({ name: 'ksf-core-index.json' }, { name: 'ksf-core-index.json' });
  await assert.rejects(releaseIndex(base + '/latest', { fetcher }), { code: 'RELEASE_INVALID' });
});
test('downloads reject public plaintext HTTP, credentials, unsafe redirects and oversized streaming bodies', async () => {
  assert.throws(() => resourceURL('http://example.com/index.json'), { code: 'SOURCE_INVALID' });
  assert.throws(() => resourceURL('https://user:password@example.com/'), { code: 'SOURCE_INVALID' });
  assert.throws(() => resourceURL('/local-file', 'https://example.com/index.json'), { code: 'SOURCE_INVALID' });
  await assert.rejects(download('https://example.invalid/index', { fetcher: async () => new Response(null, { status: 302, headers: { Location: 'file:///etc/passwd' } }) }), { code: 'SOURCE_INVALID' });
  await assert.rejects(download('https://example.invalid/index', { limit: 3, fetcher: async () => new Response('oversized') }), { code: 'DOWNLOAD_TOO_LARGE' });
  await assert.rejects(releaseIndex('https://example.invalid/index', { fetcher: async () => new Response('{invalid') }), { code: 'INVALID_JSON' });
});
