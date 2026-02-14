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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v19' }));

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','usrpubtrk',
                    'adexchangeclear','facebook.net'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','recaptcha','adsco'].some(x=>u.includes(x))) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

// ============================================================
// EXTRACT: trova URL video senza intercettare (solo osservazione)
// Chiude il browser PRIMA che Chrome scarichi il video
// → token NON consumato → il browser utente lo usa per primo
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v19] ESTRAZIONE:', url);
    let browser = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 70000);

    try {
        browser = await puppeteer.launch({
            args: [...chromium.args,
                   '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                   '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process',
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
            Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US'] });
        });

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const u = request.url();
            // Blocca tracker/ads
            if (BLOCK_URLS.some(b => u.includes(b))) {
                try { request.abort(); } catch(e) {}
                return;
            }
            // Rilevato video: cattura URL e ABORTA (token non consumato!)
            if (looksLikeVideo(u)) {
                console.log('[v19] URL video rilevato:', u.substring(0, 90));
                try { request.abort(); } catch(e) {} // abort prima di resolveWithUrl
                if (!resolved) resolveWithUrl(u);
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        page.on('response', (response) => {
            if (resolved) return;
            const u = response.url();
            const ct = response.headers()['content-type'] || '';
            if (looksLikeVideo(u) || ct.includes('video/') || ct.includes('mpegurl')) {
                console.log('[v19] URL video rilevato (response):', u.substring(0, 90));
                resolveWithUrl(u);
            }
        });

        function resolveWithUrl(videoUrl) {
            if (resolved) return;
            resolved = true;
            clearTimeout(globalTimeout);
            console.log('[v19] ✅ VIDEO:', videoUrl);
            // Chiudi subito il browser → download non completato → token ancora valido
            browser.close().catch(() => {});
            browser = null;
            res.json({ success: true, video_url: videoUrl });
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8' });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v19] goto:', e.message.substring(0, 60)));

        // Poll rapido ogni 500ms
        for (let w = 0; w < 30 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                try { if (window.jwplayer) { const p = window.jwplayer().getPlaylist?.(); if (p?.[0]?.file) return p[0].file; } } catch(e) {}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1] || null;
            }).catch(() => null);
            if (q && !resolved) { resolveWithUrl(q); return; }
        }
        if (resolved) return;

        for (let i = 0; i < 15 && !resolved; i++) {
            await page.mouse.click(640 + (Math.random() * 40 - 20), 360 + (Math.random() * 40 - 20)).catch(() => {});
            await sleep(800);
            if ((i + 1) % 3 === 0) {
                const v = await page.evaluate(() => {
                    try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                    const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                    return m?.[1] || null;
                }).catch(() => null);
                if (v && !resolved) { resolveWithUrl(v, `click-${i + 1}`); return; }
                console.log(`[v19] Click ${i + 1}: niente`);
            }
        }

    } catch(e) {
        console.error('[v19] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v19 porta ${PORT}`));
