// Legacy feedback confirmation.
//
// New private notes link to the authenticated Coach Review app. Older notes may
// still contain token links to this function, so they remain supported safely:
//   GET  -> shows a confirmation page and NEVER changes data
//   POST -> consumes one short-lived, generation-scoped token exactly once
//
// Deploy with --no-verify-jwt only for legacy links. The transactional database
// RPC records a separate suggestion_reviews row and mirrors the compatibility
// fields on suggestions.

import { createClient } from "npm:@supabase/supabase-js@2.110.8";

const VERDICTS: Record<string, string> = {
  usable: "Would send",
  edited: "Would send with edits",
  unusable: "Would not send",
};

function headers(contentType: string): Headers {
  const h = new Headers();
  h.set("Content-Type", `${contentType}; charset=utf-8`);
  h.set("Cache-Control", "no-store");
  h.set("Referrer-Policy", "no-referrer");
  h.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  return h;
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: headers("text/plain") });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function confirmPage(action: string, token: string, verdict: string): Response {
  const label = VERDICTS[verdict];
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Confirm Coach feedback</title>
<style>body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#202124}
button{font:inherit;background:#1f5eff;color:#fff;border:0;border-radius:.45rem;padding:.7rem 1rem;cursor:pointer}
.muted{color:#667085}</style></head>
<body><h1>Confirm feedback</h1><p>You selected: <strong>${esc(label)}</strong>.</p>
<p class="muted">Nothing has been saved yet.</p>
<form method="post" action="${esc(action)}">
<input type="hidden" name="t" value="${esc(token)}">
<input type="hidden" name="v" value="${esc(verdict)}">
<button type="submit">Save this verdict</button>
</form></body></html>`;
  return new Response(body, { status: 200, headers: headers("text/html") });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const token = url.searchParams.get("t") ?? "";
    const verdict = url.searchParams.get("v") ?? "";
    if (!token || !(verdict in VERDICTS)) {
      return text("This feedback link is missing or malformed.", 400);
    }
    // Deliberately no database write on GET: scanners, previews, and prefetchers
    // can open this URL without recording a verdict.
    return confirmPage(url.pathname, token, verdict);
  }

  if (req.method !== "POST") return text("Method not allowed.", 405);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text("Malformed feedback submission.", 400);
  }
  const token = String(form.get("t") ?? "");
  const verdict = String(form.get("v") ?? "");
  if (!token || !(verdict in VERDICTS)) {
    return text("This feedback submission is missing or malformed.", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return text("The feedback service is not configured.", 500);
  }

  try {
    const db = createClient(supabaseUrl, serviceKey);
    const { data, error } = await db.rpc("record_legacy_feedback", {
      p_token: token,
      p_verdict: verdict,
    });
    if (error) {
      const expired = /expired|already used|not found/i.test(error.message ?? "");
      return text(
        expired
          ? "This feedback link is expired or has already been used. Use the Coach Review app instead."
          : "Something went wrong saving your verdict. Please use the Coach Review app.",
        expired ? 409 : 500,
      );
    }
    return text(
      `Recorded: ${VERDICTS[verdict]}.\n\n` +
        `Your verdict on ticket #${data} is saved. You can close this tab.`,
    );
  } catch {
    return text("Something went wrong. Please use the Coach Review app.", 500);
  }
});
