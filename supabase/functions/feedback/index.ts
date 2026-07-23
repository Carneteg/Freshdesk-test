// feedback — records the agent's one-click verdict on a suggestion.
//
// The private note carries three links (👍/✏️/👎), each pointing here with the
// suggestion's unguessable feedback_token and a verdict. Clicking one writes the
// verdict straight into `suggestions` and shows a small confirmation page. This is
// the "would I have sent this?" signal the whole experiment exists to collect (§8),
// and the corpus a Gate 2 learning loop would train on.
//
// Deploy with --no-verify-jwt: the agent clicks from their browser (no Supabase
// JWT). Access is gated by the per-note token, which only appears in the private
// note. The only write is a single verdict column on one row — deliberately narrow.

import { createClient } from "npm:@supabase/supabase-js@2";

const VERDICTS: Record<string, string> = {
  usable: "Would send",
  edited: "Would send with edits",
  unusable: "Would not send",
};

function page(title: string, heading: string, body: string, status = 200): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title></head><body>` +
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:32rem;` +
    `margin:4rem auto;padding:0 1rem;text-align:center;color:#1a1a1a">` +
    `<h2 style="margin-bottom:.5rem">${heading}</h2>${body}</div></body></html>`;
  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(html, { status, headers });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  const verdict = url.searchParams.get("v") ?? "";

  if (!token || !(verdict in VERDICTS)) {
    return page("Feedback", "Invalid link", "<p>This feedback link is missing or malformed.</p>", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return page("Feedback", "Not configured", "<p>The feedback service is not configured.</p>", 500);
  }

  try {
    const db = createClient(supabaseUrl, serviceKey);
    // Match on the unguessable token; set the verdict + when it was recorded.
    const { data, error } = await db
      .from("suggestions")
      .update({ verdict, verdict_at: new Date().toISOString() })
      .eq("feedback_token", token)
      .select("ticket_id")
      .maybeSingle();

    if (error) {
      return page("Feedback", "Couldn't record that", "<p>Something went wrong saving your verdict. Please try again.</p>", 500);
    }
    if (!data) {
      return page("Feedback", "Link not found", "<p>We couldn't find a matching suggestion — this may be an old or already-superseded note.</p>", 404);
    }

    const label = VERDICTS[verdict];
    return page(
      "Feedback recorded",
      `✅ Recorded: ${label}`,
      `<p>Thanks — your verdict on ticket #${data.ticket_id} is saved. You can close this tab.</p>` +
        `<p style="color:#666;font-size:.9em">Changed your mind? Just click a different option in the note.</p>`,
    );
  } catch (_e) {
    return page("Feedback", "Couldn't record that", "<p>Something went wrong. Please try again.</p>", 500);
  }
});
