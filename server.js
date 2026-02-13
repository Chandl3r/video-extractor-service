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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v14' }));

// Store: videoUrl + cookies estratti da Puppeteer
const videoCache = new Map(); // embedUrl → { video_url, cookies, ts }
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of videoCache) {
        if (now - v.ts > 10 * 60 * 1000) videoCache.delete(k);
    }
}, 60000);

// ============================================================
// EXTRACT: estrae URL + salva i cookie della sessione Puppeteer
// ============================================================
const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart',
                    'adexchangeclear','flushpersist','usrpubtrk'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (u.includes('.js')||u.includes('.css')||u.includes('.png')||u.includes('.jpg')||
        u.includes('.gif')||u.includes('.ico')||u.includes('.woff')||
        u.includes('analytics')||u.includes('recaptcha')||u.includes('adsco')) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v14] Estrazione:', url);
    let browser = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 58000);

    try {
        browser = await puppeteer.launch({
            args: [...chromium.args,
                   '--no-sandbox', '--disable-setuid-sandbox',
                   '--disable-dev-shm-usage', '--disable-gpu',
                   '--no-first-run', '--no-zygote', '--single-process',
                   '--mute-audio', '--disable-blink-features=AutomationControlled'],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });

        let capturedVideoUrl = null;

        async function resolveVideo(vUrl, src) {
            if (resolved) return;
            resolved = true;
            console.log(`[v14] ✅ VIDEO (${src}):`, vUrl);

            // Raccogli i cookie della sessione Puppeteer
            const cookies = await page.cookies().catch(() => []);
            console.log(`[v14] Cookie raccolti: ${cookies.length}`);

            // Formatta cookie come stringa header
            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            // Salva in cache
            videoCache.set(url, {
                video_url: vUrl,
                cookie_str: cookieStr,
                referer: new URL(url).origin + '/',
                ts: Date.now(),
            });

            clearTimeout(globalTimeout);
            res.json({ success: true, video_url: vUrl });
            setImmediate(() => browser.close().catch(() => {}));
        }

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const u = req.url();
            if (BLOCK_URLS.some(b => u.includes(b))) return req.abort();
            if (req.resourceType() === 'media') return req.abort();
            if (!resolved && looksLikeVideo(u)) {
                resolveVideo(u, 'network');
                try { req.abort(); } catch(e) {}
                return;
            }
            try { req.continue(); } catch(e) {}
        });
        page.on('response', (r) => {
            if (resolved) return;
            const ct = r.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('mpegurl')) resolveVideo(r.url(), 'response');
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8' });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v14] goto:', e.message.substring(0, 60)));

        await sleep(2500);
        if (resolved) return;

        // Check DOM
        const v = await page.evaluate(() => {
            try { if (window.MDCore?.wurl) { const u=window.MDCore.wurl; return u.startsWith('//')?'https:'+u:u; } } catch(e){}
            try { if (window.jwplayer) { const p=window.jwplayer().getPlaylist?.(); if(p?.[0]?.file)return p[0].file; } } catch(e){}
            const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.mp4[^"]{0,50})"/);
            return m?.[1]||null;
        }).catch(()=>null);
        if (v && !resolved) { resolveVideo(v, 'dom-check'); return; }

        // Click multipli
        for (let i = 0; i < 18 && !resolved; i++) {
            await page.mouse.click(640+(Math.random()*20-10), 360+(Math.random()*20-10));
            await sleep(900);
            const v2 = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u=window.MDCore.wurl; return u.startsWith('//')?'https:'+u:u; } } catch(e){}
                const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.mp4[^"]{0,50})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if (v2 && !resolved) { resolveVideo(v2, `click-${i+1}`); return; }
        }

    } catch(e) {
        console.error('[v14] Errore:', e.message);
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

// ============================================================
// PROXY: serve il video usando i cookie della sessione Puppeteer
// ============================================================
app.options('/proxy', (req, res) => res.status(200).end());

app.get('/proxy', (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    // Recupera i cookie dalla cache (se disponibili)
    const cached = embedSrc ? videoCache.get(embedSrc) : null;
    const cookieStr = cached?.cookie_str || '';
    const referer = cached?.referer || 'https://mixdrop.vip/';

    console.log(`[proxy] ${videoUrl.substring(0, 70)} | cookies: ${cookieStr.length > 0 ? 'sì' : 'no'} | Range: ${req.headers['range'] || 'nessuno'}`);

    let parsed;
    try { parsed = new URL(videoUrl); } catch(e) { return res.status(400).send('URL non valido'); }

    const protocol = parsed.protocol === 'https:' ? https : http;

    const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer,
        'Origin': new URL(referer).origin,
        'Accept': '*/*',
        'Accept-Language': 'it-IT,it;q=0.9',
    };

    if (cookieStr) upstreamHeaders['Cookie'] = cookieStr;
    if (req.headers['range']) upstreamHeaders['Range'] = req.headers['range'];

    const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: upstreamHeaders,
        timeout: 30000,
    };

    const proxyReq = protocol.request(options, (proxyRes) => {
        console.log(`[proxy] Risposta: ${proxyRes.statusCode} | ${proxyRes.headers['content-type']} | ${proxyRes.headers['content-length'] || '?'} bytes`);

        if (proxyRes.statusCode === 403) {
            console.error('[proxy] 403 - cookies insufficienti o token scaduto');
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        res.setHeader('Accept-Ranges', 'bytes');

        ['content-type','content-length','content-range','last-modified','etag','cache-control'].forEach(h => {
            if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
        });

        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res, { end: true });
        proxyRes.on('error', e => console.error('[proxy] stream error:', e.message));
    });

    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).end(); });
    proxyReq.on('error', e => { console.error('[proxy] error:', e.message); if (!res.headersSent) res.status(502).end(); });
    req.on('close', () => proxyReq.destroy());
    proxyReq.end();
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v14 porta ${PORT}`));
