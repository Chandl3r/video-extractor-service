const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// NO puppeteer-extra, NO stealth plugin - troppo pesanti per 512MB RAM

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
    res.json({ status: 'ok', service: 'Video Extractor v12' });
});

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart',
                    'adexchangeclear','flushpersist','usrpubtrk',
                    'facebook.net','hotjar','intercom'];

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
            // 1. Tag video
            for (const v of document.querySelectorAll('video')) {
                if (v.src?.startsWith('http')) return v.src;
                const s = v.querySelector('source[src]');
                if (s?.src?.startsWith('http')) return s.src;
            }
            // 2. MDCore.wurl (Mixdrop)
            try {
                if (window.MDCore?.wurl) {
                    const u = window.MDCore.wurl;
                    return u.startsWith('//') ? 'https:' + u : u;
                }
            } catch(e) {}
            // 3. JWPlayer
            try {
                if (window.jwplayer) {
                    const p = window.jwplayer().getPlaylist?.();
                    if (p?.[0]?.file) return p[0].file;
                    if (p?.[0]?.sources?.[0]?.file) return p[0].sources[0].file;
                }
            } catch(e) {}
            // 4. Pattern HTML
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

// Controlla video in tutti i frames/iframes
async function checkAllFrames(page) {
    const main = await checkForVideo(page);
    if (main) return main;

    const frames = page.frames();
    for (const frame of frames) {
        try {
            if (frame === page.mainFrame()) continue;
            const url = frame.url();
            if (!url || url === 'about:blank') continue;

            const result = await frame.evaluate(() => {
                for (const v of document.querySelectorAll('video')) {
                    if (v.src?.startsWith('http')) return v.src;
                    const s = v.querySelector('source[src]');
                    if (s?.src?.startsWith('http')) return s.src;
                }
                try {
                    if (window.MDCore?.wurl) {
                        const u = window.MDCore.wurl;
                        return u.startsWith('//') ? 'https:' + u : u;
                    }
                } catch(e) {}
                try {
                    if (window.jwplayer) {
                        const p = window.jwplayer().getPlaylist?.();
                        if (p?.[0]?.file) return p[0].file;
                    }
                } catch(e) {}
                const html = document.documentElement.innerHTML;
                const m = html.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,50})"/);
                return m?.[1] || null;
            }).catch(() => null);

            if (result) return result;
        } catch(e) {}
    }
    return null;
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v12] Estrazione:', url);
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
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--mute-audio',
                '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();

        // Evasioni anti-bot leggere (senza plugin stealth)
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
        });

        function resolveVideo(vUrl, src) {
            if (!resolved) {
                resolved = true;
                console.log(`[v12] ✅ VIDEO (${src}):`, vUrl);
                clearTimeout(globalTimeout);
                res.json({ success: true, video_url: vUrl });
                setImmediate(() => browser.close().catch(() => {}));
            }
        }

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const u = req.url();
            if (BLOCK_URLS.some(b => u.includes(b))) return req.abort();
            // Blocca media direttamente (risparmia RAM)
            if (req.resourceType() === 'media') return req.abort();
            if (!resolved && looksLikeVideo(u)) {
                resolveVideo(u, 'network');
                try { req.abort(); } catch(e) {}
                return;
            }
            try { req.continue(); } catch(e) {}
        });

        page.on('response', (r) => {
            if (resolved) return;
            const ct = r.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('mpegurl')) {
                resolveVideo(r.url(), 'response-header');
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v12] goto:', e.message.substring(0, 60)));

        await sleep(2500);
        if (resolved) return;

        // Controlla subito
        let v = await checkAllFrames(page);
        if (v && !resolved) { resolveVideo(v, 'initial-check'); return; }

        // Log struttura frames per debug
        const frameUrls = page.frames().map(f => f.url().substring(0, 80));
        console.log('[v12] Frames:', JSON.stringify(frameUrls));

        // Click multipli - fino a 18 volte (copre il caso peggiore Mixdrop)
        console.log('[v12] Click multipli...');
        for (let i = 0; i < 18 && !resolved; i++) {
            const x = 640 + (Math.random() * 20 - 10);
            const y = 360 + (Math.random() * 20 - 10);
            await page.mouse.move(x, y, { steps: 3 });
            await sleep(100);
            await page.mouse.click(x, y);

            await sleep(900);
            v = await checkAllFrames(page);
            if (v && !resolved) { resolveVideo(v, `click-${i+1}`); return; }

            // Ogni 3 click, prova anche dentro i frames
            if (i % 3 === 2) {
                for (const frame of page.frames()) {
                    try {
                        const playBtn = await frame.$('.jw-icon-display, .vjs-big-play-button, [aria-label="Play"]');
                        if (playBtn) {
                            await playBtn.click();
                            console.log(`[v12] Click play in frame: ${frame.url().substring(0, 60)}`);
                            await sleep(1500);
                            v = await checkAllFrames(page);
                            if (v && !resolved) { resolveVideo(v, `frame-play-${i}`); return; }
                        }
                    } catch(e) {}
                }
            }
        }

    } catch (error) {
        console.error('[v12] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v12 porta ${PORT}`));

// ============================================================
// PROXY ENDPOINT: serve il video al browser
// Gestisce correttamente Range requests per lo streaming
// ============================================================
const https = require('https');
const http = require('http');

app.options('/proxy', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.status(200).end();
});

app.get('/proxy', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send('URL mancante');

    console.log('[proxy] Richiesta:', videoUrl.substring(0, 80), '| Range:', req.headers['range'] || 'nessuno');

    let parsed;
    try { parsed = new URL(videoUrl); } catch(e) {
        return res.status(400).send('URL non valido');
    }

    const protocol = parsed.protocol === 'https:' ? https : http;

    // Costruisci headers per la richiesta upstream
    const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://mixdrop.vip/',
        'Origin': 'https://mixdrop.vip',
        'Accept': '*/*',
        'Accept-Language': 'it-IT,it;q=0.9',
        'Connection': 'keep-alive',
    };

    // Passa Range header se presente (essenziale per video seeking)
    if (req.headers['range']) {
        upstreamHeaders['Range'] = req.headers['range'];
    }

    const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: upstreamHeaders,
        timeout: 30000,
    };

    const proxyReq = protocol.request(options, (proxyRes) => {
        console.log('[proxy] Risposta upstream:', proxyRes.statusCode, 
                    '| Content-Type:', proxyRes.headers['content-type'],
                    '| Content-Length:', proxyRes.headers['content-length']);

        // Headers CORS obbligatori
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

        // Propaga tutti gli header importanti
        const headersToPass = [
            'content-type', 'content-length', 'content-range',
            'accept-ranges', 'last-modified', 'etag', 'cache-control'
        ];
        headersToPass.forEach(h => {
            if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
        });

        // Assicura Accept-Ranges per il seeking
        res.setHeader('Accept-Ranges', 'bytes');

        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res, { end: true });

        proxyRes.on('error', (err) => {
            console.error('[proxy] Stream error:', err.message);
        });
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).send('Gateway timeout');
    });

    proxyReq.on('error', (err) => {
        console.error('[proxy] Errore richiesta:', err.message);
        if (!res.headersSent) res.status(502).send('Errore proxy: ' + err.message);
    });

    // Gestisci disconnessione del client
    req.on('close', () => proxyReq.destroy());

    proxyReq.end();
});

// ============================================================
// FETCH-PAGE: scarica una pagina e la restituisce come testo
// Usato da video-bridge.php quando Altervista blocca le connessioni
// ============================================================
app.get('/fetch-page', async (req, res) => {
    const pageUrl = req.query.url;
    if (!pageUrl) return res.status(400).send('URL mancante');

    console.log('[fetch-page] Richiesta:', pageUrl.substring(0, 80));
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const parsed = new URL(pageUrl);
        const protocol = parsed.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'it-IT,it;q=0.9',
                'Referer': 'https://mixdrop.vip/',
            },
            timeout: 15000,
        };

        const proxyReq = protocol.request(options, (proxyRes) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.status(proxyRes.statusCode);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            console.error('[fetch-page] Errore:', e.message);
            res.status(502).send('');
        });
        proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).send(''); });
        proxyReq.end();
    } catch(e) {
        res.status(500).send('');
    }
});
