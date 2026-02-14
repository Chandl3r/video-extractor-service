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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v36' }));

const urlCache = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of urlCache) if (now - v.ts > 15*60*1000) urlCache.delete(k);
}, 60000);

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','facebook.net'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','recaptcha'].some(x=>u.includes(x))) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

// Browser EXTRACT: senza --disable-web-security (stabile per caricare mixdrop)
async function launchExtractBrowser() {
    return puppeteer.launch({
        args: [...chromium.args,
               '--no-sandbox', '--disable-setuid-sandbox',
               '--disable-dev-shm-usage', '--disable-gpu',
               '--no-first-run', '--no-zygote', '--single-process',
               '--mute-audio', '--disable-blink-features=AutomationControlled'],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
}

// Browser PROXY: con --disable-web-security (per fetch cross-origin da about:blank)
// Stessa macchina = stesso IP = token valido
async function launchProxyBrowser() {
    return puppeteer.launch({
        args: [...chromium.args,
               '--no-sandbox', '--disable-setuid-sandbox',
               '--disable-dev-shm-usage', '--disable-gpu',
               '--no-first-run', '--no-zygote', '--single-process',
               '--mute-audio',
               '--disable-web-security',
               '--allow-running-insecure-content'],
        defaultViewport: { width: 1, height: 1 },  // minimo possibile
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
}

// ============================================================
// EXTRACT: browser normale → stabile → trova URL → chiude tutto
// RAM dopo extract: ~50MB (solo Node.js)
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    if (urlCache.has(url)) {
        const c = urlCache.get(url);
        console.log('[v36] cache hit:', c.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: c.videoUrl });
    }

    console.log('[v36] ESTRAZIONE:', url);
    let browser = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v36] TIMEOUT');
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 70000);

    try {
        browser = await launchExtractBrowser();
        const page = await browser.newPage();
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
                console.log('[v36] Video:', u.substring(0, 80));
                interceptorDone = true;
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    urlCache.set(url, { videoUrl: u, ts: Date.now() });
                    browser.close().catch(() => {}); // libera ~250MB RAM
                    console.log('[v36] ✅ Browser chiuso, RAM liberata');
                    res.json({ success: true, video_url: u });
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v36] goto:', e.message.substring(0, 60)));

        for (let w = 0; w < 30 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1] || null;
            }).catch(() => null);
            if (q && !resolved) {
                resolved = true; clearTimeout(globalTimeout);
                urlCache.set(url, { videoUrl: q, ts: Date.now() });
                browser.close().catch(() => {});
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
                    urlCache.set(url, { videoUrl: v, ts: Date.now() });
                    browser.close().catch(() => {});
                    res.json({ success: true, video_url: v });
                    return;
                }
                console.log(`[v36] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v36] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (browser) browser.close().catch(() => {});
        if (!resolved) res.json({ success: false, message: 'Errore: ' + e.message });
    }
});

// ============================================================
// PROXY: browser separato con --disable-web-security
// Stessa macchina Render = stesso IP = token valido
// fetch() da about:blank senza CORS → funziona
// Browser chiuso dopo ogni chunk → RAM liberata
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const rangeHeader = req.headers['range'];
    let start = 0, end = 65535;
    if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (m) {
            start = parseInt(m[1]);
            end = m[2] ? Math.min(parseInt(m[2]), start + 65535) : start + 65535;
        }
    }
    const rangeStr = `bytes=${start}-${end}`;
    console.log(`[proxy] Range: ${rangeStr} | ${videoUrl.substring(0,55)}`);

    let proxyBrowser = null;
    try {
        proxyBrowser = await launchProxyBrowser();
        const page = await proxyBrowser.newPage();
        await page.goto('about:blank').catch(() => {});

        const result = await Promise.race([
            page.evaluate(async (opts) => {
                try {
                    const r = await fetch(opts.url, {
                        headers: {
                            'Range': opts.range,
                            'Accept': '*/*',
                            'Referer': opts.referer,
                        }
                    });
                    const status = r.status;
                    if (status >= 400) return { error: true, status, msg: `HTTP ${status}` };
                    const ct = r.headers.get('content-type') || 'video/mp4';
                    const cr = r.headers.get('content-range') || '';
                    const ab = await r.arrayBuffer();
                    const bytes = new Uint8Array(ab);
                    let bin = '';
                    for (let i = 0; i < bytes.length; i += 4096) {
                        bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i+4096, bytes.length)));
                    }
                    return { error: false, status, ct, cr, b64: btoa(bin), len: bytes.length };
                } catch(e) { return { error: true, msg: e.message }; }
            }, { url: videoUrl, range: rangeStr, referer: embedSrc || 'https://mixdrop.vip/' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout 20s')), 20000))
        ]);

        // Chiudi browser SUBITO dopo il fetch (libera RAM)
        proxyBrowser.close().catch(() => {});
        proxyBrowser = null;

        if (result.error) {
            console.error('[proxy] fetch err:', result.msg || result.status);
            return res.status(result.status || 502).send(result.msg || 'Fetch fallito');
        }

        console.log(`[proxy] ✅ ${result.status} | ${result.ct} | ${result.len}b`);
        const buf = Buffer.from(result.b64, 'base64');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', result.ct);
        res.setHeader('Content-Length', buf.length);
        if (result.cr) res.setHeader('Content-Range', result.cr);
        res.status(result.status === 206 ? 206 : 200).send(buf);

    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if (proxyBrowser) proxyBrowser.close().catch(() => {});
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v36 porta ${PORT}`));
