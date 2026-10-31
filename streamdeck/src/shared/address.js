// Indirizzo di PTZ Hub: impostazioni globali del plugin e lettura dell'indirizzo
// del pannello OBS incollato dall'utente (http://127.0.0.1:8765/obs?k=CHIAVE).
// Usato sia dal plugin (Node) sia dal Property Inspector (browser): niente API di Node qui.

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8765;

const stripBrackets = (h) => h.replace(/^\[(.*)\]$/, '$1');

/** Impostazioni globali complete e pulite: { host, port, key }. */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let host = stripBrackets(String(src.host ?? '').trim());
  if (!host) host = DEFAULT_HOST;
  let port = Number.parseInt(String(src.port ?? '').trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) port = DEFAULT_PORT;
  const key = String(src.key ?? '').trim();
  return { host, port, key };
}

export function sameConfig(a, b) {
  return !!a && !!b && a.host === b.host && a.port === b.port && a.key === b.key;
}

/**
 * Legge host, porta e chiave da un indirizzo copiato da PTZ Hub: il pannello OBS
 * (…/obs?k=…) o qualsiasi indirizzo dei comandi (…/api/stop?k=…).
 * Accetta anche l'indirizzo senza "http://" e tra virgolette. Senza chiave ritorna null.
 */
export function parsePanelAddress(text) {
  let s = String(text ?? '').trim().replace(/^["'<\s]+|["'>\s]+$/g, '');
  if (!s) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!hasScheme) s = `http://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const key = (url.searchParams.get('k') || '').trim();
  if (!key) return null;
  const host = stripBrackets(url.hostname);
  if (!host) return null;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  return { host, port, key };
}

/** Indirizzo a cui collegarsi: "localhost" diventa 127.0.0.1, dove ascolta PTZ Hub. */
export function connectHost(host) {
  return String(host).toLowerCase() === 'localhost' ? '127.0.0.1' : host;
}

/** Valore dell'intestazione Host: PTZ Hub accetta solo 127.0.0.1:<porta>, localhost:<porta> o [::1]:<porta> in modalità locale. */
export function hostHeader(host, port) {
  const h = connectHost(host);
  return `${h.includes(':') ? `[${h}]` : h}:${port}`;
}

/** Forma breve da mostrare: 127.0.0.1:8765 */
export function displayAddress(cfg) {
  const h = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  return `${h}:${cfg.port}`;
}
