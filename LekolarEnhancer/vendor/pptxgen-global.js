(function exposePptxGenToContentScriptGlobal() {
    const root = typeof globalThis !== 'undefined'
        ? globalThis
        : (typeof window !== 'undefined' ? window : self);

    try {
        if (!root.PptxGenJS && typeof PptxGenJS !== 'undefined') {
            root.PptxGenJS = PptxGenJS;
        }
        if (!root.JSZip && typeof JSZip !== 'undefined') {
            root.JSZip = JSZip;
        }
    } catch (error) {
        console.warn('LES: PptxGenJS loaded, but could not expose it globally.', error);
    }
})();
