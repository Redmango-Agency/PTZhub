<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/logo-dark.png">
    <img src="docs/img/logo-light.png" alt="PTZ Hub" width="360">
  </picture>
</p>

<p align="center">
  <b>Controller gratuito per telecamere PTZ di rete</b><br>
  VISCA over IP · ONVIF · USB (in prova) · pannello OBS · Stream Deck · tastiere macro — Windows e macOS
</p>

<p align="center">
  <a href="https://github.com/Redmango-Agency/PTZhub/releases/latest"><b>Scarica</b></a> ·
  <a href="#cosa-fa">Cosa fa</a> ·
  <a href="#telecamere-compatibili">Telecamere</a> ·
  <a href="#installazione">Installazione</a> ·
  <a href="README.md">English</a> · <b>Italiano</b>
</p>

<p align="center">
  <img alt="Windows e macOS" src="https://img.shields.io/badge/sistemi-Windows%20%7C%20macOS-0047C2">
  <img alt="Protocolli VISCA over IP e ONVIF" src="https://img.shields.io/badge/protocolli-VISCA%20over%20IP%20%7C%20ONVIF-3D8BFF">
  <img alt="Licenza MIT" src="https://img.shields.io/badge/licenza-MIT-0047C2">
  <a href="https://redmango.agency/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=ptzhub"><img alt="Realizzato da *redmango" src="https://img.shields.io/badge/realizzato%20da-*redmango-C0392B"></a>
</p>

PTZ Hub ti dà anteprima dal vivo, joystick, zoom e fuoco, e **inquadrature** che richiami con un clic o un tasto. Pensato per eventi, conferenze, chiese e dirette streaming. *(Fino alla versione 1.3 il programma si chiamava PTZ Panel.)*

## Cosa fa

- **Inquadrature con editor dedicato**: «+ Nuova inquadratura» apre l'editor con anteprima e comandi; posizioni la camera e salvi. Vengono memorizzate le coordinate esatte (pan, tilt, zoom, fuoco) lette dalla camera, più una miniatura. Al richiamo la testa torna esattamente lì.
- **Inquadrature separate per ogni account** Windows o Mac, con esportazione e importazione.
- **Richiamo rapido**: clic sulla miniatura, tasti `1`–`9` e `0`, oppure scorciatoie globali che funzionano anche con OBS, vMix o PowerPoint in primo piano.
- **Anteprima video** RTSP (ffmpeg incluso) o USB, griglia dei terzi, rotazione 180° per montaggio a soffitto.
- **Comandi manuali**: joystick con velocità proporzionale, frecce (Maiusc = lento), zoom, fuoco automatico/manuale, Home, **STOP** (`Esc` o `Spazio`).
- **Pensato per la diretta**: finestra sempre in primo piano, stop di sicurezza al rilascio, alla perdita del fuoco e alla chiusura; STOP interrompe anche un richiamo in corso.
- **Viste ridotte**: colonna **Compatta** sempre in primo piano, oppure linguetta **Laterale** agganciata al bordo sinistro o destro dello schermo che si apre al passaggio del mouse.
- **Ricerca automatica**: trova le telecamere in rete (ONVIF WS-Discovery + scansione), rileva il protocollo e l'indirizzo del flusso video.
- **Camere collegate solo via USB (in prova)**: se la camera accetta pan, tilt e zoom dal cavo USB (UVC), PTZ Hub la comanda anche senza rete. Lo verifica da solo e lo dice chiaramente: [dettagli](#camere-collegate-via-usb-in-prova).
- **Centro operativo per OBS, Stream Deck e tastiere macro**: pannello da agganciare in OBS, indirizzo web per ogni funzione (Stream Deck, Bitfocus Companion), tasti globali per ogni funzione e **plugin per Stream Deck** con miniatura, nome e luce «in onda» sui tasti. Tutto passa dal programma, quindi tutti vedono la stessa inquadratura attiva. Dettagli in [docs/comandi-esterni.md](docs/comandi-esterni.md).
- **Italiano e inglese**, scelti in automatico dalla lingua del sistema.

## Telecamere compatibili

Telecamere PTZ comandate via rete con protocolli standard, oppure dal cavo USB se la camera lo permette:

| Protocollo | Porta tipica | Marche |
|---|---|---|
| VISCA over IP (UDP) | 1259 | Tenveo, PTZOptics, AViPAS, BZBGear, Minrray e cloni |
| VISCA over IP (TCP) | 5678 | come sopra |
| Sony VISCA over IP | 52381 | Sony SRG/BRC e compatibili |
| ONVIF PTZ | 80 / 8000 / 8080 | molte camere IP e PTZ |
| USB (UVC) — **in prova** | cavo USB | webcam PTZ e camere che accettano pan, tilt e zoom via USB: funziona solo se la camera lo permette |

Se la camera non sa comunicare la propria posizione, le inquadrature usano le memorie interne della camera (ogni account su numerazioni diverse).

**Non ancora supportate**: telecamere comandabili solo via seriale RS-232/RS-485, Panasonic AW (protocollo HTTP proprietario). Le webcam e le camere PTZ collegate solo via USB sono **in prova**: si muovono se la camera accetta i comandi dal cavo USB, altrimenti funzionano solo per l'anteprima.

### Camere collegate via USB (in prova)
- Si sceglie al primo avvio («Camera collegata via USB?») o in Impostazioni › Telecamera › Protocollo «USB (UVC)». PTZ Hub apre la camera e dice subito se accetta pan, tilt, zoom e fuoco manuale via USB.
- Molte camere PTZ dal cavo USB mandano solo il video: in quel caso compare «Questa camera non accetta movimenti via USB» e serve il cavo di rete con VISCA o ONVIF. Se accetta solo lo zoom, si usa lo zoom e lo si dice.
- Le camere USB accettano solo posizioni assolute: joystick, frecce, pannello OBS e Stream Deck muovono la camera a piccoli passi (25 al secondo) in base alla velocità; STOP ferma subito. Le inquadrature salvano la posizione esatta nel programma (le camere USB non hanno memorie interne); Home porta pan e tilt al centro e lo zoom al minimo.
- Su Windows una camera USB di solito la può usare un solo programma alla volta: se OBS la sta già usando, PTZ Hub lo segnala («La camera USB è occupata») e suggerisce di chiudere la sorgente in OBS o di comandare la camera via rete. Su Windows 11 (24H2 e successivi) si può attivare «Consenti a più app di usare la fotocamera contemporaneamente» in Impostazioni → Bluetooth e dispositivi → Fotocamere → la camera → Opzioni avanzate: così OBS riceve il video e PTZ Hub la comanda nello stesso momento. Dentro PTZ Hub l'anteprima USB e i comandi condividono la stessa camera.
- Se il cavo si stacca la Regia mostra «La camera USB non risponde» e si ricollega da sola appena la camera torna.

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

### Stream Deck
1. Scarica `PTZ-Hub.streamDeckPlugin` dalle [Releases](https://github.com/Redmango-Agency/PTZhub/releases) e aprilo con un doppio clic.
2. In PTZ Hub › Impostazioni › Comandi esterni copia l'indirizzo del pannello OBS e incollalo in un tasto PTZ Hub di Stream Deck: computer, porta e chiave si compilano da soli.
3. Trascina sulla tastiera i tasti «Inquadratura» e «Comando». Dettagli: [streamdeck/README.md](streamdeck/README.md).

### Aggiornamenti
All'avvio e poi una volta al giorno il programma chiede a GitHub qual è l'ultima versione pubblicata. Se ce n'è una più recente compare in alto l'avviso «Scarica», che apre la pagina della release: il programma non scarica e non installa nulla da solo, così durante un evento non cambia niente. Il controllo si spegne nelle Impostazioni.

## Primo utilizzo
1. Al primo avvio il programma cerca in rete e propone la telecamera (oppure scrivi l'IP). Camera collegata solo con il cavo USB: «Camera collegata via USB? (in prova)».
2. Anteprima video: trova il flusso RTSP; scegli USB se la camera è collegata a questo computer.
3. «+ Nuova inquadratura» per creare le tue inquadrature.

## Sviluppo
Serve Node.js 22.

```bash
npm install
npm run ffmpeg:win      # ffmpeg per il pacchetto Windows (non è nel repository); Mac: node scripts/fetch-ffmpeg.js darwin-arm64
npm start
npm test                # protocolli con telecamere simulate (VISCA, ONVIF, USB), collegamento esterno, aggiornamenti
npm run dist:win        # installer e versione portatile in dist/
```

GitHub Actions crea l'installer Windows, i dmg per Mac e il plugin per Stream Deck a ogni tag `v*` e li pubblica nelle Releases, con le note prese dal registro delle novità. Il plugin è in [streamdeck/](streamdeck/). Vedi [CHANGELOG.md](CHANGELOG.md) e [CONTRIBUTING.md](CONTRIBUTING.md).

```
src/main/      driver delle telecamere (visca.js, onvif.js, uvc.js + uvc-link.js per la USB), ricerca, anteprima, dati per account,
               hub.js (centro operativo), control.js (collegamento per OBS/Stream Deck), updates.js
src/renderer/  interfaccia              src/control/  pannello per OBS
src/shared/    testi in italiano e inglese         test/  telecamere simulate e test
build/         icone, installer e script di impacchettamento
```

## Sicurezza
Vulnerabilità: segnalale in privato, vedi [SECURITY.md](SECURITY.md).

## Crediti
PTZ Hub è progettato e sviluppato da [**\*redmango**](https://redmango.agency/?utm_source=github&utm_medium=referral&utm_campaign=ptzhub), studio digitale di Torino: siti e app, pubblicità online, sistemi di intelligenza artificiale e automazioni.
Ti serve una versione su misura, un collegamento con la tua regia o il supporto per un'altra telecamera? Scrivici da [redmango.agency](https://redmango.agency/?utm_source=github&utm_medium=referral&utm_campaign=ptzhub).

## Licenza
[MIT](LICENSE) © Redmango S.r.l. — libero da usare, modificare e ridistribuire, anche in ambito commerciale.

I pacchetti includono FFmpeg (GPL v3) come programma separato per l'anteprima video, ed Electron/Chromium: dettagli in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
