# Novità

Tutte le versioni di PTZ Panel. Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e le versioni seguono il [Semantic Versioning](https://semver.org/lang/it/).

## [Non ancora pubblicata]

### In arrivo nella 1.4
- Interfaccia chiara completa: Regia, editor, impostazioni a sezioni, primo avvio guidato.
- Vista **Compatta** (colonna sempre in primo piano) e **Laterale** (linguetta sul bordo dello schermo che si apre col mouse), a destra o a sinistra.
- Plugin per **Stream Deck** con miniatura, nome e luce «in onda» sui tasti.

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

[Non ancora pubblicata]: https://github.com/Redmango-Agency/PTZhub/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.3.0
[1.2.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.2.0
[1.1.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.1.0
