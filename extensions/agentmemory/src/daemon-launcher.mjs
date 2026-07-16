import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_LINE_BYTES = 8 * 1024;
const SENSITIVE = /authorization|bearer|secret|api_key|token|query|prompt|content|tool_input|tool_output/i;
const ANSI = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

/** @param {string} line */
export function sanitizeLogLine(line) {
  const clean = line.replace(ANSI, "").replace(/[^\t\n\x20-\x7e\u0080-\u{10ffff}]/gu, "");
  return SENSITIVE.test(clean) ? "[redacted sensitive daemon line]" : clean;
}

/** @param {string} path @param {number} [maxBytes] */
export async function createBoundedLogWriter(path, maxBytes = MAX_LOG_BYTES) {
  const flags = process.platform === "win32" ? "w" : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  const opened = await handle.stat();
  if (!opened.isFile()) { await handle.close(); throw new Error("Agentmemory log must be a regular file"); }
  const marker = "\n[agentmemory log truncated]\n";
  const markerBytes = Buffer.byteLength(marker);
  const contentLimit = Math.max(0, maxBytes - markerBytes);
  let bytes = 0, truncated = false, chain = Promise.resolve();
  /** @param {string} text */
  const rawWrite = async (text) => { const data = Buffer.from(text); if (!data.length) return; await handle.write(data, 0, data.length, null); bytes += data.length; };
  return {
    /** @param {string} text */
    write(text) {
      chain = chain.then(async () => {
        if (truncated) return;
        const data = Buffer.from(text);
        if (bytes + data.length <= contentLimit) { await rawWrite(text); return; }
        const allowed = Math.max(0, contentLimit - bytes);
        if (allowed) await rawWrite(data.subarray(0, allowed).toString());
        if (bytes + markerBytes <= maxBytes) await rawWrite(marker);
        truncated = true;
      });
      return chain;
    },
    async close() { await chain; await handle.sync(); await handle.close(); },
    get bytesWritten() { return bytes; },
  };
}

/** @param {NodeJS.ReadableStream} stream @param {"stdout"|"stderr"} source @param {Awaited<ReturnType<typeof createBoundedLogWriter>>} writer */
async function drainStream(stream, source, writer) {
  let stored = "", sensitive = false, discarded = false;
  const emit = async () => {
    const payload = sensitive ? "[redacted sensitive daemon line]" : sanitizeLogLine(stored);
    const suffix = discarded && payload !== "[redacted sensitive daemon line]" ? " [line truncated]" : "";
    await writer.write(`${new Date().toISOString()} ${source} ${payload}${suffix}\n`);
    stored = ""; sensitive = false; discarded = false;
  };
  for await (const raw of stream) {
    const text = raw.toString();
    let start = 0;
    for (let index = 0; index < text.length; index++) if (text[index] === "\n") {
      const part = text.slice(start, index).replace(/\r$/, "");
      sensitive ||= SENSITIVE.test(part);
      const remaining = MAX_LOG_LINE_BYTES - Buffer.byteLength(stored);
      if (remaining > 0) stored += Buffer.from(part).subarray(0, remaining).toString();
      if (Buffer.byteLength(part) > remaining) discarded = true;
      await emit(); start = index + 1;
    }
    const part = text.slice(start); sensitive ||= SENSITIVE.test(part);
    const remaining = MAX_LOG_LINE_BYTES - Buffer.byteLength(stored);
    if (remaining > 0) stored += Buffer.from(part).subarray(0, remaining).toString();
    if (Buffer.byteLength(part) > remaining) discarded = true;
  }
  if (stored || sensitive || discarded) await emit();
}

/** @param {string} path @param {string} token @param {(record: Record<string, unknown>) => Record<string, unknown>|null} transform */
async function updateRuntime(path, token, transform) {
  let record;
  try { record = JSON.parse(await readFile(path, "utf8")); } catch { return; }
  if (!record || typeof record !== "object" || record.token !== token) return;
  const next = transform(record);
  if (next === null) {
    let current; try { current = JSON.parse(await readFile(path,"utf8")); } catch { return; }
    if (current?.token === token) await unlink(path).catch(() => {});
    return;
  }
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(next)}\n`); await handle.sync(); } finally { await handle.close(); }
  let current; try { current = JSON.parse(await readFile(path,"utf8")); } catch { current = null; }
  if (current?.token === token) await rename(temp,path); else await unlink(temp).catch(()=>{});
}

/** @param {NodeJS.ProcessEnv} [env] */
export async function runLauncher(env = process.env) {
  const cliPath = env.PI_AGENTMEMORY_CLI_PATH, stateDir = env.PI_AGENTMEMORY_STATE_DIR, logPath = env.PI_AGENTMEMORY_LOG_PATH, runtimeToken = env.PI_AGENTMEMORY_RUNTIME_TOKEN;
  if (!cliPath || !stateDir || !logPath || !runtimeToken) throw new Error("Missing required Agentmemory launcher environment");
  if (![cliPath,stateDir,logPath].every(isAbsolute)) throw new Error("Agentmemory launcher paths must be absolute");
  const cliInfo = await lstat(cliPath);
  if (!cliInfo.isFile() || cliInfo.isSymbolicLink()) throw new Error("Agentmemory CLI must be a regular file");
  const stateInfo = await lstat(stateDir);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error("Agentmemory state must be a directory");
  const logRel = relative(stateDir,logPath);
  if (logRel.startsWith("..") || isAbsolute(logRel) || dirname(logPath) !== stateDir) throw new Error("Agentmemory log must stay inside state directory");
  const logInfo = await lstat(logPath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (logInfo?.isSymbolicLink() || (logInfo && !logInfo.isFile())) throw new Error("Agentmemory log target must be a regular file");
  const runtimePath = resolve(stateDir,"runtime.json");
  const writer = await createBoundedLogWriter(logPath);
  const child = spawn(process.execPath,[cliPath],{cwd:stateDir,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  const outcomePromise = new Promise((resolveOutcome) => {
    let done=false;
    child.once("error",()=>{if(!done){done=true;resolveOutcome({code:1,diagnostic:"child error"});}});
    child.once("exit",(code,signal)=>{if(!done){done=true;resolveOutcome({code:code??1,diagnostic:signal?`signal=${String(signal).replace(/[^A-Z0-9]/gi,"")}`:`code=${code??1}`});}});
  });
  const drains = Promise.all([drainStream(child.stdout,"stdout",writer),drainStream(child.stderr,"stderr",writer)]);
  if (!child.pid) { await writer.write(`${new Date().toISOString()} launcher error=no-child-pid\n`); await drains; await writer.close(); throw new Error("Agentmemory CLI returned no PID"); }
  await updateRuntime(runtimePath,runtimeToken,(record)=>({...record,childPid:child.pid}));
  const outcome = await outcomePromise;
  await drains;
  await writer.write(`${new Date().toISOString()} launcher ${outcome.diagnostic}\n`);
  await updateRuntime(runtimePath,runtimeToken,()=>null);
  await writer.close();
  return outcome.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLauncher().then((code)=>{process.exitCode=code;},()=>{process.stderr.write("Agentmemory launcher validation failed\n");process.exitCode=1;});
}
