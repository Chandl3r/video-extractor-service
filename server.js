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
    res.json({ status: 'ok', service: 'Video Extractor v7' });
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

function findVideoInText(text) {
    const patterns = [
        /MDCore\.wurl\s*=\s*["']([^"']+)["']/,
        /wurl\s*[=:]\s*["']([^"']+)["']/,
        /file\s*:\s*["'](https?:[^"']+\.mp4[^"']*)["']/i,
        /file\s*:\s*["'](https?:[^"']+\.m3u8[^"']*)["']/i,
        /"(https?:\/\/[^"]{15,}\.mp4[^"]*)"/,
        /"(https?:\/\/[^"]{15,}\.m3u8[^"]*)"/,
        /src\s*:\s*["'](https?:[^"']+\.mp4[^"']*)["']/i,
        /source\s*:\s*["'](https?:[^"']+\.mp4[^"']*)["']/i,
        /videoUrl\s*[=:]\s*["'](https?:[^"']+)["']/i,
        /["'](https?:\/\/[^"']{10,}\/[^"']*(?:video|stream|hls|media)[^"']*\.(?:mp4|m3u8)[^"']*)["']/i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) {
            const u = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
            if (u.startsWith('http')) return u;
        }
    }
    return null;
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    console.log('[v7] Estrazione:', url);
    let browser = null;
    let resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            console.log('[v7] Timeout 55s');
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
        let videoUrl = null;

        function resolveWithVideo(vUrl, source) {
            if (!resolved) {
                resolved = true;
                console.log('[v7] ✅ VIDEO (' + source + '):', vUrl);
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
                resolveWithVideo(reqUrl, 'network');
                try { req.abort(); } catch(e) {}
                return;
            }
            try { req.continue(); } catch(e) {}
        });

        page.on('response', async (response) => {
            if (resolved) return;
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('video/') || ct.includes('mpegurl')) {
                resolveWithVideo(response.url(), 'response-header');
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        });

        page.goto(url, { waitUntil: 'networkidle0', timeout: 50000 }).catch(e => {
            console.log('[v7] goto:', e.message.substring(0, 80));
        });

        // Aspetta più a lungo - gli script di Mixdrop devono finire
        await sleep(6000);

        if (!resolved) {
            console.log('[v7] Cerco video nella pagina...');
            try {
                const result = await page.evaluate((findFn) => {
                    // 1. Tag video diretto
                    for (const v of document.querySelectorAll('video')) {
                        if (v.src?.startsWith('http')) return { found: true, url: v.src, via: 'video_tag' };
                        const s = v.querySelector('source[src]');
                        if (s?.src?.startsWith('http')) return { found: true, url: s.src, via: 'source_tag' };
                    }

                    // 2. Tutti gli script inline
                    const scripts = Array.from(document.querySelectorAll('script:not([src])'));
                    const scriptContents = scripts.map(s => s.textContent).join('\n');
                    
                    // 3. Anche window/global vars
                    let allText = scriptContents;
                    try { allText += JSON.stringify(window.MDCore || {}); } catch(e) {}
                    try { allText += JSON.stringify(window.playerConfig || {}); } catch(e) {}
                    try { allText += JSON.stringify(window.jwplayer ? window.jwplayer().getPlaylist() : {}); } catch(e) {}

                    // Log per debug
                    return {
                        found: false,
                        htmlLength: document.documentElement.innerHTML.length,
                        scripts: scripts.length,
                        scriptLengths: scripts.map(s => s.textContent.length),
                        // Prendi primo script significativo per debug
                        firstScript: scripts.find(s => s.textContent.length > 100)?.textContent.substring(0, 500) || '',
                        hasMDCore: allText.includes('MDCore'),
                        hasWurl: allText.includes('wurl'),
                        hasMP4: allText.includes('.mp4'),
                        hasM3U8: allText.includes('.m3u8'),
                    };
                });

                console.log('[v7] Debug:', JSON.stringify({
                    htmlLength: result.htmlLength,
                    scripts: result.scripts,
                    hasMDCore: result.hasMDCore,
                    hasWurl: result.hasWurl,
                    hasMP4: result.hasMP4,
                    hasM3U8: result.hasM3U8,
                    firstScript: result.firstScript?.substring(0, 200)
                }));

                if (result.found) {
                    resolveWithVideo(result.url, result.via);
                    return;
                }

                // Se ha wurl o mp4 nei dati, proviamo a estrarlo direttamente
                if (result.hasWurl || result.hasMP4 || result.hasM3U8) {
                    console.log('[v7] Trovati indizi video, estraggo...');
                    const videoFound = await page.evaluate(() => {
                        const html = document.documentElement.innerHTML;
                        // Tutti i pattern possibili
                        const patterns = [
                            /MDCore\.wurl\s*=\s*["']([^"']+)["']/,
                            /wurl["']?\s*[=:]\s*["']([^"']{10,})["']/,
                            /"file"\s*:\s*"(https?:[^"]{10,}\.mp4[^"]*)"/,
                            /'file'\s*:\s*'(https?:[^']{10,}\.mp4[^']*)'/,
                            /"(https?:\/\/[^"]{10,}\.mp4[^"]*)"/g,
                            /'(https:\/\/[^']{10,}\.mp4[^']*)'/,
                        ];
                        for (const p of patterns) {
                            const m = html.match(p);
                            if (m?.[1]) return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
                        }
                        return null;
                    });
                    if (videoFound) {
                        resolveWithVideo(videoFound, 'html-deep');
                        return;
                    }
                }
            } catch(e) { console.log('[v7] eval error:', e.message); }
        }

        // Premi Play e aspetta
        if (!resolved) {
            console.log('[v7] Provo Play...');
            const selectors = [
                '.jw-icon-display', '.vjs-big-play-button', '[aria-label="Play"]',
                '.plyr__control--overlaid', '.jwplayer .jw-display-icon-container',
                'button[class*="play"]', '.play', '#play', 'video',
            ];
            for (const sel of selectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) {
                        await btn.click();
                        console.log('[v7] Click:', sel);
                        await sleep(5000);
                        break;
                    }
                } catch(e) {}
            }
            try { await page.mouse.click(640, 360); await sleep(3000); } catch(e) {}
        }

    } catch (error) {
        console.error('[v7] Errore:', error.message);
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
app.listen(PORT, () => console.log(`Video Extractor v7 porta ${PORT}`));
