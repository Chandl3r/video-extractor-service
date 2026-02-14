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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v22' }));

// UN solo browser condiviso: extract e proxy usano lo stesso IP
let sharedBrowser = null;
let browserBusy = false;

async function getSharedBrowser() {
    if (sharedBrowser) {
        try {
            const pages = await sharedBrowser.pages();
            console.log(`[browser] Browser esistente, ${pages.length} pagine aperte`);
            return sharedBrowser;
        } catch(e) {
            console.log('[browser] Browser esistente non valido, ne creo uno nuovo');
            sharedBrowser = null;
        }
    }
    console.log('[browser] Avvio nuovo browser condiviso...');
    const execPath = await chromium.executablePath();
    sharedBrowser = await puppeteer.launch({
        args: [
            ...chromium.args.filter(a => a !== '--single-process'),
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu',
            '--no-first-run', '--no-zygote',
            '--mute-audio', '--disable-blink-features=AutomationControlled',
            '--memory-pressure-off',
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: execPath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
    sharedBrowser.on('disconnected', () => {
        console.log('[browser] Browser disconnesso, verrà ricreato al prossimo uso');
        sharedBrowser = null;
    });
    console.log('[browser] Browser condiviso avviato ✅');
    return sharedBrowser;
}

// Cache: embedUrl → { videoUrl, ts }
const urlCache = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of urlCache) {
        if (now - v.ts > 8*60*1000) urlCache.delete(k);
    }
}, 60000);

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','facebook.net'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','recaptcha'].some(x=>u.includes(x))) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

// ============================================================
// EXTRACT: usa browser condiviso, trova URL, TIENE browser aperto
// Il token è firmato con l'IP del browser condiviso
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    if (urlCache.has(url)) {
        const c = urlCache.get(url);
        console.log('[v22] Cache hit:', c.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: c.videoUrl });
    }

    console.log('[v22] EXTRACT:', url);
    let page = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            if (page) page.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 70000);

    try {
        const browser = await getSharedBrowser();
        page = await browser.newPage();
        console.log('[v22] Pagina aperta nel browser condiviso');

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const u = request.url();
            if (BLOCK_URLS.some(b => u.includes(b))) { try{request.abort();}catch(e){} return; }
            if (looksLikeVideo(u)) {
                console.log('[v22] Video rilevato:', u.substring(0, 90));
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true;
                    clearTimeout(globalTimeout);
                    urlCache.set(url, { videoUrl: u, ts: Date.now() });
                    // Chiudi questa pagina ma MANTIENI il browser aperto (stesso IP per proxy)
                    page.close().catch(() => {});
                    console.log('[v22] ✅ VIDEO trovato, pagina chiusa, browser attivo');
                    res.json({ success: true, video_url: u });
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });

        console.log('[v22] Navigazione:', url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v22] goto:', e.message.substring(0, 60)));
        console.log('[v22] Pagina caricata');

        for (let w = 0; w < 30 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u=window.MDCore.wurl; return u.startsWith('//')?'https:'+u:u; } } catch(e){}
                const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if (q && !resolved) {
                resolved = true; clearTimeout(globalTimeout);
                urlCache.set(url, { videoUrl: q, ts: Date.now() });
                page.close().catch(() => {});
                res.json({ success: true, video_url: q });
                return;
            }
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
                if (v && !resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    urlCache.set(url, { videoUrl: v, ts: Date.now() });
                    page.close().catch(() => {});
                    res.json({ success: true, video_url: v });
                    return;
                }
                console.log(`[v22] Click ${i+1}: niente`);
            }
        }

    } catch(e) {
        console.error('[v22] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (page) page.close().catch(()=>{});
        if (!resolved) res.json({ success: false, message: 'Errore: ' + e.message });
    }
});

// ============================================================
// PROXY: usa lo stesso browser condiviso → stesso IP → token valido
// Nuova pagina nel browser esistente, CDP intercetta risposta
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const rangeHeader = req.headers['range'];
    console.log(`[proxy] URL: ${videoUrl.substring(0, 70)} | Range: ${rangeHeader||'nessuno'}`);

    let videoPage = null;
    try {
        // Usa lo stesso browser condiviso (stesso IP di quando è stato generato il token!)
        const browser = await getSharedBrowser();
        videoPage = await browser.newPage();
        const cdp = await videoPage.target().createCDPSession();

        await videoPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const extraHeaders = {
            'Accept': '*/*',
            'Accept-Language': 'it-IT,it;q=0.9',
            'Referer': embedSrc || 'https://mixdrop.vip/',
            'Origin': 'https://mixdrop.vip',
            'Sec-Fetch-Dest': 'video',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'cross-site',
        };
        if (rangeHeader) extraHeaders['Range'] = rangeHeader;
        await videoPage.setExtraHTTPHeaders(extraHeaders);

        // CDP intercetta risposta video
        await cdp.send('Fetch.enable', {
            patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
        });

        const streamReady = new Promise((resolve) => {
            cdp.on('Fetch.requestPaused', async (event) => {
                const status = event.responseStatusCode;
                const headers = event.responseHeaders || [];
                const ct = headers.find(h=>h.name.toLowerCase()==='content-type')?.value || 'video/mp4';
                const cl = headers.find(h=>h.name.toLowerCase()==='content-length')?.value || '';
                const cr = headers.find(h=>h.name.toLowerCase()==='content-range')?.value || '';
                console.log(`[proxy] CDP: status=${status} CT=${ct} CL=${cl}`);

                if (status && status < 400) {
                    try {
                        const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
                        resolve({ stream, status, ct, cl, cr });
                    } catch(e) {
                        console.error('[proxy] takeResponseBodyAsStream error:', e.message);
                        resolve({ error: status });
                    }
                } else {
                    console.log('[proxy] CDN 403 anche con browser condiviso!');
                    await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(()=>{});
                    resolve({ error: status || 403 });
                }
            });
        });

        console.log('[proxy] Navigazione al video (stesso browser, stesso IP)...');
        videoPage.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => {
            console.log('[proxy] goto warning:', e.message.substring(0, 60));
        });

        const result = await Promise.race([
            streamReady,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 40s')), 40000))
        ]);

        if (result.error) {
            console.log(`[proxy] FALLITO: ${result.error}`);
            await videoPage.close().catch(()=>{});
            return res.status(result.error).send('Errore CDN: ' + result.error);
        }

        const { stream, status, ct, cl, cr } = result;
        console.log(`[proxy] ✅ Stream avviato: ${status} ${ct} ${cl}bytes`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', ct);
        if (cl) res.setHeader('Content-Length', cl);
        if (cr) res.setHeader('Content-Range', cr);
        res.status(status === 206 ? 206 : 200);

        let total = 0;
        const CHUNK = 256 * 1024;
        while (true) {
            const chunk = await cdp.send('IO.read', { handle: stream, size: CHUNK });
            const buf = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'binary');
            if (buf.length > 0) { res.write(buf); total += buf.length; }
            if (chunk.eof) break;
            if (total % (5*1024*1024) < CHUNK) console.log(`[proxy] ${Math.round(total/1024/1024)}MB streamati...`);
        }
        res.end();
        console.log(`[proxy] ✅ Completato: ${Math.round(total/1024)}KB`);
        await cdp.send('IO.close', { handle: stream }).catch(()=>{});
        await videoPage.close().catch(()=>{});

    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if (videoPage) videoPage.close().catch(()=>{});
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v22 porta ${PORT}`));
