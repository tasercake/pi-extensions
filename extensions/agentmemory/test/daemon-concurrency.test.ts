import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const worker=resolve(dirname(fileURLToPath(import.meta.url)),"fixtures/lock-worker.ts");

async function run(state:string,mode="normal",timeout=5000){ return new Promise<{code:number|null,out:string}>((resolveRun,reject)=>{const child=spawn(process.execPath,["--import","tsx",worker,state,mode,String(timeout)],{stdio:["ignore","pipe","pipe"]}); let out="",err=""; const hard=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("fixture timeout"));},timeout+3000); child.stdout.on("data",c=>out+=c); child.stderr.on("data",c=>err+=c); child.on("exit",code=>{clearTimeout(hard);if(code!==0&&mode!=="crash-after-lock")reject(new Error(err||`exit ${code}`));else resolveRun({code,out});});}); }
const tempStates=new Set<string>();
after(async()=>{await Promise.all([...tempStates].map((state)=>rm(state,{recursive:true,force:true})));});
async function setup(){const state=await mkdtemp(join(tmpdir(),"am-lock-"));tempStates.add(state);await mkdir(state,{recursive:true});return state;}
async function markerCount(state:string){return (await readFile(join(state,"spawns"),"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).length;}

test("eight independent cold starters produce exactly one spawn",async()=>{const state=await setup();const results=await Promise.all(Array.from({length:8},()=>run(state)));assert.equal(await markerCount(state),1);assert(results.every(x=>/healthy|reuse/.test(x.out)));});

test("valid live lock is polled and never stolen",async()=>{const state=await setup();const lock=join(state,"startup.lock");await mkdir(lock);await writeFile(join(lock,"owner.json"),JSON.stringify({schemaVersion:1,pid:process.pid,token:"live",baseUrl:"http://localhost:3111",acquiredAt:Date.now()}));const result=await run(state,"waiter",500);assert.match(result.out,/busy/);assert.equal(await markerCount(state),0);});

test("malformed dead and stale owners recover to one winner",async()=>{for(const owner of ["{",JSON.stringify({schemaVersion:1,pid:99999999,token:"dead",baseUrl:"http://localhost:3111",acquiredAt:Date.now()}),JSON.stringify({schemaVersion:1,pid:process.pid,token:"stale",baseUrl:"http://localhost:3111",acquiredAt:0})]){const state=await setup();const lock=join(state,"startup.lock");await mkdir(lock);await writeFile(join(lock,"owner.json"),owner);const results=await Promise.all(Array.from({length:4},()=>run(state)));assert.equal(await markerCount(state),1);assert(results.every(x=>/healthy|reuse/.test(x.out)));}});

test("stale recovery claim is reclaimed without duplicate winners",async()=>{const state=await setup();const recovery=join(state,"startup.recovery");await mkdir(recovery);await utimes(recovery,new Date(0),new Date(0));const results=await Promise.all(Array.from({length:4},()=>run(state)));assert.equal(await markerCount(state),1);assert(results.every(x=>/healthy|reuse/.test(x.out)));});

test("winner crash is recovered by exactly one waiter",async()=>{const state=await setup();await run(state,"crash-after-lock");const results=await Promise.all(Array.from({length:4},()=>run(state)));assert.equal(await markerCount(state),1);assert(results.every(x=>/healthy|reuse/.test(x.out)));});

test("winner below stale threshold is not stolen",async()=>{const state=await setup();const winner=run(state,"slow-winner");await new Promise(r=>setTimeout(r,100));const waiters=Promise.all(Array.from({length:3},()=>run(state)));const results=await waiters;await winner;assert.equal(await markerCount(state),1);assert(results.every(x=>/healthy|reuse/.test(x.out)));});
