const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v18' }));

// Cache: embedUrl → { videoUrl, cdpClient, networkRequestId, ts }
const sessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) {
        if (now - s.ts > 10*60*1000) {
            if (s.browser) s.browser.close().catch(()=>{});
            sessions.delete(k);
        }
    }
}, 60000);

const VIDEO_EXTS = ['.mp4','.m3u8','.webm','.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart','usrpubtrk',
                    'adexchangeclear','facebook.net'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','recaptcha','adsco'].some(x=>u.includes(x))) return false;
    return VIDEO_EXTS.some(e=>u.includes(e));
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    if (sessions.has(url)) {
        const s = sessions.get(url);
        console.log('[v18] Riuso sessione:', s.videoUrl.substring(0,60));
        return res.json({ success: true, video_url: s.videoUrl });
    }

    console.log('[v18] ESTRAZIONE:', url);
    let browser = null, resolved = false;

    const globalTimeout = setTimeout(() => {
        if (!resolved) {
            resolved = true;
            if (browser) browser.close().catch(()=>{});
            res.json({ success: false, message: 'Timeout' });
        }
    }, 70000);

    try {
        browser = await puppeteer.launch({
            args: [...chromium.args,
                   '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
                   '--disable-gpu','--no-first-run','--no-zygote','--single-process',
                   '--mute-audio','--disable-blink-features=AutomationControlled'],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
            window.chrome={runtime:{}};
            Object.defineProperty(navigator,'languages',{get:()=>['it-IT','it','en-US']});
        });

        // Apri sessione CDP per intercettare richieste a livello di rete
        const cdpClient = await page.target().createCDPSession();

        // Usa Fetch domain per intercettare richieste video SENZA abortirle
        // Questo ci permette di raccogliere l'URL E lasciare che Chrome faccia la richiesta
        await cdpClient.send('Fetch.enable', {
            patterns: [{ urlPattern: '*.mp4*', requestStage: 'Request' },
                       { urlPattern: '*.m3u8*', requestStage: 'Request' }]
        });

        let capturedRequestId = null;
        let capturedVideoUrl = null;

        cdpClient.on('Fetch.requestPaused', async (event) => {
            const u = event.request.url;
            if (looksLikeVideo(u) && !resolved) {
                console.log('[v18] CDP Fetch intercettato:', u.substring(0,80));
                capturedRequestId = event.requestId;
                capturedVideoUrl = u;
                // Lascia continuare la richiesta (NON abortire!)
                await cdpClient.send('Fetch.continueRequest', { requestId: event.requestId }).catch(()=>{});
                resolveVideo(u, capturedRequestId, 'cdp-fetch');
            } else {
                await cdpClient.send('Fetch.continueRequest', { requestId: event.requestId }).catch(()=>{});
            }
        });

        // Intercetta anche resourceType media tramite request interception normale
        // come backup per URL che non matchano i pattern
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const u = request.url();
            if (BLOCK_URLS.some(b=>u.includes(b))) { try{request.abort();}catch(e){} return; }
            // NON abortire mai video - lasciamo che cdpClient gestisca
            try{request.continue();}catch(e){}
        });

        page.on('response', async (r) => {
            if (resolved) return;
            const u = r.url();
            const ct = r.headers()['content-type']||'';
            if ((ct.includes('video/')||ct.includes('mpegurl')||r.request().resourceType()==='media') && looksLikeVideo(u)) {
                console.log('[v18] Response video:', u.substring(0,80));
                resolveVideo(u, null, 'response');
            }
        });

        function resolveVideo(vUrl, reqId, src) {
            if (resolved) return;
            resolved = true;
            clearTimeout(globalTimeout);
            console.log(`[v18] ✅ VIDEO (${src}):`, vUrl);
            sessions.set(url, { videoUrl: vUrl, browser, page, cdpClient, networkRequestId: reqId, ts: Date.now() });
            res.json({ success: true, video_url: vUrl });
            // Browser rimane aperto per il proxy
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({'Accept-Language':'it-IT,it;q=0.9,en-US;q=0.8'});
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}).catch(e=>console.log('[v18] goto:',e.message.substring(0,60)));

        for (let w=0;w<30&&!resolved;w++) {
            await sleep(500);
            const q = await page.evaluate(()=>{
                try{if(window.MDCore?.wurl){const u=window.MDCore.wurl;return u.startsWith('//')?'https:'+u:u;}}catch(e){}
                try{if(window.jwplayer){const p=window.jwplayer().getPlaylist?.();if(p?.[0]?.file)return p[0].file;}}catch(e){}
                const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if (q&&!resolved){resolveVideo(q,null,`poll-${w}`);return;}
        }
        if (resolved) return;

        for (let i=0;i<15&&!resolved;i++) {
            await page.mouse.click(640+(Math.random()*40-20),360+(Math.random()*40-20)).catch(()=>{});
            await sleep(800);
            if ((i+1)%3===0) {
                const v=await page.evaluate(()=>{
                    try{if(window.MDCore?.wurl){const u=window.MDCore.wurl;return u.startsWith('//')?'https:'+u:u;}}catch(e){}
                    const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                    return m?.[1]||null;
                }).catch(()=>null);
                if (v&&!resolved){resolveVideo(v,null,`click-${i+1}`);return;}
                console.log(`[v18] Click ${i+1}: niente`);
            }
        }

    } catch(e) {
        console.error('[v18] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved=true;
            if(browser)browser.close().catch(()=>{});
            res.json({success:false,message:'Errore: '+e.message});
        }
    }
});

// ============================================================
// PROXY: streaming in chunk da 1MB usando Chrome (TLS corretto)
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const session = embedSrc ? sessions.get(embedSrc) : null;
    const rangeHeader = req.headers['range'];
    console.log(`[proxy] ${videoUrl.substring(0,70)} | Range: ${rangeHeader||'nessuno'} | Session: ${session?'sì':'no'}`);

    if (!session || !session.page) {
        return res.status(503).json({ error: 'Sessione scaduta, ricarica la pagina' });
    }

    try {
        const { page } = session;

        // Calcola il range richiesto (default: 0-1MB)
        let rangeStart = 0, rangeEnd = 1024 * 1024 - 1; // 1MB
        if (rangeHeader) {
            const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (m) {
                rangeStart = parseInt(m[1]);
                rangeEnd = m[2] ? parseInt(m[2]) : rangeStart + 1024*1024 - 1;
            }
        }

        console.log(`[proxy] Fetch Chrome range: ${rangeStart}-${rangeEnd}`);

        // Fetch in Chrome con range specifico - chunk piccolo = no timeout
        const result = await Promise.race([
            page.evaluate(async (opts) => {
                try {
                    const r = await fetch(opts.url, {
                        headers: { 'Range': `bytes=${opts.start}-${opts.end}` },
                        credentials: 'include',
                    });
                    const status = r.status;
                    const ct = r.headers.get('content-type') || 'video/mp4';
                    const cr = r.headers.get('content-range') || '';
                    const cl = r.headers.get('content-length') || '';
                    const ab = await r.arrayBuffer();
                    const bytes = new Uint8Array(ab);
                    // Converti a base64 in chunk per evitare stack overflow
                    let binary = '';
                    const chunkSz = 8192;
                    for (let i = 0; i < bytes.length; i += chunkSz) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i+chunkSz, bytes.length)));
                    }
                    return { ok: true, status, ct, cr, cl, b64: btoa(binary), len: bytes.length };
                } catch(e) {
                    return { ok: false, error: e.message };
                }
            }, { url: videoUrl, start: rangeStart, end: rangeEnd }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 25s')), 25000))
        ]);

        if (!result.ok) {
            console.error('[proxy] Chrome fetch error:', result.error);
            return res.status(502).send('Errore fetch: ' + result.error);
        }

        console.log(`[proxy] Chrome fetch OK: ${result.status} | ${result.len} bytes | ${result.ct}`);

        const buf = Buffer.from(result.b64, 'base64');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', result.ct || 'video/mp4');
        res.setHeader('Content-Length', buf.length);
        if (result.cr) res.setHeader('Content-Range', result.cr);
        res.status(result.status === 206 ? 206 : 200).send(buf);

        session.ts = Date.now();

    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if (!res.headersSent) res.status(500).send('Errore: ' + e.message);
    }
});


function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Video Extractor v18 porta ${PORT}`));
