import { appendFile, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireStartupLock } from "../../src/daemon.js";

const [stateDir,mode="normal",timeoutRaw="5000"]=process.argv.slice(2);
if(!stateDir) throw new Error("state dir required");
const timeout=Number(timeoutRaw), ready=join(stateDir,"ready"), spawns=join(stateDir,"spawns");
const config={stateDir,baseUrl:"http://localhost:3111"};
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const effects={now:Date.now,random:Math.random,sleep,pidAlive:(pid:number)=>{try{process.kill(pid,0);return true}catch(e){return (e as NodeJS.ErrnoException).code!=="ESRCH"}}};
const isReady=()=>access(ready).then(()=>true,()=>false);

if(mode==="waiter") {
 try { const lock=await acquireStartupLock(config,effects,Date.now()+timeout); await lock.release(); process.stdout.write("unexpected\n"); }
 catch { process.stdout.write("busy\n"); }
 process.exit(0);
}
const lock=await acquireStartupLock(config,effects,Date.now()+timeout);
if(mode==="crash-after-lock") process.exit(7);
if(await isReady()) { await lock.release(); process.stdout.write("reuse\n"); process.exit(0); }
await appendFile(spawns,`${process.pid}\n`,{mode:0o600});
if(mode==="slow-winner") await sleep(800);
await writeFile(ready,"ok",{mode:0o600});
await lock.release();
process.stdout.write("healthy\n");
