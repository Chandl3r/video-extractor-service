const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const https = require('https');
const http = require('http');
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
console.log('[v65] Avvio pulito');
process.on('unhandledRejection', (r) => console.error('[v65] unhandledRejection:', r?.message || r));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v65' }));

// Sessione: solo videoUrl e embedUrl — Chrome chiuso subito dopo extract
let session = null;

function closeSession() {
    if (session) {
        console.log('[v65] Chiudo sessione');
        session = null;
    }
}

setInterval(() => {
    if (session && Date.now() - session.ts > 15 * 60 * 1000) closeSession();
}, 60000);

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
        console.log('[v65] Cache hit:', session.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: session.videoUrl });
    }

    closeSession();
    console.log('[v65] ESTRAZIONE:', url);
    let browser = null, page = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v65] TIMEOUT');
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 120000);

    // Callback quando troviamo il video: chiude Chrome subito
    const onVideoFound = async (videoUrl) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(globalTimeout);
        console.log('[v65] Video:', videoUrl.substring(0, 80));
        // Chiudi Chrome immediatamente — non serve più
        try { await browser.close(); } catch(e) {}
        browser = null; page = null;
        console.log('[v65] ✅ Chrome chiuso, RAM liberata');
        session = { embedUrl: url, videoUrl, ts: Date.now() };
        res.json({ success: true, video_url: videoUrl });
    };

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
                interceptorDone = true;
                try { request.abort(); } catch(e) {}
                onVideoFound(u);
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
            .catch(e => console.log('[v65] goto:', e.message.substring(0, 60)));

        for (let w = 0; w < 10 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1] || null;
            }).catch(() => null);
            if (q) { await onVideoFound(q); return; }
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
                if (v) { await onVideoFound(v); return; }
                console.log(`[v65] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v65] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

// PROXY: Node.js https diretto — Chrome non serve più durante streaming
// RAM: ~50MB invece di 250MB
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');
    if (!session) return res.status(503).send('Sessione scaduta, ricarica');

    const rangeHeader = req.headers['range'];
    console.log(`[proxy] Range:${rangeHeader||'no'} | ${videoUrl.substring(0,50)}`);

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': embedSrc || 'https://mixdrop.vip/',
        'Origin': 'https://mixdrop.vip',
    };
    if (rangeHeader) headers['Range'] = rangeHeader;

    const parsed = new URL(videoUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const proxyReq = lib.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
    }, (proxyRes) => {
        const status = proxyRes.statusCode;
        console.log(`[proxy] ✅ ${status} | ${proxyRes.headers['content-type']} | ${proxyRes.headers['content-length']}b`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
        if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
        if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
        res.status(status);

        proxyRes.pipe(res);
        proxyRes.on('end', () => {
            console.log(`[proxy] ✅ Completato`);
            if (session) session.ts = Date.now();
        });
    });

    proxyReq.on('error', (e) => {
        console.error('[proxy] ERRORE:', e.message);
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    });

    req.on('close', () => proxyReq.destroy());
    proxyReq.end();
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v65 porta ${PORT}`));
