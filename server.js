const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v27' }));

let sharedBrowser = null;
let proxyPage = null; // pagina tenuta aperta per il proxy (stesso IP, no CORS con --disable-web-security)

async function getSharedBrowser() {
    if (sharedBrowser) {
        try { await sharedBrowser.pages(); return sharedBrowser; } catch(e) { sharedBrowser = null; proxyPage = null; }
    }
    console.log('[browser] Avvio (single-process + no-cors)...');
    sharedBrowser = await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process',
            '--mute-audio', '--disable-blink-features=AutomationControlled',
            '--disable-web-security',       // ← disabilita CORS: fetch funziona ovunque
            '--allow-running-insecure-content',
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
    sharedBrowser.on('disconnected', () => { console.log('[browser] Disconnesso'); sharedBrowser = null; proxyPage = null; });
    console.log('[browser] ✅ Avviato');
    return sharedBrowser;
}

const urlCache = new Map();
setInterval(() => { const now=Date.now(); for(const [k,v] of urlCache) if(now-v.ts>8*60*1000) urlCache.delete(k); }, 60000);

const VIDEO_EXTS = ['.mp4','.m3u8','.webm','.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick','googlesyndication','adsco.re','facebook.net'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','recaptcha'].some(x=>u.includes(x))) return false;
    return VIDEO_EXTS.some(e=>u.includes(e));
}

// ============================================================
// EXTRACT: request interception (funzionava in v23)
// Tiene la pagina aperta come proxyPage per il fetch nel proxy
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });
    if (urlCache.has(url) && proxyPage) {
        const c = urlCache.get(url);
        console.log('[v27] cache hit:', c.videoUrl.substring(0,60));
        return res.json({ success: true, video_url: c.videoUrl });
    }

    console.log('[v27] EXTRACT:', url);
    let page=null, resolved=false;
    const timer = setTimeout(() => {
        console.log('[v27] TIMEOUT');
        if(!resolved){ resolved=true; if(page)page.close().catch(()=>{}); res.json({success:false,message:'Timeout'}); }
    }, 70000);

    try {
        const browser = await getSharedBrowser();
        page = await browser.newPage();
        console.log('[v27] Pagina aperta');

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {get:()=>undefined});
            window.chrome = {runtime:{}};
        });

        await page.setRequestInterception(true);
        page.on('request', (r) => {
            const u = r.url();
            if(BLOCK_URLS.some(b=>u.includes(b))){ try{r.abort();}catch(e){} return; }
            if(looksLikeVideo(u)){
                console.log('[v27] Video trovato:', u.substring(0,90));
                try{r.abort();}catch(e){}   // abort: token non consumato
                if(!resolved){
                    resolved=true; clearTimeout(timer);
                    urlCache.set(url, {videoUrl:u, ts:Date.now()});
                    proxyPage = page;       // tieni pagina aperta per proxy
                    console.log('[v27] ✅ Pagina tenuta per proxy (stesso IP, CORS disabilitato)');
                    res.json({success:true, video_url:u});
                }
                return;
            }
            try{r.continue();}catch(e){}
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({'Accept-Language':'it-IT,it;q=0.9'});

        console.log('[v27] Navigazione:', url);
        await page.goto(url, {waitUntil:'domcontentloaded', timeout:30000})
            .catch(e=>console.log('[v27] goto warn:', e.message.substring(0,80)));
        console.log('[v27] Pagina caricata');

        for(let w=0; w<30&&!resolved; w++){
            await sleep(500);
            const q = await page.evaluate(()=>{
                try{if(window.MDCore?.wurl){const u=window.MDCore.wurl;return u.startsWith('//')?'https:'+u:u;}}catch(e){}
                try{if(window.jwplayer){const p=window.jwplayer().getPlaylist?.();if(p?.[0]?.file)return p[0].file;}}catch(e){}
                const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if(q&&!resolved){ resolved=true; clearTimeout(timer); urlCache.set(url,{videoUrl:q,ts:Date.now()}); proxyPage=page; res.json({success:true,video_url:q}); return; }
        }
        if(resolved) return;

        for(let i=0; i<15&&!resolved; i++){
            await page.mouse.click(640+(Math.random()*40-20), 360+(Math.random()*40-20)).catch(()=>{});
            await sleep(800);
            if((i+1)%3===0){
                const v = await page.evaluate(()=>{
                    try{if(window.MDCore?.wurl){const u=window.MDCore.wurl;return u.startsWith('//')?'https:'+u:u;}}catch(e){}
                    const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.(?:mp4|m3u8)[^"]{0,100})"/);
                    return m?.[1]||null;
                }).catch(()=>null);
                if(v&&!resolved){ resolved=true; clearTimeout(timer); urlCache.set(url,{videoUrl:v,ts:Date.now()}); proxyPage=page; res.json({success:true,video_url:v}); return; }
                console.log(`[v27] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v27] ERRORE:', e.message);
        clearTimeout(timer);
        if(page) page.close().catch(()=>{});
        if(!resolved) res.json({success:false,message:'Errore: '+e.message});
    }
});

// ============================================================
// PROXY: fetch dalla proxyPage (stesso browser, stesso IP)
// --disable-web-security → nessun CORS
// Chunk da 256KB → nessun timeout
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');

    if (!proxyPage) {
        console.log('[proxy] Nessuna pagina attiva');
        return res.status(503).send('Sessione scaduta, ricarica la pagina');
    }

    const rangeHeader = req.headers['range'];
    let start = 0, end = 256*1024 - 1;
    if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if(m){ start=parseInt(m[1]); end=m[2]?parseInt(m[2]):start+256*1024-1; }
    }
    const rangeStr = `bytes=${start}-${end}`;
    console.log(`[proxy] Range: ${rangeStr} | ${videoUrl.substring(0,60)}`);

    try {
        const result = await Promise.race([
            proxyPage.evaluate(async (opts) => {
                try {
                    const r = await fetch(opts.url, {
                        headers: { 'Range': opts.range, 'Accept': '*/*' },
                        // --disable-web-security: nessun CORS check!
                    });
                    const status = r.status;
                    const ct = r.headers.get('content-type') || 'video/mp4';
                    const cr = r.headers.get('content-range') || '';
                    const cl = r.headers.get('content-length') || '';
                    if (status >= 400) return { error: true, status, message: `HTTP ${status}` };
                    const ab = await r.arrayBuffer();
                    const bytes = new Uint8Array(ab);
                    let bin = '';
                    for(let i=0; i<bytes.length; i+=4096) {
                        bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i+4096, bytes.length)));
                    }
                    return { error:false, status, ct, cr, cl, b64:btoa(bin), len:bytes.length };
                } catch(e) { return { error:true, message: e.message }; }
            }, { url: videoUrl, range: rangeStr }),
            new Promise((_,rej) => setTimeout(()=>rej(new Error('Timeout 20s')), 20000))
        ]);

        if(result.error){
            console.error('[proxy] Fetch error:', result.message||result.status);
            return res.status(result.status||502).send(result.message||'Fetch fallito');
        }

        console.log(`[proxy] ✅ ${result.status} | ${result.ct} | ${result.len}b`);
        const buf = Buffer.from(result.b64, 'base64');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', result.ct);
        res.setHeader('Content-Length', buf.length);
        if(result.cr) res.setHeader('Content-Range', result.cr);
        res.status(result.status===206?206:200).send(buf);

    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if(!res.headersSent) res.status(500).send('Errore: '+e.message);
    }
});

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Video Extractor v27 porta ${PORT}`));
