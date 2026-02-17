const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { execSync } = require('child_process');

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

try { execSync('pkill -f "chromium|chrome" 2>/dev/null || true', { timeout: 3000 }); } catch(e) {}
process.on('unhandledRejection', (r) => console.error('[v108] unhandledRejection:', r?.message || r));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v108' }));

let session = null;
let proxyChain = Promise.resolve();

function closeSession() {
    if (session) {
        console.log('[v108] Chiudo sessione');
        if (session.browser) session.browser.close().catch(() => {});
        session = null;
        proxyChain = Promise.resolve();
    }
}

setInterval(() => {
    if (session && Date.now() - session.ts > 15 * 60 * 1000) closeSession();
}, 60000);

function withProxyLock(fn) {
    const result = proxyChain.then(() => fn());
    proxyChain = result.catch(() => {});
    return result;
}

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','facebook.net',
                    'adexchangeclear','inadsexchange','protrafficinspector',
                    'dogcollarfavourbluff','preferencenail','realizationnewest',
                    'inklinkor','weirdopt','displayvertising','oyo4d.com',
                    'rtmark.net','mdstats.info','lastingillipe','fjhvwqjimr',
                    'jnbhi.com','dcbogyqtfxolp','creative-sb1','show-creative1'];

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

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    if (session && session.embedUrl === url) {
        session.ts = Date.now();
        console.log('[v108] Cache hit:', session.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: session.videoUrl });
    }

    closeSession();
    console.log('[v108] ESTRAZIONE:', url);
    let browser = null, page = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v108] TIMEOUT');
        if (!resolved) {
            resolved = true;
            if (page) page.close().catch(() => {});
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 120000);

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
            if (BLOCK_URLS.some(b => u.includes(b))) { try { request.abort(); } catch(e) {} return; }
            if (looksLikeVideo(u)) {
                console.log('[v108] Video:', u.substring(0, 80));
                interceptorDone = true;
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 })
                        .then(async () => {
                            try {
                                const cdp = await page.target().createCDPSession();
                                await cdp.send('Network.enable', {
                                    maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024
                                });
                                console.log('[v108] ✅ CDP pronto');
                                session = { embedUrl: url, videoUrl: u, browser, page, cdp, ts: Date.now() };
                                res.json({ success: true, video_url: u });
                                console.log('[v108] → Risposta inviata, session salvata');
                            } catch(e) {
                                console.error('[v108] CDP err:', e.message);
                                if (browser) browser.close().catch(() => {});
                                res.json({ success: false, message: 'CDP err' });
                            }
                        })
                        .catch(() => {
                            setTimeout(async () => {
                                try {
                                    const cdp = await page.target().createCDPSession();
                                    await cdp.send('Network.enable', {
                                        maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024
                                    });
                                    session = { embedUrl: url, videoUrl: u, browser, page, cdp, ts: Date.now() };
                                    res.json({ success: true, video_url: u });
                                    console.log('[v108] → Risposta inviata (fallback)');
                                } catch(e) {
                                    if (browser) browser.close().catch(() => {});
                                    res.json({ success: false, message: 'CDP err fallback' });
                                }
                            }, 1000);
                        });
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
            .catch(e => console.log('[v108] goto:', e.message.substring(0, 60)));

        for (let w = 0; w < 10 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1] || null;
            }).catch(() => null);
            if (q && !resolved) {
                resolved = true; clearTimeout(globalTimeout);
                try {
                    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
                    const cdp = await page.target().createCDPSession();
                    await cdp.send('Network.enable', { maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024 });
                    session = { embedUrl: url, videoUrl: q, browser, page, cdp, ts: Date.now() };
                    res.json({ success: true, video_url: q });
                    console.log('[v108] → Risposta inviata (poll loop)');
                } catch(e) {
                    if (browser) browser.close().catch(() => {});
                    res.json({ success: false, message: 'CDP err: ' + e.message });
                }
                return;
            }
        }
        if (resolved) return;

        for (let i = 0; i < 25 && !resolved; i++) {
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
                    try {
                        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
                        const cdp = await page.target().createCDPSession();
                        await cdp.send('Network.enable', { maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024 });
                        session = { embedUrl: url, videoUrl: v, browser, page, cdp, ts: Date.now() };
                        res.json({ success: true, video_url: v });
                        console.log('[v108] → Risposta inviata (click loop)');
                    } catch(e) {
                        if (browser) browser.close().catch(() => {});
                        res.json({ success: false, message: 'CDP err: ' + e.message });
                    }
                    return;
                }
                console.log(`[v108] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v108] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (page) page.close().catch(() => {});
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const rangeHeader = req.headers['range'];
    const ok = session && session.cdp && session.page;
    console.log(`[proxy] Range:${rangeHeader||'no'} | CDP:${ok?'sì':'NO'} | ${videoUrl.substring(0,50)}`);
    if (!ok) return res.status(503).send('Sessione scaduta, ricarica');

    const CHUNK = 512 * 1024;
    let start = 0, end = CHUNK - 1;
    if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (m) { start = parseInt(m[1]); end = m[2] ? Math.min(parseInt(m[2]), start+CHUNK-1) : start+CHUNK-1; }
    }
    const rangeStr = `bytes=${start}-${end}`;

    try {
        await withProxyLock(async () => {
            if (!session?.cdp) throw new Error('Sessione persa');
            console.log(`[proxy] CDP fetch: ${rangeStr}`);
            const { page, cdp } = session;

            // Network domain: Chrome scarica body normalmente → TCP liberata dopo download
            // Diverso da Fetch domain: lì il body resta "pending" → TCP occupata forever
            const bodyReady = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    cdp.removeListener('Network.responseReceived', onResponse);
                    cdp.removeListener('Network.loadingFinished', onFinished);
                    cdp.removeListener('Network.loadingFailed', onFailed);
                    reject(new Error('Timeout Network 30s'));
                }, 30000);

                let networkReqId = null;

                const onResponse = (ev) => {
                    if (!ev.response.url.includes('mxcontent.net')) return;
                    networkReqId = ev.requestId;
                    const r = ev.response;
                    const status = r.status;
                    const ct = r.headers['content-type'] || r.headers['Content-Type'] || 'video/mp4';
                    const cr = r.headers['content-range'] || r.headers['Content-Range'] || '';
                    const cl = r.headers['content-length'] || r.headers['Content-Length'] || '';
                    if (status >= 400) {
                        clearTimeout(timer);
                        cdp.removeListener('Network.responseReceived', onResponse);
                        cdp.removeListener('Network.loadingFinished', onFinished);
                        cdp.removeListener('Network.loadingFailed', onFailed);
                        reject(new Error(`HTTP ${status}`));
                    } else {
                        resolve({ networkReqId: ev.requestId, status, ct, cr, cl });
                    }
                };

                const onFinished = async (ev) => {
                    if (ev.requestId !== networkReqId) return;
                    clearTimeout(timer);
                    cdp.removeListener('Network.loadingFinished', onFinished);
                    cdp.removeListener('Network.loadingFailed', onFailed);
                    // Non serve fare nulla - resolve già chiamata in onResponse
                };

                const onFailed = (ev) => {
                    if (ev.requestId !== networkReqId && networkReqId !== null) return;
                    clearTimeout(timer);
                    cdp.removeListener('Network.responseReceived', onResponse);
                    cdp.removeListener('Network.loadingFinished', onFinished);
                    cdp.removeListener('Network.loadingFailed', onFailed);
                    reject(new Error('Network loading failed'));
                };

                cdp.on('Network.responseReceived', onResponse);
                cdp.on('Network.loadingFinished', onFinished);
                cdp.on('Network.loadingFailed', onFailed);
            });

            // Avvia fetch nel renderer
            page.evaluate(async (opts) => {
                fetch(opts.url, {
                    headers: { 'Range': opts.range, 'Accept': '*/*', 'Referer': opts.referer }
                }).catch(() => {});
            }, { url: videoUrl, range: rangeStr, referer: embedSrc || 'https://mixdrop.vip/' }).catch(() => {});

            const { networkReqId, status, ct, cr, cl } = await bodyReady;

            // Aspetta che Chrome finisca di scaricare il body (loadingFinished)
            await new Promise((resolve) => {
                const check = (ev) => {
                    if (ev.requestId === networkReqId) {
                        cdp.removeListener('Network.loadingFinished', check);
                        resolve();
                    }
                };
                cdp.on('Network.loadingFinished', check);
                // Se già finito, timeout di sicurezza
                setTimeout(resolve, 15000);
            });

            // Ora la TCP connection è libera in Chrome!
            // Leggiamo il body bufferato
            const bodyResult = await cdp.send('Network.getResponseBody', { requestId: networkReqId });
            const bodyBuf = bodyResult.base64Encoded
                ? Buffer.from(bodyResult.body, 'base64')
                : Buffer.from(bodyResult.body, 'binary');

            console.log(`[proxy] ✅ ${status} | ${ct} | ${bodyBuf.length}b`);

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', ct);
            res.setHeader('Content-Length', bodyBuf.length);
            if (cr) res.setHeader('Content-Range', cr);
            res.status(status === 206 ? 206 : 200);
            res.end(bodyBuf);

            console.log(`[proxy] ✅ Completato: ${bodyBuf.length}b`);
            if (session) session.ts = Date.now();
        });
    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v108 porta ${PORT}`));
