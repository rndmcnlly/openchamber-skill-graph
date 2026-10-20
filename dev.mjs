// Development preview outside OpenChamber: serves panel/ and a read-only
// stand-in for the host's listDir/readFile/stat, limited to the skills root.
// Never packaged. Usage: npm run build && npm run dev [-- port]
// SKILL_GRAPH_ROOT=/some/dir previews another tree (for example a test fixture)
// while the panel still asks for ~/.config/opencode/skills paths.
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { nodeFiles } from "./report.ts"

const root = fileURLToPath(new URL(".", import.meta.url))
const port = Number(process.argv[2] ?? 4317)
const SKILLS = "~/.config/opencode/skills"
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost")
  try {
    if (url.pathname === "/__fs") {
      const path = url.searchParams.get("path") ?? ""
      if (!(path === SKILLS || path.startsWith(`${SKILLS}/`)) || path.split("/").includes("..")) throw new Error("Outside the skills root")
      const op = url.searchParams.get("op")
      const real = process.env.SKILL_GRAPH_ROOT ? process.env.SKILL_GRAPH_ROOT + path.slice(SKILLS.length) : path
      const body = op === "list" ? { entries: await nodeFiles.listDir(real) } : op === "read" ? { content: await nodeFiles.readFile(real) } : await nodeFiles.stat(real)
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body))
      return
    }
    const file = normalize(join(root, "panel", url.pathname === "/" ? "index.html" : url.pathname))
    if (!file.startsWith(join(root, "panel"))) throw new Error("Not found")
    const body = await readFile(file)
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(body)
  } catch (error) {
    if (response.headersSent) return response.end()
    response.writeHead(404, { "Content-Type": "text/plain" }).end(String(error instanceof Error ? error.message : error))
  }
}).listen(port, "127.0.0.1", () => console.log(`Skill Graph preview at http://127.0.0.1:${port}/`))
