// scripts/upload_review_ui.ts — upload web/review.html to the public `app` Storage
// bucket with the CORRECT content-type (text/html), so the hosted URL renders as a
// page instead of showing raw source.
//
// Supabase Storage stores a per-object content-type at upload time; the dashboard
// upload left it as text/plain here, which makes browsers show source. This uploads
// with an explicit `content-type: text/html` header and `x-upsert: true` (overwrite
// + cache-bust). Run it whenever you change the app:
//
//   deno run --env-file=.env --allow-env --allow-net --allow-read scripts/upload_review_ui.ts
//
// After it prints 200, open (hard-refresh, or add ?v=2 to bust the CDN):
//   https://pqwnpcibymtmcpnqlkle.supabase.co/storage/v1/object/public/app/review.html

const url = Deno.env.get("SUPABASE_URL") ?? "https://pqwnpcibymtmcpnqlkle.supabase.co";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!key) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY (it's in your .env).");
  Deno.exit(1);
}

const html = await Deno.readTextFile(new URL("../web/review.html", import.meta.url));

// Upload to a FRESH object name (coach.html) so we don't hit the CDN copy of
// review.html that was cached as text/plain. The request Content-Type header
// becomes the object's served content-type.
const OBJECT = "coach.html";
const res = await fetch(`${url}/storage/v1/object/app/${OBJECT}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${key}`,
    apikey: key,
    "content-type": "text/html; charset=utf-8", // <- served content-type
    "cache-control": "no-cache",
    "x-upsert": "true", // overwrite if it already exists
  },
  body: html,
});

const bodyText = await res.text();
console.log("HTTP", res.status, bodyText);
if (res.ok) {
  console.log("\n✅ Uploaded as text/html. Open this URL (hard-refresh):");
  console.log(`${url}/storage/v1/object/public/app/${OBJECT}`);
} else {
  console.error("\n❌ Upload failed. Copy the HTTP line above and send it back.");
  Deno.exit(1);
}
