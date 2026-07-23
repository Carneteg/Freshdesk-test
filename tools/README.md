# tools/ — shareable-document generators

One **data spec** renders to **Word, PowerPoint, or a self-contained HTML page**
(the HTML works well as a Claude Artifact). Used for the project's status and
roadmap one-pagers/decks.

> Node-only. The product code is Deno; `docx` and `pptxgenjs` are Node libraries,
> so these generators live here and are never imported by the pipeline.

## Structure — data vs presentation

```
tools/
  render.js          PRESENTATION — renderDocx / renderPptx / renderHtml + a CLI.
                     Takes a "doc spec" and knows nothing about specific content.
  content/
    status.js        DATA — Gate 1 status (built / not built / how to develop).
    roadmap.js       DATA — Gate 2+ roadmap (mirrors docs/roadmap.md).
```

To change wording, edit `content/*.js`. To add a new document, add a new
`content/<name>.js` — **never copy the renderer.**

## The doc spec

```js
module.exports = {
  title:    "…",
  subtitle: "…",          // optional
  intro:    "…",          // optional lead paragraph
  sections: [
    { heading: "…", items: [ { lead: "Bold lead. ", text: "rest" }, { text: "plain bullet" } ] },
  ],
  closing:  "…",          // optional italic closing line
};
```

## Run

```bash
cd tools
npm install                              # once — installs docx + pptxgenjs

node render.js roadmap pptx roadmap.pptx  # PowerPoint from content/roadmap.js
node render.js status  docx status.docx   # Word from content/status.js
node render.js roadmap html roadmap.html  # self-contained HTML (Artifact-ready)
```

`node render.js <content> <format> [outfile]`
- `<content>` — `status`, `roadmap`, or a path to a spec file.
- `<format>` — `docx`, `pptx`, or `html`.

The `shareable-docs` Claude skill (`.claude/skills/shareable-docs/`) wraps this.
