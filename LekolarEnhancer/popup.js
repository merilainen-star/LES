// popup.js — Settings logic for popup

const DEFAULTS = {
    infiniteScroll: true,
    copyButtons: true,
    modifierKey: 'shiftKey',
    countries: {
        fi: { enabled: true, url: 'https://www.lekolar.fi/haku/?query=' },
        se: { enabled: false, url: 'https://www.lekolar.se/sok/?query=' },
        no: { enabled: false, url: 'https://www.lekolar.no/sok/?query=' },
        dk: { enabled: false, url: 'https://www.lekolar.dk/soeg/?query=' }
    }
};

const COUNTRY_CODES = ['fi', 'se', 'no', 'dk'];

// DOM refs
const infiniteScrollEl = document.getElementById('infiniteScroll');
const copyButtonsEl = document.getElementById('copyButtons');
const modifierKeyEl = document.getElementById('modifierKey');
const saveIndicator = document.getElementById('saveIndicator');

// Country refs
const countryRadios = {};
const countryUrls = {};
COUNTRY_CODES.forEach(code => {
    countryRadios[code] = document.getElementById(`country-${code}`);
    countryUrls[code] = document.getElementById(`url-${code}`);
});

// Load saved settings
function loadSettings() {
    chrome.storage.sync.get(null, (data) => {
        const settings = { ...DEFAULTS, ...data };
        if (data.countries) {
            settings.countries = { ...DEFAULTS.countries };
            COUNTRY_CODES.forEach(code => {
                settings.countries[code] = { ...DEFAULTS.countries[code], ...(data.countries[code] || {}) };
            });
        }

        infiniteScrollEl.checked = settings.infiniteScroll;
        copyButtonsEl.checked = settings.copyButtons;
        modifierKeyEl.value = settings.modifierKey;

        // Find which country is enabled and select its radio
        let activeCode = 'fi'; // Default fallback
        COUNTRY_CODES.forEach(code => {
            if (settings.countries[code].enabled) {
                activeCode = code;
            }
            // Set URLs
            countryUrls[code].value = settings.countries[code].url;
        });
        if (countryRadios[activeCode]) {
            countryRadios[activeCode].checked = true;
        }
    });
}

// Save all settings
function saveSettings() {
    const countries = {};
    COUNTRY_CODES.forEach(code => {
        countries[code] = {
            enabled: countryRadios[code].checked,
            url: countryUrls[code].value.trim() || DEFAULTS.countries[code].url
        };
    });

    const settings = {
        infiniteScroll: infiniteScrollEl.checked,
        copyButtons: copyButtonsEl.checked,
        modifierKey: modifierKeyEl.value,
        countries
    };

    chrome.storage.sync.set(settings, () => {
        showSaveIndicator();
    });
}

function showSaveIndicator() {
    saveIndicator.classList.add('visible');
    clearTimeout(showSaveIndicator._timer);
    showSaveIndicator._timer = setTimeout(() => {
        saveIndicator.classList.remove('visible');
    }, 1500);
}

// Auto-save on change
infiniteScrollEl.addEventListener('change', saveSettings);
copyButtonsEl.addEventListener('change', saveSettings);
modifierKeyEl.addEventListener('change', saveSettings);

COUNTRY_CODES.forEach(code => {
    countryRadios[code].addEventListener('change', saveSettings);
    // Debounce URL input saves
    let urlTimer;
    countryUrls[code].addEventListener('input', () => {
        clearTimeout(urlTimer);
        urlTimer = setTimeout(saveSettings, 500);
    });
});

// Initialize
loadSettings();
