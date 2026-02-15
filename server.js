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

// Uccidi Chrome orfano all'avvio (rimasto da crash precedente)
// Senza questo: Chrome A (200MB crash) + Chrome B (200MB nuovo) = 400MB → OOM
function killOrphanChrome() {
    try {
        execSync('pkill -f "chromium|chrome" 2>/dev/null || true', { timeout: 3000 });
        console.log('[v63] Chrome orfano killato');
    } catch(e) { /* nessun processo da killare */ }
}
killOrphanChrome();

process.on('unhandledRejection', (reason) => {
    console.error('[v63] unhandledRejection:', reason?.message || reason);
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v63' }));

let session = null;
let proxyChain = Promise.resolve();

function closeSession() {
    if (session) {
        console.log('[v63] Chiudo sessione');
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
        console.log('[v63] Cache hit:', session.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: session.videoUrl });
    }

    closeSession();
    console.log('[v63] ESTRAZIONE:', url);
    let browser = null, page = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v63] TIMEOUT');
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
                console.log('[v63] Video:', u.substring(0, 80));
                interceptorDone = true;
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 })
                        .then(async () => {
                            try {
                                // Sessione TEMPORANEA per pulizia memoria
                                // Separata da quella Fetch per evitare interferenze
                                const cleanCdp = await page.target().createCDPSession();
                                await cleanCdp.send('Network.clearBrowserCache').catch(() => {});
                                await cleanCdp.send('Network.clearBrowserCookies').catch(() => {});
                                await cleanCdp.send('HeapProfiler.enable').catch(() => {});
                                await cleanCdp.send('HeapProfiler.collectGarbage').catch(() => {});
                                await cleanCdp.send('HeapProfiler.disable').catch(() => {});
                                await cleanCdp.detach().catch(() => {}); // chiude sessione pulizia
                                // Sessione PRINCIPALE per Fetch intercept (fresh, zero stato)
                                const cdp = await page.target().createCDPSession();
                                await cdp.send('Fetch.enable', {
                                    patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
                                });
                                console.log('[v63] ✅ CDP pronto');
                                session = { embedUrl: url, videoUrl: u, browser, page, cdp, ts: Date.now() };
                                res.json({ success: true, video_url: u });
                            } catch(e) {
                                console.error('[v63] CDP err:', e.message);
                                if (browser) browser.close().catch(() => {});
                                res.json({ success: false, message: 'CDP err' });
                            }
                        })
                        .catch(() => {
                            setTimeout(async () => {
                                try {
                                    const cdp = await page.target().createCDPSession();
                                    await cdp.send('Fetch.enable', {
                                        patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
                                    });
                                    session = { embedUrl: url, videoUrl: u, browser, page, cdp, ts: Date.now() };
                                    res.json({ success: true, video_url: u });
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
            .catch(e => console.log('[v63] goto:', e.message.substring(0, 60)));

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
                    const cleanCdp2 = await page.target().createCDPSession();
                    await cleanCdp2.send('Network.clearBrowserCache').catch(()=>{});
                    await cleanCdp2.send('Network.clearBrowserCookies').catch(()=>{});
                    await cleanCdp2.send('HeapProfiler.enable').catch(()=>{});
                    await cleanCdp2.send('HeapProfiler.collectGarbage').catch(()=>{});
                    await cleanCdp2.send('HeapProfiler.disable').catch(()=>{});
                    await cleanCdp2.detach().catch(()=>{});
                    const cdp = await page.target().createCDPSession();
                    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }] });
                    session = { embedUrl: url, videoUrl: q, browser, page, cdp, ts: Date.now() };
                    res.json({ success: true, video_url: q });
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
                        const cleanCdp3 = await page.target().createCDPSession();
                    await cleanCdp3.send('Network.clearBrowserCache').catch(()=>{});
                    await cleanCdp3.send('Network.clearBrowserCookies').catch(()=>{});
                    await cleanCdp3.send('HeapProfiler.enable').catch(()=>{});
                    await cleanCdp3.send('HeapProfiler.collectGarbage').catch(()=>{});
                    await cleanCdp3.send('HeapProfiler.disable').catch(()=>{});
                    await cleanCdp3.detach().catch(()=>{});
                    const cdp = await page.target().createCDPSession();
                    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }] });
                        session = { embedUrl: url, videoUrl: v, browser, page, cdp, ts: Date.now() };
                        res.json({ success: true, video_url: v });
                    } catch(e) {
                        if (browser) browser.close().catch(() => {});
                        res.json({ success: false, message: 'CDP err: ' + e.message });
                    }
                    return;
                }
                console.log(`[v63] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v63] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (page) page.close().catch(() => {});
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

// PROXY: identico a v52 che funzionava (256KB, fire-and-forget semplice)
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const rangeHeader = req.headers['range'];
    const ok = session && session.cdp;
    console.log(`[proxy] Range:${rangeHeader||'no'} | CDP:${ok?'sì':'NO'} | ${videoUrl.substring(0,50)}`);
    if (!ok) return res.status(503).send('Sessione scaduta, ricarica');

    const CHUNK = 256 * 1024; // 256KB come v59 che funzionava
    let start = 0, end = CHUNK - 1;
    if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (m) {
            start = parseInt(m[1]);
            end = m[2] ? Math.min(parseInt(m[2]), start + CHUNK - 1) : start + CHUNK - 1;
        }
    }
    const rangeStr = `bytes=${start}-${end}`;

    try {
        await withProxyLock(async () => {
            if (!session || !session.cdp) throw new Error('Sessione persa');
            console.log(`[proxy] CDP fetch: ${rangeStr}`);
            const { page, cdp } = session;

            const streamReady = new Promise((resolve, reject) => {
                const timer = setTimeout(async () => {
                    cdp.removeListener('Fetch.requestPaused', handler);
                    // Ricrea CDP per pulire stato dopo timeout
                    try {
                        await cdp.detach().catch(() => {});
                        const newCdp = await session.page.target().createCDPSession();
                        await newCdp.send('Fetch.enable', {
                            patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
                        });
                        session.cdp = newCdp;
                        console.log('[proxy] CDP ricreato');
                    } catch(e) {}
                    reject(new Error('Timeout CDP 25s'));
                }, 25000);

                const handler = async (ev) => {
                    if (ev.responseStatusCode === undefined) {
                        await cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
                        return;
                    }
                    clearTimeout(timer);
                    cdp.removeListener('Fetch.requestPaused', handler);
                    const status = ev.responseStatusCode;
                    const hdrs = ev.responseHeaders || [];
                    const ct = hdrs.find(h => h.name.toLowerCase() === 'content-type')?.value || 'video/mp4';
                    const cr = hdrs.find(h => h.name.toLowerCase() === 'content-range')?.value || '';
                    const cl = hdrs.find(h => h.name.toLowerCase() === 'content-length')?.value || '';
                    if (status >= 400) {
                        await cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
                        reject(new Error(`HTTP ${status}`));
                        return;
                    }
                    try {
                        const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId: ev.requestId });
                        resolve({ stream, status, ct, cr, cl });
                    } catch(e) { reject(e); }
                };
                cdp.on('Fetch.requestPaused', handler);
            });

            // Fire-and-forget: identico a v52, senza AbortController che creava problemi
            page.evaluate(async (opts) => {
                fetch(opts.url, {
                    headers: { 'Range': opts.range, 'Accept': '*/*', 'Referer': opts.referer }
                }).catch(() => {});
            }, { url: videoUrl, range: rangeStr, referer: embedSrc || 'https://mixdrop.vip/' }).catch(() => {});

            const { stream, status, ct, cr, cl } = await streamReady;
            console.log(`[proxy] ✅ ${status} | ${ct} | ${cl}b`);

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', ct);
            if (cl) res.setHeader('Content-Length', cl);
            if (cr) res.setHeader('Content-Range', cr);
            res.status(status === 206 ? 206 : 200);

            // Usa session.cdp (non cdp locale) perché potrebbe essere stato ricreato
            const activeCdp = session.cdp;
            let total = 0;
            while (true) {
                const chunk = await activeCdp.send('IO.read', { handle: stream, size: 65536 });
                const buf = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'binary');
                if (buf.length > 0) {
                    const canContinue = res.write(buf);
                    total += buf.length;
                    // Backpressure: se buffer TCP pieno, aspetta drain prima di leggere altro
                    if (!canContinue) await new Promise(r => res.once('drain', r));
                }
                if (chunk.eof) break;
            }
            res.end();
            await activeCdp.send('IO.close', { handle: stream }).catch(() => {});
            console.log(`[proxy] ✅ Completato: ${total}b`);
            if (session) session.ts = Date.now();
        });
    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v63 porta ${PORT}`));
