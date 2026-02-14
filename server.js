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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v20' }));

// Sessioni: embedUrl → { videoUrl, browser, ts }
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
        args: [...chromium.args, '--no-sandbox','--disable-setuid-sandbox',
               '--disable-dev-shm-usage','--disable-gpu','--no-first-run',
               '--no-zygote','--single-process','--mute-audio',
               '--disable-blink-features=AutomationControlled'],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
}

// ============================================================
// EXTRACT: trova URL video (ABORT → token non consumato)
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    // Riusa sessione valida
    if (sessions.has(url)) {
        const s = sessions.get(url);
        s.ts = Date.now();
        console.log('[v20] Riuso sessione:', s.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: s.videoUrl });
    }

    console.log('[v20] ESTRAZIONE:', url);
    let browser = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) { resolved = true; if (browser) browser.close().catch(()=>{}); res.json({ success: false, message: 'Timeout' }); }
    }, 70000);

    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const u = request.url();
            if (BLOCK_URLS.some(b => u.includes(b))) { try{request.abort();}catch(e){} return; }
            if (looksLikeVideo(u)) {
                console.log('[v20] Video rilevato:', u.substring(0, 80));
                try { request.abort(); } catch(e) {} // ABORT: token non consumato!
                if (!resolved) {
                    resolved = true;
                    clearTimeout(globalTimeout);
                    sessions.set(url, { videoUrl: u, browser, ts: Date.now() });
                    res.json({ success: true, video_url: u });
                    // Browser rimane aperto per il proxy
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('[v20] goto:', e.message.substring(0, 60)));

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
                    res.json({ success: true, video_url: v });
                    return;
                }
                console.log(`[v20] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v20] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (!resolved) { resolved = true; if (browser) browser.close().catch(()=>{}); res.json({ success: false, message: 'Errore: ' + e.message }); }
    }
});

// ============================================================
// PROXY: nuova tab Chrome nello stesso browser (stesso IP Render)
// Intercetta risposta via CDP Fetch → streama via IO.read
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const session = embedSrc ? sessions.get(embedSrc) : null;
    const rangeHeader = req.headers['range'];
    console.log(`[proxy] ${videoUrl.substring(0, 70)} | Range: ${rangeHeader||'nessuno'} | Session: ${session ? 'sì' : 'no'}`);

    if (!session || !session.browser) {
        return res.status(503).json({ error: 'Sessione scaduta, ricarica la pagina' });
    }

    let videoPage = null;
    try {
        const { browser } = session;

        // Apri nuova tab nello stesso browser (stesso IP, stesso TLS Chrome)
        videoPage = await browser.newPage();
        const cdp = await videoPage.target().createCDPSession();

        // Headers che imita il video player originale
        const extraHeaders = {
            'Accept': '*/*',
            'Referer': embedSrc,
            'Origin': 'https://mixdrop.vip',
        };
        if (rangeHeader) extraHeaders['Range'] = rangeHeader;
        await videoPage.setExtraHTTPHeaders(extraHeaders);
        await videoPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Intercetta risposta via CDP Fetch
        await cdp.send('Fetch.enable', {
            patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
        });

        let streamResolve;
        const streamReady = new Promise(r => streamResolve = r);

        cdp.on('Fetch.requestPaused', async (event) => {
            const status = event.responseStatusCode;
            const ct = (event.responseHeaders||[]).find(h=>h.name.toLowerCase()==='content-type')?.value||'?';
            const cl = (event.responseHeaders||[]).find(h=>h.name.toLowerCase()==='content-length')?.value||'?';
            console.log(`[proxy] CDP intercettato: url=${event.request?.url?.substring(0,60)} status=${status} CT=${ct} CL=${cl}`);
            if (status && status < 400) {
                try {
                    const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
                    streamResolve({ stream, status, headers: event.responseHeaders || [] });
                } catch(e) {
                    console.error('[proxy] takeResponseBodyAsStream error:', e.message);
                    await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
                    streamResolve({ error: status });
                }
            } else {
                console.log('[proxy] CDN errore:', status);
                await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
                streamResolve({ error: status || 403 });
            }
        });

        // Naviga all'URL video - Chrome fa la richiesta con il suo TLS dal suo IP
        console.log('[proxy] Chrome naviga al video:', videoUrl.substring(0, 80));
        console.log('[proxy] Referer impostato:', embedSrc ? embedSrc.substring(0,60) : 'nessuno');
        videoPage.goto(videoUrl, { waitUntil: 'commit', timeout: 20000 }).catch(e => {
            console.log('[proxy] goto video warning:', e.message.substring(0, 80));
        });

        // Attendi la risposta (max 25s)
        const result = await Promise.race([
            streamReady,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout stream')), 25000))
        ]);

        if (result.error) {
            await videoPage.close().catch(() => {});
            return res.status(result.error).send('CDN errore ' + result.error);
        }

        const { stream, status, headers } = result;

        // Imposta headers risposta
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        res.setHeader('Accept-Ranges', 'bytes');

        const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
        const ct = getHeader('content-type') || 'video/mp4';
        const cl = getHeader('content-length');
        const cr = getHeader('content-range');

        res.setHeader('Content-Type', ct);
        if (cl) res.setHeader('Content-Length', cl);
        if (cr) res.setHeader('Content-Range', cr);

        res.status(status === 206 ? 206 : 200);
        console.log(`[proxy] Streaming: status=${status} | ${ct} | ${cl || '?'} bytes`);

        // Streama via IO.read in chunk da 256KB
        let totalBytes = 0;
        const CHUNK = 256 * 1024;

        while (true) {
            const chunk = await cdp.send('IO.read', { handle: stream, size: CHUNK });
            const buf = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'binary');
            if (buf.length > 0) {
                res.write(buf);
                totalBytes += buf.length;
                if (totalBytes % (5 * 1024 * 1024) < CHUNK) {
                    console.log(`[proxy] Streamati ${Math.round(totalBytes/1024/1024)}MB...`);
                }
            }
            if (chunk.eof) break;
        }
        res.end();
        console.log(`[proxy] ✅ Completato: ${Math.round(totalBytes/1024)}KB`);
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
app.listen(PORT, () => console.log(`Video Extractor v20 porta ${PORT}`));
