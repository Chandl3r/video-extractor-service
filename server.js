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
    res.json({ status: 'ok', service: 'Video Extractor v4' });
});

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_TYPES = ['image', 'font', 'stylesheet'];
const BLOCK_URLS  = ['google-analytics','googletagmanager','facebook','doubleclick','googlesyndication'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (u.includes('.js') || u.includes('.css') || u.includes('.png') ||
        u.includes('.jpg') || u.includes('.gif') || u.includes('.ico') ||
        u.includes('.woff') || u.includes('analytics') || u.includes('ads')) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v4] Estrazione:', url);
    let browser = null;
    let resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            console.log('[v4] Timeout globale 45s');
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout: video non trovato in tempo' });
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
                '--disable-blink-features=AutomationControlled', // Anti-detection!
            ],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        let videoUrl = null;

        // === ANTI-DETECTION: rimuovi segni di automazione ===
        await page.evaluateOnNewDocument(() => {
            // Rimuovi webdriver flag
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            // Simula plugins reali
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            // Simula linguaggi reali
            Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US', 'en'] });
            // Simula chrome reale
            window.chrome = { runtime: {} };
            // Rimuovi segni di headless
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
        });

        await page.setRequestInterception(true);

        page.on('request', (req) => {
            const reqUrl = req.url();
            const resType = req.resourceType();

            if (BLOCK_TYPES.includes(resType)) return req.abort();
            if (BLOCK_URLS.some(b => reqUrl.includes(b))) return req.abort();

            if (!videoUrl && looksLikeVideo(reqUrl)) {
                videoUrl = reqUrl;
                console.log('[v4] ✅ VIDEO (richiesta):', reqUrl);
                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    res.json({ success: true, video_url: videoUrl, source: url });
                    setImmediate(() => browser.close().catch(() => {}));
                }
            }
            try { req.continue(); } catch(e) {}
        });

        page.on('response', (response) => {
            if (videoUrl || resolved) return;
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('application/x-mpegurl') || ct.includes('application/vnd.apple.mpegurl')) {
                videoUrl = response.url();
                console.log('[v4] ✅ VIDEO (risposta header):', videoUrl);
                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    res.json({ success: true, video_url: videoUrl, source: url });
                    setImmediate(() => browser.close().catch(() => {}));
                }
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Imposta header HTTP realistici
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Upgrade-Insecure-Requests': '1',
        });

        // Carica la pagina
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(e => {
            console.log('[v4] goto:', e.message.substring(0, 60));
        });

        // Aspetta 3s poi cerca nell'HTML
        await sleep(3000);

        if (!videoUrl && !resolved) {
            console.log('[v4] Cerco nell\'HTML...');
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
                        /"(https?:\/\/[^"]{15,}\.m3u8[^"]*)"/,
                    ];
                    for (const s of document.querySelectorAll('script:not([src])')) {
                        for (const p of patterns) {
                            const m = s.textContent.match(p);
                            if (m) return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
                        }
                    }
                    // Log HTML per debug
                    console.log('[page] HTML length:', document.documentElement.innerHTML.length);
                    console.log('[page] title:', document.title);
                    return null;
                });
            } catch(e) { console.log('[v4] evaluate error:', e.message); }

            if (videoUrl) {
                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    console.log('[v4] ✅ VIDEO (HTML):', videoUrl);
                    res.json({ success: true, video_url: videoUrl, source: url });
                    setImmediate(() => browser.close().catch(() => {}));
                }
                return;
            }
        }

        // Premi Play
        if (!videoUrl && !resolved) {
            console.log('[v4] Provo Play...');
            const selectors = [
                '.jw-icon-display', '.vjs-big-play-button', '[aria-label="Play"]',
                '.plyr__control--overlaid', '.jwplayer .jw-display-icon-container',
                'button[class*="play"]', '[id*="play"]', '[class*="play"]',
            ];
            for (const sel of selectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) {
                        await btn.click();
                        console.log('[v4] Cliccato:', sel);
                        await sleep(4000);
                        break;
                    }
                } catch(e) {}
            }
            // Prova click generico sul centro della pagina (dove spesso c'è il player)
            try {
                await page.mouse.click(640, 360);
                console.log('[v4] Click centro pagina');
                await sleep(3000);
            } catch(e) {}
        }

    } catch (error) {
        console.error('[v4] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v4 porta ${PORT}`));
