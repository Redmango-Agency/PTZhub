# PTZ Hub

Controller gratuito per telecamere PTZ di rete, con integrazione OBS, Stream Deck e tastiere macro. Windows e macOS.

[English](README.md) · **Italiano**

PTZ Hub ti dà anteprima dal vivo, joystick, zoom e fuoco, e **inquadrature** che richiami con un clic o un tasto. Pensato per eventi, conferenze, chiese e dirette streaming. *(Fino alla versione 1.3 il programma si chiamava PTZ Panel.)*

## Cosa fa

- **Inquadrature con editor dedicato**: «+ Nuova inquadratura» apre l'editor con anteprima e comandi; posizioni la camera e salvi. Vengono memorizzate le coordinate esatte (pan, tilt, zoom, fuoco) lette dalla camera, più una miniatura. Al richiamo la testa torna esattamente lì.
- **Inquadrature separate per ogni account** Windows o Mac, con esportazione e importazione.
- **Richiamo rapido**: clic sulla miniatura, tasti `1`–`9` e `0`, oppure scorciatoie globali che funzionano anche con OBS, vMix o PowerPoint in primo piano.
- **Anteprima video** RTSP (ffmpeg incluso) o USB, griglia dei terzi, rotazione 180° per montaggio a soffitto.
- **Comandi manuali**: joystick con velocità proporzionale, frecce (Maiusc = lento), zoom, fuoco automatico/manuale, Home, **STOP** (`Esc` o `Spazio`).
- **Pensato per la diretta**: finestra sempre in primo piano, stop di sicurezza al rilascio, alla perdita del fuoco e alla chiusura; STOP interrompe anche un richiamo in corso.
- **Viste ridotte** *(1.4)*: colonna **Compatta** sempre in primo piano, oppure linguetta **Laterale** agganciata al bordo sinistro o destro dello schermo che si apre al passaggio del mouse.
- **Ricerca automatica**: trova le telecamere in rete (ONVIF WS-Discovery + scansione), rileva il protocollo e l'indirizzo del flusso video.
- **Centro operativo per OBS, Stream Deck e tastiere macro**: pannello da agganciare in OBS, indirizzo web per ogni funzione (Stream Deck, Bitfocus Companion), tasti globali per ogni funzione e **plugin per Stream Deck** con miniatura, nome e luce «in onda» sui tasti *(1.4)*. Tutto passa dal programma, quindi tutti vedono la stessa inquadratura attiva. Dettagli in [docs/comandi-esterni.md](docs/comandi-esterni.md).
- **Italiano e inglese**, scelti in automatico dalla lingua del sistema.

## Telecamere compatibili

Telecamere PTZ comandate via rete con protocolli standard:

| Protocollo | Porta tipica | Marche |
|---|---|---|
| VISCA over IP (UDP) | 1259 | Tenveo, PTZOptics, AViPAS, BZBGear, Minrray e cloni |
| VISCA over IP (TCP) | 5678 | come sopra |
| Sony VISCA over IP | 52381 | Sony SRG/BRC e compatibili |
| ONVIF PTZ | 80 / 8000 / 8080 | molte camere IP e PTZ |

Se la camera non sa comunicare la propria posizione, le inquadrature usano le memorie interne della camera (ogni account su numerazioni diverse).

**Non ancora supportate**: telecamere comandabili solo via seriale RS-232/RS-485, Panasonic AW (protocollo HTTP proprietario), webcam PTZ solo USB (le camere USB funzionano per l'anteprima, non per muovere la testa).

Il supporto è in fase di collaudo: se la provi con il tuo modello, apri una [Issue](https://github.com/Redmango-Agency/PTZhub/issues/new/choose) («Telecamera provata»).

## Installazione

### Windows
1. Scarica `…-Setup-<versione>.exe` dalla pagina [Releases](https://github.com/Redmango-Agency/PTZhub/releases).
2. Avvialo: installa il programma per tutti gli account del PC, crea i collegamenti e apre il firewall per la telecamera.
3. Windows può avvisare che il programma non è firmato: «Ulteriori informazioni» → «Esegui comunque».

C'è anche una versione portatile (`…-portable-win-x64.zip`).

### Mac (in prova)
1. Scarica `…-mac-arm64.dmg` per i Mac con chip Apple (M1–M4) o `…-mac-x64.dmg` per i Mac Intel.
2. Apri il dmg e trascina l'app in Applicazioni.
3. L'app non è ancora firmata da Apple: la prima volta apri il Terminale e incolla
   `xattr -cr "/Applications/PTZ Hub.app"` (per le versioni fino alla 1.3: `"/Applications/PTZ Panel.app"`),
   altrimenti macOS dice che l'app «è danneggiata».
4. Alla prima ricerca della telecamera consenti l'accesso alla rete locale.

### Aggiornamenti
All'avvio e poi una volta al giorno il programma chiede a GitHub qual è l'ultima versione pubblicata. Se ce n'è una più recente compare in alto l'avviso «Scarica», che apre la pagina della release: il programma non scarica e non installa nulla da solo, così durante un evento non cambia niente. Il controllo si spegne nelle Impostazioni.

## Primo utilizzo
1. Al primo avvio il programma cerca in rete e propone la telecamera (oppure scrivi l'IP).
2. Anteprima video: trova il flusso RTSP; scegli USB se la camera è collegata a questo computer.
3. «+ Nuova inquadratura» per creare le tue inquadrature.

## Sviluppo
Serve Node.js 22.

```bash
npm install
npm run ffmpeg:win      # ffmpeg per il pacchetto Windows (non è nel repository); Mac: node scripts/fetch-ffmpeg.js darwin-arm64
npm start
npm test                # protocolli con telecamere simulate (VISCA, ONVIF), collegamento esterno, aggiornamenti
npm run dist:win        # installer e versione portatile in dist/
```

GitHub Actions crea l'installer Windows e i dmg per Mac a ogni tag `v*` e li pubblica nelle Releases. Vedi [CHANGELOG.md](CHANGELOG.md) e [CONTRIBUTING.md](CONTRIBUTING.md).

```
src/main/      driver delle telecamere (visca.js, onvif.js), ricerca, anteprima, dati per account,
               hub.js (centro operativo), control.js (collegamento per OBS/Stream Deck), updates.js
src/renderer/  interfaccia              src/control/  pannello per OBS
src/shared/    testi in italiano e inglese         test/  telecamere simulate e test
build/         icone, installer e script di impacchettamento
```

## Sicurezza
Vulnerabilità: segnalale in privato, vedi [SECURITY.md](SECURITY.md).

## Licenza
[MIT](LICENSE) © Redmango S.r.l. — libero da usare, modificare e ridistribuire, anche in ambito commerciale.

I pacchetti includono FFmpeg (GPL v3) come programma separato per l'anteprima video, ed Electron/Chromium: dettagli in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
