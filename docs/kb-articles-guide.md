# Turning tickets into knowledge-base articles — a guide

*For the support agents and reviewers using the Coach Review app.*

Gate 1 taught us one uncomfortable thing: the AI was not worse than you because
it reasons badly. It was worse because you know things that are **written down
nowhere** — which incidents are live, that reindexing fixes certain 404s, that a
particular customer sits on a read-only link, that legal questions go to
Simployer Expert.

This feature exists to fix that at the only moment it is cheap: right after you
have solved a ticket, while the answer is still in front of you.

**Nothing here is published automatically, and nothing reaches a customer.**

---

## The four steps, and who decides what

| # | What happens | Who does it |
|---|---|---|
| 1 | A ticket is flagged as "this answer would help others" | **AI** (a suggestion) |
| 2 | Someone asks for an article | **You** |
| 3 | The article is drafted | **AI** |
| 4 | The article is edited and approved | **You** |

Steps 2 and 4 are human on purpose. The AI proposes and writes; **it never
decides that something becomes knowledge.**

---

## Step 1 — Spotting the suggestion

At the bottom of a private note you may see:

> **📝 Worth a knowledge-base article?** Suggested title: "How to add a new
> employee" — the same question comes up from many customers
> *Your call — ask for a draft in the Coach Review app if you agree.*

The AI only raises this when all three hold: the question is **general** (not
about this customer's own data), the answer is a **stable how-to** (not a
live incident status), and the **knowledge base did not already cover it**.

It will be wrong sometimes. That is what step 2 is for.

---

## Step 2 — Asking for an article

Open the ticket in the Coach Review app. Under the card you will find a box
headed **📝 Kunskapsartikel** with one button:

> **Skriv en artikel av detta** *(write an article from this)*

Click it and the request goes in the queue. That is all you need to do.

You can ask for an article on **any** ticket — you do not have to wait for the
AI to suggest one. If you just solved something you have explained five times
before, that is exactly the article worth having.

### Nothing happened. Why?

The article is only written once the ticket carries a resolution **a human stood
behind**. That means one of:

- an **ideal answer** you wrote in the review app (preferred — it is the gold
  standard), or
- the **reply the agent actually sent** to the customer.

If neither exists yet, the request sits and waits. This is deliberate: the AI is
never allowed to generalise from **its own** draft. An article outlives a reply,
so encoding a guess there would spread one mistake across every future customer.

**So if a ticket matters, write the ideal answer first, then ask for the
article.** That gives the best possible source material.

---

## Step 3 — The draft gets written

A batch job (`deno task write-articles`) picks up the queue and drafts each one.
This is not instant — think "next run", not "next second".

The writer works under two rules worth knowing about:

**It may not invent anything.** Everything in the article has to come from the
resolution, the ticket, or an existing knowledge-base source. It will not
complete a half-described procedure or guess a menu name.

**It generalises rather than copies.** Customer names, e-mail addresses, company
names, employee data, ticket numbers and dates are stripped out — and it lists
what it removed so you can check. An article that quietly kept a customer's name
is a data-protection problem, not a style problem.

---

## Step 4 — Reviewing it in the Articles tab

Open the **📝 Artiklar** tab at the top of the review app. Every article lives
there, in every state, ordered so the ones needing you come first.

| Tag | Meaning |
|---|---|
| **i kö** | requested, waiting to be written |
| **utkast klart** | drafted — **this is the one that needs you** |
| **godkänd** | approved, ready to publish |
| **avvisad** | rejected |
| **misslyckades** | the writer could not produce anything |

Filter by status, or search by title, ticket number or subject.

### Editing

Everything is editable — **rubrik** (title), **Sammanfattning** (summary),
**Steg** (steps, one per line) and **Noteringar** (notes, one per line).

Your words beat the model's. If the wording is nearly right, fix it rather than
rejecting it — a rejected article is work thrown away.

Three buttons:

- **Spara** — save your edits and leave everything else alone. Safe to use on an
  approved article: it will **not** unapprove it and will **not** overwrite the
  record of who approved it.
- **Godkänn** — approve it.
- **Avvisa** — reject it.

### Before you approve — the four checks

1. **Is it true?** You are the one who knows. The AI cannot check the product.
2. **Would it work for a customer who is not this one?** If it only makes sense
   for the ticket it came from, it is not an article.
3. **Any customer details left?** Open *Ursprung och historik* and read
   "Borttagna kunduppgifter" — then re-read the body yourself. Names, companies,
   e-mail addresses, dates.
4. **Does it match the tone we use?** Friendly, professional, clear,
   solution-oriented. No apologies — an article has nothing to apologise for.

### Where did this come from?

Every card has an expandable **Ursprung och historik** *(origin and history)*
section:

- which ticket it came from, with a link
- **which human-validated resolution it was generalised from** — your ideal
  answer, or the reply that was actually sent
- what the AI originally proposed, and why
- which customer details were stripped
- who requested it, who approved it, and when
- article and model version

An article outlives the ticket it came from, so its origin travels with it.

---

## "Kunde inte skrivas" — when the AI refuses

Sometimes you will see:

> **Kunde inte skrivas:** the resolution is specific to this customer's
> configuration and cannot be generalised

**This is a good outcome, not a bug.** We would much rather have no article than
one that sends the next customer down a wrong path. Common honest reasons: the
resolution was a one-off, it was really an incident status rather than a stable
answer, or it was too vague to reproduce.

If you disagree, write a fuller ideal answer on the ticket and ask again.

---

## Publishing

**Approved articles are not published anywhere automatically.** They wait in the
Articles tab (and in the `approved_articles` view) for a human to paste into the
help centre.

This is a deliberate choice, not an unfinished feature. Writing into Freshdesk's
knowledge base would be a **third system we write to** — today we only ever post
a private note and up to three tags — and that widens the security review the
project has kept deliberately narrow. If we want it, we should decide it openly
rather than let it arrive as a side effect.

---

## If something looks wrong

- **A save fails with red text** — that text is the real error. Send it to
  Tobias rather than retrying blindly.
- **The AI keeps proposing articles that are not worth writing** — say so. That
  means the rules in the prompt are too loose, and the fix is to tighten them,
  not to make you filter more.
- **An approved article turns out to be wrong** — open it in the Articles tab,
  fix it and press **Spara**. The approval and the approver are preserved.

---

## The short version

> Solve the ticket → write the ideal answer → ask for an article → check it is
> true and general → approve.

Every article you approve is one question the AI can answer correctly next time
without needing you. That is the whole point of the exercise.
