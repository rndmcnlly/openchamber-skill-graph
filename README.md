# Skill Graph for OpenChamber

**See what your agent can discover, and how your skills connect.**

![Skill Graph showing an example library, with exposed indexes connected to hidden specialist skills and a selected skill's references in the inspector.](docs/skill-graph.png)

*An example skill library in the extension's full-screen view. Select a skill to follow its connections and inspect the source behind each link.*

As a skill library grows, it gets harder to tell which instructions the agent sees up front, which it loads later, and which it may never find. Skill Graph gives you a map of that library inside [OpenChamber](https://openchamber.dev).

## Is it for you?

It's useful when you're writing or reorganizing OpenCode skills and want to:

- **Keep discovery lean.** See the exposed skills alongside the hidden specialists they point to.
- **Find overlooked skills.** Spot hidden skills with no recorded path from an exposed entry point.
- **Catch broken definitions.** Find missing descriptions, malformed frontmatter, naming mismatches, and missing files.
- **Check the evidence.** Click a connection to see the exact file, line, and text that created it.

The graph follows written references, not model behavior. It doesn't predict which skill an agent will choose, and it doesn't need an AI API or send your skill contents anywhere.

**Current scope:** the local `~/.config/opencode/skills` folder. Project-local skills, other skill directories, and overrides across directories aren't included yet.

## Install

You'll need **OpenChamber 2.5.0 or newer**, plus **Node.js 22.18+**, npm, and the `zip` command to build the extension.

```sh
git clone https://github.com/rndmcnlly/openchamber-skill-graph.git
cd openchamber-skill-graph
npm ci
npm run package
```

1. In OpenChamber, open **Settings → Extensions → Add**.
2. Paste the absolute path to your cloned `openchamber-skill-graph` folder, or select the generated `dist/openchamber-skill-graph.zip`.
3. Approve access to `~/.config/opencode/skills` and its contents.
4. Open **Skill Graph** from the extension rail. Use the expand button or the **Extension pages** menu for more room.

The extension only reads files. OpenChamber's filesystem permission also permits writes within the approved folder, but Skill Graph does not use that ability. It doesn't change your skills or run a background service.

The source checkout must be built before installation. If you install from the folder, rebuild and reopen the panel after updating it. If you install the ZIP, install a newly built ZIP to update.

## Explore your library

**Click a skill** to see its description, whether it's exposed or hidden, and its incoming and outgoing references. **Click a connection** to inspect its source. Filled nodes are exposed; hollow nodes are hidden. An extra outline means the skill has supporting files.

Search by name or description, or use the four switches:

| Switch | What it does |
| --- | --- |
| **Problems** | Focus on skills with errors or warnings. |
| **Hidden** | Include skills that aren't advertised to the agent. |
| **Nested** | Look for references in supporting Markdown files too. |
| **Watch** | Refresh automatically as files change while the panel is visible. |

Drag the graph to pan. Use **+**, **−**, or **Fit** to adjust the view. In wide mode, scrolling zooms; in a narrow panel, scrolling moves down to the details instead. Ctrl/Command-scroll still zooms in the narrow view.

A warning that a hidden skill is *unreachable* means no written reference leads to it from an exposed skill. It can still be loaded explicitly. If a connection looks surprising, inspect its evidence before changing your library.

## Development

See [AGENTS.md](AGENTS.md) for the implementation map, parsing rules, tests, and packaging details. Bug reports and contributions are welcome through [GitHub Issues](https://github.com/rndmcnlly/openchamber-skill-graph/issues).
