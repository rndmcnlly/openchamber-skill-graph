import { build } from "esbuild"
import { fileURLToPath } from "node:url"

const absWorkingDir = fileURLToPath(new URL(".", import.meta.url))

// One classic IIFE: the panel iframe cannot load ES modules.
await build({ absWorkingDir, entryPoints: ["panel/main.ts"], bundle: true, format: "iife", platform: "browser", target: "es2022", minify: true, outfile: "panel/main.js" })
