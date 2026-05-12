// aiPrompt.js — Builds the system prompt used for all providers. Pinned to
// PIM_TO_FACET_MAP so the schema can't drift. When a category vocabulary is
// supplied, each enum facet is restricted to its allowed values and the AI is
// told to map specific user terms to the closest broader category option.

const LES_AI_FACET_DESCRIPTIONS = {
    length: 'pituus senttimetreinä (numero)',
    width: 'leveys senttimetreinä (numero)',
    height: 'korkeus senttimetreinä (numero)',
    depth: 'syvyys senttimetreinä (numero)',
    diameter: 'halkaisija senttimetreinä (numero)',
    seatHeight: 'istuinkorkeus senttimetreinä (numero)',
    color: 'väri',
    material: 'kalustemateriaali',
    legMaterial: 'jalkamateriaali',
    shape: 'pöytälevyn muoto',
    ecolabel: 'ympäristömerkki',
    toxicFree: 'myrkytön (true/false)',
    grade: 'luokka-aste',
    series: 'tuotesarja',
    heightAdjustable: 'korkeussäädettävyys — valitse "Korkeussäädettävä" jos käyttäjä mainitsee korkeussäädön (esim. "manuaalisella korkeussäädöllä", "sähköpöytä", "säädettävä"). Lekolarilla on vain yksi arvo, ei erillistä manuaalista/sähköistä.',
    silent: 'äänenvaimentava / hiljainen tuote (akustinen)',
    ralColor: 'RAL-värikoodi (esim. "RAL 9006"). Käytä tätä jos asiakas antaa tarkan RAL-koodin, esim. "jalat RAL 9006". Vain koodi, ei väliä minkä pinnan sävystä on kyse.',
    ncsColor: 'NCS-värikoodi (esim. "S 1002-Y"). Käytä tätä jos asiakas antaa tarkan NCS-koodin.'
};

// Numeric facets are never restricted by vocabulary — any reasonable cm value
// is valid. Enum facets, however, are category-specific and get dropped from
// the prompt when the category doesn't define allowed values for them.
const LES_AI_NUMERIC_FACETS = new Set([
    'length', 'width', 'height', 'depth', 'diameter', 'seatHeight'
]);

function lesAiBuildFacetCatalog(map, vocabulary) {
    const hasVocab = vocabulary && Object.keys(vocabulary).length > 0;
    const lines = [];
    for (const [key, facet] of Object.entries(map)) {
        if (facet === null) continue;
        const desc = LES_AI_FACET_DESCRIPTIONS[key] || '';
        const allowed = vocabulary && vocabulary[key];
        if (Array.isArray(allowed) && allowed.length > 0) {
            lines.push(`- ${key} — ${desc}. Sallitut arvot: ${allowed.join(', ')}.`);
        } else if (hasVocab && !LES_AI_NUMERIC_FACETS.has(key)) {
            // Enum facet has no vocab entry for this category — omit entirely
            // so the AI doesn't emit it. E.g. legMaterial is not a separate
            // facet for tables; leg material rolls into `material`.
            continue;
        } else {
            lines.push(`- ${key}${desc ? ` — ${desc}` : ''}`);
        }
    }
    return lines.join('\n');
}

function lesAiBuildSystemPrompt(map, vocabulary) {
    const catalog = lesAiBuildFacetCatalog(map, vocabulary);
    const hasVocab = vocabulary && Object.keys(vocabulary).length > 0;
    return [
        'Olet Lekolarin hakuavustaja. Muunna käyttäjän vapaa suomenkielinen kuvaus hakutermiksi ja suodattimiksi.',
        '',
        'Palauta AINA vain JSON, ei muuta tekstiä. Skeema:',
        '{ "query": string, "filters": { [avain]: string } }',
        '',
        '"query" on lyhyt tuotetyyppi yhtenä sanana (esim. "tuoli", "pöytä", "sohva", "kaappi"). Jätä pois mitat, värit ja tarkennukset.',
        '',
        '"filters" saa sisältää VAIN seuraavat avaimet. Jätä pois avaimet joita käyttäjä ei mainitse. Älä keksi avaimia eikä uusia arvoja.',
        catalog,
        '',
        'Säännöt:',
        '- Mitat aina senttimetreinä pelkkänä numerona (ei yksikköä). "45 cm" -> "45". "0,5 m" -> "50". "L70" -> length "70". "S60" -> width "60".',
        '- Desimaalit pisteellä: "45,5" -> "45.5".',
        hasVocab
            ? '- Värit, materiaalit, muodot ja ympäristömerkit VAIN yllä listatuista sallituista arvoista. Jos käyttäjän sana ei ole listalla, kartoita se listan laajempaan arvoon. Yleisiä kartoituksia (mutta käytä VAIN jos kohde-arvo on listalla): "teräs"/"alumiini" → "Metalli". "lasikuitu"/"polypropeeni"/"ABS" → "Muovi". "mänty"/"tammi"/"pyökki" → "Puu" TAI vastaava puulaji (Pyökki/Tammi) jos listalla. "koivuvaneri" → "Vaneri" (EI "Koivu" — Koivu tarkoittaa massiivikoivua). "lastulevy", "MDF", "MDF-levy" → EI VASTINETTA listalla → pudota. "massiivipuu" → "Pyökki" tai "Koivu" jos listalla, muuten pudota. "laminaatti" → sekä "Laminaatti" ETTÄ "Korkeapainelaminaatti" jos molemmat listalla (yhdistä putkilla). Jos sopivaa arvoa ei löydy, jätä suodatin pois.'
            : '- Värit ja materiaalit isolla alkukirjaimella suomeksi.',
        '- MITTA-ALUEET: jos käyttäjä antaa mittavälin (esim. "60-80 cm", "50–70", "välillä 62 ja 90"), palauta numeroarvo muodossa "min-max" (esim. "60-80"). Älä valitse yksittäistä arvoa välistä.',
        '- YKSIKKÖJÄRKI: huonekalujen mitat senttimetreinä. Jos arvo ylittää ~250 cm (esim. pöydän korkeus "650-850 cm"), kyseessä on lähes varmasti mm-yksikkö jonka kirjoittaja on merkinnyt vahingossa cm:ksi. Muunna silloin mm→cm jakamalla 10:llä (esim. "650-850 cm" → "65-85").',
        '- "noin N" / "alle N" / "yli N" → yksittäinen arvo N (ei aluetta).',
        '- VAIHTOEHDOT enum-kentille: jos käyttäjä sallii useamman värin/materiaalin/muodon (esim. "valkoinen, harmaa tai koivu"), yhdistä ne putki-merkillä: "Valkoinen|Harmaa|Koivu". Jokainen arvo on normalisoitava vocab-listaan. Jos yksikään ei osu vocabiin, jätä kenttä pois.',
        '- PÖYTIEN MITAT (Lekolarin Swedish-konventio, TÄRKEÄ): pöytien facet-kentät ovat eri kuin intuitio sanoisi. Pöydillä "kannen leveys" (vaakasuuntainen) → length. "kannen syvyys" (etu-taka) → width. ÄLÄ KÄYTÄ width:iä leveydelle pöydissä, äläkä depth:iä syvyydelle. Esim. "kannen leveys 60-80" → length:"60-80". "syvyys 50-70" → width:"50-70". Ei koskaan depth:iä pöydissä. Muille tuotteille (tuoli, kaappi) leveys=width kuten normaalisti.',
        '- SALLITUT VAIHTOEHDOT: jos käyttäjä listaa useita hyväksyttäviä arvoja (esim. "lastulevyä, MDF-levyä, koivuvaneria, massiivipuuta tai laminaattia"), yhdistä KAIKKI vocabiin osuvat arvot putkilla. Esim. vocab=[Koivu, Korkeapainelaminaatti, Laminaatti, Vaneri, ...] → material:"Koivu|Korkeapainelaminaatti|Laminaatti|Vaneri". Älä valitse vain 1-2 arvoa kun useampi on sallittu.',
        '- Ohita kuvailevat lauseet joita ei voi suodattaa (esim. "koottavissa ilman rakoa", "reppukoukku", "laatikko", "kallistettava kansi"). Älä lisää niitä filtereihin äläkä queryyn — ne vähentävät hakutuloksia.',
        '- Jos syötettä ei voi tulkita, palauta { "query": "<syöte sellaisenaan>", "filters": {} }.',
        '',
        'Esimerkit:',
        'Käyttäjä: "musta muovituoli istuinkorkeus 45cm"',
        'JSON: {"query":"tuoli","filters":{"color":"Musta","material":"Muovi","seatHeight":"45"}}',
        '',
        'Käyttäjä: "pyöreä puupöytä halkaisija 120"',
        'JSON: {"query":"pöytä","filters":{"shape":"Pyöreä","material":"Puu","diameter":"120"}}',
        '',
        'Käyttäjä: "oppilaspöytä L70 S60, korkeapainelaminaattikansi, teräsjalusta"',
        'JSON: {"query":"pöytä","filters":{"length":"70","width":"60","material":"Korkeapainelaminaatti","legMaterial":"Metalli"}}',
        '',
        'Käyttäjä: "valkoinen sohva"',
        'JSON: {"query":"sohva","filters":{"color":"Valkoinen"}}',
        '',
        'Käyttäjä: "kirjahylly korkeus 180"',
        'JSON: {"query":"kirjahylly","filters":{"height":"180"}}',
        '',
        'Käyttäjä: "korkeussäädettävä oppilaspöytä, kannen leveys 60-80, syvyys 50-70, korkeus 62-90, runko metallia, kansi valkoinen, harmaa tai koivu"',
        'JSON: {"query":"pöytä","filters":{"length":"60-80","width":"50-70","height":"62-90","legMaterial":"Metalli","color":"Valkoinen|Harmaa|Koivu","heightAdjustable":"Korkeussäädettävä"}}'
    ].join('\n');
}

function lesAiNormalizeValue(value, allowedValues) {
    if (!Array.isArray(allowedValues) || allowedValues.length === 0) return value;
    const target = String(value).trim().toLowerCase();
    if (!target) return null;
    // Exact match first (case-insensitive).
    const exact = allowedValues.find(v => v.toLowerCase() === target);
    if (exact) return exact;
    // Prefix match — "Vihre" matches "Vihreä". Helps the AI when it produces
    // stems without the final diacritic.
    const prefix = allowedValues.find(v => v.toLowerCase().startsWith(target) || target.startsWith(v.toLowerCase()));
    return prefix || null;
}

// Parse a numeric range like "60-80" or "60–80" (en-dash) into an inclusive
// integer array. Returns null if not a plausible range (reject when min>max or
// either end is non-numeric). The range is used as-is; Lekolar silently ignores
// bucket values that don't exist, so we don't need to know real bucket lists.
function lesAiParseNumericRange(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*[-–]\s*(-?\d+(?:[.,]\d+)?)$/);
    if (!m) return null;
    const min = parseFloat(m[1].replace(',', '.'));
    const max = parseFloat(m[2].replace(',', '.'));
    if (!isFinite(min) || !isFinite(max) || min > max) return null;
    const loInt = Math.ceil(min);
    const hiInt = Math.floor(max);
    if (hiInt < loInt) return null;
    // Guardrail: cap at 150 ints. Real furniture dimensions in cm fit well
    // inside that. Ranges that would exceed it are almost always a unit bug
    // (mm mistyped as cm, e.g. "650-850" meant "65-85"). Bloated URLs hit
    // Lekolar's max request length and return 404 — better to drop.
    if (hiInt - loInt > 150) return null;
    const out = [];
    for (let i = loInt; i <= hiInt; i++) out.push(String(i));
    return out;
}

function lesAiValidateExtraction(raw, map, vocabulary) {
    if (!raw || typeof raw !== 'object') return { query: '', filters: {} };
    const out = { query: '', filters: {} };
    if (typeof raw.query === 'string') out.query = raw.query.trim();
    const hasVocab = vocabulary && Object.keys(vocabulary).length > 0;
    if (raw.filters && typeof raw.filters === 'object') {
        for (const [k, v] of Object.entries(raw.filters)) {
            if (!(k in map)) continue;      // drop unknown keys
            if (map[k] === null) continue;  // drop explicitly ignored
            if (v === null || v === undefined) continue;
            const str = String(v).trim();
            if (!str) continue;

            const allowed = vocabulary && vocabulary[k];
            const isNumeric = LES_AI_NUMERIC_FACETS.has(k);

            if (isNumeric) {
                // Numeric facet: support range syntax "min-max" → integer array.
                // If the string looks like a range (contains an internal dash
                // between digits) but parsing rejects it (malformed, too wide,
                // or likely unit bug), drop the filter entirely instead of
                // sending a garbage single value that matches nothing.
                const looksLikeRange = /\d\s*[-–]\s*\d/.test(str);
                const range = lesAiParseNumericRange(str);
                if (range && range.length > 0) {
                    out.filters[k] = range;
                } else if (looksLikeRange) {
                    continue; // malformed / overflow range → drop
                } else {
                    out.filters[k] = str; // single value, unchanged behavior
                }
                continue;
            }

            // Enum facet: support pipe-delimited multi-value "A|B|C".
            const parts = str.includes('|') ? str.split('|').map(s => s.trim()).filter(Boolean) : [str];

            if (Array.isArray(allowed) && allowed.length > 0) {
                const normalized = [];
                const seen = new Set();
                for (const p of parts) {
                    const n = lesAiNormalizeValue(p, allowed);
                    if (n && !seen.has(n)) { normalized.push(n); seen.add(n); }
                }
                if (normalized.length === 0) continue; // nothing matched vocab
                out.filters[k] = normalized.length === 1 ? normalized[0] : normalized;
            } else if (hasVocab) {
                // Enum facet not applicable to this category — drop it.
                continue;
            } else {
                out.filters[k] = parts.length === 1 ? parts[0] : parts;
            }
        }
    }
    return out;
}

const LES_AI_PROMPT_API = { lesAiBuildSystemPrompt, lesAiValidateExtraction, lesAiNormalizeValue, lesAiParseNumericRange };

const LES_AI_PROMPT_GLOBAL =
    typeof globalThis !== 'undefined'
        ? globalThis
        : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LES_AI_PROMPT_API;
} else if (LES_AI_PROMPT_GLOBAL) {
    Object.assign(LES_AI_PROMPT_GLOBAL, LES_AI_PROMPT_API);
}
