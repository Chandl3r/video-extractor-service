const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

try { execSync('pkill -f "chromium|chrome" 2>/dev/null || true', { timeout: 3000 }); } catch(e) {}
process.on('unhandledRejection', (r) => console.error('[v103] unhandledRejection:', r?.message || r));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v103' }));

let session = null;
let proxyChain = Promise.resolve();

function closeSession() {
    if (session) {
        console.log('[v103] Chiudo sessione');
        if (session.browser) session.browser.close().catch(() => {});
        session = null;
        proxyChain = Promise.resolve();
    }
}

setInterval(() => {
    if (session && Date.now() - session.ts > 15 * 60 * 1000) closeSession();
}, 60000);

function withProxyLock(fn) {
    const result = proxyChain.then(() => fn());
    proxyChain = result.catch(() => {});
    return result;
}

const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','facebook.net',
                    'adexchangeclear','inadsexchange','protrafficinspector',
                    'dogcollarfavourbluff','preferencenail','realizationnewest',
                    'inklinkor','weirdopt','displayvertising','oyo4d.com',
                    'rtmark.net','mdstats.info','lastingillipe','fjhvwqjimr',
                    'jnbhi.com','dcbogyqtfxolp','creative-sb1','show-creative1'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','recaptcha'].some(x=>u.includes(x))) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

async function launchBrowser() {
    return puppeteer.launch({
        args: [...chromium.args,
               '--no-sandbox', '--disable-setuid-sandbox',
               '--disable-dev-shm-usage', '--disable-gpu',
               '--no-first-run', '--no-zygote', '--single-process',
               '--mute-audio', '--disable-blink-features=AutomationControlled',
               '--disable-web-security', '--allow-running-insecure-content'],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    if (session && session.embedUrl === url) {
        session.ts = Date.now();
        console.log('[v103] Cache hit:', session.videoUrl.substring(0, 60));
        return res.json({ success: true, video_url: session.videoUrl });
    }

    closeSession();
    console.log('[v103] ESTRAZIONE:', url);
    let browser = null, page = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        console.log('[v103] TIMEOUT');
        if (!resolved) {
            resolved = true;
            if (page) page.close().catch(() => {});
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 120000);

    try {
        browser = await launchBrowser();
        page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        let interceptorDone = false;
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (interceptorDone) { try { request.continue(); } catch(e) {} return; }
            const u = request.url();
            if (BLOCK_URLS.some(b => u.includes(b))) { try { request.abort(); } catch(e) {} return; }
            if (looksLikeVideo(u)) {
                console.log('[v103] Video:', u.substring(0, 80));
                interceptorDone = true;
                try { request.abort(); } catch(e) {}
                if (!resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 })
                        .then(async () => {
                            try {
                                const cdp = await page.target().createCDPSession();
                                await cdp.send('Fetch.enable', {
                                    patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
                                });
                                console.log('[v103] ✅ CDP pronto');
                                session = { embedUrl: url, videoUrl: u, browser, page, cdp, ts: Date.now() };
                                res.json({ success: true, video_url: u });
                                console.log('[v103] → Risposta inviata, session salvata');
                            } catch(e) {
                                console.error('[v103] CDP err:', e.message);
                                if (browser) browser.close().catch(() => {});
                                res.json({ success: false, message: 'CDP err' });
                            }
                        })
                        .catch(() => {
                            setTimeout(async () => {
                                try {
                                    const cdp = await page.target().createCDPSession();
                                    await cdp.send('Fetch.enable', {
                                        patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }]
                                    });
                                    session = { embedUrl: url, videoUrl: u, browser, page, cdp, ts: Date.now() };
                                    res.json({ success: true, video_url: u });
                                    console.log('[v103] → Risposta inviata (fallback)');
                                } catch(e) {
                                    if (browser) browser.close().catch(() => {});
                                    res.json({ success: false, message: 'CDP err fallback' });
                                }
                            }, 1000);
                        });
                }
                return;
            }
            try { request.continue(); } catch(e) {}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
            .catch(e => console.log('[v103] goto:', e.message.substring(0, 60)));

        for (let w = 0; w < 10 && !resolved; w++) {
            await sleep(500);
            const q = await page.evaluate(() => {
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1] || null;
            }).catch(() => null);
            if (q && !resolved) {
                resolved = true; clearTimeout(globalTimeout);
                try {
                    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
                    const cdp = await page.target().createCDPSession();
                    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }] });
                    session = { embedUrl: url, videoUrl: q, browser, page, cdp, ts: Date.now() };
                    res.json({ success: true, video_url: q });
                    console.log('[v103] → Risposta inviata (poll loop)');
                } catch(e) {
                    if (browser) browser.close().catch(() => {});
                    res.json({ success: false, message: 'CDP err: ' + e.message });
                }
                return;
            }
        }
        if (resolved) return;

        for (let i = 0; i < 25 && !resolved; i++) {
            await page.mouse.click(640+(Math.random()*40-20), 360+(Math.random()*40-20)).catch(() => {});
            await sleep(800);
            if ((i+1) % 3 === 0) {
                const v = await page.evaluate(() => {
                    try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                    const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                    return m?.[1] || null;
                }).catch(() => null);
                if (v && !resolved) {
                    resolved = true; clearTimeout(globalTimeout);
                    try {
                        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
                        const cdp = await page.target().createCDPSession();
                        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*mxcontent.net*', requestStage: 'Response' }] });
                        session = { embedUrl: url, videoUrl: v, browser, page, cdp, ts: Date.now() };
                        res.json({ success: true, video_url: v });
                        console.log('[v103] → Risposta inviata (click loop)');
                    } catch(e) {
                        if (browser) browser.close().catch(() => {});
                        res.json({ success: false, message: 'CDP err: ' + e.message });
                    }
                    return;
                }
                console.log(`[v103] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v103] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (page) page.close().catch(() => {});
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(() => {});
            res.json({ success: false, message: 'Errore: ' + e.message });
        }
    }
});

app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const rangeHeader = req.headers['range'];
    const ok = session && session.videoUrl;
    console.log(`[proxy] Range:${rangeHeader||'no'} | session:${ok?'sì':'NO'} | ${videoUrl.substring(0,50)}`);
    if (!ok) return res.status(503).send('Sessione scaduta, ricarica');

    const CHUNK = 512 * 1024;
    let start = 0, end = CHUNK - 1;
    if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (m) { start = parseInt(m[1]); end = m[2] ? Math.min(parseInt(m[2]), start+CHUNK-1) : start+CHUNK-1; }
    }
    const rangeStr = `bytes=${start}-${end}`;

    try {
        // Richiesta HTTP diretta da Node.js: stesso IP di Chrome su Render
        // → token mxcontent.net valido, zero CDP overhead, zero connection limits
        console.log(`[proxy] HTTP diretto: ${rangeStr}`);
        const https = require('https');
        const urlObj = new URL(videoUrl);
        
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'Range': rangeStr,
                'Referer': embedSrc || 'https://mixdrop.vip/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Origin': 'https://mixdrop.vip',
            }
        };

        await new Promise((resolve, reject) => {
            const httpReq = https.request(options, (httpRes) => {
                const status = httpRes.statusCode;
                const ct = httpRes.headers['content-type'] || 'video/mp4';
                const cr = httpRes.headers['content-range'] || '';
                const cl = httpRes.headers['content-length'] || '';
                
                console.log(`[proxy] ✅ ${status} | ${ct} | ${cl}b`);
                
                if (status >= 400) {
                    httpRes.resume();
                    reject(new Error(`HTTP ${status}`));
                    return;
                }

                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Type', ct);
                if (cl) res.setHeader('Content-Length', cl);
                if (cr) res.setHeader('Content-Range', cr);
                res.status(status === 206 ? 206 : 200);

                let total = 0;
                httpRes.on('data', (chunk) => { total += chunk.length; res.write(chunk); });
                httpRes.on('end', () => {
                    res.end();
                    console.log(`[proxy] ✅ Completato: ${total}b`);
                    if (session) session.ts = Date.now();
                    resolve();
                });
                httpRes.on('error', reject);
            });
            httpReq.on('error', reject);
            httpReq.setTimeout(30000, () => { httpReq.destroy(); reject(new Error('HTTP timeout')); });
            httpReq.end();
        });
    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Extractor v103 porta ${PORT}`));
