const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS per permettere chiamate da Altervista
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Video Extractor' });
});

/**
 * POST /extract
 * Body: { url: "https://mixdrop.vip/e/abc123" }
 * Returns: { success: true, video_url: "https://..." }
 */
app.post('/extract', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.json({ success: false, message: 'URL mancante' });
    }

    console.log('[Extractor] Inizio estrazione da:', url);

    let browser = null;

    try {
        // Lancia Chromium headless
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();

        // Intercetta le richieste di rete per trovare il video
        let videoUrl = null;

        await page.setRequestInterception(true);

        page.on('request', (request) => {
            const reqUrl = request.url();

            // Cerca URL video nelle richieste di rete
            if (isVideoUrl(reqUrl) && !videoUrl) {
                videoUrl = reqUrl;
                console.log('[Extractor] Video trovato nelle richieste:', reqUrl);
            }

            request.continue();
        });

        // Imposta User Agent realistico
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Carica la pagina
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Aspetta un po' per il caricamento JavaScript
        await sleep(2000);

        // Cerca il pulsante Play e clicca
        if (!videoUrl) {
            console.log('[Extractor] Cerco pulsante Play...');
            
            const playSelectors = [
                // Selettori comuni per il pulsante play
                '.jw-icon-display',
                '.vjs-big-play-button',
                '.play-button',
                '[aria-label="Play"]',
                '.plyr__control--overlaid',
                '#player .play',
                '.fp-play',
                'button.play',
                '.video-play-button',
                '[data-action="play"]',
                '.jwplayer .jw-display-icon-container',
            ];

            for (const selector of playSelectors) {
                try {
                    const btn = await page.$(selector);
                    if (btn) {
                        console.log('[Extractor] Clicco play:', selector);
                        await btn.click();
                        await sleep(3000);
                        break;
                    }
                } catch (e) {}
            }

            // Prova a cliccare sul video/player direttamente
            try {
                await page.click('video');
                await sleep(2000);
            } catch (e) {}

            // Prova a triggerare il play via JavaScript
            if (!videoUrl) {
                videoUrl = await page.evaluate(() => {
                    // Metodo 1: Tag video
                    const videos = document.querySelectorAll('video');
                    for (const v of videos) {
                        if (v.src && v.src.length > 10) return v.src;
                        const source = v.querySelector('source');
                        if (source && source.src) return source.src;
                    }

                    // Metodo 2: Cerca nell'HTML della pagina
                    const html = document.documentElement.innerHTML;
                    
                    const patterns = [
                        /MDCore\.wurl\s*=\s*["']([^"']+)["']/,
                        /wurl\s*:\s*["']([^"']+)["']/,
                        /file\s*:\s*["']([^"']+\.mp4[^"']*)["']/,
                        /sources?\s*:\s*\[\s*{[^}]*file\s*:\s*["']([^"']+)["']/,
                        /"(https?:\/\/[^"]+\.mp4[^"]*)"/,
                        /'(https:\/\/[^']+\.m3u8[^']*)'/,
                    ];

                    for (const p of patterns) {
                        const m = html.match(p);
                        if (m) return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
                    }

                    return null;
                });
            }
        }

        // Aspetta ancora se non trovato
        if (!videoUrl) {
            await sleep(3000);

            // Cerca ancora nelle richieste di rete
            videoUrl = await page.evaluate(() => {
                const html = document.documentElement.innerHTML;
                const m = html.match(/["'](https?:\/\/[^"']+(?:\.mp4|\.m3u8)[^"']*?)["']/);
                return m ? m[1] : null;
            });
        }

        await browser.close();

        if (videoUrl) {
            console.log('[Extractor] Successo:', videoUrl);
            return res.json({
                success: true,
                video_url: videoUrl,
                source_url: url
            });
        } else {
            console.log('[Extractor] Video non trovato');
            return res.json({
                success: false,
                message: 'Video non trovato nella pagina'
            });
        }

    } catch (error) {
        console.error('[Extractor] Errore:', error.message);
        if (browser) await browser.close();
        return res.json({
            success: false,
            message: 'Errore: ' + error.message
        });
    }
});

// Helper: controlla se un URL è un video
function isVideoUrl(url) {
    const videoExtensions = ['.mp4', '.m3u8', '.webm', '.mkv', '.ts'];
    const videoPatterns = ['video/', 'stream/', 'hls/', 'manifest'];
    
    const lowerUrl = url.toLowerCase();
    
    if (videoExtensions.some(ext => lowerUrl.includes(ext))) return true;
    if (videoPatterns.some(p => lowerUrl.includes(p))) return true;
    
    // Esclude risorse non video
    if (lowerUrl.includes('.js') || lowerUrl.includes('.css') || 
        lowerUrl.includes('.png') || lowerUrl.includes('.jpg') ||
        lowerUrl.includes('google') || lowerUrl.includes('analytics')) return false;
    
    return false;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Video Extractor Service in ascolto su porta ${PORT}`);
});
