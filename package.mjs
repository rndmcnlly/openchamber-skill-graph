import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Runtime files only: no sources, tests, dev server, or node_modules.
const files = ["package.json", "README.md", "icon.svg", "panel/index.html", "panel/styles.css", "panel/main.js"]
const root = fileURLToPath(new URL(".", import.meta.url))
const dist = join(root, "dist")
const archive = join(dist, "openchamber-skill-graph.zip")
const staging = await mkdtemp(join(tmpdir(), "openchamber-skill-graph-"))
try {
  for (const file of files) {
    await mkdir(dirname(join(staging, file)), { recursive: true })
    await cp(join(root, file), join(staging, file))
  }
  await mkdir(dist, { recursive: true })
  await rm(archive, { force: true })
  execFileSync("zip", ["-X", "-q", archive, ...files], { cwd: staging })
  const hash = createHash("sha256").update(await readFile(archive)).digest("hex")
  await writeFile(join(dist, "SHA256SUMS"), `${hash}  openchamber-skill-graph.zip\n`)
  console.log(`Packaged ${archive}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
