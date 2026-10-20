import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { parseManifestJson } from "@openchamber/sdk/schemas"

const root = new URL("../", import.meta.url)
const expectedFiles = ["README.md", "icon.svg", "package.json", "panel/index.html", "panel/main.js", "panel/styles.css"]

async function checkManifest(directory) {
  const parsed = parseManifestJson(await readFile(new URL("package.json", directory), "utf8"))
  assert.equal(parsed.ok, true, parsed.message)
  const { contributes } = parsed.manifest
  assert.equal(contributes.panel.id, "skill-graph")
  // Global skills plus project files, still no service or network.
  assert.deepEqual(contributes.filesystem, ["~/.config/opencode/skills", "~/.config/opencode/skills/**"])
  assert.equal(contributes.service, undefined)
  assert.deepEqual(contributes.capabilities, ["files"])
  assert.equal(contributes.page, undefined, "rail maximize is enough; no separate page launcher")
  for (const file of [contributes.panel.entry, contributes.panel.icon, "panel/main.js", "panel/styles.css"]) await access(new URL(file, directory))
}

test("folder package has a valid manifest and built entries", () => checkManifest(root))

test("panel bundle never writes files", async () => {
  const source = await readFile(new URL("panel/main.ts", root), "utf8")
  assert.ok(!/writeFile/.test(source))
})

test("release ZIP holds only runtime files", async () => {
  const zip = fileURLToPath(new URL("dist/openchamber-skill-graph.zip", root))
  assert.deepEqual(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n").sort(), expectedFiles)
  const checksum = createHash("sha256").update(await readFile(zip)).digest("hex")
  assert.equal(await readFile(new URL("dist/SHA256SUMS", root), "utf8"), `${checksum}  openchamber-skill-graph.zip\n`)
  const directory = await mkdtemp(join(tmpdir(), "skill-graph-release-"))
  try {
    execFileSync("unzip", ["-q", zip, "-d", directory])
    await checkManifest(new URL(`file://${directory}/`))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
