import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBoundedLogWriter, runLauncher, sanitizeLogLine } from "../src/daemon-launcher.mjs";
const fixture=resolve(dirname(fileURLToPath(import.meta.url)),"fixtures/fake-agentmemory-cli.mjs");
const tempStates=new Set<string>();
after(async()=>{await Promise.all([...tempStates].map((state)=>rm(state,{recursive:true,force:true})));});

async function setup(mode="normal", exit="0") { const state=await mkdtemp(join(tmpdir(),"am-launch-"));tempStates.add(state); const log=join(state,"agentmemory.log"), runtime=join(state,"runtime.json"), token="abc"; await writeFile(runtime,JSON.stringify({schemaVersion:1,token,launcherPid:process.pid,baseUrl:"http://localhost:3111",startedAt:1,packageVersion:"0.9.27"})); return {state,log,runtime,env:{...process.env,PI_AGENTMEMORY_CLI_PATH:fixture,PI_AGENTMEMORY_STATE_DIR:state,PI_AGENTMEMORY_LOG_PATH:log,PI_AGENTMEMORY_RUNTIME_TOKEN:token,FAKE_MODE:mode,FAKE_EXIT:exit}}; }

test("sanitize strips controls and redacts whole sensitive lines",()=>{
 assert.equal(sanitizeLogLine("\u001b[31mhello\u0007\tworld\u001b[0m"),"hello\tworld");
 assert.equal(sanitizeLogLine("hello\nworld"),"hello\nworld");
 for(const word of ["authorization","bearer","secret","api_key","token","query","prompt","content","tool_input","tool_output"]) assert.equal(sanitizeLogLine(`prefix ${word} payload`),"[redacted sensitive daemon line]");
});

test("required absolute path and containment validation",async()=>{
 for(const patch of [{PI_AGENTMEMORY_CLI_PATH:""},{PI_AGENTMEMORY_STATE_DIR:"relative"},{PI_AGENTMEMORY_LOG_PATH:"/tmp/outside.log"},{PI_AGENTMEMORY_RUNTIME_TOKEN:""}]) { const x=await setup(); await assert.rejects(()=>runLauncher({...x.env,...patch})); }
});

test("launcher rejects an existing symlink log target",async()=>{const x=await setup();const target=join(x.state,"target.log");await writeFile(target,"do not overwrite");await symlink(target,x.log);await assert.rejects(()=>runLauncher(x.env));await assert.rejects(()=>createBoundedLogWriter(x.log));assert.equal(await readFile(target,"utf8"),"do not overwrite");});

test("launcher is headless in private cwd and token-safe updates/removes runtime",async()=>{
 const x=await setup(); const record=join(x.state,"record.json"); const code=await runLauncher({...x.env,FAKE_RECORD:record,AGENTMEMORY_SECRET:"secret"}); assert.equal(code,0);
 const seen=JSON.parse(await readFile(record,"utf8")); assert.equal(seen.cwd,x.state); assert.equal(seen.secret,"present"); assert(!seen.argv.join(" ").includes("secret"));
 await assert.rejects(()=>readFile(x.runtime));
});

test("launcher redacts bounds lines and logs with private mode",async()=>{
 const x=await setup("sensitive","3"); assert.equal(await runLauncher(x.env),3); const log=await readFile(x.log,"utf8"); assert(log.includes("normal line")); assert(!log.includes("LEAK")); assert(!log.includes("private")); assert(log.match(/\[redacted sensitive daemon line\]/g)!.length>=3); assert(log.includes("code=3"));
 if(process.platform!=="win32") assert.equal((await stat(x.log)).mode&0o777,0o600);
 const y=await setup("oversized"); await runLauncher(y.env); const big=await readFile(y.log); assert(big.length<=1024*1024); assert.equal((big.toString().match(/log truncated/g)??[]).length,1);
});

test("bounded writer keeps one marker and discards after cap",async()=>{ const x=await setup(); const writer=await createBoundedLogWriter(x.log,64); await writer.write("a".repeat(50)); await writer.write("b".repeat(50)); await writer.write("ignored"); await writer.close(); const out=await readFile(x.log,"utf8"); assert(out.length<=64); assert.equal((out.match(/log truncated/g)??[]).length,1); });
