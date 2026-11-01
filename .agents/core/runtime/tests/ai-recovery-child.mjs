import { createWorkbenchAI } from '../src/services/ai-tasks.js';
const ai=createWorkbenchAI(process.argv[2]);
await ai.config('connections',{revision:0,items:[{id:'codex',kind:'codex',enabled:true,executablePath:process.argv[3],concurrency:1}]});
await ai.config('profiles',{revision:0,items:[{id:'text',executorId:'codex',enabled:true,timeoutMs:20000,maxAttempts:1,retryDelayMs:0,maxInputBytes:65536,maxOutputBytes:4096}]});
const task=await ai.submit({appId:'example.crash'},{contractVersion:'ai-task-v1',idempotencyKey:'crash-fixture',profileId:'text',instruction:'synthetic',inputs:[],outputSpec:{format:'text'}});
process.send({aiTaskId:task.aiTaskId});
// A PID only proves spawn, before the Windows wrapper has started the CLI.
// Crash after its protocol identity is durably recorded, not during startup.
const timer=setInterval(async()=>{const current=await ai.get({appId:'example.crash'},task.aiTaskId);if(current.execution.attempts[0]?.nativeSessionId==='crash-fixture'){clearInterval(timer);process.send({running:true});}},10);
