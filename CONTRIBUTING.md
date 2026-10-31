# Contribuire a PTZ Hub

Grazie dell'interesse! *English speakers are welcome: issues and pull requests in English are fine.*

## Hai provato una telecamera?
È il contributo più utile. Apri una *Issue* con il modello «Telecamera provata» indicando marca, modello, protocollo rilevato e cosa funziona (movimento, zoom, fuoco, posizione esatta, anteprima video).

## Segnalare un problema
Usa il modello «Problema» e allega, se puoi, il file `errori.log` dalla cartella dati (Impostazioni › Generale › Cartella dati).

## Sviluppo
Serve Node.js 22.

```bash
npm install
npm run ffmpeg:win        # oppure: node scripts/fetch-ffmpeg.js darwin-arm64
npm start
npm test                  # protocolli con telecamere simulate (VISCA, ONVIF, USB), collegamento esterno, aggiornamenti
```

- Testi dell'interfaccia: sempre in italiano **e** inglese in `src/shared/i18n.js`.
- Sicurezza della camera prima di tutto: ogni movimento deve potersi fermare con STOP e fermarsi da solo se il comando si interrompe.
- Prima di una pull request: `npm test` deve passare.

## Licenza
Contribuendo accetti che il tuo codice sia distribuito con la [licenza MIT](LICENSE) del progetto.
