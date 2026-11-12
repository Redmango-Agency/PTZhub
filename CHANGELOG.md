# Novità

Tutte le versioni di PTZ Hub (fino alla 1.3 si chiamava PTZ Panel). Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e le versioni seguono il [Semantic Versioning](https://semver.org/lang/it/).

## [Non ancora pubblicata]

## [1.5.6] — 2026-11-12

### Aggiunto
- **Griglia sull'anteprima**: tasto «Griglia» in basso a destra sull'anteprima, con le linee dei terzi e un mirino al centro esatto, leggibili sia sulle immagini chiare sia su quelle scure. La scelta si ricorda; mentre crei o modifichi un'inquadratura la griglia si accende da sola.
- **Centra con un clic**: attivi il tasto e clicchi sull'anteprima il punto da mettere al centro (per esempio il viso di chi parla): la camera lo porta al centro. Funziona con le camere USB, VISCA e ONVIF che comunicano la posizione. La prima volta usa una stima del campo visivo, poi ritrova nell'immagine il punto cliccato, corregge con uno o due piccoli passi e impara quanto si sposta l'immagine a ogni livello di zoom (anche se la camera è capovolta o specchiata), così le volte dopo è più precisa. In Regia è spento all'avvio e si spegne da solo dopo ogni clic, per non muovere la camera in diretta per sbaglio; nella modifica di un'inquadratura è acceso. Senza anteprima video (spenta, o su Windows lasciata a OBS o Zoom) i tasti non compaiono e un messaggio lo dice.

### Cambiato
- **Home non è più al centro del cerchio**: veniva premuto per sbaglio e la camera si spostava in diretta. Ora il centro del cerchio non fa niente; Home è un tasto piccolo sotto STOP e parte solo **tenendolo premuto mezzo secondo** (una barra si riempie; un clic da solo mostra solo un suggerimento). Da tastiera globale, pannello OBS, Stream Deck e indirizzi web Home funziona come prima.
- **Frecce con le camere USB**: un clic sposta la camera del passo più piccolo che fa davvero (PTZ Hub controlla rileggendo la posizione: se la camera non si è mossa il passo cresce un po' e il valore buono si ricorda). Tenendo premuto in «Lento» la camera va a piccoli passi regolari, più lenta della velocità minima della camera; «Veloce» resta fluido come prima.

### Corretto
- **Camera USB: un clic sulle frecce non la muoveva e «Lento» tenuto premuto andava troppo veloce** (Tenveo). Il clic era un comando a velocità bassissima per un attimo, troppo breve perché la camera partisse, e la velocità minima della camera è comunque alta: ora clic e «Lento» non dipendono più da quella velocità.
- **Camera USB mossa col telecomando: il richiamo di un'inquadratura non sempre la riportava sul punto salvato.** Causa probabile: via USB la camera continua a dichiarare l'ultima posizione ricevuta e ignora un comando uguale a quello, quindi richiamando l'inquadratura già usata (o premendo Home due volte) non si muoveva. Ora il richiamo manda sempre pan, tilt e zoom e, per gli assi che risultano già sul punto giusto, passa prima da un valore accanto (un passo) e subito dopo da quello giusto: la camera può fare un piccolissimo scatto, ma arriva. Anche il modo del fuoco (automatico o manuale) si rimanda sempre, perché il telecomando può averlo cambiato.
- Salvataggio di un'inquadratura USB: la posizione si rilegge sempre dalla camera; se la camera non la comunica compare un errore invece di salvare coordinate forse vecchie.
- Muovere la camera a mano nell'app (frecce tenute, zoom, fuoco) ora interrompe anche un richiamo VISCA o ONVIF in corso, come già STOP e Home: prima zoom e fuoco dell'inquadratura potevano arrivare dopo. Un impulso dallo Stream Deck non ferma più a metà un movimento fatto a mano nell'app.

## [1.5.5] — 2026-11-08

### Corretto
- **Telecamere Dahua (e simili) con autenticazione ONVIF attiva**: la password giusta, la stessa che apre la pagina web, poteva essere rifiutata («Sender not Authorized») per colpa dell'orologio della telecamera: l'ora che dichiara non è quella con cui controlla l'accesso (fuso orario o ora legale sbagliati). Ora PTZ Hub prova da solo, con pochi tentativi, i modi di accesso che funzionano anche in questi casi (ora del PC, ora locale della telecamera, Digest HTTP) e si ricorda quello buono per ogni telecamera, così ai collegamenti successivi entra al primo colpo. Non serve più togliere l'autenticazione ONVIF.
- Con la password rifiutata PTZ Hub riprova da solo ogni 2 minuti invece che ogni 5 secondi, e non ripete i tentativi per cercare il video: molte telecamere bloccano l'utente dopo pochi errori. Se la telecamera ha bloccato l'utente, il messaggio lo dice e spiega di aspettare qualche minuto.

### Aggiunto
- Primo avvio, password rifiutata: compare la risposta esatta della telecamera (utile per l'assistenza) e due consigli nuovi: sulle Dahua l'utente ONVIF ha una password sua, che non cambia quando si cambia quella della pagina web (Impostazioni › Sistema › Account › Utente ONVIF); controllare data, ora e fuso orario della telecamera. Anche la guida spiega questi casi.

## [1.5.4] — 2026-11-08

### Aggiunto
- **Telecamere con password nel primo avvio** (Dahua, Hikvision e simili): se la telecamera chiede utente e password compare un riquadro dove scriverli e provarli subito, senza passare dalle Impostazioni. Se vengono rifiutati, si aprono i consigli: ONVIF spento (dove attivarlo su Dahua e Hikvision), telecamera nuova da attivare, password dimenticata, e un pulsante per aprire la pagina web della telecamera. Lo stesso riquadro compare se è il video a chiedere la password. Utente e password accettati vengono salvati con la telecamera.
- **Guida passo passo** per chi usa PTZ Hub per la prima volta ([docs/guida.md](docs/guida.md), in inglese [docs/guide.md](docs/guide.md)), raggiungibile dal primo avvio con «Serve aiuto?»: password, telecamera che non compare, USB, video, comandi, inquadrature.

### Corretto
- Le telecamere virtuali (OBS Virtual Camera, Snap Camera, NVIDIA Broadcast e simili) non compaiono più tra le telecamere USB da comandare; nelle Impostazioni sono in fondo, segnate come virtuali.
- Telecamera ONVIF senza movimento: la verifica dice «telecamera senza movimento, solo video» invece di «non risponde».
- Impostazioni › Telecamera: se la telecamera chiede la password, il messaggio porta direttamente alle caselle di «Accesso».

## [1.5.3] — 2026-11-08

### Cambiato
- **Movimento fine**: «Lento» ora muove la camera alla velocità più bassa, per centrare con precisione; «Veloce» è quello che prima era il lento. Vale per le frecce a schermo e da tastiera (Maiusc = sempre lento).
- **Camera USB su Windows: movimento fluido** se la camera accetta i comandi a velocità (gli stessi del telecomando): niente più scatti di un grado alla volta, e un clic sposta di pochissimo. Se la camera non li accetta si continua a passi, e un avviso lo dice. Si può spegnere in Impostazioni › Telecamera › «Movimento fluido via USB». Per sicurezza la camera si ferma da sola se PTZ Hub smette di confermare il movimento o si chiude.
- **Avviso di nuova versione più pronto**: il controllo parte 3 secondi dopo l'avvio (prima 20), poi ogni 6 ore e quando torni sulla finestra dopo almeno un'ora; se non riesce si riprova dopo 15 minuti. Oltre al tasto «Scarica» in alto compare un avviso, visibile anche nella vista Compatta.

### Corretto
- **Inquadrature via USB che andavano solo in orizzontale**: alcune camere, mentre la testa si muove, scartano il secondo valore (l'altezza). Ora, se la camera si ferma senza essere arrivata, PTZ Hub rimanda un asse alla volta finché non è sul punto salvato: basta un clic.

## [1.5.2] — 2026-11-05

### Corretto
- **Camera USB non rilevata su Windows con la 1.5.1**: torna il modo di aprire la camera della 1.5.0 (senza il comando unico per pan e tilt aggiunto nella 1.5.1, la causa più probabile). Restano le correzioni della 1.5.1: prima di muoverla si rilegge la posizione vera e l'asse fermo non salta. Se la camera USB non si collega, un avviso dice la causa precisa (codice di Windows).
- **I comandi non scorrono più**: l'avviso «la telecamera non risponde» sta sopra l'anteprima invece di spingere giù i comandi; nelle finestre basse il cerchio si rimpicciolisce e, se serve, la colonna dei comandi scende accanto alle inquadrature.
- Tasti del cerchio un po' più scuri, visibili anche su schermi poco contrastati.

## [1.5.1] — 2026-11-05

### Corretto
- **Camera USB mossa col telecomando (o da OBS)**: le frecce partivano dall'ultima posizione conosciuta da PTZ Hub, quindi un clic su «Lento» poteva far saltare la camera di molto, e la freccia a destra poteva spostarla anche in su. Ora prima di muoverla PTZ Hub rilegge dove si trova davvero, e l'asse fermo resta fermo.
- **Modificare un'inquadratura non muove più la camera**: aprendo la modifica si possono cambiare nome e ordine o eliminarla senza toccare la diretta. «Porta la camera qui» la sposta sulla posizione salvata per ritoccarla; «Salva nome e posizione» compare solo dopo che la camera si è mossa.

## [1.5.0] — 2026-11-05

### Aggiunto
- **Cerchio con 4 frecce al posto del joystick**: premi = la camera si sposta di poco, per centrare l'inquadratura; tieni premuto = si muove. Home al centro del cerchio, STOP subito sotto. **Lento / Veloce** per il movimento e, a parte, per lo zoom (se la camera ha velocità variabili; altrimenti va alla sua). Le frecce della tastiera funzionano allo stesso modo, con Maiusc sempre lento. Zoom con «− Allarga» e «Avvicina +», fuoco rapido con «Metti a fuoco».
- **Miniature che si aggiornano con l'uso**: quando la camera arriva su un'inquadratura e nessuno la sposta a mano, la miniatura prende l'ultima immagine dell'anteprima.
- **Comando via cavo USB (UVC)**: terzo protocollo accanto a VISCA e ONVIF per le camere collegate al PC solo con il cavo USB. Funziona solo se la camera accetta pan, tilt e zoom via USB: PTZ Hub lo verifica nel primo avvio («Camera collegata via USB?») e in Impostazioni › Telecamera e mostra l'esito (pan, tilt, zoom e fuoco manuale: sì/no).
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

[Non ancora pubblicata]: https://github.com/Redmango-Agency/PTZhub/compare/v1.5.6...HEAD
[1.5.6]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.5.6
[1.5.5]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.5.5
[1.5.4]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.5.4
[1.5.3]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.5.3
[1.5.2]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.5.2
[1.5.1]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.5.1
[1.5.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.5.0
[1.4.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.4.0
[1.3.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.3.0
[1.2.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.2.0
[1.1.0]: https://github.com/Redmango-Agency/PTZhub/releases/tag/v1.1.0
