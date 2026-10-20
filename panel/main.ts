import { connectHost, HostRequestError } from "@openchamber/sdk"
import { applyHostReady, applyHostTheme, mountBanner, mountButton, mountSearchField, mountSwitch, type BannerHandle } from "@openchamber/sdk/ui"
import { buildGraph, edgeClass, sourcesFingerprint, projectSources, reachability, SKILLS_ROOT, type Diagnostic, type EdgeClass, type Evidence, type Graph, type Relation, type Severity, type Skill, type SkillFiles } from "../graph.ts"

// Outside an iframe (npm run dev) the page reads through dev.mjs instead of the host.
const embedded = window.parent !== window
const host = connectHost()
async function dev(op: string, path: string) {
  const response = await fetch(`/__fs?op=${op}&path=${encodeURIComponent(path)}`)
  if (!response.ok) throw Object.assign(new Error(await response.text()), { code: response.headers.get("X-Error-Code") })
  return response.json()
}
const files: SkillFiles = embedded ? {
  listDir: async (path) => (await host.listDir(path)).entries,
  readFile: async (path) => (await host.readFile(path)).content,
  stat: (path) => host.stat(path),
} : {
  listDir: async (path) => (await dev("list", path)).entries,
  readFile: async (path) => (await dev("read", path)).content,
  stat: (path) => dev("stat", path),
}

const CLASS_LABEL: Record<EdgeClass, string> = { discovery: "Index discovery", mention: "Other ID mention", path: "File or path link" }
const CLASS_HELP: Record<EdgeClass, string> = {
  discovery: "An exposed skill names this skill ID in backticks. This is how the model can find a hidden skill; it is not proof the skill gets loaded.",
  mention: "A hidden skill names this exact skill ID in backticks. A textual mention, not a verified invocation or dependency.",
  path: "A Markdown link or file path in the text resolves into the other skill's folder. An agent may read that file; it does not load the skill by ID.",
}
const FORM_LABEL: Record<Evidence["form"], string> = { "backticked-id": "backticked ID", "markdown-link": "Markdown link", "relative-path": "relative path", "absolute-path": "absolute path" }
const CLASSES: EdgeClass[] = ["discovery", "mention", "path"]
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

type Prefs = { classes: EdgeClass[]; showHidden: boolean; problemsOnly: boolean; deep: boolean; watch: boolean }
type Selection = { kind: "skill"; id: string } | { kind: "relation"; key: string } | { kind: "folder"; path: string } | { kind: "subject"; subject: string } | null
// A drawable node: a skill, or a top-level folder that defines no skill.
type Item = { key: string; label: string; exposed: boolean; skill?: Skill; folder?: string }
let prefs: Prefs = { classes: [...CLASSES], showHidden: true, problemsOnly: false, deep: false, watch: true }
let graph: Graph | null = null
let skills = new Map<string, Skill>()
let chains = new Map<string, string[] | null>()
let issues = new Map<string, Diagnostic[]>()
let selection: Selection = null
let query = ""
let loading = false
let refreshPending = false
let lastFingerprint = ""
let viewBox = { x: -500, y: -500, w: 1000, h: 1000 }
let fittedFor = ""
let directory: string | null = null
let contextVersion = 0

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
const svgRoot = $<SVGSVGElement>("#graph")
const inspector = $<HTMLElement>("#inspector")
const summary = $<HTMLElement>("#summary")
const legend = $<HTMLElement>("#legend")
const SVG = "http://www.w3.org/2000/svg"
const relationKey = (relation: Relation) => `${relation.source}>${relation.target}>${relation.kind}`
const folderKey = (path: string) => `folder:${path}`
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}, parent?: Element) {
  const node = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  parent?.append(node)
  return node
}
function html<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "", parent?: Element) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  parent?.append(node)
  return node
}
// Problems are what this panel exists to find: errors, warnings (including
// unreachable hidden skills), and folders that define no skill.
function hasProblem(key: string) { return (issues.get(key.startsWith("folder:") ? key.slice(7) : key) ?? []).some((item) => item.severity !== "info") }
function worst(subject: string): Severity | null {
  const list = issues.get(subject)?.filter((item) => item.code !== "unreachable") ?? []
  return list.length ? list.reduce((best, item) => RANK[item.severity] < RANK[best] ? item.severity : best, "info" as Severity) : null
}

// ---- Controls --------------------------------------------------------------

let banner: BannerHandle | null = null
function showBanner(tone: "info" | "warning" | "error", title: string, body = "") {
  banner?.dispose()
  banner = title ? mountBanner($("#banner"), { tone, title, body }) : null
}
mountSearchField($("#search"), { value: "", placeholder: "Search skills", label: "Search skills by ID or description", onChange: (value) => { query = value.trim().toLowerCase(); render() } })
const switches = {
  problems: mountSwitch($("#switches"), { label: "Problems", checked: prefs.problemsOnly, onChange: (checked) => { prefs.problemsOnly = checked; switches.problems.update({ checked }); savePrefs(); render() } }),
  hidden: mountSwitch($("#switches"), { label: "Hidden", checked: prefs.showHidden, onChange: (checked) => { prefs.showHidden = checked; switches.hidden.update({ checked }); savePrefs(); render() } }),
  deep: mountSwitch($("#switches"), { label: "Nested", checked: prefs.deep, onChange: (checked) => { prefs.deep = checked; switches.deep.update({ checked }); savePrefs(); void refresh() } }),
  watch: mountSwitch($("#switches"), { label: "Watch", checked: prefs.watch, onChange: (checked) => { prefs.watch = checked; switches.watch.update({ checked }); savePrefs(); renderSummary() } }),
}
const refreshButton = mountButton($("#actions"), { label: "Refresh", variant: "outline", size: "sm", onClick: () => void refresh() })
mountButton($("#zoom"), { label: "+", variant: "outline", size: "xs", onClick: () => zoomAt(1 / 1.3) })
mountButton($("#zoom"), { label: "−", variant: "outline", size: "xs", onClick: () => zoomAt(1.3) })
mountButton($("#zoom"), { label: "Fit", variant: "outline", size: "xs", onClick: () => fit() })

function savePrefs() { if (embedded) void host.storage.set("prefs", prefs).catch(() => undefined) }

// ---- Loading ---------------------------------------------------------------

function explain(error: unknown) {
  if (error instanceof HostRequestError) {
    if (error.code === "NOT_GRANTED") return "Approve this extension's project files and global filesystem access in Settings → Extensions."
    if (error.code === "BAD_PATH") return "The host refused a skill path. Project paths must stay inside the active directory; global paths must match the approved skills tree. Symlinks cannot escape those boundaries."
    if (error.code === "NOT_FOUND") return "A skill file or folder disappeared during the scan. Try Refresh."
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

async function refresh() {
  if (loading) { refreshPending = true; return }
  loading = true
  refreshButton.update({ loading: true })
  summary.textContent = "Reading skills…"
  try {
    do {
      refreshPending = false
      const deep = prefs.deep
      const version = contextVersion
      const sources = projectSources(directory)
      try {
        const nextFingerprint = await sourcesFingerprint(files, sources, deep)
        const nextGraph = await buildGraph(files, { deep, sources })
        // A scope toggle during either read must not publish a stale graph, even
        // with Watch off. Coalesce queued requests into one follow-up read.
        if (deep !== prefs.deep || version !== contextVersion) { refreshPending = true; continue }
        graph = nextGraph
        lastFingerprint = nextFingerprint
        skills = new Map(graph.skills.map((skill) => [skill.id, skill]))
        chains = reachability(graph)
        issues = new Map()
        for (const item of graph.diagnostics) issues.set(item.subject, [...(issues.get(item.subject) ?? []), item])
        const current = selection
        if (current?.kind === "skill" && !skills.has(current.id)) selection = null
        if (current?.kind === "relation" && !graph.relations.some((relation) => relationKey(relation) === current.key)) selection = null
        if (current?.kind === "folder" && !graph.strayFolders.some((folder) => folder.path === current.path)) selection = null
        if (current?.kind === "subject" && !issues.has(current.subject)) selection = null
        showBanner("info", "")
        render()
      } catch (error) {
        if (version !== contextVersion || deep !== prefs.deep) { refreshPending = true; continue }
        clearGraph()
        showBanner("error", "Could not read skills", explain(error))
        summary.textContent = ""
      }
    } while (refreshPending)
  } finally {
    loading = false
    refreshButton.update({ loading: false })
  }
}

// Polling, because the SDK offers no file-watch subscription. Paused while the
// frame is hidden.
setInterval(async () => {
  if (!prefs.watch || loading || !graph || document.hidden) return
  const version = contextVersion
  try { if (await sourcesFingerprint(files, projectSources(directory), prefs.deep) !== lastFingerprint && version === contextVersion) await refresh() }
  catch { /* the next manual refresh reports the error */ }
}, 5000)

function clearGraph() {
  graph = null
  selection = null
  skills.clear()
  chains.clear()
  issues.clear()
  lastFingerprint = ""
  fittedFor = ""
  svgRoot.replaceChildren()
  inspector.replaceChildren()
  legend.replaceChildren()
}

function setDirectory(next: string | null) {
  if (directory === next) return
  directory = next
  contextVersion++
  clearGraph()
  showBanner("info", "")
  if (started) void refresh()
}

// ---- Layout ----------------------------------------------------------------

type Point = { x: number; y: number; angle: number }
const INNER = 120

// Two rings: exposed skills inside, everything else outside, grouped by the
// exposed skill that reaches it first so discovery edges stay short.
function layout(items: Item[]) {
  const positions = new Map<string, Point>()
  const inner = items.filter((item) => item.exposed)
  const outer = items.filter((item) => !item.exposed)
  const group = (item: Item) => chains.get(item.key)?.[0] ?? (item.folder ? "￿" : "￾")
  outer.sort((a, b) => group(a).localeCompare(group(b)) || a.key.localeCompare(b.key))
  const radius = Math.max(220, outer.length * 7)
  const slots = outer.length + new Set(outer.map(group)).size
  const angles = new Map<string, number[]>()
  let slot = 0
  let previous = ""
  for (const item of outer) {
    if (group(item) !== previous) { slot++; previous = group(item) }
    const angle = -Math.PI / 2 + (2 * Math.PI * slot++) / slots
    positions.set(item.key, { x: radius * Math.cos(angle), y: radius * Math.sin(angle), angle })
    angles.set(group(item), [...(angles.get(group(item)) ?? []), angle])
  }
  // Inner nodes aim at the middle of their group's arc, then get pushed apart
  // until no two are closer than `gap`.
  const wanted = inner.map((item, index) => {
    const owned = angles.get(item.key)
    return { item, angle: owned ? owned.reduce((sum, value) => sum + value, 0) / owned.length : -Math.PI / 2 + (2 * Math.PI * (index + 0.5)) / Math.max(1, inner.length) }
  }).sort((a, b) => a.angle - b.angle)
  const gap = Math.min((2 * Math.PI) / Math.max(1, wanted.length), Math.PI / 3) * 0.9
  for (let round = 0; round < 60 && wanted.length > 1; round++) {
    for (let index = 0; index < wanted.length; index++) {
      const a = wanted[index], b = wanted[(index + 1) % wanted.length]
      const spread = (b.angle - a.angle + 4 * Math.PI) % (2 * Math.PI)
      if (spread < gap) { const push = (gap - spread) / 2; a.angle -= push; b.angle += push }
    }
  }
  for (const { item, angle } of wanted) positions.set(item.key, { x: INNER * Math.cos(angle), y: INNER * Math.sin(angle), angle })
  return positions
}

// ---- Rendering -------------------------------------------------------------

function matches(item: Item) { return !query || item.key.toLowerCase().includes(query) || (item.skill?.description.toLowerCase().includes(query) ?? false) || (item.skill?.name?.toLowerCase().includes(query) ?? false) }
function visibleItems(): Item[] {
  const shown = graph!.skills.filter((skill) => prefs.showHidden || skill.exposed).map((skill) => ({ key: skill.id, label: skill.id, exposed: skill.exposed, skill }))
  return [...shown, ...graph!.strayFolders.map((folder) => ({ key: folderKey(folder.path), label: `${folder.path}/`, exposed: false, folder: folder.path }))]
}

function render() {
  if (!graph) return
  renderLegend()
  renderSummary()
  renderGraph()
  renderInspector()
}

function renderLegend() {
  const focusedKind = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-legend]")?.dataset.legend
  legend.replaceChildren()
  const total: Record<EdgeClass, number> = { discovery: 0, mention: 0, path: 0 }
  for (const relation of graph!.relations) total[edgeClass(relation, skills)]++
  for (const kind of CLASSES) {
    const button = html("button", `legend-item ${kind}`, "", legend)
    button.type = "button"
    button.dataset.legend = kind
    button.setAttribute("aria-pressed", String(prefs.classes.includes(kind)))
    button.title = `${CLASS_HELP[kind]} Click to show or hide.`
    const sample = svg("svg", { width: 26, height: 10, "aria-hidden": "true" }, button)
    svg("line", { x1: 1, y1: 5, x2: 25, y2: 5, class: `edge-line ${kind}` }, sample)
    html("span", "", `${CLASS_LABEL[kind]} ${total[kind]}`, button)
    button.onclick = () => {
      prefs.classes = prefs.classes.includes(kind) ? prefs.classes.filter((item) => item !== kind) : [...prefs.classes, kind]
      savePrefs()
      render()
    }
  }
  const nodes = html("span", "legend-nodes", "", legend)
  const key = (glyph: string, label: string, title: string) => { const span = html("span", "legend-key", "", nodes); span.title = title; html("span", `glyph ${glyph}`, "", span); html("span", "", label, span) }
  key("exposed", "Exposed", "Listed to the model: has a description and no hiding flag")
  key("hidden", "Hidden", "Not listed to the model; still loadable by exact ID")
  key("global", "Global", "From the server's global OpenCode skills folder")
  key("project", "Project", "From the active directory's project skills folders")
  key("stack", "Has other files", "The skill folder holds files besides its definition")
  key("issue", "Diagnostics", "Red ring: error. Amber ring: warning")
  key("unreachable", "Unreachable", "Hidden, and no recorded reference chain from an exposed skill")
  key("folder", "No SKILL.md", "Top-level folder that defines no skill")
  if (focusedKind) legend.querySelector<HTMLButtonElement>(`[data-legend="${focusedKind}"]`)?.focus({ preventScroll: true })
}

function renderSummary() {
  if (!graph) return
  const exposed = graph.skills.filter((skill) => skill.exposed).length
  const errors = graph.diagnostics.filter((item) => item.severity === "error").length
  const warnings = graph.diagnostics.filter((item) => item.severity === "warning").length
  const attention = new Set(graph.diagnostics.filter((item) => item.severity !== "info").map((item) => item.subject)).size
  const scope = graph.deep ? `SKILL.md plus nested Markdown (${graph.filesScanned} files)` : "SKILL.md only"
  const time = new Date(graph.builtAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  summary.textContent = `${graph.skills.length} skills · ${exposed} exposed · ${graph.skills.length - exposed} hidden · ${plural(graph.relations.length, "relation")} · ${attention ? `${attention} need${attention === 1 ? "s" : ""} attention (${plural(errors, "error")}, ${plural(warnings, "warning")})` : "no problems found"} · ${scope} · read ${time}${prefs.watch ? " · watching" : ""}`
  const projectCount = graph.skills.filter((skill) => skill.scope === "project").length
  summary.textContent += ` · ${projectCount} project / ${graph.skills.length - projectCount} global · ${directory ? `Directory: ${directory}` : "No project open: global only"}`
}

function renderGraph() {
  const focusedKey = (document.activeElement as Element | null)?.closest?.(".node")?.getAttribute("data-key")
  svgRoot.replaceChildren()
  const items = visibleItems()
  const positions = layout(items)
  const defs = svg("defs", {}, svgRoot)
  for (const kind of CLASSES) {
    const marker = svg("marker", { id: `arrow-${kind}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs)
    svg("path", { d: "M0 1 L10 5 L0 9 z", class: `arrow ${kind}` }, marker)
  }
  const content = svg("g", { class: "content" }, svgRoot)
  const edgeLayer = svg("g", { class: "edges" }, content)
  const nodeLayer = svg("g", { class: "nodes" }, content)
  const selectedKey = selection?.kind === "skill" ? selection.id : selection?.kind === "folder" ? folderKey(selection.path) : null
  const selectedRelation = selection?.kind === "relation" ? selection.key : null
  const neighbors = new Set<string>()
  const shown = graph!.relations.filter((relation) => positions.has(relation.source) && positions.has(relation.target) && prefs.classes.includes(edgeClass(relation, skills)))
  for (const relation of shown) {
    if (relation.source === selectedKey) neighbors.add(relation.target)
    if (relation.target === selectedKey) neighbors.add(relation.source)
    if (relationKey(relation) === selectedRelation) { neighbors.add(relation.source); neighbors.add(relation.target) }
  }
  const radius = (key: string) => (skills.get(key)?.exposed ? 11 : 7) + 3
  const kindOffset: Record<EdgeClass, number> = { discovery: 0, mention: 16, path: -16 }
  for (const relation of shown) {
    const kind = edgeClass(relation, skills)
    const a = positions.get(relation.source)!
    const b = positions.get(relation.target)!
    const pull = Math.hypot(a.x, a.y) > INNER + 1 && Math.hypot(b.x, b.y) > INNER + 1 ? 0.35 : 0.8
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const cx = ((a.x + b.x) / 2) * pull - ((b.y - a.y) / length) * kindOffset[kind]
    const cy = ((a.y + b.y) / 2) * pull + ((b.x - a.x) / length) * kindOffset[kind]
    const trim = (to: Point, by: number) => {
      const distance = Math.hypot(to.x - cx, to.y - cy) || 1
      return { x: to.x - ((to.x - cx) / distance) * by, y: to.y - ((to.y - cy) / distance) * by }
    }
    const start = trim(a, radius(relation.source))
    const end = trim(b, radius(relation.target))
    const d = `M${start.x.toFixed(1)} ${start.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`
    const key = relationKey(relation)
    const incident = relation.source === selectedKey || relation.target === selectedKey || key === selectedRelation
    const searchDim = query && !(matches({ key: relation.source, label: "", exposed: false, skill: skills.get(relation.source) }) || matches({ key: relation.target, label: "", exposed: false, skill: skills.get(relation.target) }))
    const problemDim = prefs.problemsOnly && !hasProblem(relation.source) && !hasProblem(relation.target)
    const group = svg("g", { class: `edge ${kind}${incident ? " active" : ""}${(selection && !incident) || searchDim || (problemDim && !incident) ? " dim" : ""}` }, edgeLayer)
    svg("path", { d, class: `edge-line ${kind}`, "marker-end": `url(#arrow-${kind})` }, group)
    const hit = svg("path", { d, class: "edge-hit" }, group)
    svg("title", {}, hit).textContent = `${relation.source} → ${relation.target}\n${CLASS_LABEL[kind]} · ${plural(relation.evidence.length, "line")} of evidence`
    hit.addEventListener("click", (event) => { event.stopPropagation(); select({ kind: "relation", key }) })
  }
  for (const item of items) {
    const point = positions.get(item.key)!
    const severity = worst(item.folder ?? item.key)
    const unreachable = !!item.skill && chains.get(item.key) === null
    const selected = item.key === selectedKey
    const dim = (selection && !selected && !neighbors.has(item.key)) || (query && !matches(item)) || (prefs.problemsOnly && !selected && !neighbors.has(item.key) && !hasProblem(item.key))
    const classes = ["node", item.skill?.scope ?? "global", item.folder ? "folder" : item.exposed ? "exposed" : "hidden", item.skill?.extraFiles.length ? "stacked" : "", severity && severity !== "info" ? `issue-${severity}` : "", unreachable ? "unreachable" : "", selected ? "selected" : "", neighbors.has(item.key) ? "neighbor" : "", (query && matches(item)) || (prefs.problemsOnly && hasProblem(item.key)) ? "match" : "", dim ? "dim" : ""]
    const description = item.folder ? "folder without SKILL.md" : `${item.skill?.scope ?? "global"}, ${item.exposed ? "exposed" : "hidden"} skill${item.skill?.extraFiles.length ? `, ${plural(item.skill.extraFiles.length, "other file")}` : ""}${severity && severity !== "info" ? `, has ${severity}s` : ""}${unreachable ? ", unreachable" : ""}`
    const group = svg("g", { class: classes.filter(Boolean).join(" "), "data-key": item.key, tabindex: 0, role: "button", "aria-label": `${item.label}, ${description}`, "aria-pressed": String(selected) }, nodeLayer)
    const r = item.exposed ? 11 : 7
    if (item.folder) svg("rect", { x: point.x - 6, y: point.y - 6, width: 12, height: 12, rx: 2, class: "shape" }, group)
    else {
      // A second outline behind the node reads as "more pages in this folder".
      if (item.skill?.extraFiles.length) svg("circle", { cx: point.x + 3.5, cy: point.y - 3.5, r, class: "stack" }, group)
      svg("circle", { cx: point.x, cy: point.y, r, class: "shape" }, group)
    }
    const label = svg("text", {}, group)
    label.textContent = item.label
    if (item.exposed) {
      label.setAttribute("x", String(point.x)); label.setAttribute("y", String(point.y + 26)); label.setAttribute("text-anchor", "middle")
    } else {
      const left = Math.cos(point.angle) < 0
      const degrees = (point.angle * 180) / Math.PI + (left ? 180 : 0)
      label.setAttribute("transform", `translate(${point.x + Math.cos(point.angle) * 14} ${point.y + Math.sin(point.angle) * 14}) rotate(${degrees.toFixed(1)})`)
      label.setAttribute("text-anchor", left ? "end" : "start")
      label.setAttribute("dominant-baseline", "central")
    }
    svg("title", {}, group).textContent = item.folder ? `${item.folder}/ has no SKILL.md` : item.skill?.description || item.key
    const choose = () => select(item.folder ? { kind: "folder", path: item.folder } : { kind: "skill", id: item.key })
    group.addEventListener("click", (event) => { event.stopPropagation(); choose() })
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose() } })
  }
  const signature = items.map((item) => item.key).join(",")
  if (signature !== fittedFor) { fittedFor = signature; fit() } else applyViewBox()
  if (focusedKey) svgRoot.querySelector<SVGGElement>(`.node[data-key="${CSS.escape(focusedKey)}"]`)?.focus()
}

// ---- Pan and zoom ----------------------------------------------------------

function applyViewBox() {
  svgRoot.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`)
  const ctm = svgRoot.getScreenCTM()
  svgRoot.classList.toggle("compact", !!ctm && ctm.a < 0.75)
}
function fit() {
  const box = svgRoot.querySelector<SVGGElement>(".content")?.getBBox()
  if (box && box.width > 0) viewBox = { x: box.x - 16, y: box.y - 16, w: box.width + 32, h: box.height + 32 }
  applyViewBox()
}
function toSvgPoint(clientX: number, clientY: number) {
  const ctm = svgRoot.getScreenCTM()
  if (!ctm) return { x: viewBox.x + viewBox.w / 2, y: viewBox.y + viewBox.h / 2 }
  const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
  return { x: point.x, y: point.y }
}
function zoomAt(factor: number, center = { x: viewBox.x + viewBox.w / 2, y: viewBox.y + viewBox.h / 2 }) {
  const applied = Math.min(6000, Math.max(120, viewBox.w * factor)) / viewBox.w
  viewBox = { x: center.x - (center.x - viewBox.x) * applied, y: center.y - (center.y - viewBox.y) * applied, w: viewBox.w * applied, h: viewBox.h * applied }
  applyViewBox()
}
const stackedLayout = window.matchMedia("(max-width: 700px)")
svgRoot.addEventListener("wheel", (event) => {
  // In the stacked panel, scrolling must reach the inspector below the graph.
  if (stackedLayout.matches && !event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  zoomAt(Math.exp(event.deltaY * 0.0015), toSvgPoint(event.clientX, event.clientY))
}, { passive: false })
let drag: { x: number; y: number; box: typeof viewBox; scale: number; moved: boolean } | null = null
svgRoot.addEventListener("pointerdown", (event) => {
  if (stackedLayout.matches && event.pointerType === "touch") return
  if ((event.target as Element).closest(".node, .edge-hit")) return
  const ctm = svgRoot.getScreenCTM()
  drag = { x: event.clientX, y: event.clientY, box: { ...viewBox }, scale: ctm ? 1 / ctm.a : 1, moved: false }
  svgRoot.setPointerCapture(event.pointerId)
})
svgRoot.addEventListener("pointermove", (event) => {
  if (!drag) return
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y
  if (Math.hypot(dx, dy) > 3) drag.moved = true
  viewBox = { ...drag.box, x: drag.box.x - dx * drag.scale, y: drag.box.y - dy * drag.scale }
  applyViewBox()
})
svgRoot.addEventListener("pointerup", () => { if (drag && !drag.moved && selection) select(null); drag = null })
svgRoot.addEventListener("pointercancel", () => { drag = null })
new ResizeObserver(() => applyViewBox()).observe(svgRoot)

// ---- Inspector -------------------------------------------------------------

function select(next: Selection) {
  selection = next
  renderGraph()
  renderInspector()
}

function skillButton(id: string, parent: Element) {
  const skill = skills.get(id)
  const button = html("button", `skill-link ${skill?.scope ?? "global"} ${skill?.exposed ? "exposed" : "hidden"}`, id, parent)
  button.type = "button"
  button.title = skill?.description ?? id
  button.onclick = () => select(skill ? { kind: "skill", id } : graph?.strayFolders.some((folder) => folder.path === id) ? { kind: "folder", path: id } : { kind: "subject", subject: id })
  return button
}

function badge(label: string, tone: string, parent: Element) { return html("span", `badge ${tone}`, label, parent) }

async function copy(text: string) {
  try {
    if (embedded) { await host.writeClipboard(text); await host.toast({ kind: "info", message: `Copied ${text}` }) }
    else await navigator.clipboard.writeText(text)
  } catch { /* clipboard is best effort */ }
}

function locationButton(file: string, line: number | undefined, parent: Element) {
  const text = line ? `${file}:${line}` : file
  const button = html("button", "location", text, parent)
  button.type = "button"
  button.title = "Copy absolute path"
  const absolute = file.startsWith("/") || file.startsWith("~") ? text : graph?.sources ? `${directory}/${text}` : `${graph?.root ?? SKILLS_ROOT}/${text}`
  button.onclick = () => void copy(absolute)
  return button
}

function evidenceList(items: Evidence[], parent: Element, limit = 4) {
  const list = html("ul", "evidence", "", parent)
  const add = (item: Evidence, into: Element) => {
    const row = html("li", "", "", into)
    locationButton(item.file, item.line, row)
    html("span", "form", `${FORM_LABEL[item.form]}${item.missing ? ", target missing" : ""}`, row)
    html("code", "snippet", item.snippet, row)
  }
  items.slice(0, limit).forEach((item) => add(item, list))
  if (items.length > limit) {
    const more = html("details", "more", "", parent)
    html("summary", "", `${items.length - limit} more`, more)
    const rest = html("ul", "evidence", "", more)
    items.slice(limit).forEach((item) => add(item, rest))
  }
}

function diagnosticList(items: Diagnostic[], parent: Element, withSubject: boolean) {
  const list = html("ul", "diagnostics", "", parent)
  for (const item of items) {
    const row = html("li", item.severity, "", list)
    const head = html("div", "diagnostic-head", "", row)
    badge(item.severity, item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "neutral", head)
    html("span", "code", item.code, head)
    if (withSubject) skillButton(item.subject, head)
    html("p", "", item.message, row)
    if (item.file) locationButton(item.file, item.line, row)
  }
}

function relationGroup(title: string, relations: Relation[], other: (relation: Relation) => string, parent: Element) {
  const section = html("section", "group", "", parent)
  html("h3", "", `${title} (${relations.length})`, section)
  if (!relations.length) { html("p", "muted", "None in the enabled relation types.", section); return }
  for (const relation of relations) {
    const kind = edgeClass(relation, skills)
    const item = html("div", `relation ${kind}`, "", section)
    const head = html("div", "relation-head", "", item)
    skillButton(other(relation), head)
    const label = html("button", `kind ${kind}`, CLASS_LABEL[kind], head)
    label.type = "button"
    label.title = "Inspect this relation"
    label.onclick = () => select({ kind: "relation", key: relationKey(relation) })
    evidenceList(relation.evidence, item, 2)
  }
}

function header(title: string) {
  const head = html("header", "detail-head", "", inspector)
  html("h2", "", title, head)
  const close = html("button", "close", "Overview", head)
  close.type = "button"
  close.onclick = () => select(null)
  return head
}

let inspectorSelection = ""
function renderInspector() {
  const active = document.activeElement
  const hadFocus = !!active && inspector.contains(active)
  const focusables = () => [...inspector.querySelectorAll<HTMLElement>("button, summary")]
  const focusKey = (node: Element) => `${node.tagName}:${node.className}:${node.textContent}`
  const previous = hadFocus ? focusables().filter((node) => focusKey(node) === focusKey(active)) : []
  const occurrence = previous.indexOf(active as HTMLElement)
  const key = hadFocus ? focusKey(active) : ""
  const nextSelection = JSON.stringify(selection)
  const sameView = inspectorSelection === nextSelection
  const scrollTop = inspector.scrollTop
  const openDetails = new Set([...inspector.querySelectorAll("details[open]")].map((node) => node.querySelector("summary")?.textContent))
  inspectorSelection = nextSelection
  inspector.replaceChildren()
  if (!graph) return
  const current = selection
  const relation = current?.kind === "relation" ? graph.relations.find((relation) => relationKey(relation) === current.key) : undefined
  const skill = current?.kind === "skill" ? skills.get(current.id) : undefined
  const folder = current?.kind === "folder" ? graph.strayFolders.find((folder) => folder.path === current.path) : undefined
  if (relation) renderRelation(relation)
  else if (skill) renderSkill(skill)
  else if (folder) renderFolder(folder)
  else if (current?.kind === "subject") {
    header(current.subject)
    diagnosticList(issues.get(current.subject) ?? [], inspector, false)
  }
  else renderOverview()
  if (sameView) for (const details of inspector.querySelectorAll("details")) details.open = openDetails.has(details.querySelector("summary")?.textContent)
  inspector.scrollTop = sameView ? scrollTop : 0
  if (hadFocus) {
    const restored = sameView ? focusables().filter((node) => focusKey(node) === key)[occurrence] : undefined
    const target = restored ?? inspector.querySelector<HTMLElement>("h2") ?? inspector
    if (!restored) target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
}

function renderOverview() {
  const g = graph!
  const problems = g.diagnostics.filter((item) => item.severity !== "info")
  const notes = g.diagnostics.filter((item) => item.severity === "info")
  const subjects = new Set(problems.map((item) => item.subject)).size
  html("h2", "", subjects ? `${subjects} need${subjects === 1 ? "s" : ""} attention` : "No problems found", inspector)
  html("p", "muted", "Errors stop OpenCode from loading a skill as intended. Warnings flag misconfiguration or skills nothing exposed points to. Toggle Problems to see them in the graph.", inspector)
  if (!problems.length) html("p", "muted", "No errors or warnings.", inspector)
  else diagnosticList(problems, inspector, true)
  if (notes.length) {
    const more = html("details", "more", "", inspector)
    html("summary", "", `${plural(notes.length, "note")}`, more)
    diagnosticList(notes, more, true)
  }
  html("h2", "spaced", "Skills", inspector)
  html("p", "muted", `Read from ${g.sources?.map((source) => source.root).join(", ") ?? g.root} using OpenCode V2 discovery: root-level *.md files and SKILL.md at any depth; the path sets the ID. Relations come only from exact text: backticked skill IDs outside code fences, and Markdown links or paths (also inside fences) that resolve into another skill's folder. ${g.deep ? "Nested Markdown files are scanned too and attributed to their skill." : "Only definition files are scanned; turn on Nested to include reference files."} Nothing is inferred by a model.`, inspector)
  html("p", "muted", "Scope: active-directory project folders and the global OpenCode folder only. Ancestors outside this directory, global compatibility folders, configured sources/catalogs, built-ins and agent permission rules are not inspected. Overrides apply only among scanned sources.", inspector)
  const incoming = new Map<string, number>()
  for (const relation of g.relations) incoming.set(relation.target, (incoming.get(relation.target) ?? 0) + 1)
  for (const exposed of [true, false]) {
    const list = g.skills.filter((skill) => skill.exposed === exposed && matches({ key: skill.id, label: skill.id, exposed, skill }))
    const section = html("section", "group", "", inspector)
    html("h3", "", `${exposed ? "Exposed" : "Hidden"} (${list.length})`, section)
    const ul = html("ul", "skill-list", "", section)
    for (const skill of list) {
      const li = html("li", "", "", ul)
      skillButton(skill.id, li)
      badge(skill.scope === "project" ? "Project" : "Global", skill.scope ?? "global", li)
      html("span", "muted count", `${incoming.get(skill.id) ?? 0} in`, li)
      if (skill.extraFiles.length) html("span", "muted count", `+${plural(skill.extraFiles.length, "file")}`, li)
      const severity = worst(skill.id)
      if (severity && severity !== "info") badge(severity, severity, li)
      if (chains.get(skill.id) === null) badge("unreachable", "warning", li)
    }
  }
}

function renderSkill(skill: Skill) {
  const head = header(skill.id)
  badge(skill.exposed ? "Exposed" : "Hidden", skill.exposed ? "primary" : "neutral", head)
  badge(skill.scope === "project" ? "Project" : "Global", skill.scope ?? "global", head)
  const chain = chains.get(skill.id)
  if (chain === null) badge("Unreachable", "warning", head)
  html("p", "", skill.description || "No description.", inspector)
  const facts = html("dl", "facts", "", inspector)
  const fact = (term: string, value: string | Element) => { html("dt", "", term, facts); const dd = html("dd", "", "", facts); if (typeof value === "string") dd.textContent = value; else dd.append(value) }
  if (skill.name !== skill.id) fact("Display name", skill.name ?? "(none)")
  fact("Exposure", skill.exposureReason)
  if (skill.sourceRoot) fact("Source", skill.sourceRoot)
  if (skill.overrides?.length) fact("Overrides", skill.overrides.join(", "))
  fact("File", locationButton(skill.file, undefined, document.createElement("span")))
  if (chain && chain.length > 1) {
    const span = html("span", "chain")
    chain.forEach((id, index) => { if (index) span.append(" → "); if (id === skill.id) span.append(id); else skillButton(id, span) })
    fact("Reached via", span)
  } else if (chain === null) fact("Reached via", "No chain of recorded references from an exposed skill reaches this skill. It stays loadable by exact ID.")
  if (graph!.deep) fact("Files scanned", String(skill.scannedFiles.length))
  const own = issues.get(skill.id) ?? []
  if (own.length) {
    html("h3", "", `Diagnostics (${own.length})`, inspector)
    diagnosticList(own, inspector, false)
  }
  const enabled = graph!.relations.filter((relation) => prefs.classes.includes(edgeClass(relation, skills)))
  relationGroup("Outgoing", enabled.filter((relation) => relation.source === skill.id), (relation) => relation.target, inspector)
  relationGroup("Incoming", enabled.filter((relation) => relation.target === skill.id), (relation) => relation.source, inspector)
  if (skill.extraFiles.length) {
    const more = html("details", "more", "", inspector)
    html("summary", "", `Other files in the folder (${skill.extraFiles.length})`, more)
    const ul = html("ul", "file-list", "", more)
    for (const file of skill.extraFiles) locationButton(file, undefined, html("li", "", "", ul))
  }
  if (skill.internalRefs.length) {
    const more = html("details", "more", "", inspector)
    html("summary", "", `References to its own files (${skill.internalRefs.length})`, more)
    evidenceList(skill.internalRefs, more, 50)
  }
}

function renderFolder(folder: { path: string; files: string[] }) {
  const head = header(`${folder.path}/`)
  badge("No SKILL.md", "error", head)
  diagnosticList(issues.get(folder.path) ?? [], inspector, false)
  html("h3", "", `Contents (${folder.files.length})`, inspector)
  if (!folder.files.length) html("p", "muted", "Empty.", inspector)
  const ul = html("ul", "file-list", "", inspector)
  for (const file of folder.files) locationButton(file, undefined, html("li", "", "", ul))
}

function renderRelation(relation: Relation) {
  const kind = edgeClass(relation, skills)
  header(CLASS_LABEL[kind])
  const route = html("p", "route", "", inspector)
  skillButton(relation.source, route)
  route.append(" → ")
  skillButton(relation.target, route)
  html("p", "muted", CLASS_HELP[kind], inspector)
  html("h3", "", `Evidence (${relation.evidence.length})`, inspector)
  evidenceList(relation.evidence, inspector, 20)
}

// ---- Startup ---------------------------------------------------------------

const DEV_THEME = {
  mode: "dark" as const,
  tokens: { background: "#151313", elevated: "#1f1d1c", foreground: "#e6e1dc", muted: "#9a948e", subtle: "#2a2725", border: "#38332f", hover: "#2a2725", selection: "#3a3430", focus: "#7aa2f7", primary: "#d6a35c", mutedSurface: "#1b1918", elevatedForeground: "#e6e1dc", active: "#332e2b", selectionForeground: "#ffffff", primaryForeground: "#151313", primaryText: "#e5b46d", successText: "#8fc98f", warningText: "#e0b45c", errorText: "#e58080", infoText: "#82aee8", success: "#5a9a5a", warning: "#c99a3a", error: "#c05050", info: "#5b8bd0", font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", mono: "ui-monospace, SFMono-Regular, Menlo, monospace", radius: "8px" },
}

async function start() {
  if (embedded) {
    try {
      const saved = await host.storage.get("prefs") as Partial<Prefs> | undefined
      if (saved) prefs = { ...prefs, ...saved, classes: (saved.classes ?? prefs.classes).filter((kind) => CLASSES.includes(kind)) }
    } catch { /* defaults */ }
    switches.problems.update({ checked: prefs.problemsOnly })
    switches.hidden.update({ checked: prefs.showHidden })
    switches.deep.update({ checked: prefs.deep })
    switches.watch.update({ checked: prefs.watch })
  } else {
    applyHostTheme(DEV_THEME as Parameters<typeof applyHostTheme>[0], document.documentElement)
    const context = await fetch("/__context").then((response) => response.json()) as { directory: string | null }
    directory = context.directory
  }
  await refresh()
}
let started = false
host.onReady((context) => {
  applyHostReady(context, document.documentElement)
  setDirectory(context.directory)
  if (!started) { started = true; void start() }
})
host.onDirectory(setDirectory)
if (!embedded) { started = true; void start() }
