# Video Extractor Service

Microservizio Node.js con Puppeteer per estrarre link video da piattaforme di streaming.

## Deploy GRATUITO su Render.com

### STEP 1: Crea account GitHub
Se non ce l'hai, registrati su https://github.com

### STEP 2: Crea repository
1. Vai su https://github.com/new
2. Nome: `video-extractor-service`
3. Privato o pubblico (va bene entrambi)
4. Click "Create repository"

### STEP 3: Carica i file
Nella pagina del repo appena creato:
1. Click "uploading an existing file"
2. Carica: `server.js`, `package.json`, `render.yaml`
3. Click "Commit changes"

### STEP 4: Deploy su Render
1. Vai su https://render.com e crea account GRATUITO
2. Click "New +" → "Web Service"
3. Collega il tuo GitHub
4. Seleziona il repo `video-extractor-service`
5. Impostazioni:
   - **Name:** video-extractor-service
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** FREE
6. Click "Create Web Service"

### STEP 5: Ottieni l'URL del servizio
Dopo il deploy (circa 5 minuti), Render ti darà un URL tipo:
`https://video-extractor-service.onrender.com`

### STEP 6: Aggiorna video_extractor.php
Nel file `application/controllers/video_extractor.php`, modifica la costante:
```php
private $extractor_service_url = 'https://video-extractor-service.onrender.com';
```

## Test
```
POST https://video-extractor-service.onrender.com/extract
Body: { "url": "https://mixdrop.vip/e/abc123" }
```

## Note
- Il piano gratuito di Render va in sleep dopo 15 minuti di inattività
- La prima chiamata dopo lo sleep impiega ~30 secondi (cold start)
- Per evitarlo, usa un servizio di ping gratuito come UptimeRobot
