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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v29' }));

let sharedBrowser = null;

async function getSharedBrowser() {
    if (sharedBrowser) {
        try { await sharedBrowser.pages(); return sharedBrowser; } catch(e) { sharedBrowser = null; }
    }
    console.log('[browser] Avvio single-process...');
    sharedBrowser = await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process',
            '--mute-audio', '--disable-blink-features=AutomationControlled',
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
    sharedBrowser.on('disconnected', () => { console.log('[browser] Disconnesso'); sharedBrowser = null; });
    console.log('[browser] ✅ Avviato');
    return sharedBrowser;
}

const urlCache = new Map();
setInterval(() => { const now=Date.now(); for(const [k,v] of urlCache) if(now-v.ts>8*60*1000) urlCache.delete(k); }, 60000);

// ============================================================
// EXTRACT: CDP Fetch pattern specifico *.mp4*, continueRequest
// (failRequest crasha Chrome in single-process!)
// Chiude la pagina subito → download si interrompe naturalmente
// Browser resta aperto → stesso IP per il proxy
// ============================================================
app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });
    if (urlCache.has(url)) { const c=urlCache.get(url); console.log('[v29] cache hit'); return res.json({success:true,video_url:c.videoUrl}); }

    console.log('[v29] EXTRACT:', url);
    let page=null, cdp=null, resolved=false;
    const timer = setTimeout(() => {
        console.log('[v29] TIMEOUT');
        if(!resolved){ resolved=true; if(page)page.close().catch(()=>{}); res.json({success:false,message:'Timeout'}); }
    }, 70000);

    function finish(videoUrl) {
        if(resolved) return;
        resolved=true; clearTimeout(timer);
        console.log('[v29] ✅ VIDEO:', videoUrl.substring(0,80));
        urlCache.set(url, {videoUrl, ts:Date.now()});
        page.close().catch(()=>{}); // chiude pagina → interrompe download → browser resta
        res.json({success:true, video_url:videoUrl});
    }

    try {
        const browser = await getSharedBrowser();
        page = await browser.newPage();
        cdp = await page.target().createCDPSession();

        // Pattern specifico solo .mp4 (non jpg/thumbs)
        // continueRequest: NON failRequest (failRequest crasha single-process!)
        await cdp.send('Fetch.enable', {
            patterns: [{ urlPattern: '*mxcontent.net/*.mp4*', requestStage: 'Request' }]
        });

        cdp.on('Fetch.requestPaused', async (event) => {
            const u = event.request.url;
            console.log('[v29] CDP intercettato .mp4:', u.substring(0,80));
            // continueRequest prima, poi chiudi pagina (più sicuro di failRequest)
            await cdp.send('Fetch.continueRequest', {requestId:event.requestId}).catch(()=>{});
            finish(u); // chiude pagina → Chrome smette di scaricare
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {get:()=>undefined});
            window.chrome = {runtime:{}};
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({'Accept-Language':'it-IT,it;q=0.9'});

        console.log('[v29] Navigazione:', url);
        await page.goto(url, {waitUntil:'domcontentloaded', timeout:30000})
            .catch(e=>console.log('[v29] goto warn:', e.message.substring(0,80)));
        console.log('[v29] Pagina caricata');

        // Poll DOM per URL (fallback)
        for(let w=0; w<30&&!resolved; w++){
            await sleep(500);
            const q = await page.evaluate(()=>{
                try{if(window.MDCore?.wurl){const u=window.MDCore.wurl;return u.startsWith('//')?'https:'+u:u;}}catch(e){}
                try{if(window.jwplayer){const p=window.jwplayer().getPlaylist?.();if(p?.[0]?.file)return p[0].file;}}catch(e){}
                const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.mp4[^"]{0,100})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if(q){ finish(q); return; }
        }
        if(resolved) return;

        // Click
        for(let i=0; i<15&&!resolved; i++){
            await page.mouse.click(640+(Math.random()*40-20), 360+(Math.random()*40-20)).catch(()=>{});
            await sleep(800);
            if((i+1)%3===0){
                const v = await page.evaluate(()=>{
                    try{if(window.MDCore?.wurl){const u=window.MDCore.wurl;return u.startsWith('//')?'https:'+u:u;}}catch(e){}
                    const m=document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.mp4[^"]{0,100})"/);
                    return m?.[1]||null;
                }).catch(()=>null);
                if(v){ finish(v); return; }
                console.log(`[v29] Click ${i+1}: niente`);
            }
        }
    } catch(e) {
        console.error('[v29] ERRORE:', e.message);
        clearTimeout(timer);
        if(page) page.close().catch(()=>{});
        if(!resolved) res.json({success:false,message:'Errore: '+e.message});
    }
});

// ============================================================
// PROXY: nuova pagina nello stesso browser (stesso IP del token)
// CDP Fetch Response stage → IO.read streaming
// ============================================================
app.get('/proxy', async (req, res) => {
    const { url: videoUrl, src: embedSrc } = req.query;
    if (!videoUrl) return res.status(400).send('URL mancante');
    const rangeHeader = req.headers['range'];
    console.log(`[proxy] Range:${rangeHeader||'no'} | ${videoUrl.substring(0,60)}`);

    let videoPage=null;
    try {
        const browser = await getSharedBrowser();
        videoPage = await browser.newPage();
        const cdp = await videoPage.target().createCDPSession();

        await cdp.send('Fetch.enable', {
            patterns: [{ urlPattern: '*mxcontent.net*.mp4*', requestStage: 'Response' }]
        });

        const streamReady = new Promise((resolve) => {
            cdp.on('Fetch.requestPaused', async (event) => {
                const status = event.responseStatusCode;
                const hdrs = event.responseHeaders||[];
                const ct = hdrs.find(h=>h.name.toLowerCase()==='content-type')?.value||'video/mp4';
                const cl = hdrs.find(h=>h.name.toLowerCase()==='content-length')?.value||'';
                const cr = hdrs.find(h=>h.name.toLowerCase()==='content-range')?.value||'';
                console.log(`[proxy] CDP: ${status} | ${ct} | ${cl||'?'}b`);
                if(status && status < 400){
                    try{
                        const {stream} = await cdp.send('Fetch.takeResponseBodyAsStream',{requestId:event.requestId});
                        resolve({stream,status,ct,cl,cr});
                    }catch(e){ console.error('[proxy] stream err:', e.message); resolve({error:status}); }
                } else {
                    console.log('[proxy] CDN blocca:', status);
                    await cdp.send('Fetch.continueRequest',{requestId:event.requestId}).catch(()=>{});
                    resolve({error:status||403});
                }
            });
        });

        await videoPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        const navHeaders = {'Accept':'*/*','Accept-Language':'it-IT,it;q=0.9','Referer':embedSrc||'https://mixdrop.vip/'};
        if(rangeHeader) navHeaders['Range'] = rangeHeader;
        await videoPage.setExtraHTTPHeaders(navHeaders);

        console.log('[proxy] Navigo al video (stesso browser, stesso IP)...');
        videoPage.goto(videoUrl, {waitUntil:'domcontentloaded', timeout:20000}).catch(e=>console.log('[proxy] goto:',e.message.substring(0,60)));

        const result = await Promise.race([
            streamReady,
            new Promise((_,reject)=>setTimeout(()=>reject(new Error('Timeout CDP 35s')),35000))
        ]);

        if(result.error){ await videoPage.close().catch(()=>{}); return res.status(result.error).send('error:'+result.error); }

        const {stream,status,ct,cl,cr}=result;
        console.log(`[proxy] ✅ Streaming: ${status} ${ct} ${cl||'?'}b`);
        res.setHeader('Access-Control-Allow-Origin','*');
        res.setHeader('Accept-Ranges','bytes');
        res.setHeader('Content-Type',ct);
        if(cl) res.setHeader('Content-Length',cl);
        if(cr) res.setHeader('Content-Range',cr);
        res.status(status===206?206:200);

        let total=0, CHUNK=256*1024;
        while(true){
            const chunk=await cdp.send('IO.read',{handle:stream,size:CHUNK});
            const buf=chunk.base64Encoded?Buffer.from(chunk.data,'base64'):Buffer.from(chunk.data,'binary');
            if(buf.length>0){res.write(buf);total+=buf.length;}
            if(chunk.eof) break;
            if(total%(5*1024*1024)<CHUNK) console.log(`[proxy] ${Math.round(total/1024/1024)}MB...`);
        }
        res.end();
        console.log(`[proxy] ✅ Completato: ${Math.round(total/1024)}KB`);
        await cdp.send('IO.close',{handle:stream}).catch(()=>{});
        await videoPage.close().catch(()=>{});

    } catch(e) {
        console.error('[proxy] ERRORE:', e.message);
        if(videoPage) videoPage.close().catch(()=>{});
        if(!res.headersSent) res.status(500).send('Errore: '+e.message);
    }
});

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Video Extractor v29 porta ${PORT}`));
