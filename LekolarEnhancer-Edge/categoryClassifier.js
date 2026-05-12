// categoryClassifier.js — Deterministic Finnish keyword classifier that maps
// the user's raw query to a facet-vocabulary category. Runs before the AI call
// so we know which "allowed values" list to inject into the prompt.

// Order matters — more specific categories come before generic ones, because
// the first rule whose keyword appears in the query wins. E.g. "vaatekaappi"
// hits `kaappi` (which pulls from the wardrobe category page) before the
// generic `säilytys`.
const LES_CATEGORY_RULES = [
    {
        category: 'kaappi',
        keywords: [
            'vaatekaappi', 'vaatekaapit', 'koulukaappi', 'koulukaapit',
            'pukukaappi', 'pukukaapit', 'lukollinen', 'lokerokaappi'
        ]
    },
    {
        category: 'taulu',
        keywords: [
            'peili', 'peilit', 'valkotaulu', 'valkotaulut',
            'ilmoitustaulu', 'ilmoitustaulut', 'magneettitaulu', 'liitutaulu'
        ]
    },
    {
        category: 'tilanjakaja',
        keywords: [
            'tilanjakaja', 'tilanjakajat', 'sermi', 'sermit',
            'äänenvaimennus', 'akustiikkalevy', 'akustiikka', 'pöytäsermi'
        ]
    },
    {
        category: 'toimisto',
        keywords: [
            'toimistokaluste', 'toimistokalusteet', 'toimisto', 'työasema',
            'konferenssi', 'neuvottelu'
        ]
    },
    {
        category: 'tuoli',
        keywords: [
            'tuoli', 'tuolit', 'tuolin', 'oppilastuoli', 'opettajantuoli',
            'työtuoli', 'jakkara', 'jakkaran', 'istuin', 'satulatuoli'
        ]
    },
    {
        category: 'pöytä',
        keywords: [
            'pöytä', 'pöydät', 'pöydän', 'oppilaspöytä', 'opettajanpöytä',
            'työpöytä', 'ruokapöytä', 'pulpetti', 'pulpetin', 'kirjoituspöytä'
        ]
    },
    {
        category: 'sohva',
        keywords: ['sohva', 'sohvan', 'sohvat', 'rahi', 'rahin', 'nojatuoli']
    },
    {
        category: 'säilytys',
        keywords: [
            'kaappi', 'kaapit', 'kaapin', 'hylly', 'hyllyt', 'hyllyn',
            'kirjahylly', 'lokerikko', 'säilytys', 'säilytyskaluste',
            'laatikosto', 'naulakko'
        ]
    }
];

function lesClassifyCategory(text) {
    if (!text) return '_default';
    const q = String(text).toLowerCase();
    for (const rule of LES_CATEGORY_RULES) {
        if (rule.keywords.some(k => q.includes(k))) return rule.category;
    }
    return '_default';
}

const LES_CLASSIFIER_API = { lesClassifyCategory };

const LES_CLASSIFIER_GLOBAL =
    typeof globalThis !== 'undefined'
        ? globalThis
        : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null));

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LES_CLASSIFIER_API;
} else if (LES_CLASSIFIER_GLOBAL) {
    Object.assign(LES_CLASSIFIER_GLOBAL, LES_CLASSIFIER_API);
}
