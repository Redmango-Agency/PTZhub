# Novità

Tutte le versioni di PTZ Hub (fino alla 1.3 si chiamava PTZ Panel). Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e le versioni seguono il [Semantic Versioning](https://semver.org/lang/it/).

## [Non ancora pubblicata]

## [1.5.0] — 2026-10-31

### Aggiunto
- **Cerchio con 4 frecce al posto del joystick**: premi = la camera si sposta di poco, per centrare l'inquadratura; tieni premuto = si muove. Home al centro del cerchio, STOP subito sotto. **Lento / Veloce** per il movimento e, a parte, per lo zoom (se la camera ha velocità variabili; altrimenti va alla sua). Le frecce della tastiera funzionano allo stesso modo, con Maiusc sempre lento. Zoom con «− Allarga» e «Avvicina +», fuoco rapido con «Metti a fuoco».
- **Miniature che si aggiornano con l'uso**: quando la camera arriva su un'inquadratura e nessuno la sposta a mano, la miniatura prende l'ultima immagine dell'anteprima.
- **Comando via cavo USB (UVC), in prova**: terzo protocollo accanto a VISCA e ONVIF per le camere collegate al PC solo con il cavo USB. Funziona solo se la camera accetta pan, tilt e zoom via USB: PTZ Hub lo verifica nel primo avvio («Camera collegata via USB?») e in Impostazioni › Telecamera e mostra l'esito (pan, tilt, zoom e fuoco manuale: sì/no).
- Con la camera USB funzionano Regia, editor delle inquadrature, viste Compatta e Laterale, pannello OBS, indirizzi web, tasti globali e plugin Stream Deck: il movimento continuo è fatto di piccoli passi assoluti (25 al secondo), le inquadrature salvano la posizione esatta, Home porta al centro con lo zoom al minimo, STOP ferma subito anche un richiamo a metà strada.
- Avvisi chiari per la camera USB: «non accetta movimenti via USB» (con il consiglio di usare il cavo di rete e VISCA/ONVIF), «solo zoom», «occupata» (su Windows di solito da OBS: chiudi lì la sorgente, comanda la camera via rete oppure, su Windows 11, consenti a più app di usare la fotocamera), «non risponde» quando il cavo si stacca, con nuovo collegamento automatico.

### Cambiato
- **Inquadrature sempre nella posizione salvata (camera USB)**: il richiamo manda subito pan, tilt e zoom salvati, qualunque sia la posizione di partenza, e controlla che la camera ci arrivi; se la camera scarta il comando mentre si muove, lo rimanda.
- **Anteprima USB che lascia il posto a OBS e Zoom (Windows)**: senza OBS l'anteprima si vede; appena si apre OBS (o Zoom, Teams… usano la camera) si mette in pausa e la camera resta a loro; quando la camera si libera l'anteprima torna da sola. Se la camera è occupata si riprova ogni pochi secondi. I comandi funzionano sempre.
- **Viste Compatta e Laterale solo con le inquadrature**: Home e STOP restano nel cerchio delle frecce della vista completa (STOP sempre anche con Esc e Spazio).
- **Modifica delle inquadrature**: «Salva solo il nome» cambia il nome senza toccare la posizione; «Salva nome e posizione» salva anche la nuova inquadratura; l'ordine (e quindi il tasto) si cambia trascinando le miniature.
- **Camera USB su Windows insieme a OBS o Zoom**: PTZ Hub muove la camera senza aprirne il video, con la funzione di Windows per i comandi della camera (la stessa della scheda «Controllo telecamera» di OBS). OBS o Zoom continuano a usare il video, anche su Windows 10, senza impostazioni da cambiare; l'anteprima in PTZ Hub è spenta di default per le camere USB.
- **Primo avvio**: la procedura guidata cerca insieme le camere in rete e quelle collegate via USB; se in rete non c'è nessuna camera e c'è una sola camera USB, verifica subito se accetta pan, tilt e zoom.
- **Ricerca delle telecamere più precisa**: compaiono solo i dispositivi che rispondono come telecamere (VISCA via UDP, Sony o TCP, RTSP oppure ONVIF). Router, telefoni VoIP, stampanti e altri servizi con la sola pagina web non compaiono più.
- I testi sull'anteprima USB non dicono più che i movimenti passano sempre dalla rete: via USB funzionano se la camera lo permette.
- Un richiamo interrotto direttamente dalla camera (per esempio dalle frecce della Regia) non resta più segnato «In arrivo».

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

[Non ancora pubblicata]: https://github.com/Redmango-Agency/PTZhub/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.5.0
[1.4.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.4.0
[1.3.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.3.0
[1.2.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.2.0
[1.1.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.1.0
