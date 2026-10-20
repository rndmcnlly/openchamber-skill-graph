// Deterministic skill graph model. No DOM and no host calls: the panel and the
// Node report both hand in a SkillFiles adapter, so the same extraction runs in
// OpenChamber and in tests against the real skills folder (read-only).
//
// Discovery follows the OpenCode V2 skills page (opencode.ai/v2/docs/skills):
// a root-level *.md file or a file named exactly SKILL.md at any depth defines
// a skill, and the path, not frontmatter `name`, determines the ID.
import { parse as parseYaml } from "yaml"

export const SKILLS_ROOT = "~/.config/opencode/skills"

export type Entry = { name: string; kind: "file" | "directory" | "other" }
export type FileStat = { kind: string; size: number; mtime: number }
export interface SkillFiles {
  listDir(path: string): Promise<Entry[]>
  readFile(path: string): Promise<string>
  stat(path: string): Promise<FileStat>
}

// Two observable kinds of reference. Neither claims the source loads, invokes,
// or depends on the target; they record what the text literally contains.
export type RelationKind = "skill-id" | "path"
export type EvidenceForm = "backticked-id" | "markdown-link" | "relative-path" | "absolute-path"
export type Evidence = { file: string; line: number; form: EvidenceForm; match: string; snippet: string; missing?: boolean }
export type Relation = { source: string; target: string; kind: RelationKind; evidence: Evidence[] }
// Display class: a skill-ID mention from an exposed skill is how the model can
// discover a hidden skill, so it gets its own visual treatment.
export type EdgeClass = "discovery" | "mention" | "path"

export type Severity = "error" | "warning" | "info"
export type Diagnostic = { severity: Severity; code: string; subject: string; message: string; file?: string; line?: number }

export type Skill = {
  id: string
  file: string
  folder: string
  name: string | null
  description: string
  exposed: boolean
  exposureReason: string
  extraFiles: string[]
  scannedFiles: string[]
  internalRefs: Evidence[]
}
export type Graph = {
  root: string
  deep: boolean
  skills: Skill[]
  relations: Relation[]
  diagnostics: Diagnostic[]
  strayFolders: { path: string; files: string[] }[]
  filesScanned: number
  builtAt: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const dirname = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
const within = (path: string, folder: string) => folder === "" ? false : path === folder || path.startsWith(`${folder}/`)

export function splitFrontmatter(text: string): { data: Record<string, unknown> | null; present: boolean; error: string | null; lines: string[]; bodyStart: number } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return { data: null, present: false, error: null, lines, bodyStart: 0 }
  const end = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."))
  if (end < 0) return { data: null, present: true, error: "Frontmatter opens with --- but never closes", lines, bodyStart: 0 }
  try {
    const data = parseYaml(lines.slice(1, end).join("\n")) ?? {}
    return { data: isRecord(data) ? data : null, present: true, error: isRecord(data) ? null : "Frontmatter is not a YAML mapping", lines, bodyStart: end + 1 }
  } catch (error) {
    return { data: null, present: true, error: `Frontmatter YAML does not parse: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, lines, bodyStart: end + 1 }
  }
}

// YAML booleans and the portable strings "true"/"false" both count.
const flagValue = (value: unknown) => value === true || value === "true" ? true : value === false || value === "false" ? false : undefined

// V2: the model's list holds permitted skills that have a description and do not
// set opencode/autoinvoke to false. disable-model-invocation: true has the same
// effect, and an explicit opencode/autoinvoke wins when both are set.
export function resolveExposure(data: Record<string, unknown> | null, description: string): { exposed: boolean; reason: string; invalidFlag?: unknown } {
  const raw = isRecord(data?.metadata) ? data.metadata["opencode/autoinvoke"] : undefined
  const flag = flagValue(raw)
  const disabled = flagValue(data?.["disable-model-invocation"]) === true
  const invalidFlag = raw !== undefined && flag === undefined ? raw : undefined
  if (!description) return { exposed: false, reason: "No description, so V2 does not advertise it", invalidFlag }
  if (flag === false) return { exposed: false, reason: "metadata.opencode/autoinvoke: false", invalidFlag }
  if (flag === true) return { exposed: true, reason: `metadata.opencode/autoinvoke: true${disabled ? " (wins over disable-model-invocation: true)" : ""}`, invalidFlag }
  if (disabled) return { exposed: false, reason: "disable-model-invocation: true", invalidFlag }
  return { exposed: true, reason: "Has a description and no hiding flag", invalidFlag }
}

// Join and normalize inside the skills root; null when the path escapes it.
export function resolveInRoot(base: string, target: string): string | null {
  const parts: string[] = []
  for (const segment of `${base}/${target}`.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") { if (!parts.length) return null; parts.pop() } else parts.push(segment)
  }
  return parts.join("/")
}

const LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const ABSOLUTE = /(?:~|\$HOME|\/Users\/[^/\s`]+|\/home\/[^/\s`]+)\/\.config\/opencode\/skills\/([A-Za-z0-9_-][^\s`'"()<>\]|,;]*)/g
const RELATIVE = /(?<![\w./~-])((?:\.\.\/)+[A-Za-z0-9_-][A-Za-z0-9._\/-]*)/g
const BACKTICK = /`([^`\n]+)`/g
const FENCE = /^\s*(`{3,}|~{3,})/

function snippetAround(line: string, index: number) {
  const trimmed = line.trim()
  if (trimmed.length <= 220) return trimmed
  const start = Math.max(0, index - 90)
  return `${start > 0 ? "..." : ""}${line.slice(start, start + 220).trim()}${start + 220 < line.length ? "..." : ""}`
}

// What the scanner needs to know about the tree it is reading.
export type Tree = { ids: ReadonlySet<string>; paths: ReadonlySet<string>; ownerOf: (path: string) => string | null }

export type Found =
  | { type: "relation"; target: string; kind: RelationKind; evidence: Evidence }
  | { type: "internal"; evidence: Evidence }
  | { type: "unowned"; evidence: Evidence; resolved: string }

// Scan one Markdown file owned by skill `owner`. `file` is relative to the root.
export function extractReferences(owner: string, file: string, text: string, tree: Tree): Found[] {
  const { lines, bodyStart } = splitFrontmatter(text)
  const found: Found[] = []
  const directory = dirname(file)
  let fence: string | null = null
  const classify = (raw: string, evidence: Evidence) => {
    const resolved = raw.replace(/[.,:;]+$/, "").replace(/\/+$/, "")
    if (!resolved) return
    evidence.missing = !tree.paths.has(resolved) || undefined
    const target = tree.ownerOf(resolved)
    if (target === owner) found.push({ type: "internal", evidence })
    else if (target) found.push({ type: "relation", target, kind: "path", evidence })
    else found.push({ type: "unowned", evidence, resolved })
  }
  for (let index = bodyStart; index < lines.length; index++) {
    const line = lines[index]
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !line.slice(fenceMatch[0].length).trim()) fence = null
      continue
    }
    const evidence = (form: EvidenceForm, match: string, at: number): Evidence => ({ file, line: index + 1, form, match, snippet: snippetAround(line, at) })
    // Mask each consumed span so one path is never counted by two patterns.
    let rest = line
    const mask = (at: number, length: number) => { rest = rest.slice(0, at) + " ".repeat(length) + rest.slice(at + length) }
    if (!fence) {
      // A link written inside inline code is an example, not a link.
      const code = [...line.matchAll(BACKTICK)].map((match) => [match.index, match.index + match[0].length])
      for (const match of line.matchAll(LINK)) {
        if (code.some(([start, end]) => match.index >= start && match.index < end)) continue
        const raw = match[1]
        const target = raw.split("#")[0]
        // Consume the destination and optional title, not an opening parenthesis
        // inside the title. The label can still contain an exact skill-ID mention.
        const destination = match.index + match[0].indexOf("](") + 2
        mask(destination, match.index + match[0].length - destination)
        const absolute = [...target.matchAll(ABSOLUTE)][0]
        if (absolute?.[0] === target) {
          const resolved = resolveInRoot("", absolute[1])
          if (resolved !== null) classify(resolved, evidence("markdown-link", raw, match.index))
          continue
        }
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("~")) continue
        const resolved = resolveInRoot(directory, target)
        if (resolved !== null) classify(resolved, evidence("markdown-link", raw, match.index))
      }
    }
    for (const match of rest.matchAll(ABSOLUTE)) {
      mask(match.index, match[0].length)
      classify(match[1], evidence("absolute-path", match[0], match.index))
    }
    for (const match of rest.matchAll(RELATIVE)) {
      mask(match.index, match[0].length)
      const resolved = resolveInRoot(directory, match[1])
      if (resolved !== null) classify(resolved, evidence("relative-path", match[1], match.index))
    }
    if (fence) continue
    for (const match of rest.matchAll(BACKTICK)) {
      const token = match[1].trim()
      if (token !== owner && tree.ids.has(token)) found.push({ type: "relation", target: token, kind: "skill-id", evidence: evidence("backticked-id", match[0], match.index) })
    }
  }
  return found
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]) }
  }))
  return results
}

const SKIP_DIRECTORIES = new Set(["node_modules", "__pycache__"])

// Every file and folder under the root, relative to it. Dot entries and
// dependency caches are skipped; that is this tool's choice, not OpenCode's.
export async function walk(files: SkillFiles, root: string): Promise<{ files: string[]; folders: string[] }> {
  const result = { files: [] as string[], folders: [] as string[] }
  const visit = async (folder: string, depth: number): Promise<void> => {
    const entries = (await files.listDir(folder ? `${root}/${folder}` : root)).filter((entry) => !entry.name.startsWith("."))
    const children: string[] = []
    for (const entry of entries) {
      const path = folder ? `${folder}/${entry.name}` : entry.name
      if (entry.kind === "file") result.files.push(path)
      else if (entry.kind === "directory" && !SKIP_DIRECTORIES.has(entry.name) && depth < 8) { result.folders.push(path); children.push(path) }
    }
    await mapLimit(children, 6, (child) => visit(child, depth + 1))
  }
  await visit("", 0)
  result.files.sort()
  result.folders.sort()
  return result
}

type Definition = { id: string; file: string; folder: string }

// V2 rules: root-level *.md (ID = file name) and SKILL.md at any depth (ID =
// its folder name; a root-level SKILL.md gets the literal ID "SKILL").
export function definitions(paths: string[]): Definition[] {
  const result: Definition[] = []
  for (const file of paths) {
    if (!file.includes("/") && file.endsWith(".md")) result.push({ id: file.slice(0, -3), file, folder: "" })
    else if (basename(file) === "SKILL.md") result.push({ id: basename(dirname(file)), file, folder: dirname(file) })
  }
  return result
}

// Change detector for polling: the tree's names plus definition mtimes and sizes.
export async function fingerprint(files: SkillFiles, root = SKILLS_ROOT, deep = false): Promise<string> {
  const tree = await walk(files, root)
  const watched = deep ? tree.files.filter((file) => file.endsWith(".md")) : definitions(tree.files).map((definition) => definition.file)
  const stats = await mapLimit(watched, 16, (file) => files.stat(`${root}/${file}`))
  return [...tree.folders, ...tree.files, ...watched.map((file, index) => `${file}@${stats[index].mtime}:${stats[index].size}`)].join("|")
}

export async function buildGraph(files: SkillFiles, options: { root?: string; deep?: boolean } = {}): Promise<Graph> {
  const root = options.root ?? SKILLS_ROOT
  const deep = options.deep ?? false
  const tree = await walk(files, root)
  const diagnostics: Diagnostic[] = []
  const all = definitions(tree.files)
  // Duplicate IDs: keep the first by path and report the rest.
  const defs: Definition[] = []
  for (const definition of all) {
    const first = defs.find((item) => item.id === definition.id)
    if (first) diagnostics.push({ severity: "error", code: "duplicate-id", subject: first.id, file: definition.file, message: `${definition.file} also derives ID "${definition.id}" (first: ${first.file}). Only one can be loaded; this graph shows the first.` })
    else defs.push(definition)
  }
  const ids = new Set(defs.map((definition) => definition.id))
  // Deepest skill folder that contains a path owns it.
  const byDepth = [...defs].filter((definition) => definition.folder).sort((a, b) => b.folder.length - a.folder.length)
  const ownerOf = (path: string) => defs.find((definition) => !definition.folder && definition.file === path)?.id ?? byDepth.find((definition) => within(path, definition.folder))?.id ?? null
  const scanTree: Tree = { ids, paths: new Set([...tree.files, ...tree.folders]), ownerOf }

  for (const file of tree.files) {
    if (file.includes("/") && basename(file) !== "SKILL.md" && basename(file).toLowerCase() === "skill.md") diagnostics.push({ severity: "error", code: "skill-md-case", subject: dirname(file), file, message: `${file} is not named exactly SKILL.md, so OpenCode does not load it.` })
  }
  for (const definition of defs) {
    if (!definition.folder && definition.id !== "SKILL") diagnostics.push({ severity: "info", code: "root-markdown", subject: definition.id, file: definition.file, message: `Root-level Markdown defines skill "${definition.id}" in V2. Intended?` })
    if (definition.folder.includes("/")) {
      const parent = byDepth.find((other) => other !== definition && within(definition.folder, other.folder))
      diagnostics.push({ severity: "warning", code: "nested-skill", subject: definition.id, file: definition.file, message: `Nested SKILL.md registers its own ID "${definition.id}"${parent ? ` inside ${parent.id}'s folder` : ""}.` })
    }
  }
  const topFolders = tree.folders.filter((folder) => !folder.includes("/"))
  const strayFolders = topFolders.filter((folder) => !defs.some((definition) => within(definition.folder, folder))).map((path) => ({ path, files: tree.files.filter((file) => within(file, path)) }))
  for (const folder of strayFolders) diagnostics.push({ severity: "error", code: "missing-skill-md", subject: folder.path, message: `Folder ${folder.path}/ has no SKILL.md, so it defines no skill${folder.files.length ? ` (${folder.files.length} file${folder.files.length === 1 ? "" : "s"} inside)` : " (empty)"}.` })

  const relations = new Map<string, Relation>()
  let filesScanned = 0
  const skills = await mapLimit(defs, 8, async (definition): Promise<Skill> => {
    const { id, file, folder } = definition
    const owned = folder ? tree.files.filter((path) => within(path, folder) && ownerOf(path) === id) : [file]
    const extraFiles = owned.filter((path) => path !== file)
    const scannedFiles = [file, ...(deep ? extraFiles.filter((path) => path.endsWith(".md")) : [])]
    const text = await files.readFile(`${root}/${file}`)
    const front = splitFrontmatter(text)
    const report = (severity: Severity, code: string, message: string, line?: number) => diagnostics.push({ severity, code, subject: id, file, line, message })
    if (!front.present) report("warning", "missing-frontmatter", "No YAML frontmatter. V2 accepts this but cannot advertise the skill without a description; V1 and the Agent Skills spec require name and description.", 1)
    if (front.error) report("error", "invalid-frontmatter", front.error, 1)
    const name = typeof front.data?.name === "string" ? front.data.name : null
    const description = typeof front.data?.description === "string" ? front.data.description.trim() : ""
    if (front.present && !front.error) {
      if (name === null) report("info", "missing-name", `No name. V2 displays the path-derived ID "${id}"; V1 requires a name.`)
      else if (name !== id) report("warning", "name-mismatch", `Frontmatter name "${name}" differs from path-derived ID "${id}". V2 loads it as "${id}" and shows "${name}" as a label; V1 requires them to match.`)
      if (!description) report("warning", "missing-description", "No description, so V2 never lists this skill to the model. It stays loadable by exact ID.")
      else if (description.length > 1024) report("info", "description-length", `Description is ${description.length} characters; the Agent Skills spec allows 1 to 1024. V2 does not enforce this.`)
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || id.length > 64) report("info", "id-format", `ID "${id}" is not portable lowercase kebab-case of 1 to 64 characters (recommended, not enforced by V2).`)
    const exposure = resolveExposure(front.data, description)
    if (exposure.invalidFlag !== undefined) report("warning", "autoinvoke-value", `metadata.opencode/autoinvoke is ${JSON.stringify(exposure.invalidFlag)}; only true, false, "true", or "false" are meaningful.`)
    const internalRefs: Evidence[] = []
    for (const path of scannedFiles) {
      const content = path === file ? text : await files.readFile(`${root}/${path}`)
      filesScanned++
      for (const item of extractReferences(id, path, content, scanTree)) {
        if (item.evidence.missing) diagnostics.push({ severity: "info", code: "missing-target", subject: id, file: path, line: item.evidence.line, message: `${item.evidence.match} points at a path that does not exist${item.type === "relation" ? ` in ${item.target}` : ""} (possibly an example placeholder).` })
        if (item.type === "internal") internalRefs.push(item.evidence)
        else if (item.type === "unowned") { if (!item.evidence.missing) diagnostics.push({ severity: "warning", code: "unowned-target", subject: id, file: path, line: item.evidence.line, message: `${item.evidence.match} points into the skills folder but not into any skill.` }) }
        else {
          const key = `${id}\u0000${item.target}\u0000${item.kind}`
          const relation = relations.get(key) ?? { source: id, target: item.target, kind: item.kind, evidence: [] }
          relation.evidence.push(item.evidence)
          relations.set(key, relation)
        }
      }
    }
    return { id, file, folder, name, description, exposed: exposure.exposed, exposureReason: exposure.reason, extraFiles, scannedFiles, internalRefs }
  })
  const byEvidence = (a: Evidence, b: Evidence) => a.file.localeCompare(b.file) || a.line - b.line
  for (const relation of relations.values()) relation.evidence.sort(byEvidence)
  const graph: Graph = {
    root, deep, skills, strayFolders, filesScanned, builtAt: Date.now(),
    relations: [...relations.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind)),
    diagnostics,
  }
  const chains = reachability(graph)
  for (const skill of skills) if (chains.get(skill.id) === null) diagnostics.push({ severity: "warning", code: "unreachable", subject: skill.id, file: skill.file, message: "Hidden, and no chain of recorded references from an exposed skill reaches it. It stays loadable by exact ID." })
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  diagnostics.sort((a, b) => rank[a.severity] - rank[b.severity] || a.subject.localeCompare(b.subject) || (a.line ?? 0) - (b.line ?? 0))
  return graph
}

export function edgeClass(relation: Relation, skills: ReadonlyMap<string, Skill>): EdgeClass {
  if (relation.kind === "path") return "path"
  return skills.get(relation.source)?.exposed ? "discovery" : "mention"
}

// Shortest chain from any exposed skill along any recorded reference. A chain
// shows text an agent could follow; it does not prove the agent will.
export function reachability(graph: Pick<Graph, "skills" | "relations">): Map<string, string[] | null> {
  const outgoing = new Map<string, string[]>()
  for (const relation of graph.relations) outgoing.set(relation.source, [...(outgoing.get(relation.source) ?? []), relation.target])
  const chains = new Map<string, string[] | null>(graph.skills.map((skill) => [skill.id, null]))
  const queue: string[] = []
  for (const skill of graph.skills) if (skill.exposed) { chains.set(skill.id, [skill.id]); queue.push(skill.id) }
  for (let head = 0; head < queue.length; head++) {
    const chain = chains.get(queue[head])!
    for (const next of (outgoing.get(queue[head]) ?? []).sort()) {
      if (chains.get(next) !== null) continue
      chains.set(next, [...chain, next])
      queue.push(next)
    }
  }
  return chains
}
