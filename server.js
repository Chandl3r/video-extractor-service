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
    res.json({ status: 'ok', service: 'Video Extractor v9' });
});

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart',
                    'adexchangeclear','flushpersist','usrpubtrk'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (u.includes('.js') || u.includes('.css') || u.includes('.png') ||
        u.includes('.jpg') || u.includes('.gif') || u.includes('.ico') ||
        u.includes('.woff') || u.includes('analytics') || u.includes('recaptcha') ||
        u.includes('adsco') || u.includes('adexchange')) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

async function checkForVideo(page) {
    try {
        return await page.evaluate(() => {
            for (const v of document.querySelectorAll('video')) {
                if (v.src?.startsWith('http')) return v.src;
                const s = v.querySelector('source[src]');
                if (s?.src?.startsWith('http')) return s.src;
            }
            try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
            try {
                if (window.jwplayer) {
                    const p = window.jwplayer().getPlaylist?.();
                    if (p?.[0]?.file) return p[0].file;
                    if (p?.[0]?.sources?.[0]?.file) return p[0].sources[0].file;
                }
            } catch(e) {}
            try {
                if (window.videojs?.players) {
                    for (const p of Object.values(window.videojs.players)) {
                        const s = p.currentSrc?.();
                        if (s?.startsWith('http')) return s;
                    }
                }
            } catch(e) {}
            const html = document.documentElement.innerHTML;
            const patterns = [
                /MDCore\.wurl\s*=\s*["']([^"']{10,})["']/,
                /wurl\s*[=:]\s*["']([^"']{10,})["']/,
                /"file"\s*:\s*"(https?:[^"]{10,}\.(?:mp4|m3u8)[^"]*)"/,
                /"(https?:\/\/[^"]{15,}\.mp4[^"]{0,50})"/,
                /"(https?:\/\/[^"]{15,}\.m3u8[^"]{0,50})"/,
            ];
            for (const p of patterns) {
                const m = html.match(p);
                if (m?.[1]) return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
            }
            return null;
        });
    } catch(e) { return null; }
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v9] Estrazione:', url);
    let browser = null;
    let resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 58000);

    try {
        browser = await puppeteer.launch({
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox',
                   '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
                   '--no-zygote', '--single-process', '--mute-audio'],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();

        function resolveVideo(vUrl, src) {
            if (!resolved) {
                resolved = true;
                console.log(`[v9] ✅ VIDEO (${src}):`, vUrl);
                clearTimeout(globalTimeout);
                res.json({ success: true, video_url: vUrl });
                setImmediate(() => browser.close().catch(() => {}));
            }
        }

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (BLOCK_URLS.some(b => req.url().includes(b))) return req.abort();
            if (!resolved && looksLikeVideo(req.url())) {
                resolveVideo(req.url(), 'network');
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
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
            console.log('[v9] goto:', e.message.substring(0, 60));
        });

        await sleep(2000);
        if (resolved) return;

        // Mixdrop richiede MOLTI click per superare gli ad overlay
        // Simuliamo 10 click in posizioni diverse con pause realistiche
        console.log('[v9] Simulazione click multipli (stile umano)...');

        // Posizioni di click diverse per simulare comportamento reale
        const clickPositions = [
            { x: 640, y: 360 },  // centro
            { x: 640, y: 360 },  // centro ancora
            { x: 635, y: 355 },  // leggermente spostato
            { x: 645, y: 365 },
            { x: 640, y: 360 },
            { x: 638, y: 358 },
            { x: 642, y: 362 },
            { x: 640, y: 360 },
            { x: 640, y: 360 },
            { x: 640, y: 360 },
        ];

        for (let i = 0; i < clickPositions.length; i++) {
            if (resolved) break;
            
            const pos = clickPositions[i];
            
            // Muovi il mouse alla posizione
            await page.mouse.move(pos.x, pos.y, { steps: 5 });
            await sleep(150 + Math.random() * 200);
            await page.mouse.click(pos.x, pos.y);
            
            console.log(`[v9] Click ${i+1}/10 su (${pos.x},${pos.y})`);
            
            // Attendi un po' tra i click (come farebbe un umano)
            await sleep(800 + Math.random() * 500);
            
            // Controlla se il video è apparso
            const v = await checkForVideo(page);
            if (v && !resolved) {
                resolveVideo(v, `click-${i+1}`);
                return;
            }

            // Ogni 3 click, prova anche i selettori del player
            if (i % 3 === 2) {
                const playSelectors = [
                    '.jw-icon-display', '.jw-display-icon-container',
                    '.vjs-big-play-button', '[aria-label="Play"]',
                    '.plyr__control--overlaid',
                ];
                for (const sel of playSelectors) {
                    try {
                        const el = await page.$(sel);
                        if (el) {
                            const box = await el.boundingBox();
                            if (box) {
                                await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
                                console.log('[v9] Click selettore:', sel);
                                await sleep(1000);
                                const v2 = await checkForVideo(page);
                                if (v2 && !resolved) { resolveVideo(v2, 'selector-' + sel); return; }
                            }
                        }
                    } catch(e) {}
                }
            }
        }

        // Polling finale
        console.log('[v9] Polling finale...');
        for (let i = 0; i < 8; i++) {
            if (resolved) break;
            await sleep(2000);
            const v = await checkForVideo(page);
            if (v && !resolved) { resolveVideo(v, `final-poll-${i}`); return; }
            console.log(`[v9] Final poll ${i+1}/8`);
        }

    } catch (error) {
        console.error('[v9] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v9 porta ${PORT}`));
