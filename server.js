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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v32' }));

// Sessioni: embedUrl → { videoUrl, browser, ts }
// NOTA: pagina mixdrop viene chiusa subito dopo extract per liberare RAM
const sessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) {
        if (now - s.ts > 15 * 60 * 1000) {
            if (s.browser) s.browser.close().catch(() => {});
            sessions.delete(k);
        }
    }
}, 60000);

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','usrpubtrk',
                    'adexchangeclear','facebook.net'];

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
               '--mute-audio', '--disable-blink-features=AutomationControlled'],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
}

// ============================================================
// EXTRACT: trova URL, chiude la pagina mixdrop, mantiene browser
// RAM dopo extract: ~150MB (solo processo Chrome, nessuna pagina)
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    if (sessions.has(url)) {
        const s = sessions.get(url);
        s.ts = Date.now();
        console.log('[v32] Riuso sessione:', s.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: s.videoUrl });
    }

    console.log('[v32] ESTRAZIONE:', url);
    let browser = null, page = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v32] TIMEOUT');
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

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const u = request.url();
            if (BLOCK_URLS.some(b => u.includes(b))) { try{request.abort();}catch(e){} return; }
            if (looksLikeVideo(u)) {
                console.log('[v32] Video rilevato:', u.substring(0, 80));
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    sessions.set(url, { videoUrl: u, browser, ts: Date.now() });
                    // Chiudi pagina mixdrop → libera ~100MB RAM
                    // Il browser resta aperto → stesso IP per il proxy
                    page.close().catch(() => {});
                    console.log('[v32] ✅ Pagina chiusa, browser attivo, RAM liberata');
                    res.json({ success: true, video_url: u });
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v32] goto:', e.message.substring(0, 60)));

        for (let w = 0; w < 30 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1] || null;
            }).catch(() => null);
            if (q && !resolved) {
                resolved = true; clearTimeout(globalTimeout);
                sessions.set(url, { videoUrl: q, browser, ts: Date.now() });
                page.close().catch(() => {});
                res.json({ success: true, video_url: q });
                return;
            }
        }
        if (resolved) return;

        for (let i = 0; i < 15 && !resolved; i++) {
            await page.mouse.click(640 + (Math.random()*40-20), 360 + (Math.random()*40-20)).catch(() => {});
            await sleep(800);
            if ((i+1) % 3 === 0) {
                const v = await page.evaluate(() => {
                    try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                    const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                    return m?.[1] || null;
                }).catch(() => null);
                if (v && !resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    sessions.set(url, { videoUrl: v, browser, ts: Date.now() });
                    page.close().catch(() => {});
                    res.json({ success: true, video_url: v });
                    return;
                }
                console.log(`[v32] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v32] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (page) page.close().catch(() => {});
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

// ============================================================
// PROXY: apre pagina minimale con <video> nello stesso browser
// RAM durante proxy: ~200MB (browser + 1 pagina leggera)
// Chrome invia Sec-Fetch-Dest: video → CDN accetta ✅
// Stesso IP dell'extract → token valido ✅
// CDP intercetta risposta → IO.read streaming ✅
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const session = embedSrc ? sessions.get(embedSrc) : null;
    const rangeHeader = req.headers['range'];
    console.log(`[proxy] Range:${rangeHeader||'no'} | Session:${session?'sì':'NO'} | ${videoUrl.substring(0,60)}`);

    if (!session || !session.browser) {
        return res.status(503).send('Sessione scaduta, ricarica');
    }

    let videoPage = null;
    try {
        const { browser } = session;

        // Pagina minimale: solo un <video> element, niente altro
        // Chrome carica questa pagina in ~5MB RAM (vs ~80MB per mixdrop)
        videoPage = await browser.newPage();
        const cdp = await videoPage.target().createCDPSession();

        // Intercetta sia Request (per aggiungere Range/headers) che Response (per stream)
        await cdp.send('Fetch.enable', {
            patterns: [
                { urlPattern: '*mxcontent.net*.mp4*', requestStage: 'Request' },
                { urlPattern: '*mxcontent.net*.mp4*', requestStage: 'Response' }
            ]
        });

        const streamReady = new Promise((resolve) => {
            cdp.on('Fetch.requestPaused', async (event) => {
                const isResponse = event.responseStatusCode !== undefined;

                if (!isResponse) {
                    // Stage Request: modifica headers prima che Chrome invii
                    const headers = [
                        { name: 'Accept', value: '*/*' },
                        { name: 'Accept-Language', value: 'it-IT,it;q=0.9' },
                        { name: 'Referer', value: embedSrc || 'https://mixdrop.vip/' },
                        { name: 'Sec-Fetch-Dest', value: 'video' },
                        { name: 'Sec-Fetch-Mode', value: 'no-cors' },
                        { name: 'Sec-Fetch-Site', value: 'cross-site' },
                        { name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
                    ];
                    if (rangeHeader) headers.push({ name: 'Range', value: rangeHeader });
                    console.log('[proxy] Modifico headers request...');
                    await cdp.send('Fetch.continueRequest', {
                        requestId: event.requestId,
                        headers
                    }).catch(() => cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {}));

                } else {
                    // Stage Response: intercetta il corpo
                    const status = event.responseStatusCode;
                    const hdrs = event.responseHeaders || [];
                    const ct = hdrs.find(h=>h.name.toLowerCase()==='content-type')?.value || 'video/mp4';
                    const cl = hdrs.find(h=>h.name.toLowerCase()==='content-length')?.value || '';
                    const cr = hdrs.find(h=>h.name.toLowerCase()==='content-range')?.value || '';
                    console.log(`[proxy] CDP risposta: ${status} | ${ct} | ${cl||'?'}b | CR:${cr||'no'}`);

                    if (status && status < 400) {
                        try {
                            const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
                            resolve({ stream, status, ct, cl, cr });
                        } catch(e) {
                            console.error('[proxy] stream err:', e.message);
                            resolve({ error: status });
                        }
                    } else {
                        console.log('[proxy] CDN blocca:', status);
                        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
                        resolve({ error: status || 403 });
                    }
                }
            });
        });

        // Pagina minimale: <video> element che richiede il video
        // data: URL = nessuna navigazione di rete, ~5MB RAM
        const html = `<html><body><video autoplay muted><source src="${videoUrl}"></video></body></html>`;
        console.log('[proxy] Carico pagina <video> minimale...');
        await videoPage.goto('data:text/html,' + encodeURIComponent(html), {
            waitUntil: 'domcontentloaded', timeout: 10000
        }).catch(e => console.log('[proxy] goto warn:', e.message.substring(0, 40)));

        const result = await Promise.race([
            streamReady,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 35s')), 35000))
        ]);

        if (result.error) {
            await videoPage.close().catch(() => {});
            return res.status(result.error).send('CDN error: ' + result.error);
        }

        const { stream, status, ct, cl, cr } = result;
        console.log(`[proxy] ✅ Streaming: ${status} | ${ct} | ${cl||'?'}b`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', ct);
        if (cl) res.setHeader('Content-Length', cl);
        if (cr) res.setHeader('Content-Range', cr);
        res.status(status === 206 ? 206 : 200);

        let total = 0, CHUNK = 256 * 1024;
        while (true) {
            const chunk = await cdp.send('IO.read', { handle: stream, size: CHUNK });
            const buf = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'binary');
            if (buf.length > 0) { res.write(buf); total += buf.length; }
            if (chunk.eof) break;
            if (total % (5*1024*1024) < CHUNK) console.log(`[proxy] ${Math.round(total/1024/1024)}MB...`);
        }
        res.end();
        console.log(`[proxy] ✅ Completato: ${Math.round(total/1024)}KB`);
        await cdp.send('IO.close', { handle: stream }).catch(() => {});
        await videoPage.close().catch(() => {});
        session.ts = Date.now();

    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if (videoPage) videoPage.close().catch(() => {});
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v32 porta ${PORT}`));
