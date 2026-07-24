// review-ui — a small, self-contained reviewer app served as an Edge Function.
//
// Phase 2 of the review-UI plan. It lets an allowlisted agent log in (Supabase
// Auth, magic link / email code), read the AI coach drafts, and record a verdict
// ("would I have sent this?") — the same signal the note buttons capture, but in a
// browsable list so agents can work through a batch.
//
// SECURITY MODEL (why this is safe to serve publicly):
//   • The page embeds only the ANON key — public by design. No service-role key,
//     no Freshdesk key, no OpenAI key ever reaches the browser.
//   • All data access is gated by RLS (migrations 18/19): only an authenticated
//     user whose email is in `app_reviewers` can read rows, and they can update
//     ONLY the verdict columns. A logged-out or non-allowlisted user sees nothing.
//   • The function is public (verify_jwt=false) because it only serves static HTML;
//     the privileged surface is the Supabase REST API, which the RLS protects.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://pqwnpcibymtmcpnqlkle.supabase.co";
// Public anon key (safe to embed; RLS does the real gating).
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxd25wY2lieW10bWNwbnFsa2xlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2NDQxNjQsImV4cCI6MjEwMDIyMDE2NH0.D-Fn0t2jzvyIE-VeIuZlWxinhJLiJPa0wOvv0oe0zEs";

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coach Review — Simployer Gate 1</title>
<style>
  :root{
    --bg:#F5F7F9;--surface:#fff;--surface-2:#EDF1F4;--border:#DCE3E8;
    --ink:#182029;--ink-2:#56636E;--ink-3:#8694A1;
    --accent:#0F766E;--accent-soft:#D6E8E5;
    --good:#2F855A;--good-soft:#DCEEE3;--warn:#B7791F;--warn-soft:#F3E8CE;
    --crit:#C0392B;--crit-soft:#F4D9D5;--info:#5B7089;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
    --radius:8px;--shadow:0 1px 2px rgba(24,32,41,.05),0 4px 16px rgba(24,32,41,.05);
  }
  @media(prefers-color-scheme:dark){:root{
    --bg:#0E1319;--surface:#151C24;--surface-2:#1C252F;--border:#2A3540;
    --ink:#E8EDF1;--ink-2:#A5B2BD;--ink-3:#6E7E8B;
    --accent:#4FD1C5;--accent-soft:#123A38;
    --good:#4FB784;--good-soft:#14301F;--warn:#E0A64B;--warn-soft:#33280F;
    --crit:#E86B5C;--crit-soft:#38191A;--info:#8AA0B5;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 16px rgba(0,0,0,.3);
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5;font-variant-numeric:tabular-nums}
  .wrap{max-width:920px;margin:0 auto;padding:24px 16px 80px}
  header.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:600}
  h1{font-size:22px;margin:2px 0 0;letter-spacing:-.02em}
  .who{margin-left:auto;font-size:13px;color:var(--ink-2);display:flex;align-items:center;gap:10px}
  button{font-family:inherit;cursor:pointer}
  .btn{border:1px solid var(--border);background:var(--surface);color:var(--ink);border-radius:6px;padding:7px 12px;font-size:13px;font-weight:600}
  .btn:hover{border-color:var(--accent)}
  .btn.small{padding:4px 9px;font-size:12px}
  .link{background:none;border:0;color:var(--accent);font-size:13px;padding:0;text-decoration:underline}

  /* auth */
  .auth{max-width:400px;margin:8vh auto 0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:26px;box-shadow:var(--shadow)}
  .auth h2{margin:0 0 4px;font-size:19px}
  .auth p{margin:0 0 18px;color:var(--ink-2);font-size:14px}
  .field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
  .field label{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
  input{font-family:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink)}
  input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;width:100%;padding:11px;font-size:14px}
  .btn.primary:hover{filter:brightness(1.06)}
  .msg{font-size:13px;margin-top:12px;padding:10px 12px;border-radius:6px}
  .msg.ok{background:var(--good-soft);color:var(--good)}
  .msg.err{background:var(--crit-soft);color:var(--crit)}
  .sep{display:flex;align-items:center;gap:10px;color:var(--ink-3);font-size:12px;margin:16px 0}
  .sep::before,.sep::after{content:"";flex:1;height:1px;background:var(--border)}

  /* tabs + counts */
  .bar{display:flex;gap:8px;align-items:center;margin:18px 0 16px;flex-wrap:wrap}
  .tab{border:1px solid var(--border);background:var(--surface);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;color:var(--ink-2)}
  .tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
  .count{margin-left:auto;font-size:12.5px;color:var(--ink-3);font-family:var(--mono)}

  /* card */
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px 18px;margin-bottom:14px}
  .chead{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:4px}
  .chead .id{font-family:var(--mono);font-size:12px;color:var(--ink-3)}
  .chead .subj{font-weight:650;font-size:15px}
  .tags{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px}
  .tag{font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:20px;background:var(--surface-2);color:var(--ink-2)}
  .tag.c-high{background:var(--good-soft);color:var(--good)}
  .tag.c-low{background:var(--warn-soft);color:var(--warn)}
  .tag.c-none{background:var(--surface-2);color:var(--ink-3)}
  .tag.qa{background:var(--accent-soft);color:var(--accent)}
  .tag.qa.review{background:var(--crit-soft);color:var(--crit)}
  .draft{white-space:pre-wrap;font-size:14px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin:2px 0 12px}
  .refbox{background:var(--good-soft);border:1px solid color-mix(in srgb,var(--good) 30%,transparent);border-radius:6px;padding:10px 12px;margin:0 0 12px;white-space:pre-wrap;font-size:13.5px}
  .refbox .rl{font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--good);display:block;margin-bottom:5px}
  .gold{margin:2px 0 12px}
  .gold .gl{font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);display:block;margin-bottom:5px}
  textarea{width:100%;min-height:88px;font-family:inherit;font-size:14px;line-height:1.5;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--ink);resize:vertical}
  textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
  .goldbar{display:flex;align-items:center;gap:12px;margin-top:8px;flex-wrap:wrap}
  .goldbar .st{font-size:12px;color:var(--ink-3)}
  .noreply{font-style:italic;color:var(--ink-3);font-size:13.5px;margin:2px 0 12px}
  details{margin:0 0 10px}
  details summary{cursor:pointer;font-size:12.5px;color:var(--accent);font-family:var(--mono);letter-spacing:.03em}
  details .body{font-size:13.5px;color:var(--ink-2);white-space:pre-wrap;padding:8px 0 2px}
  .sources{display:flex;flex-direction:column;gap:4px;padding:8px 0 2px}
  .sources a{font-size:13px}
  .actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:12px;margin-top:4px}
  .actions .lab{font-size:12.5px;color:var(--ink-3);margin-right:2px}
  .vbtn{border:1px solid var(--border);background:var(--surface);border-radius:6px;padding:6px 12px;font-size:13px;font-weight:600;color:var(--ink)}
  .vbtn[data-v=usable]:hover,.vbtn.sel[data-v=usable]{background:var(--good);border-color:var(--good);color:#fff}
  .vbtn[data-v=edited]:hover,.vbtn.sel[data-v=edited]{background:var(--warn);border-color:var(--warn);color:#fff}
  .vbtn[data-v=unusable]:hover,.vbtn.sel[data-v=unusable]{background:var(--crit);border-color:var(--crit);color:#fff}
  .vstate{font-size:12.5px;color:var(--ink-3);margin-left:auto}
  .empty{text-align:center;color:var(--ink-3);padding:48px 0;font-size:14px}
  .ticketlink{margin-left:auto;font-size:12.5px}
  a{color:var(--accent)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
</head>
<body>
<div class="wrap" id="app"><div class="empty">Loading…</div></div>

<script type="module">
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SB_URL = "__SB_URL__", SB_ANON = "__SB_ANON__";
const sb = createClient(SB_URL, SB_ANON);
const app = document.getElementById("app");
const esc = (s) => (s ?? "").toString();
let rows = [], tab = "todo", me = null;

sb.auth.onAuthStateChange((_e, session) => {
  const u = session?.user ?? null;
  if (u && (!me || me.id !== u.id)) { me = u; loadData(); }
  else if (!u && me) { me = null; renderAuth(); }
});
(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session) { me = data.session.user; loadData(); } else renderAuth();
})();

function renderAuth(msg, cls) {
  app.innerHTML = \`
    <div class="auth">
      <div class="eyebrow">Simployer · Gate 1</div>
      <h2>Coach review</h2>
      <p>Sign in with your agent email to review AI coach drafts and record your verdict.</p>
      <div class="field">
        <label for="em">Email</label>
        <input id="em" type="email" autocomplete="email" placeholder="you@simployer.com">
      </div>
      <button class="btn primary" id="send">Email me a login link</button>
      <div class="sep">or paste the code from the email</div>
      <div class="field">
        <label for="code">6-digit code</label>
        <input id="code" inputmode="numeric" placeholder="123456">
      </div>
      <button class="btn" id="verify" style="width:100%">Verify code</button>
      <div id="authmsg"></div>
    </div>\`;
  if (msg) setAuthMsg(msg, cls);
  const emailEl = document.getElementById("em");
  document.getElementById("send").onclick = async () => {
    const email = emailEl.value.trim();
    if (!email) return setAuthMsg("Enter your email first.", "err");
    setAuthMsg("Sending…", "ok");
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.href.split("#")[0], shouldCreateUser: true },
    });
    setAuthMsg(error ? error.message : "Check your inbox — click the link, or paste the code below.", error ? "err" : "ok");
  };
  document.getElementById("verify").onclick = async () => {
    const email = emailEl.value.trim(), token = document.getElementById("code").value.trim();
    if (!email || !token) return setAuthMsg("Enter your email and the code.", "err");
    setAuthMsg("Verifying…", "ok");
    const { error } = await sb.auth.verifyOtp({ email, token, type: "email" });
    if (error) setAuthMsg(error.message, "err");
  };
}
function setAuthMsg(t, cls) {
  const m = document.getElementById("authmsg");
  if (m) m.innerHTML = \`<div class="msg \${cls}">\${esc(t)}</div>\`;
}

async function loadData() {
  app.innerHTML = '<div class="empty">Loading tickets…</div>';
  const { data, error } = await sb.from("suggestions")
    .select("id,ticket_id,ticket_url,subject,ticket_type,language,confidence,draft,agent_analysis,rationale,sources,qa_score,qa_verdict,qa_needs_review,verdict,verdict_at,agent_sent_reply,gold_answer,gold_answer_by,prompt_version,created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) {
    app.innerHTML = \`<div class="empty">Couldn't load (\${esc(error.message)}).<br>If this says permission denied, your email isn't on the reviewer allowlist yet.</div>\`;
    return;
  }
  rows = data ?? [];
  render();
}

function render() {
  const todo = rows.filter((r) => !r.verdict);
  const done = rows.filter((r) => r.verdict);
  const list = tab === "todo" ? todo : tab === "done" ? done : rows;
  app.innerHTML = "";

  const top = el("header", "top");
  top.innerHTML = \`<div><div class="eyebrow">Simployer · Gate 1</div><h1>Coach review</h1></div>
    <div class="who"><span>\${esc(me?.email ?? "")}</span><button class="btn small" id="out">Sign out</button></div>\`;
  app.appendChild(top);

  const bar = el("div", "bar");
  bar.appendChild(tabEl("todo", "To review", todo.length));
  bar.appendChild(tabEl("done", "Judged", done.length));
  bar.appendChild(tabEl("all", "All", rows.length));
  const c = el("div", "count"); c.textContent = \`\${rows.length} loaded\`;
  bar.appendChild(c);
  app.appendChild(bar);
  document.getElementById("out").onclick = () => sb.auth.signOut();

  if (!list.length) { app.appendChild(Object.assign(el("div", "empty"), { textContent: tab === "todo" ? "Nothing left to review 🎉" : "Nothing here." })); return; }
  for (const r of list) app.appendChild(cardEl(r));
}

function tabEl(id, label, n) {
  const b = el("button", "tab" + (tab === id ? " on" : ""));
  b.textContent = \`\${label} · \${n}\`;
  b.onclick = () => { tab = id; render(); };
  return b;
}

function cardEl(r) {
  const card = el("div", "card");
  const head = el("div", "chead");
  head.appendChild(Object.assign(el("span", "id"), { textContent: "#" + r.ticket_id }));
  head.appendChild(Object.assign(el("span", "subj"), { textContent: esc(r.subject) || "(no subject)" }));
  card.appendChild(head);

  const tags = el("div", "tags");
  tags.appendChild(tag(r.ticket_type || "—"));
  tags.appendChild(tag((r.language || "—").toUpperCase()));
  tags.appendChild(tag("conf: " + (r.confidence || "—"), "c-" + (r.confidence || "none")));
  if (r.qa_score != null) tags.appendChild(tag("QA " + r.qa_score + " · " + (r.qa_verdict || ""), "qa" + (r.qa_needs_review ? " review" : "")));
  tags.appendChild(tag(r.prompt_version || ""));
  card.appendChild(tags);

  if (r.draft && r.draft.trim()) {
    card.appendChild(Object.assign(el("div", "draft"), { textContent: r.draft }));
  } else {
    card.appendChild(Object.assign(el("div", "noreply"), { textContent: "No send-ready customer reply (the coach abstained — agent guidance only)." }));
  }

  if (r.agent_analysis) card.appendChild(detail("Agent analysis", r.agent_analysis));
  if (r.rationale) card.appendChild(detail("Why (rationale)", r.rationale));
  if (Array.isArray(r.sources) && r.sources.length) {
    const d = document.createElement("details");
    d.innerHTML = \`<summary>Sources · \${r.sources.length}</summary>\`;
    const box = el("div", "sources");
    for (const s of r.sources) {
      const a = document.createElement("a");
      a.href = esc(s.url || "#"); a.target = "_blank"; a.rel = "noopener";
      a.textContent = (s.kind === "ticket" ? "🎫 " : "📄 ") + esc(s.title || s.ref);
      box.appendChild(a);
    }
    d.appendChild(box); card.appendChild(d);
  }

  // Reference: what the agent actually sent — the gold standard for training.
  if (r.agent_sent_reply && r.agent_sent_reply.trim()) {
    const ref = el("div", "refbox");
    ref.appendChild(Object.assign(el("span", "rl"), { textContent: "What the agent actually sent · reference" }));
    ref.appendChild(document.createTextNode(r.agent_sent_reply));
    card.appendChild(ref);
  }

  // Ideal-answer capture — the "what good looks like" training corpus.
  const gold = el("div", "gold");
  gold.appendChild(Object.assign(el("span", "gl"), { textContent: "Ideal answer (training material)" }));
  const ta = document.createElement("textarea");
  ta.value = r.gold_answer ?? "";
  ta.placeholder = r.agent_sent_reply
    ? "Write the ideal answer, or start from the agent's reply above…"
    : "Write the ideal answer the AI should learn from…";
  gold.appendChild(ta);
  const gbar = el("div", "goldbar");
  const save = el("button", "btn small"); save.textContent = "Save ideal answer";
  const st = el("span", "st");
  st.textContent = r.gold_answer ? ("saved" + (r.gold_answer_by ? " · " + r.gold_answer_by : "")) : "";
  save.onclick = () => saveGold(r, ta.value, st);
  gbar.appendChild(save);
  if (r.agent_sent_reply) {
    const useSent = el("button", "link"); useSent.textContent = "use agent's reply";
    useSent.onclick = () => { ta.value = r.agent_sent_reply; };
    gbar.appendChild(useSent);
  }
  gbar.appendChild(st);
  gold.appendChild(gbar);
  card.appendChild(gold);

  const actions = el("div", "actions");
  actions.appendChild(Object.assign(el("span", "lab"), { textContent: "Would you have sent this?" }));
  for (const v of ["usable", "edited", "unusable"]) {
    const b = el("button", "vbtn" + (r.verdict === v ? " sel" : ""));
    b.dataset.v = v; b.textContent = v[0].toUpperCase() + v.slice(1);
    b.onclick = () => setVerdict(r, v, card);
    actions.appendChild(b);
  }
  const state = el("span", "vstate");
  state.textContent = r.verdict ? "recorded: " + r.verdict : "";
  actions.appendChild(state);
  if (r.ticket_url) {
    const link = document.createElement("a");
    link.className = "ticketlink"; link.href = esc(r.ticket_url); link.target = "_blank"; link.rel = "noopener";
    link.textContent = "Open in Freshdesk ↗";
    actions.appendChild(link);
  }
  card.appendChild(actions);
  return card;
}

async function setVerdict(r, v, card) {
  const prev = r.verdict;
  r.verdict = v; r.verdict_at = new Date().toISOString();
  card.querySelectorAll(".vbtn").forEach((b) => b.classList.toggle("sel", b.dataset.v === v));
  card.querySelector(".vstate").textContent = "saving…";
  const { error } = await sb.from("suggestions").update({ verdict: v, verdict_at: r.verdict_at }).eq("id", r.id);
  if (error) {
    r.verdict = prev;
    card.querySelector(".vstate").textContent = "save failed: " + error.message;
  } else {
    card.querySelector(".vstate").textContent = "recorded: " + v;
  }
}

async function saveGold(r, text, st) {
  st.textContent = "saving…";
  const { error } = await sb.from("suggestions").update({ gold_answer: text }).eq("id", r.id);
  if (error) { st.textContent = "save failed: " + error.message; return; }
  r.gold_answer = text;
  st.textContent = text.trim() ? "saved ✓" : "cleared";
}

function detail(label, text) {
  const d = document.createElement("details");
  d.innerHTML = \`<summary>\${esc(label)}</summary>\`;
  d.appendChild(Object.assign(el("div", "body"), { textContent: esc(text) }));
  return d;
}
function tag(text, cls) { return Object.assign(el("span", "tag" + (cls ? " " + cls : "")), { textContent: esc(text) }); }
function el(t, cls) { const e = document.createElement(t); if (cls) e.className = cls; return e; }
</script>
</body>
</html>`;

Deno.serve((_req: Request) => {
  const body = HTML.replace("__SB_URL__", SUPABASE_URL).replace("__SB_ANON__", ANON_KEY);
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});
