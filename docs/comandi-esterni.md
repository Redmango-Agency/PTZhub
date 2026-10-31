# Comandi esterni — OBS, Stream Deck, Companion, tastiere macro

*English summary at the end.*

PTZ Hub è il **centro operativo**: tiene la connessione alla telecamera e le inquadrature dell'account. OBS, Stream Deck e tastiere macro sono telecomandi che passano sempre dal programma, così lo stato è lo stesso ovunque (l'inquadratura attiva si accende in tutti).

Tutto si configura in **Impostazioni › Comandi esterni**. Il programma deve essere aperto.

## Pannello in OBS

1. In PTZ Hub copia l'**Indirizzo per il pannello di OBS**.
2. In OBS: **Pannelli › Pannelli browser personalizzati**, incolla l'indirizzo, dai un nome (es. «Telecamera») e applica.

Il pannello mostra le inquadrature con miniatura, quella attiva, STOP, Home, successiva/precedente e i comandi manuali (joystick e zoom).

## Stream Deck, Companion e simili

**Impostazioni › Funzioni e tasti…** elenca tutte le funzioni con il pulsante **Copia indirizzo**.

- **Stream Deck**: azione *Sistema › Sito web*, incolla l'indirizzo e attiva l'opzione per l'accesso in background (richiesta GET senza aprire il browser).
- **Bitfocus Companion**: modulo *Generic HTTP*, azione GET con l'indirizzo.

Gli indirizzi contengono la chiave dell'account (`k=…`). «Nuova chiave» la cambia: gli indirizzi vecchi smettono di funzionare.

## Tastiere macro

In **Funzioni e tasti…** premi **Assegna** accanto alla funzione e poi la combinazione da usare. Serve Ctrl o Alt (es. `Ctrl+Alt+Maiusc+A`), oppure un tasto F13–F24 da solo. Poi programma la tastiera macro perché invii quella combinazione. I tasti funzionano anche quando PTZ Hub non è in primo piano.

## Elenco indirizzi

Base: `http://127.0.0.1:8765/api/…?k=CHIAVE` (GET o POST). Rispondono in JSON: `{"ok":true}` oppure `{"ok":false,"error":"…"}`.

| Indirizzo | Funzione |
|---|---|
| `/api/recall/1` … `/api/recall/N` | richiama l'inquadratura per numero (ordine della griglia) |
| `/api/recall/id/<id>` | richiama per identificativo (non cambia se riordini) |
| `/api/next`, `/api/prev` | inquadratura successiva / precedente |
| `/api/stop`, `/api/home` | STOP, posizione Home |
| `/api/nudge/up\|down\|left\|right?ms=300&speed=0.5` | piccolo spostamento che si ferma da solo |
| `/api/zoom/in\|out?ms=300` | zoom a impulso |
| `/api/onepush` | fuoco rapido |
| `/api/move?x=&y=&z=` | movimento continuo (da −1 a 1); va ripetuto almeno ogni 700 ms, altrimenti si ferma |
| `/api/state` | stato: camera, inquadratura attiva, elenco |
| `/api/events` | stato in tempo reale (Server-Sent Events) |
| `/api/presets/<id>/thumb` | miniatura JPEG |

Durante la modifica di un'inquadratura nel programma i richiami, Home, impulsi e movimenti che arrivano da fuori vengono rifiutati (risposta 409), per non spostare la camera mentre la stai componendo. STOP funziona sempre.

Se durante un richiamo arriva STOP, Home, un comando manuale o un altro richiamo, quello in corso si interrompe: la risposta è `{"ok": true, "superseded": true}` e l'inquadratura non diventa attiva.

In `/api/state`, `activeIndex` conta da 1 come `/api/recall/<n>` (0 = nessuna inquadratura attiva).

## Sicurezza

- Di base il collegamento accetta solo richieste dallo stesso PC (`127.0.0.1`).
- «Accetta comandi anche da altri dispositivi in rete» lo apre alla rete locale (tablet, secondo PC): la chiave resta obbligatoria.
- Le pagine web aperte nel browser non possono comandare la camera senza la chiave.

---

## English summary

PTZ Hub is the control centre; OBS, Stream Deck, Companion and macro keyboards are remotes that go through it. Settings › External control shows the **OBS dock address** (OBS: Docks › Custom Browser Docks) and **Functions and keys…**, where every function has a copyable URL (Stream Deck “Website” action with background access, Companion Generic HTTP GET) and an assignable global key (Ctrl/Alt combination or F13–F24 for macro keyboards). Endpoints are listed in the table above; all require the account key `k=…`. By default only requests from the same PC are accepted.
