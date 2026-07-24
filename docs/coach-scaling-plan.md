# Detaljerad plan: från Gate 1 till ett skalbart AI Coach-system

> **Om detta dokument.** Detta är den övergripande utvecklings-, kvalitets- och
> skalningsplanen för AI Coach-systemet. Den kombinerar och bygger vidare på det
> som redan är beslutat i gates (se `CLAUDE.md` §12) och kompletterar
> `docs/roadmap.md`, som beskriver den *deferrerade* datakälls-expansionen
> (Jira / Confluence / Planhat / Slack). Där denna plan och tidigare
> gate-beslut överlappar gäller den mest specifika/senaste beskrivningen —
> flagga uttryckligen om något behöver ändras i stället för att tyst avvika.
>
> **Bärande princip:** skala inte mängden AI-svar först. Skala kvaliteten,
> bevisningen och förtroendet.

---

## 1. Målbild

Projektet ska utvecklas från ett granskningsverktyg till ett internt stödsystem som:

- hjälper agenten att svara snabbare och bättre,
- coachar agenten i ton, kontrollpunkter och risker,
- identifierar incidenter och återkommande kundproblem,
- hittar brister i kunskapsbasen,
- ger ledningen strukturerade insikter om kvalitet, kapacitet och produktfriktion.

AI:n ska initialt **aldrig** skicka kundsvar automatiskt.

---

## 2. Skalningsmodell

| Gate | Funktion | Användare | Krav för nästa gate |
|---|---|---|---|
| **Gate 1: Coach Review** | Människor granskar historiska AI-förslag | Tobias och Johanna | Stabil utvärdering och golden set |
| **Gate 2: Shadow Coach** | AI analyserar aktuella ärenden utan att visas för agenten | Projektgruppen | Tillräcklig kvalitet på verkliga ärenden |
| **Gate 3: Agent Assist** | Agenten får coachning och svarsutkast | Pilotgrupp | Dokumenterad tids- och kvalitetsvinst |
| **Gate 4: Scaled Coach** | Tillgängligt för hela Customer Care | CC Sverige/Norge | Stabil drift, säkerhet och governance |
| **Gate 5: Customer Intelligence** | Produkt-, KB- och ledningsinsikter | Product, CS, ledning | Tillförlitlig klassificering och volym |
| **Gate 6: Begränsad automation** | Automatisering av mycket enkla, verifierade flöden | Utvalda ärendetyper | Extremt låg risk och mänsklig fallback |

---

## Fas 1: Stabil Gate 1

**Period:** Vecka 1–2.

**Syfte:** Göra granskningsverktyget tillräckligt robust för att producera
pålitlig tränings- och utvärderingsdata.

### 1.1 Slutför pågående kod

**PR #19 – persistent inloggning**

- Granska refresh-token-flödet.
- Verifiera att utloggning raderar sessionen.
- Testa utgången refresh-token.
- Testa flera dagars inloggning.
- Kontrollera att obehöriga användare stoppas av RLS, inte bara frontend.
- Logga misslyckade autentiseringsförsök.
- Mergas först efter ett komplett test.

**Granskningsgränssnittet** — dela förbättringen i mindre leveranser:

- läsbarhet och WCAG,
- kundens ursprungsfråga,
- sökning, filtrering och sortering,
- autosave,
- strukturerade felskäl,
- dubblett- och likhetsstöd,
- metadata och versionsinformation.

Det minskar risken att en stor frontendändring blir svår att felsöka.

### 1.2 Autosave

Autosave är en **blockerande** funktion innan större granskning påbörjas. Det ska:

- spara efter exempelvis 800–1 500 ms utan nya ändringar,
- visa *Sparar*, *Sparat* eller *Kunde inte spara*,
- behålla osparad text vid nätverksfel,
- försöka spara igen,
- varna innan sidan lämnas om data inte är sparad,
- skydda mot att två granskare skriver över varandra,
- lagra senaste ändringstid och granskare.

Lägg gärna till ett versionsnummer på granskningen för optimistisk låsning.

### 1.3 Strukturerad granskning

Varje granskning ska innehålla:

**Grundbedömning**

- Godkänd
- Delvis godkänd
- Underkänd
- Ej bedömningsbar

**Felskäl**

- Felaktig fakta
- Obelagt antagande
- Felaktig problemorsak
- Fel lösning
- Fel incident
- Föråldrad incidentstatus
- Fel routning
- Missad kundfråga
- Missad kontrollpunkt
- Fel språk
- Svag ton
- För långt eller otydligt
- Säkerhets- eller integritetsrisk
- AI borde ha avstått
- Bilaga kunde inte granskas
- Otillräcklig kunskapskälla

**Kritisk flagga** — ett separat fält för allvarliga fel:

- felaktig juridisk rådgivning,
- felaktig radering,
- obehörig åtkomst,
- personuppgiftsrisk,
- felaktigt kundlöfte,
- påhittad produktfunktion.

Ett kritiskt fel ska automatiskt göra förslaget **underkänt**.

### 1.4 Datamodell

Utöver befintliga fält bör varje förslag kunna spåra:

`reviewer_id`, `review_status`, `reason_codes`, `critical_error`, `gold_answer`,
`gold_answer_verified`, `verified_source_ids`, `coach_mode`,
`requires_agent_action`, `model_version`, `prompt_version`, `playbook_version`,
`retrieval_version`, `retrieved_source_ids`, `comparison_reply_id`,
`context_cutoff_at`, `holdout_cohort`, `review_version`, `updated_at`.

Det gör varje resultat reproducerbart.

### 1.5 Definition of Done för Fas 1

- Inloggningen fungerar stabilt över flera dagar.
- Alla dataskrivningar skyddas av RLS.
- Autosave fungerar även vid tillfälligt nätverksfel.
- Kundfråga, AI-svar, agentens svar och källor visas tydligt.
- Granskningen kan filtreras per språk, typ, verdict och risk.
- Alla svar kan kopplas till modell-, prompt- och playbookversion.
- Spam och autosvar kan markeras och exkluderas.
- Två granskare kan inte tyst skriva över varandra.

---

## Fas 2: Gör utvärderingen vetenskapligt trovärdig

**Period:** Vecka 2–4.

### 2.1 Separera tre datamängder

- **Learning set** — godkända exempel som AI:n får använda som few-shot eller
  retrieval.
- **Development set** — används löpande när promptar, playbook och retrieval
  förbättras.
- **Locked holdout** — ärenden som **aldrig** får användas:
  - som gold answers,
  - vid promptutveckling,
  - som retrieval-källa till sig själva,
  - för att skapa regler som senare testas på samma ärenden.

  Holdout-listan ska versionshanteras och vara låst.

### 2.2 Storlek

Första milstolpen:

- 100 verifierade learning-exempel,
- 50 development-exempel,
- 100 låsta holdout-exempel.

Tio gold answers räcker endast som tekniskt smoke test.

### 2.3 Balansera urvalet

Urvalet ska fördelas över:

- norska, svenska och engelska,
- BUG, QUESTION, HOWTO och UNCLEAR,
- olika produktmoduler,
- enkla och komplexa ärenden,
- juridisk routning,
- incidenter,
- behörighetsfrågor,
- bilagor,
- tekniska fel,
- missnöje eller brutet återkopplingslöfte.

Undvik att 50 nästan identiska avtalsfel dominerar mätningen.

### 2.4 Replay-regler

Replayen ska välja ett specifikt agentsvar och **endast** visa AI:n information
som fanns *före* det svaret. Följande ska alltid filtreras bort:

- målärendet som retrieval-källa,
- senare agentmeddelanden,
- senare kundmeddelanden,
- senare interna anteckningar,
- ärenden som inte fanns vid den simulerade tidpunkten,
- autosvar och holding replies.

Logga:

- valt agentsvar,
- tidpunkt för kontextavskärningen,
- vilka meddelanden som inkluderades,
- vilka källor som hämtades.

### 2.5 Bedömningsrubrik

Bedöm varje AI-resultat på:

| Dimension | Poäng |
|---|---|
| Faktamässig korrekthet | 0–2 |
| Grundning i tillåtna källor | 0–2 |
| Rätt lösning/nästa steg | 0–2 |
| Ton och tydlighet | 0–1 |
| Språk | 0–1 |
| Säkerhet och omdöme | 0–2 |
| **Totalt** | **0–10** |

Kritiska fel ska även registreras **separat**, eftersom ett genomsnitt annars kan
dölja allvarliga risker.

### 2.6 Definition of Done för Fas 2

- Inget målärende förekommer som egen källa.
- Alla jämförelser gäller samma dialogtur.
- Holdout-setet är låst.
- Minst 20 % av ärendena dubbelgranskas av Tobias och Johanna.
- Skillnader mellan granskarna diskuteras och rubriceringen kalibreras.
- Ett fryst baseline-resultat har dokumenterats.

---

## Fas 3: Formalisera AI Coach

**Period:** Vecka 3–5.

### 3.1 Tre outputlägen

AI:n ska alltid välja ett av följande:

**`REPLY_READY`** — används endast när:

- lösningen är verifierad,
- rätt källa finns,
- ingen systemkontroll krävs,
- ingen bilaga behöver granskas,
- inga kritiska risker finns.

**`COACH_AGENT`** — AI:n ger:

- vad agenten bör tänka på,
- vilka kontroller som krävs,
- möjliga orsaker tydligt märkta som hypoteser,
- preliminär text om det är säkert.

**`AGENT_ACTION_REQUIRED`** — används när:

- en bilaga måste öppnas,
- kundens roller måste kontrolleras,
- systemåtkomst krävs,
- identitet måste verifieras,
- incidentmatchningen är osäker,
- frågan måste routas.

Här ska inget send-ready svar produceras om det riskerar att bli missvisande.

### 3.2 Strukturerat AI-format

AI:n bör returnera ett internt JSON-kontrakt:

```json
{
  "classification": "BUG",
  "language": "no",
  "confidence": "low",
  "coach_mode": "AGENT_ACTION_REQUIRED",
  "customer_need": "...",
  "facts_from_ticket": [],
  "hypotheses": [],
  "checks_required": [],
  "risk_flags": [],
  "incident_match": null,
  "sources": [],
  "agent_coaching": "...",
  "reply_draft": null
}
```

Frontend kan sedan presentera detta begripligt.

### 3.3 Obligatoriska guardrails

**Bilagor.** Om AI:n inte kan läsa en nödvändig bilaga:
*Agentåtgärd krävs: öppna bilagan och kör analysen igen.* AI:n får **inte** säga
till kunden att den själv inte kan läsa bilagan.

**Roller och åtkomst.** AI:n får säga: *Kontrollera om användaren har rollen X.*
Den får **inte** säga: *Användaren saknar rollen X* om detta inte uttryckligen står
i underlaget.

**Radering.** Före konto- eller dataradering:

- verifiera identitet,
- verifiera kontorelation,
- verifiera behörighet,
- verifiera exakt raderingsobjekt,
- kontrollera retention och juridiska krav.

**Juridik.** Juridikregeln ska endast aktiveras för frågor om rättigheter,
skyldigheter, lag, lön, semester, sjukpenning eller anställningsvillkor.
Produktfrågor som "kan systemet förhandssignera?" ska **inte** routas till Expert.

**Brutet kundlöfte.** Om kunden inte blivit uppringd eller fått utlovad
återkoppling ska AI:n coacha agenten att:

- be om ursäkt konkret,
- ta ansvar,
- svara på sakfrågan,
- förklara nästa steg.

### 3.4 Definition of Done för Fas 3

- Alla AI-resultat har ett av de tre lägena.
- Bilagor och systemkontroller skapar inte falska kundlöften.
- Kritiska åtgärder kräver mänsklig kontroll.
- Kundsvaret innehåller alla relevanta kundsteg från analysen.
- AI:n skiljer fakta från hypoteser.

---

## Fas 4: Kunskaps- och incidentlager

**Period:** Vecka 4–7.

### 4.1 Källhierarki

AI:n ska prioritera:

1. aktiv verifierad incident,
2. officiell KB,
3. godkänt gold answer,
4. verifierat historiskt ärende,
5. generell modellkunskap.

Produktfakta får inte baseras enbart på generell modellkunskap.

### 4.2 Incidentmodell

Varje incident behöver: `incident_id`, produktområde, symptom,
inkluderingskriterier, exkluderingskriterier, status, startdatum, resolved-datum,
workaround, åtgärd efter rättning, berörda versioner, ansvarigt team, senaste
verifiering, länk till utvecklingsärende, kundkommunikation.

**Status:** Possible · Confirmed · Investigating · Workaround available · Fixed · Closed.

### 4.3 Aktiv incidentdetektion

Analysera inkommande ärenden mot: liknande symptom, samma produktområde, samma
feltext, samma tidsperiod, flera kunder.

> Exempel: *Fyra kunder har rapporterat samma avtalsfel under två timmar. Möjlig
> incident – manuell verifiering krävs.*

AI:n ska **inte** själv skapa en bekräftad incident. Den ska *föreslå* den.

### 4.4 Kunskapsluckor

När AI:n inte hittar en verifierad lösning ska systemet skapa en
**knowledge-gap-signal**:

- saknad KB-artikel,
- föråldrad artikel,
- motstridiga källor,
- lösning finns bara i historiska tickets,
- agenten löste problemet utan dokumenterad källa.

Rapportera de tio viktigaste luckorna varje vecka.

---

## Fas 5: Shadow mode i produktion

**Period:** Vecka 6–8.

**Syfte:** Testa AI:n på verkliga inkommande ärenden utan att påverka agenten
eller kunden.

**Genomförande**

- AI:n analyserar alla relevanta nya ärenden.
- Resultaten visas inte för agenten.
- Agenten arbetar som vanligt.
- Efteråt jämförs AI:n med agentens första substantiella svar.
- Spam, autosvar och telefonloggar filtreras bort.
- Modellen och playbookversionen fryses under mätperioden.

**Mätning** — minst:

- 300 verkliga ärenden, helst 500 eller fler,
- jämn fördelning mellan språk och produktområden,
- separat rapportering för olika ärendetyper.

**Krav för Gate 3**

- AI-kvalitet minst 4,3/5 eller motsvarande rubricerad nivå.
- Inga kritiska fel i det senaste säkerhetsurvalet.
- Minst 90 % korrekt språk.
- Minst 90 % korrekt routning.
- Säker avhållsamhet vid otillräcklig information.
- Ingen benchmarkläcka eller dialogtursmiss.

---

## Fas 6: Agentpilot

**Period:** Vecka 9–12.

**Pilotgrupp**

- 5–8 agenter,
- Sverige och Norge,
- Johanna som kvalitetschampion,
- Tobias som produktägare,
- ett till två avgränsade produktområden.

**Agentgränssnitt** — agenten ska se:

- kundens behov i en mening,
- klassificering och confidence,
- vad AI:n vet,
- vad AI:n inte vet,
- kontrollpunkter,
- eventuellt incidentförslag,
- använda källor,
- svarsutkast,
- snabb feedback.

**Feedbackknappar:** Användbart · Delvis användbart · Inte användbart · Fel eller riskfyllt.

**Pilotdesign** — använd antingen:

- pilotgrupp och kontrollgrupp, eller
- stegvis utrullning där samma agenter jämförs före och efter.

Undvik att ändra prompt och playbook dagligen under mätperioden. Arbeta i fasta
veckoversioner.

**Pilotmål**

- minst 70 % bedömer coachningen som användbar,
- minst 40 % använder utkast med små ändringar,
- 10–15 % lägre aktiv hanteringstid,
- ingen försämring av CSAT,
- ingen försämring av SLA,
- ingen ökning av återöppnade ärenden,
- inga kritiska säkerhetsfel.

---

## Fas 7: Management- och produktinsikter

**Period:** Månad 4–5.

Skapa dashboards för:

**Customer Care**

- AI-användning per agent,
- accepterade förslag,
- vanligaste coachingbehov,
- ton- och språkproblem,
- kunskapsluckor,
- ärendetyper som tar längst tid.

**Produktorganisationen**

- återkommande produktfel,
- nya incidentkluster,
- kunder påverkade per problem,
- volym före och efter rättning,
- workaround-användning,
- ärenden som kunde ha undvikits med bättre UX.

**Knowledge Management**

- mest använda artiklar,
- artiklar som leder till fel lösning,
- frågor utan KB-stöd,
- gold answers som borde bli artiklar,
- artiklar med föråldrade steg.

**Ledningen**

- sparade timmar,
- kostnad per AI-assisterat ärende,
- kapacitetseffekt,
- kvalitetsutveckling,
- CSAT- och SLA-effekt,
- produktområden med störst kundfriktion.

---

## Fas 8: Teknisk produktionshärdning

**Period:** Månad 4–6.

**Frontend** — ni kan behålla vanilla JavaScript, men dela upp den växande
`index.html`:

- `auth.js`, `api.js`, `state.js`, `review.js`, `render.js`, `filters.js`,
  `styles.css`.

Det behövs inte ett nytt ramverk för att skala Gate 1.

**Backend och säkerhet**

- Supabase RLS på alla relevanta tabeller.
- Inga service-role-nycklar i frontend.
- Känsliga operationer via Edge Functions/backend.
- Auditlogg.
- Rate limiting.
- EU-region.
- Fastställd retention.
- Personuppgiftsmaskering där möjligt.
- Kontroll av underbiträden och LLM-datalagring.
- Versionshantering av prompt, modell och kunskap.

**Freshdesk-integration** — när pilotvärdet är bevisat:

- bygg en Freshdesk-app eller sidebar,
- hämta aktuell ticketkontext,
- visa coachningen utan kontextbyte,
- registrera vilka delar agenten använder,
- skapa **aldrig** publikt svar utan agentens aktiva val.

---

## Roller och ansvar

| Roll | Ansvar |
|---|---|
| **Produktägare – Tobias** | Prioritering, effektmål, pilot och ledningsrapportering |
| **Kvalitetschampion – Johanna** | Gold answers, rubricering och agentfeedback |
| **Teknisk ägare** | Kod, Supabase, deployment och incidenter |
| **Knowledge owners** | Godkänna produktlösningar och KB |
| **Produkt/Engineering** | Aktiva incidenter och rättningsstatus |
| **Security/DPO** | GDPR, åtkomst och audit |
| **Pilotagenter** | Användning, feedback och verklighetskontroll |

### Veckomöte, 30–45 minuter

Agenda:

- resultat sedan förra veckan,
- kritiska AI-fel,
- vanligaste underkännandeorsaker,
- kunskapsluckor,
- nya eller ändrade incidenter,
- beslut om nästa versionsändring.

---

## Prioriterad backlog

**P0 – måste göras före pilot**

- Merge och testa PR #19.
- Autosave.
- Strukturerade felskäl.
- Grön/Gul/Röd-output.
- Exakt dialogtursavskärning.
- Holdout-separation.
- Spam- och autosvarsfilter.
- Bilageguardrail.
- Raderingsguardrail.
- Incidentstatus.
- Versionsspårning.
- Auditlogg.

**P1 – ska finnas under pilot**

- Agentfeedback.
- Källvisning.
- Freshdesk-sidebar eller enkel integration.
- Dubblettdetektion.
- Telemetri för användning och ändringar.
- Dashboard för kvalitet och tid.
- Knowledge-gap-rapport.

**P2 – efter bevisat värde**

- Automatisk incidentdetektion.
- Produktfriktionsdashboard.
- Expansionsstöd till flera team.
- Begränsad automatisering av verifierade lågriskflöden.
- Eventuell fine-tuning.

> Fine-tuning bör inte prioriteras innan ni har minst omkring **1 000**
> kvalitetskontrollerade exempel och ett stabilt holdout-test. Fram till dess ger
> playbook, retrieval och godkända exempel större kontroll.

---

## Beslutspunkt efter 90 dagar

**Skala vidare om**

- AI:n når minst 4,3/5 på låst holdout,
- avståndet till människan är högst cirka 0,3–0,4 poäng,
- minst 70 % av coachningen är användbar,
- hanteringstiden minskar minst 10 %,
- CSAT och SLA är stabila eller bättre,
- inga kritiska fel har observerats i det senaste säkerhetsurvalet.

**Fortsätt begränsad utveckling om**

- agentnyttan finns men kunskapsfelen är för många,
- incidentstatus fortfarande är osäker,
- bilagor eller behörighetskontroller fungerar dåligt,
- kvalitetsvinsten inte kan skiljas från urvalsbias.

**Stoppa expansion om**

- verktyget skapar fler följdfrågor,
- agenten måste kontrollera allt AI:n säger,
- kritiska fel återkommer,
- hanteringstiden inte minskar,
- agenterna tappar förtroende för verktyget.

---

## Konkret startordning

1. Merge och verifiera PR #19.
2. Implementera autosave.
3. Implementera strukturerade felskäl och kritisk flagga.
4. Inför Grön/Gul/Röd-output.
5. Säkra replay, dialogtur och holdout.
6. Skapa 100 balanserade gold answers.
7. Strukturera incidenterna med status och efteråtgärder.
8. Kör ett fryst baseline-test.
9. Kör shadow mode på minst 300 ärenden.
10. Starta en fyra veckor lång agentpilot.
11. Räkna kvalitet, tidsbesparing och kapacitetsvärde.
12. Presentera ett skalningsbeslut för Customer- och produktledningen.

> Den avgörande principen är: **skala inte mängden AI-svar först. Skala kvaliteten,
> bevisningen och förtroendet.**
