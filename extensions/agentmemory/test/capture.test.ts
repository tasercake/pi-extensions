import test from "node:test";
import assert from "node:assert/strict";
import { AgentmemoryError } from "../src/errors.js";
import { CaptureQueue, buildObservePayload, createCaptureItem, findPendingTurns, getText } from "../src/capture.js";

test("text extraction excludes thinking images calls results custom and system",()=>{
 assert.equal(getText("plain"),"plain");
 assert.equal(getText([{type:"text",text:"hello"},{type:"thinking",thinking:"secret"},{type:"image",data:"x"},{type:"toolCall",arguments:{secret:1}}]),"hello");
 assert.equal(getText([{type:"toolResult",content:[{type:"text",text:"no"}]}]),"");
});

test("settled pairing selects final nonempty assistant before each next user",()=>{
 const branch:any[]=[
  {id:"u1",type:"message",message:{role:"user",content:"one"}},
  {id:"a1",type:"message",message:{role:"assistant",content:[{type:"text",text:"draft"}]}},
  {id:"a2",type:"message",message:{role:"assistant",content:[{type:"text",text:"final one"}]}},
  {id:"u2",type:"message",message:{role:"user",content:"two"}},
  {id:"t",type:"message",message:{role:"toolResult",content:"ignore"}},
  {id:"a3",type:"message",message:{role:"assistant",content:"final two"}},
 ];
 assert.deepEqual(findPendingTurns(branch,new Map([["u1","one"],["u2","two"]])),[
  {userEntryId:"u1",assistantEntryId:"a2",prompt:"one",response:"final one"},
  {userEntryId:"u2",assistantEntryId:"a3",prompt:"two",response:"final two"},
 ]);
});

test("deterministic keys deduplicate IDs while distinct IDs remain distinct and bounds apply",()=>{
 const a=createCaptureItem({sessionId:"s",project:"p",cwd:"p",userEntryId:"u",assistantEntryId:"a",prompt:"x".repeat(3000),response:"y".repeat(9000),timestamp:"2026-01-01T00:00:00.000Z"});
 const b=createCaptureItem({...a,prompt:"different",response:"different"}); const c=createCaptureItem({...a,userEntryId:"u2"});
 assert.equal(a.key,b.key); assert.notEqual(a.key,c.key); assert.equal(a.prompt.length,2000); assert.equal(a.response.length,8000);
 assert.deepEqual(buildObservePayload(a),{hookType:"post_tool_use",sessionId:"s",project:"p",cwd:"p",timestamp:"2026-01-01T00:00:00.000Z",data:{tool_name:"conversation",tool_input:{prompt:a.prompt,pi_user_entry_id:"u",pi_assistant_entry_id:"a",pi_capture_key:a.key},tool_output:a.response}});
});

test("queue processes sequentially deduplicates and retries only retryable errors",async()=>{
 let active=0,max=0,calls=0;const delays:number[]=[];let unrefs=0;
 const client={observe:async(_:unknown)=>{active++;max=Math.max(max,active);calls++;await Promise.resolve();active--;if(calls<3)throw new AgentmemoryError("unreachable","x",{endpoint:"x",operation:"o",reason:"x"},{retryable:true});}};
 const timers={setTimeout:(fn:()=>void,ms:number)=>{delays.push(ms);const x=setTimeout(fn,0);return Object.assign(x,{unref(){unrefs++;return x;}})},clearTimeout};
 const q=new CaptureQueue(client as never,{timers,random:()=>0,logger:()=>{}});
 const item=createCaptureItem({sessionId:"s",project:"p",cwd:"p",userEntryId:"u",assistantEntryId:"a",prompt:"q",response:"r",timestamp:"t"});
 assert.equal(q.enqueue(item),true); assert.equal(q.enqueue(item),false); await q.drain(1000);
 assert.equal(calls,3);assert.equal(max,1);assert.deepEqual(delays.slice(0,2),[250,1000]);assert(unrefs>=2);
});

test("permanent failure is diagnostic and overflow drops oldest queued",async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);const seen:string[]=[];const logs:string[]=[];
 const q=new CaptureQueue({observe:async(p:any)=>{seen.push(p.data.tool_input.pi_user_entry_id);if(seen.length===1)await gate;throw new AgentmemoryError("unauthorized","x",{endpoint:"x",operation:"o",reason:"unauthorized"});}} as never,{logger:(x)=>logs.push(x)});
 for(let i=0;i<22;i++)q.enqueue(createCaptureItem({sessionId:"s",project:"p",cwd:"p",userEntryId:`u${i}`,assistantEntryId:`a${i}`,prompt:"private-prompt",response:"private-response",timestamp:"t"}));
 assert(q.diagnostics().dropped>=1);release();await q.drain(1000);assert(q.diagnostics().lastError?.includes("unauthorized"));assert(logs.every(x=>!x.includes("private-prompt")&&!x.includes("private-response")));
});

test("drain processes all queued work before its deadline",async()=>{
 let calls=0;const q=new CaptureQueue({observe:async()=>{calls++;}} as never,{logger:()=>{}});
 for(let i=0;i<5;i++)q.enqueue(createCaptureItem({sessionId:"s",project:"p",cwd:"p",userEntryId:`u${i}`,assistantEntryId:`a${i}`,prompt:"q",response:"r",timestamp:"t"}));
 await q.drain(1000);assert.equal(calls,5);assert.equal(q.diagnostics().queued,0);assert.equal(q.diagnostics().abandoned,0);
});

test("bounded drain aborts owned request records and returns even if abort is ignored",async()=>{
 let aborted=false;const q=new CaptureQueue({observe:(_:unknown,signal:AbortSignal)=>new Promise<void>(()=>signal.addEventListener("abort",()=>{aborted=true;}))} as never,{logger:()=>{}});
 q.enqueue(createCaptureItem({sessionId:"s",project:"p",cwd:"p",userEntryId:"u",assistantEntryId:"a",prompt:"secret",response:"response",timestamp:"t"}));
 const start=Date.now();await q.drain(20);assert(Date.now()-start<500);assert(aborted);assert(q.diagnostics().abandoned>=1);
});
