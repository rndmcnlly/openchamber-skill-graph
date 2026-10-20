import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { buildGraph, edgeClass, extractReferences, fingerprint, resolveExposure, projectSources, sourcesFingerprint, SKILLS_ROOT } from "../graph.ts"
import { nodeFiles } from "../report.ts"

// One fixture per failure mode the panel should diagnose.
const fixture = {
  "good-index/SKILL.md": "---\nname: good-index\ndescription: Lists things\n---\n| Need | Load |\n| --- | --- |\n| x | `hidden-one` |\nSee [ref](../hidden-one/ref.md) and ~/.config/opencode/skills/hidden-two/.\n```\n`hidden-two` inside a fence is not a mention\ncat ../hidden-two/SKILL.md\n```\nBroken: ../ghost/x.md and `[not a link](../hidden-two/SKILL.md)`\n",
  "hidden-one/SKILL.md": "---\nname: Hidden One\ndescription: Loaded by ID\nmetadata:\n  opencode/autoinvoke: \"false\"\n---\nBody mentions `good-index` and `hidden-one` (self).\n",
  "hidden-one/ref.md": "Nested note naming `hidden-two`.\n",
  "hidden-one/scripts/run.sh": "echo hi\n",
  "hidden-two/SKILL.md": "---\nname: hidden-two\ndescription: Explicit metadata wins\ndisable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: true\n---\nBody.\n",
  "no-front/SKILL.md": "# No frontmatter here\n",
  "bad-yaml/SKILL.md": "---\nname: [unclosed\n---\n",
  "orphan/notes.txt": "no skill here\n",
  "wrongcase/skill.md": "---\nname: wrongcase\ndescription: lower-case file\n---\n",
  "container/nested/SKILL.md": "---\nname: nested\ndescription: Deep skill\n---\n",
  "review.md": "---\nname: review\ndescription: Root markdown skill\n---\n",
}

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "skill-graph-fixture-"))
  try {
    for (const [path, content] of Object.entries(fixture)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    }
    await run(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}
const codes = (graph, subject) => graph.diagnostics.filter((item) => item.subject === subject).map((item) => item.code).sort()

test("exposure follows the V2 rules, including string flags and precedence", () => {
  assert.equal(resolveExposure({ metadata: { "opencode/autoinvoke": false } }, "d").exposed, false)
  assert.equal(resolveExposure({ metadata: { "opencode/autoinvoke": "false" } }, "d").exposed, false)
  assert.equal(resolveExposure({ "disable-model-invocation": true }, "d").exposed, false)
  assert.equal(resolveExposure({ "disable-model-invocation": true, metadata: { "opencode/autoinvoke": true } }, "d").exposed, true)
  assert.equal(resolveExposure({}, "").exposed, false)
  assert.equal(resolveExposure({ metadata: { "opencode/autoinvoke": "no" } }, "d").invalidFlag, "no")
})

test("discovery, relations, and diagnostics on a seeded fixture", () => withFixture(async (root) => {
  const graph = await buildGraph(nodeFiles, { root })
  const ids = graph.skills.map((skill) => skill.id).sort()
  assert.deepEqual(ids, ["bad-yaml", "good-index", "hidden-one", "hidden-two", "nested", "no-front", "review"])
  const skills = new Map(graph.skills.map((skill) => [skill.id, skill]))
  assert.equal(skills.get("good-index").exposed, true)
  assert.equal(skills.get("hidden-one").exposed, false)
  assert.equal(skills.get("hidden-two").exposed, true)
  assert.equal(skills.get("no-front").exposed, false)
  assert.deepEqual(skills.get("hidden-one").extraFiles, ["hidden-one/ref.md", "hidden-one/scripts/run.sh"])
  assert.deepEqual(skills.get("good-index").extraFiles, [])

  const edges = graph.relations.map((relation) => `${relation.source}>${relation.target}:${relation.kind}:${edgeClass(relation, skills)}:${relation.evidence.map((item) => `${item.line}/${item.form}`).join(",")}`)
  assert.deepEqual(edges, [
    "good-index>hidden-one:path:path:8/markdown-link",
    "good-index>hidden-one:skill-id:discovery:7/backticked-id",
    // The fenced `hidden-two` is not a mention, but fenced and inline-code paths
    // count; only the Markdown link syntax inside inline code is ignored.
    "good-index>hidden-two:path:path:8/absolute-path,11/relative-path,13/relative-path",
    "hidden-one>good-index:skill-id:mention:7/backticked-id",
  ])

  assert.deepEqual(codes(graph, "hidden-one"), ["name-mismatch"])
  assert.deepEqual(codes(graph, "no-front"), ["missing-frontmatter", "unreachable"])
  assert.deepEqual(codes(graph, "bad-yaml"), ["invalid-frontmatter", "unreachable"])
  assert.deepEqual(codes(graph, "orphan"), ["missing-skill-md"])
  assert.deepEqual(codes(graph, "wrongcase"), ["missing-skill-md", "skill-md-case"])
  assert.deepEqual(codes(graph, "nested"), ["nested-skill"])
  assert.deepEqual(codes(graph, "review"), ["root-markdown"])
  assert.deepEqual(codes(graph, "good-index"), ["missing-target"])
  assert.deepEqual(graph.strayFolders.map((folder) => folder.path), ["orphan", "wrongcase"])
  assert.ok(!graph.strayFolders.some((folder) => folder.path === "container"), "a folder holding a nested SKILL.md is not stray")
}))

test("nested Markdown is opt-in and attributed to its skill", () => withFixture(async (root) => {
  const shallow = await buildGraph(nodeFiles, { root })
  const deep = await buildGraph(nodeFiles, { root, deep: true })
  const has = (graph) => graph.relations.some((relation) => relation.source === "hidden-one" && relation.target === "hidden-two")
  assert.equal(has(shallow), false)
  assert.equal(has(deep), true)
  assert.equal(deep.relations.find((relation) => relation.source === "hidden-one" && relation.target === "hidden-two").evidence[0].file, "hidden-one/ref.md")
}))

test("fingerprint changes when a skill or folder changes", () => withFixture(async (root) => {
  const before = await fingerprint(nodeFiles, root)
  assert.equal(await fingerprint(nodeFiles, root), before)
  await writeFile(join(root, "hidden-two/SKILL.md"), `${fixture["hidden-two/SKILL.md"]}more\n`)
  const edited = await fingerprint(nodeFiles, root)
  assert.notEqual(edited, before)
  await mkdir(join(root, "new-folder"))
  assert.notEqual(await fingerprint(nodeFiles, root), edited)
}))

const skillText = (id, body = "", hidden = false) => `---\nname: ${id}\ndescription: ${id}\ndisable-model-invocation: ${hidden}\n---\n${body}`
function memoryFiles(contents) {
  return {
    async listDir(path) {
      const entries = new Map()
      for (const file of Object.keys(contents)) {
        if (!file.startsWith(`${path}/`)) continue
        const tail = file.slice(path.length + 1)
        entries.set(tail.split("/")[0], { name: tail.split("/")[0], kind: tail.includes("/") ? "directory" : "file" })
      }
      if (!entries.size) throw Object.assign(new Error(`Missing ${path}`), { code: "NOT_FOUND" })
      return [...entries.values()]
    },
    async readFile(path) { assert.ok(path in contents, path); return contents[path] },
    async stat(path) { return { kind: "file", mtime: 1, size: contents[path].length } },
  }
}

test("project sources follow V2 precedence with qualified provenance and cross-source mentions", async () => {
  const contents = {
    [`${SKILLS_ROOT}/index/SKILL.md`]: skillText("index", "`local` and `shared`"),
    [`${SKILLS_ROOT}/index/shadow/SKILL.md`]: skillText("shadow", "`global-only`"),
    [`${SKILLS_ROOT}/shared/SKILL.md`]: skillText("shared", "`global-only`"),
    [`${SKILLS_ROOT}/global-only/SKILL.md`]: skillText("global-only"),
    ".claude/skills/shared/SKILL.md": skillText("shared"),
    ".agents/skills/shared/SKILL.md": skillText("shared"),
    ".opencode/skills/shared/SKILL.md": skillText("shared", "`local`", true),
    ".opencode/skills/shadow/SKILL.md": skillText("shadow"),
    ".opencode/skills/local/SKILL.md": skillText("local", "[shared](../shared/SKILL.md) and [global](~/.config/opencode/skills/global-only/SKILL.md)", true),
    ".opencode/skills/skill.md": skillText("skill"),
    ".opencode/skills/orphan/notes.md": "stray",
    ".opencode/skills/container/nested/SKILL.md": skillText("nested"),
  }
  const files = memoryFiles(contents)
  const graph = await buildGraph(files, { sources: projectSources("/project"), deep: true })
  const skills = new Map(graph.skills.map((skill) => [skill.id, skill]))
  assert.equal(skills.size, 7)
  assert.equal(skills.get("shared").scope, "project")
  assert.equal(skills.get("shared").file, ".opencode/skills/shared/SKILL.md")
  assert.equal(skills.get("shared").exposed, false)
  assert.deepEqual(skills.get("shared").overrides, [".claude/skills/shared/SKILL.md", ".agents/skills/shared/SKILL.md", `${SKILLS_ROOT}/shared/SKILL.md`])
  assert.equal(skills.get("index").scope, "global")
  assert.ok(graph.relations.some((edge) => edge.source === "index" && edge.target === "local"))
  assert.ok(!graph.relations.some((edge) => edge.source === "shared" && edge.target === "global-only"), "overridden bodies must not contribute edges")
  assert.ok(!graph.relations.some((edge) => edge.source === "index" && edge.target === "global-only"), "a shadowed nested definition must not be scanned as parent supporting Markdown")
  assert.ok(graph.relations.some((edge) => edge.source === "local" && edge.target === "global-only" && edge.kind === "path"))
  assert.deepEqual(graph.relations.find((edge) => edge.source === "local" && edge.target === "shared").evidence.map((item) => item.file), [".opencode/skills/local/SKILL.md"])
  assert.ok(!graph.diagnostics.some((item) => item.code === "unreachable" && ["local", "shared"].includes(item.subject)))
  assert.ok(!graph.diagnostics.some((item) => item.code === "skill-md-case" && item.file === ".opencode/skills/skill.md"))
  assert.ok(!graph.diagnostics.some((item) => item.code === "nested-skill" && item.subject === "local"))
  assert.deepEqual(graph.strayFolders.map((folder) => folder.path), [".opencode/skills/orphan"])
  // The global OpenCode folder wins over project compatibility sources.
  delete contents[".opencode/skills/shared/SKILL.md"]
  const fallback = await buildGraph(files, { sources: projectSources("/project") })
  assert.equal(fallback.skills.find((skill) => skill.id === "shared").scope, "global")
})

test("optional sources can appear later; errors other than missing roots are not suppressed", async () => {
  const contents = {}
  const files = memoryFiles(contents)
  const sources = projectSources("/project")
  const before = await sourcesFingerprint(files, sources)
  assert.equal((await buildGraph(files, { sources })).skills.length, 0)
  contents[".opencode/skills/new.md"] = skillText("new")
  assert.notEqual(await sourcesFingerprint(files, sources), before)
  assert.equal((await buildGraph(files, { sources: projectSources(null) })).skills.length, 0, "no directory means global only")
  const denied = { ...files, async listDir() { throw Object.assign(new Error("Denied"), { code: "NOT_GRANTED" }) } }
  await assert.rejects(buildGraph(denied, { sources }), /Denied/)
  const brokenChild = { ...files, async listDir(path) { if (path.endsWith("/child")) throw Object.assign(new Error("Child vanished"), { code: "NOT_FOUND" }); return [{ name: "child", kind: "directory" }] } }
  await assert.rejects(buildGraph(brokenChild, { sources: [{ root: "root", scope: "project", optional: true }] }), /Child vanished/)
})

const referenceTree = {
  ids: new Set(["source", "target"]),
  paths: new Set(["target/SKILL.md"]),
  ownerOf: (path) => path.startsWith("target/") ? "target" : null,
}

test("skills-root Markdown links are classified once, with link evidence", () => {
  for (const root of ["~", "$HOME", "/Users/test-user", "/home/test-user"]) {
    const destination = `${root}/.config/opencode/skills/target/SKILL.md#section`
    const found = extractReferences("source", "source/SKILL.md", `[target](${destination} "Read (this) ../target/SKILL.md")`, referenceTree)
    assert.equal(found.length, 1, root)
    assert.equal(found[0].type, "relation")
    assert.equal(found[0].target, "target")
    assert.equal(found[0].evidence.form, "markdown-link")
    assert.equal(found[0].evidence.match, destination)
    assert.equal(found[0].evidence.missing, undefined)
  }
  assert.deepEqual(extractReferences("source", "source/SKILL.md", "[web](https://example.com/target/SKILL.md) [outside](/etc/passwd)", referenceTree), [])
})

test("parentheses in link titles do not duplicate destination path evidence", () => {
  const found = extractReferences("source", "source/SKILL.md", '[target](../target/SKILL.md "Read (this)")', referenceTree)
  assert.equal(found.length, 1)
  assert.equal(found[0].evidence.form, "markdown-link")
  assert.equal(found[0].evidence.match, "../target/SKILL.md")
})

test("fence closers require whitespace-only tails, correct marker, and enough markers", () => {
  for (const marker of ["```", "~~~"]) {
    const text = [marker + "text", marker + " not a closer", "`target`", marker.slice(1), "`target`", marker[0] === "`" ? "~~~" : "```", "`target`", "../target/SKILL.md", marker + "  ", "`target`"].join("\n")
    const found = extractReferences("source", "source/SKILL.md", text, referenceTree)
    assert.deepEqual(found.map((item) => [item.kind, item.evidence.line]), [["path", 8], ["skill-id", 10]])
  }
})

test("root-level skill.md is a valid V2 definition, not a case error", () => withFixture(async (root) => {
  await writeFile(join(root, "skill.md"), "---\nname: skill\ndescription: Root skill\n---\n")
  const graph = await buildGraph(nodeFiles, { root })
  assert.ok(graph.skills.some((skill) => skill.id === "skill" && skill.file === "skill.md"))
  assert.deepEqual(codes(graph, "skill"), ["root-markdown"])
  assert.ok(!graph.diagnostics.some((item) => item.file === "skill.md" && item.code === "skill-md-case"))
  assert.ok(graph.diagnostics.some((item) => item.file === "wrongcase/skill.md" && item.code === "skill-md-case"))
}))

// Read-only check against the user's real library, skipped where it is absent.
const real = join(homedir(), ".config/opencode/skills")
const hasReal = await stat(real).then(() => true, () => false)
test("real skills: every evidence line contains its match at the recorded line", { skip: !hasReal && "no ~/.config/opencode/skills" }, async () => {
  for (const deep of [false, true]) {
    const graph = await buildGraph(nodeFiles, { deep })
    const ids = new Set(graph.skills.map((skill) => skill.id))
    assert.ok(graph.skills.length > 0)
    for (const relation of graph.relations) {
      assert.ok(ids.has(relation.source) && ids.has(relation.target), `${relation.source} -> ${relation.target}`)
      assert.notEqual(relation.source, relation.target)
      for (const item of relation.evidence) {
        const line = (await readFile(join(real, item.file), "utf8")).split(/\r?\n/)[item.line - 1]
        assert.ok(line.includes(item.match), `${item.file}:${item.line} lacks ${item.match}`)
      }
    }
  }
})
