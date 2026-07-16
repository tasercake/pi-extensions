import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, "..");
const root = resolve(ext, "../..");
const json = async (p: string) => JSON.parse(await readFile(p, "utf8"));

test("root and nested manifests expose the managed extension", async () => {
  const rootPkg = await json(resolve(root, "package.json"));
  const pkg = await json(resolve(ext, "package.json"));
  assert.deepEqual(rootPkg.pi.extensions, ["extensions/*/src/index.ts"]);
  assert.equal(rootPkg.workspaces, undefined);
  assert.equal(rootPkg.dependencies["@agentmemory/agentmemory"], "0.9.27");
  assert.equal(pkg.dependencies["@agentmemory/agentmemory"], undefined);
  assert.equal(pkg.name, "pi-agentmemory"); assert.equal(pkg.private, true); assert.equal(pkg.license, "Apache-2.0");
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]); assert.equal(pkg.engines.node, ">=20.0.0");
  assert(pkg.scripts.test); assert.equal(pkg.bin, undefined);
});

test("license notice and docs contain attribution install privacy and lifetime", async () => {
  const license = await readFile(resolve(ext, "LICENSE"), "utf8");
  const notice = await readFile(resolve(ext, "NOTICE"), "utf8");
  const docs = `${await readFile(resolve(root, "README.md"), "utf8")}\n${await readFile(resolve(ext, "README.md"), "utf8")}`;
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(notice, /93ae9bc04f3ab5042f982aaadf11f1e3f5137531/);
  for (const text of ["pi install git:github.com/tasercake/pi-extensions", "pi update --all", "memory_search", "PI_AGENTMEMORY_AUTO_CAPTURE", "persistent"]) assert(docs.includes(text), text);
});

test("entrypoint imports and static hazards are absent", async () => {
  const module = await import("../src/index.js");
  assert.equal(typeof module.default, "function");
  const sources = await Promise.all(["index.ts", "extension.ts"].map((x) => readFile(resolve(ext, "src", x), "utf8")));
  const all = sources.join("\n");
  assert(!all.includes("@mariozechner/pi-coding-agent"));
  assert(!/name:\s*["']memory_(search|save|health)/.test(all));
  assert(!all.includes("process.cwd()"));
  assert(!/session_shutdown[\s\S]{0,1000}(process\.kill|\.kill\(|agentmemory stop)/.test(all));
});
