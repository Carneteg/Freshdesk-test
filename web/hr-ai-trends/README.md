# HR i AI-eran — interaktiv sida

En scrollbaserad single-page-sida som visualiserar trender inom HR och people
management i AI-eran, i Simployers varumärke. Sidan är **datadriven med robust
fallback**: den försöker hämta riktig data, och om det inte går renderar den en
komplett demodatamängd i stället — aldrig en trasig vy.

```
web/hr-ai-trends/
├── index.html                  scenografi: behållare + laddningsskelett, noll innehåll
├── styles.css                  all design; varumärkesvärden ligger i :root
├── app.js                      loadData(), getDummyData(), renderare, interaktion
├── data/simployer-cx.json      exempel på en RIKTIG datakälla
└── README.md                   den här filen
```

## Kör lokalt

Sidan behöver serveras över HTTP för att kunna hämta JSON-filen — `fetch()` mot
`file://` blockeras av webbläsarens CORS-regler.

```bash
cd web/hr-ai-trends
python3 -m http.server 8899
# → http://localhost:8899
```

Öppnar du `index.html` direkt från disk fungerar sidan ändå. Den faller då
tillbaka till demodata och visar demobannern — vilket också är ett bra sätt att
se fallbacken i verkligheten.

---

## (a) Peka om `DATA_URL` till en riktig källa

Överst i `app.js`:

```js
var DATA_URL = "./data/simployer-cx.json";   // ← byt här
var FETCH_TIMEOUT_MS = 5000;                 // timeout innan fallback
```

Sätt den till vad som helst som svarar med JSON i schemat nedan:

```js
var DATA_URL = "https://api.example.com/hr-trends";   // fjärr-API
var DATA_URL = "";                                     // tvinga alltid demoläge
```

**Vad som händer, i ordning.** `loadData()` faller tillbaka till
`getDummyData()` — och loggar alltid skälet med `console.warn` — om något av
detta inträffar:

| Läge | Resultat |
|---|---|
| `DATA_URL` är tom | demodata |
| Svaret dröjer > `FETCH_TIMEOUT_MS` | demodata (`AbortController`) |
| Nätverksfel / CORS-blockering | demodata |
| HTTP-status ≠ 2xx | demodata |
| Tom kropp | demodata |
| Ogiltig JSON | demodata |
| Validerar inte mot schemat | demodata + lista över vad som saknades |

Felen är **tysta för användaren** men aldrig för utvecklaren. Öppna konsolen för
att se exakt vilken regel som föll.

**Demoläget är alltid synligt i gränssnittet:** en banner under toppnavigeringen,
och en explicit rad i källsektionen om att siffrorna är illustrativa exempel och
inte verifierad Simployer-data. Sätt `meta.isDemo: false` i din egen källa så
försvinner båda.

### Schemat

```jsonc
{
  "meta":   { "isDemo": false, "source": "…", "published": "2026-08-05" },
  "hero":   { "title": "HR i <em>AI-eran</em>", "ingress": "…", "fact": "…",
              "ctas":  [{ "label": "…", "href": "#trender", "variant": "primary|ghost" }],
              "stats": [{ "value": "68 %", "key": "…", "detail": "…" }] },
  "trends": [{ "tab": "…", "title": "…", "desc": "…", "percent": 74,
               "forCustomer": "…", "risk": "…", "recommendation": "…" }],
  "journeys": [{ "id": "…", "label": "…", "tagline": "…",
                 "steps": [{ "title": "…", "desc": "…", "friction": 0-100 }],
                 "indicators": { "speed": 0-100, "effort": 0-100, "trust": 0-100 },
                 "complexity": 0-100, "sensitivity": 0-100, "recommendedPath": "…" }],
  "contextLayers": [{ "id": "…", "label": "…", "desc": "…", "frictionReduction": 14 }],
  "matrixCases":   [{ "id": "…", "label": "…", "complexity": 0-100,
                      "sensitivity": 0-100, "quadrant": "…", "recommendation": "…" }],
  "sources": [{ "org": "…", "title": "…", "desc": "…", "published": "…", "url": "…" }],
  "scope":   { "title": "…", "body": ["…", "…"] }
}
```

Några praktiska detaljer:

- **`complexity` och `sensitivity` är procent** och styr punktens läge i matrisen
  direkt (`left` respektive `bottom`). 0–100.
- **`friction` och `frictionReduction`** ligger på samma skala. Kontextsimulatorn
  räknar `100 − summan av påslagna lager`, med golv på 5.
- **`<em>` i rubriker** ger den kursiva varumärkesbetoningen. Det är den *enda*
  markup som accepteras från data — allt annat sätts som text, så en datakälla
  aldrig kan injicera HTML.
- Antalet flikar, ärenden, lager, matrisfall och källkort styrs helt av hur många
  poster arrayerna innehåller. Layouten anpassar sig.

---

## (b) Byt färger, logotyp och texter

### Färger

Allt ligger i `:root` överst i `styles.css`. Ingen regel längre ned innehåller en
hårdkodad varumärkesfärg, så det räcker att ändra här:

```css
:root {
  --brand:      #9773FF;   /* primär lila — knappar, kursiv betoning, matrispunkt */
  --brand-dark: #7A55E0;   /* hover/aktiv */
  --brand-soft: #E0DEF9;   /* ljuslila yta — banner, aktiv kvadrant */
  --brand-tint: #F2F0F7;   /* ljusaste ytan — sektionsbakgrund, kort */
  --brand-2:    #7AB8CE;   /* sekundär blå — indikatorstaplar, illustration */
  --ink:        #333333;   /* brödtext */
  --line:       #E6E4EF;   /* ramar */
}
```

### Logotyp

I `index.html`, inuti `<a class="brand">`, ligger en `<svg class="brand-mark">`
som är en **platshållare** — inte Simployers riktiga logotyp. Byt hela elementet:

```html
<a class="brand" href="#hero" aria-label="Simployer — till toppen">
  <img class="brand-mark" src="./simployer-logo.svg" alt="" width="26" height="26">
  <span class="brand-name">Simployer</span>
</a>
```

Är logotypen en ordbild som redan innehåller namnet, ta bort `<span class="brand-name">`
och flytta texten till `alt`. Byt även favikonen i `<head>` (en inbäddad data-URI).

### Typsnitt

```css
--sans:  "Inter", -apple-system, …;   /* brödtext */
--serif: "Georgia", …;                /* rubriker */
```

Inter laddas **inte** externt, så sidan fungerar offline och från `file://`. Finns
Inter installerat lokalt används det, annars systemets sans-serif. Vill du
garantera Inter: lägg `Inter.woff2` bredvid filerna och lägg till en `@font-face`
överst i `styles.css` — ändra ingenting annat.

### Texter

Ändra dem i din datakälla, inte i markup. `index.html` innehåller medvetet inga
rubriker, siffror eller brödtexter — bara sektionsrubrikerna som är strukturella.
Vill du ändra även dem finns de i `<h2 class="section-h">` respektive
`<p class="section-lead">`.

---

## Tillgänglighet

- "Hoppa till innehåll" först i tabbordningen.
- Trendflikarna är en riktig `tablist`/`tab`/`tabpanel` med **roving tabindex** och
  pilnavigering (←/→, Home, End). Ärendeväljarna likaså (←/→/↑/↓).
- Kontextlagren är `button` med `aria-pressed` och beskrivande `aria-label`, inte
  klickbara `div`:ar.
- `aria-live="polite"` på kontextresultatet och matrisens sidopanel, så en
  skärmläsare hör att siffrorna ändrats.
- Synlig fokusmarkering med 3 px kontrastram överallt.
- `prefers-reduced-motion` stänger av animationer och mjuk scroll.
- Aktiv sektion markeras i navigeringen med `aria-current` medan man scrollar.

## Verifierat

Renderat headless i Chromium, båda vägarna:

| | `meta.isDemo` | Banner | Flikar | Ärenden | Lager | Matrisfall | Skelett kvar | Konsolfel |
|---|---|---|---|---|---|---|---|---|
| Över HTTP | `false` | dold | 5 | 5 | 5 | 6 | 0 | inga |
| Över `file://` | `true` | synlig | 5 | 5 | 5 | 6 | 0 | inga |

Interaktion kontrollerad: flikbyte visar exakt en panel, ärendebyte ritar om
stegen, två påslagna kontextlager ger 100 → 64, matrispunkten flyttar till
84 % / 92 % för "Uppsägningsrisk", och pilnavigering flyttar fliken.
