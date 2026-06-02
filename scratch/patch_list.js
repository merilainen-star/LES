const fs = require('fs');
const path = require('path');

const contentJsPath = path.join(__dirname, '../LekolarEnhancer/content.js');
let content = fs.readFileSync(contentJsPath, 'utf8');

const listStateLogic = `
function ensureListStateLoaded() {
    if (listStateLoaded) return Promise.resolve(listItems);
    if (listStateLoadPromise) return listStateLoadPromise;

    listStateLoadPromise = storageLocalGet(LIST_STORAGE_KEY)
        .then(data => {
            const stored = data && Array.isArray(data[LIST_STORAGE_KEY]) ? data[LIST_STORAGE_KEY] : [];
            listItems = stored.map(sanitizeCompareItem).filter(Boolean);
            listStateLoaded = true;
            return listItems;
        })
        .catch(error => {
            console.warn('LES: Could not load product list state', error);
            listItems = [];
            listStateLoaded = true;
            return listItems;
        })
        .finally(() => {
            listStateLoadPromise = null;
        });

    return listStateLoadPromise;
}

function persistListState() {
    return storageLocalSet({ [LIST_STORAGE_KEY]: listItems }).catch(error => {
        console.warn('LES: Could not save product list state', error);
    });
}

function queueListUiRefresh() {
    queueComparisonUiRefresh(); 
}

function findListIndex(itemOrId) {
    const id = typeof itemOrId === 'string' ? itemOrId : getCompareItemId(itemOrId);
    const url = typeof itemOrId === 'string' ? '' : normalizeCompareUrl(itemOrId && itemOrId.url);
    const articleNumber = typeof itemOrId === 'string' ? '' : normalizeWhitespace(itemOrId && itemOrId.articleNumber);

    return listItems.findIndex(item => {
        if (item.id === id) return true;
        if (url && item.url === url) return true;
        return Boolean(articleNumber && item.articleNumber && item.articleNumber === articleNumber);
    });
}

function isListItemSelected(itemOrId) {
    return findListIndex(itemOrId) >= 0;
}

async function toggleListItem(rawItem) {
    await ensureListStateLoaded();

    const item = sanitizeCompareItem(rawItem);
    if (!item) return;

    const existingIndex = findListIndex(item);
    if (existingIndex >= 0) {
        listItems.splice(existingIndex, 1);
        await persistListState();
        queueListUiRefresh();
        return;
    }

    listItems.push(item);
    await persistListState();
    queueListUiRefresh();
    showCompareToast('Item added to list.');
}
`;

content = content.replace(
    'function findComparisonIndex(itemOrId) {',
    listStateLogic + '\\nfunction findComparisonIndex(itemOrId) {'
);

const svgLogic = `
function createListSvg(size = 14) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');
    const poly = document.createElementNS(svgNS, 'polyline');
    poly.setAttribute('points', '14 2 14 8 20 8');
    
    const l1 = document.createElementNS(svgNS, 'line');
    l1.setAttribute('x1', '16');
    l1.setAttribute('y1', '13');
    l1.setAttribute('x2', '8');
    l1.setAttribute('y2', '13');
    const l2 = document.createElementNS(svgNS, 'line');
    l2.setAttribute('x1', '16');
    l2.setAttribute('y1', '17');
    l2.setAttribute('x2', '8');
    l2.setAttribute('y2', '17');
    const l3 = document.createElementNS(svgNS, 'polyline');
    l3.setAttribute('points', '10 9 9 9 8 9');

    const plus1 = document.createElementNS(svgNS, 'line');
    plus1.setAttribute('x1', '19');
    plus1.setAttribute('y1', '3');
    plus1.setAttribute('x2', '19');
    plus1.setAttribute('y2', '7');
    const plus2 = document.createElementNS(svgNS, 'line');
    plus2.setAttribute('x1', '17');
    plus2.setAttribute('y1', '5');
    plus2.setAttribute('x2', '21');
    plus2.setAttribute('y2', '5');

    svg.appendChild(path);
    svg.appendChild(poly);
    svg.appendChild(l1);
    svg.appendChild(l2);
    svg.appendChild(l3);
    svg.appendChild(plus1);
    svg.appendChild(plus2);
    return svg;
}
`;
content = content.replace('function createCartSvg', svgLogic + '\\nfunction createCartSvg');

const buttonLogic = `
function createListButton(meta, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className.replace('les-compare-card-btn', 'les-list-card-btn').replace('les-product-compare-btn', 'les-product-list-btn');
    button.dataset.listId = meta.id;
    button.__lesListMeta = meta;
    button.setAttribute('aria-pressed', 'false');

    const label = document.createElement('span');
    label.className = 'les-list-btn-label';
    button.appendChild(createListSvg(14));
    button.appendChild(label);

    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await toggleListItem(button.__lesListMeta);
    });

    updateListButtonState(button);
    return button;
}

function updateListButtonState(button) {
    if (!button) return;
    const selected = isListItemSelected(button.__lesListMeta || button.dataset.listId);
    const label = button.querySelector('.les-list-btn-label');
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    button.title = selected ? 'Remove from list' : 'Add to list';
    button.setAttribute('aria-label', selected ? 'Remove from list' : 'Add to list');
    if (label) label.textContent = selected ? 'Listed' : 'Add to list';
}

function syncListButtons() {
    document.querySelectorAll('.les-list-card-btn, .les-product-list-btn').forEach(updateListButtonState);
}
`;
content = content.replace('function syncCompareButtons() {', buttonLogic + '\\nfunction syncCompareButtons() {');

content = content.replace('syncCompareButtons();', 'syncCompareButtons();\\n        syncListButtons();');
content = content.replace(
    'insertCardAction(toolbar, button, 30);',
    'insertCardAction(toolbar, button, 30);\\n    const listButton = createListButton(meta, "les-card-action-btn les-list-card-btn");\\n    insertCardAction(toolbar, listButton, 35);'
);

content = content.replace(
    'const buttonsBar = ensureProductActionBar();',
    \`const listMeta = buildCompareMetaFromCurrentProduct();
    if (listMeta) {
        let listBtn = document.querySelector('.les-product-list-btn');
        if (!listBtn) {
            listBtn = createListButton(listMeta, 'les-product-list-btn');
        } else {
            listBtn.dataset.listId = listMeta.id;
            listBtn.__lesListMeta = listMeta;
            updateListButtonState(listBtn);
        }
        const buttonsBar = ensureProductActionBar();
        if (buttonsBar && listBtn.parentElement !== buttonsBar) {
            buttonsBar.insertBefore(listBtn, buttonsBar.firstChild);
        }
    }
    const buttonsBar = ensureProductActionBar();\`
);

fs.writeFileSync(contentJsPath, content);
console.log('content.js patched with list builder logic.');
