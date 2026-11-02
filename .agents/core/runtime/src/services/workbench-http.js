import {createCoreHost} from './core-host.js';
import {project as projectService} from './projects.js';
import {listTasks} from './tasks.js';
import {createWorkbenchGit} from './workbench-git.js';
import {createApplicationStorage} from './application-storage.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {createCommunicationService} from '../communication/service.js';
import {createLocalControl} from '../communication/control.js';
import { createCoordinator, problem, assert } from './workbench-common.js';
import { createWorkspaceFiles } from './workspace-files.js';
import {createTaskActivitySource} from './task-activity.js';
import { createApplicationManager } from '../applications/manager.js';
import { MAX_PACKAGE } from '../applications/protocol.js';
import { createWorkbenchAI } from './ai-tasks.js';
import { createCodexConversations, CONVERSATION_METHODS } from './codex-conversations.js';

async function readJSON(request) {
  assert(request.headers['content-type']?.split(';')[0] === 'application/json', 'WEB_CONTENT_TYPE', '写请求需要 application/json。', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; assert(size <= 30 * 1024 * 1024, 'WEB_BODY_TOO_LARGE', '请求内容过大。', 413); chunks.push(chunk); }
  try { const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert(input && typeof input === 'object' && !Array.isArray(input), 'WEB_BODY_INVALID', '请求需要 JSON 对象。'); return input; }
  catch (error) { if (error.code) throw error; throw problem('WEB_BODY_INVALID', '请求不是有效 JSON。'); }
}
export function createWorkbenchHTTP(root, options = {}) {
  const host=options.host??createCoreHost(root,options);
  const {files,activity,applications,ai,codexConversations,communication:communicationReady,control,configuration,git}=host;
  const token = randomBytes(32).toString('hex'), nonce = randomBytes(24).toString('base64');
  const secureEqual = value => typeof value === 'string' && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  const matches = pathname => (pathname==='/api/config'||pathname.startsWith('/api/config/')) || pathname.startsWith('/api/runtime/') || pathname.startsWith('/api/local/') || pathname.startsWith('/api/communication/') || pathname === '/api/work-stats' || pathname.startsWith('/api/apps/') || pathname.startsWith('/app-assets/') || pathname.startsWith('/app-store/') || pathname === '/api/workbench/session' || pathname.startsWith('/api/workspace/') || pathname === '/api/git/repositories' || pathname.startsWith('/api/git/repositories/') || pathname === '/api/git/operations' || pathname.startsWith('/api/git/operations/');
  async function handle(request, url, send, response) {
    if (!matches(url.pathname) && !url.pathname.startsWith('/api/ai/')) return false;
    const json = (status, data) => send(status, JSON.stringify({ ok: true, data }) + '\n');
    try {
      if(url.pathname.startsWith('/api/local/'))return await control.handle(request,url,send,response,{local:true});
      if(url.pathname==='/api/work-stats')assert(['GET','HEAD'].includes(request.method),'WEB_METHOD_NOT_ALLOWED','Use GET or HEAD.',405);
      const write = request.method === 'POST';
      assert(['GET', 'HEAD', 'POST'].includes(request.method), 'WEB_METHOD_NOT_ALLOWED', '此接口只支持 GET、HEAD 或 POST。', 405);
      if (write) {
        assert(request.headers.origin, 'WEB_WRITE_FORBIDDEN', '写请求需要当前工作台的来源。', 403);
        assert(!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin', 'WEB_WRITE_FORBIDDEN', '拒绝跨站写请求。', 403);
        assert(secureEqual(request.headers['x-ksf-token']), 'WEB_SESSION_EXPIRED', '工作台会话已失效，请重新连接后保存。', 403);
      }
      if(write&&host.draining()&&!url.pathname.startsWith('/api/runtime/'))throw problem('SERVICE_STOPPING','后台正在退出，请稍后重试。',409);
      if(url.pathname==='/api/config'||url.pathname.startsWith('/api/config/')){
        const input=write?await readJSON(request):{};
        if(url.pathname==='/api/config'){assert(!write,'WEB_METHOD_NOT_ALLOWED','目录仅支持读取。',405);json(200,await configuration.list());}
        else if(url.pathname==='/api/config/export'){assert(write,'WEB_METHOD_NOT_ALLOWED','配置导出需要 POST。',405);json(200,await configuration.export(input));}
        else{const domain=decodeURIComponent(url.pathname.slice('/api/config/'.length));json(200,write?await configuration.perform(domain,input.operation??'write',input):await configuration.read(domain));}
        return true;
      }
      if(url.pathname==='/api/runtime/monitor'){assert(write,'WEB_METHOD_NOT_ALLOWED','监控接口需要会话保护的 POST。',405);json(200,await host.monitor.perform(await readJSON(request)));return true;}
      if(url.pathname.startsWith('/api/runtime/')){const input=write?await readJSON(request):{};if(url.pathname==='/api/runtime/apps')json(200,await applications.runtimeManage(input));else if(url.pathname==='/api/runtime/service'){const operation=input.operation??'status';assert(options.service&&['status','logs','doctor','stop','restart','autostart'].includes(operation),'SERVICE_OPERATION_INVALID','未知服务操作。');assert(write||operation==='status','WEB_METHOD_NOT_ALLOWED','管理操作需要 POST。',405);json(200,await options.service[operation](input));}else throw problem('WEB_NOT_FOUND','接口不存在。',404);return true;}
      if(url.pathname.startsWith('/api/communication/'))return await control.handle(request,url,send,response);
      if(url.pathname==='/api/work-stats'){
        const zones=url.searchParams.getAll('timeZone'),refresh=url.searchParams.getAll('refresh');
        assert(zones.length<=1&&refresh.length<=1&&(!refresh.length||refresh[0]==='1'),'INVALID_ARGUMENTS','统计参数无效。');
        const data=await applications.invoke('com.ksf.conversations','stats.read',{...(zones.length?{timeZone:zones[0]}:{}),refresh:refresh[0]==='1'});
        send(200,JSON.stringify({ok:!data.errors.length,data,errors:data.errors})+'\n');return true;
      }
      const query = key => { const values = url.searchParams.getAll(key); assert(values.length <= 1, 'INVALID_ARGUMENTS', `参数 ${key} 重复。`); return values[0] ?? undefined; };
      const path = query('path') ?? '', route = url.pathname;
      if (route === '/api/workbench/session' && !write) { json(200, { instanceId: files.instanceId, token, nonce, capabilities: ['workspace', 'git', 'applications-v1', 'ai-tasks-v1', 'codex-conversations-v1','host-terminal-v1','app-storage-v1','app-storage-runtime-v1','projects-v1','projects-management-v1','assets-v1','config-v1','runtime-monitor-v1'], sessionId: nonce }); return true; }
      if (route.startsWith('/api/ai/')) {
        assert(write,'WEB_METHOD_NOT_ALLOWED','AI 配置与管理接口需要会话保护的 POST。',405);
        if(route==='/api/ai/material-upload') {
          const caller=applications.caller(query('instanceId'));
          const material=await ai.upload(caller,{name:query('name'),mimeType:request.headers['content-type']?.split(';')[0]},request);
          json(201,material);return true;
        }
        const input=await readJSON(request);
        if(route==='/api/ai/inspect')json(200,{...await ai.inspect(),backgroundErrors:applications.getBackgroundErrors()});
        else if(route==='/api/ai/desktop'){
          assert(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===0,'INVALID_ARGUMENTS','Desktop 状态检查不接受操作参数。');
          const state=await codexConversations.check({appId:'ksf.workbench'});
          json(200,{available:state.available,contractVersion:state.contractVersion,platform:state.platform,...(state.executable?{executable:state.executable}:{}),permissionProfile:state.permissions?.id??null,...(state.code?{code:state.code,message:state.message}:{}),checkedAt:new Date().toISOString()});
        }
        else if(route==='/api/ai/config')json(200,await ai.config(input.kind,input.config));
        else if(route==='/api/ai/check')json(200,await ai.checkConnection(input.executorId));
        else if(route==='/api/ai/task') {
          json(200,await ai.adminGet(input.aiTaskId));
        } else throw problem('WEB_NOT_FOUND','AI 管理接口不存在。',404);
        return true;
      }
      if (route.startsWith('/app-assets/')) {
        assert(!write, 'WEB_METHOD_NOT_ALLOWED', '应用资源只支持读取。', 405);
        const match = route.match(/^\/app-assets\/([a-z][a-z0-9.-]{1,79})\/([a-f0-9]{64})\/(.+)$/); assert(match, 'APP_ASSET_NOT_FOUND', '应用资源不存在。', 404);
        const asset = await applications.asset(match[1], match[2], match[3]); send(200, asset.bytes, asset.type); return true;
      }
      if (route.startsWith('/app-store/')) { assert(!write, 'WEB_METHOD_NOT_ALLOWED', '应用源资源只支持读取。', 405); const name = route.slice('/app-store/'.length); send(200, await applications.storeAsset(name), name.endsWith('.json') ? 'application/json' : 'application/octet-stream'); return true; }
      if (route.startsWith('/api/apps/')) {
        if (!write) {
          if (route === '/api/apps/cli/docs') {
            const appId=query('appId'),digest=query('digest');
            assert(typeof appId==='string'&&/^[a-z][a-z0-9.-]{1,79}$/.test(appId)&&typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest),'INVALID_ARGUMENTS','CLI 文档需要应用标识和完整包摘要。');
            json(200,await applications.cliDocs(appId,{expectedPackageDigest:digest,path:query('path')}));return true;
          }
          if (route === '/api/apps/installed') { json(200, await applications.snapshot()); return true; }
          if (route === '/api/apps/catalog') { json(200, await applications.catalog()); return true; }
          if(route==='/api/apps/file-read'){let params;try{params=JSON.parse(query('params')??'{}');}catch{throw problem('INVALID_ARGUMENTS','导出参数无效。');}assert(Buffer.byteLength(JSON.stringify(params))<=8192,'INVALID_ARGUMENTS','导出参数过大。');const file=await applications.download(query('instanceId'),params);send(200,file.bytes,'application/octet-stream',{'X-Content-Type-Options':'nosniff','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name),'Cache-Control':'no-store'});return true;}
          if (route === '/api/apps/media') { const asset=await applications.media({sourceId:query('sourceId'),appId:query('appId'),version:query('version'),digest:query('digest')});send(200,asset.bytes,asset.type,{'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=300'});return true; }
          throw problem('WEB_METHOD_NOT_ALLOWED', '应用操作需要 POST。', 405);
        }
        if(route==='/api/apps/import/preview'){
          assert(request.headers['content-type']?.split(';')[0]==='application/octet-stream','WEB_CONTENT_TYPE','应用包上传需要 application/octet-stream。',415);
          assert(Number(request.headers['content-length']??0)<=MAX_PACKAGE,'APP_PACKAGE_TOO_LARGE','应用包不能超过 32 MiB。',413);
          const chunks=[];let size=0;
          for await(const chunk of request){size+=chunk.length;assert(size<=MAX_PACKAGE,'APP_PACKAGE_TOO_LARGE','应用包不能超过 32 MiB。',413);chunks.push(chunk);}
          json(200,await applications.prepareImport(Buffer.concat(chunks),query('name')));return true;
        }
        const input = await readJSON(request);
        switch (route) {
          case '/api/apps/import/install': json(200,await applications.installImport(input));break;
          case '/api/apps/import/discard': await applications.discardImport(input.importId);json(200,{});break;
          case '/api/apps/install': json(200, await applications.install(input)); break;
          case '/api/apps/source': json(200, await applications.saveSource(input)); break;
          case '/api/apps/source/remove': json(200, await applications.removeSource(input.id)); break;
          case '/api/apps/launch': json(200, await applications.launch(input.appId, input.digest, input.surface)); break;
          case '/api/apps/call': json(200, await applications.call(input.instanceId, input.method, input.params)); break;
          case '/api/apps/release': json(200, await applications.release(input.instanceId)); break;
          case '/api/apps/release-many': assert(Array.isArray(input.ids)&&input.ids.length<=256,'APP_CALL_INVALID','应用租约参数无效。'); await Promise.all(input.ids.map(id=>applications.release(id)));json(200,{});break;
          case '/api/apps/heartbeat': assert(Array.isArray(input.ids) && input.ids.length <= 256, 'APP_CALL_INVALID', '应用租约参数无效。'); json(200, await applications.heartbeat(input.ids)); break;
          case '/api/apps/change': json(200, await applications.changeApp(input.appId, input.action, input.force === true)); break;
          default: throw problem('WEB_NOT_FOUND', '应用接口不存在。', 404);
        }
        return true;
      }
      const fileReads = {
        '/api/workspace/tree': () => files.tree(path), '/api/workspace/file': () => files.read(path),
        '/api/workspace/search': () => files.search({ q: query('q'), path }),
      };
      const fileWrites = { '/api/workspace/save': files.save, '/api/workspace/create': files.create, '/api/workspace/move': files.move, '/api/workspace/unlock': files.unlock, '/api/workspace/upload': files.upload };
      if (Object.hasOwn(fileReads, route)) { assert(!write, 'WEB_METHOD_NOT_ALLOWED', '查询接口只支持 GET 或 HEAD。', 405); json(200, await fileReads[route]()); return true; }
      if (Object.hasOwn(fileWrites, route)) { assert(write, 'WEB_METHOD_NOT_ALLOWED', '写接口只支持 POST。', 405); const input = await readJSON(request); assert(typeof input.path === 'string' && input.path.length > 0, 'WORKSPACE_PATH_INVALID', '请选择文件路径。'); const result = await fileWrites[route](input); await git.invalidate(input.path, result.path ?? input.path).catch(()=>{}); json(200, result); return true; }
      if (route === '/api/workspace/media') { assert(!write, 'WEB_METHOD_NOT_ALLOWED', '图片接口只支持读取。', 405); const media = await files.media(path); send(200, media.bytes, media.type, { 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox" }); return true; }
      if (route === '/api/git/repositories') { assert(!write, 'WEB_METHOD_NOT_ALLOWED', '仓库目录只支持读取。', 405); assert([undefined, '1'].includes(query('refresh')), 'INVALID_ARGUMENTS', 'refresh 必须是 1。'); json(200, path ? await git.owner(path) : await git.list({ refresh: query('refresh') === '1' })); return true; }
      const resource = route.match(/^\/api\/git\/repositories\/([a-f0-9]{64})\/(status|diff|history|commit|tree|refs|conflict|stash|settings)$/);
      if (resource) {
        assert(!write, 'WEB_METHOD_NOT_ALLOWED', '仓库查询只支持 GET 或 HEAD。', 405);
        const [, id, method] = resource;
        let data;
        switch (method) {
          case 'status': data = await git.status(id); break;
          case 'diff': assert(['0', '1', undefined].includes(query('staged')), 'INVALID_ARGUMENTS', 'staged 必须是 0 或 1。'); data = await git.diff(id, { path, staged: query('staged') === '1', rev: query('rev'), baseRev: query('baseRev') }); break;
          case 'history': data = await git.history(id, { path, offset: Number(query('offset') ?? 0), rev: query('rev'), q: query('q'), author: query('author') }); break;
          case 'commit': data = await git.commit(id, query('rev')); break;
          case 'tree': data = await git.tree(id, { path, rev: query('rev') }); break;
          case 'refs': data = await git.refs(id); break;
          case 'settings': data = await git.settings(id); break;
          case 'conflict': data = await git.conflict(id, path); break;
          case 'stash': data = await git.stashDetail(id, query('rev')); break;
        }
        json(200, data); return true;
      }
      if (route === '/api/git/operations') { assert(write, 'WEB_METHOD_NOT_ALLOWED', 'Git 动作需要 POST。', 405); json(202, await git.start(await readJSON(request))); return true; }
      const operation = route.match(/^\/api\/git\/operations\/([a-f0-9-]{36})$/);
      if (operation) { assert(!write, 'WEB_METHOD_NOT_ALLOWED', '操作状态只支持读取。', 405); json(200, await git.operation(operation[1])); return true; }
      throw problem('WEB_NOT_FOUND', '接口不存在。', 404);
    } catch (error) {
      // A cancelled streamed download has already sent headers (and may have closed the socket).
      // It cannot be replaced with a JSON error response.
      if (response && (response.headersSent || response.destroyed || response.writableEnded)) {
        if (!response.destroyed && !response.writableEnded) response.destroy();
        return true;
      }
      if(url.pathname==='/api/work-stats'){send(error.code==='INVALID_ARGUMENTS'?400:error.status??500,JSON.stringify({ok:false,error:{code:error.code??'WORK_STATS_READ_FAILED',message:error.code==='INVALID_ARGUMENTS'||error.status===405?error.message:'工作统计暂时无法读取，请重试。'}})+'\n');return true;}
      const status = error.status ?? (error.code === 'INVALID_ARGUMENTS' ? 400 : error.code === 'ENOENT' ? 404 : error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 500);
      send(status, JSON.stringify({ ok: false, error: { code: error.code ?? 'WORKBENCH_FAILED', message: error.status ? error.message : status === 404 ? '文件或目录已不存在。' : status === 403 ? '没有访问此文件的权限。' : '工作台操作失败，请重试并检查本机文件状态。' }, ...(error.data ? { data: error.data } : {}) }) + '\n');
    }
    return true;
  }
  return {start:host.start,resume:host.resume,quiesce:host.quiesce,draining:host.draining,handle, nonce, files, git, applications, ai, codexConversations, communication:communicationReady,publishControl:control.publish, close:()=>host.close() };
}
