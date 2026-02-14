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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v21' }));

// Cache URL: embedUrl → { videoUrl, ts }
const urlCache = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of urlCache) {
        if (now - v.ts > 10*60*1000) urlCache.delete(k);
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

// Args senza --single-process (causa crash con più tab/browser)
function getBrowserArgs() {
    const args = chromium.args.filter(a => a !== '--single-process');
    return [...args, '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
            '--no-zygote', '--mute-audio', '--disable-blink-features=AutomationControlled',
            '--disable-web-security', '--allow-running-insecure-content'];
}

// ============================================================
// EXTRACT: trova URL video, chiude browser immediatamente
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    // Cache hit
    if (urlCache.has(url)) {
        const cached = urlCache.get(url);
        console.log('[v21] Cache hit:', cached.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: cached.videoUrl });
    }

    console.log('[v21] EXTRACT START:', url);
    let browser = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v21] TIMEOUT globale');
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 70000);

    try {
        const execPath = await chromium.executablePath();
        console.log('[v21] execPath:', execPath ? 'OK' : 'NULL');
        
        browser = await puppeteer.launch({
            args: getBrowserArgs(),
            defaultViewport: { width: 1280, height: 720 },
            executablePath: execPath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });
        console.log('[v21] Browser avviato');

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
                console.log('[v21] Video rilevato (request):', u.substring(0, 90));
                try { request.abort(); } catch(e) {}
                if (!resolved) finish(u);
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        page.on('response', (r) => {
            if (resolved) return;
            const u = r.url(), ct = r.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('mpegurl')) {
                console.log('[v21] Video rilevato (response CT):', u.substring(0, 90));
                if (!resolved) finish(u);
            }
        });

        function finish(videoUrl) {
            if (resolved) return;
            resolved = true;
            clearTimeout(globalTimeout);
            console.log('[v21] ✅ VIDEO:', videoUrl);
            urlCache.set(url, { videoUrl, ts: Date.now() });
            // Chiudi subito - token non consumato, browser libera RAM
            setImmediate(() => browser.close().catch(() => {}));
            res.json({ success: true, video_url: videoUrl });
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        
        console.log('[v21] Navigazione a:', url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v21] goto:', e.message.substring(0, 80)));
        console.log('[v21] Pagina caricata');

        for (let w = 0; w < 30 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u=window.MDCore.wurl; return u.startsWith('//')?'https:'+u:u; } } catch(e){}
                try { if (window.jwplayer) { const p=window.jwplayer().getPlaylist?.(); if(p?.[0]?.file)return p[0].file; } } catch(e){}
                const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if (q && !resolved) { finish(q); return; }
        }
        if (resolved) return;

        for (let i = 0; i < 15 && !resolved; i++) {
            await page.mouse.click(640+(Math.random()*40-20), 360+(Math.random()*40-20)).catch(()=>{});
            await sleep(800);
            if ((i+1)%3===0) {
                const v = await page.evaluate(()=>{
                    try{if(window.MDCore?.wurl){const u=window.MDCore.wurl;return u.startsWith('//')?'https:'+u:u;}}catch(e){}
                    const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                    return m?.[1]||null;
                }).catch(()=>null);
                if (v && !resolved) { finish(v); return; }
                console.log(`[v21] Click ${i+1}: niente`);
            }
        }

    } catch(e) {
        console.error('[v21] ERRORE CRITICO:', e.message, e.stack?.substring(0,300));
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(()=>{});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

// ============================================================
// PROXY: nuovo browser → naviga al video → CDP stream
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const rangeHeader = req.headers['range'];
    console.log(`[proxy] ===== NUOVA RICHIESTA =====`);
    console.log(`[proxy] URL: ${videoUrl.substring(0, 80)}`);
    console.log(`[proxy] Range: ${rangeHeader || 'nessuno'}`);
    console.log(`[proxy] Referer app: ${req.headers['referer'] || 'nessuno'}`);

    let browser = null;
    try {
        const execPath = await chromium.executablePath();
        console.log('[proxy] Avvio browser proxy...');
        browser = await puppeteer.launch({
            args: getBrowserArgs(),
            defaultViewport: { width: 1280, height: 720 },
            executablePath: execPath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });
        console.log('[proxy] Browser avviato');

        const page = await browser.newPage();
        const cdp = await page.target().createCDPSession();

        // Imposta headers identici al player originale
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        const extraHeaders = {
            'Accept': 'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5',
            'Accept-Language': 'it-IT,it;q=0.9',
            'Referer': embedSrc || 'https://mixdrop.vip/',
            'Origin': 'https://mixdrop.vip',
            'Sec-Fetch-Dest': 'video',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'cross-site',
        };
        if (rangeHeader) extraHeaders['Range'] = rangeHeader;
        await page.setExtraHTTPHeaders(extraHeaders);
        console.log('[proxy] Headers impostati, Referer:', extraHeaders['Referer'].substring(0, 60));

        // Intercetta risposta via CDP
        await cdp.send('Fetch.enable', {
            patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
        });

        let streamData = null;
        const streamReady = new Promise((resolve) => {
            cdp.on('Fetch.requestPaused', async (event) => {
                const status = event.responseStatusCode;
                const headers = event.responseHeaders || [];
                const ct = headers.find(h=>h.name.toLowerCase()==='content-type')?.value || '?';
                const cl = headers.find(h=>h.name.toLowerCase()==='content-length')?.value || '?';
                const cr = headers.find(h=>h.name.toLowerCase()==='content-range')?.value || '';
                console.log(`[proxy] CDP risposta: status=${status} CT=${ct} CL=${cl} CR=${cr}`);
                console.log(`[proxy] CDP request URL: ${event.request?.url?.substring(0,80)}`);
                
                if (status && status < 400) {
                    try {
                        console.log('[proxy] takeResponseBodyAsStream...');
                        const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
                        console.log('[proxy] Stream handle ottenuto:', stream);
                        resolve({ stream, status, ct, cl, cr });
                    } catch(e) {
                        console.error('[proxy] takeResponseBodyAsStream ERRORE:', e.message);
                        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(()=>{});
                        resolve({ error: status, message: e.message });
                    }
                } else {
                    console.log(`[proxy] CDN blocca: status=${status}`);
                    await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(()=>{});
                    resolve({ error: status || 403 });
                }
            });
        });

        console.log('[proxy] Navigazione al video...');
        page.goto(videoUrl, { waitUntil: 'commit', timeout: 20000 }).catch(e => {
            console.log('[proxy] goto warning:', e.message.substring(0, 80));
        });

        const result = await Promise.race([
            streamReady,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 25s in attesa CDP')), 25000))
        ]);

        if (result.error) {
            console.log(`[proxy] FALLITO: status=${result.error} ${result.message||''}`);
            await browser.close().catch(()=>{});
            return res.status(result.error).send('CDN errore ' + result.error);
        }

        const { stream, status, ct, cl, cr } = result;
        console.log(`[proxy] Inizio streaming: status=${status} CT=${ct} CL=${cl}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', ct === '?' ? 'video/mp4' : ct);
        if (cl && cl !== '?') res.setHeader('Content-Length', cl);
        if (cr) res.setHeader('Content-Range', cr);
        res.status(status === 206 ? 206 : 200);

        let totalBytes = 0;
        const CHUNK = 256 * 1024;
        while (true) {
            const chunk = await cdp.send('IO.read', { handle: stream, size: CHUNK });
            const buf = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'binary');
            if (buf.length > 0) {
                res.write(buf);
                totalBytes += buf.length;
                if (totalBytes % (2*1024*1024) < CHUNK) console.log(`[proxy] Streamati ${Math.round(totalBytes/1024)}KB...`);
            }
            if (chunk.eof) break;
        }
        res.end();
        console.log(`[proxy] ✅ Completato: ${Math.round(totalBytes/1024)}KB totali`);
        await cdp.send('IO.close', { handle: stream }).catch(()=>{});
        await browser.close().catch(()=>{});

    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        console.error('[proxy] Stack:', e.stack?.substring(0, 300));
        if (browser) browser.close().catch(()=>{});
        if (!res.headersSent) res.status(500).send('Errore proxy: ' + e.message);
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v21 porta ${PORT}`));
