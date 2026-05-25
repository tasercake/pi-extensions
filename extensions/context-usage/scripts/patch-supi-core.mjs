import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(root, "node_modules", "@mrclrchtr", "supi-core", "package.json");

async function main() {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const distDir = join(root, "node_modules", "@mrclrchtr", "supi-core", "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(
    join(distDir, "context.js"),
    `const providers = [];

export function registerContextProvider(provider) {
  providers.push(provider);
  return () => unregisterContextProvider(provider.id);
}

export function unregisterContextProvider(id) {
  const index = providers.findIndex((provider) => provider.id === id);
  if (index >= 0) providers.splice(index, 1);
}

export function getRegisteredContextProviders() {
  return [...providers];
}
`,
  );

  pkg.exports = { ...(pkg.exports ?? {}), "./context": "./dist/context.js" };
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

await main();
