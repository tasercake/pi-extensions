import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentmemoryConfig } from "./config.js";
import { LOCK_STALE_MS, STARTUP_POLL_MS, STARTUP_TIMEOUT_MS } from "./config.js";
import type { AgentmemoryClient, HealthyProbe, ProbeResult } from "./client.js";
import { AgentmemoryError } from "./errors.js";

export interface DaemonDiagnostics { managed: boolean; launcherPid?: number; childPid?: number; startedAt?: number; logPath: string; lastError?: string }
interface RuntimeRecord { schemaVersion: 1; token: string; launcherPid: number; childPid?: number; baseUrl: string; startedAt: number; packageVersion: "0.9.27" }
interface OwnerRecord { schemaVersion: 1; pid: number; token: string; baseUrl: string; acquiredAt: number }
interface Spawned { pid?: number; unref(): void }

export interface DaemonEffects {
  now: () => number;
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  pidAlive: (pid: number) => boolean;
  spawn: (executable: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => Spawned;
  resolveRuntime: () => Promise<string>;
  launcherPath: string;
  prepareState?: (stateDir: string) => Promise<void>;
  startupTimeoutMs: number;
}

const plainObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const validPid = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;
const token = () => randomBytes(16).toString("hex");
const safeReason = (kind: string) => kind.replace(/[^a-z_]/gi, "").slice(0, 40) || "failure";

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "EPERM" || code !== "ESRCH"; }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolveSleep) => {
    const done=()=>{signal?.removeEventListener("abort",abort);resolveSleep();};
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); done(); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function defaultResolveRuntime(): Promise<string> {
  let packageUrl: string;
  try { packageUrl = import.meta.resolve("@agentmemory/agentmemory/package.json"); }
  catch (cause) { throw new AgentmemoryError("startup_failed", "Unable to resolve the pinned Agentmemory package", { endpoint: "package", operation: "startup package resolution", reason: "package missing" }, { cause }); }
  const packagePath = fileURLToPath(packageUrl);
  let value: unknown;
  try { value = JSON.parse(await readFile(packagePath, "utf8")); } catch (cause) { throw new AgentmemoryError("startup_failed", "Unable to read the pinned Agentmemory package", { endpoint: packagePath, operation: "startup package resolution", reason: "invalid package metadata" }, { cause }); }
  return resolveAgentmemoryCli(packagePath, value);
}

const defaults: DaemonEffects = {
  now: Date.now,
  random: Math.random,
  sleep: defaultSleep,
  pidAlive: defaultPidAlive,
  spawn: (exe, args, options) => nodeSpawn(exe, args, options) as ChildProcess,
  resolveRuntime: defaultResolveRuntime,
  launcherPath: fileURLToPath(new URL("./daemon-launcher.mjs", import.meta.url)),
  startupTimeoutMs: STARTUP_TIMEOUT_MS,
};

export async function resolveAgentmemoryCli(packagePath: string, value: unknown): Promise<string> {
  if (!plainObject(value) || value.name !== "@agentmemory/agentmemory" || value.version !== "0.9.27") throw new AgentmemoryError("startup_failed", "Resolved Agentmemory package does not match required version 0.9.27", { endpoint: packagePath, operation: "startup package resolution", reason: "wrong package name or version" });
  let bin: unknown = value.bin;
  if (plainObject(bin)) bin = bin.agentmemory;
  if (typeof bin !== "string" || !bin) throw new AgentmemoryError("startup_failed", "Agentmemory package has no agentmemory CLI", { endpoint: packagePath, operation: "startup package resolution", reason: "missing bin" });
  const root = dirname(packagePath); const cli = resolve(root, bin); const rel = relative(root, cli);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new AgentmemoryError("startup_failed", "Agentmemory CLI escapes package root", { endpoint: packagePath, operation: "startup package resolution", reason: "bin traversal" });
  let info;
  try { info = await lstat(cli); } catch (cause) { throw new AgentmemoryError("startup_failed", "Agentmemory CLI is missing", { endpoint: packagePath, operation: "startup package resolution", reason: "missing bin file" }, { cause }); }
  if (info.isSymbolicLink() || !info.isFile()) throw new AgentmemoryError("startup_failed", "Agentmemory CLI must be a regular package file", { endpoint: packagePath, operation: "startup package resolution", reason: "unsafe bin file" });
  return cli;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe Agentmemory state directory: ${path}`);
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function prepareState(stateDir: string): Promise<void> {
  const extensionRoot = dirname(stateDir);
  await ensurePrivateDirectory(extensionRoot);
  await ensurePrivateDirectory(stateDir);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${token()}`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

async function boundedJson(path: string): Promise<unknown | undefined> {
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) return undefined;
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}

function parseRuntime(value: unknown, baseUrl: string): RuntimeRecord | undefined {
  if (!plainObject(value) || value.schemaVersion !== 1 || typeof value.token !== "string" || !validPid(value.launcherPid) || value.baseUrl !== baseUrl || typeof value.startedAt !== "number" || value.packageVersion !== "0.9.27" || (value.childPid !== undefined && !validPid(value.childPid))) return undefined;
  return value as unknown as RuntimeRecord;
}
function parseOwner(value: unknown, baseUrl: string): OwnerRecord | undefined {
  if (!plainObject(value) || value.schemaVersion !== 1 || !validPid(value.pid) || typeof value.token !== "string" || value.baseUrl !== baseUrl || typeof value.acquiredAt !== "number") return undefined;
  return value as unknown as OwnerRecord;
}
async function readRuntimeState(path:string,baseUrl:string):Promise<{kind:"missing"}|{kind:"invalid"}|{kind:"valid";record:RuntimeRecord}>{
  let info;try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {kind:"missing"};throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024)return {kind:"invalid"};
  const record=parseRuntime(await boundedJson(path),baseUrl);return record?{kind:"valid",record}:{kind:"invalid"};
}

export interface StartupLock { token: string; release(): Promise<void> }
export async function acquireStartupLock(config: Pick<AgentmemoryConfig, "stateDir"|"baseUrl">, effects: Pick<DaemonEffects,"now"|"random"|"sleep"|"pidAlive">, deadline: number, signal?: AbortSignal): Promise<StartupLock> {
  const lockPath = join(config.stateDir, "startup.lock"); const ownerPath = join(lockPath, "owner.json");const recoveryPath=join(config.stateDir,"startup.recovery");
  const exists=async(path:string)=>!!(await lstat(path).catch(()=>undefined));
  while (effects.now() < deadline) {
    if (signal?.aborted) throw new AgentmemoryError("aborted", `Agentmemory startup aborted for ${config.baseUrl}`, { endpoint: config.baseUrl, operation: "startup lock", reason: "aborted" });
    if(await exists(recoveryPath)){const info=await lstat(recoveryPath).catch(()=>undefined);if(info&&effects.now()-info.mtimeMs>=LOCK_STALE_MS){const staleRecovery=`${recoveryPath}.stale-${process.pid}-${token()}`;try{await rename(recoveryPath,staleRecovery);await rm(staleRecovery,{recursive:true,force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}continue;}await effects.sleep(STARTUP_POLL_MS+Math.floor(effects.random()*101),signal);continue;}
    const mine = token();
    try {
      await mkdir(lockPath, { mode: 0o700 });
      // A stale-recovery claimant may have appeared after our precheck. Back off before publishing ownership.
      if(await exists(recoveryPath)){await rm(lockPath,{recursive:true,force:true});await effects.sleep(STARTUP_POLL_MS,signal);continue;}
      const owner: OwnerRecord = { schemaVersion: 1, pid: process.pid, token: mine, baseUrl: config.baseUrl, acquiredAt: effects.now() };
      await atomicWrite(ownerPath, owner);
      return { token: mine, release: async () => {
        const current = parseOwner(await boundedJson(ownerPath), config.baseUrl);
        if (current?.token === mine) await rm(lockPath, { recursive: true, force: true });
      } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raw = await boundedJson(ownerPath); const owner = parseOwner(raw, config.baseUrl);
      let stale = !!raw && !owner;
      if (!raw) {
        // Avoid stealing the mkdir-to-atomic-owner-write gap. A live writer's temp filename carries its PID.
        const names: string[] = await readdir(lockPath).catch((): string[] => []);
        const writerPids = names.map((name) => /^owner\.json\.tmp-(\d+)-/.exec(name)?.[1]).filter((pid): pid is string => !!pid).map(Number);
        const liveWriter = writerPids.some((pid) => validPid(pid) && effects.pidAlive(pid));
        const ownerAppeared = names.includes("owner.json");
        if (ownerAppeared) {
          const appearedOwner = parseOwner(await boundedJson(ownerPath), config.baseUrl);
          stale = !appearedOwner || !effects.pidAlive(appearedOwner.pid) || effects.now() - appearedOwner.acquiredAt >= LOCK_STALE_MS;
        } else {
          const lockInfo = await stat(lockPath).catch(() => undefined);
          stale = !liveWriter && !!lockInfo && effects.now() - lockInfo.mtimeMs >= STARTUP_POLL_MS;
        }
      }
      if (owner) stale = !effects.pidAlive(owner.pid) || effects.now() - owner.acquiredAt >= LOCK_STALE_MS;
      if (stale) {
        try{await mkdir(recoveryPath,{mode:0o700});}
        catch(recoveryError){if((recoveryError as NodeJS.ErrnoException).code!=="EEXIST")throw recoveryError;await effects.sleep(STARTUP_POLL_MS,signal);continue;}
        try{
          // Revalidate only after exclusively claiming recovery; normal acquirers check this claim twice.
          const currentRaw=await boundedJson(ownerPath);const currentOwner=parseOwner(currentRaw,config.baseUrl);let stillStale=!!currentRaw&&!currentOwner;
          if(!currentRaw){const names:string[]=await readdir(lockPath).catch(():string[]=>[]);const liveWriter=names.map((name)=>/^owner\.json\.tmp-(\d+)-/.exec(name)?.[1]).filter((pid):pid is string=>!!pid).map(Number).some((pid)=>validPid(pid)&&effects.pidAlive(pid));if(names.includes("owner.json"))stillStale=!parseOwner(await boundedJson(ownerPath),config.baseUrl);else{const info=await stat(lockPath).catch(()=>undefined);stillStale=!liveWriter&&!!info&&effects.now()-info.mtimeMs>=STARTUP_POLL_MS;}}
          if(currentOwner)stillStale=!effects.pidAlive(currentOwner.pid)||effects.now()-currentOwner.acquiredAt>=LOCK_STALE_MS;
          if(stillStale){const tombstone=`${lockPath}.stale-${process.pid}-${token()}`;try{await rename(lockPath,tombstone);await rm(tombstone,{recursive:true,force:true});}catch(renameError){if(!["ENOENT","EEXIST"].includes((renameError as NodeJS.ErrnoException).code??""))throw renameError;}}
        }finally{await rm(recoveryPath,{recursive:true,force:true});}
        continue;
      }
      await effects.sleep(STARTUP_POLL_MS + Math.floor(effects.random() * 101), signal);
    }
  }
  throw new AgentmemoryError("startup_busy", `Agentmemory startup is busy for ${config.baseUrl}`, { endpoint: config.baseUrl, operation: "startup lock", reason: "startup deadline exceeded" });
}

export class DaemonManager {
  private ensurePromise?: Promise<HealthyProbe>;
  private readonly effects: DaemonEffects;
  private lastError?: string;
  constructor(readonly config: AgentmemoryConfig, private readonly client: Pick<AgentmemoryClient,"probe">, effects: Partial<DaemonEffects> = {}) { this.effects = { ...defaults, ...effects }; }
  probe(signal?: AbortSignal): Promise<ProbeResult> { return this.client.probe(signal); }
  ensureAvailable(signal?: AbortSignal): Promise<HealthyProbe> {
    if (this.ensurePromise) return this.ensurePromise;
    const promise = this.ensure(signal).catch((error:unknown)=>{if(error instanceof AgentmemoryError)throw error;throw this.startupError("managed startup operation failed");}); this.ensurePromise = promise;
    void promise.finally(() => { if (this.ensurePromise === promise) this.ensurePromise = undefined; }).catch(() => {});
    return promise;
  }

  private async ensure(signal?: AbortSignal): Promise<HealthyProbe> {
    const deadline = this.effects.now() + this.effects.startupTimeoutMs;
    const first = await this.client.probe(signal);
    if (first.kind === "healthy") return first;
    if (first.kind === "unreachable" && first.error.code === "aborted") throw first.error;
    this.rejectRecognized(first);
    if (!this.config.canAutostart) throw first.error;
    if (signal?.aborted) throw first.error;
    await (this.effects.prepareState ?? prepareState)(this.config.stateDir);

    const runtimeState = await readRuntimeState(join(this.config.stateDir,"runtime.json"), this.config.baseUrl);
    if(runtimeState.kind==="invalid")throw this.busyRuntimeError("invalid runtime metadata");
    const runtime=runtimeState.kind==="valid"?runtimeState.record:undefined;
    if (runtime && this.runtimeAlive(runtime)) return this.pollExisting(deadline, signal, "startup_busy");
    if (runtime) await this.removeStaleRuntime();

    const lock = await acquireStartupLock(this.config, this.effects, deadline, signal);
    let primary: unknown;
    try {
      const second = await this.client.probe(signal);
      if (second.kind === "healthy") return second;
      if(second.kind==="unreachable"&&second.error.code==="aborted")throw second.error;
      this.rejectRecognized(second);
      const underLockState=await readRuntimeState(join(this.config.stateDir,"runtime.json"),this.config.baseUrl);
      if(underLockState.kind==="invalid")throw this.busyRuntimeError("invalid runtime metadata");
      const underLock=underLockState.kind==="valid"?underLockState.record:undefined;
      if (underLock && this.runtimeAlive(underLock)) return await this.pollExisting(deadline, signal, "startup_busy");
      if (underLock) await this.removeStaleRuntime();

      if (signal?.aborted) throw new AgentmemoryError("aborted", `Agentmemory startup aborted for ${this.config.baseUrl}`, { endpoint: this.config.baseUrl, operation: "startup", reason: "aborted" });
      let cliPath:string;
      try{cliPath=await this.effects.resolveRuntime();}catch{throw this.startupError("runtime package resolution failed");}
      if (signal?.aborted) throw new AgentmemoryError("aborted", `Agentmemory startup aborted for ${this.config.baseUrl}`, { endpoint: this.config.baseUrl, operation: "startup", reason: "aborted" });
      await this.rotateLogs();
      if (signal?.aborted) throw new AgentmemoryError("aborted", `Agentmemory startup aborted for ${this.config.baseUrl}`, { endpoint: this.config.baseUrl, operation: "startup", reason: "aborted" });
      const runtimeToken = token();
      const child = this.effects.spawn(process.execPath, [this.effects.launcherPath], {
        detached: true, windowsHide: true, stdio: "ignore", cwd: this.config.stateDir,
        env: { ...process.env, PI_AGENTMEMORY_CLI_PATH: cliPath, PI_AGENTMEMORY_STATE_DIR: this.config.stateDir, PI_AGENTMEMORY_LOG_PATH: this.config.logPath, PI_AGENTMEMORY_RUNTIME_TOKEN: runtimeToken, AGENTMEMORY_URL: this.config.baseUrl, ...(this.config.secret ? { AGENTMEMORY_SECRET: this.config.secret } : {}) },
      });
      if (!validPid(child.pid)) throw this.startupError("launcher returned no PID");
      child.unref();
      const record: RuntimeRecord = { schemaVersion:1, token:runtimeToken, launcherPid:child.pid, baseUrl:this.config.baseUrl, startedAt:this.effects.now(), packageVersion:"0.9.27" };
      await atomicWrite(join(this.config.stateDir,"runtime.json"), record);
      return await this.pollSpawned(deadline, record, signal);
    } catch (error) { primary = error; this.lastError = error instanceof AgentmemoryError ? safeReason(error.code) : "startup_failed"; throw error; }
    finally { try { await lock.release(); } catch { if (!primary) this.lastError = "lock_cleanup_failed"; } }
  }

  private rejectRecognized(result: Exclude<ProbeResult,HealthyProbe>): void {
    if (result.kind === "unauthorized" || result.kind === "unhealthy" || result.kind === "foreign") throw result.error;
  }
  private runtimeAlive(record: RuntimeRecord): boolean { return this.effects.pidAlive(record.launcherPid) || (record.childPid !== undefined && this.effects.pidAlive(record.childPid)); }
  private async removeStaleRuntime(): Promise<void> {
    const path=join(this.config.stateDir,"runtime.json"), stale=`${path}.stale-${process.pid}-${token()}`;
    try { await rename(path,stale); await unlink(stale).catch(()=>{}); } catch (error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  }
  private async pollExisting(deadline:number, signal:AbortSignal|undefined, code:"startup_busy"):Promise<HealthyProbe> {
    while(this.effects.now()<deadline){ const p=await this.client.probe(signal); if(p.kind==="healthy") return p; this.rejectRecognized(p); await this.effects.sleep(STARTUP_POLL_MS,signal); }
    throw new AgentmemoryError(code,`Agentmemory startup is busy for ${this.config.baseUrl}; see ${this.config.logPath}`,{endpoint:this.config.baseUrl,operation:"startup",reason:"live runtime did not become healthy"});
  }
  private async pollSpawned(deadline:number, runtime:RuntimeRecord, signal?:AbortSignal):Promise<HealthyProbe>{
    while(this.effects.now()<deadline){ const p=await this.client.probe(signal); if(p.kind==="healthy") return p; this.rejectRecognized(p); const latest=parseRuntime(await boundedJson(join(this.config.stateDir,"runtime.json")),this.config.baseUrl)??runtime; if(!this.runtimeAlive(latest)) throw this.startupError("launcher exited before readiness"); await this.effects.sleep(STARTUP_POLL_MS,signal); }
    throw this.startupError("readiness deadline exceeded");
  }
  private startupError(reason:string):AgentmemoryError{return new AgentmemoryError("startup_failed",`Agentmemory startup failed for ${this.config.baseUrl}: ${reason}; see ${this.config.logPath}`,{endpoint:this.config.baseUrl,operation:"startup",reason});}
  private busyRuntimeError(reason:string):AgentmemoryError{return new AgentmemoryError("startup_busy",`Agentmemory startup is suppressed for ${this.config.baseUrl}: ${reason}; see ${this.config.logPath}`,{endpoint:this.config.baseUrl,operation:"startup runtime",reason});}
  private async rotateLogs():Promise<void>{
    const prior=`${this.config.logPath}.1`;
    for(const path of [this.config.logPath,prior]){ const info=await lstat(path).catch(()=>undefined); if(info?.isSymbolicLink()) throw this.startupError("unsafe symlink log target"); }
    await unlink(prior).catch((e)=>{if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;});
    await rename(this.config.logPath,prior).catch((e)=>{if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;});
  }
  async diagnostics():Promise<DaemonDiagnostics>{
    const runtime=parseRuntime(await boundedJson(join(this.config.stateDir,"runtime.json")),this.config.baseUrl);
    return {managed:!!runtime,...(runtime?{launcherPid:runtime.launcherPid,...(runtime.childPid?{childPid:runtime.childPid}:{}),startedAt:runtime.startedAt}:{}),logPath:this.config.logPath,...(this.lastError?{lastError:this.lastError}:{})};
  }
}
