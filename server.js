const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v15' }));

// Cache cookie per il proxy
const cookieCache = new Map(); // embedUrl → { cookieStr, referer, ts }
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cookieCache) {
        if (now - v.ts > 10 * 60 * 1000) cookieCache.delete(k);
    }
}, 60000);

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','usrpubtrk',
                    'adexchangeclear','flushpersist','facebook.net','hotjar'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (['.js','.css','.png','.jpg','.gif','.ico','.woff',
         'analytics','recaptcha','adsco'].some(x => u.includes(x))) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v15] === INIZIO ESTRAZIONE:', url);
    let browser = null;
    let resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v15] ⏰ TIMEOUT GLOBALE');
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 70000);

    try {
        console.log('[v15] Avvio Chromium...');
        const execPath = await chromium.executablePath();
        console.log('[v15] execPath:', execPath ? execPath.substring(0, 50) : 'NULL');

        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--mute-audio',
                '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: execPath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });
        console.log('[v15] Browser avviato ✅');

        const page = await browser.newPage();
        console.log('[v15] Nuova pagina creata');

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
        });

        // Risoluzione ASINCRONA: raccoglie cookie PRIMA di rispondere
        async function resolveVideo(vUrl, src) {
            if (resolved) return;
            resolved = true;
            clearTimeout(globalTimeout);
            console.log(`[v15] ✅ VIDEO (${src}):`, vUrl);

            // Raccoglie cookie prima di rispondere al client
            let cookieStr = '';
            try {
                const cookies = await page.cookies();
                cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                console.log(`[v15] Cookie raccolti: ${cookies.length} → ${cookieStr.substring(0, 120)}`);
            } catch(e) {
                console.log('[v15] Cookie error:', e.message);
            }

            cookieCache.set(url, {
                cookieStr,
                referer: url,  // URL completo dell'embed, non solo origin
                ts: Date.now(),
            });

            // Ora risponde: i cookie sono già in cache quando il client chiama /proxy
            res.json({ success: true, video_url: vUrl });
            setTimeout(() => browser.close().catch(() => {}), 500);
        }

        await page.setRequestInterception(true);

        page.on('request', (request) => {
            const u = request.url();
            if (BLOCK_URLS.some(b => u.includes(b))) {
                try { request.abort(); } catch(e) {}
                return;
            }
            if (request.resourceType() === 'media') {
                console.log('[v15] Media (risorsa):', u.substring(0, 80));
                try { request.abort(); } catch(e) {}
                if (!resolved) resolveVideo(u, 'media-resource'); // async, non blocca
                return;
            }
            if (!resolved && looksLikeVideo(u)) {
                console.log('[v15] Video da network:', u.substring(0, 100));
                try { request.abort(); } catch(e) {}
                resolveVideo(u, 'network'); // async, non blocca
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        page.on('response', (response) => {
            if (resolved) return;
            const ct = response.headers()['content-type'] || '';
            const u = response.url();
            if (ct.includes('video/') || ct.includes('mpegurl') || ct.includes('octet-stream')) {
                if (looksLikeVideo(u)) {
                    console.log('[v15] Video da response:', u.substring(0, 100));
                    resolveVideo(u, 'response');
                }
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8' });

        console.log('[v15] Navigazione a:', url);
        const gotoResult = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        }).catch(e => {
            console.log('[v15] goto warning:', e.message.substring(0, 80));
            return null;
        });
        console.log('[v15] Pagina caricata, status:', gotoResult?.status?.() || 'N/A');

        if (resolved) return;

        // Poll rapido ogni 500ms per i primi 15 secondi
        for (let w = 0; w < 30 && !resolved; w++) {
            await sleep(500);
            const quick = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u=window.MDCore.wurl; return u.startsWith('//')?'https:'+u:u; } } catch(e){}
                try { if (window.jwplayer) { const p=window.jwplayer().getPlaylist?.(); if(p?.[0]?.file)return p[0].file; } } catch(e){}
                const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if (quick) {
                console.log(`[v15] Trovato in poll rapido (${w*0.5}s):`, quick.substring(0, 80));
                if (!resolved) resolveVideo(quick, 'poll');
                return;
            }
        }

        console.log('[v15] Poll rapido completato, resolved:', resolved);
        if (resolved) return;

        // Check DOM
        const domVideo = await page.evaluate(() => {
            try {
                for (const v of document.querySelectorAll('video')) {
                    if (v.src?.startsWith('http')) return v.src;
                }
                if (window.MDCore?.wurl) {
                    const u = window.MDCore.wurl;
                    return u.startsWith('//') ? 'https:' + u : u;
                }
                if (window.jwplayer) {
                    const p = window.jwplayer().getPlaylist?.();
                    if (p?.[0]?.file) return p[0].file;
                }
            } catch(e) {}
            // Cerca nell'HTML
            const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
            return m?.[1] || null;
        }).catch(e => { console.log('[v15] DOM eval error:', e.message); return null; });

        if (domVideo) {
            console.log('[v15] Trovato nel DOM:', domVideo.substring(0, 100));
            if (!resolved) resolveVideo(domVideo, 'dom');
            return;
        }
        console.log('[v15] DOM check: niente trovato');

        // Click multipli
        for (let i = 0; i < 15 && !resolved; i++) {
            const x = 640 + (Math.random() * 40 - 20);
            const y = 360 + (Math.random() * 40 - 20);
            await page.mouse.click(x, y).catch(() => {});
            await sleep(800);

            if ((i + 1) % 3 === 0) {
                const v = await page.evaluate(() => {
                    try {
                        for (const v of document.querySelectorAll('video')) {
                            if (v.src?.startsWith('http')) return v.src;
                        }
                        if (window.MDCore?.wurl) { const u=window.MDCore.wurl; return u.startsWith('//')?'https:'+u:u; }
                    } catch(e) {}
                    const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                    return m?.[1] || null;
                }).catch(() => null);

                if (v) {
                    console.log(`[v15] Trovato dopo click ${i+1}:`, v.substring(0, 80));
                    if (!resolved) resolveVideo(v, `click-${i+1}`);
                    return;
                }
                console.log(`[v15] Click ${i+1}: niente ancora`);
            }
        }

        console.log('[v15] Fine ciclo click, resolved:', resolved);

    } catch(e) {
        console.error('[v15] ERRORE CRITICO:', e.message);
        console.error('[v15] Stack:', e.stack?.substring(0, 200));
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

// ============================================================
// PROXY con cookie
// ============================================================
app.get('/proxy', (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const cached = embedSrc ? cookieCache.get(embedSrc) : null;
    const cookieStr = cached?.cookieStr || '';
    const referer = cached?.referer || 'https://mixdrop.vip/';

    console.log(`[proxy] URL: ${videoUrl.substring(0, 70)}`);
    console.log(`[proxy] Cookie: ${cookieStr ? cookieStr.substring(0, 80) : 'nessuno'}`);
    console.log(`[proxy] Range: ${req.headers['range'] || 'nessuno'}`);

    let parsed;
    try { parsed = new URL(videoUrl); } catch(e) { return res.status(400).send('URL non valido'); }

    const protocol = parsed.protocol === 'https:' ? https : http;

    let refererOrigin = 'https://mixdrop.vip';
    try { refererOrigin = new URL(referer).origin; } catch(e) {}

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer,        // URL completo embed: https://mixdrop.vip/emb/7kpp37vmi31zj4
        'Origin': refererOrigin,   // Solo origin: https://mixdrop.vip
        'Accept': '*/*',
        'Accept-Language': 'it-IT,it;q=0.9',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
    };
    if (cookieStr) headers['Cookie'] = cookieStr;
    if (req.headers['range']) headers['Range'] = req.headers['range'];

    const proxyReq = protocol.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: 30000,
    }, (proxyRes) => {
        console.log(`[proxy] Risposta: ${proxyRes.statusCode} | CT: ${proxyRes.headers['content-type']} | Size: ${proxyRes.headers['content-length'] || '?'}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        res.setHeader('Accept-Ranges', 'bytes');
        ['content-type','content-length','content-range','last-modified','etag','cache-control'].forEach(h => {
            if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
        });
        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).end(); });
    proxyReq.on('error', e => { console.error('[proxy] error:', e.message); if (!res.headersSent) res.status(502).end(); });
    req.on('close', () => proxyReq.destroy());
    proxyReq.end();
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v15 porta ${PORT}`));
