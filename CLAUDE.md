# PTZ Hub — note per Claude

Programma gratuito (MIT, © Redmango S.r.l.) per comandare telecamere PTZ da Windows e Mac: anteprima, joystick, zoom e fuoco, inquadrature con posizione esatta, viste ridotte, pannello per OBS, indirizzi web, tasti globali e plugin per Stream Deck. Fino alla 1.3 si chiamava PTZ Panel.

Storico completo dello sviluppo, decisioni e cose in sospeso: `storico.local.md` nella cartella del progetto (solo locale, non va su GitHub). Leggilo all’inizio di un lavoro nuovo.

## Regole di lavoro
- Rispondi in italiano, breve e concreto. Commenti nel codice e messaggi dei commit in italiano.
- Ogni testo dell'interfaccia va in italiano **e** inglese in `src/shared/i18n.js`: mai chiavi non tradotte.
- Stile grafico chiaro tipo Apple (non scuro), angoli morbidi; riusa le classi di `src/renderer/styles.css` e `base.css`.
- Sicurezza in diretta: STOP sempre raggiungibile (Esc/Spazio, tasto rosso sotto il joystick e nelle Impostazioni; le viste Compatta e Laterale hanno solo le inquadrature, scelta di Daniele); la testa si ferma al rilascio, alla perdita del fuoco e alla chiusura; STOP, Home o un comando manuale interrompono un richiamo in corso.
- Non è una regia video: il cambio tra le camere lo fa OBS. Più PTZ (solo per muoverle) è previsto per la 2.0.
- Tutti i comandi passano dal centro operativo `src/main/hub.js` (app, pannello OBS, indirizzi web, tasti globali, Stream Deck), così tutti vedono la stessa inquadratura attiva.

## Dove sta cosa
```
src/main/main.js       finestre (Completa, Compatta, Laterale), menu, IPC, migrazione dati da «PTZ Panel», aggiornamenti
src/main/hub.js        centro operativo: richiami annullabili (gen + cancelled), stop, comandi esterni
src/main/visca.js      VISCA over IP (UDP 1259, TCP 5678, Sony 52381)
src/main/onvif.js      ONVIF PTZ
src/main/uvc.js        camera via cavo USB (UVC, in prova); uvc-link.js + src/renderer/uvc.* = finestra nascosta col MediaStreamTrack (Mac/Linux);
                       uvc-native.js + native/uvc-win/ptzhub-uvc.exe = Windows, comandi DirectShow senza aprire il video (OBS/Zoom tengono la camera)
src/main/control.js    server locale 127.0.0.1:8765 con chiave per account (pannello OBS, Stream Deck, Companion)
src/main/updates.js    controllo nuove versioni su GitHub releases/latest (solo avviso)
src/main/store.js      impostazioni e inquadrature per account (userData «PTZ Hub»)
src/main/preview.js    anteprima RTSP con ffmpeg (vendor/ffmpeg, non nel repo)
src/renderer/          interfaccia (app.js, index.html, side.* = linguetta Laterale, common.js)
src/control/           pannello per OBS
src/shared/            i18n.js, uvc-caps.js
streamdeck/            plugin Stream Deck (SDK v2), test e pacchetto propri
test/                  test con camere simulate + smoke-main.js (prova completa in Electron)
scripts/               fetch-ffmpeg, release-notes, ci-annotate, make-dmg-linux
```

## Comandi
```bash
npm install
node scripts/fetch-ffmpeg.js darwin-arm64     # ffmpeg per l'anteprima (Windows: npm run ffmpeg:win)
npm start
npm test                                      # VISCA, ONVIF, collegamento esterno, hub, USB, aggiornamenti
cd streamdeck && npm ci && npm test && npm run pack   # plugin -> streamdeck/dist/PTZ-Hub.streamDeckPlugin
```
- Prova completa: `test/smoke-main.js` (modalità con `PTZ_SMOKE=main|wizard|startup|usb|usb-noptz`). È pensata per Linux con `xvfb-run` e `XDG_CONFIG_HOME` vuota: sul Mac userebbe i dati veri dell'account, quindi non lanciarla lì senza una cartella dati separata.
- Aiuto USB per Windows: `npm run uvc:win` (serve mingw-w64; `brew install mingw-w64` sul Mac, `apt install g++-mingw-w64-x86-64` su Linux) → `vendor/uvc-win/ptzhub-uvc.exe`.
- Pacchetti: Windows `npm run dist:win`; Mac (dal Mac) `npx electron-builder --mac dmg --arm64 --x64`. L'app per Mac non è firmata: al primo avvio `xattr -cr "/Applications/PTZ Hub.app"`.

## Pubblicare una versione
1. `npm version X.Y.Z --no-git-tag-version`; in `CHANGELOG.md` sezione `## [X.Y.Z] — data` e link in fondo.
2. Commit e push su `main`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`: GitHub Actions (`.github/workflows/build.yml`) crea installer Windows, versione portatile, dmg arm64 e x64, plugin Stream Deck e somme SHA256, e pubblica la release con le note prese dal CHANGELOG (`scripts/release-notes.js`). I test si riprovano una volta; un fallimento compare come avviso nella pagina della compilazione.

## Da non cambiare senza motivo
- `appId` resta `agency.redmango.ptzpanel`: serve all'installer per sostituire PTZ Panel.
- Dati per account in `PTZ Hub` (copiati una volta da `PTZ Panel`).
- Repository per gli aggiornamenti: `ptzPanel.updateRepo` in package.json (`Redmango-Agency/PTZhub`). Il controllo funziona solo quando il repository è pubblico.
