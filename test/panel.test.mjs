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
      const button = inspector.getByRole("button", { name: subject, exact: true })
      await button.focus()
      await page.keyboard.press("Enter")
      await assertHeadingFocus(subject)
      assert.ok(await inspector.getByText("skill-md-case", { exact: true }).isVisible())
      assert.ok(await inspector.locator(".location").count())
      await overview()
    }
    await inspector.getByRole("button", { name: "orphan", exact: true }).focus()
    await page.keyboard.press("Enter")
    await assertHeadingFocus("orphan/")
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
    assert.ok(await inspector.getByText("source/ref.md:1", { exact: true }).isVisible())
    await delayedRefresh(3)
    await page.waitForFunction(() => document.querySelector("#summary").textContent.includes("SKILL.md only"))
    assert.equal(await nested.getAttribute("aria-checked"), "false")
    assert.equal(await inspector.getByText("source/ref.md:1", { exact: true }).count(), 0)

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
