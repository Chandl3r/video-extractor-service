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
    res.json({ status: 'ok', service: 'Video Extractor v10' });
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

// Chiudi tutti gli overlay/popup pubblicitari visibili
async function dismissAds(page) {
    try {
        const dismissed = await page.evaluate(() => {
            let count = 0;
            
            // Selettori comuni per chiudere ads/overlay
            const closeSelectors = [
                // Pulsanti chiudi generici
                '[class*="close"]', '[id*="close"]',
                '[class*="dismiss"]', '[id*="dismiss"]',
                '[class*="skip"]', '[id*="skip"]',
                '[aria-label="Close"]', '[aria-label="close"]',
                '[aria-label="Dismiss"]',
                // Overlay/popup
                '[class*="overlay"] [class*="close"]',
                '[class*="popup"] [class*="close"]',
                '[class*="modal"] [class*="close"]',
                '[class*="ad-close"]', '[class*="adClose"]',
                // Iframe overlay (click per chiudere)
                '[class*="ad-container"]', '[class*="adContainer"]',
            ];
            
            for (const sel of closeSelectors) {
                try {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        const style = window.getComputedStyle(el);
                        // Solo elementi visibili
                        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                            el.click();
                            count++;
                        }
                    }
                } catch(e) {}
            }
            
            // Rimuovi overlay con z-index alto (ads)
            const allEls = document.querySelectorAll('*');
            for (const el of allEls) {
                try {
                    const style = window.getComputedStyle(el);
                    const zIndex = parseInt(style.zIndex);
                    const pos = style.position;
                    if (zIndex > 1000 && (pos === 'fixed' || pos === 'absolute')) {
                        const rect = el.getBoundingClientRect();
                        // Se copre buona parte dello schermo
                        if (rect.width > 200 && rect.height > 200) {
                            el.remove();
                            count++;
                        }
                    }
                } catch(e) {}
            }
            
            return count;
        });
        if (dismissed > 0) console.log(`[v10] Rimossi ${dismissed} overlay/ads`);
    } catch(e) {}
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v10] Estrazione:', url);
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
                console.log(`[v10] ✅ VIDEO (${src}):`, vUrl);
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
            console.log('[v10] goto:', e.message.substring(0, 60));
        });

        await sleep(2000);
        if (resolved) return;

        // Controlla subito dopo il caricamento
        let v = await checkForVideo(page);
        if (v && !resolved) { resolveVideo(v, 'initial'); return; }

        // STRATEGIA: dismissAds + click sul vero player, ripetuto molte volte
        console.log('[v10] Strategia: dismiss ads + click player...');

        for (let round = 0; round < 20 && !resolved; round++) {
            // 1. Chiudi ads e overlay
            await dismissAds(page);
            await sleep(300);

            // 2. Trova il player e clicca
            const playerSelectors = [
                '.jw-icon-display',
                '.jw-display-icon-container', 
                '.vjs-big-play-button',
                '[aria-label="Play"]',
                '.plyr__control--overlaid',
                '#player',
                '.player-container',
                'video',
                // Fallback: centro pagina
            ];

            let clicked = false;
            for (const sel of playerSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el) {
                        const box = await el.boundingBox();
                        if (box && box.width > 0 && box.height > 0) {
                            await page.mouse.move(
                                box.x + box.width/2 + (Math.random()*10-5),
                                box.y + box.height/2 + (Math.random()*10-5),
                                { steps: 5 }
                            );
                            await sleep(100);
                            await page.mouse.click(
                                box.x + box.width/2 + (Math.random()*10-5),
                                box.y + box.height/2 + (Math.random()*10-5)
                            );
                            console.log(`[v10] Round ${round+1}: click su "${sel}"`);
                            clicked = true;
                            break;
                        }
                    }
                } catch(e) {}
            }

            // Fallback: click centro
            if (!clicked) {
                await page.mouse.click(640 + (Math.random()*20-10), 360 + (Math.random()*20-10));
                console.log(`[v10] Round ${round+1}: click centro (fallback)`);
            }

            // 3. Attendi e controlla
            await sleep(1000);
            v = await checkForVideo(page);
            if (v && !resolved) { resolveVideo(v, `round-${round+1}`); return; }

            // Pausa variabile tra i round
            await sleep(500 + Math.random() * 500);
        }

        // Polling finale
        console.log('[v10] Polling finale...');
        for (let i = 0; i < 5 && !resolved; i++) {
            await sleep(2000);
            v = await checkForVideo(page);
            if (v && !resolved) { resolveVideo(v, `final-${i}`); return; }
        }

    } catch (error) {
        console.error('[v10] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v10 porta ${PORT}`));
