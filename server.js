const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Video Extractor v5-debug' });
});

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_TYPES = ['image', 'font', 'stylesheet'];
const BLOCK_URLS  = ['google-analytics','googletagmanager','facebook','doubleclick','googlesyndication'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (u.includes('.js') || u.includes('.css') || u.includes('.png') ||
        u.includes('.jpg') || u.includes('.gif') || u.includes('.ico') ||
        u.includes('.woff') || u.includes('analytics')) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v5] Estrazione:', url);
    let browser = null;
    let resolved = false;
    let allRequests = []; // Log tutte le richieste per debug

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            console.log('[v5] Timeout - richieste intercettate:', allRequests.length);
            // Logga le ultime 20 richieste per capire cosa ha caricato
            allRequests.slice(-20).forEach(r => console.log('[v5] req:', r));
            if (browser) browser.close().catch(() => {});
            res.json({ 
                success: false, 
                message: 'Timeout',
                debug_requests: allRequests.slice(-30)
            });
        }
    }, 45000);

    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--no-first-run', '--no-zygote', '--single-process',
                '--disable-extensions', '--mute-audio',
                '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        let videoUrl = null;

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US', 'en'] });
            window.chrome = { runtime: {} };
        });

        await page.setRequestInterception(true);

        page.on('request', (req) => {
            const reqUrl = req.url();
            const resType = req.resourceType();

            // Logga TUTTE le richieste (per debug)
            allRequests.push(resType + ': ' + reqUrl.substring(0, 100));

            if (BLOCK_TYPES.includes(resType)) return req.abort();
            if (BLOCK_URLS.some(b => reqUrl.includes(b))) return req.abort();

            if (!videoUrl && looksLikeVideo(reqUrl)) {
                videoUrl = reqUrl;
                console.log('[v5] ✅ VIDEO:', reqUrl);
                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    res.json({ success: true, video_url: videoUrl });
                    setImmediate(() => browser.close().catch(() => {}));
                }
            }
            try { req.continue(); } catch(e) {}
        });

        page.on('response', (response) => {
            if (videoUrl || resolved) return;
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('mpegurl')) {
                videoUrl = response.url();
                console.log('[v5] ✅ VIDEO (header):', videoUrl);
                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    res.json({ success: true, video_url: videoUrl });
                    setImmediate(() => browser.close().catch(() => {}));
                }
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        });

        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(e => {
            console.log('[v5] goto error:', e.message.substring(0, 80));
        });

        await sleep(3000);

        if (!videoUrl && !resolved) {
            // Log stato pagina per debug
            try {
                const pageInfo = await page.evaluate(() => ({
                    title: document.title,
                    url: window.location.href,
                    htmlLength: document.documentElement.innerHTML.length,
                    hasVideo: document.querySelectorAll('video').length,
                    bodyText: document.body?.innerText?.substring(0, 200) || '',
                }));
                console.log('[v5] Pagina:', JSON.stringify(pageInfo));
            } catch(e) { console.log('[v5] eval error:', e.message); }

            // Cerca video nell'HTML
            try {
                videoUrl = await page.evaluate(() => {
                    for (const v of document.querySelectorAll('video')) {
                        if (v.src?.startsWith('http')) return v.src;
                        const s = v.querySelector('source[src]');
                        if (s?.src?.startsWith('http')) return s.src;
                    }
                    const patterns = [
                        /MDCore\.wurl\s*=\s*["']([^"']+)["']/,
                        /wurl\s*[=:]\s*["']([^"']+)["']/,
                        /file\s*:\s*["'](https?:[^"']+\.mp4[^"']*)["']/i,
                        /file\s*:\s*["'](https?:[^"']+\.m3u8[^"']*)["']/i,
                        /"(https?:\/\/[^"]{15,}\.mp4[^"]*)"/,
                    ];
                    for (const s of document.querySelectorAll('script:not([src])')) {
                        for (const p of patterns) {
                            const m = s.textContent.match(p);
                            if (m) return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
                        }
                    }
                    return null;
                });
            } catch(e) {}

            if (videoUrl) {
                console.log('[v5] ✅ VIDEO (HTML):', videoUrl);
                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    res.json({ success: true, video_url: videoUrl });
                    setImmediate(() => browser.close().catch(() => {}));
                }
                return;
            }

            // Premi Play
            console.log('[v5] Provo Play...');
            const selectors = [
                '.jw-icon-display', '.vjs-big-play-button', '[aria-label="Play"]',
                '.plyr__control--overlaid', 'button[class*="play"]',
            ];
            for (const sel of selectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) { await btn.click(); console.log('[v5] Click:', sel); await sleep(4000); break; }
                } catch(e) {}
            }
            try { await page.mouse.click(640, 360); await sleep(3000); } catch(e) {}
        }

    } catch (error) {
        console.error('[v5] Errore:', error.message);
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + error.message });
        }
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v5-debug porta ${PORT}`));
