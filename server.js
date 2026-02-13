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

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Video Extractor v12' });
});

// ============================================================
// SERVE-EMBED: scarica pagina embed, inietta interceptor JS,
// e la serve al browser dell'utente da Render (stesso dominio
// della richiesta → cookie/IP corretti per il video)
// ============================================================
app.get('/serve-embed', async (req, res) => {
    const embedUrl = req.query.url;
    if (!embedUrl) return res.status(400).send('URL mancante');

    console.log('[serve-embed] Fetching:', embedUrl.substring(0, 80));

    try {
        const html = await fetchPage(embedUrl);
        if (!html) return res.status(502).send('Impossibile scaricare la pagina');

        // Script interceptor da iniettare
        const interceptor = `<script id="__vex">
(function(){
var EXT=['.mp4','.m3u8','.webm','.ts'];
var SKIP=['.js','.css','.png','.jpg','.gif','.ico','.woff','analytics','pixel','tracker'];
var done=false;

function isVid(u){
    if(!u||typeof u!=='string')return false;
    var l=u.toLowerCase();
    if(SKIP.some(function(s){return l.indexOf(s)>-1;}))return false;
    return EXT.some(function(e){return l.indexOf(e)>-1;});
}

function found(url){
    if(done)return; done=true;
    console.log('[VEX] VIDEO TROVATO:',url);
    try{window.parent.postMessage({type:'VIDEO_FOUND',url:url},'*');}catch(e){}
    try{window.top.postMessage({type:'VIDEO_FOUND',url:url},'*');}catch(e){}
}

// Patch XHR
var OX=window.XMLHttpRequest;
function PX(){var x=new OX();var oo=x.open.bind(x);x.open=function(m,u){if(isVid(u))found(u);return oo.apply(this,arguments);};return x;}
PX.prototype=OX.prototype; window.XMLHttpRequest=PX;

// Patch fetch
if(window.fetch){var of=window.fetch;window.fetch=function(i){var u=typeof i==='string'?i:(i&&i.url);if(u&&isVid(u))found(u);return of.apply(this,arguments);};}

// Patch video.src
var md=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');
if(md&&md.set){Object.defineProperty(HTMLMediaElement.prototype,'src',{set:function(v){if(isVid(v))found(v);md.set.call(this,v);},get:function(){return md.get.call(this);},configurable:true});}

// Patch setAttribute
var osa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){if(n==='src'&&isVid(v))found(v);return osa.apply(this,arguments);};

// MutationObserver
new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){
    if(n.tagName==='VIDEO'&&n.src&&isVid(n.src))found(n.src);
    if(n.tagName==='SOURCE'&&n.src&&isVid(n.src))found(n.src);
    if(n.querySelectorAll)n.querySelectorAll('video[src],source[src]').forEach(function(el){if(isVid(el.src))found(el.src);});
});});}).observe(document.documentElement,{childList:true,subtree:true});

// PerformanceObserver
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){if(!done&&isVid(e.name))found(e.name);});}).observe({entryTypes:['resource']});}catch(e){}

// Poll
setInterval(function(){
    if(done)return;
    performance.getEntriesByType('resource').forEach(function(e){if(!done&&isVid(e.name))found(e.name);});
    document.querySelectorAll('video[src],source[src]').forEach(function(el){if(!done&&isVid(el.src))found(el.src);});
},200);

console.log('[VEX] Interceptor attivo su Render');
})();
</script>`;

        // Inietta all'inizio del <head>
        let injected = html;
        if (injected.toLowerCase().includes('<head>')) {
            injected = injected.replace(/<head>/i, '<head>' + interceptor);
        } else {
            injected = interceptor + injected;
        }

        // Reindirizza URL relativi al dominio originale
        const domain = new URL(embedUrl).origin;
        injected = injected
            .replace(/\bsrc="\/(?!\/)/g, `src="${domain}/`)
            .replace(/\bsrc='\/(?!\/)/g, `src='${domain}/`)
            .replace(/\bhref="\/(?!\/)/g, `href="${domain}/`)
            .replace(/\bhref='\/(?!\/)/g, `href='${domain}/`);

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Frame-Options', 'ALLOWALL');
        res.send(injected);
        console.log('[serve-embed] Pagina servita con interceptor iniettato');

    } catch(e) {
        console.error('[serve-embed] Errore:', e.message);
        res.status(500).send('Errore: ' + e.message);
    }
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
            const req = protocol.request(options, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', c => data += c);
                res.on('end', () => resolve(data || null));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        } catch(e) { resolve(null); }
    });
}

// ============================================================
// EXTRACT: usa Puppeteer per estrarre URL video
// ============================================================
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

async function checkAllFrames(page) {
    const main = await checkForVideo(page);
    if (main) return main;
    for (const frame of page.frames()) {
        try {
            if (frame === page.mainFrame()) continue;
            const url = frame.url();
            if (!url || url === 'about:blank') continue;
            const result = await frame.evaluate(() => {
                for (const v of document.querySelectorAll('video')) {
                    if (v.src?.startsWith('http')) return v.src;
                }
                try { if (window.MDCore?.wurl) { const u = window.MDCore.wurl; return u.startsWith('//') ? 'https:' + u : u; } } catch(e) {}
                return null;
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
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox',
                   '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
                   '--no-zygote', '--single-process', '--mute-audio',
                   '--disable-blink-features=AutomationControlled'],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: true,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();

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
            if (ct.includes('video/') || ct.includes('mpegurl')) resolveVideo(r.url(), 'response');
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8' });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
            .catch(e => console.log('[v12] goto:', e.message.substring(0, 60)));

        await sleep(2500);
        if (resolved) return;

        let v = await checkAllFrames(page);
        if (v && !resolved) { resolveVideo(v, 'initial-check'); return; }

        const frameUrls = page.frames().map(f => f.url().substring(0, 80));
        console.log('[v12] Frames:', JSON.stringify(frameUrls));

        for (let i = 0; i < 18 && !resolved; i++) {
            const x = 640 + (Math.random() * 20 - 10);
            const y = 360 + (Math.random() * 20 - 10);
            await page.mouse.move(x, y, { steps: 3 });
            await sleep(100);
            await page.mouse.click(x, y);
            await sleep(900);
            v = await checkAllFrames(page);
            if (v && !resolved) { resolveVideo(v, `click-${i+1}`); return; }
            if (i % 3 === 2) {
                for (const frame of page.frames()) {
                    try {
                        const playBtn = await frame.$('.jw-icon-display, .vjs-big-play-button, [aria-label="Play"]');
                        if (playBtn) {
                            await playBtn.click();
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
