import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { build } from "esbuild"

// Optional browser regression suite without a production dependency. Run with
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm test, or install
// Playwright locally. PLAYWRIGHT_EXECUTABLE can select an existing browser.
const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright").catch(() => null)
const definition = (name, body = "") => `---\nname: ${name}\ndescription: Fixture ${name}\n---\n${body}`
const fixture = {
  "source/SKILL.md": definition("source", '`target` and [target](../target/SKILL.md "Read (this)")'),
  "source/ref.md": "`target`",
  "source/notes/skill.md": "Nested mis-cased definition",
  "target/SKILL.md": "---\nname: target\ndescription: Target\ndisable-model-invocation: true\n---\n",
  "container/nested/SKILL.md": definition("nested"),
  "container/skill.md": "Container mis-cased definition",
  "orphan/notes.txt": "Stray folder",
  "skill.md": definition("skill"),
}

test("panel diagnostics, keyboard focus, queued scope refresh, and narrow scrolling", { skip: !playwright && "Playwright not installed; set PLAYWRIGHT_MODULE to enable", timeout: 60000 }, async () => {
  const bundled = await build({ entryPoints: ["panel/main.ts"], bundle: true, platform: "browser", write: false })
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname
    if (path === "/__context") return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ directory: null }))
    const body = path === "/main.js" ? bundled.outputFiles[0].contents : await readFile(new URL(path === "/styles.css" ? "../panel/styles.css" : "../panel/index.html", import.meta.url))
    response.setHeader("Content-Type", path === "/main.js" ? "text/javascript" : path === "/styles.css" ? "text/css" : "text/html")
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  let browser
  try {
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) })
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    let holdNextList = null
    await page.route("**/__fs?*", async (route) => {
      const url = new URL(route.request().url())
      const path = url.searchParams.get("path").replace(/^~\/\.config\/opencode\/skills\/?/, "")
      const op = url.searchParams.get("op")
      if (op === "list" && !path && holdNextList) {
        const hold = holdNextList
        holdNextList = null
        await hold()
      }
      let body
      if (op === "list") {
        const entries = new Map()
        for (const file of Object.keys(fixture)) {
          const prefix = path ? `${path}/` : ""
          if (!file.startsWith(prefix)) continue
          const rest = file.slice(prefix.length)
          const name = rest.split("/")[0]
          entries.set(name, { name, kind: rest.includes("/") ? "directory" : "file" })
        }
        body = { entries: [...entries.values()] }
      } else if (op === "read") body = { content: fixture[path] }
      else body = { kind: "file", size: fixture[path]?.length ?? 0, mtime: 1 }
      await route.fulfill({ json: body })
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => document.querySelector("#summary").textContent.includes("4 skills"))
    const inspector = page.locator("#inspector")
    const heading = () => inspector.locator("h2").first()
    const assertHeadingFocus = async (title) => {
      assert.equal(await heading().textContent(), title)
      assert.ok(await heading().evaluate((node) => node === document.activeElement))
    }
    const overview = async () => {
      await inspector.getByRole("button", { name: "Overview", exact: true }).focus()
      await page.keyboard.press("Enter")
      assert.ok(await heading().evaluate((node) => node === document.activeElement))
    }
    // These subjects are neither skills nor stray folders. Both previously
    // navigated to renderFolder(undefined), emptying the inspector and throwing.
    for (const subject of ["source/notes", "container"]) {
      const button = inspector.getByRole("button", { name: `~/.config/opencode/skills/${subject}`, exact: true })
      await button.focus()
      await page.keyboard.press("Enter")
      await assertHeadingFocus(`~/.config/opencode/skills/${subject}`)
      assert.ok(await inspector.getByText("skill-md-case", { exact: true }).isVisible())
      assert.ok(await inspector.locator(".location").count())
      await overview()
    }
    await inspector.getByRole("button", { name: "~/.config/opencode/skills/orphan", exact: true }).focus()
    await page.keyboard.press("Enter")
    await assertHeadingFocus("~/.config/opencode/skills/orphan/")
    await overview()
    await inspector.locator(".skill-list").getByRole("button", { name: "source", exact: true }).focus()
    await page.keyboard.press("Enter")
    await assertHeadingFocus("source")
    await inspector.getByRole("button", { name: "Index discovery", exact: true }).focus()
    await page.keyboard.press("Enter")
    await assertHeadingFocus("Index discovery")
    await inspector.getByRole("button", { name: "target", exact: true }).focus()
    await page.keyboard.press("Enter")
    await assertHeadingFocus("target")
    await overview()

    const legend = page.locator('[data-legend="path"]')
    await legend.focus()
    await page.keyboard.press("Space")
    assert.equal(await legend.getAttribute("aria-pressed"), "false")
    assert.ok(await legend.evaluate((node) => node === document.activeElement))
    await page.keyboard.press("Space")
    assert.equal(await legend.getAttribute("aria-pressed"), "true")

    // Background refresh preserves focus inside expanded overview notes.
    const notes = inspector.locator("details").first()
    await notes.locator("summary").click()
    const noteButton = notes.locator("button").first()
    const noteText = await noteButton.textContent()
    await noteButton.focus()
    await page.getByRole("button", { name: "Refresh", exact: true }).evaluate((node) => node.click())
    await page.waitForFunction(() => !document.querySelector("#summary").textContent.includes("Reading"))
    assert.equal(await page.evaluate(() => document.activeElement.textContent), noteText)
    assert.equal(await notes.getAttribute("open"), "")

    const watch = page.getByRole("switch", { name: "Watch", exact: true })
    await watch.click()
    const nested = page.getByRole("switch", { name: "Nested", exact: true })
    const delayedRefresh = async (toggleCount) => {
      let release, entered
      const gate = new Promise((resolve) => { release = resolve })
      const started = new Promise((resolve) => { entered = resolve })
      holdNextList = () => { entered(); return gate }
      await page.getByRole("button", { name: "Refresh", exact: true }).click()
      await started
      for (let index = 0; index < toggleCount; index++) await nested.click()
      release()
    }
    await delayedRefresh(1)
    await page.waitForFunction(() => document.querySelector("#summary").textContent.includes("plus nested Markdown (6 files)"))
    assert.equal(await watch.getAttribute("aria-checked"), "false")
    await inspector.locator(".skill-list").getByRole("button", { name: "source", exact: true }).click()
    assert.ok(await inspector.getByText("~/.config/opencode/skills/source/ref.md:1", { exact: true }).isVisible())
    await delayedRefresh(3)
    await page.waitForFunction(() => document.querySelector("#summary").textContent.includes("SKILL.md only"))
    assert.equal(await nested.getAttribute("aria-checked"), "false")
    assert.equal(await inspector.getByText("~/.config/opencode/skills/source/ref.md:1", { exact: true }).count(), 0)

    // Keep the existing short labels and ordinary wheel scrolling on phones.
    await page.setViewportSize({ width: 390, height: 700 })
    for (const name of ["Problems", "Hidden", "Nested", "Watch"]) assert.ok(await page.getByRole("switch", { name, exact: true }).isVisible())
    await page.locator("#graph").hover()
    const before = await page.evaluate(() => ({ y: document.body.scrollTop, box: document.querySelector("#graph").getAttribute("viewBox") }))
    await page.mouse.wheel(0, 500)
    await page.waitForFunction((y) => document.body.scrollTop > y, before.y)
    assert.equal(await page.locator("#graph").getAttribute("viewBox"), before.box)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("embedded panel follows project switches, rejects stale reads, colors scopes, and copies project paths", { skip: !playwright && "Playwright not installed; set PLAYWRIGHT_MODULE to enable", timeout: 60000 }, async () => {
  // Exercise the real panel and UI kit inside an iframe, substituting only the
  // host transport. No personal project or global skill files are consulted.
  const bundled = await build({
    entryPoints: ["panel/main.ts"], bundle: true, platform: "browser", write: false,
    plugins: [{ name: "fixture-host", setup(build) {
      build.onResolve({ filter: /^@openchamber\/sdk$/ }, () => ({ path: "host", namespace: "fixture" }))
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export class HostRequestError extends Error {} export const connectHost = () => window.parent.fixtureHost;" }))
    } }],
  })
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname
    if (path === "/") return response.end('<iframe src="/panel" style="width:1100px;height:800px;border:0"></iframe>')
    response.setHeader("Content-Type", path === "/main.js" ? "text/javascript" : path === "/styles.css" ? "text/css" : "text/html")
    response.end(path === "/main.js" ? bundled.outputFiles[0].contents : await readFile(new URL(path === "/styles.css" ? "../panel/styles.css" : "../panel/index.html", import.meta.url)))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  let browser
  try {
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) })
    const page = await browser.newPage({ viewport: { width: 1150, height: 850 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript(() => {
      if (window.parent !== window) return
      const text = (id, body = "") => `---\nname: ${id}\ndescription: Fixture ${id}\n---\n${body}`
      const global = {
        "~/.config/opencode/skills/index.md": text("index", "`local` and `shared`"),
        "~/.config/opencode/skills/shared.md": text("shared"),
      }
      const projects = {
        "/project-a": { ".opencode/skills/local.md": text("local"), ".opencode/skills/shared.md": text("shared") },
        "/project-b": { ".opencode/skills/only-b.md": text("only-b") },
      }
      const tokens = Object.fromEntries(["background", "elevated", "foreground", "muted", "subtle", "border", "hover", "selection", "focus", "primary", "mutedSurface", "elevatedForeground", "active", "selectionForeground", "primaryForeground", "primaryText", "successText", "warningText", "errorText", "infoText", "success", "warning", "error", "info"].map((key) => [key, "#999999"]))
      // Reproduce a host theme with indistinguishable accent and info hues.
      Object.assign(tokens, { primary: "#3b67c4", info: "#3b67c4", background: "#151313", mutedSurface: "#151313", foreground: "#eeeeee", font: "sans-serif", mono: "monospace", radius: "8px" })
      const ctx = { directory: "/project-a", theme: { mode: "dark", tokens }, surface: "panel" }
      const missing = () => Object.assign(new Error("Missing fixture path"), { code: "NOT_FOUND" })
      const contents = () => ({ ...global, ...(projects[ctx.directory] ?? {}) })
      window.fixtureHost = {
        storage: { get: async () => ({ watch: false }), set: async () => {} },
        onReady(listener) { this.ready = listener; queueMicrotask(() => listener(ctx)) },
        onDirectory(listener) { this.changed = listener },
        switch(directory, ready = false) { ctx.directory = directory; if (ready) this.ready(ctx); else this.changed(directory) },
        theme(mode) { ctx.theme.mode = mode; ctx.theme.tokens.background = ctx.theme.tokens.mutedSurface = mode === "light" ? "#f4f5f7" : "#151313"; this.ready(ctx) },
        hold() { this.entered = false; this.gate = new Promise((resolve, reject) => { this.release = resolve; this.reject = reject }) },
        async listDir(path) {
          const data = contents()
          if (this.gate && path === ".opencode/skills") { const gate = this.gate; this.gate = null; this.entered = true; await gate }
          const entries = new Map()
          for (const file of Object.keys(data)) {
            if (!file.startsWith(`${path}/`)) continue
            const tail = file.slice(path.length + 1)
            entries.set(tail.split("/")[0], { name: tail.split("/")[0], kind: tail.includes("/") ? "directory" : "file" })
          }
          if (!entries.size) throw missing()
          return { entries: [...entries.values()] }
        },
        async readFile(path) { const content = contents()[path]; if (!content) throw missing(); return { content } },
        async stat(path) { return { kind: "file", mtime: 1, size: contents()[path]?.length ?? 0 } },
        async writeClipboard(text) { this.clipboard = text },
        async toast() {},
      }
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const frame = page.frameLocator("iframe")
    const waitSummary = async (text) => page.waitForFunction((text) => document.querySelector("iframe").contentDocument.querySelector("#summary").textContent.includes(text), text)
    await waitSummary("2 project / 1 global")
    const inspector = frame.locator("#inspector")
    assert.equal(await frame.locator(".node.project").count(), 2)
    assert.equal(await frame.locator(".node.global").count(), 1)
    const rgb = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number)
    const luminance = (color) => rgb(color).map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
    let previousColors
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => fixtureHost.theme(mode), mode)
      const colors = await frame.locator("body").evaluate((body) => {
        const style = (selector) => getComputedStyle(body.querySelector(selector))
        return {
          global: style('.node[data-key="index"] .shape').fill,
          project: style('.node[data-key="local"] .shape').fill,
          globalLabel: style('.node[data-key="index"] text').fill,
          projectLabel: style('.node[data-key="local"] text').fill,
          globalLegend: style(".glyph.global").backgroundColor,
          projectLegend: style(".glyph.project").backgroundColor,
          globalBadge: style(".badge.global").color,
          projectBadge: style(".badge.project").color,
          canvas: style("#canvas").backgroundColor,
        }
      })
      assert.ok(Math.hypot(...rgb(colors.global).map((v, i) => v - rgb(colors.project)[i])) > 150, `${mode}: visibly separated scope palette, not merely unequal colors`)
      for (const scope of ["global", "project"]) {
        for (const suffix of ["Label", "Legend", "Badge"]) assert.deepEqual(rgb(colors[scope + suffix]), rgb(colors[scope]), `${mode}: ${scope} ${suffix} matches its nodes`)
        assert.ok(contrast(colors[scope + "Label"], colors.canvas) >= 4.5, `${mode}: ${scope} text contrast`)
      }
      if (previousColors) assert.notDeepEqual(colors, previousColors, "live theme changes adapt the scope palette")
      previousColors = colors
    }
    await inspector.locator(".skill-list").getByRole("button", { name: "shared", exact: true }).click()
    assert.ok(await inspector.getByText("Overrides", { exact: true }).isVisible())
    await inspector.locator(".facts").getByRole("button", { name: ".opencode/skills/shared.md", exact: true }).click()
    assert.equal(await page.evaluate(() => fixtureHost.clipboard), "/project-a/.opencode/skills/shared.md")

    // Both successful and failed old reads must be discarded, even with Watch off.
    for (const reject of [false, true]) {
      await page.evaluate(() => fixtureHost.switch("/project-a", true))
      await waitSummary("2 project / 1 global")
      await page.evaluate(() => fixtureHost.hold())
      await frame.getByRole("button", { name: "Refresh", exact: true }).click()
      await page.waitForFunction(() => fixtureHost.entered)
      await page.evaluate(() => fixtureHost.switch("/project-b"))
      assert.equal(await frame.locator(".node").count(), 0, "clear old graph immediately on directory change")
      await page.evaluate((reject) => reject ? fixtureHost.reject(new Error("Old project read failed")) : fixtureHost.release(), reject)
      await waitSummary("Directory: /project-b")
      assert.equal(await frame.locator('.node[data-key="local"]').count(), 0)
      assert.equal(await frame.locator('.node[data-key="only-b"]').count(), 1)
      assert.equal(await frame.locator("#banner").textContent(), "")
      assert.equal(await inspector.getByRole("heading", { name: "shared", exact: true }).count(), 0, "selection resets across projects")
    }
    // Returning to the same directory is still a new context generation.
    await page.evaluate(() => fixtureHost.switch("/project-a"))
    await waitSummary("2 project / 1 global")
    await page.evaluate(() => fixtureHost.hold())
    await frame.getByRole("button", { name: "Refresh", exact: true }).click()
    await page.waitForFunction(() => fixtureHost.entered)
    await page.evaluate(() => { fixtureHost.switch("/project-b"); fixtureHost.switch("/project-a"); fixtureHost.reject(new Error("Stale A read")) })
    await waitSummary("Directory: /project-a")
    assert.equal(await frame.locator("#banner").textContent(), "")
    assert.equal(await frame.locator('.node[data-key="local"]').count(), 1)
    await page.evaluate(() => fixtureHost.switch(null))
    await waitSummary("No project open: global only")
    assert.equal(await frame.locator(".node.project").count(), 0)
    assert.equal(await frame.locator(".node.global").count(), 2)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
