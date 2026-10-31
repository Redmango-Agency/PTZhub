# Novità

Tutte le versioni di PTZ Hub (fino alla 1.3 si chiamava PTZ Panel). Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e le versioni seguono il [Semantic Versioning](https://semver.org/lang/it/).

## [Non ancora pubblicata]

## [1.4.0] — 2026-10-31

### Cambiato
- Il programma si chiama **PTZ Hub**. Al primo avvio impostazioni e inquadrature di PTZ Panel vengono copiate in automatico; l'installer sostituisce la versione precedente.
- Nuova icona e nuovo logo.
- Interfaccia chiara rifatta da capo: Regia, editor delle inquadrature, impostazioni a pagina intera in cinque sezioni (Telecamera, Anteprima video, Inquadrature, Comandi esterni, Generale).

### Aggiunto
- **Primo avvio guidato** in tre passi: trova la telecamera, l'anteprima video, tutto pronto.
- Vista **Compatta**: colonna sempre in primo piano con inquadrature, Home e STOP, agganciata al lato scelto.
- Vista **Laterale**: linguetta sul bordo sinistro o destro dello schermo che si apre al passaggio del mouse.
- **Plugin per Stream Deck** con miniatura, nome e luce «in onda» sui tasti, più i comandi (STOP, Home, successiva/precedente, zoom, fuoco).
- Avviso «La telecamera non risponde» con «Riprova ora»; Regia vuota con «Crea la prima inquadratura»; schermata dei tasti rapidi.
- Miniature senza foto: segnaposto con il numero dell'inquadratura.
- Conferma prima di importare inquadrature; filtro «Con tasto» in Funzioni e tasti.
- Collegamento esterno: lo stato indica anche l'inquadratura in arrivo e la versione di PTZ Hub.

## [1.3.0] — 2026-10-31

### Aggiunto
- Centro operativo unico: app, pannello OBS, indirizzi web e tasti globali passano tutti dal programma e vedono la stessa inquadratura attiva.
- Pannello da agganciare in OBS (*Pannelli browser personalizzati*), aggiornato in tempo reale.
- Indirizzi web per ogni funzione (Stream Deck azione «Sito web», Bitfocus Companion) e tasti globali assegnabili, anche F13–F24 per le tastiere macro.
- Avviso quando su GitHub esce una nuova versione (non scarica e non installa nulla da solo).
- Versione per Mac di prova (dmg non firmato).

### Sicurezza e affidabilità
- STOP, Home o un comando manuale interrompono un richiamo in corso; i movimenti a impulso e quelli dal pannello OBS si fermano sempre.
- Durante la modifica di un'inquadratura i comandi da fuori aspettano; STOP passa sempre.
- Collegamento locale protetto da una chiave per account e dal controllo del nome host.

## [1.2.0] — 2026-10-31

### Aggiunto
- Interfaccia in italiano e inglese, scelta in automatico da Windows.
- Installer in italiano e inglese.
- Licenza MIT.

## [1.1.0] — 2026-10-31

### Aggiunto
- Prima versione pubblica: controllo VISCA over IP (UDP, TCP, Sony) e ONVIF, anteprima RTSP con ffmpeg, joystick, zoom e fuoco.
- Inquadrature con editor dedicato, salvate per ogni account Windows, con esportazione e importazione.
- Ricerca automatica della telecamera e del flusso video, installer per Windows.

[Non ancora pubblicata]: https://github.com/Redmango-Agency/PTZhub/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.4.0
[1.3.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.3.0
[1.2.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.2.0
[1.1.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.1.0
