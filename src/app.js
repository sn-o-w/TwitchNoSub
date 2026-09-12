(function () {
    'use strict';

    if (window.__twitchNoSub) return;
    Object.defineProperty(window, '__twitchNoSub', {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
    });

    const patch_url = localStorage.getItem("tns_internal_patch_url");

    if (typeof patch_url === 'undefined' || !patch_url) {
        console.error('[TNS] patch_url is not defined – worker patch cannot be applied');
        return;
    }

    const WORKER_URL_CACHE = new Map();
    const PATCHED_BLOBS = new Set();
    const TNS_BOOTSTRAP_MARKER = '__TNS_BOOTSTRAP__';
    const IVS_WORKER_RE = /amazon-ivs-wasmworker[\w.-]*\.js/i;
    const IMPORT_RE = /importScripts\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const VAFT_RE = /getWasmWorkerJs\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    function fetchSync(url) {
        try {
            const req = new XMLHttpRequest();
            req.open('GET', url, false);
            req.overrideMimeType('text/javascript');
            req.send();

            if (req.status === 0 || (req.status >= 200 && req.status < 300)) {
                return req.responseText || '';
            }
        } catch (e) {
            console.warn('[TNS] Failed to fetch worker source:', url, e);
        }

        return null;
    }

    function chainLeadsToIvsWorker(initialUrl, maxDepth = 6) {
        if (WORKER_URL_CACHE.has(initialUrl)) {
            return WORKER_URL_CACHE.get(initialUrl);
        }

        let url = String(initialUrl);
        let result = false;

        for (let depth = 0; depth < maxDepth; depth++) {
            if (IVS_WORKER_RE.test(url)) {
				result = true;
				break;
			}

            const src = fetchSync(url);
            if (!src) break;
			
            if (src.includes(TNS_BOOTSTRAP_MARKER)) {
                result = false;
                break;
            }
			
            if (IVS_WORKER_RE.test(src)) {
                result = true;
                break;
            }

            IMPORT_RE.lastIndex = 0;
            VAFT_RE.lastIndex = 0;

            let match;
            let nextBlobUrl = null;

            while ((match = IMPORT_RE.exec(src))) {
                const importedUrl = match[1];

                if (IVS_WORKER_RE.test(importedUrl)) {
                    result = true;
                    break;
                }
                if (!nextBlobUrl && importedUrl.startsWith('blob:')) {
                    nextBlobUrl = importedUrl;
                }
            }

            if (result) break;

            while ((match = VAFT_RE.exec(src))) {
                const importedUrl = match[1];
                if (IVS_WORKER_RE.test(importedUrl)) {
                    result = true;
                    break;
                }
                if (!nextBlobUrl && importedUrl.startsWith('blob:')) {
                    nextBlobUrl = importedUrl;
                }
            }

            if (result) break;
            if (!nextBlobUrl) break;
            url = nextBlobUrl;
        }

        WORKER_URL_CACHE.set(initialUrl, result);
        return result;
    }

    function buildPatchedBlobUrl(originalScriptUrl) {
        const workerSrc = fetchSync(originalScriptUrl);

        const originalCode = workerSrc
            ? workerSrc
            : `importScripts(${JSON.stringify(String(originalScriptUrl))});`;

        const bootstrap = `"use strict";
/* ${TNS_BOOTSTRAP_MARKER} */
try {
    importScripts(${JSON.stringify(patch_url)});
} catch (error) {
    console.error('[TNS] patch_amazonworker failed:', error);
}
${originalCode}
try { self.postMessage({ __tns: 'ready' }); } catch (_) {}
`;

        const patchedBlobUrl = URL.createObjectURL(
            new Blob([bootstrap], {
                type: 'text/javascript'
            })
        );
		
        PATCHED_BLOBS.add(patchedBlobUrl);

        return patchedBlobUrl;
    }

    const NativeWorker = window.Worker;

    if (typeof NativeWorker === 'function') {
        class TwitchNoSubWorker extends NativeWorker {
            constructor(scriptUrl, options) {
                if (scriptUrl != null && PATCHED_BLOBS.has(String(scriptUrl))) {
                    super(scriptUrl, options);
                    return;
                }

                if (scriptUrl == null || options?.type === 'module' || !chainLeadsToIvsWorker(scriptUrl)) {
                    super(scriptUrl, options);
                    return;
                }

                const patchedUrl = buildPatchedBlobUrl(scriptUrl);
                super(patchedUrl, options);

                setTimeout(() => {
                    try { URL.revokeObjectURL(patchedUrl); } catch (_) {}
                    PATCHED_BLOBS.delete(patchedUrl);
                }, 30000);
            }

            static toString() {
                return `function Worker() { [native code] /* isVariantA besuper/ ${patch_url} */ }`;
            }
        }

        TwitchNoSubWorker.toString = function () {
            return `function Worker() { [native code] /* isVariantA besuper/ ${patch_url} */ }`;
        };

        window.Worker = TwitchNoSubWorker;
    }
})();
