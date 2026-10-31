# PTZ Panel

Pannello di controllo gratuito per Windows per telecamere **PTZ** (testa mobile) collegate in rete: anteprima video, joystick, zoom e fuoco, e **inquadrature** richiamabili con un clic o un tasto. Pensato per eventi, conferenze, chiese e dirette streaming.

> *English: free Windows control panel for network PTZ cameras (VISCA over IP, ONVIF) with live preview, joystick and per-user presets. The interface is available in Italian and English (chosen automatically from Windows).*

## Cosa fa

- **Inquadrature con editor dedicato**: «+ Nuova inquadratura» apre l'editor con anteprima e comandi; posizioni la camera e salvi. Vengono memorizzate le coordinate esatte (pan, tilt, zoom, fuoco) lette dalla camera, più una miniatura. Al richiamo la testa torna esattamente lì.
- **Inquadrature separate per ogni account Windows** (cartella `%APPDATA%\PTZ Panel`), con esportazione e importazione.
- **Richiamo rapido**: clic sulla miniatura, tasti `1`–`9` e `0`, oppure scorciatoie globali `Ctrl+Alt+1…0` che funzionano anche con OBS, vMix o PowerPoint in primo piano.
- **Anteprima video** RTSP (ffmpeg incluso) o USB, griglia dei terzi, rotazione 180° per montaggio a soffitto.
- **Comandi manuali**: joystick con velocità proporzionale, frecce (Maiusc = lento), zoom, fuoco automatico/manuale, Home, **STOP** (`Esc` o `Spazio`).
- **Pensato per la diretta**: finestra sempre in primo piano, modalità compatta, stop di sicurezza su rilascio, perdita di fuoco della finestra e chiusura.
- **Ricerca automatica**: trova le telecamere in rete (ONVIF WS-Discovery + scansione), rileva il protocollo e l'indirizzo del flusso video.
- **Italiano e inglese**: lingua scelta in automatico da Windows, modificabile nelle Impostazioni.
- **Centro operativo per OBS, Stream Deck e tastiere macro**: pannello da agganciare in OBS, indirizzi web per ogni funzione (Stream Deck, Bitfocus Companion) e tasti globali assegnabili a ogni funzione. Tutti passano dal programma e vedono la stessa inquadratura attiva. Dettagli in [docs/comandi-esterni.md](docs/comandi-esterni.md).

## Telecamere compatibili

Funziona con le telecamere PTZ che si controllano via rete con protocolli standard:

| Protocollo | Porta tipica | Esempi di marche |
|---|---|---|
| VISCA over IP (UDP) | 1259 | Tenveo, PTZOptics, AViPAS, BZBGear, Minrray e cloni |
| VISCA over IP (TCP) | 5678 | come sopra |
| Sony VISCA over IP | 52381 | Sony SRG/BRC e compatibili |
| ONVIF PTZ | 80 / 8000 / 8080 | molte camere IP e PTZ |

Se la camera non sa comunicare la propria posizione, il programma usa le memorie interne della camera (ogni account su numerazioni diverse).

**Non ancora supportate**: telecamere controllabili solo via seriale RS-232/RS-485, Panasonic AW (protocollo HTTP proprietario), webcam PTZ solo USB.

Il supporto è in fase di collaudo: se la provi con il tuo modello, apri una *Issue* indicando marca, modello e se funziona.

## Installazione

1. Scarica `PTZ-Panel-Setup-<versione>.exe` dalla pagina **Releases**.
2. Avvialo: installa il programma per tutti gli account del PC, crea i collegamenti e apre il firewall per la telecamera.
3. Windows può avvisare che il programma non è firmato: «Ulteriori informazioni» → «Esegui comunque».

C'è anche una versione portatile (`…-portable-win-x64.zip`) da estrarre e avviare senza installazione.

### Aggiornamenti

All'avvio e poi una volta al giorno il programma chiede a GitHub qual è l'ultima versione pubblicata. Se ce n'è una più recente compare in alto «Nuova versione … · Scarica», che apre la pagina della release: il programma non scarica e non installa nulla da solo, così durante un evento non cambia niente. Il controllo si spegne in Impostazioni → Aggiornamenti (lì c'è anche «Controlla ora»). L'unica informazione inviata è la versione installata, nell'intestazione della richiesta.

## Primo utilizzo

1. **Impostazioni** → «Cerca in rete» e clicca la telecamera (oppure scrivi l'IP e premi «Rileva protocollo»).
2. Anteprima video: «Trova» cerca il flusso RTSP. Se la camera è in USB su questo PC, scegli «USB».
3. Salva, poi «+ Nuova inquadratura» per creare le inquadrature.

## Sviluppo

Serve Node.js 22.

```bash
npm install
npm run ffmpeg:win      # scarica ffmpeg per il pacchetto Windows (non è nel repository)
npm start               # avvia l'app
npm test                # test dei protocolli con telecamere simulate (VISCA e ONVIF)
npm run dist:win        # crea installer e versione portatile in dist/
node tools/rileva-camera.js [--ip 192.168.1.50]   # diagnosi della rete da riga di comando
```

Su GitHub l'installer viene creato automaticamente (GitHub Actions su Windows) a ogni tag `v*` e pubblicato nelle Releases.

Per il controllo aggiornamenti, `package.json` → `ptzPanel.updateRepo` indica il repository (`proprietario/nome`); se è vuoto il controllo è spento. Pubblica le release con tag `vX.Y.Z` uguale alla versione del `package.json`: le pre-release non vengono proposte.

### Struttura

```
src/main/visca.js     driver VISCA over IP (UDP, TCP, Sony)
src/main/onvif.js     client ONVIF (PTZ, Media, Imaging)
src/main/probe.js     ricerca telecamere e rilevamento protocolli
src/main/preview.js   anteprima RTSP tramite ffmpeg
src/main/store.js     impostazioni e inquadrature per account
src/main/hub.js       centro operativo: richiami, impulsi, STOP, stato condiviso
src/main/control.js   collegamento locale per OBS, Stream Deck e Companion
src/main/updates.js   controllo nuove versioni su GitHub (avvisa soltanto)
src/control/          pannello per OBS
src/main/main.js      processo principale Electron
src/shared/i18n.js    testi in italiano e inglese (per aggiungere una lingua basta un dizionario)
src/renderer/         interfaccia
test/                 telecamere simulate e test
build/                icone, installer (NSIS) e script di impacchettamento
```

## Licenza

[MIT](LICENSE) © Redmango S.r.l. — libero da usare, modificare e ridistribuire, anche in ambito commerciale.

L'installer include FFmpeg (GPL v3) come programma separato per l'anteprima video, ed Electron/Chromium: dettagli in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
