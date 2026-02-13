const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

// Attiva il plugin stealth - bypassa reCAPTCHA, WebRTC fingerprint, ecc.
puppeteer.use(StealthPlugin());

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
    res.json({ status: 'ok', service: 'Video Extractor v6-stealth' });
});

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_TYPES = ['image', 'font', 'stylesheet'];
const BLOCK_URLS  = ['google-analytics','googletagmanager','doubleclick',
                     'googlesyndication','hotjar','adsco.re','xadsmart',
                     'adexchangeclear','flushpersist','usrpubtrk'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (u.includes('.js') || u.includes('.css') || u.includes('.png') ||
        u.includes('.jpg') || u.includes('.gif') || u.includes('.ico') ||
        u.includes('.woff') || u.includes('analytics') || u.includes('recaptcha')) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v6] Estrazione:', url);
    let browser = null;
    let resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            console.log('[v6] Timeout 50s');
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout: video non trovato' });
        }
    }, 50000);

    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--no-first-run', '--no-zygote', '--single-process',
                '--mute-audio',
            ],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        let videoUrl = null;

        function resolveWithVideo(vUrl) {
            if (!resolved) {
                resolved = true;
                videoUrl = vUrl;
                console.log('[v6] ✅ VIDEO:', vUrl);
                clearTimeout(globalTimeout);
                res.json({ success: true, video_url: vUrl });
                setImmediate(() => browser.close().catch(() => {}));
            }
        }

        await page.setRequestInterception(true);

        page.on('request', (req) => {
            const reqUrl = req.url();
            const resType = req.resourceType();

            if (BLOCK_TYPES.includes(resType)) return req.abort();
            if (BLOCK_URLS.some(b => reqUrl.includes(b))) return req.abort();

            if (!resolved && looksLikeVideo(reqUrl)) {
                resolveWithVideo(reqUrl);
                try { req.abort(); } catch(e) {}
                return;
            }
            try { req.continue(); } catch(e) {}
        });

        page.on('response', async (response) => {
            if (resolved) return;
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('mpegurl')) {
                resolveWithVideo(response.url());
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        });

        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => {
            console.log('[v6] goto:', e.message.substring(0, 80));
        });

        // Aspetta che la pagina carichi e JS venga eseguito
        await sleep(4000);

        if (!resolved) {
            console.log('[v6] Cerco nell\'HTML...');
            try {
                const result = await page.evaluate(() => {
                    // Tag video
                    for (const v of document.querySelectorAll('video')) {
                        if (v.src?.startsWith('http')) return { type: 'video_tag', url: v.src };
                        const s = v.querySelector('source[src]');
                        if (s?.src?.startsWith('http')) return { type: 'source_tag', url: s.src };
                    }
                    // Script inline - pattern comuni
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
                            if (m) {
                                const u = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
                                return { type: 'script', url: u };
                            }
                        }
                    }
                    return { 
                        type: 'not_found',
                        title: document.title,
                        htmlLength: document.documentElement.innerHTML.length,
                        scripts: Array.from(document.querySelectorAll('script:not([src])')).length
                    };
                });
                
                console.log('[v6] Risultato HTML:', JSON.stringify(result));
                
                if (result.url) {
                    resolveWithVideo(result.url);
                    return;
                }
            } catch(e) { console.log('[v6] eval error:', e.message); }
        }

        // Premi Play
        if (!resolved) {
            console.log('[v6] Provo Play...');
            const selectors = [
                '.jw-icon-display', '.vjs-big-play-button', '[aria-label="Play"]',
                '.plyr__control--overlaid', '.jwplayer .jw-display-icon-container',
                'button[class*="play"]', '.play', '#play',
            ];
            for (const sel of selectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) {
                        await btn.click();
                        console.log('[v6] Click:', sel);
                        await sleep(5000);
                        break;
                    }
                } catch(e) {}
            }
            // Click centro
            try { await page.mouse.click(640, 360); await sleep(3000); } catch(e) {}
        }

    } catch (error) {
        console.error('[v6] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v6-stealth porta ${PORT}`));
