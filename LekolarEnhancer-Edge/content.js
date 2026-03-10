// content.js
let currentSettings = {
    infiniteScroll: true,
    copyButtons: true,
    modifierKey: 'shiftKey'
};

function getProductNumber() {
    const existingBtn = document.querySelector('.lekolar-copy-btn[data-type="number"]');
    if (existingBtn && existingBtn.dataset.value) {
        return existingBtn.dataset.value;
    }

    // Check for "Tuotenro:" text pattern
    // Since we are running early, we might need to rely on text content check more often
    // XPath is slow on full document mutation, let's try a simpler check first
    // or just stick to the specific elements usually found

    // Check common locations if possible, but keeping generic robust search
    const xpath = "//*[contains(text(), 'Tuotenro') or contains(text(), 'Art.nr') or contains(text(), 'Varenr')]";
    // evaluate might fail if document body not ready? content_scripts at document_start usually have document element
    if (!document.body) return null;

    try {
        const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < result.snapshotLength; i++) {
            const element = result.snapshotItem(i);
            const text = element.textContent.trim();
            let match = text.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([\d-]+)/i);
            if (match) return match[1];

            let next = element.nextSibling;
            while (next && (next.nodeType === 8 || (next.nodeType === 3 && !next.textContent.trim()))) {
                next = next.nextSibling;
            }
            if (next && next.textContent) {
                const nextText = next.textContent.trim();
                const numberMatch = nextText.match(/^:?\s*([\d-]+)/);
                if (numberMatch) return numberMatch[1];
            }
        }
    } catch (e) {
        console.error("LES Error: Failed to find product number", e);
    }
    return null;
}

function getProductName() {
    // Only target the main product h1 by looking inside product page wrappers
    const h1 = document.querySelector('.product-info h1, .product-page-wrapper h1, .product-page h1');
    return h1 ? h1.innerText.trim() : null;
}

function createCopyButton(textGetter, type) {
    const button = document.createElement('button');
    button.className = 'lekolar-copy-btn';
    button.dataset.type = type;

    let getValue = () => typeof textGetter === 'function' ? textGetter() : textGetter;
    const initialValue = getValue();
    if (initialValue) button.dataset.value = initialValue;

    button.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-copy">
            <rect x="5" y="5" width="13" height="13" rx="2" ry="2"></rect>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" fill="white"></rect>
        </svg>
        <span class="tooltip">Copy ${type}</span>
    `;

    // Shared helper to update tooltip based on modifier key state
    function updateTooltip(isModifier) {
        const tooltip = button.querySelector('.tooltip');
        if (isModifier) {
            tooltip.innerText = "Copy number + name (Link)";
        } else {
            tooltip.innerText = `Copy ${type}`;
        }
    }

    // Key listeners for when the mouse is stationary over the button
    function onKeyDown(e) {
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') {
            updateTooltip(e[currentSettings.modifierKey]);
        }
    }
    function onKeyUp(e) {
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') {
            updateTooltip(e[currentSettings.modifierKey]);
        }
    }

    button.addEventListener('mouseenter', (e) => {
        updateTooltip(e[currentSettings.modifierKey]);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
    });

    button.addEventListener('mouseleave', () => {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
    });

    button.addEventListener('mousemove', (e) => {
        updateTooltip(e[currentSettings.modifierKey]);
    });

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        let textToCopy = getValue();

        if (e[currentSettings.modifierKey]) {
            const name = getProductName();
            const number = getProductNumber();
            const url = window.location.href;

            if (name && number) {
                const plainText = `${number} ${name} - ${url}`;
                const htmlText = `<a href="${url}">${number} ${name}</a>`;

                const clipboardItem = new ClipboardItem({
                    "text/plain": new Blob([plainText], { type: "text/plain" }),
                    "text/html": new Blob([htmlText], { type: "text/html" })
                });

                navigator.clipboard.write([clipboardItem]).then(onCopySuccess).catch(err => console.error('Failed to copy rich text: ', err));
                return;
            }
        }

        if (textToCopy) {
            navigator.clipboard.writeText(textToCopy).then(onCopySuccess).catch(err => {
                console.error('Failed to copy text: ', err);
            });
        }

        function onCopySuccess() {
            const tooltip = button.querySelector('.tooltip');
            const originalText = tooltip.innerText;
            tooltip.innerText = 'Copied!';
            tooltip.classList.add('visible');
            setTimeout(() => {
                tooltip.innerText = originalText;
                tooltip.classList.remove('visible');
            }, 2000);
        }
    });

    return button;
}

function findAndInject() {
    if (!document.body) return; // Wait for body

    // 1. Inject Product Number Buttons
    // Find all potential product number containers
    const xpath = "//*[contains(text(), 'Tuotenro') or contains(text(), 'Art.nr') or contains(text(), 'Varenr')]";
    try {
        const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < result.snapshotLength; i++) {
            const element = result.snapshotItem(i);
            const text = element.textContent.trim();
            let number = null;
            let target = null;
            let method = 'append';

            let match = text.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([\d-]+)/i);
            if (match) {
                number = match[1];
                target = element;
            } else if (text.match(/Tuotenro|Art\.nr|Varenr/i)) {
                let next = element.nextSibling;
                while (next && (next.nodeType === 8 || (next.nodeType === 3 && !next.textContent.trim()))) {
                    next = next.nextSibling;
                }
                if (next && next.textContent) {
                    const nextText = next.textContent.trim();
                    const numberMatch = nextText.match(/^:?\s*([\d-]+)/);
                    if (numberMatch) {
                        number = numberMatch[1];
                        if (next.nodeType === 1) target = next;
                        else {
                            target = next.parentNode;
                            if (next.nextSibling) {
                                target = next.nextSibling;
                                method = 'insertBefore';
                            } else {
                                target = next.parentNode;
                            }
                        }
                    }
                }
            }

            if (number && target) {
                // Check if button already exists for this target
                let alreadyExists = false;
                if (method === 'append') {
                    if (target.querySelector(`.lekolar-copy-btn[data-value="${number}"]`)) alreadyExists = true;
                } else if (method === 'insertBefore') {
                    if (target.previousElementSibling &&
                        target.previousElementSibling.classList.contains('lekolar-copy-btn') &&
                        target.previousElementSibling.dataset.value === number) {
                        alreadyExists = true;
                    }
                }

                if (!alreadyExists) {
                    const btn = createCopyButton(number, 'number');
                    if (isListPage()) btn.classList.add('lekolar-hover-copy');
                    if (method === 'insertBefore') target.parentNode.insertBefore(btn, target);
                    else target.appendChild(btn);
                }
            }
        }
    } catch (e) {
        console.error("LES Error: Failed during findAndInject", e);
    }

    // 2. Inject Product Name Button
    if (!document.querySelector('.lekolar-copy-btn[data-type="name"]')) {
        // Strict targeting so it doesn't accidentally attach to search result counters or category titles
        const h1 = document.querySelector('.product-info h1, .product-page-wrapper h1, .product-page h1');
        if (h1) {
            const name = h1.innerText.trim();
            const btn = createCopyButton(name, 'name');
            h1.appendChild(btn);
        }
    }
}



// --- Search Consolidation Logic (Infinite Scroll) ---

function initSearchConsolidation() {
    // Run on search pages AND category pages
    // Category pages often contain '/verkkokauppa/' in path and usually don't have 'query=' but we want to be broad
    // Check if we are on a page that likely has a product list
    const isSearch = (window.location.pathname.includes('/haku/') || window.location.pathname.includes('/sok/') || window.location.pathname.includes('/sog/')) && window.location.search.includes('query=');
    const isCategory = window.location.pathname.includes('/verkkokauppa/') || window.location.pathname.includes('/sortiment/');

    if (!isSearch && !isCategory) {
        return;
    }

    // Heuristic to find the product grid container
    const findProductGrid = () => {
        const productLinks = document.querySelectorAll('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]');
        if (productLinks.length === 0) return null;

        const parentCounts = new Map();
        productLinks.forEach(link => {
            let current = link;
            for (let i = 0; i < 5; i++) {
                if (!current.parentElement) break;
                current = current.parentElement;
                const tag = current.tagName.toLowerCase();
                if (tag === 'div' || tag === 'ul' || tag === 'section') {
                    parentCounts.set(current, (parentCounts.get(current) || 0) + 1);
                }
            }
        });

        // Only run if we haven't already injected the sentinel
        if (document.getElementById('lekolar-infinite-scroll-sentinel')) return null;

        const mainContent = document.querySelector('main') || document.body;
        const allDivs = mainContent.querySelectorAll('div, ul, section');
        let bestContainer = null;
        let maxProductChildren = 0;

        allDivs.forEach(div => {
            let productChildrenCount = 0;
            Array.from(div.children).forEach(child => {
                if (child.querySelector('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]') && child.innerText.length > 10) {
                    productChildrenCount++;
                }
            });

            if (productChildrenCount > maxProductChildren) {
                maxProductChildren = productChildrenCount;
                bestContainer = div;
            }
        });

        if (maxProductChildren > 2) {
            return bestContainer;
        }

        return null;
    };

    // Heuristic: Check if pagination exists
    const hasPagination = () => {
        // Look for common pagination patterns or "Next" links
        // Lekolar specific might use 'pagination' class or similar
        // Also checks for links with 'page=' parameter

        const pagination = document.querySelector('.pagination, .pager, nav[aria-label="Pagination"]');
        if (pagination) return true;

        const pageLinks = document.querySelectorAll('a[href*="page="]');
        if (pageLinks.length > 0) return true;

        // Check for specific text like "Next" or ">"
        const allLinks = document.querySelectorAll('a');
        for (let link of allLinks) {
            if (link.innerText.includes('Seuraava') || link.innerText.includes('Nästa') || link.innerText.includes('Neste') || link.innerText.includes('Næste') || link.innerText.trim() === '>' || link.innerText.trim() === '›') {
                return true;
            }
        }
        return false;
    };

    if (!hasPagination() && !window.location.search.includes('page=')) {
        // If no pagination controls and we are on page 1 (no page param usually means page 1),
        // then we might not need infinite scroll. 
        // But some sites hide pagination if only 1 page. 
        // If there is only 1 page, we don't need infinite scroll anyway.
        return;
    }

    const container = findProductGrid();


    if (container) {
        // Create Sentinel for Infinite Scroll
        const sentinel = document.createElement('div');
        sentinel.id = 'lekolar-infinite-scroll-sentinel';
        sentinel.style.height = '50px';
        sentinel.style.width = '100%';
        sentinel.style.textAlign = 'center';
        sentinel.style.padding = '20px';
        sentinel.className = 'lekolar-loading-sentinel';
        sentinel.innerText = ''; // Initially empty

        // Insert sentinel after the grid container
        if (container.nextSibling) {
            container.parentNode.insertBefore(sentinel, container.nextSibling);
        } else {
            container.parentNode.appendChild(sentinel);
        }

        // Initialize state
        let currentPage = 1;
        const urlParams = new URL(window.location.href).searchParams;
        if (urlParams.get('page')) currentPage = parseInt(urlParams.get('page'));

        // Safety check
        if (currentPage < 1 || isNaN(currentPage)) currentPage = 1;

        let isLoading = false;
        let hasMore = true;

        const observer = new IntersectionObserver(async (entries) => {
            if (entries[0].isIntersecting && !isLoading && hasMore) {
                isLoading = true;
                sentinel.innerText = 'Initializing fetch...';

                try {
                    const nextPage = currentPage + 1;
                    const result = await loadNextPage(container, nextPage, sentinel); // Pass sentinel for updates

                    if (result.success) {
                        currentPage = nextPage;
                        isLoading = false;
                        sentinel.innerText = ''; // Clear loading text
                    } else {
                        hasMore = false;
                        isLoading = false;
                        sentinel.innerText = result.message || 'No more products.';
                    }
                } catch (e) {
                    console.error("Critical infinite scroll error:", e);
                    isLoading = false;
                    sentinel.innerText = 'Error: ' + e.message;
                }
            }
        }, { rootMargin: '400px' }); // Start loading earlier

        observer.observe(sentinel);
    }
}

async function loadNextPage(gridContainer, page, debugElement) {
    if (debugElement) debugElement.innerText = `Fetching page ${page}...`;

    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set('page', page);
    const nextUrl = currentUrl.toString();

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const response = await fetch(nextUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) return { success: false, message: 'Server error: ' + response.status };

        if (debugElement) debugElement.innerText = `Parsing page ${page}...`;
        const text = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        const fetchedMain = doc.querySelector('main') || doc.body;
        const fetchedDivs = fetchedMain.querySelectorAll('div, ul, section');
        let fetchedContainer = null;
        let maxChildren = 0;

        // Debug: count candidates
        let candidates = 0;

        fetchedDivs.forEach(div => {
            let count = 0;
            Array.from(div.children).forEach(child => {
                if (child.querySelector('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]')) count++;
            });
            if (count > 0) candidates++;

            if (count > maxChildren) {
                maxChildren = count;
                fetchedContainer = div;
            }
        });

        if (fetchedContainer && maxChildren > 0) {
            if (debugElement) debugElement.innerText = `Appending ${maxChildren} items...`;
            const newItems = Array.from(fetchedContainer.children);
            if (newItems.length === 0) return { success: false, message: 'No items found in grid.' };

            newItems.forEach(item => {
                const importedNode = document.importNode(item, true);
                gridContainer.appendChild(importedNode);
            });
            
            // Trigger injection on newly added items
            setTimeout(() => {
                if (currentSettings.copyButtons) {
                    findAndInject();
                    observeNewProductCards();
                }
            }, 150);

            return { success: true };
        } else {
            return { success: false, message: 'Could not find product grid on new page.' };
        }

    } catch (err) {
        console.error('Error loading page:', err);
        return { success: false, message: 'Error: ' + err.message };
    }
}

// --- Prefetching Logic for Configurable Products ---

const fetchedProducts = new Map(); // Cache URL -> Product Number
const fetchQueue = [];
let isFetching = false;

function fetchProductNumber(url) {
    return new Promise((resolve, reject) => {
        if (fetchedProducts.has(url)) {
            resolve(fetchedProducts.get(url));
            return;
        }

        // Limit cache size to prevent memory leak
        if (fetchedProducts.size >= 500) {
            const firstKey = fetchedProducts.keys().next().value;
            fetchedProducts.delete(firstKey);
        }

        fetchQueue.push({ url, resolve, reject });
        processFetchQueue();
    });
}

async function processFetchQueue() {
    if (isFetching || fetchQueue.length === 0) return;

    isFetching = true;
    const { url, resolve, reject } = fetchQueue.shift();

    try {
        const response = await fetch(url);
        const text = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        const productNumber = extractProductNumberFromDoc(doc);

        if (productNumber) {
            fetchedProducts.set(url, productNumber);
            resolve(productNumber);
        } else {
            resolve(null);
        }

    } catch (error) {
        console.error("Error fetching product page:", error);
        resolve(null);
    } finally {
        isFetching = false;
        setTimeout(processFetchQueue, 300);
    }
}

// Extract product number from a parsed HTML document
function extractProductNumberFromDoc(doc) {
    let productNumber = null;

    // 1. Check data attributes on main elements
    const buyInfo = doc.querySelector('.buy-info, .js-buyInfo');
    if (buyInfo && buyInfo.dataset.articlenumber) {
        productNumber = buyInfo.dataset.articlenumber;
    }

    // 2. Check "Tuotenro" text
    if (!productNumber) {
        const xpath = "//*[contains(text(), 'Tuotenro') or contains(text(), 'Art.nr') or contains(text(), 'Varenr')]";
        const result = doc.evaluate(xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (result.singleNodeValue) {
            const match = result.singleNodeValue.textContent.match(/(?:Tuotenro|Art\.nr|Varenr)[\.\s:]*\s*([\d-]+)/i);
            if (match) productNumber = match[1];
        }
    }

    // 3. Check meta tags or other data attributes
    if (!productNumber) {
        const productDiv = doc.querySelector('[data-productnumber]');
        if (productDiv) productNumber = productDiv.dataset.productnumber;
    }

    return productNumber;
}

// Direct fetch for hover — bypasses the slow queue for responsiveness
async function fetchProductNumberDirect(url) {
    if (fetchedProducts.has(url)) return fetchedProducts.get(url);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        const text = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');

        const productNumber = extractProductNumberFromDoc(doc);

        if (productNumber) {
            if (fetchedProducts.size >= 500) {
                const firstKey = fetchedProducts.keys().next().value;
                fetchedProducts.delete(firstKey);
            }
            fetchedProducts.set(url, productNumber);
        }
        return productNumber;
    } catch (error) {
        console.error("Error fetching product page directly:", error);
        return null;
    }
}


// --- Hover-to-Reveal + Idle Prefetch System ---

const hoverInitialized = new WeakSet();
const prefetchQueued = new Set();
const visibleProductCards = new Set();
let prefetchObserver = null;
let idlePrefetchScheduled = false;
let hoverSystemInitialized = false;

const PRODUCT_CARD_SELECTOR = '.product-item, .category-product, .product-list-item, article';

function isListPage() {
    // Product detail pages also have '/verkkokauppa/' in their URL,
    // so check for product page wrapper to exclude them
    if (document.querySelector('.product-page-wrapper, .jsProductPage')) return false;

    const path = window.location.pathname;
    const isSearch = path.includes('/haku/') || path.includes('/sok/') || path.includes('/sog/');
    const isCategory = path.includes('/verkkokauppa/') || path.includes('/sortiment/');
    return isSearch || isCategory;
}

function findProductCard(element) {
    let current = element;
    while (current && current !== document.body) {
        if (current.matches && current.matches(PRODUCT_CARD_SELECTOR)) {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

function getProductCardUrl(card) {
    const link = card.querySelector('a[href*="/verkkokauppa/"], a[href*="/sortiment/"]');
    return link ? link.href : null;
}

function injectCopyButtonOnCard(card, number) {
    if (card.querySelector('.lekolar-copy-btn[data-type="number"]')) return;

    const btn = createCopyButton(number, 'number');
    btn.classList.add('lekolar-hover-copy');

    let target = card.querySelector('.product-artno, .eS-product-artno, [class*="artno"]');

    if (target) {
        target.innerText = `Tuotenro: ${number} `;
        target.appendChild(btn);
    } else {
        target = card.querySelector('.product-title, .inner-title, h3, .product-name, [class*="title"], .eS-productname');
        if (!target) target = card.querySelector('a') || card;
        target.appendChild(btn);
    }
}

async function handleProductCardHover(card) {
    if (card.querySelector('.lekolar-copy-btn[data-type="number"]')) return;

    const url = getProductCardUrl(card);
    if (!url) return;

    // Check cache first — instant show
    if (fetchedProducts.has(url)) {
        const number = fetchedProducts.get(url);
        if (number) injectCopyButtonOnCard(card, number);
        return;
    }

    // Direct fetch (bypass slow queue) for responsiveness
    const number = await fetchProductNumberDirect(url);
    if (number) injectCopyButtonOnCard(card, number);
}

function initHoverCopySystem() {
    if (!isListPage()) return;

    if (!hoverSystemInitialized) {
        hoverSystemInitialized = true;

        // Event delegation using 'mouseover' (it bubbles, unlike mouseenter)
        document.body.addEventListener('mouseover', (e) => {
            if (!currentSettings.copyButtons) return;

            const card = findProductCard(e.target);
            if (!card || hoverInitialized.has(card)) return;

            hoverInitialized.add(card);
            handleProductCardHover(card);
        });
    }

    // Start / continue idle background prefetch
    initIdlePrefetch();
}

function initIdlePrefetch() {
    if (prefetchObserver) {
        // Already initialized — just observe any new cards
        observeNewProductCards();
        return;
    }

    prefetchObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                visibleProductCards.add(entry.target);
            } else {
                visibleProductCards.delete(entry.target);
            }
        });
        scheduleIdlePrefetch();
    }, { rootMargin: '300px' });

    observeNewProductCards();
}

function observeNewProductCards() {
    if (!prefetchObserver) return;

    const cards = document.querySelectorAll(PRODUCT_CARD_SELECTOR);
    cards.forEach(card => {
        const url = getProductCardUrl(card);
        if (url && !fetchedProducts.has(url) && !prefetchQueued.has(url)) {
            prefetchObserver.observe(card);
        }
    });
}

function scheduleIdlePrefetch() {
    if (idlePrefetchScheduled || visibleProductCards.size === 0) return;
    idlePrefetchScheduled = true;

    const callback = (deadline) => {
        idlePrefetchScheduled = false;

        for (const card of visibleProductCards) {
            const url = getProductCardUrl(card);
            if (!url || fetchedProducts.has(url) || prefetchQueued.has(url)) {
                visibleProductCards.delete(card);
                prefetchObserver.unobserve(card);
                continue;
            }

            if (deadline.timeRemaining() > 5 || deadline.didTimeout) {
                prefetchQueued.add(url);
                fetchProductNumber(url).then(number => {
                    // Data is now cached — button shows instantly on next hover
                    // If user already hovered this card, inject button now
                    if (number && hoverInitialized.has(card)) {
                        injectCopyButtonOnCard(card, number);
                    }
                });
                visibleProductCards.delete(card);
                prefetchObserver.unobserve(card);

                // Schedule next item
                scheduleIdlePrefetch();
                return;
            }
            break; // No idle time remaining
        }
    };

    if ('requestIdleCallback' in window) {
        requestIdleCallback(callback, { timeout: 10000 });
    } else {
        // Fallback for browsers without requestIdleCallback
        setTimeout(() => callback({ timeRemaining: () => 50, didTimeout: true }), 2000);
    }
}


// --- Compact Layout: Remove tabs and tighten spacing ---
function compactSearchPage() {
    const isSearch = window.location.pathname.includes('/haku/') || window.location.pathname.includes('/sok/') || window.location.pathname.includes('/sog/');
    const isCategory = window.location.pathname.includes('/verkkokauppa/') || window.location.pathname.includes('/sortiment/');
    if (!isSearch && !isCategory) return;

    // Remove the search navigation tabs (Tuotteet, Vinkkejä, Sisältö)
    const navs = document.querySelectorAll('nav.main-search-nav, nav.js-searchNavigation, .js-searchNavigation');
    navs.forEach(nav => {
        nav.style.display = 'none';
        nav.style.height = '0';
        nav.style.margin = '0';
        nav.style.padding = '0';
        nav.style.overflow = 'hidden';
    });

    // Also hide the parent container (.search-filter-panel) which has display:contents inline
    const panels = document.querySelectorAll('.search-filter-panel, [class*="search-filter-panel"]');
    panels.forEach(panel => {
        panel.style.setProperty('display', 'none', 'important');
        panel.style.setProperty('height', '0', 'important');
        panel.style.setProperty('margin', '0', 'important');
        panel.style.setProperty('padding', '0', 'important');
    });

    // Also try to find elements by data-content-type="products" parent container
    const searchResults = document.querySelectorAll('[data-content-type="products"]');
    searchResults.forEach(el => {
        // We no longer zero out the margin here for everything
    });

    // The search page has a massive inline 10em margin-top because we hid the tabs.
    // We strictly apply a margin-fix ONLY on search pages, so product pages are untouched.
    if (isSearch) {
        const searchResultEls = document.querySelectorAll('.search-result, .js-searchResults');
        searchResultEls.forEach(el => {
            el.style.setProperty('margin-top', '20px', 'important'); // 20px clearance below header
            el.style.setProperty('padding-top', '0', 'important');
        });
    }
}


// Settings
function loadSettingsAndInit() {
    chrome.storage.sync.get({
        infiniteScroll: true,
        copyButtons: true,
        modifierKey: 'shiftKey'
    }, (items) => {
        currentSettings = items;
        initAll();
    });
}

// Initialize
function initAll() {
    compactSearchPage();
    if (currentSettings.infiniteScroll) {
        initSearchConsolidation();
    }
    if (currentSettings.copyButtons) {
        findAndInject();
        initHoverCopySystem();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSettingsAndInit);
} else {
    loadSettingsAndInit();
}

// Watch for settings changes
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
        if (changes.infiniteScroll) currentSettings.infiniteScroll = changes.infiniteScroll.newValue;
        if (changes.copyButtons) currentSettings.copyButtons = changes.copyButtons.newValue;
        if (changes.modifierKey) currentSettings.modifierKey = changes.modifierKey.newValue;

        // React to changes
        if (currentSettings.infiniteScroll) initSearchConsolidation();
        if (currentSettings.copyButtons) {
            findAndInject();
            observeNewProductCards();
        }
    }
});

// Watch for DOM changes (Infinite Scroll, Navigation)
let lastUrl = window.location.href;
let mutationTimeout = null;

const pageObserver = new MutationObserver((mutations) => {
    // Check for URL change
    const url = window.location.href;
    if (url !== lastUrl) {
        lastUrl = url;
        clearTimeout(mutationTimeout);
        setTimeout(loadSettingsAndInit, 1500); // Re-load settings just in case
    } else {
        // Standard mutation (infinite scroll loading new items)
        // Debounce to improve performance
        clearTimeout(mutationTimeout);
        mutationTimeout = setTimeout(() => {
            if (currentSettings.infiniteScroll) initSearchConsolidation();
            if (currentSettings.copyButtons) {
                findAndInject();
                observeNewProductCards();
            }
        }, 250);
    }
});

pageObserver.observe(document.body, { childList: true, subtree: true });
