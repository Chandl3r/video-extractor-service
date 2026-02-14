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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v17' }));

// Cache sessioni: embedUrl → { videoUrl, browser, page, cdpClient, ts }
const sessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) {
        if (now - s.ts > 10*60*1000) {
            console.log('[v17] Pulizia sessione:', k.substring(0,50));
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

// ============================================================
// EXTRACT: trova URL video, mantiene browser aperto per proxy CDP
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });

    // Se abbiamo già una sessione valida per questo embed, riusala
    if (sessions.has(url)) {
        const s = sessions.get(url);
        console.log('[v17] Riuso sessione esistente:', s.videoUrl.substring(0,60));
        return res.json({ success: true, video_url: s.videoUrl });
    }

    console.log('[v17] ESTRAZIONE:', url);
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
            Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
        });

        async function resolveVideo(vUrl, src) {
            if (resolved) return;
            resolved = true;
            clearTimeout(globalTimeout);
            console.log(`[v17] VIDEO (${src}):`, vUrl);

            // Apri sessione CDP sulla pagina per future richieste proxy
            const cdpClient = await page.target().createCDPSession();
            await cdpClient.send('Network.enable');

            sessions.set(url, { videoUrl: vUrl, browser, page, cdpClient, ts: Date.now() });
            res.json({ success: true, video_url: vUrl });
            // Browser rimane aperto per il proxy
        }

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const u = request.url();
            if (BLOCK_URLS.some(b=>u.includes(b))) { try{request.abort();}catch(e){} return; }
            if (request.resourceType()==='media') {
                console.log('[v17] Media:', u.substring(0,80));
                try{request.abort();}catch(e){}
                if (!resolved) resolveVideo(u,'media');
                return;
            }
            if (!resolved && looksLikeVideo(u)) {
                try{request.abort();}catch(e){}
                resolveVideo(u,'network');
                return;
            }
            try{request.continue();}catch(e){}
        });
        page.on('response', (r) => {
            if (resolved) return;
            const ct = r.headers()['content-type']||'';
            if ((ct.includes('video/')||ct.includes('mpegurl'))&&looksLikeVideo(r.url()))
                resolveVideo(r.url(),'response');
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({'Accept-Language':'it-IT,it;q=0.9,en-US;q=0.8'});
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}).catch(e=>console.log('[v17] goto:',e.message.substring(0,60)));

        // Poll rapido ogni 500ms per 15s
        for (let w=0;w<30&&!resolved;w++) {
            await sleep(500);
            const q = await page.evaluate(()=>{
                try{if(window.MDCore?.wurl){const u=window.MDCore.wurl;return u.startsWith('//')?'https:'+u:u;}}catch(e){}
                try{if(window.jwplayer){const p=window.jwplayer().getPlaylist?.();if(p?.[0]?.file)return p[0].file;}}catch(e){}
                const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if (q&&!resolved){resolveVideo(q,`poll-${w}`);return;}
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
                if (v&&!resolved){resolveVideo(v,`click-${i+1}`);return;}
                console.log(`[v17] Click ${i+1}: niente`);
            }
        }

    } catch(e) {
        console.error('[v17] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved=true;
            if(browser)browser.close().catch(()=>{});
            res.json({success:false,message:'Errore: '+e.message});
        }
    }
});

// ============================================================
// PROXY: usa CDP Network.loadNetworkResource (Chrome TLS!)
// Streama il video usando il browser Chrome, non Node.js http
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const session = embedSrc ? sessions.get(embedSrc) : null;
    const rangeHeader = req.headers['range'];

    console.log(`[proxy] URL: ${videoUrl.substring(0,70)}`);
    console.log(`[proxy] Range: ${rangeHeader||'nessuno'}`);
    console.log(`[proxy] Sessione CDP: ${session ? 'sì' : 'no'}`);

    if (!session || !session.cdpClient) {
        console.log('[proxy] Nessuna sessione CDP, fallback Node.js http');
        return proxyFallback(videoUrl, rangeHeader, res, embedSrc);
    }

    try {
        const { cdpClient, page } = session;

        // Usa CDP Network.loadNetworkResource - richiesta fatta da Chrome stesso!
        // Questo usa il TLS fingerprint di Chrome, non di Node.js
        console.log('[proxy] Usando CDP loadNetworkResource...');

        const frameId = page.mainFrame()._id;
        const result = await cdpClient.send('Network.loadNetworkResource', {
            frameId,
            url: videoUrl,
            options: {
                disableCache: false,
                includeCredentials: true,
            }
        });

        const { resource } = result;
        console.log(`[proxy] CDP status: ${resource.success} | httpStatusCode: ${resource.httpStatusCode}`);

        if (!resource.success || resource.httpStatusCode === 403) {
            console.log('[proxy] CDP fallito, provo fallback...');
            return proxyFallback(videoUrl, rangeHeader, res, embedSrc);
        }

        // Leggi il contenuto via IO.read in streaming
        const streamHandle = resource.stream;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');

        if (resource.httpStatusCode) res.status(resource.httpStatusCode);

        console.log('[proxy] Streaming via CDP IO.read...');
        let totalBytes = 0;
        const CHUNK_SIZE = 128 * 1024; // 128KB per chunk

        while (true) {
            const chunk = await cdpClient.send('IO.read', {
                handle: streamHandle,
                size: CHUNK_SIZE
            });

            const buf = chunk.base64Encoded
                ? Buffer.from(chunk.data, 'base64')
                : Buffer.from(chunk.data, 'binary');

            if (buf.length > 0) {
                res.write(buf);
                totalBytes += buf.length;
                if (totalBytes % (1024*1024) < CHUNK_SIZE) {
                    console.log(`[proxy] Streamati ${Math.round(totalBytes/1024)}KB...`);
                }
            }

            if (chunk.eof) break;
        }

        await cdpClient.send('IO.close', { handle: streamHandle }).catch(()=>{});
        res.end();
        console.log(`[proxy] ✅ Stream completato: ${Math.round(totalBytes/1024)}KB`);

        // Aggiorna timestamp sessione
        session.ts = Date.now();

    } catch(e) {
        console.error('[proxy] CDP error:', e.message);
        if (!res.headersSent) {
            return proxyFallback(videoUrl, rangeHeader, res, embedSrc);
        }
    }
});

// Fallback: proxy HTTP classico (potrebbe dare 403 per TLS, ma tentiamo)
function proxyFallback(videoUrl, rangeHeader, res, embedSrc) {
    const https = require('https');
    const http = require('http');
    let parsed;
    try { parsed = new URL(videoUrl); } catch(e) { return res.status(400).send('URL non valido'); }

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://mixdrop.vip/',
        'Origin': 'https://mixdrop.vip',
    };
    if (rangeHeader) headers['Range'] = rangeHeader;

    const protocol = parsed.protocol==='https:' ? https : http;
    const proxyReq = protocol.request({
        hostname: parsed.hostname,
        port: parsed.port||(parsed.protocol==='https:'?443:80),
        path: parsed.pathname+parsed.search,
        method: 'GET', headers, timeout: 30000,
    }, (proxyRes) => {
        console.log(`[proxy-fallback] ${proxyRes.statusCode} | ${proxyRes.headers['content-type']}`);
        res.setHeader('Access-Control-Allow-Origin','*');
        res.setHeader('Accept-Ranges','bytes');
        ['content-type','content-length','content-range'].forEach(h=>{
            if(proxyRes.headers[h])res.setHeader(h,proxyRes.headers[h]);
        });
        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res,{end:true});
    });
    proxyReq.on('error',e=>{if(!res.headersSent)res.status(502).end();});
    req?.on('close',()=>proxyReq.destroy());
    proxyReq.end();
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Video Extractor v17 porta ${PORT}`));
