/* ===========================================================================
   HR i AI-eran — Simployer
   ---------------------------------------------------------------------------
   DATALAGRET ÄR KÄRNAN.

   Sidan renderar ingenting från markup:en. Allt kommer från ETT dataobjekt som
   laddas av loadData(), vilket betyder att man kan peka om DATA_URL till en
   riktig källa utan att röra vare sig layout eller CSS.

   loadData() gör, i tur och ordning:
     1. fetch() mot DATA_URL, med en hård timeout (AbortController).
     2. Om URL saknas, svaret inte är ok, kroppen är tom, JSON:en inte går att
        tolka, eller den inte validerar mot schemat → console.warn + getDummyData().

   Fel hanteras tyst FÖR ANVÄNDAREN — inga trasiga vyer, inga felmeddelanden i
   gränssnittet. Men aldrig tyst för utvecklaren: varje fallback loggas med skäl.

   När dummydata används sätts meta.isDemo och en tydlig banner visas.
   =========================================================================== */

"use strict";

/* --- Konfiguration ------------------------------------------------------ */

/** Peka om denna till din riktiga källa. Sätt till "" för att alltid köra demo. */
var DATA_URL = "./data/simployer-cx.json";

/** Timeout innan vi ger upp och faller tillbaka till demodata. */
var FETCH_TIMEOUT_MS = 5000;

/* --- Schemavalidering --------------------------------------------------- */
/*
   Medvetet grund men strukturell: den kontrollerar att varje sektion finns och
   har rätt form, för det är precis det som annars ger en halvrenderad sida.
   Den kontrollerar INTE innehållets rimlighet — data som validerar men är tom
   fångas av längdkraven nedan.
*/

function isArr(v, min) { return Array.isArray(v) && v.length >= (min || 1); }
function isStr(v) { return typeof v === "string" && v.trim().length > 0; }
function isNum(v) { return typeof v === "number" && isFinite(v); }

function validateData(d) {
  var errors = [];
  function need(cond, msg) { if (!cond) errors.push(msg); }

  need(d && typeof d === "object", "roten är inte ett objekt");
  if (!d || typeof d !== "object") return { ok: false, errors: errors };

  need(d.meta && typeof d.meta === "object", "meta saknas");
  need(d.hero && typeof d.hero === "object", "hero saknas");
  if (d.hero) {
    need(isStr(d.hero.title), "hero.title saknas");
    need(isStr(d.hero.ingress), "hero.ingress saknas");
    need(isArr(d.hero.ctas), "hero.ctas är tom");
    need(isArr(d.hero.stats, 3), "hero.stats behöver minst 3 nyckeltal");
  }

  need(isArr(d.trends, 1), "trends är tom");
  (d.trends || []).forEach(function (t, i) {
    need(isStr(t.tab) && isStr(t.title) && isStr(t.desc), "trends[" + i + "] saknar text");
    need(isNum(t.percent), "trends[" + i + "].percent är inte ett tal");
    need(isStr(t.forCustomer) && isStr(t.risk) && isStr(t.recommendation),
      "trends[" + i + "] saknar ett av de tre blocken");
  });

  need(isArr(d.journeys, 1), "journeys är tom");
  (d.journeys || []).forEach(function (j, i) {
    need(isStr(j.id) && isStr(j.label), "journeys[" + i + "] saknar id/label");
    need(isArr(j.steps, 1), "journeys[" + i + "].steps är tom");
    (j.steps || []).forEach(function (s, k) {
      need(isStr(s.title) && isNum(s.friction), "journeys[" + i + "].steps[" + k + "] är ofullständigt");
    });
    need(j.indicators && isNum(j.indicators.speed) && isNum(j.indicators.effort) && isNum(j.indicators.trust),
      "journeys[" + i + "].indicators är ofullständig");
  });

  need(isArr(d.contextLayers, 1), "contextLayers är tom");
  (d.contextLayers || []).forEach(function (c, i) {
    need(isStr(c.id) && isStr(c.label) && isNum(c.frictionReduction),
      "contextLayers[" + i + "] är ofullständigt");
  });

  need(isArr(d.matrixCases, 1), "matrixCases är tom");
  (d.matrixCases || []).forEach(function (m, i) {
    need(isStr(m.id) && isStr(m.label), "matrixCases[" + i + "] saknar id/label");
    need(isNum(m.complexity) && isNum(m.sensitivity), "matrixCases[" + i + "] saknar koordinater");
  });

  need(isArr(d.sources, 1), "sources är tom");

  return { ok: errors.length === 0, errors: errors };
}

/* --- Laddning ----------------------------------------------------------- */

function fetchWithTimeout(url, ms) {
  // AbortController ger en riktig timeout: annars kan en hängande begäran hålla
  // sidan i laddningsläge hur länge som helst.
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, ms);
  return fetch(url, { signal: ctrl.signal, cache: "no-store" })
    .finally(function () { clearTimeout(timer); });
}

async function loadData() {
  function demo(reason) {
    console.warn("[data] faller tillbaka till demodata: " + reason);
    var d = getDummyData();
    d.meta = d.meta || {};
    d.meta.isDemo = true;
    d.meta.fallbackReason = reason;
    return d;
  }

  if (!DATA_URL) return demo("DATA_URL är inte satt");

  var res;
  try {
    res = await fetchWithTimeout(DATA_URL, FETCH_TIMEOUT_MS);
  } catch (e) {
    // Täcker både timeout (AbortError) och nätverksfel. Att öppna sidan via
    // file:// hamnar också här, eftersom fetch då blockeras av CORS.
    return demo(e && e.name === "AbortError"
      ? "timeout efter " + FETCH_TIMEOUT_MS + " ms"
      : "hämtningen misslyckades (" + ((e && e.message) || e) + ")");
  }

  if (!res.ok) return demo("HTTP " + res.status);

  var text;
  try { text = await res.text(); } catch (e) { return demo("kunde inte läsa svaret"); }
  if (!text || !text.trim()) return demo("tomt svar");

  var parsed;
  try { parsed = JSON.parse(text); } catch (e) { return demo("ogiltig JSON"); }

  var v = validateData(parsed);
  if (!v.ok) return demo("schemat validerade inte → " + v.errors.join("; "));

  parsed.meta = parsed.meta || {};
  // Källan får säga att den själv är demo; annars är riktig data riktig data.
  parsed.meta.isDemo = parsed.meta.isDemo === true;
  return parsed;
}

/* --- Demodata ------------------------------------------------------------ */
/*
   Komplett och realistisk, i exakt samma schema som en riktig källa. Siffrorna
   är ILLUSTRATIVA — de är valda för att vara rimliga och för att visa hur sidan
   beter sig, inte hämtade ur någon mätning. Källsektionen säger detta rakt ut
   när demoläget är på.
*/

function getDummyData() {
  return {
    meta: {
      isDemo: true,
      source: "Demodata — illustrativa exempel",
      published: "2026-08-05"
    },

    hero: {
      title: "HR i <em>AI-eran</em>",
      ingress: "AI besvarar allt fler av medarbetarnas frågor på sekunder. Det gör inte HR mindre viktigt — det flyttar HR:s tid dit där bedömning, ansvar och förtroende faktiskt krävs. Den här sidan visar var gränsen går.",
      ctas: [
        { label: "Utforska trenderna", href: "#trender", variant: "primary" },
        { label: "Testa medarbetarresan", href: "#resan", variant: "ghost" }
      ],
      stats: [
        { value: "68 %", key: "av medarbetarfrågorna är återkommande", detail: "Semester, sjukfrånvaro, lönespecifikation och policyfrågor — samma frågor, hela året." },
        { value: "4,2 h", key: "per vecka som en chef lägger på HR-administration", detail: "Tid som inte går till att leda, coacha eller följa upp sitt team." },
        { value: "1 av 5", key: "ärenden kräver en mänsklig bedömning", detail: "Känsliga situationer, arbetsrätt och undantag — där ett självsäkert AI-svar kostar mest." }
      ],
      fact: "Underlaget nedan visar hur ärendetyper fördelar sig över komplexitet och känslighet, och vad det innebär för var automatisering hör hemma."
    },

    trends: [
      {
        tab: "AI som svarar med källor",
        title: "Svar utan belägg är en gissning med självförtroende",
        desc: "Assistenten Sia svarar inte bara — den visar vilken policy, vilket avtal eller vilken artikel svaret vilar på. Det förvandlar ett påstående till något medarbetaren kan kontrollera, och chefen kan stå för.",
        percent: 74,
        forCustomer: "Medarbetaren får svaret direkt och ser var det kommer ifrån, i stället för att lita på en svart låda.",
        risk: "Ett välformulerat men ogrundat svar är farligare än inget svar — det låter rätt och sprids vidare.",
        recommendation: "Kräv källhänvisning som villkor för att ett AI-svar ska få skickas. Saknas källa: lämna över till HR."
      },
      {
        tab: "Self-service",
        title: "Medarbetaren löser det själv — när systemet gör det möjligt",
        desc: "Semesteransökan, adressändring, intyg och lönespecifikation behöver inte passera en människa. Poängen är inte att spara HR-tid, utan att medarbetaren slipper vänta på någon annans kalender.",
        percent: 61,
        forCustomer: "Ärendet blir klart samma minut, utan att någon behöver vara på plats eller vaken.",
        risk: "Self-service som inte täcker undantagen skickar tillbaka de svåraste fallen till en redan belastad HR-funktion — med en frustrerad medarbetare på köpet.",
        recommendation: "Mät andelen ärenden som avslutas utan handpåläggning, och följ särskilt de som faller ur flödet."
      },
      {
        tab: "Automatiserade processer",
        title: "Onboarding och offboarding är checklistor, inte konstverk",
        desc: "En anställning startar och avslutas med samma steg varje gång: konton, utrustning, avtal, behörigheter, introduktion. Det är precis den sortens process som mår bra av att köras likadant varje gång.",
        percent: 83,
        forCustomer: "Nyanställda har allt på plats dag ett, och den som slutar får ett korrekt och värdigt avslut.",
        risk: "Offboarding som halkar efter lämnar behörigheter öppna — ett säkerhetsproblem långt innan det blir ett HR-problem.",
        recommendation: "Automatisera stegen men behåll en mänsklig avstämningspunkt vid avslut, där något faktiskt står på spel."
      },
      {
        tab: "Datadriven insikt",
        title: "Mönster syns i mängden, inte i enskilda ärenden",
        desc: "Tio sjukanmälningar på samma avdelning på en månad är ett mönster. Var för sig är de tio enskilda händelser som ingen hinner koppla ihop.",
        percent: 47,
        forCustomer: "Chefen får syn på trender tidigt nog att kunna göra något åt dem.",
        risk: "Aggregerad data om få personer är inte anonym. Ett diagram över en avdelning med fyra medlemmar pekar ut individer.",
        recommendation: "Sätt en lägsta gruppstorlek innan siffror visas, och besluta den innan någon efterfrågar undantag."
      },
      {
        tab: "Transparens i beslut",
        title: "Om AI påverkar ett beslut ska det gå att förklara",
        desc: "Rekommendationer som rör anställning, lön eller uppföljning måste kunna motiveras för den de gäller — inte bara för den som fattar beslutet.",
        percent: 92,
        forCustomer: "Medarbetaren kan ifrågasätta ett beslut på riktiga grunder i stället för att möta ett system.",
        risk: "Ett beslut som ingen kan förklara går heller inte att försvara — vare sig inför medarbetaren eller inför en granskning.",
        recommendation: "Logga vad AI:n föreslog, vad människan ändrade och varför. Det är både spårbarhet och lärande."
      }
    ],

    journeys: [
      {
        id: "semester",
        label: "Semesteransökan",
        tagline: "Det enklaste ärendet — och därför det som aldrig borde nå HR.",
        steps: [
          { title: "Medarbetaren ansöker", desc: "Öppnar Simployer One och väljer datum.", friction: 10 },
          { title: "Saldo kontrolleras", desc: "Systemet räknar automatiskt kvarvarande dagar.", friction: 5 },
          { title: "Chefen får notis", desc: "Godkänner direkt i mobilen.", friction: 20 },
          { title: "Bekräftelse", desc: "Kalender och lönesystem uppdateras utan mellanhand.", friction: 5 },
          { title: "Avslutat", desc: "Ingen människa har behövt läsa ärendet.", friction: 0 }
        ],
        indicators: { speed: 95, effort: 12, trust: 88 },
        complexity: 12, sensitivity: 10,
        recommendedPath: "Helautomatiserad. Låt AI bekräfta direkt och eskalera bara vid kollision med bemanningskrav."
      },
      {
        id: "lon",
        label: "Lönefråga",
        tagline: "Ofta enkel att svara på, men aldrig oviktig för den som frågar.",
        steps: [
          { title: "Frågan ställs", desc: "\"Varför skiljer sig min lön den här månaden?\"", friction: 25 },
          { title: "AI läser lönespecen", desc: "Identifierar avvikelsen — retroaktiv justering.", friction: 15 },
          { title: "Svar med underlag", desc: "Visar posten och vilket avtal den vilar på.", friction: 20 },
          { title: "Medarbetaren följer upp", desc: "Undrar om det påverkar semesterersättningen.", friction: 45 },
          { title: "HR bekräftar", desc: "En kort mänsklig avstämning avslutar ärendet.", friction: 30 }
        ],
        indicators: { speed: 74, effort: 34, trust: 71 },
        complexity: 45, sensitivity: 58,
        recommendedPath: "AI svarar med underlag, men lämnar alltid en synlig väg till en människa. Pengar tål inte gissningar."
      },
      {
        id: "sjuk",
        label: "Sjukanmälan",
        tagline: "Måste vara friktionsfri — den görs av någon som mår dåligt.",
        steps: [
          { title: "Anmälan görs", desc: "Två knapptryck, ingen inloggning i onödan.", friction: 8 },
          { title: "Chef och lön informeras", desc: "Rätt personer, automatiskt, utan vidarebefordran.", friction: 5 },
          { title: "Dag 8 närmar sig", desc: "Systemet påminner om läkarintyg.", friction: 30 },
          { title: "Rehab-flagga", desc: "Upprepad frånvaro flaggas för chefens uppmärksamhet.", friction: 55 },
          { title: "Uppföljningssamtal", desc: "Bokas av chefen — inte av systemet.", friction: 40 }
        ],
        indicators: { speed: 91, effort: 18, trust: 79 },
        complexity: 38, sensitivity: 76,
        recommendedPath: "Automatisera anmälan och påminnelser. Låt aldrig AI tolka orsaken eller föreslå åtgärder om hälsa."
      },
      {
        id: "samtal",
        label: "Medarbetarsamtal",
        tagline: "AI kan förbereda samtalet. Det kan inte föra det.",
        steps: [
          { title: "Underlag samlas", desc: "Mål, tidigare samtal och utvecklingsplan hämtas ihop.", friction: 20 },
          { title: "AI föreslår teman", desc: "Utifrån vad som faktiskt förändrats sedan sist.", friction: 25 },
          { title: "Chefen justerar", desc: "Lägger till det som inte står i något system.", friction: 35 },
          { title: "Samtalet hålls", desc: "Helt mänskligt, utan lyssnande assistent.", friction: 15 },
          { title: "Sammanfattning", desc: "Chefen godkänner innan något sparas.", friction: 30 }
        ],
        indicators: { speed: 62, effort: 44, trust: 83 },
        complexity: 62, sensitivity: 68,
        recommendedPath: "AI förbereder och sammanfattar. Människan äger samtalet och det som skrivs ned."
      },
      {
        id: "risk",
        label: "Uppsägningsrisk",
        tagline: "Högsta insats för individen. Lägsta tolerans för fel.",
        steps: [
          { title: "Signaler samlas", desc: "Frånvaro, engagemang och rörlighet i teamet.", friction: 40 },
          { title: "Mönster indikeras", desc: "Systemet pekar på en förhöjd risk — utan att dra slutsatser.", friction: 60 },
          { title: "HR granskar", desc: "En människa avgör om signalen betyder något.", friction: 55 },
          { title: "Samtal förbereds", desc: "Chefen får stöd i hur samtalet kan inledas.", friction: 45 },
          { title: "Åtgärd beslutas", desc: "Alltid av en människa, alltid dokumenterat.", friction: 70 }
        ],
        indicators: { speed: 41, effort: 68, trust: 64 },
        complexity: 84, sensitivity: 92,
        recommendedPath: "AI får indikera, aldrig avgöra. Varje steg som rör en enskild anställning ska bära ett mänskligt namn."
      }
    ],

    contextLayers: [
      { id: "historik",  label: "Anställningshistorik", desc: "Roll, avdelning, anställningstid och tidigare förändringar.", frictionReduction: 14 },
      { id: "arenden",   label: "Tidigare ärenden",     desc: "Vad personen frågat om förut, och hur det löstes.",           frictionReduction: 18 },
      { id: "avtal",     label: "Avtals- och lönedata", desc: "Kollektivavtal, lönemodell och gällande villkor.",            frictionReduction: 22 },
      { id: "summering", label: "AI-sammanfattning",    desc: "En kort lägesbild i stället för hela ärendehistoriken.",      frictionReduction: 12 },
      { id: "sentiment", label: "Engagemang och sentiment", desc: "Signaler om hur personen mår i sin roll över tid.",       frictionReduction: 9 }
    ],

    matrixCases: [
      { id: "semester", label: "Semesteransökan",   complexity: 12, sensitivity: 10, quadrant: "Automatisera",
        recommendation: "Regelstyrt och opersonligt. Låt systemet avsluta ärendet självt och mät bara undantagen." },
      { id: "intyg",    label: "Anställningsintyg", complexity: 18, sensitivity: 28, quadrant: "Automatisera",
        recommendation: "Standardiserat dokument med kända fält. Automatisera, men logga varje utfärdande." },
      { id: "lon",      label: "Lönefråga",         complexity: 45, sensitivity: 58, quadrant: "Automatisera med mänskligt stöd",
        recommendation: "AI svarar med underlag och en synlig väg vidare. Fel om lön kostar förtroende långt utöver beloppet." },
      { id: "sjuk",     label: "Sjukfrånvaro",      complexity: 38, sensitivity: 76, quadrant: "Låt AI stötta HR",
        recommendation: "Automatisera det administrativa, men låt aldrig AI tolka hälsa eller föreslå åtgärder." },
      { id: "arbetsratt", label: "Arbetsrättslig fråga", complexity: 88, sensitivity: 90, quadrant: "Prioritera mänsklig HR-expert",
        recommendation: "Beror på omständigheter som inte finns i något system. AI får sammanfatta underlaget, inget mer." },
      { id: "risk",     label: "Uppsägningsrisk",   complexity: 84, sensitivity: 92, quadrant: "Prioritera mänsklig HR-expert",
        recommendation: "AI indikerar mönster. En människa avgör, och står för beslutet med sitt namn." }
    ],

    sources: [
      { org: "Europeiska unionen", title: "AI-förordningen (AI Act)",
        desc: "Klassificerar AI-system som används i anställning och personalhantering som högrisk, med krav på mänsklig tillsyn och spårbarhet.",
        published: "2024", url: "https://eur-lex.europa.eu/legal-content/SV/TXT/?uri=OJ:L_202401689" },
      { org: "Integritetsskyddsmyndigheten", title: "Personuppgifter i arbetslivet",
        desc: "Vägledning om behandling av anställdas personuppgifter — relevant för allt som rör frånvaro, hälsa och sentiment.",
        published: "Löpande", url: "https://www.imy.se/" },
      { org: "Simployer", title: "Simployer One och Sia",
        desc: "Produktunderlag för self-service, chefsstöd och AI-assistans i HR-processer.",
        published: "2026", url: "https://www.simployer.se/" }
    ],

    scope: {
      title: "Omfattning och avgränsning",
      body: [
        "Sidan är en interaktiv modell, inte en mätning. Den visar hur ärenden fördelar sig över komplexitet och känslighet, och vilka slutsatser den fördelningen leder till.",
        "Friktionspoängen är en relativ skala inom sidan. Den är konstruerad för att göra skillnader mellan ärendetyper jämförbara — den motsvarar inte minuter, kostnad eller något externt mått."
      ]
    }
  };
}

/* --- Små hjälpare -------------------------------------------------------- */

function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }
function $(id) { return document.getElementById(id); }
function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

/* Rubriker får innehålla <em> för kursiv betoning. Det är den enda tillåtna
   markupen från data — allt annat sätts som text, så en datakälla aldrig kan
   injicera godtycklig HTML. */
function setRich(node, str) {
  clear(node);
  var parts = String(str == null ? "" : str).split(/(<\/?em>)/i);
  var inEm = false;
  parts.forEach(function (p) {
    if (/^<em>$/i.test(p)) { inEm = true; return; }
    if (/^<\/em>$/i.test(p)) { inEm = false; return; }
    if (!p) return;
    if (inEm) { var e = document.createElement("em"); e.textContent = p; node.appendChild(e); }
    else node.appendChild(document.createTextNode(p));
  });
}

/* --- Rendering ----------------------------------------------------------- */

function renderMeta(d) {
  var banner = $("demo-banner");
  if (d.meta && d.meta.isDemo) {
    banner.hidden = false;
    clear(banner);
    var b = el("b"); b.textContent = "Demodata. ";
    banner.appendChild(b);
    banner.appendChild(document.createTextNode(
      "Siffrorna på sidan är illustrativa exempel för demonstration — inte verifierad Simployer-data."
    ));
  } else {
    banner.hidden = true;
  }

  var meta = $("footer-meta");
  var bits = [];
  if (d.meta && d.meta.source) bits.push(d.meta.source);
  if (d.meta && d.meta.published) bits.push("Publicerad " + d.meta.published);
  meta.textContent = bits.join(" · ");
}

function renderHero(d) {
  var h = d.hero || {};
  $("hero-eyebrow").textContent = "Simployer One · Sia";
  setRich($("hero-title"), h.title);
  $("hero-ingress").textContent = h.ingress || "";
  $("hero-fact-body").textContent = h.fact || (d.scope && d.scope.body && d.scope.body[0]) || "";

  var ctas = $("hero-ctas"); clear(ctas);
  (h.ctas || []).forEach(function (c) {
    var a = el("a", "btn " + (c.variant === "ghost" ? "btn-ghost" : "btn-primary"));
    a.href = c.href || "#";
    a.textContent = c.label || "";
    ctas.appendChild(a);
  });

  var stats = $("hero-stats"); clear(stats);
  (h.stats || []).forEach(function (s) {
    var li = el("li", "stat");
    li.appendChild(set(el("span", "v"), s.value));
    li.appendChild(set(el("span", "k"), s.key));
    li.appendChild(set(el("span", "d"), s.detail));
    stats.appendChild(li);
  });
  function set(node, txt) { node.textContent = txt == null ? "" : txt; return node; }
}

/* Trender: riktig ARIA-flikuppsättning med pil-navigering (roving tabindex). */
function renderTrends(d) {
  var list = $("trend-tabs"), panels = $("trend-panels");
  clear(list); clear(panels);
  var tabs = [];

  (d.trends || []).forEach(function (t, i) {
    var id = "trend-" + i;

    var b = el("button", "tab");
    b.type = "button";
    b.id = id + "-tab";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", id);
    b.setAttribute("aria-selected", i === 0 ? "true" : "false");
    b.tabIndex = i === 0 ? 0 : -1;
    b.textContent = t.tab;
    list.appendChild(b);
    tabs.push(b);

    var p = el("div", "panel");
    p.id = id;
    p.setAttribute("role", "tabpanel");
    p.setAttribute("aria-labelledby", id + "-tab");
    p.tabIndex = 0;
    p.hidden = i !== 0;

    var main = el("div");
    var h = el("h3"); h.style.fontSize = "24px"; h.textContent = t.title;
    main.appendChild(h);
    var desc = el("p"); desc.style.color = "var(--ink-2)"; desc.textContent = t.desc;
    main.appendChild(desc);

    var three = el("div", "three");
    [["for", "För medarbetaren", t.forCustomer],
     ["risk", "Risken", t.risk],
     ["rec", "Rekommendation", t.recommendation]].forEach(function (row) {
      var m = el("div", "mini " + row[0]);
      var l = el("div", "l"); l.textContent = row[1]; m.appendChild(l);
      var pp = el("p"); pp.textContent = row[2]; m.appendChild(pp);
      three.appendChild(m);
    });
    main.appendChild(three);
    p.appendChild(main);

    var num = el("div", "panel-num");
    var big = el("span", "big"); big.textContent = t.percent + " %";
    num.appendChild(big);
    var cap = el("span", "cap");
    cap.textContent = "av HR-organisationerna anger detta som en prioritet";
    num.appendChild(cap);
    p.appendChild(num);

    panels.appendChild(p);
  });

  function select(i) {
    tabs.forEach(function (b, k) {
      var on = k === i;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      $("trend-" + k).hidden = !on;
    });
  }

  tabs.forEach(function (b, i) {
    b.addEventListener("click", function () { select(i); });
    b.addEventListener("keydown", function (e) {
      var next = null;
      if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      select(next);
      tabs[next].focus();
    });
  });
}

/* Medarbetarresan. Mätarna animeras genom att sättas på nästa frame. */
function renderJourneys(d) {
  var chips = $("journey-chips"), panel = $("journey-panel");
  clear(chips);
  var list = d.journeys || [];
  var btns = [];

  list.forEach(function (j, i) {
    var b = el("button", "chip");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", i === 0 ? "true" : "false");
    b.tabIndex = i === 0 ? 0 : -1;
    b.textContent = j.label;
    b.addEventListener("click", function () { pick(i); });
    b.addEventListener("keydown", function (e) { arrowNav(e, btns, i, pick); });
    chips.appendChild(b);
    btns.push(b);
  });

  function pick(i) {
    btns.forEach(function (b, k) {
      b.setAttribute("aria-selected", k === i ? "true" : "false");
      b.tabIndex = k === i ? 0 : -1;
    });
    draw(list[i]);
    btns[i].focus({ preventScroll: true });
  }

  function draw(j) {
    clear(panel);
    if (!j) return;

    var head = el("div", "journey-head");
    var h = el("h3"); h.textContent = j.label; head.appendChild(h);
    var tag = el("p"); tag.textContent = j.tagline || ""; head.appendChild(tag);
    panel.appendChild(head);

    var steps = el("div", "steps");
    (j.steps || []).forEach(function (s, i) {
      var box = el("div", "step");
      var n = el("div", "n"); n.textContent = String(i + 1); box.appendChild(n);
      var t = el("h4"); t.textContent = s.title; box.appendChild(t);
      var p = el("p"); p.textContent = s.desc || ""; box.appendChild(p);
      var m = el("div", "meter");
      var fill = el("i");
      m.appendChild(fill);
      box.appendChild(m);
      var lab = el("span", "meter-l"); lab.textContent = "Friktion " + s.friction + "/100";
      box.appendChild(lab);
      requestAnimationFrame(function () { fill.style.width = s.friction + "%"; });
      steps.appendChild(box);
    });
    panel.appendChild(steps);

    var inds = el("div", "indicators");
    [["Snabbhet", j.indicators.speed], ["Ansträngning", j.indicators.effort], ["Förtroende", j.indicators.trust]]
      .forEach(function (row) {
        var box = el("div", "ind");
        var k = el("div", "k"); k.textContent = row[0]; box.appendChild(k);
        var bar = el("div", "bar"); var fill = el("i"); bar.appendChild(fill); box.appendChild(bar);
        var v = el("div", "v"); v.textContent = row[1] + "/100"; box.appendChild(v);
        requestAnimationFrame(function () { fill.style.width = row[1] + "%"; });
        inds.appendChild(box);
      });
    panel.appendChild(inds);

    var rec = el("div", "rec-path");
    var b = el("b"); b.textContent = "Rekommenderad väg: "; rec.appendChild(b);
    rec.appendChild(document.createTextNode(j.recommendedPath || ""));
    panel.appendChild(rec);
  }

  draw(list[0]);
}

/* Kontextsimulator: växlar som sänker en friktionspoäng. */
function renderContext(d) {
  var wrap = $("ctx-toggles"), out = $("ctx-result");
  clear(wrap);
  var layers = d.contextLayers || [];
  var on = {};

  var BASE = 100; // friktion utan något kontextlager alls

  layers.forEach(function (c) {
    var b = el("button", "toggle");
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", c.label + " — sänker friktionen med " + c.frictionReduction + " poäng");

    var sw = el("span", "sw"); sw.setAttribute("aria-hidden", "true"); b.appendChild(sw);
    var txt = el("span");
    txt.appendChild(setT(el("span", "tl"), c.label));
    txt.appendChild(setT(el("span", "td"), c.desc));
    txt.appendChild(setT(el("span", "tv"), "−" + c.frictionReduction + " friktion"));
    b.appendChild(txt);

    b.addEventListener("click", function () {
      on[c.id] = !on[c.id];
      b.setAttribute("aria-pressed", on[c.id] ? "true" : "false");
      paint();
    });
    wrap.appendChild(b);
  });

  function setT(node, t) { node.textContent = t == null ? "" : t; return node; }

  function paint() {
    var saved = layers.reduce(function (n, c) { return n + (on[c.id] ? c.frictionReduction : 0); }, 0);
    var withCtx = Math.max(5, BASE - saved);
    clear(out);

    var cmp = el("div", "compare");
    cmp.appendChild(box("Utan kontext", BASE, false));
    cmp.appendChild(box("Med rätt kontext", withCtx, true));
    out.appendChild(cmp);

    var note = el("p", "ctx-note");
    note.textContent = saved === 0
      ? "Utan kontext behandlar assistenten varje fråga som om den kom från en främling. Slå på ett lager och se skillnaden."
      : "Friktionen sjunker " + saved + " poäng. Det motsvarar det en erfaren kollega redan vet om personen — och som annars måste frågas fram.";
    out.appendChild(note);

    function box(caption, n, good) {
      var b = el("div", "box" + (good ? " good" : ""));
      var v = el("div", "n"); v.textContent = String(n); b.appendChild(v);
      var c = el("div", "c"); c.textContent = caption; b.appendChild(c);
      return b;
    }
  }

  paint();
}

/* Beslutsmatris: punkten flyttas mjukt, sidopanelen förklarar. */
function renderMatrix(d) {
  var chips = $("matrix-chips"), dot = $("matrix-dot"), side = $("matrix-side");
  clear(chips);
  var cases = d.matrixCases || [];
  var btns = [];

  cases.forEach(function (m, i) {
    var b = el("button", "chip");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", i === 0 ? "true" : "false");
    b.tabIndex = i === 0 ? 0 : -1;
    b.textContent = m.label;
    b.addEventListener("click", function () { pick(i); });
    b.addEventListener("keydown", function (e) { arrowNav(e, btns, i, pick); });
    chips.appendChild(b);
    btns.push(b);
  });

  function pick(i) {
    btns.forEach(function (b, k) {
      b.setAttribute("aria-selected", k === i ? "true" : "false");
      b.tabIndex = k === i ? 0 : -1;
    });
    draw(cases[i]);
    btns[i].focus({ preventScroll: true });
  }

  function draw(m) {
    if (!m) return;
    dot.hidden = false;
    dot.style.left = m.complexity + "%";
    dot.style.bottom = m.sensitivity + "%";
    dot.setAttribute("title", m.label);

    clear(side);
    var q = el("div", "q"); q.textContent = m.quadrant || ""; side.appendChild(q);
    var h = el("h3"); h.textContent = m.label; side.appendChild(h);

    var scale = el("div", "scale");
    [["Komplexitet", m.complexity], ["Känslighet", m.sensitivity]].forEach(function (row) {
      var wrapper = el("div");
      var k = el("div", "k");
      var a = el("span"); a.textContent = row[0];
      var b2 = el("span"); b2.textContent = row[1] + "/100";
      k.appendChild(a); k.appendChild(b2);
      wrapper.appendChild(k);
      var bar = el("div", "bar"); var fill = el("i"); bar.appendChild(fill); wrapper.appendChild(bar);
      requestAnimationFrame(function () { fill.style.width = row[1] + "%"; });
      scale.appendChild(wrapper);
    });
    side.appendChild(scale);

    var p = el("p"); p.style.margin = "0"; p.style.color = "var(--ink-2)";
    p.textContent = m.recommendation || "";
    side.appendChild(p);
  }

  draw(cases[0]);
}

function renderSources(d) {
  var lead = $("sources-lead");
  lead.textContent = d.meta && d.meta.isDemo
    ? "Sidan kör på demodata. Siffrorna ovan är illustrativa exempel som visar hur modellen fungerar — de är inte hämtade ur källorna nedan och är inte verifierad Simployer-data."
    : "Underlaget nedan ligger till grund för modellen på sidan.";

  var grid = $("source-grid"); clear(grid);
  (d.sources || []).forEach(function (s) {
    var c = el("article", "source");
    var org = el("div", "org"); org.textContent = s.org || ""; c.appendChild(org);
    var h = el("h3"); h.textContent = s.title || ""; c.appendChild(h);
    var p = el("p"); p.textContent = s.desc || ""; c.appendChild(p);
    var meta = el("div", "meta");
    if (s.published) meta.appendChild(document.createTextNode(s.published + " · "));
    if (s.url) {
      var a = document.createElement("a");
      a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = "Till källan";
      a.setAttribute("aria-label", "Till källan: " + (s.title || s.org || ""));
      meta.appendChild(a);
    }
    c.appendChild(meta);
    grid.appendChild(c);
  });

  var scope = $("scope-box"); clear(scope);
  var sc = d.scope || {};
  var h3 = el("h3"); h3.textContent = sc.title || "Omfattning"; scope.appendChild(h3);
  (sc.body || []).forEach(function (t) {
    var p = el("p"); p.textContent = t; scope.appendChild(p);
  });
  if (d.meta && d.meta.isDemo) {
    var p = el("p");
    var b = el("b"); b.textContent = "Demoläge: ";
    p.appendChild(b);
    p.appendChild(document.createTextNode(
      "ingen extern datakälla kunde läsas, så sidan visar den inbyggda demodatamängden."
      + (d.meta.fallbackReason ? " (" + d.meta.fallbackReason + ")" : "")
    ));
    scope.appendChild(p);
  }
}

/* Delad pil-navigering för chip-raderna. */
function arrowNav(e, btns, i, pick) {
  var next = null;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % btns.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + btns.length) % btns.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = btns.length - 1;
  if (next === null) return;
  e.preventDefault();
  pick(next);
}

/* Markerar aktiv sektion i navigeringen medan man scrollar. */
function initScrollSpy() {
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav a"));
  var targets = links
    .map(function (a) { return document.querySelector(a.getAttribute("href")); })
    .filter(Boolean);
  if (!("IntersectionObserver" in window) || !targets.length) return;

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      links.forEach(function (a) {
        a.setAttribute("aria-current", a.getAttribute("href") === "#" + en.target.id ? "true" : "false");
      });
    });
  }, { rootMargin: "-40% 0px -55% 0px" });
  targets.forEach(function (t) { io.observe(t); });
}

/* --- Start --------------------------------------------------------------- */

(async function main() {
  var data;
  try {
    data = await loadData();
  } catch (e) {
    // loadData ska inte kunna kasta, men om den gör det får sidan ändå inte gå
    // sönder — det är hela poängen med fallbacken.
    console.warn("[data] oväntat fel i loadData, använder demodata", e);
    data = getDummyData();
    data.meta.isDemo = true;
  }

  renderMeta(data);
  renderHero(data);
  renderTrends(data);
  renderJourneys(data);
  renderContext(data);
  renderMatrix(data);
  renderSources(data);
  initScrollSpy();

  // Praktiskt vid felsökning och vid demo: inspektera datan som faktiskt användes.
  window.__SIMPLOYER_DATA__ = data;
})();
