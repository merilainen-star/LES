var JSZip = typeof JSZip !== 'undefined' ? JSZip : undefined;
var PptxGenJS = typeof PptxGenJS !== 'undefined' ? PptxGenJS : undefined;
var regeneratorRuntime = typeof regeneratorRuntime !== 'undefined' ? regeneratorRuntime : undefined;

(function preparePptxGenBundleGlobals() {
    const globalRoot = typeof globalThis !== 'undefined' ? globalThis : null;
    const roots = [];
    if (typeof window !== 'undefined' && !roots.includes(window)) roots.push(window);
    if (typeof self !== 'undefined' && !roots.includes(self)) roots.push(self);

    roots.forEach(root => {
        try {
            if (root.JSZip && !JSZip) JSZip = root.JSZip;
            if (!root || root === globalRoot) return;
            const descriptor = Object.getOwnPropertyDescriptor(root, 'JSZip');
            if (!descriptor || descriptor.configurable) {
                Object.defineProperty(root, 'JSZip', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return JSZip;
                    },
                    set(value) {
                        JSZip = value;
                    }
                });
            }
        } catch (error) {
            console.warn('LES: Could not prepare JSZip global for PptxGenJS.', error);
        }
    });
})();
