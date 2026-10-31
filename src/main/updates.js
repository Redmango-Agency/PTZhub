'use strict';
// Controllo aggiornamenti: legge l'ultima release pubblicata su GitHub e la confronta
// con la versione installata. Non scarica e non installa nulla: avvisa e apre la pagina
// di download, così durante un evento non cambia mai niente da solo.

const API_BASE = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
}

// > 0 se a è più recente di b; una pre-release viene prima della versione finale
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// "owner/nome" dal package.json: campo ptzPanel.updateRepo oppure repository su GitHub
function repoFromPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return '';
  const candidates = [];
  if (pkg.ptzPanel && pkg.ptzPanel.updateRepo) candidates.push(pkg.ptzPanel.updateRepo);
  const r = pkg.repository;
  if (typeof r === 'string') candidates.push(r);
  else if (r && typeof r.url === 'string') candidates.push(r.url);
  for (const c of candidates) {
    const s = String(c).trim()
      .replace(/^github:/i, '')
      .replace(/^git\+/i, '')
      .replace(/^(?:https?:\/\/|git:\/\/|ssh:\/\/git@|git@)github\.com[/:]/i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    if (REPO_RE.test(s)) return s;
  }
  return '';
}

function codedError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(codedError('timeout', 'timeout'));
    }, ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/**
 * Chiede a GitHub l'ultima release stabile del repository.
 * Ritorna { state: 'available' | 'current' | 'none', current, latest?, url? }.
 * 'none' = il repository non ha ancora release pubblicate.
 */
async function checkForUpdate({ repo, current, fetch: fetchImpl, apiBase = API_BASE, timeoutMs = 8000 }) {
  if (!REPO_RE.test(String(repo || ''))) throw codedError('notConfigured', 'update repository not configured');
  if (typeof fetchImpl !== 'function') throw codedError('network', 'fetch not available');
  if (!parseVersion(current)) throw codedError('badVersion', `installed version not recognised (${current})`);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const url = `${String(apiBase).replace(/\/+$/, '')}/repos/${repo}/releases/latest`;
  const res = await withTimeout(fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `PTZ-Hub/${current}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: ctrl ? ctrl.signal : undefined,
  }), timeoutMs, () => ctrl && ctrl.abort());

  const releasesPage = `https://github.com/${repo}/releases/latest`;
  if (res.status === 404) return { state: 'none', current, url: releasesPage };
  if (res.status === 403 || res.status === 429) throw codedError('rate', 'GitHub rate limit', { status: res.status });
  if (!res.ok) throw codedError('http', `HTTP ${res.status}`, { status: res.status });

  const data = await withTimeout(res.json(), timeoutMs);
  if (!data || data.draft || data.prerelease) return { state: 'none', current, url: releasesPage };
  const latest = String(data.tag_name || '').trim().replace(/^v/i, '');
  if (!parseVersion(latest)) throw codedError('badVersion', 'published version not recognised');

  // si apre solo una pagina del repository stesso, mai un indirizzo arbitrario
  const page = typeof data.html_url === 'string'
    && data.html_url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/`)
    ? data.html_url : releasesPage;

  return {
    state: compareVersions(latest, current) > 0 ? 'available' : 'current',
    current,
    latest,
    url: page,
  };
}

function isSafeReleaseUrl(url, repo) {
  return typeof url === 'string' && REPO_RE.test(String(repo || ''))
    && url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/`);
}

module.exports = {
  API_BASE, parseVersion, compareVersions, repoFromPackage, checkForUpdate, isSafeReleaseUrl,
};
