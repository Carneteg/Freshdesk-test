// scripts/write_articles.ts — draft KB articles from resolved tickets.
//
//   deno task write-articles              # preview the queue, write nothing
//   ARTICLES_APPROVED=true deno task write-articles
//   ARTICLE_LIMIT=3 ARTICLES_APPROVED=true deno task write-articles
//
// Picks up article requests a REVIEWER made in the Coach Review app
// (`article_write_queue`) and drafts each one. Writes only to Supabase — nothing
// is posted to Freshdesk, and nothing here decides on its own that something
// becomes knowledge:
//
//   pipeline flags it  →  a human requests it  →  THIS drafts it  →  a human approves
//
// The safeguard that matters (CLAUDE.md §12, the coach pivot): an article is only
// ever generalised from a resolution a HUMAN stood behind — a reviewer's gold
// answer, or the reply the agent actually sent. Never from the AI's own draft. An
// article outlives a reply, so encoding a guess would reproduce the Gate 1 failure
// at scale.
//
// Same approval gate as the replay harness: real ticket text goes to OpenAI, so
// the queue is previewed and the run stops unless ARTICLES_APPROVED=true.

import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { LLM } from "../supabase/functions/ticket-suggester/clients.ts";
import { draftKbArticle } from "../supabase/functions/ticket-suggester/pipeline.ts";
import type { SourceDoc } from "../supabase/functions/ticket-suggester/prompts.ts";

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) {
    console.error(`missing required env var: ${name}`);
    Deno.exit(1);
  }
  return v;
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o";
const limit = Number(Deno.env.get("ARTICLE_LIMIT") ?? "5");
const approved = (Deno.env.get("ARTICLES_APPROVED") ?? "").toLowerCase() === "true";
// Batch jobs must not leak ticket text into Actions logs (CLAUDE.md §5 / P0).
const safeLog = (Deno.env.get("CLOUD_LOG_MODE") ?? "").toLowerCase() === "safe";

const { data: queue, error: queueError } = await db
  .from("article_write_queue")
  .select("article_id, ticket_id, generation_id, proposed_title, resolution_source")
  .limit(limit);

if (queueError) {
  console.error(`failed to read article_write_queue: ${queueError.message}`);
  Deno.exit(1);
}
const rows = queue ?? [];

if (!rows.length) {
  console.log(
    "Nothing to write. The queue holds requests that a reviewer made AND whose ticket\n" +
      "already carries a human-validated resolution (a gold answer, or the agent's sent reply).",
  );
  Deno.exit(0);
}

console.log(`${rows.length} article request(s) ready to draft:\n`);
for (const r of rows) {
  const title = safeLog ? "(hidden)" : (r.proposed_title || "(no proposed title)");
  console.log(
    `  #${r.ticket_id}  [${r.resolution_source}]  ${title}`,
  );
}

if (!approved) {
  console.log(
    "\nPreview only — nothing sent. Real ticket text goes to OpenAI when you run this.\n" +
      "Re-run with ARTICLES_APPROVED=true to draft them.",
  );
  Deno.exit(0);
}

const llm = new LLM(env("OPENAI_API_KEY"), model);
let drafted = 0, blocked = 0, failed = 0;

for (const r of rows) {
  // Load the resolution + context for this generation. Selected here rather than in
  // the view so the view stays a cheap queue and the PII stays in one place.
  const { data: gen, error: genError } = await db
    .from("suggestions")
    .select("subject, language, conversation_context, sources, gold_answer, agent_sent_reply")
    .eq("id", r.generation_id)
    .single();

  if (genError || !gen) {
    console.error(`  #${r.ticket_id}: could not load generation — skipped`);
    failed++;
    continue;
  }

  const resolution = (gen.gold_answer?.trim() || gen.agent_sent_reply?.trim() || "");
  const resolutionSource: "gold_answer" | "agent_reply" = gen.gold_answer?.trim()
    ? "gold_answer"
    : "agent_reply";

  const article = await draftKbArticle({ llm, model }, {
    subject: gen.subject ?? "",
    language: gen.language ?? "en",
    context: gen.conversation_context ?? "",
    resolution,
    resolutionSource,
    sources: (gen.sources ?? []) as SourceDoc[],
    proposedTitle: r.proposed_title,
  });

  if (!article) {
    await db.from("article_drafts").update({
      status: "failed",
      blocked_reason: "the article writer returned nothing",
      drafted_at: new Date().toISOString(),
    }).eq("id", r.article_id);
    console.error(`  #${r.ticket_id}: writer failed — marked failed`);
    failed++;
    continue;
  }

  // A refusal is a real outcome, not an error: "this cannot be written correctly"
  // is exactly the judgement we want the writer to be willing to make.
  await db.from("article_drafts").update({
    status: "drafted",
    language: gen.language ?? null,
    title: article.title || null,
    summary: article.summary || null,
    steps: article.steps,
    notes: article.notes,
    audience: article.audience,
    gap_filled: article.gap_filled || null,
    removed_specifics: article.removed_specifics,
    resolution_source: resolutionSource,
    article_version: article.article_version,
    model: article.model,
    publishable: article.publishable,
    blocked_reason: article.publishable ? null : (article.not_publishable_reason || null),
    drafted_at: new Date().toISOString(),
  }).eq("id", r.article_id);

  if (article.publishable) {
    drafted++;
    console.log(
      `  #${r.ticket_id}: drafted${safeLog ? "" : ` — “${article.title}”`}` +
        (article.removed_specifics.length
          ? ` (stripped: ${article.removed_specifics.length} customer-specific detail(s))`
          : ""),
    );
  } else {
    blocked++;
    console.log(
      `  #${r.ticket_id}: not publishable${
        safeLog ? "" : ` — ${article.not_publishable_reason}`
      }`,
    );
  }
}

console.log(
  `\n${drafted} drafted, ${blocked} declined as not publishable, ${failed} failed.\n` +
    "Drafts await human approval in the Coach Review app — nothing is published anywhere.",
);
