import { assertEquals } from "./test_assert.ts";
import { Freshdesk, slugify } from "./clients.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("Freshdesk note POST is never retried automatically", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response("upstream failed", { status: 500 }));
  }) as typeof fetch;
  try {
    const fd = new Freshdesk("example", "key");
    let threw = false;
    try {
      await fd.postPrivateNote(42, "<p>test</p>");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("Freshdesk updated-ticket scan paginates until a short page", async () => {
  const original = globalThis.fetch;
  const pages: number[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    const count = page === 1 ? 100 : 1;
    const rows = Array.from({ length: count }, (_, i) => ({
      id: (page - 1) * 100 + i + 1,
      subject: "safe synthetic",
      responder_id: 1,
      updated_at: "2026-07-28T00:00:00Z",
      status: 2,
    }));
    return Promise.resolve(json(rows));
  }) as typeof fetch;
  try {
    const fd = new Freshdesk("example", "key");
    const rows = await fd.listAllUpdatedTickets("2026-07-27T00:00:00Z");
    assertEquals(rows.length, 101);
    assertEquals(pages, [1, 2]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("Freshdesk delivery recovery finds a private note marker", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      json({
        id: 42,
        subject: "safe synthetic",
        responder_id: 1,
        updated_at: "2026-07-28T00:00:00Z",
        status: 2,
        description_text: "question",
        conversations: [
          {
            id: 9001,
            body_text: "AI generation simployer-ai-generation:77",
            incoming: false,
            private: true,
            created_at: "2026-07-28T00:01:00Z",
          },
        ],
      }),
    )) as typeof fetch;
  try {
    const fd = new Freshdesk("example", "key");
    assertEquals(
      await fd.findPrivateNoteByMarker(42, "simployer-ai-generation:77"),
      9001,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ── Customer knowledge-base links ────────────────────────────────────────────
// The portal path was CONFIRMED against a real article supplied by the team:
//   https://simployer.freshdesk.com/en/support/solutions/articles/201000115133-expert-invoice
// which is why these assert the slugged form. A bare `/articles/{id}` guess —
// the shape assumed before that URL arrived — would have been wrong.

Deno.test("portalArticleUrl: reproduces the confirmed live article URL", () => {
  const fd = new Freshdesk("simployer", "key");
  assertEquals(
    fd.portalArticleUrl(201000115133, { title: "Expert invoice" }),
    "https://simployer.freshdesk.com/en/support/solutions/articles/201000115133-expert-invoice",
  );
});

Deno.test("portalArticleUrl: agent and customer links are different targets", () => {
  const fd = new Freshdesk("simployer", "key");
  // The agent link sits behind the Freshdesk login and must never be sent to a
  // customer; the portal link is the one that can be pasted into a reply.
  assertEquals(
    fd.articleUrl(201000115133),
    "https://simployer.freshdesk.com/a/solutions/articles/201000115133",
  );
  assertEquals(fd.kbHome(), "https://simployer.freshdesk.com/en/support/home");
  assertEquals(fd.kbHome("sv-SE"), "https://simployer.freshdesk.com/sv-SE/support/home");
});

Deno.test("portalArticleUrl: falls back to the bare id when no title is known", () => {
  const fd = new Freshdesk("simployer", "key");
  assertEquals(
    fd.portalArticleUrl(123),
    "https://simployer.freshdesk.com/en/support/solutions/articles/123",
  );
});

Deno.test("slugify: Nordic titles transliterate rather than lose letters", () => {
  // The KB is largely Norwegian and Swedish, so this is the common case.
  assertEquals(slugify("Fravær og sykemelding"), "fravaer-og-sykemelding");
  assertEquals(slugify("Ansettelse – ny medarbeider"), "ansettelse-ny-medarbeider");
  assertEquals(slugify("Semesterårsavslut (Sverige)"), "semesterarsavslut-sverige");
  assertEquals(slugify("Expert invoice"), "expert-invoice");
  assertEquals(slugify("  Trailing / leading  "), "trailing-leading");
  assertEquals(slugify(""), "");
});
