// Manifest del plugin e testi tradotti (en.json, it.json), scritti da scripts/build.mjs.
// Nota: Stream Deck oggi non ha l'italiano tra le lingue dell'app (de, en, es, fr, ja, ko, zh_CN, zh_TW):
// it.json è pronto ma verrà usato solo se Elgato lo aggiungerà. Il manifest è in inglese,
// la lingua che Stream Deck usa quando non trova un file per la sua lingua.

export const PLUGIN_UUID = 'agency.redmango.ptzhub';
export const SD_PLUGIN_DIR = `${PLUGIN_UUID}.sdPlugin`;

const TEXT = {
  en: {
    Name: 'PTZ Hub',
    Description: 'Recall PTZ Hub presets and control the camera from Stream Deck: live preset thumbnails, active preset highlighted, STOP, Home, zoom and small moves.',
    preset: {
      Name: 'Preset',
      Tooltip: 'Recalls a PTZ Hub preset. The key shows its thumbnail and a red ring when it is the active one.',
    },
    command: {
      Name: 'Command',
      Tooltip: 'STOP, Home, next/previous preset, zoom, small moves and one-push focus.',
    },
  },
  it: {
    Name: 'PTZ Hub',
    Description: 'Richiama le inquadrature di PTZ Hub e comanda la telecamera da Stream Deck: miniature aggiornate, inquadratura attiva evidenziata, STOP, Home, zoom e piccoli spostamenti.',
    preset: {
      Name: 'Inquadratura',
      Tooltip: 'Richiama un’inquadratura di PTZ Hub. Il tasto mostra la miniatura e un anello rosso quando è quella attiva.',
    },
    command: {
      Name: 'Comando',
      Tooltip: 'STOP, Home, inquadratura successiva/precedente, zoom, piccoli spostamenti e fuoco rapido.',
    },
  },
};

export function manifest(version) {
  const en = TEXT.en;
  return {
    $schema: 'https://schemas.elgato.com/streamdeck/plugins/manifest.json',
    UUID: PLUGIN_UUID,
    Name: en.Name,
    Version: version,
    Author: 'Redmango',
    Description: en.Description,
    Icon: 'imgs/plugin/icon',
    Category: 'PTZ Hub',
    CategoryIcon: 'imgs/plugin/category',
    CodePath: 'bin/plugin.js',
    PropertyInspectorPath: 'ui/pi.html',
    SDKVersion: 2,
    Software: { MinimumVersion: '6.5' },
    OS: [
      { Platform: 'mac', MinimumVersion: '12' },
      { Platform: 'windows', MinimumVersion: '10' },
    ],
    Nodejs: { Version: '20' },
    Actions: [
      {
        UUID: `${PLUGIN_UUID}.preset`,
        Name: en.preset.Name,
        Tooltip: en.preset.Tooltip,
        Icon: 'imgs/actions/preset/icon',
        Controllers: ['Keypad'],
        SupportedInMultiActions: true,
        States: [{ Image: 'imgs/actions/preset/key', ShowTitle: false }],
      },
      {
        UUID: `${PLUGIN_UUID}.command`,
        Name: en.command.Name,
        Tooltip: en.command.Tooltip,
        Icon: 'imgs/actions/command/icon',
        Controllers: ['Keypad'],
        SupportedInMultiActions: true,
        States: [{ Image: 'imgs/actions/command/key', ShowTitle: false }],
      },
    ],
  };
}

/** Contenuto di <lingua>.json */
export function localization(lang) {
  const x = TEXT[lang];
  return {
    Name: x.Name,
    Description: x.Description,
    [`${PLUGIN_UUID}.preset`]: { Name: x.preset.Name, Tooltip: x.preset.Tooltip },
    [`${PLUGIN_UUID}.command`]: { Name: x.command.Name, Tooltip: x.command.Tooltip },
  };
}

export const LANGUAGES = Object.keys(TEXT);
