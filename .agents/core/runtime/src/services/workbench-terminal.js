import {platform,requirePlatformCapability} from '../platform/index.js';
const nativePTY=()=>import('../../native/node-pty/lib/index.js').then(module=>module.default??module);
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {randomUUID} from 'node:crypto';

async function terminalScope(workspace,loadPTY) {
  const pty=await loadPTY();
  const sessions = new Map();let disposed=false;
  const fail = message => { throw new Error(message); };
  const size = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  function get(id) { return sessions.get(id) ?? fail('终端会话已结束，请新建会话。'); }
  function append(session, data) {
    const chunk = { seq: ++session.seq, data }; session.chunks.push(chunk); session.bytes += Buffer.byteLength(data);
    while (session.bytes > 2 * 1024 * 1024 && session.chunks.length > 1) session.bytes -= Buffer.byteLength(session.chunks.shift().data);
    for (const wake of session.waiters) wake(); session.waiters.clear();
  }
  function stop(session) {
    return session.stopping??=(async()=>{
      session.stopRequested=true;
      if(!session.exited)session.terminal.kill();
      for(const wake of session.waiters)wake();
      let timer;
      try { await Promise.race([session.completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('终端进程未能在关闭时限内退出。'),{code:'TERMINAL_STOP_TIMEOUT'})),10000);})]); }
      finally { clearTimeout(timer); }
    })();
  }
  return {
    async call(method, input = {}) {
      if(disposed)fail('终端窗口已关闭。');
      if (method === 'create') {
        if (sessions.size >= 8) fail('每个窗口最多创建 8 个终端会话。');
        if (!size(input.cols, 2, 1000) || !size(input.rows, 1, 500)) fail('终端尺寸无效。');
        const requested=input.cwd??workspace??homedir();
        if(typeof requested!=='string')fail('工作目录无效。');
        const cwd=realpathSync(requested);if(!statSync(cwd).isDirectory())fail('工作目录不是目录。');
        const {shell,args,env}=platform.terminalLaunch();
        const terminal=pty.spawn(shell,args,{name:'xterm-256color',cols:input.cols,rows:input.rows,cwd,env,...(platform.name==='win32'?{useConptyDll:true}:{})});
        const id = String(terminal.pid), session = { terminal, monitorId:randomUUID(),startedAt:new Date().toISOString(),chunks: [], seq: 0, bytes: 0, waiters: new Set(), exited: false, exitCode: null, cwd, shell };
        try{session.processStart=platform.processStart(terminal.pid);}catch{}
        let complete;session.completion=new Promise(resolve=>{complete=resolve;});
        sessions.set(id, session);
        terminal.onData(data => append(session, data));
        terminal.onExit(event => { session.exited = true;session.finishedAt=new Date().toISOString(); session.exitCode = event.exitCode; append(session, '');complete(); });
        return { id, pid: terminal.pid, cwd, shell, cols: input.cols, rows: input.rows };
      }
      if (method === 'list') return [...sessions].map(([id, s]) => ({ id, cwd: s.cwd, shell: s.shell, exited: s.exited }));
      const session = get(input.id);
      if (method === 'read') {
        if (!Number.isSafeInteger(input.after) || input.after < 0) fail('终端输出游标无效。');
        if (session.seq <= input.after && !session.exited) await new Promise(resolve => { const done = () => { clearTimeout(timer); session.waiters.delete(done); resolve(); }, timer = setTimeout(done, 5000); session.waiters.add(done); });
        const earliest = session.chunks[0]?.seq ?? 1;
        return { chunks: session.chunks.filter(c => c.seq > input.after), seq: session.seq, truncated: input.after < earliest - 1, exited: session.exited, exitCode: session.exitCode };
      }
      if (method === 'write') { if (typeof input.data !== 'string' || input.data.length > 65536 || session.exited || session.stopping) fail('终端输入无效或进程已退出。'); session.terminal.write(input.data); return {}; }
      if (method === 'resize') { if (!size(input.cols, 2, 1000) || !size(input.rows, 1, 500)) fail('终端尺寸无效。'); if (!session.exited) session.terminal.resize(input.cols, input.rows); return {}; }
      if (method === 'close') { await stop(session);sessions.delete(input.id);return {}; }
      fail('未知终端操作。');
    },
    monitorSnapshot(){return [...sessions].map(([id,s])=>({id,monitorId:s.monitorId,pid:s.terminal.pid,processStart:s.processStart,cwd:s.cwd,shell:s.shell,startedAt:s.startedAt,finishedAt:s.finishedAt,stopped:s.stopRequested===true,exited:s.exited,exitCode:s.exitCode}));},
    async monitorClose(input){const session=[...sessions.values()].find(s=>s.monitorId===input.monitorId);if(!session||session.exited)throw Object.assign(Error('终端会话已经结束，请刷新。'),{code:'MONITOR_STALE',status:409});await stop(session);return {state:'stopped'};},
    async dispose() { disposed=true;await Promise.all([...sessions.values()].map(stop));sessions.clear(); },
  };
}

/** Workbench owns every PTY. App crashes and window lease expiry also release them. */
export function createWorkbenchTerminal(workspace,{loadPTY=nativePTY}={}) {
  const scopes=new Map(),methods=['create','list','read','write','resize','close'];let disposed=false;
  const key=caller=>caller.runtimeId+':'+caller.instanceId;
  async function release(caller) {await Promise.all([...scopes].filter(([id])=>id.startsWith(caller.runtimeId+':')&&(!caller.instanceId||id===key(caller))).map(async([id,entry])=>{try{await (await entry).dispose();}finally{if(scopes.get(id)===entry)scopes.delete(id);}}));}
  const service=Object.fromEntries(methods.map(method=>[method,async(caller,input={})=>{
    requirePlatformCapability('terminal');
    if(disposed)throw new Error('终端服务已关闭。');
    const id=key(caller);let entry=scopes.get(id);
    if(!entry){if(method!=='create'&&method!=='list')throw new Error('终端会话已结束，请新建会话。');entry=terminalScope(workspace,loadPTY);entry.caller={...caller};scopes.set(id,entry);entry.catch(()=>{if(scopes.get(id)===entry)scopes.delete(id);});}
    return (await entry).call(method,input);
  }]));
  return {...service,release,async monitorSnapshot(){return (await Promise.all([...scopes.values()].map(async entry=>(await entry).monitorSnapshot().map(row=>({...row,appId:entry.caller.appId,runtimeId:entry.caller.runtimeId}))))).flat();},async monitorClose(input){for(const entry of scopes.values())if((await entry).monitorSnapshot().some(row=>row.monitorId===input.monitorId))return (await entry).monitorClose(input);throw Object.assign(Error('终端会话已不存在。'),{code:'MONITOR_STALE',status:409});},async dispose(){disposed=true;await Promise.all([...scopes.values()].map(async entry=>(await entry).dispose()));scopes.clear();}};
}
