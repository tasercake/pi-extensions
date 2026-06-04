#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run check
npm pack --dry-run >/dev/null
npx tsx -e 'import("./index.ts").then((mod) => { if (typeof mod.default !== "function") throw new Error("default export must be extension function"); })'
