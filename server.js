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

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Video Extractor v13' }));

// ============================================================
// SESSION STORE: mappa sessionId → videoUrl (in memoria)
// Pulita automaticamente dopo 5 minuti
// ============================================================
const sessions = new Map(); // sessionId -> { url, ts }

function cleanSessions() {
    const now = Date.now();
    for (const [id, data] of sessions) {
        if (now - data.ts > 5 * 60 * 1000) sessions.delete(id);
    }
}
setInterval(cleanSessions, 60000);

// L'interceptor chiama questo endpoint quando trova il video
app.get('/report-video', (req, res) => {
    const { session, url } = req.query;
    if (!session || !url) return res.status(400).json({ ok: false });
    console.log(`[report-video] Session ${session}: ${url.substring(0, 80)}`);
    sessions.set(session, { url, ts: Date.now() });
    res.json({ ok: true });
});

// Il client fa polling su questo endpoint
app.get('/get-video', (req, res) => {
    const { session } = req.query;
    if (!session) return res.status(400).json({ found: false });
    const data = sessions.get(session);
    if (data) {
        sessions.delete(session); // usa una volta sola
        return res.json({ found: true, url: data.url });
    }
    res.json({ found: false });
});

// ============================================================
// SERVE-EMBED: scarica pagina, inietta interceptor con session
// ============================================================
app.get('/serve-embed', async (req, res) => {
    const { url: embedUrl, session } = req.query;
    if (!embedUrl || !session) return res.status(400).send('Parametri mancanti');

    console.log(`[serve-embed] Session ${session}: ${embedUrl.substring(0, 80)}`);

    const html = await fetchPage(embedUrl);
    if (!html) return res.status(502).send('Impossibile scaricare la pagina');

    const renderBase = `${req.protocol}://${req.get('host')}`;

    const interceptor = `<script id="__vex">
(function(){
var SESSION='${session}';
var REPORT='${renderBase}/report-video';
var EXT=['.mp4','.m3u8','.webm','.ts'];
var SKIP=['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','pixel','tracker','recaptcha'];
var done=false;

function isVid(u){
    if(!u||typeof u!=='string')return false;
    var l=u.toLowerCase();
    if(SKIP.some(function(s){return l.indexOf(s)>-1;}))return false;
    return EXT.some(function(e){return l.indexOf(e)>-1;});
}

function found(url){
    if(done)return; done=true;
    console.log('[VEX] VIDEO:',url);
    // Chiama Render per registrare il video (no postMessage cross-origin!)
    var img=new Image();
    img.src=REPORT+'?session='+encodeURIComponent(SESSION)+'&url='+encodeURIComponent(url);
    // Backup: fetch
    try{fetch(REPORT+'?session='+encodeURIComponent(SESSION)+'&url='+encodeURIComponent(url));}catch(e){}
}

// Patch XHR
var OX=window.XMLHttpRequest;
function PX(){var x=new OX();var oo=x.open.bind(x);x.open=function(m,u){if(isVid(u))found(u);return oo.apply(this,arguments);};return x;}
PX.prototype=OX.prototype; window.XMLHttpRequest=PX;

// Patch fetch
if(window.fetch){var of=window.fetch;window.fetch=function(i){var u=typeof i==='string'?i:(i&&i.url);if(u&&isVid(u))found(u);return of.apply(this,arguments);};}

// Patch video.src
var md=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');
if(md&&md.set){Object.defineProperty(HTMLMediaElement.prototype,'src',{
    set:function(v){if(isVid(v))found(v);md.set.call(this,v);},
    get:function(){return md.get.call(this);},configurable:true});}

// Patch setAttribute
var osa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){if(n==='src'&&isVid(v))found(v);return osa.apply(this,arguments);};

// MutationObserver
new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){
    if(n.nodeType!==1)return;
    if((n.tagName==='VIDEO'||n.tagName==='SOURCE')&&isVid(n.src))found(n.src);
    if(n.querySelectorAll)n.querySelectorAll('video[src],source[src]').forEach(function(el){if(isVid(el.src))found(el.src);});
});});}).observe(document.documentElement,{childList:true,subtree:true});

// PerformanceObserver
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){if(!done&&isVid(e.name))found(e.name);});}).observe({entryTypes:['resource']});}catch(e){}

// Poll DOM + performance
setInterval(function(){
    if(done)return;
    performance.getEntriesByType('resource').forEach(function(e){if(!done&&isVid(e.name))found(e.name);});
    document.querySelectorAll('video[src],source[src]').forEach(function(el){if(!done&&isVid(el.src))found(el.src);});
},200);

console.log('[VEX] Interceptor attivo, session:',SESSION);
})();
</script>`;

    let injected = html;
    if (injected.toLowerCase().includes('<head>')) {
        injected = injected.replace(/<head>/i, '<head>' + interceptor);
    } else {
        injected = interceptor + injected;
    }

    // Reindirizza URL relativi
    const domain = new URL(embedUrl).origin;
    injected = injected
        .replace(/\bsrc="\/(?!\/)/g, `src="${domain}/`)
        .replace(/\bsrc='\/(?!\/)/g, `src='${domain}/`)
        .replace(/\bhref="\/(?!\/)/g, `href="${domain}/`)
        .replace(/\bhref='\/(?!\/)/g, `href='${domain}/`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', ''); // rimuovi CSP che blocca iframe
    res.send(injected);
    console.log(`[serve-embed] Servita con interceptor, session ${session}`);
});

function fetchPage(url) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(url);
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
                    'Referer': parsed.origin + '/',
                },
                timeout: 15000,
            };
            const req = protocol.request(options, (proxyRes) => {
                let data = '';
                proxyRes.setEncoding('utf8');
                proxyRes.on('data', c => data += c);
                proxyRes.on('end', () => resolve(data || null));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        } catch(e) { resolve(null); }
    });
}

// ============================================================
// EXTRACT: Puppeteer (manteniamo come backup)
// ============================================================
const VIDEO_EXTS = ['.mp4', '.m3u8', '.webm', '.ts'];
const BLOCK_URLS = ['google-analytics','googletagmanager','doubleclick',
                    'googlesyndication','adsco.re','xadsmart',
                    'adexchangeclear','flushpersist','usrpubtrk'];

function looksLikeVideo(url) {
    const u = url.toLowerCase();
    if (u.includes('.js')||u.includes('.css')||u.includes('.png')||u.includes('.jpg')||
        u.includes('.gif')||u.includes('.ico')||u.includes('.woff')||
        u.includes('analytics')||u.includes('recaptcha')||u.includes('adsco')) return false;
    return VIDEO_EXTS.some(e => u.includes(e));
}

async function checkAllFrames(page) {
    for (const frame of [page.mainFrame(), ...page.frames()]) {
        try {
            const result = await frame.evaluate(() => {
                for (const v of document.querySelectorAll('video')) {
                    if (v.src?.startsWith('http')) return v.src;
                }
                try { if (window.MDCore?.wurl) { const u=window.MDCore.wurl; return u.startsWith('//')?'https:'+u:u; }} catch(e){}
                try { if (window.jwplayer) { const p=window.jwplayer().getPlaylist?.(); if(p?.[0]?.file) return p[0].file; }} catch(e){}
                const m = document.documentElement.innerHTML.match(/"(https?:\/\/[^"]{15,}\.mp4[^"]{0,50})"/);
                return m?.[1]||null;
            }).catch(()=>null);
            if (result) return result;
        } catch(e) {}
    }
    return null;
}

app.post('/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.json({ success: false, message: 'URL mancante' });
    console.log('[v13] Estrazione Puppeteer:', url);
    let browser=null, resolved=false;
    const globalTimeout = setTimeout(() => {
        if (!resolved) { resolved=true; if(browser)browser.close().catch(()=>{}); res.json({success:false,message:'Timeout'}); }
    }, 58000);
    try {
        browser = await puppeteer.launch({
            args:[...chromium.args,'--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process','--mute-audio','--disable-blink-features=AutomationControlled'],
            defaultViewport:{width:1280,height:720},
            executablePath:await chromium.executablePath(),
            headless:true, ignoreHTTPSErrors:true,
        });
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(()=>{
            Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
            window.chrome={runtime:{}};
        });
        function resolveVideo(vUrl,src) {
            if(!resolved){resolved=true;console.log(`[v13] ✅ (${src}):`,vUrl);clearTimeout(globalTimeout);res.json({success:true,video_url:vUrl});setImmediate(()=>browser.close().catch(()=>{}));}
        }
        await page.setRequestInterception(true);
        page.on('request',(req)=>{
            const u=req.url();
            if(BLOCK_URLS.some(b=>u.includes(b)))return req.abort();
            if(req.resourceType()==='media')return req.abort();
            if(!resolved&&looksLikeVideo(u)){resolveVideo(u,'network');try{req.abort();}catch(e){} return;}
            try{req.continue();}catch(e){}
        });
        page.on('response',(r)=>{ if(resolved)return; const ct=r.headers()['content-type']||''; if(ct.includes('video/')||ct.includes('mpegurl'))resolveVideo(r.url(),'response'); });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}).catch(e=>console.log('[v13] goto:',e.message.substring(0,60)));
        await sleep(2500);
        if(resolved)return;
        let v=await checkAllFrames(page);
        if(v&&!resolved){resolveVideo(v,'initial');return;}
        for(let i=0;i<18&&!resolved;i++){
            await page.mouse.click(640+(Math.random()*20-10),360+(Math.random()*20-10));
            await sleep(900);
            v=await checkAllFrames(page);
            if(v&&!resolved){resolveVideo(v,`click-${i+1}`);return;}
        }
    } catch(e) {
        clearTimeout(globalTimeout);
        if(!resolved){resolved=true;if(browser)browser.close().catch(()=>{});res.json({success:false,message:'Errore: '+e.message});}
    }
});

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Video Extractor v13 porta ${PORT}`));
