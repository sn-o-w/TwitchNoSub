// ==UserScript==
// @name         TwitchNoSub
// @namespace    https://github.com/besuper/TwitchNoSub
// @version      2.0.0
// @description  Watch sub only VODs on Twitch
// @author       besuper
// @updateURL    https://raw.githubusercontent.com/besuper/TwitchNoSub/master/userscript/twitchnosub.user.js
// @downloadURL  https://raw.githubusercontent.com/besuper/TwitchNoSub/master/userscript/twitchnosub.user.js
// @icon         https://raw.githubusercontent.com/besuper/TwitchNoSub/master/assets/icons/icon.png
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.__twitchNoSub) return;
    Object.defineProperty(window, '__twitchNoSub', {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
    });

    const WORKER_URL_CACHE = new Map();
    const PATCHED_BLOBS = new Set();
    const TNS_BOOTSTRAP_MARKER = '__TNS_BOOTSTRAP__';
    const PATCH_URL = 'https://cdn.jsdelivr.net/gh/besuper/TwitchNoSub@master/src/patch_amazonworker.js';
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
    importScripts(${JSON.stringify(PATCH_URL)});
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
                return `function Worker() { [native code] /* isVariantA besuper/ ${PATCH_URL} */ }`;
            }
        }

        TwitchNoSubWorker.toString = function () {
            return `function Worker() { [native code] /* isVariantA besuper/ ${PATCH_URL} */ }`;
        };

        window.Worker = TwitchNoSubWorker;
    }
	
    function removeFromNode(node) {
        if (!node || node.nodeType !== 1) return;

        if (node.classList?.contains('video-preview-card-restriction')) {
            node.remove();
            return;
        }

        const restrictions = node.getElementsByClassName?.(
            'video-preview-card-restriction'
        );

        if (!restrictions?.length) return;

        for (let index = restrictions.length - 1; index >= 0; index--) {
            restrictions[index].remove();
        }
    }

    function sweepExisting() {
        const restrictions = document.getElementsByClassName(
            'video-preview-card-restriction'
        );

        while (restrictions.length) {
            restrictions[0].remove();
        }
    }

    sweepExisting();

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        removeFromNode(node);
                    }
                }
            }

            if (
                mutation.type === 'attributes' &&
                mutation.target?.classList?.contains('video-preview-card-restriction')
            ) {
                mutation.target.remove();
            }
        }
    });

    const observerTarget = document.getElementById('root') || document.body;

    if (observerTarget) {
        observer.observe(observerTarget, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });
    }

    window.addEventListener(
        'beforeunload',
        () => observer.disconnect(),
        { once: true, passive: true }
    );
})();