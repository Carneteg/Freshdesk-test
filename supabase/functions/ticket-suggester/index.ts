// ticket-suggester — HTTP entrypoint + polling loop (CLAUDE.md §3).
//
// The importable pipeline lives in pipeline.ts; this file only loads config,
// runs one poll, and serves. It calls Deno.serve unconditionally, so nothing
// else should import this module — the replay harness imports pipeline.ts.
//
// Flow per run:
//   1. page from a durable (updated_at, ticket_id) cursor into a DB queue
//   2. atomically reserve one immutable generation per queued customer turn
//   3. per ticket: analyse -> retrieve -> draft -> verify -> outbox -> note
//   4. reconcile usage of earlier suggestions the agent has since replied to

import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import { Freshdesk, LLM } from "./clients.ts";
import { FreshworksCRM } from "./freshworks-crm.ts";
import { PROMPT_VERSION } from "./prompts.ts";
import { deriveTags, isIgnorableTicket, latestCustomerMessage } from "./render.ts";
import { loadIncidents, reconcileUsage, runPipeline, toRow } from "./pipeline.ts";
import { loadCatalog } from "./upsell.ts";

const SIMPLOYER_SUBSCRIPTIONS_PATH =
  "/custom_module/cm_subscription/view/31008500658?q[]=%7B%22name%22%3A%22cf_account_number%22%2C%22operator%22%3A4%2C%22value%22%3A%22{account_id}%22%2C%22domType%22%3A6%7D";

// ── Config ────────────────────────────────────────────────────────────────────

interface Config {
  domain: string;
  apiKey: string;
  // The monitored agents (CLAUDE.md §12, 2026-07-23): MY_AGENT_ID is a comma-
  // separated list of numeric agent ids. Only these agents' tickets are ever
  // touched. Gate 1 started single-agent (§9); this widens it to a small, named set.
  myAgentIds: number[];
  expectedName: string;
  openaiKey: string;
  model: string;
  cronSecret: string;
  supabaseUrl: string;
  serviceKey: string;
  maxPerRun: number;
  bootstrapLookbackMin: number;
  pollStream: string;
  pollLeaseSeconds: number;
  withRetrieval: boolean;
  excludeCategories: string[];
  excludeSubjects: string[];
  // Safety flag for the first live runs (CLAUDE.md §4: never run live before).
  // When true, the full pipeline runs and every suggestion is logged, but NO note
  // or tag is written to Freshdesk. Defaults to TRUE — posting must be turned on
  // deliberately with DRY_RUN=false, so a first deploy/cron can never surprise-post.
  dryRun: boolean;
  // Authenticated review app. New notes link here; they never carry write tokens.
  reviewUrl: string;
  // Optional read-only Freshworks CRM context. It is a separate key/source from
  // Freshdesk and stays off until the tenant-specific module endpoint is verified.
  crmEnabled: boolean;
  crmBaseUrl: string;
  crmApiKey: string;
  crmSubscriptionsPath: string;
  crmSubscriptionsCollection: string;
  crmAccountField: string;
  crmProductField: string;
  crmRenewalStatusField: string;
  crmEndDateField: string;
}

// Comma-separated env list -> lowercased, trimmed, non-empty.
function envList(name: string): string[] {
  return (Deno.env.get(name) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(
    Boolean,
  );
}

// Comma-separated env list of positive integers (e.g. MY_AGENT_ID="123,456").
function numList(name: string): number[] {
  return (Deno.env.get(name) ?? "").split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function env(name: string): string {
  const v = Deno.env.get(name) ?? "";
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

function loadConfig(): Config {
  return {
    domain: env("FRESHDESK_DOMAIN"),
    apiKey: env("FRESHDESK_API_KEY"),
    myAgentIds: numList("MY_AGENT_ID"),
    expectedName: Deno.env.get("EXPECTED_AGENT_NAME") ?? "Tobias Carneteg",
    openaiKey: env("OPENAI_API_KEY"),
    model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o",
    cronSecret: env("CRON_SECRET"),
    supabaseUrl: env("SUPABASE_URL"),
    serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
    maxPerRun: Number(Deno.env.get("MAX_PER_RUN") ?? "5"),
    bootstrapLookbackMin: Number(Deno.env.get("BOOTSTRAP_LOOKBACK_MINUTES") ?? "60"),
    pollStream: Deno.env.get("POLL_STREAM") ?? "ticket-suggester-v1",
    pollLeaseSeconds: Number(Deno.env.get("POLL_LEASE_SECONDS") ?? "180"),
    withRetrieval: (Deno.env.get("WITH_RETRIEVAL") ?? "true") !== "false",
    excludeCategories: envList("EXCLUDE_SOLUTION_CATEGORIES"),
    excludeSubjects: envList("EXCLUDE_SUBJECTS"),
    // Safe by default: post only when DRY_RUN is explicitly "false".
    dryRun: (Deno.env.get("DRY_RUN") ?? "true") !== "false",
    reviewUrl: Deno.env.get("REVIEW_APP_URL") ?? "",
    crmEnabled: (Deno.env.get("FRESHWORKS_CRM_ENABLED") ?? "false") === "true",
    crmBaseUrl: Deno.env.get("FRESHWORKS_CRM_BASE_URL") ?? "",
    crmApiKey: Deno.env.get("FRESHWORKS_CRM_API_KEY") ?? "",
    crmSubscriptionsPath: Deno.env.get("FRESHWORKS_CRM_SUBSCRIPTIONS_PATH") ??
      SIMPLOYER_SUBSCRIPTIONS_PATH,
    crmSubscriptionsCollection: Deno.env.get("FRESHWORKS_CRM_SUBSCRIPTIONS_COLLECTION") ??
      "cm_subscription",
    crmAccountField: Deno.env.get("FRESHWORKS_CRM_ACCOUNT_FIELD") ??
      "cf_account_number",
    crmProductField: Deno.env.get("FRESHWORKS_CRM_PRODUCT_FIELD") ??
      "cf_product_name",
    crmRenewalStatusField: Deno.env.get("FRESHWORKS_CRM_RENEWAL_STATUS_FIELD") ??
      "cf_renewal_status",
    crmEndDateField: Deno.env.get("FRESHWORKS_CRM_END_DATE_FIELD") ??
      "cf_end_date",
  };
}

function nameMatches(name: string | undefined, expected: string): boolean {
  const n = (name ?? "").toLowerCase();
  return expected.toLowerCase().split(/\s+/).every((part) => n.includes(part));
}

interface Summary {
  dry_run: boolean;
  lease_acquired: boolean;
  scanned: number;
  mine: number;
  queued: number;
  processed: number;
  posted: number;
  skipped: number;
  errors: number;
  usage_scored: number;
}

// deno-lint-ignore no-explicit-any
type Db = any;

function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Bound database/log payloads and collapse whitespace. API response bodies are
  // already excluded by HttpError, but this also protects unexpected providers.
  return raw.replace(/\s+/g, " ").slice(0, 500);
}

// Supabase JS returns { data, error }; it does not throw database errors.
// deno-lint-ignore no-explicit-any
function checked<T>(result: { data: unknown; error: any }, operation: string): T {
  if (result.error) {
    throw new Error(`${operation}: ${result.error.message ?? "database error"}`);
  }
  return result.data as T;
}

interface QueueRow {
  id: number;
  ticket_id: number;
  ticket_updated_at: string;
  subject: string | null;
  responder_id: number | null;
  attempts: number;
}

interface GenerationRow {
  id: number;
  ticket_id: number;
  note_id: number | null;
  note_html: string | null;
  delivery_marker: string | null;
  delivery_status: string;
  post_attempts: number;
  keywords: string[] | null;
}

async function markQueueDone(db: Db, id: number): Promise<void> {
  checked(
    await db.from("ticket_poll_queue").update({
      state: "done",
      processed_at: new Date().toISOString(),
      last_error: null,
    }).eq("id", id),
    "mark queue item done",
  );
}

async function markQueueFailed(db: Db, row: QueueRow, err: unknown): Promise<void> {
  const attempts = (row.attempts ?? 0) + 1;
  checked(
    await db.from("ticket_poll_queue").update({
      state: attempts >= 5 ? "failed" : "queued",
      attempts,
      last_error: safeError(err),
    }).eq("id", row.id),
    "record queue failure",
  );
}

async function loadGeneration(db: Db, id: number): Promise<GenerationRow> {
  const row = checked<GenerationRow | null>(
    await db.from("suggestions")
      .select(
        "id,ticket_id,note_id,note_html,delivery_marker,delivery_status,post_attempts,keywords",
      )
      .eq("id", id)
      .maybeSingle(),
    "load generation",
  );
  if (!row) throw new Error(`generation ${id} not found`);
  return row;
}

async function ensureNotePosted(
  fd: Freshdesk,
  db: Db,
  generation: GenerationRow,
  reservationToken: string,
): Promise<number> {
  if (generation.note_id) return generation.note_id;
  if (!generation.note_html || !generation.delivery_marker) {
    throw new Error(`generation ${generation.id} has no stored note outbox payload`);
  }

  const claimed = checked<{ id: number } | null>(
    await db.from("suggestions").update({
      delivery_status: "posting",
      posting_started_at: new Date().toISOString(),
      post_attempts: (generation.post_attempts ?? 0) + 1,
      reservation_expires_at: new Date(Date.now() + 180_000).toISOString(),
    }).eq("id", generation.id).eq("reservation_token", reservationToken)
      .select("id").maybeSingle(),
    "mark generation posting",
  );
  if (!claimed) {
    throw new Error(`lost delivery reservation for generation ${generation.id}`);
  }

  // Check first: this covers a previous POST that Freshdesk accepted while our
  // response/database update was lost.
  let noteId = await fd.findPrivateNoteByMarker(
    generation.ticket_id,
    generation.delivery_marker,
  );
  if (!noteId) {
    try {
      noteId = await fd.postPrivateNote(generation.ticket_id, generation.note_html);
    } catch (err) {
      // An uncertain POST is recovered by marker, never by repeating POST blindly.
      noteId = await fd.findPrivateNoteByMarker(
        generation.ticket_id,
        generation.delivery_marker,
      );
      if (!noteId) {
        checked(
          await db.from("suggestions").update({
            delivery_status: "failed",
            error: safeError(err),
          }).eq("id", generation.id).eq("reservation_token", reservationToken),
          "record uncertain note failure",
        );
        throw err;
      }
    }
  }

  const posted = checked<{ id: number } | null>(
    await db.from("suggestions").update({
      delivery_status: "posted",
      note_id: noteId,
      posted_at: new Date().toISOString(),
      reservation_expires_at: null,
      error: null,
    }).eq("id", generation.id).eq("reservation_token", reservationToken)
      .select("id").maybeSingle(),
    "mark generation posted",
  );
  if (!posted) {
    throw new Error(`could not persist posted state for generation ${generation.id}`);
  }
  return noteId;
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollOnce(cfg: Config): Promise<Summary> {
  const fd = new Freshdesk(cfg.domain, cfg.apiKey);
  const crm = cfg.crmEnabled
    ? new FreshworksCRM({
      baseUrl: cfg.crmBaseUrl || env("FRESHWORKS_CRM_BASE_URL"),
      apiKey: cfg.crmApiKey || env("FRESHWORKS_CRM_API_KEY"),
      subscriptionsPathTemplate: cfg.crmSubscriptionsPath ||
        env("FRESHWORKS_CRM_SUBSCRIPTIONS_PATH"),
      subscriptionsCollection: cfg.crmSubscriptionsCollection ||
        env("FRESHWORKS_CRM_SUBSCRIPTIONS_COLLECTION"),
      accountField: cfg.crmAccountField || env("FRESHWORKS_CRM_ACCOUNT_FIELD"),
      productField: cfg.crmProductField || env("FRESHWORKS_CRM_PRODUCT_FIELD"),
      renewalStatusField: cfg.crmRenewalStatusField ||
        env("FRESHWORKS_CRM_RENEWAL_STATUS_FIELD"),
      endDateField: cfg.crmEndDateField || env("FRESHWORKS_CRM_END_DATE_FIELD"),
    })
    : undefined;
  const llm = new LLM(cfg.openaiKey, cfg.model);
  const db = createClient(cfg.supabaseUrl, cfg.serviceKey);
  const summary: Summary = {
    dry_run: cfg.dryRun,
    lease_acquired: false,
    scanned: 0,
    mine: 0,
    queued: 0,
    processed: 0,
    posted: 0,
    skipped: 0,
    errors: 0,
    usage_scored: 0,
  };

  // Roles are decoupled (CLAUDE.md §12): the API key is a SERVICE account that
  // POSTS the notes; MY_AGENT_ID lists the monitored agents whose tickets we watch.
  // Safety ("never touch a colleague's ticket") is preserved by the poll filter +
  // responder_id re-check below, which only ever act on tickets whose responder is
  // one of the monitored agents.
  const service = await fd.me(); // throws on a bad key -> fail fast
  console.log(`posting as service account ${service.id} (${service.contact?.name})`);
  if (cfg.dryRun) {
    console.log(
      "DRY_RUN is on — running the full pipeline and logging suggestions, but posting NO notes/tags to Freshdesk. Set DRY_RUN=false to enable posting.",
    );
  }

  if (!cfg.myAgentIds.length) {
    throw new Error(
      "refusing to run: MY_AGENT_ID must be one or more numeric agent ids (comma-separated)",
    );
  }
  // Best-effort: log each monitored agent's name (so the logs show exactly who is
  // watched), and warn if none matches EXPECTED_AGENT_NAME. Needs admin-scoped API;
  // a failure only warns — the id filter still holds.
  let anyExpected = false;
  for (const id of cfg.myAgentIds) {
    try {
      const monitored = await fd.getAgent(id);
      const name = monitored.contact?.name ?? "(unknown)";
      console.log(`monitoring agent ${id} (${name})`);
      if (cfg.expectedName && nameMatches(name, cfg.expectedName)) anyExpected = true;
    } catch (e) {
      console.warn(
        `could not verify monitored agent ${id} (needs admin API): ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }
  if (cfg.expectedName && !anyExpected) {
    console.warn(
      `monitored-agent name check: none matched EXPECTED_AGENT_NAME ~"${cfg.expectedName}"`,
    );
  }
  const monitoredIds = new Set(cfg.myAgentIds);

  // A database lease prevents overlapping cron invocations. The immutable unique
  // key + note marker remain the final duplicate guard if a lease expires mid-run.
  const leaseToken = crypto.randomUUID();
  const acquired = checked<boolean>(
    await db.rpc("acquire_poll_lease", {
      p_lease_name: cfg.pollStream,
      p_lease_token: leaseToken,
      p_ttl_seconds: cfg.pollLeaseSeconds,
    }),
    "acquire poll lease",
  );
  summary.lease_acquired = acquired;
  if (!acquired) {
    summary.skipped++;
    return summary;
  }

  try {
    // Team-curated known-incidents playbook, loaded once per run.
    const incidents = await loadIncidents(db);
    // Curated capability -> product map for upsell detection (migration 46).
    // Seeded INACTIVE, so this is empty until a product owner has checked the
    // wording — and an empty catalogue turns the detector off entirely.
    const productCatalog = await loadCatalog(db);

    // Page from the durable cursor. The initial lookback is only a bootstrap;
    // subsequent runs always continue from the stored tuple.
    const cursor = checked<{ last_updated_at: string; last_ticket_id: number } | null>(
      await db.from("poll_cursors")
        .select("last_updated_at,last_ticket_id")
        .eq("stream_name", cfg.pollStream)
        .maybeSingle(),
      "load poll cursor",
    );
    const since = cursor?.last_updated_at ??
      new Date(Date.now() - cfg.bootstrapLookbackMin * 60_000).toISOString();
    const updated = await fd.listAllUpdatedTickets(since);
    summary.scanned = updated.length;

    const ordered = updated.slice().sort((a, b) =>
      a.updated_at.localeCompare(b.updated_at) || a.id - b.id
    );
    const fresh = ordered.filter((t) =>
      !cursor ||
      t.updated_at > cursor.last_updated_at ||
      (t.updated_at === cursor.last_updated_at && t.id > cursor.last_ticket_id)
    );

    if (fresh.length) {
      const queueEvents = fresh
        .filter((t) => monitoredIds.has(t.responder_id ?? -1))
        .filter((t) => !isIgnorableTicket(t.subject, cfg.excludeSubjects))
        .map((t) => ({
          ticket_id: t.id,
          ticket_updated_at: t.updated_at,
          subject: t.subject,
          responder_id: t.responder_id,
        }));
      const last = fresh[fresh.length - 1];
      summary.mine = queueEvents.length;
      summary.queued = checked<number>(
        await db.rpc("enqueue_ticket_updates", {
          p_stream_name: cfg.pollStream,
          p_events: queueEvents,
          p_cursor_updated_at: last.updated_at,
          p_cursor_ticket_id: last.id,
        }),
        "enqueue ticket updates and advance cursor",
      );
    }

    const queue = checked<QueueRow[]>(
      await db.from("ticket_poll_queue")
        .select("id,ticket_id,ticket_updated_at,subject,responder_id,attempts")
        .eq("stream_name", cfg.pollStream)
        .eq("state", "queued")
        .order("ticket_updated_at", { ascending: true })
        .order("ticket_id", { ascending: true })
        .limit(cfg.maxPerRun),
      "load ticket queue",
    ) ?? [];

    for (const item of queue) {
      let generationId: number | null = null;
      const reservationToken = crypto.randomUUID();
      try {
        const ticket = await fd.ticketWithConversations(item.ticket_id);

        // Second independent agent filter: re-check the freshly-loaded ticket.
        if (
          !monitoredIds.has(ticket.responder_id ?? -1) ||
          isIgnorableTicket(ticket.subject, cfg.excludeSubjects)
        ) {
          summary.skipped++;
          await markQueueDone(db, item.id);
          continue;
        }

        const { triggerId } = latestCustomerMessage(ticket);
        const runVariant = cfg.dryRun ? "dry-run" : "live";

        // A live customer turn is posted once even after prompt/model upgrades.
        // Replay/dry-run generations remain fully versioned for evaluation.
        if (!cfg.dryRun) {
          const alreadyPosted = checked<{ id: number } | null>(
            await db.from("suggestions")
              .select("id")
              .eq("ticket_id", ticket.id)
              .eq("trigger_message_id", triggerId)
              .eq("run_variant", "live")
              .eq("delivery_status", "posted")
              .limit(1)
              .maybeSingle(),
            "check existing live delivery",
          );
          if (alreadyPosted) {
            summary.skipped++;
            await markQueueDone(db, item.id);
            continue;
          }
        }

        const reservation = checked<Array<{ generation_id: number; action: string }>>(
          await db.rpc("reserve_generation", {
            p_ticket_id: ticket.id,
            p_trigger_message_id: triggerId,
            p_subject: ticket.subject,
            p_prompt_version: PROMPT_VERSION,
            p_model: cfg.model,
            p_run_variant: runVariant,
            p_reservation_token: reservationToken,
            p_lease_seconds: cfg.pollLeaseSeconds,
          }),
          "reserve generation",
        )?.[0];
        if (!reservation) throw new Error("generation reservation returned no result");
        generationId = reservation.generation_id;

        if (reservation.action === "skip") {
          summary.skipped++;
          await markQueueDone(db, item.id);
          continue;
        }

        if (reservation.action === "generate") {
          const s = await runPipeline({
            fd,
            crm,
            llm,
            model: cfg.model,
            withRetrieval: cfg.withRetrieval,
            excludeCategories: cfg.excludeCategories,
            incidents,
            productCatalog,
            db,
            reviewUrl: cfg.reviewUrl || undefined,
            generationId,
            runVariant,
          }, ticket);
          const marker = `simployer-ai-generation:${generationId}`;
          const noteHtml = `${s.note_html}\n` +
            `<p style="color:#aaa;font-size:9px">AI generation ${marker}</p>`;

          const saved = checked<{ id: number } | null>(
            await db.from("suggestions").update({
              ...toRow(s),
              note_html: noteHtml,
              delivery_marker: marker,
              delivery_status: "generated",
              error: null,
            })
              .eq("id", generationId)
              .eq("reservation_token", reservationToken)
              .eq("delivery_status", "reserved")
              .select("id")
              .maybeSingle(),
            "persist generated outbox payload",
          );
          if (!saved) throw new Error(`lost reservation for generation ${generationId}`);
        }

        let generation = await loadGeneration(db, generationId);
        summary.processed++;

        // DRY_RUN ends at the stored generated state: no Freshdesk note or tag.
        if (cfg.dryRun) {
          await markQueueDone(db, item.id);
          continue;
        }

        await ensureNotePosted(fd, db, generation, reservationToken);
        summary.posted++;

        // Tags are secondary. The note is already exactly-once-like and persisted.
        generation = await loadGeneration(db, generationId);
        const tags = deriveTags(generation.keywords ?? []);
        if (tags.length) {
          try {
            await fd.setTags(
              ticket.id,
              Array.from(new Set([...(ticket.tags ?? []), ...tags])),
            );
          } catch (err) {
            console.warn(`tag write failed for ${ticket.id}: ${safeError(err)}`);
          }
        }
        await markQueueDone(db, item.id);
      } catch (err) {
        summary.errors++;
        const msg = safeError(err);
        console.error(`ticket ${item.ticket_id} failed: ${msg}`);
        if (generationId) {
          const result = await db.from("suggestions").update({
            delivery_status: "failed",
            error: msg,
          }).eq("id", generationId).neq("delivery_status", "posted");
          if (result.error) {
            console.error(
              `failed to record generation error: ${safeError(result.error)}`,
            );
          }
        }
        try {
          await markQueueFailed(db, item, err);
        } catch (queueErr) {
          console.error(`failed to record queue error: ${safeError(queueErr)}`);
        }
      }
    }

    // Usage reconciliation is bounded and cannot block delivery. Its own database
    // operations now throw on errors rather than silently pretending success.
    try {
      summary.usage_scored = await reconcileUsage(fd, db);
    } catch (err) {
      console.error(`usage reconciliation failed: ${safeError(err)}`);
    }

    return summary;
  } finally {
    const released = await db.rpc("release_poll_lease", {
      p_lease_name: cfg.pollStream,
      p_lease_token: leaseToken,
    });
    if (released.error) {
      console.error(`release poll lease failed: ${safeError(released.error)}`);
    }
  }
}

// ── HTTP entrypoint ───────────────────────────────────────────────────────────
// pg_cron calls this every minute with the x-cron-secret header (custom auth,
// which is why the function is deployed with verify_jwt = false).

Deno.serve(async (req: Request) => {
  try {
    const cfg = loadConfig();
    if (req.headers.get("x-cron-secret") !== cfg.cronSecret) {
      return new Response("forbidden", { status: 403 });
    }
    const summary = await pollOnce(cfg);
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("poll failed:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});
