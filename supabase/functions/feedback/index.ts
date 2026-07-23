// feedback — records the agent's one-click verdict on a suggestion.
//
// The private note carries three links (👍/✏️/👎), each pointing here with the
// suggestion's unguessable feedback_token and a verdict. Clicking one writes the
// verdict straight into `suggestions` and shows a short confirmation. This is the
// "would I have sent this?" signal the whole experiment exists to collect (§8), and
// the corpus a Gate 2 learning loop would train on.
//
// The confirmation is PLAIN TEXT on purpose: Supabase's edge-runtime would not
// reliably serve our HTML as text/html (it rendered as raw source in the browser),
// so a clean plain-text response is the robust choice for a throwaway confirm tab.
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

function text(body: string, status = 200): Response {
  const headers = new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(body, { status, headers });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  const verdict = url.searchParams.get("v") ?? "";

  if (!token || !(verdict in VERDICTS)) {
    return text("This feedback link is missing or malformed.", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return text("The feedback service is not configured.", 500);
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
      return text("Something went wrong saving your verdict. Please try again.", 500);
    }
    if (!data) {
      return text("We couldn't find a matching suggestion — this may be an old or already-superseded note.", 404);
    }

    const label = VERDICTS[verdict];
    return text(
      `✅ Recorded: ${label}.\n\n` +
        `Your verdict on ticket #${data.ticket_id} is saved — you can close this tab.\n\n` +
        `Changed your mind? Just click a different option in the note.`,
    );
  } catch (_e) {
    return text("Something went wrong. Please try again.", 500);
  }
});
