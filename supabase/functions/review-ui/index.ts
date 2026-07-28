// review-ui — compatibility redirect to the canonical Coach Review app.
//
// The old implementation duplicated web/review.html and wrote review fields
// directly on suggestions. That path is intentionally gone: migration 31 stores
// reviewer-owned state in suggestion_reviews and exposes authenticated RPCs.
//
// Keep this public Edge Function only as a stable legacy URL. The target app is
// public HTML, but all data and writes remain protected by Supabase Auth + RLS.

const REVIEW_APP_URL = Deno.env.get("REVIEW_APP_URL") ?? "";

Deno.serve((request: Request) => {
  if (!REVIEW_APP_URL) {
    return new Response("Coach Review is not configured.", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  let target: URL;
  try {
    target = new URL(REVIEW_APP_URL);
  } catch {
    return new Response("Coach Review configuration is invalid.", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const source = new URL(request.url);
  if (target.origin === source.origin && target.pathname === source.pathname) {
    return new Response("Coach Review redirect points to itself.", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return new Response(null, {
    status: 307,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
});
