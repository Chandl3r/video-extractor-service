const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

const BLOCKED_TYPES = ['image', 'font', 'stylesheet'];
const BLOCKED_URLS = ['google-analytics', 'googletagmanager', 'facebook.net', 'doubleclick', 'googlesyndication'];
const VIDEO_EXTENSIONS = ['.mp4', '.m3u8', '.webm', '.ts'];
const VIDEO_PATTERNS = ['/hls/', '/dash/', '/manifest', 'video/mp4'];

function isVideoRequest(url) {
    const lower = url.toLowerCase();
    if (lower.includes('.js') || lower.includes('.css') || lower.includes('.png') ||
        lower.includes('.jpg') || lower.includes('.gif') || lower.includes('.woff') ||
        lower.includes('analytics') || lower.includes('tracking')) return false;
    return VIDEO_EXTENSIONS.some(e => lower.includes(e)) ||
           VIDEO_PATTERNS.some(p => lower.includes(p));
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Video Extractor v2' });
});

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[Extractor] Estrazione da:', url);
    let browser = null;

    try {
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--disable-gpu', '--disable-extensions', '--mute-audio',
            ],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        let videoUrl = null;

        await page.setRequestInterception(true);
        
        page.on('request', (req) => {
            if (BLOCKED_TYPES.includes(req.resourceType())) return req.abort();
            if (BLOCKED_URLS.some(b => req.url().includes(b))) return req.abort();
            if (!videoUrl && isVideoRequest(req.url())) {
                videoUrl = req.url();
                console.log('[Extractor] Video nelle richieste:', videoUrl);
            }
            req.continue();
        });

        page.on('response', async (response) => {
            if (videoUrl) return;
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('video/') || contentType.includes('application/x-mpegurl')) {
                videoUrl = response.url();
                console.log('[Extractor] Video negli header:', videoUrl);
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch(e) {
            console.log('[Extractor] Timeout goto, continuo...');
        }

        await sleep(1500);

        if (!videoUrl) {
            videoUrl = await page.evaluate(() => {
                const videos = document.querySelectorAll('video');
                for (const v of videos) {
                    if (v.src && v.src.startsWith('http')) return v.src;
                    const src = v.querySelector('source[src]');
                    if (src && src.src.startsWith('http')) return src.src;
                }
                const scripts = document.querySelectorAll('script:not([src])');
                const patterns = [
                    /MDCore\.wurl\s*=\s*["']([^"']+)["']/,
                    /wurl\s*[=:]\s*["']([^"']+)["']/,
                    /file\s*:\s*["'](https?:[^"']+\.mp4[^"']*)["']/i,
                    /file\s*:\s*["'](https?:[^"']+\.m3u8[^"']*)["']/i,
                    /videoUrl\s*[=:]\s*["'](https?:[^"']+)["']/i,
                    /hlsUrl\s*[=:]\s*["'](https?:[^"']+\.m3u8[^"']*)["']/i,
                ];
                for (const script of scripts) {
                    const text = script.textContent;
                    for (const p of patterns) {
                        const m = text.match(p);
                        if (m) {
                            const u = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
                            if (u.startsWith('http')) return u;
                        }
                    }
                }
                return null;
            });
        }

        if (!videoUrl) {
            console.log('[Extractor] Provo Play...');
            const playSelectors = [
                '.jw-icon-display', '.vjs-big-play-button', '[aria-label="Play"]',
                '.plyr__control--overlaid', '.jwplayer .jw-display-icon-container',
                'button[class*="play"]', '[class*="play-btn"]',
            ];
            for (const selector of playSelectors) {
                try {
                    const btn = await page.$(selector);
                    if (btn) {
                        await btn.click();
                        console.log('[Extractor] Cliccato:', selector);
                        await sleep(4000);
                        break;
                    }
                } catch(e) {}
            }
            try { await page.click('video'); await sleep(2000); } catch(e) {}

            if (!videoUrl) {
                videoUrl = await page.evaluate(() => {
                    const html = document.documentElement.innerHTML;
                    const m = html.match(/["'](https?:\/\/[^"']{10,}(?:\.mp4|\.m3u8)[^"']*?)["']/);
                    return m ? m[1] : null;
                });
            }
        }

        await browser.close();
        browser = null;

        if (videoUrl) {
            console.log('[Extractor] Successo:', videoUrl);
            return res.json({ success: true, video_url: videoUrl, source: url });
        } else {
            return res.json({ success: false, message: 'Video non trovato nella pagina' });
        }

    } catch (error) {
        console.error('[Extractor] Errore:', error.message);
        if (browser) try { await browser.close(); } catch(e) {}
        return res.json({ success: false, message: 'Errore: ' + error.message });
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v2 sulla porta ${PORT}`));
