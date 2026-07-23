---
name: shareable-docs
description: Generate a shareable Word, PowerPoint, or HTML page from the project's status or roadmap. Use when the user asks for a doc/deck/one-pager (e.g. of the Gate 1 status or the development roadmap) to share with others.
---

# Generate a shareable document

Renders the project's status or roadmap to **Word / PowerPoint / HTML** from a
single data spec. Reuses `tools/render.js` — **never re-implement the rendering.**

## When to use
- "Make a deck / Word doc / one-pager of the status (or roadmap)."
- "Give me something to share with the team / management."

## How it is structured (data vs presentation)
- `tools/content/*.js` — the **content** (`status`, `roadmap`) as data.
- `tools/render.js` — the **renderer** (`docx` / `pptx` / `html`).
- Full details: `tools/README.md`.

## Steps
1. One-time: `cd tools && npm install` (installs `docx` + `pptxgenjs`).
2. If the content is stale, edit `tools/content/<name>.js` — **do not** hardcode
   content in the renderer.
3. Render:
   ```bash
   node tools/render.js <status|roadmap|path> <docx|pptx|html> [outfile]
   # e.g.
   node tools/render.js roadmap pptx roadmap.pptx
   node tools/render.js status  docx status.docx
   node tools/render.js roadmap html roadmap.html
   ```
4. Deliver the file to the user with **SendUserFile**. QA first when possible
   (`markitdown` for content; the pptx skill's `validate.py` for the deck).
5. For an **HTML** output: it is self-contained and theme-aware, so it can be
   published as a **Claude Artifact** (load the `artifact-design` skill first, then
   the Artifact tool) when the user wants a shareable link rather than a file.

## Add a new document type
Add `tools/content/<name>.js` following the doc-spec shape in `tools/README.md`,
then render it with the same command. One spec → all three formats.
