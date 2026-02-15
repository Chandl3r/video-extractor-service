const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v42' }));

// Una sola sessione: { embedUrl, videoUrl, browser, page, cdp, ts }
let currentSession = null;
let proxyLock = false;  // una sola richiesta proxy alla volta

function closeSession() {
    if (currentSession) {
        console.log('[v42] Chiudo sessione');
        if (currentSession.cdp) currentSession.cdp.detach().catch(() => {});
        if (currentSession.browser) currentSession.browser.close().catch(() => {});
        currentSession = null;
        proxyLock = false;
    }
}

setInterval(() => {
    if (currentSession && Date.now() - currentSession.ts > 15 * 60 * 1000) closeSession();
}, 60000);

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','facebook.net'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','recaptcha'].some(x=>u.includes(x))) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

async function launchBrowser() {
    return puppeteer.launch({
        args: [...chromium.args,
               '--no-sandbox', '--disable-setuid-sandbox',
               '--disable-dev-shm-usage', '--disable-gpu',
               '--no-first-run', '--no-zygote', '--single-process',
               '--mute-audio', '--disable-blink-features=AutomationControlled',
               '--disable-web-security', '--allow-running-insecure-content'],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
}

// ============================================================
// EXTRACT
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    if (currentSession && currentSession.embedUrl === url) {
        currentSession.ts = Date.now();
        console.log('[v42] Cache hit:', currentSession.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: currentSession.videoUrl });
    }

    closeSession();
    console.log('[v42] ESTRAZIONE:', url);
    let browser = null, page = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v42] TIMEOUT');
        if (!resolved) {
            resolved = true;
            if (page) page.close().catch(() => {});
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 70000);

    try {
        browser = await launchBrowser();
        page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        let interceptorDone = false;
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (interceptorDone) { try { request.continue(); } catch(e) {} return; }
            const u = request.url();
            if (BLOCK_URLS.some(b => u.includes(b))) { try{request.abort();}catch(e){} return; }
            if (looksLikeVideo(u)) {
                console.log('[v42] Video:', u.substring(0, 80));
                interceptorDone = true;
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    setupSession(url, u, browser, page)
                        .then(session => {
                            currentSession = session;
                            console.log('[v42] ✅ Sessione pronta');
                            res.json({ success: true, video_url: u });
                        })
                        .catch(e => {
                            console.error('[v42] setup err:', e.message);
                            res.json({ success: true, video_url: u }); // rispondi comunque
                        });
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v42] goto:', e.message.substring(0, 60)));

        for (let w = 0; w < 30 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1] || null;
            }).catch(() => null);
            if (q && !resolved) {
                resolved = true; clearTimeout(globalTimeout);
                currentSession = await setupSession(url, q, browser, page).catch(() =>
                    ({ embedUrl: url, videoUrl: q, browser, page, cdp: null, ts: Date.now() }));
                res.json({ success: true, video_url: q });
                return;
            }
        }
        if (resolved) return;

        for (let i = 0; i < 15 && !resolved; i++) {
            await page.mouse.click(640+(Math.random()*40-20), 360+(Math.random()*40-20)).catch(() => {});
            await sleep(800);
            if ((i+1) % 3 === 0) {
                const v = await page.evaluate(() => {
                    try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                    const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                    return m?.[1] || null;
                }).catch(() => null);
                if (v && !resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    currentSession = await setupSession(url, v, browser, page).catch(() =>
                        ({ embedUrl: url, videoUrl: v, browser, page, cdp: null, ts: Date.now() }));
                    res.json({ success: true, video_url: v });
                    return;
                }
                console.log(`[v42] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v42] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (page) page.close().catch(() => {});
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

// Naviga about:blank e prepara CDP per streaming
async function setupSession(embedUrl, videoUrl, browser, page) {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    // CDP per intercettare le risposte delle fetch senza btoa
    const cdp = await page.target().createCDPSession();
    await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
    });
    console.log('[v42] CDP Fetch.enable attivo');
    return { embedUrl, videoUrl, browser, page, cdp, ts: Date.now() };
}

// ============================================================
// PROXY: fetch() da page → CDP intercetta risposta → IO.read streaming
// ZERO btoa: i byte vanno direttamente da Chrome a Node.js a client
// Nessun accumulo in V8 heap → nessun GC → nessun timeout ✅
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const rangeHeader = req.headers['range'];
    const ok = currentSession && currentSession.page && currentSession.cdp;
    console.log(`[proxy] Range:${rangeHeader||'no'} | Session:${ok?'sì':'NO'} | ${videoUrl.substring(0,50)}`);

    if (!ok) return res.status(503).send('Sessione scaduta, ricarica');

    // Serializza: una richiesta alla volta
    if (proxyLock) {
        // Aspetta che si liberi (max 30s)
        let waited = 0;
        while (proxyLock && waited < 30000) { await sleep(100); waited += 100; }
        if (proxyLock) return res.status(503).send('Proxy occupato');
    }

    const CHUNK = 128 * 1024; // 128KB: giusto equilibrio per IO.read
    let start = 0, end = CHUNK - 1;
    if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (m) {
            start = parseInt(m[1]);
            end = m[2] ? Math.min(parseInt(m[2]), start + CHUNK - 1) : start + CHUNK - 1;
        }
    }
    const rangeStr = `bytes=${start}-${end}`;
    console.log(`[proxy] fetch: ${rangeStr}`);

    proxyLock = true;
    try {
        const { page, cdp } = currentSession;

        // Prepara listener CDP: cattura la risposta della prossima fetch
        const responseReady = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cdp.removeListener('Fetch.requestPaused', handler);
                reject(new Error('Timeout CDP 25s'));
            }, 25000);

            const handler = async (event) => {
                // Ignora request stage (solo response)
                if (event.responseStatusCode === undefined) {
                    await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
                    return;
                }
                clearTimeout(timer);
                cdp.removeListener('Fetch.requestPaused', handler);

                const status = event.responseStatusCode;
                const hdrs = event.responseHeaders || [];
                const ct = hdrs.find(h => h.name.toLowerCase() === 'content-type')?.value || 'video/mp4';
                const cr = hdrs.find(h => h.name.toLowerCase() === 'content-range')?.value || '';
                const cl = hdrs.find(h => h.name.toLowerCase() === 'content-length')?.value || '';

                if (status >= 400) {
                    await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
                    reject(new Error(`CDN ${status}`));
                    return;
                }
                try {
                    const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
                    resolve({ stream, status, ct, cr, cl });
                } catch(e) {
                    reject(e);
                }
            };
            cdp.on('Fetch.requestPaused', handler);
        });

        // Lancia fetch dalla pagina (fire-and-forget, CDP la intercetta)
        page.evaluate(async (opts) => {
            fetch(opts.url, {
                headers: { 'Range': opts.range, 'Accept': '*/*', 'Referer': opts.referer }
            }).catch(() => {});
        }, { url: videoUrl, range: rangeStr, referer: embedSrc || 'https://mixdrop.vip/' }).catch(() => {});

        const { stream, status, ct, cr, cl } = await responseReady;
        console.log(`[proxy] ✅ CDP stream: ${status} | ${ct} | cl=${cl}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', ct);
        if (cl) res.setHeader('Content-Length', cl);
        if (cr) res.setHeader('Content-Range', cr);
        res.status(status === 206 ? 206 : 200);

        // IO.read: streama direttamente da Chrome a client, zero buffer in Node.js
        let total = 0;
        const READ_SIZE = 64 * 1024;
        while (true) {
            const chunk = await cdp.send('IO.read', { handle: stream, size: READ_SIZE });
            const buf = chunk.base64Encoded
                ? Buffer.from(chunk.data, 'base64')
                : Buffer.from(chunk.data, 'binary');
            if (buf.length > 0) { res.write(buf); total += buf.length; }
            if (chunk.eof) break;
        }
        res.end();
        await cdp.send('IO.close', { handle: stream }).catch(() => {});
        console.log(`[proxy] ✅ Completato: ${total}b`);
        if (currentSession) currentSession.ts = Date.now();

    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    } finally {
        proxyLock = false;
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v42 porta ${PORT}`));
