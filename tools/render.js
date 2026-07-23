// tools/render.js — ONE parameterised renderer, THREE output formats.
//
// The repo's product logic is Deno; these document generators are the only Node
// code, because `docx` and `pptxgenjs` are Node-only. They are intentionally
// isolated here and never imported by the pipeline.
//
// Separation of concerns:
//   • DATA (what to say)  lives in tools/content/*.js as a "doc spec" (below).
//   • PRESENTATION (how it looks) lives here: renderDocx / renderPptx / renderHtml.
// The SAME spec renders to Word, PowerPoint, or a self-contained HTML page that
// works well as a Claude Artifact. Add a new document by adding a content file —
// never by copying this renderer.
//
// Doc spec shape:
//   {
//     title:    string,
//     subtitle?: string,
//     intro?:   string,
//     sections: [ { heading: string, items: [ { lead?: string, text: string } ] } ],
//     closing?: string,   // italic closing line
//   }
//
// CLI:  node tools/render.js <content> <format> [outfile]
//   <content>  status | roadmap | ./path/to/spec.js
//   <format>   docx | pptx | html
// e.g.  node tools/render.js roadmap pptx roadmap.pptx

const path = require("path");
const fs = require("fs");

// Shared palette (deep-blue / teal executive) — kept in one place for all formats.
const C = {
  navy: "21295C", blue: "065A82", teal: "1C7293", mint: "02C39A",
  ink: "1A2233", mute: "5A6472", light: "EEF3F6", white: "FFFFFF", iceText: "CADCFC",
};

// ── Word ──────────────────────────────────────────────────────────────────────
async function renderDocx(spec) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat, AlignmentType,
  } = require("docx");
  const ref = "bullets";
  const kids = [];
  kids.push(new Paragraph({ children: [new TextRun({ text: spec.title, bold: true, size: 32 })], spacing: { after: 60 } }));
  if (spec.subtitle) kids.push(new Paragraph({ children: [new TextRun({ text: spec.subtitle, italics: true, color: "555555" })], spacing: { after: 200 } }));
  if (spec.intro) kids.push(new Paragraph({ children: [new TextRun({ text: spec.intro, size: 22 })], spacing: { after: 160 } }));
  for (const s of spec.sections) {
    kids.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
    for (const it of s.items) {
      const runs = it.lead
        ? [new TextRun({ text: it.lead, bold: true }), new TextRun(it.text || "")]
        : [new TextRun(it.text || "")];
      kids.push(new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs, spacing: { after: 60 } }));
    }
  }
  if (spec.closing) kids.push(new Paragraph({ children: [new TextRun({ text: spec.closing, italics: true })], spacing: { before: 240 } }));

  const doc = new Document({
    numbering: {
      config: [{
        reference: ref,
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 480, hanging: 240 } } },
        }],
      }],
    },
    sections: [{ children: kids }],
  });
  return Packer.toBuffer(doc);
}

// ── PowerPoint ─────────────────────────────────────────────────────────────────
async function renderPptx(spec, outPath) {
  const pptxgen = require("pptxgenjs");
  const p = new pptxgen();
  p.layout = "LAYOUT_WIDE"; // 13.33 x 7.5

  // Title slide (dark).
  const t = p.addSlide();
  t.background = { color: C.navy };
  t.addText(spec.title, { x: 0.7, y: 1.7, w: 12, h: 1.0, fontFace: "Cambria", fontSize: 40, bold: true, color: C.white });
  if (spec.subtitle) t.addText(spec.subtitle, { x: 0.72, y: 2.75, w: 12, h: 0.6, fontFace: "Calibri", fontSize: 20, color: C.iceText });
  if (spec.intro) t.addText(spec.intro, { x: 0.72, y: 3.5, w: 11.8, h: 1.3, fontFace: "Calibri", fontSize: 14, italic: true, color: C.iceText });

  // One content slide per section (heading + bullet list). Bullets are plain runs
  // for reliability; emphasis stays in the Word/HTML formats.
  for (const s of spec.sections) {
    const sl = p.addSlide();
    sl.background = { color: C.white };
    sl.addText(s.heading, { x: 0.6, y: 0.45, w: 12.1, h: 0.7, fontFace: "Cambria", fontSize: 27, bold: true, color: C.blue });
    const bullets = s.items.map((it, i) => ({
      text: (it.lead || "") + (it.text || ""),
      options: {
        bullet: { code: "2022", indent: 16 },
        breakLine: i < s.items.length - 1,
        paraSpaceAfter: 10, color: C.ink,
      },
    }));
    sl.addText(bullets, { x: 0.75, y: 1.35, w: 11.8, h: 5.7, fontFace: "Calibri", fontSize: 14, valign: "top" });
  }
  await p.writeFile({ fileName: outPath });
  return outPath;
}

// ── HTML (Claude Artifact-friendly, self-contained, light/dark aware) ──────────
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderHtml(spec) {
  const sections = spec.sections.map((s) => {
    const items = s.items.map((it) =>
      `<li>${it.lead ? `<strong>${esc(it.lead)}</strong>` : ""}${esc(it.text || "")}</li>`
    ).join("\n");
    return `<section><h2>${esc(s.heading)}</h2><ul>${items}</ul></section>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title)}</title>
<style>
  :root{--bg:#fff;--fg:#1a2233;--mut:#5a6472;--accent:#065a82;--card:#eef3f6}
  @media (prefers-color-scheme: dark){:root{--bg:#12161f;--fg:#e7ecf3;--mut:#9aa6b5;--accent:#4aa3c7;--card:#1b2230}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:60rem;margin:0 auto;padding:3rem 1.25rem}
  h1{font-size:2rem;margin:0 0 .25rem}
  .sub{color:var(--mut);font-style:italic;margin:0 0 1.25rem}
  .intro{color:var(--fg);margin:0 0 1.5rem}
  h2{color:var(--accent);font-size:1.2rem;margin:1.75rem 0 .5rem}
  ul{margin:.25rem 0 0;padding-left:1.2rem}
  li{margin:.35rem 0}
  .closing{margin-top:2rem;color:var(--mut);font-style:italic}
</style></head><body><main>
  <h1>${esc(spec.title)}</h1>
  ${spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : ""}
  ${spec.intro ? `<p class="intro">${esc(spec.intro)}</p>` : ""}
  ${sections}
  ${spec.closing ? `<p class="closing">${esc(spec.closing)}</p>` : ""}
</main></body></html>`;
}

module.exports = { renderDocx, renderPptx, renderHtml };

// ── CLI ────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [content, format, outArg] = process.argv.slice(2);
  if (!content || !format) {
    console.error("Usage: node tools/render.js <status|roadmap|path> <docx|pptx|html> [outfile]");
    process.exit(1);
  }
  const specPath = fs.existsSync(content) ? path.resolve(content) : path.join(__dirname, "content", content + ".js");
  const spec = require(specPath);
  const out = outArg || `${path.basename(content).replace(/\.js$/, "")}.${format}`;

  (async () => {
    if (format === "docx") {
      fs.writeFileSync(out, await renderDocx(spec));
    } else if (format === "pptx") {
      await renderPptx(spec, out);
    } else if (format === "html") {
      fs.writeFileSync(out, renderHtml(spec));
    } else {
      console.error(`unknown format: ${format} (use docx | pptx | html)`);
      process.exit(1);
    }
    console.log("wrote", out);
  })();
}
