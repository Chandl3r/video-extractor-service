const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const https = require('https');
const http = require('http');

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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v16' }));

// Cache: embedUrl → { videoUrl, cdnCookies, referer, ts }
// cdnCookies = cookie che Puppeteer riceve da mxcontent.net (non da mixdrop.vip)
const videoCache = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of videoCache) {
        if (now - v.ts > 8*60*1000) videoCache.delete(k);
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

    console.log('[v16] ESTRAZIONE:', url);
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

        // Tiene traccia dei cookie ricevuti da mxcontent.net
        // (intercettando le response del CDN durante la sessione Puppeteer)
        const cdnResponseHeaders = {};

        async function resolveVideo(vUrl, src) {
            if (resolved) return;
            resolved = true;
            clearTimeout(globalTimeout);
            console.log(`[v16] VIDEO (${src}):`, vUrl);

            // Raccoglie cookie di mixdrop (per referer auth)
            const allCookies = await page.cookies().catch(()=>[]);
            const mixdropCookies = allCookies.map(c=>`${c.name}=${c.value}`).join('; ');
            console.log(`[v16] Cookies mixdrop: ${allCookies.length}`);

            // Estrai il dominio CDN per i cookie specifici
            let cdnCookieStr = '';
            try {
                const cdnHost = new URL(vUrl).hostname;
                const cdnCookies = await page.cookies(vUrl).catch(()=>[]);
                cdnCookieStr = cdnCookies.map(c=>`${c.name}=${c.value}`).join('; ');
                console.log(`[v16] Cookies CDN (${cdnHost}): ${cdnCookies.length}`);
            } catch(e) {}

            videoCache.set(url, {
                videoUrl: vUrl,
                mixdropCookies,
                cdnCookieStr,
                referer: url,
                responseHeaders: cdnResponseHeaders,
                ts: Date.now(),
            });

            res.json({ success: true, video_url: vUrl });
            setImmediate(() => browser.close().catch(()=>{}));
        }

        await page.setRequestInterception(true);

        page.on('request', (request) => {
            const u = request.url();
            if (BLOCK_URLS.some(b=>u.includes(b))) { try{request.abort();}catch(e){} return; }
            if (request.resourceType()==='media') {
                console.log('[v16] Media:', u.substring(0,80));
                try{request.abort();}catch(e){}
                if (!resolved) resolveVideo(u,'media');
                return;
            }
            if (!resolved && looksLikeVideo(u)) {
                console.log('[v16] Video network:', u.substring(0,80));
                try{request.abort();}catch(e){}
                resolveVideo(u,'network');
                return;
            }
            try{request.continue();}catch(e){}
        });

        page.on('response', (r) => {
            if (resolved) return;
            const u = r.url();
            const ct = r.headers()['content-type']||'';
            if ((ct.includes('video/')||ct.includes('mpegurl'))&&looksLikeVideo(u))
                resolveVideo(u,'response');
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({'Accept-Language':'it-IT,it;q=0.9,en-US;q=0.8'});
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}).catch(e=>console.log('[v16] goto:',e.message.substring(0,60)));

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
                console.log(`[v16] Click ${i+1}: niente`);
            }
        }

    } catch(e) {
        console.error('[v16] ERRORE:', e.message);
        clearTimeout(globalTimeout);
        if (!resolved) {
            resolved=true;
            if(browser)browser.close().catch(()=>{});
            res.json({success:false,message:'Errore: '+e.message});
        }
    }
});

// ============================================================
// PROXY: streaming con tutti i cookie giusti
// ============================================================
app.get('/proxy', (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    const cached = embedSrc ? videoCache.get(embedSrc) : null;
    const rangeHeader = req.headers['range'];

    // Usa i cookie CDN se disponibili, altrimenti quelli di mixdrop
    const cookieStr = cached?.cdnCookieStr || cached?.mixdropCookies || '';
    const referer = cached?.referer || 'https://mixdrop.vip/';

    console.log(`[proxy] ${videoUrl.substring(0,70)}`);
    console.log(`[proxy] Referer: ${referer}`);
    console.log(`[proxy] Cookie (${cookieStr.split(';').length}): ${cookieStr.substring(0,100)}`);
    console.log(`[proxy] Range: ${rangeHeader||'nessuno'}`);

    let parsed;
    try { parsed = new URL(videoUrl); } catch(e) { return res.status(400).send('URL non valido'); }

    const protocol = parsed.protocol==='https:' ? https : http;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'identity',
        'Referer': referer,
        'Origin': 'https://mixdrop.vip',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        'Connection': 'keep-alive',
    };
    // Manda i cookie CDN specifici (non quelli di mixdrop.vip)
    if (cached?.cdnCookieStr) headers['Cookie'] = cached.cdnCookieStr;
    if (rangeHeader) headers['Range'] = rangeHeader;

    const proxyReq = protocol.request({
        hostname: parsed.hostname,
        port: parsed.port||(parsed.protocol==='https:'?443:80),
        path: parsed.pathname+parsed.search,
        method: 'GET',
        headers,
        timeout: 30000,
    }, (proxyRes) => {
        console.log(`[proxy] Risposta: ${proxyRes.statusCode} | CT: ${proxyRes.headers['content-type']} | Size: ${proxyRes.headers['content-length']||'?'}`);

        res.setHeader('Access-Control-Allow-Origin','*');
        res.setHeader('Access-Control-Expose-Headers','Content-Length,Content-Range,Accept-Ranges');
        res.setHeader('Accept-Ranges','bytes');
        ['content-type','content-length','content-range','last-modified','etag','cache-control']
            .forEach(h=>{if(proxyRes.headers[h])res.setHeader(h,proxyRes.headers[h]);});

        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res,{end:true});
    });

    proxyReq.on('timeout',()=>{proxyReq.destroy();if(!res.headersSent)res.status(504).end();});
    proxyReq.on('error',e=>{console.error('[proxy] error:',e.message);if(!res.headersSent)res.status(502).end();});
    req.on('close',()=>proxyReq.destroy());
    proxyReq.end();
});

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Video Extractor v16 porta ${PORT}`));
