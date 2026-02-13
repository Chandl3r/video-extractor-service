const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

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
    res.json({ status: 'ok', service: 'Video Extractor v8' });
});

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_TYPES = ['image', 'font', 'stylesheet'];
const BLOCK_URLS  = ['google-analytics','googletagmanager','doubleclick',
                     'googlesyndication','adsco.re','xadsmart',
                     'adexchangeclear','flushpersist','usrpubtrk'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (u.includes('.js') || u.includes('.css') || u.includes('.png') ||
        u.includes('.jpg') || u.includes('.gif') || u.includes('.ico') ||
        u.includes('.woff') || u.includes('analytics') || u.includes('recaptcha')) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

// Sonda la pagina ogni 2 secondi fino a trovare il video
async function pollForVideo(page, maxAttempts = 15) {
    for (let i = 0; i < maxAttempts; i++) {
        await sleep(2000);
        console.log(`[v8] Poll ${i+1}/${maxAttempts}...`);

        try {
            const result = await page.evaluate(() => {
                // 1. Tag video
                for (const v of document.querySelectorAll('video')) {
                    if (v.src?.startsWith('http')) return v.src;
                    const s = v.querySelector('source[src]');
                    if (s?.src?.startsWith('http')) return s.src;
                }

                // 2. MDCore (Mixdrop specifico)
                try {
                    if (window.MDCore?.wurl) {
                        const u = window.MDCore.wurl;
                        return u.startsWith('//') ? 'https:' + u : u;
                    }
                } catch(e) {}

                // 3. JWPlayer
                try {
                    if (window.jwplayer) {
                        const pl = window.jwplayer().getPlaylist?.();
                        if (pl?.[0]?.file) return pl[0].file;
                        if (pl?.[0]?.sources?.[0]?.file) return pl[0].sources[0].file;
                    }
                } catch(e) {}

                // 4. VideoJS
                try {
                    const vjs = window.videojs?.players;
                    if (vjs) {
                        for (const p of Object.values(vjs)) {
                            const src = p.currentSrc?.();
                            if (src?.startsWith('http')) return src;
                        }
                    }
                } catch(e) {}

                // 5. Cerca nell'HTML corrente
                const html = document.documentElement.innerHTML;
                const patterns = [
                    /MDCore\.wurl\s*=\s*["']([^"']{10,})["']/,
                    /wurl\s*[=:]\s*["']([^"']{10,})["']/,
                    /"file"\s*:\s*"(https?:[^"]{10,}\.(?:mp4|m3u8)[^"]*)"/,
                    /'file'\s*:\s*'(https?:[^']{10,}\.(?:mp4|m3u8)[^']*)'/,
                    /"(https?:\/\/[^"]{15,}\.mp4[^"]*)"/,
                    /"(https?:\/\/[^"]{15,}\.m3u8[^"]*)"/,
                    /src:\s*["'](https?:[^"']{10,}\.(?:mp4|m3u8)[^"']*)["']/i,
                ];
                for (const p of patterns) {
                    const m = html.match(p);
                    if (m?.[1]) {
                        const u = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
                        if (u.startsWith('http')) return u;
                    }
                }

                return null;
            });

            if (result) return result;
        } catch(e) {
            console.log(`[v8] Poll error: ${e.message}`);
        }
    }
    return null;
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v8] Estrazione:', url);
    let browser = null;
    let resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            console.log('[v8] Timeout globale');
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout: video non trovato' });
        }
    }, 55000);

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

        await page.setRequestInterception(true);

        // Intercetta richieste video dirette dalla rete
        page.on('request', (req) => {
            const reqUrl = req.url();
            const resType = req.resourceType();

            if (BLOCK_TYPES.includes(resType)) return req.abort();
            if (BLOCK_URLS.some(b => reqUrl.includes(b))) return req.abort();

            if (!resolved && looksLikeVideo(reqUrl)) {
                console.log('[v8] ✅ VIDEO (network):', reqUrl);
                clearTimeout(globalTimeout);
                resolved = true;
                res.json({ success: true, video_url: reqUrl });
                setImmediate(() => browser.close().catch(() => {}));
                try { req.abort(); } catch(e) {}
                return;
            }
            try { req.continue(); } catch(e) {}
        });

        page.on('response', (response) => {
            if (resolved) return;
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('mpegurl')) {
                const vUrl = response.url();
                console.log('[v8] ✅ VIDEO (response):', vUrl);
                clearTimeout(globalTimeout);
                resolved = true;
                res.json({ success: true, video_url: vUrl });
                setImmediate(() => browser.close().catch(() => {}));
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        });

        // Avvia il caricamento della pagina (non aspettiamo)
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 50000 }).catch(e => {
            console.log('[v8] goto:', e.message.substring(0, 60));
        });

        // Sonda ogni 2 secondi fino a trovare il video
        const videoUrl = await pollForVideo(page, 15); // max 30 secondi

        if (videoUrl && !resolved) {
            console.log('[v8] ✅ VIDEO (poll):', videoUrl);
            clearTimeout(globalTimeout);
            resolved = true;
            res.json({ success: true, video_url: videoUrl });
            setImmediate(() => browser.close().catch(() => {}));
        }

        // Se ancora non trovato, premi Play
        if (!resolved) {
            console.log('[v8] Provo Play...');
            const selectors = [
                '.jw-icon-display', '.vjs-big-play-button', '[aria-label="Play"]',
                '.plyr__control--overlaid', '.jwplayer .jw-display-icon-container',
                'button[class*="play"]', 'video',
            ];
            for (const sel of selectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) {
                        await btn.click();
                        console.log('[v8] Click:', sel);
                        // Sonda ancora dopo il click
                        const afterClick = await pollForVideo(page, 5);
                        if (afterClick && !resolved) {
                            console.log('[v8] ✅ VIDEO (dopo play):', afterClick);
                            clearTimeout(globalTimeout);
                            resolved = true;
                            res.json({ success: true, video_url: afterClick });
                            setImmediate(() => browser.close().catch(() => {}));
                        }
                        break;
                    }
                } catch(e) {}
            }
        }

    } catch (error) {
        console.error('[v8] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v8 porta ${PORT}`));
