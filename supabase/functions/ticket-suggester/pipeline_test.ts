import { assertEquals } from "./test_assert.ts";
import { stripHtmlForPrompt } from "./pipeline.ts";

Deno.test("stripHtmlForPrompt: plain text passes through untouched", () => {
  const text = "Hei!\n\nGå til Innstillinger > Roller.\n\nMvh";
  assertEquals(stripHtmlForPrompt(text), text);
});

Deno.test("stripHtmlForPrompt: formatted gold answers become clean prose", () => {
  const html = "<p>Hei!</p><p>Slik løser du det:</p>" +
    "<ul><li>Åpne <b>Innstillinger</b></li><li>Velg <i>Roller</i></li></ul>" +
    '<p>Se <a href="https://support.simployer.com/a">artikkelen</a>.</p>';
  assertEquals(
    stripHtmlForPrompt(html),
    // the list end acts as a paragraph break
    "Hei!\nSlik løser du det:\n- Åpne Innstillinger\n- Velg Roller\n\nSe artikkelen.",
  );
});

Deno.test("stripHtmlForPrompt: entities decode once, ampersand last (no double-decode)", () => {
  assertEquals(
    stripHtmlForPrompt("L&#39;avtal: 1 &lt; 2 &amp;&nbsp;&quot;ok&quot; &amp;lt;kept&amp;gt;"),
    // &amp;lt; is the LITERAL text "&lt;" — it must not double-decode to "<".
    'L\'avtal: 1 < 2 & "ok" &lt;kept&gt;',
  );
});
