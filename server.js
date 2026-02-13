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
    res.json({ status: 'ok', service: 'Video Extractor v11-iframe' });
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

// Controlla video in tutti gli iframe della pagina
async function checkAllFrames(page) {
    try {
        // Prima controlla la pagina principale
        const main = await checkForVideo(page);
        if (main) return { url: main, frame: 'main' };

        // Poi controlla ogni iframe
        const frames = page.frames();
        console.log(`[v11] Frames trovati: ${frames.length}`);
        
        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            try {
                const frameUrl = frame.url();
                console.log(`[v11] Frame ${i}: ${frameUrl.substring(0, 80)}`);
                
                const result = await frame.evaluate(() => {
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
                    ];
                    for (const p of patterns) {
                        const m = html.match(p);
                        if (m?.[1]) return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
                    }
                    return null;
                });
                
                if (result) return { url: result, frame: `frame-${i}` };

                // Prova a cliccare play dentro questo frame
                try {
                    const playSelectors = [
                        '.jw-icon-display', '.jw-display-icon-container',
                        '.vjs-big-play-button', '[aria-label="Play"]',
                        '.plyr__control--overlaid', 'button[class*="play"]',
                    ];
                    for (const sel of playSelectors) {
                        const el = await frame.$(sel);
                        if (el) {
                            console.log(`[v11] Play in frame ${i}: ${sel}`);
                            await el.click();
                            return { clicked: true, frame: `frame-${i}`, selector: sel };
                        }
                    }
                } catch(e) {}
                
            } catch(e) {
                // Frame cross-origin - non accessibile ma intercettiamo le richieste
            }
        }
        return null;
    } catch(e) { 
        console.log('[v11] checkAllFrames error:', e.message);
        return null; 
    }
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v11] Estrazione:', url);
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
                console.log(`[v11] ✅ VIDEO (${src}):`, vUrl);
                clearTimeout(globalTimeout);
                res.json({ success: true, video_url: vUrl });
                setImmediate(() => browser.close().catch(() => {}));
            }
        }

        // Intercetta richieste video da QUALSIASI frame/iframe
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
            console.log('[v11] goto:', e.message.substring(0, 60));
        });

        await sleep(3000);
        if (resolved) return;

        // Analisi struttura iframe
        console.log('[v11] Analisi struttura pagina...');
        let result = await checkAllFrames(page);
        
        if (result?.url && !resolved) {
            resolveVideo(result.url, result.frame);
            return;
        }

        // Se ha cliccato un play, aspetta e ricontrolla
        if (result?.clicked) {
            await sleep(3000);
            result = await checkAllFrames(page);
            if (result?.url && !resolved) {
                resolveVideo(result.url, result.frame + '-after-play');
                return;
            }
        }

        // Click multipli sul centro + ricontrollo frames
        console.log('[v11] Click multipli con controllo frames...');
        for (let i = 0; i < 15 && !resolved; i++) {
            // Click con piccola variazione casuale
            const x = 640 + (Math.random() * 30 - 15);
            const y = 360 + (Math.random() * 30 - 15);
            await page.mouse.move(x, y, { steps: 3 });
            await page.mouse.click(x, y);
            
            await sleep(1200);
            
            result = await checkAllFrames(page);
            if (result?.url && !resolved) {
                resolveVideo(result.url, `click-${i+1}-${result.frame}`);
                return;
            }
            console.log(`[v11] Click ${i+1}/15 - nessun video`);
        }

    } catch (error) {
        console.error('[v11] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v11-iframe porta ${PORT}`));
