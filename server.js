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
process.on('unhandledRejection', (r) => console.error('[v83-diag] unhandledRejection:', r?.message || r));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v83-diag' }));

let session = null;
let proxyChain = Promise.resolve();

function closeSession() {
    if (session) {
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
                    'jnbhi.com','dcbogyqtfxolp','creative-sb1','show-creative1',
                    'wayfarerorthodox.com','djtdmgwjbq.com','acscdn.com','asacdn.com'];

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
        return res.json({ success: true, video_url: session.videoUrl });
    }

    closeSession();
    console.log('[v83] ESTRAZIONE:', url);
    let browser = null, page = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            if (page) page.close().catch(() => {});
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 120000);

    async function setupCDP(videoUrl) {
        const cdp = await page.target().createCDPSession();

        // DIAGNOSTICA 1: ascolta TUTTI gli eventi CDP per vedere cosa arriva
        cdp.on('*', (eventName, params) => {
            if (eventName !== 'Fetch.requestPaused') {
                console.log(`[v83-diag] CDPSession evento: ${eventName}`);
            }
        });

        await cdp.send('Fetch.enable', {
            patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
        });
        console.log('[v83] ✅ CDP pronto, Fetch.enable inviato');

        // DIAGNOSTICA 2: verifica subito che la CDPSession risponde
        try {
            const target = await cdp.send('Target.getTargetInfo').catch(() => null);
            console.log('[v83-diag] CDPSession alive:', target ? 'sì' : 'no (null response)');
        } catch(e) {
            console.log('[v83-diag] CDPSession alive check err:', e.message);
        }

        session = { embedUrl: url, videoUrl, browser, page, cdp, ts: Date.now() };
        res.json({ success: true, video_url: videoUrl });
    }

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
                console.log('[v83] Video via intercept:', u.substring(0, 80));
                interceptorDone = true;
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    setupCDP(u).catch(e => {
                        console.error('[v83] CDP err:', e.message);
                        if (browser) browser.close().catch(() => {});
                        res.json({ success: false, message: 'CDP err: ' + e.message });
                    });
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
            .catch(e => console.log('[v83] goto err:', e.message.substring(0, 60)));

        for (let w = 0; w < 10 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1] || null;
            }).catch(() => null);
            if (q && !resolved) {
                resolved = true; clearTimeout(globalTimeout);
                interceptorDone = true;
                await setupCDP(q).catch(e => {
                    if (browser) browser.close().catch(() => {});
                    res.json({ success: false, message: 'CDP err: ' + e.message });
                });
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
                    interceptorDone = true;
                    await setupCDP(v).catch(e => {
                        if (browser) browser.close().catch(() => {});
                        res.json({ success: false, message: 'CDP err: ' + e.message });
                    });
                    return;
                }
                console.log(`[v83] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v83] ERRORE:', e.message);
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
    const ok = session && session.cdp;
    console.log(`[proxy] Range:${rangeHeader||'no'} | CDP:${ok?'sì':'NO'} | ${videoUrl.substring(0,50)}`);
    if (!ok) return res.status(503).send('Sessione scaduta, ricarica');

    const CHUNK = 256 * 1024;
    let start = 0, end = CHUNK - 1;
    if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (m) { start = parseInt(m[1]); end = m[2] ? Math.min(parseInt(m[2]), start+CHUNK-1) : start+CHUNK-1; }
    }
    const rangeStr = `bytes=${start}-${end}`;

    try {
        await withProxyLock(async () => {
            if (!session?.cdp) throw new Error('Sessione persa');
            const { page, cdp } = session;

            // DIAGNOSTICA 3: verifica CDPSession viva prima di ogni proxy
            try {
                await cdp.send('Target.getTargetInfo');
                console.log('[v83-diag] Pre-fetch CDPSession: viva');
            } catch(e) {
                console.log('[v83-diag] Pre-fetch CDPSession MORTA:', e.message);
                throw new Error('CDPSession detached');
            }

            console.log(`[proxy] CDP fetch: ${rangeStr}`);

            const streamReady = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    cdp.removeListener('Fetch.requestPaused', handler);
                    reject(new Error('Timeout CDP 25s'));
                }, 25000);

                const handler = async (ev) => {
                    console.log(`[v83-diag] Fetch.requestPaused: statusCode=${ev.responseStatusCode} url=${(ev.request?.url||'?').substring(0,60)}`);
                    if (ev.responseStatusCode === undefined) {
                        await cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
                        return;
                    }
                    clearTimeout(timer);
                    cdp.removeListener('Fetch.requestPaused', handler);
                    const status = ev.responseStatusCode;
                    const hdrs = ev.responseHeaders || [];
                    const ct = hdrs.find(h=>h.name.toLowerCase()==='content-type')?.value || 'video/mp4';
                    const cr = hdrs.find(h=>h.name.toLowerCase()==='content-range')?.value || '';
                    const cl = hdrs.find(h=>h.name.toLowerCase()==='content-length')?.value || '';
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

            // DIAGNOSTICA 4: verifica che fetch() venga effettivamente chiamata nel renderer
            const fetchResult = await page.evaluate(async (opts) => {
                try {
                    window.__fetchCalled = true;
                    window.__fetchTime = Date.now();
                    // Non awaita: lascia che CDP intercetti
                    fetch(opts.url, {
                        headers: { 'Range': opts.range, 'Accept': '*/*', 'Referer': opts.referer }
                    }).then(() => { window.__fetchDone = true; }).catch(e => { window.__fetchErr = e.message; });
                    return 'fetch lanciata';
                } catch(e) {
                    return 'ERRORE fetch: ' + e.message;
                }
            }, { url: videoUrl, range: rangeStr, referer: embedSrc || 'https://mixdrop.vip/' }).catch(e => 'evaluate err: ' + e.message);
            console.log(`[v83-diag] page.evaluate fetch(): ${fetchResult}`);

            // Aspetta 2s poi controlla stato fetch nel renderer
            await sleep(2000);
            const fetchState = await page.evaluate(() => ({
                called: window.__fetchCalled,
                done: window.__fetchDone,
                err: window.__fetchErr,
                elapsed: window.__fetchTime ? Date.now() - window.__fetchTime : null
            })).catch(() => null);
            console.log(`[v83-diag] fetch state dopo 2s:`, JSON.stringify(fetchState));

            const { stream, status, ct, cr, cl } = await streamReady;
            console.log(`[proxy] ✅ stream: ${status} | ${ct} | ${cl}b`);

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', ct);
            if (cl) res.setHeader('Content-Length', cl);
            if (cr) res.setHeader('Content-Range', cr);
            res.status(status === 206 ? 206 : 200);

            let total = 0;
            while (true) {
                const chunk = await cdp.send('IO.read', { handle: stream, size: 65536 });
                const buf = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'binary');
                if (buf.length > 0) { res.write(buf); total += buf.length; }
                if (chunk.eof) break;
            }
            res.end();
            await cdp.send('IO.close', { handle: stream }).catch(() => {});
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
app.listen(PORT, () => console.log(`Video Extractor v83-diag porta ${PORT}`));
