# PTZ Hub per Stream Deck

Plugin per Elgato Stream Deck (Windows e macOS) che comanda la telecamera **passando da PTZ Hub**:
i tasti richiamano le inquadrature e mostrano la loro miniatura, l'inquadratura attiva si accende
con un anello rosso, e ci sono i comandi STOP, Home, successiva/precedente, zoom, piccoli spostamenti
e fuoco rapido. Lo stato è quello di PTZ Hub, in tempo reale: se richiami un'inquadratura dal
programma, da OBS o da un altro tasto, lo Stream Deck si aggiorna da solo.

## Installazione

1. Serve Stream Deck 6.5 o successivo (Windows 10+ o macOS 12+).
2. Fai doppio clic su **`PTZ-Hub.streamDeckPlugin`** (si trova in `streamdeck/dist/` dopo `npm run pack`).
   Stream Deck chiede conferma e installa il plugin: nell'elenco delle azioni compare la categoria **PTZ Hub**.
3. PTZ Hub deve essere **aperto**, con il collegamento esterno attivo
   (Impostazioni › Comandi esterni; è attivo di base).

Per aggiornare il plugin basta fare doppio clic sulla versione nuova.

## Collegare il plugin a PTZ Hub (una volta sola)

1. In PTZ Hub apri **Impostazioni › Comandi esterni** e, in **Pannello in OBS**, premi **Copia**.
   L'indirizzo è simile a `http://127.0.0.1:8765/obs?k=XXXXXXXXXXXX`:
   la parte dopo `k=` è la **chiave** del tuo account.
2. In Stream Deck trascina un tasto PTZ Hub su un pulsante e, nelle impostazioni del tasto (in basso),
   incolla l'indirizzo nel campo **Indirizzo OBS** (*Indirizzo del pannello OBS, incollalo da PTZ Hub*).
   Host, Porta e Chiave si compilano da soli e il plugin prova subito il collegamento.
3. La riga sotto **Prova collegamento** deve diventare verde: «Collegato a PTZ Hub (127.0.0.1:8765) · N inquadrature».

Il collegamento vale per tutti i tasti. Se in PTZ Hub premi **Nuova chiave**, ricopia l'indirizzo
nel plugin: la chiave vecchia smette di funzionare.

## Configurare i tasti

**Inquadratura** (nell'elenco di Stream Deck si chiama *Preset*, vedi «Lingua» più sotto)
- Scegli l'inquadratura dall'elenco (`1 · Palco`, `2 · Relatore`, …): l'elenco arriva da PTZ Hub.
- Premendo il tasto la telecamera va su quell'inquadratura; il segno di conferma compare quando è arrivata.
- Cosa mostra il tasto:
  - la miniatura dell'inquadratura, il nome in basso e il numero in alto a sinistra;
  - un **anello rosso** quando è l'inquadratura attiva;
  - senza miniatura: fondo grigio scuro con il numero grande;
  - una **matita arancione** mentre in PTZ Hub si sta modificando un'inquadratura: in quel momento
    i richiami sono sospesi e premendo il tasto compare il triangolo di avviso;
  - **«?»** se l'inquadratura è stata eliminata in PTZ Hub: scegline un'altra;
  - fondo grigio con un triangolo giallo e «PTZ Hub» se PTZ Hub non è raggiungibile (vedi Problemi).

**Comando** (*Command*)
- Scegli il comando: STOP, Home, Inquadratura successiva/precedente, Fuoco rapido, Zoom +/−,
  Su/Giù/Sinistra/Destra (piccolo spostamento che si ferma da solo).
- STOP è rosso e funziona sempre, anche durante la modifica di un'inquadratura.
- Dopo la pressione compare il segno di conferma se PTZ Hub ha eseguito il comando, il triangolo
  di avviso se l'ha rifiutato.

Il titolo di Stream Deck è nascosto perché il nome è già disegnato sul tasto; se vuoi, puoi
riattivarlo dalle impostazioni del titolo.

### Lingua

I testi sui tasti e nelle impostazioni seguono la lingua di PTZ Hub (italiano o inglese).
Stream Deck invece non ha l'italiano tra le sue lingue: i nomi delle azioni nel suo elenco restano
in inglese (*Preset*, *Command*). Il plugin contiene già la traduzione italiana, che Stream Deck
userà se un giorno aggiungerà l'italiano.

## Problemi

| Cosa vedi | Cosa fare |
|---|---|
| Tasti grigi con triangolo e «PTZ Hub · non raggiungibile» | PTZ Hub è chiuso o il collegamento esterno è disattivato: apri PTZ Hub e controlla Impostazioni › Comandi esterni. Controlla anche che la porta nel plugin sia quella di PTZ Hub (di base 8765). I tasti tornano da soli entro 10 secondi da quando PTZ Hub risponde (subito con **Prova collegamento**). |
| «chiave errata» | La chiave è cambiata o è stata copiata male: ricopia l'indirizzo del pannello OBS da PTZ Hub e incollalo di nuovo. |
| «manca la chiave» | Il plugin non è ancora collegato: incolla l'indirizzo del pannello OBS (vedi sopra). |
| «non consentito» | Stream Deck è su un altro computer ma PTZ Hub accetta solo richieste dallo stesso PC: vedi sotto. |
| «Sulla porta … risponde un altro programma» | La porta è usata da un altro programma: cambia la porta in PTZ Hub e ricopia l'indirizzo. |
| Triangolo dopo la pressione | PTZ Hub ha rifiutato il comando: c'è una modifica in corso, l'inquadratura non esiste più o la telecamera non è configurata. |

**Stream Deck su un altro computer.** Di base PTZ Hub accetta comandi solo dallo stesso PC.
Solo se Stream Deck gira su un altro computer: in PTZ Hub, Impostazioni › Comandi esterni › Rete e sicurezza,
attiva **«Accetta comandi da altri dispositivi»**, poi nel plugin scrivi in **Host** l'indirizzo IP
del computer con PTZ Hub (es. `192.168.1.20`; l'indirizzo copiato contiene `127.0.0.1`, che va sostituito).
Se il firewall chiede il permesso per PTZ Hub, consentilo sulla rete privata. Usalo solo su una rete fidata:
la chiave viaggia in chiaro.

**Log.** Se qualcosa non torna, i log del plugin sono nella cartella del plugin, sottocartella `logs`:
- Windows: `%appdata%\Elgato\StreamDeck\Plugins\agency.redmango.ptzhub.sdPlugin\logs`
- macOS: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/agency.redmango.ptzhub.sdPlugin/logs`

## Per chi sviluppa

```bash
cd streamdeck
npm install
npm run build   # crea agency.redmango.ptzhub.sdPlugin/
npm test        # build + test (PTZ Hub finto, Stream Deck finto, server vero dell'app)
npm run pack    # build + streamdeck validate + dist/PTZ-Hub.streamDeckPlugin
```

- `src/plugin/` — plugin Node.js (SDK `@elgato/streamdeck` 2.x, manifest `SDKVersion` 2, Node 20):
  `connection.js` (un solo collegamento per tutti i tasti: eventi SSE da `/api/events`, riconnessione
  1 s → 10 s, miniature in memoria per id+v, comandi), `keys.js` (disegno e pressioni), `images.js`
  (SVG 144×144 dei tasti), `pi-bridge.js` (messaggi con il Property Inspector), `plugin.js` (collegamento all'SDK).
- `src/pi/` — Property Inspector (componenti sdpi v4, copiati in `vendor/` per funzionare senza internet).
- `src/shared/` — codice comune a plugin e Property Inspector (lettura dell'indirizzo, comandi, testi it/en).
- `src/manifest.js` — manifest e traduzioni (`en.json`, `it.json`); `scripts/icons.mjs` — icone ricavate dal
  marchio in `assets/brand/` (icona del plugin in PNG generata con resvg-wasm, le altre in SVG bianco).
- Il plugin usa solo le API pubbliche di PTZ Hub descritte in `docs/comandi-esterni.md`, con la chiave
  nell'intestazione `x-ptz-key`. Per provarlo in Stream Deck senza impacchettarlo: `npx streamdeck link agency.redmango.ptzhub.sdPlugin`.
