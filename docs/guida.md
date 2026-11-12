# PTZ Hub — guida passo passo

Questa guida è per chi usa PTZ Hub per la prima volta, anche senza esperienza di telecamere o di reti. Se qualcosa non va, cerca qui sotto il caso che ti capita.

*English: [guide.md](guide.md)*

## Indice

- [Cosa serve prima di iniziare](#cosa-serve-prima-di-iniziare)
- [Primo avvio in 3 passi](#primo-avvio-in-3-passi)
- [La telecamera chiede utente e password](#la-telecamera-chiede-utente-e-password)
- [La telecamera non compare nell'elenco](#la-telecamera-non-compare-nellelenco)
- [Telecamera collegata con il cavo USB](#telecamera-collegata-con-il-cavo-usb)
- [Il video si vede ma la telecamera non si muove](#il-video-si-vede-ma-la-telecamera-non-si-muove)
- [Non vedo il video](#non-vedo-il-video)
- [Usare i comandi](#usare-i-comandi)
- [Le inquadrature](#le-inquadrature)
- [Nuove versioni](#nuove-versioni)
- [Serve ancora aiuto](#serve-ancora-aiuto)

## Cosa serve prima di iniziare

1. **La telecamera accesa** e collegata con il cavo di rete allo stesso router o switch del PC, oppure con il cavo USB al PC.
2. **Utente e password della telecamera**, se ne ha una: sono quelli della sua pagina web o dell'app del produttore (non quelli di Windows). Molte telecamere VISCA (Tenveo, PTZOptics e simili) non la chiedono; quasi tutte le Dahua, Hikvision, Axis e simili sì.
3. Al primo avvio Windows può chiedere se **consentire l'accesso alla rete** a PTZ Hub: scegli **Consenti** (reti private). Senza questo permesso la ricerca delle telecamere non trova niente.

## Primo avvio in 3 passi

1. **Telecamera.** PTZ Hub cerca da solo le telecamere in rete e quelle collegate via USB. Clicca su quella giusta: parte una verifica che controlla se si può muovere, se si possono salvare le posizioni esatte e se c'è il video. Quando la verifica è verde, premi **Usa questa telecamera**.
2. **Video.** Scegli da dove prendere l'anteprima: dalla rete (consigliato) o dal cavo USB. Se non ti serve l'anteprima puoi saltare.
3. **Pronto.** Salva la prima inquadratura: muovi la camera con le frecce, poi **+ Nuova inquadratura**.

Tutto si può cambiare dopo in **Impostazioni › Telecamera**.

## La telecamera chiede utente e password

Nella verifica compare **«La telecamera chiede utente e password»** con due caselle.

1. Scrivi l'**utente** (spesso è `admin`) e la **password** della telecamera. Con **Mostra** controlli di averla scritta giusta: maiuscole e minuscole contano.
2. Premi **Prova**. Se va bene compare «Accesso riuscito» e il pulsante **Usa questa telecamera** si attiva. Utente e password restano salvati con la telecamera, sul tuo PC.

**Se viene rifiutata**, i casi più comuni sono questi:

- **ONVIF è spento nella telecamera** (succede spesso anche con la password giusta). Premi **Apri la pagina della telecamera**, entra con utente e password e attiva ONVIF nelle impostazioni di rete. I nomi cambiano un po' da modello a modello:
  - **Dahua**: Impostazioni › Rete › Piattaforma di accesso (Access Platform) › ONVIF › Attiva. Se c'è «Autenticazione ONVIF», lasciala attiva (vedi sotto per la password).
  - **Hikvision**: Configurazione › Rete › Impostazioni avanzate › Protocollo di integrazione (Integration Protocol) › attiva ONVIF, poi **aggiungi un utente ONVIF** (nome e password) e usa quello in PTZ Hub.
  - **Altre marche**: cerca «ONVIF» nelle impostazioni di rete o di sicurezza.
- **Dalla pagina web entri, da PTZ Hub no** (succede spesso con le Dahua). Le cause sono quasi sempre due:
  1. **L'utente ONVIF ha una password sua.** Sulle Dahua gli utenti ONVIF sono separati da quelli della pagina web: quando si cambia la password della pagina web, quella ONVIF resta la vecchia. Entra nella pagina della telecamera, vai in Impostazioni › Sistema › Account › **Utente ONVIF**, modifica «admin» e metti la stessa password della pagina web. Sulle Hikvision va creato un utente ONVIF a parte (vedi sopra).
  2. **Data, ora o fuso orario sbagliati.** Con l'ora sbagliata (anche solo l'ora legale) alcune telecamere rifiutano la password giusta. In Impostazioni › Sistema › Generale › Data e ora scegli il fuso orario giusto e attiva la sincronizzazione automatica (NTP). Dalla versione 1.5.5 PTZ Hub prova già da solo a compensare l'ora sbagliata.

  **Non serve togliere l'autenticazione ONVIF**: lasciala attiva, altrimenti chiunque sia nella stessa rete può muovere la telecamera.
- **Utente bloccato**: dopo alcuni tentativi sbagliati molte telecamere bloccano l'utente per qualche minuto (di solito da 5 a 30). PTZ Hub lo segnala e fa pochi tentativi: aspetta, controlla la password e riprova.
- **Telecamera nuova, mai configurata**: le Dahua e le Hikvision vanno prima «attivate» scegliendo una password, dalla loro pagina web o con l'app del produttore (Dahua ConfigTool, Hikvision SADP). Poi torna su PTZ Hub e usa quella password.
- **Password dimenticata**: si reimposta sulla telecamera (tasto di reset o assistenza del produttore). PTZ Hub non può recuperarla.

Puoi inserire o cambiare utente e password anche dopo: **Impostazioni › Telecamera › Accesso**, poi **Rileva di nuovo**.

## La telecamera non compare nell'elenco

- **È accesa e collegata?** Le luci della presa di rete della telecamera devono essere accese.
- **Stessa rete del PC?** PTZ Hub cerca solo nella rete del PC (in alto vedi quale, per esempio `192.168.1.x`). Se la telecamera ha un indirizzo di un'altra rete (per esempio `192.168.0.100` mentre il PC è in `192.168.1.x`), va cambiato l'indirizzo della telecamera dalla sua app o dalla sua pagina, oppure va collegata alla stessa rete.
- **Conosci l'indirizzo?** Premi **Inserisci l'indirizzo a mano** e scrivilo (per esempio `192.168.1.108`). L'indirizzo lo trovi nell'app del produttore, nell'elenco dei dispositivi del router o sull'etichetta della telecamera.
- **Windows ha bloccato PTZ Hub?** Se al primo avvio hai scelto «Annulla» sull'avviso del firewall, la ricerca non funziona: riapri l'avviso da Impostazioni di Windows › Privacy e sicurezza › Sicurezza di Windows › Firewall › Consenti app, e attiva PTZ Hub per le reti private.

## Telecamera collegata con il cavo USB

- Premi **Camera collegata via USB?** e scegli la telecamera. Le telecamere «virtuali» (OBS Virtual Camera, Snap Camera e simili) non compaiono, perché non hanno una testa da muovere.
- **Funziona solo se la telecamera accetta i comandi via USB.** Molte PTZ dal cavo USB mandano solo il video: in quel caso la verifica lo dice e conviene collegarla con il cavo di rete.
- **Zoom, OBS e PTZ Hub insieme**: su Windows i comandi passano anche mentre Zoom o OBS usano la telecamera. L'anteprima invece la vede un solo programma alla volta: PTZ Hub lascia la precedenza a OBS e Zoom e mostra l'anteprima quando la camera è libera.
- **Movimento a scatti?** In Impostazioni › Telecamera lascia attivo **Movimento fluido via USB**: se la telecamera lo accetta, «Veloce» tenuto premuto è fluido. Il clic e «Lento» vanno sempre a passi minimi (il più piccolo spostamento che la camera fa davvero), così restano precisi anche con le camere che partono solo a una velocità alta.
- **Telecomando e PTZ Hub insieme**: se sposti la camera col telecomando, il richiamo di un'inquadratura da PTZ Hub la riporta comunque sul punto salvato (la camera può fare un piccolissimo scatto prima di arrivare: serve a farle accettare il comando). Per salvare un'inquadratura composta col telecomando usa **Salva anche la posizione**: funziona se la camera comunica via USB dove si trova; se dopo il richiamo non torna lì, ricomponila con le frecce di PTZ Hub e salvala di nuovo.

## Il video si vede ma la telecamera non si muove

- **La verifica dice «solo video» o «senza movimento»**: la telecamera risponde ma non ha comandi PTZ (è una telecamera fissa, oppure il comando è spento). Controlla nella sua pagina web che ONVIF o VISCA siano attivi.
- **VISCA spento**: su alcune telecamere (Tenveo, PTZOptics, Avonic…) il comando VISCA via rete va attivato nella pagina web della telecamera (cerca «VISCA over IP»).
- **Telecamera con password**: vedi [La telecamera chiede utente e password](#la-telecamera-chiede-utente-e-password).

## Non vedo il video

- **Via rete**: PTZ Hub prova da solo gli indirizzi video più comuni. Se non ne trova uno, in **Impostazioni › Anteprima video** puoi scegliere un altro indirizzo o scriverlo a mano (è nel manuale della telecamera, di solito inizia con `rtsp://`). Molte telecamere chiedono la password anche per il video: PTZ Hub usa la stessa della telecamera.
- **Via USB**: se Zoom o OBS stanno usando la telecamera, l'anteprima torna da sola quando la lasciano.
- L'anteprima non è obbligatoria: i comandi e le inquadrature funzionano anche senza.

## Usare i comandi

- **Cerchio con 4 frecce**: premi una volta per spostare di pochissimo (per centrare), tieni premuto per muovere. Il centro del cerchio non fa niente, così un clic sbagliato non sposta la camera in diretta.
- **Home** (piccolo, sotto STOP) riporta la camera alla posizione di partenza con lo zoom al minimo: va **tenuto premuto mezzo secondo** (si riempie una barra); un clic da solo non fa niente. Da tastiera globale, pannello OBS, Stream Deck e indirizzi web Home parte subito, come prima.
- **Lento / Veloce**: «Lento» per gli spostamenti precisi (con le camere USB va a piccoli passi regolari), «Veloce» per spostarsi molto. Anche lo zoom ha il suo Lento / Veloce.
- **STOP** (o i tasti `Esc` e `Spazio`) ferma tutto, anche un'inquadratura in arrivo.
- **Tastiera**: frecce per muovere (con Maiusc sempre lento), PagSu / PagGiù per lo zoom, `1`–`9` e `0` per le inquadrature.
- **Griglia** (tasto in basso a destra sull'anteprima): linee dei terzi e mirino al centro esatto, per capire se la persona è davvero al centro. Mentre crei o modifichi un'inquadratura si accende da sola.
- **Centra con un clic** (accanto a Griglia): attivalo e clicca sull'anteprima il punto da mettere al centro, per esempio il viso di chi parla: la camera lo porta al centro. Le prime volte corregge da sola con due o tre piccoli passi e impara quanto si sposta l'immagine a ogni livello di zoom, così le volte dopo è più precisa. In Regia si spegne da solo dopo ogni clic (un clic sull'anteprima non deve muovere la camera in diretta per sbaglio); nella modifica di un'inquadratura resta acceso. Serve l'anteprima video: se l'anteprima è spenta, o su Windows la camera USB è in uso da OBS o Zoom, i due tasti non ci sono e un messaggio lo dice.

## Le inquadrature

- **Salvare**: componi l'immagine e premi **+ Nuova inquadratura**. PTZ Hub salva la posizione esatta (destra/sinistra, su/giù, zoom e fuoco).
- **Richiamare**: clic sulla miniatura o tasti `1`–`9`, `0`. La camera va sempre in quella posizione esatta, da qualunque punto parta.
- **Modificare**: matita sulla miniatura. Aprendo la modifica la camera **non** si muove: puoi cambiare nome, ordine o eliminarla senza toccare la diretta. Per cambiare la posizione: **Porta la camera qui**, ritocca e **Salva nome e posizione**.
- **Riordinare**: trascina le miniature.
- Le miniature si aggiornano da sole con l'ultima immagine di quando le usi.

## Nuove versioni

PTZ Hub controlla da solo se c'è una versione nuova (all'avvio e ogni 6 ore) e lo segnala in alto con **Scarica la …**: si apre la pagina da cui scaricare l'installer. Non installa niente da solo.

## Serve ancora aiuto

Apri una segnalazione su GitHub con il modello della telecamera, come è collegata (rete o USB) e una foto del messaggio: <https://github.com/Redmango-Agency/PTZhub/issues>
