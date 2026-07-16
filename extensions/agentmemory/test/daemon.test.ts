import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonManager, resolveAgentmemoryCli } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { AgentmemoryError } from "../src/errors.js";
import type { ProbeResult } from "../src/client.js";

const tempStates=new Set<string>();
after(async()=>{await Promise.all([...tempStates].map((state)=>rm(state,{recursive:true,force:true})));});
const temporary=async(prefix:string)=>{const path=await mkdtemp(join(tmpdir(),prefix));tempStates.add(path);return path;};
const configAt = (home: string, extra: Record<string,string | undefined> = {}) => { const x = loadConfig(extra, home); assert(x.ok); return x.config; };
const probeError = (kind: "unreachable"|"unauthorized"|"foreign", code = kind === "foreign" ? "foreign_service" : kind): ProbeResult => ({ kind, error: new AgentmemoryError(code as never, kind, { endpoint:"http://localhost:3111", operation:"probe", reason:kind }) } as never);

test("healthy and recognized failures never touch filesystem or spawn", async () => {
  for (const result of [{ kind:"healthy", version:"0.9.27" }, probeError("unauthorized"), { kind:"unhealthy", status:"degraded", error:new AgentmemoryError("unhealthy","u",{endpoint:"x",operation:"p",reason:"u"}) }, probeError("foreign")] as ProbeResult[]) {
    let effects = 0;
    const manager = new DaemonManager(configAt("/never"), { probe: async () => result } as never, { prepareState: async () => { effects++; }, spawn: (() => { effects++; }) as never });
    if (result.kind === "healthy") assert.equal((await manager.ensureAvailable()).kind, "healthy"); else await assert.rejects(() => manager.ensureAvailable(), AgentmemoryError);
    assert.equal(effects, 0);
  }
});

test("caller abort never starts filesystem or spawn effects",async()=>{const controller=new AbortController();controller.abort();let effects=0;const aborted=new AgentmemoryError("aborted","aborted",{endpoint:"http://localhost:3111",operation:"liveness",reason:"aborted"});const manager=new DaemonManager(configAt("/h"),{probe:async()=>({kind:"unreachable",error:aborted})} as never,{prepareState:async()=>{effects++},spawn:(()=>{effects++}) as never});await assert.rejects(()=>manager.ensureAvailable(controller.signal),(error:any)=>error.code==="aborted");assert.equal(effects,0);});

test("abort while waiting on a live lock reports the configured endpoint",async()=>{const home=await temporary("am-abort-lock-");const config=configAt(home);await mkdir(join(config.stateDir,"startup.lock"),{recursive:true,mode:0o700});await writeFile(join(config.stateDir,"startup.lock","owner.json"),JSON.stringify({schemaVersion:1,pid:process.pid,token:"live",baseUrl:config.baseUrl,acquiredAt:Date.now()}));const manager=new DaemonManager(config,{probe:async()=>probeError("unreachable")} as never);const controller=new AbortController();setTimeout(()=>controller.abort(),10);await assert.rejects(()=>manager.ensureAvailable(controller.signal),(error:any)=>error.code==="aborted"&&error.message.includes(config.baseUrl));});

test("remote disabled and local autostart disabled never spawn", async () => {
  for (const env of [{ AGENTMEMORY_URL:"https://example.test" }, { PI_AGENTMEMORY_AUTOSTART:"0" }]) {
    let spawned = false;
    const manager = new DaemonManager(configAt("/h", env), { probe: async () => probeError("unreachable") } as never, { spawn: (() => { spawned=true; }) as never });
    await assert.rejects(() => manager.ensureAvailable()); assert.equal(spawned, false);
  }
});

test("cold start probes locks reprobes spawns once and becomes managed", async () => {
  const home = await temporary("am-daemon-"); const config = configAt(home, { AGENTMEMORY_SECRET:"secret" });
  const calls:string[]=[]; let count=0; let spawnOptions:any;
  const manager = new DaemonManager(config, { probe: async () => { calls.push("probe"); return count++ >= 2 ? {kind:"healthy",version:"0.9.27"} : probeError("unreachable"); } } as never, {
    resolveRuntime: async () => "/safe/cli.mjs", launcherPath:"/safe/daemon-launcher.mjs",
    spawn: ((exe:string,args:string[],opts:any) => { calls.push("spawn"); spawnOptions={exe,args,opts}; return {pid:123,unref(){calls.push("unref");}}; }) as never,
    pidAlive: () => true, sleep: async () => {},
  });
  const out=await manager.ensureAvailable(); assert.equal(out.kind,"healthy");
  assert.deepEqual(calls.slice(0,4),["probe","probe","spawn","unref"]);
  assert.equal(spawnOptions.exe,process.execPath); assert.deepEqual(spawnOptions.args,["/safe/daemon-launcher.mjs"]); assert.equal(spawnOptions.opts.detached,true); assert.equal(spawnOptions.opts.stdio,"ignore");
  assert(!spawnOptions.args.join(" ").includes("secret"));
  const metadata=await readFile(join(config.stateDir,"runtime.json"),"utf8"); assert(!metadata.includes("secret"));
  assert.equal((await manager.diagnostics()).managed,true);
});

test("live runtime waits, dead runtime recovers, and deadline never kills", async () => {
  const home=await temporary("am-runtime-"); const config=configAt(home); await mkdir(config.stateDir,{recursive:true,mode:0o700});
  await writeFile(join(config.stateDir,"runtime.json"),JSON.stringify({schemaVersion:1,token:"a",launcherPid:44,baseUrl:config.baseUrl,startedAt:1,packageVersion:"0.9.27"}));
  let spawned=0, killed=0, now=0, probes=0;
  const manager=new DaemonManager(config,{probe:async()=>probes++>1?{kind:"healthy"}:probeError("unreachable")} as never,{pidAlive:()=>true,sleep:async(ms:number)=>{now+=ms},now:()=>now,startupTimeoutMs:1000,spawn:(()=>{spawned++;return {pid:1,unref(){}}}) as never,kill:()=>{killed++}} as never);
  assert.equal((await manager.ensureAvailable()).kind,"healthy"); assert.equal(spawned,0); assert.equal(killed,0);

  probes=0; now=0;
  const busy=new DaemonManager(config,{probe:async()=>probeError("unreachable")} as never,{pidAlive:()=>true,sleep:async(ms:number)=>{now+=ms},now:()=>now,startupTimeoutMs:500,spawn:(()=>{spawned++;}) as never});
  await assert.rejects(()=>busy.ensureAvailable(),(e:any)=>e.code==="startup_busy"&&e.message.includes(config.logPath)); assert.equal(spawned,0);
});

test("malformed runtime metadata suppresses duplicate startup",async()=>{const home=await temporary("am-invalid-runtime-");const config=configAt(home);await mkdir(config.stateDir,{recursive:true,mode:0o700});await writeFile(join(config.stateDir,"runtime.json"),"{not-json");let spawned=0;const manager=new DaemonManager(config,{probe:async()=>probeError("unreachable")} as never,{spawn:(()=>{spawned++;return {pid:1,unref(){}}}) as never});await assert.rejects(()=>manager.ensureAvailable(),(error:any)=>error.code==="startup_busy");assert.equal(spawned,0);});

test("same-process ensure deduplicates and clears rejected promise", async () => {
  const home=await temporary("am-dedupe-"); let resolve!:()=>void; let probes=0;
  const gate=new Promise<void>((r)=>resolve=r); const manager=new DaemonManager(configAt(home),{probe:async()=>{probes++; await gate; return {kind:"healthy"};}} as never);
  const a=manager.ensureAvailable(), b=manager.ensureAvailable(); resolve(); await Promise.all([a,b]); assert.equal(probes,1);
  let fail=true; const retry=new DaemonManager(configAt(home),{probe:async()=>fail?(fail=false,probeError("unauthorized")):{kind:"healthy"}} as never);
  await assert.rejects(()=>retry.ensureAvailable()); assert.equal((await retry.ensureAvailable()).kind,"healthy");
});

test("runtime resolution failures are rebound to the configured endpoint",async()=>{const home=await temporary("am-resolve-error-");const config=configAt(home);const manager=new DaemonManager(config,{probe:async()=>probeError("unreachable")} as never,{resolveRuntime:async()=>{throw new AgentmemoryError("startup_failed","package missing",{endpoint:"package",operation:"resolve",reason:"package missing"})}});await assert.rejects(()=>manager.ensureAvailable(),(error:any)=>error.code==="startup_failed"&&error.message.includes(config.baseUrl)&&!error.message.includes("package missing"));});

test("package resolution enforces name version bin containment and regular non-symlink file", async () => {
  const root=await temporary("am-pkg-"); await mkdir(join(root,"dist")); await writeFile(join(root,"dist/cli.mjs"),"// ok");
  assert.equal(await resolveAgentmemoryCli(join(root,"package.json"), {name:"@agentmemory/agentmemory",version:"0.9.27",bin:{agentmemory:"dist/cli.mjs"}}),join(root,"dist/cli.mjs"));
  for (const pkg of [{name:"wrong",version:"0.9.27",bin:"dist/cli.mjs"},{name:"@agentmemory/agentmemory",version:"1",bin:"dist/cli.mjs"},{name:"@agentmemory/agentmemory",version:"0.9.27",bin:"../cli.mjs"}]) await assert.rejects(()=>resolveAgentmemoryCli(join(root,"package.json"),pkg));
  await symlink(join(root,"dist/cli.mjs"),join(root,"link.mjs")); await assert.rejects(()=>resolveAgentmemoryCli(join(root,"package.json"),{name:"@agentmemory/agentmemory",version:"0.9.27",bin:"link.mjs"}));
});

test("state directory symlinks and malformed oversized metadata fail safely", async () => {
  const home=await temporary("am-state-"); const config=configAt(home); await mkdir(join(home,"target")); await mkdir(join(home,".agentmemory"));
  await symlink(join(home,"target"),join(home,".agentmemory","pi-extension"));
  const manager=new DaemonManager(config,{probe:async()=>probeError("unreachable")} as never,{resolveRuntime:async()=>"/x",spawn:(()=>({pid:1,unref(){}})) as never});
  await assert.rejects(()=>manager.ensureAvailable(),(error:any)=>error instanceof AgentmemoryError&&error.code==="startup_failed"&&!error.message.includes("target"));
});
