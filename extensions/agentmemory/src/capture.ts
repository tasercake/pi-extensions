import { createHash } from "node:crypto";
import { CAPTURE_ATTEMPTS, CAPTURE_RETRY_DELAYS_MS, MAX_CAPTURE_PROMPT_CHARS, MAX_CAPTURE_QUEUE, MAX_CAPTURE_RESPONSE_CHARS } from "./config.js";
import type { AgentmemoryClient } from "./client.js";
import { AgentmemoryError, formatDiagnostic } from "./errors.js";

export interface CaptureItem { sessionId:string; project:string; cwd:string; userEntryId:string; assistantEntryId:string; prompt:string; response:string; attempts:number; key:string; timestamp:string }
export interface PendingTurn { userEntryId:string; assistantEntryId:string; prompt:string; response:string }
interface Entry { id?:unknown; type?:unknown; message?: {role?:unknown;content?:unknown} }

export function getText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is {type:"text";text:string} => !!block && typeof block === "object" && (block as {type?:unknown}).type === "text" && typeof (block as {text?:unknown}).text === "string").map((block)=>block.text).join("\n");
}

export function findPendingTurns(branch: Entry[], pendingUserEntries: ReadonlyMap<string,string>): PendingTurn[] {
  const turns: PendingTurn[]=[];
  for(let i=0;i<branch.length;i++){
    const entry=branch[i]; if(entry?.type!=="message"||typeof entry.id!=="string"||entry.message?.role!=="user"||!pendingUserEntries.has(entry.id))continue;
    let assistantId:string|undefined,response="";
    for(let j=i+1;j<branch.length;j++){
      const next=branch[j]; if(next?.type!=="message")continue;
      if(next.message?.role==="user")break;
      if(next.message?.role==="assistant"&&typeof next.id==="string") { const text=getText(next.message.content).trim(); if(text){assistantId=next.id;response=text;} }
    }
    if(assistantId)turns.push({userEntryId:entry.id,assistantEntryId:assistantId,prompt:pendingUserEntries.get(entry.id)!,response});
  }
  return turns;
}

export function createCaptureItem(input: Omit<CaptureItem,"key"|"attempts"|"prompt"|"response"> & {prompt:string;response:string;attempts?:number;key?:string}):CaptureItem{
  const key=createHash("sha256").update(`${input.sessionId}\0${input.userEntryId}\0${input.assistantEntryId}`).digest("hex");
  return {...input,prompt:input.prompt.slice(0,MAX_CAPTURE_PROMPT_CHARS),response:input.response.slice(0,MAX_CAPTURE_RESPONSE_CHARS),attempts:input.attempts??0,key};
}

export function buildObservePayload(item:CaptureItem){return {hookType:"post_tool_use",sessionId:item.sessionId,project:item.project,cwd:item.cwd,timestamp:item.timestamp,data:{tool_name:"conversation",tool_input:{prompt:item.prompt,pi_user_entry_id:item.userEntryId,pi_assistant_entry_id:item.assistantEntryId,pi_capture_key:item.key},tool_output:item.response}};}

type TimerHandle=ReturnType<typeof setTimeout>;
interface Timers {setTimeout:(callback:()=>void,ms:number)=>TimerHandle;clearTimeout:(timer:TimerHandle)=>void}
interface QueueOptions {timers?:Timers;random?:()=>number;logger?:(diagnostic:string)=>void}

export class CaptureQueue {
  private readonly queue:CaptureItem[]=[]; private readonly known=new Set<string>(); private processing?:Promise<void>; private controller?:AbortController;
  private readonly timers:Timers; private readonly random:()=>number; private readonly logger:(diagnostic:string)=>void;
  private readonly waiting=new Map<TimerHandle,()=>void>(); private dropped=0; private abandoned=0; private lastError?:string; private inFlight?:CaptureItem; private draining=false;
  constructor(private readonly client:Pick<AgentmemoryClient,"observe">,options:QueueOptions={}){this.timers=options.timers??{setTimeout,clearTimeout};this.random=options.random??Math.random;this.logger=options.logger??(()=>{});}
  enqueue(item:CaptureItem):boolean{
    if(this.draining||this.known.has(item.key))return false;
    while(this.queue.length+(this.inFlight?1:0)>=MAX_CAPTURE_QUEUE){const old=this.queue.shift();if(!old)break;this.known.delete(old.key);this.dropped++;this.logger(`agentmemory capture queue overflow: dropped=${this.dropped} queued=${this.queue.length}`);}
    this.known.add(item.key);this.queue.push(item);if(!this.processing)this.processing=this.run().finally(()=>{this.processing=undefined;});return true;
  }
  private async run():Promise<void>{
    while(this.queue.length){const item=this.queue.shift()!;this.inFlight=item;this.controller=new AbortController();
      try{await this.send(item);}catch(error){if(!this.controller.signal.aborted){this.lastError=this.safeError(error);this.logger(`agentmemory capture failed: ${this.lastError}`);}}
      finally{this.known.delete(item.key);this.inFlight=undefined;this.controller=undefined;}
    }
  }
  private async send(item:CaptureItem):Promise<void>{
    while(item.attempts<CAPTURE_ATTEMPTS){item.attempts++;
      try{await this.client.observe(buildObservePayload(item),this.controller!.signal);return;}
      catch(error){const retryable=error instanceof AgentmemoryError&&error.retryable;if(!retryable||item.attempts>=CAPTURE_ATTEMPTS)throw error;const base=CAPTURE_RETRY_DELAYS_MS[item.attempts-1]!;await this.delay(base+Math.floor(this.random()*101));if(this.controller!.signal.aborted)throw error;}
    }
  }
  private delay(ms:number):Promise<void>{return new Promise((resolveDelay)=>{let handle:TimerHandle;const done=()=>{this.waiting.delete(handle);resolveDelay();};handle=this.timers.setTimeout(done,ms);(handle as {unref?:()=>unknown}).unref?.();this.waiting.set(handle,done);});}
  async drain(timeoutMs:number):Promise<void>{
    this.draining=true;if(!this.processing&&!this.queue.length)return;
    let timeout!:TimerHandle;let expired=false;
    // Keep the drain deadline referenced: it is the guarantee that shutdown itself completes.
    const deadline=new Promise<void>((resolveDeadline)=>{timeout=globalThis.setTimeout(()=>{expired=true;resolveDeadline();},timeoutMs);});
    await Promise.race([this.processing??Promise.resolve(),deadline]);
    globalThis.clearTimeout(timeout);
    if(expired){this.abandoned+=this.queue.length+(this.inFlight?1:0);this.queue.length=0;this.controller?.abort();for(const [timer,resolveDelay]of this.waiting){this.timers.clearTimeout(timer);resolveDelay();}this.waiting.clear();this.lastError=`capture drain abandoned=${this.abandoned}`;this.logger(`agentmemory capture drain: abandoned=${this.abandoned}`);}
  }
  diagnostics(){return {queued:this.queue.length,inFlight:this.inFlight?1:0,dropped:this.dropped,abandoned:this.abandoned,...(this.lastError?{lastError:this.lastError}:{})};}
  private safeError(error:unknown):string{return error instanceof AgentmemoryError?formatDiagnostic(error).slice(0,500):"capture request failed";}
}
