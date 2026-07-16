import { writeFile } from "node:fs/promises";
import { once } from "node:events";
const mode=process.env.FAKE_MODE??"normal";
if(process.env.FAKE_RECORD) await writeFile(process.env.FAKE_RECORD,JSON.stringify({cwd:process.cwd(),argv:process.argv,secret:process.env.AGENTMEMORY_SECRET?"present":"absent"}));
if(mode==="sensitive") {
  process.stdout.write("\u001b[31mnormal\u0007 line\u001b[0m\nAuthorization: Bearer LEAK\nquery=private\n");
  process.stderr.write("content secret words\n");
}
if(mode==="oversized") {
  for(let i=0;i<150;i++) if(!process.stdout.write("x".repeat(9000)+"\n")) await once(process.stdout,"drain");
  process.stdout.write("DRAINED\n");
}
if(mode==="delay") await new Promise(r=>setTimeout(r,Number(process.env.FAKE_DELAY??100)));
process.exit(Number(process.env.FAKE_EXIT??0));
