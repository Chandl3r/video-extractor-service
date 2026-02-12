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
    res.json({ status: 'ok', service: 'Video Extractor v3' });
});

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_TYPES = ['image', 'font', 'stylesheet', 'media'];
const BLOCK_URLS  = ['google-analytics','googletagmanager','facebook','doubleclick','googlesyndication','hotjar','disqus'];

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

    console.log('[v3] Estrazione:', url);
    let browser = null;
    let resolved = false;

    // Timeout globale: rispondo dopo 45s al massimo
    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            console.log('[v3] Timeout globale 45s');
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout: il sito non ha risposto in tempo' });
        }
    }, 45000);

    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--no-first-run', '--no-zygote',
                '--single-process', // Importante per Render free
                '--disable-extensions', '--mute-audio',
                '--disable-background-networking',
                '--disable-sync', '--metrics-recording-only',
                '--disable-default-apps', '--no-pings',
            ],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        let videoUrl = null;

        await page.setRequestInterception(true);

        // INTERCETTA RICHIESTE - appena trova un video, STOP!
        page.on('request', async (req) => {
            const reqUrl = req.url();
            const resType = req.resourceType();

            // Blocca risorse pesanti
            if (BLOCK_TYPES.includes(resType)) return req.abort();
            if (BLOCK_URLS.some(b => reqUrl.includes(b))) return req.abort();

            // Trovato video! Rispondi subito e chiudi il browser
            if (!videoUrl && looksLikeVideo(reqUrl)) {
                videoUrl = reqUrl;
                console.log('[v3] ✅ VIDEO TROVATO (richiesta):', reqUrl);

                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    res.json({ success: true, video_url: videoUrl, source: url });
                    // Chiudi browser in background
                    setImmediate(() => browser.close().catch(() => {}));
                }
            }

            try { req.continue(); } catch(e) {}
        });

        // Intercetta anche le risposte
        page.on('response', (response) => {
            if (videoUrl || resolved) return;
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('application/x-mpegurl') || ct.includes('application/vnd.apple.mpegurl')) {
                videoUrl = response.url();
                console.log('[v3] ✅ VIDEO TROVATO (risposta):', videoUrl);
                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    res.json({ success: true, video_url: videoUrl, source: url });
                    setImmediate(() => browser.close().catch(() => {}));
                }
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Carica la pagina (non aspettiamo che finisca - ci interessa solo l'intercettazione)
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(e => {
            console.log('[v3] goto error (normale):', e.message.substring(0, 50));
        });

        // Aspetta 3 secondi poi cerca nell'HTML
        await sleep(3000);

        if (!videoUrl && !resolved) {
            console.log('[v3] Cerco nell\'HTML...');
            try {
                videoUrl = await page.evaluate(() => {
                    // Tag video
                    for (const v of document.querySelectorAll('video')) {
                        if (v.src && v.src.startsWith('http')) return v.src;
                        const s = v.querySelector('source[src]');
                        if (s?.src?.startsWith('http')) return s.src;
                    }
                    // Script inline
                    const patterns = [
                        /MDCore\.wurl\s*=\s*["']([^"']+)["']/,
                        /wurl\s*[=:]\s*["']([^"']+)["']/,
                        /file\s*:\s*["'](https?:[^"']+\.mp4[^"']*)["']/i,
                        /file\s*:\s*["'](https?:[^"']+\.m3u8[^"']*)["']/i,
                        /"(https?:\/\/[^"]{15,}\.mp4[^"]*)"/,
                        /'(https?:\/\/[^']{15,}\.mp4[^']*)'/,
                        /"(https?:\/\/[^"]{15,}\.m3u8[^"]*)"/,
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
                console.log('[v3] ✅ VIDEO TROVATO (HTML):', videoUrl);
                clearTimeout(globalTimeout);
                if (!resolved) {
                    resolved = true;
                    res.json({ success: true, video_url: videoUrl, source: url });
                    setImmediate(() => browser.close().catch(() => {}));
                }
                return;
            }
        }

        // Premi Play se ancora non trovato
        if (!videoUrl && !resolved) {
            console.log('[v3] Provo Play...');
            const selectors = [
                '.jw-icon-display', '.vjs-big-play-button', '[aria-label="Play"]',
                '.plyr__control--overlaid', '.jwplayer .jw-display-icon-container',
            ];
            for (const sel of selectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) { await btn.click(); console.log('[v3] Cliccato:', sel); await sleep(3000); break; }
                } catch(e) {}
            }
        }

        // Se dopo tutto non abbiamo trovato niente, il globalTimeout gestirà la risposta
        
    } catch (error) {
        console.error('[v3] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v3 porta ${PORT}`));
