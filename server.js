const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const https = require('https');
const http = require('http');

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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v34' }));

// Cache: embedUrl → { videoUrl, ts }
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

// ============================================================
// EXTRACT: Puppeteer trova URL, chiude tutto, libera RAM
// Dopo extract: 0 browser in RAM (solo Node.js ~50MB)
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    if (urlCache.has(url)) {
        const c = urlCache.get(url);
        console.log('[v34] cache hit:', c.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: c.videoUrl });
    }

    console.log('[v34] ESTRAZIONE:', url);
    let browser = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v34] TIMEOUT');
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 70000);

    try {
        browser = await puppeteer.launch({
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
                console.log('[v34] Video rilevato:', u.substring(0, 80));
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    urlCache.set(url, { videoUrl: u, ts: Date.now() });
                    // Chiudi browser subito: libera ~250MB RAM!
                    browser.close().catch(() => {});
                    console.log('[v34] ✅ Browser chiuso, RAM liberata');
                    res.json({ success: true, video_url: u });
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v34] goto:', e.message.substring(0, 60)));

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
                console.log(`[v34] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v34] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (browser) browser.close().catch(() => {});
        if (!resolved) res.json({ success: false, message: 'Errore: ' + e.message });
    }
});

// ============================================================
// PROXY: Node.js https nativo - pipe diretto, RAM ~0MB extra!
// mxcontent.net CDN controlla IP+token, non TLS fingerprint
// Render ha stesso IP per Node.js e Chrome → token valido ✅
// Streaming puro: nessun buffer, dati passano direttamente ✅
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const rangeHeader = req.headers['range'];
    console.log(`[proxy] Range:${rangeHeader||'no'} | ${videoUrl.substring(0, 60)}`);

    const parsedUrl = new URL(videoUrl);
    const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'it-IT,it;q=0.9',
            'Referer': embedSrc || 'https://mixdrop.vip/',
            'Origin': 'https://mixdrop.vip',
        }
    };
    if (rangeHeader) options.headers['Range'] = rangeHeader;

    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = protocol.request(options, (proxyRes) => {
        const status = proxyRes.statusCode;
        console.log(`[proxy] CDN risposta: ${status} | ${proxyRes.headers['content-type']||'?'} | ${proxyRes.headers['content-length']||'?'}b`);

        if (status >= 400) {
            console.log(`[proxy] CDN blocca: ${status}`);
            res.status(status).send(`CDN error: ${status}`);
            return;
        }

        // Passa headers al client
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
        if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
        if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
        res.status(status);

        // Pipe diretto: dati CDN → client, nessun buffer in memoria!
        let total = 0;
        proxyRes.on('data', (chunk) => {
            total += chunk.length;
            if (total % (5*1024*1024) < chunk.length) console.log(`[proxy] ${Math.round(total/1024/1024)}MB...`);
        });
        proxyRes.pipe(res);
        proxyRes.on('end', () => console.log(`[proxy] ✅ Completato: ${Math.round(total/1024)}KB`));
    });

    proxyReq.on('error', (e) => {
        console.error('[proxy] ERRORE:', e.message);
        if (!res.headersSent) res.status(502).send('Errore proxy: ' + e.message);
    });

    req.on('close', () => proxyReq.destroy());
    proxyReq.end();
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v34 porta ${PORT}`));
