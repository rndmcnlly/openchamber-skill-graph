// Read-only command-line view of the same model the panel draws.
// node report.ts [--deep] [--json] [skills-root]
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { buildGraph, edgeClass, reachability, SKILLS_ROOT, type Graph, type SkillFiles } from "./graph.ts"

const expand = (path: string) => path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path

// Mirrors the host's listDir/readFile/stat shapes; it never writes.
export const nodeFiles: SkillFiles = {
  async listDir(path) {
    const entries = await readdir(expand(path), { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "directory" as const : entry.isFile() ? "file" as const : "other" as const })).sort((a, b) => a.name.localeCompare(b.name))
  },
  readFile: (path) => readFile(expand(path), "utf8"),
  async stat(path) {
    try {
      const info = await stat(expand(path))
      return { kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, mtime: info.mtimeMs }
    } catch { return { kind: "missing", size: 0, mtime: 0 } }
  },
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const root = args.find((arg) => !arg.startsWith("--")) ?? SKILLS_ROOT
  const graph = await buildGraph(nodeFiles, { root, deep: args.includes("--deep") })
  if (args.includes("--json")) console.log(JSON.stringify(graph, null, 2))
  else summarize(graph)
}

function summarize(graph: Graph) {
  const skills = new Map(graph.skills.map((skill) => [skill.id, skill]))
  const counts = { discovery: 0, mention: 0, path: 0 }
  for (const relation of graph.relations) counts[edgeClass(relation, skills)]++
  const chains = reachability(graph)
  const exposed = graph.skills.filter((skill) => skill.exposed)
  const evidence = graph.relations.reduce((sum, relation) => sum + relation.evidence.length, 0)
  console.log(`Root ${graph.root} (${graph.deep ? "SKILL.md plus nested Markdown" : "SKILL.md only"}), ${graph.filesScanned} files scanned`)
  console.log(`Skills ${graph.skills.length}: ${exposed.length} exposed [${exposed.map((skill) => skill.id).join(", ")}], ${graph.skills.length - exposed.length} hidden`)
  console.log(`Relations ${graph.relations.length} (${evidence} evidence lines): ${counts.discovery} index discovery, ${counts.mention} other ID mentions, ${counts.path} file/path links`)
  const withExtras = graph.skills.filter((skill) => skill.extraFiles.length).length
  console.log(`Skill folders with files beyond the definition: ${withExtras}`)
  const tally = { error: 0, warning: 0, info: 0 }
  for (const item of graph.diagnostics) tally[item.severity]++
  console.log(`Diagnostics: ${tally.error} errors, ${tally.warning} warnings, ${tally.info} info`)
  for (const item of graph.diagnostics) console.log(`  ${item.severity.padEnd(7)} ${item.code.padEnd(20)} ${item.subject}${item.file ? ` (${item.file}${item.line ? `:${item.line}` : ""})` : ""}: ${item.message}`)
}
