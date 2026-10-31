// Richieste HTTP verso PTZ Hub (solo moduli di Node, nessuna dipendenza).

import http from 'node:http';
import { connectHost, hostHeader } from '../shared/address.js';

const MAX_BODY = 8 * 1024 * 1024;

function codedError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Prepara le opzioni comuni: la chiave viaggia nell'intestazione x-ptz-key (non finisce nei log
 * degli indirizzi) e l'intestazione Host è sempre "host:porta", come vuole PTZ Hub.
 */
export function requestOptions({ host, port, key, method = 'GET', path, agent, headers = {} }) {
  return {
    host: connectHost(host),
    port,
    method,
    path,
    agent,
    headers: {
      Host: hostHeader(host, port),
      'x-ptz-key': key,
      'User-Agent': 'PTZHub-StreamDeck',
      ...(method === 'POST' ? { 'Content-Length': '0' } : {}),
      ...headers,
    },
  };
}

/**
 * Richiesta completa con risposta in memoria.
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 * Errori di rete: e.code = ECONNREFUSED, ETIMEDOUT, … ; chiave con caratteri non validi: EBADKEY.
 */
export function httpRequest({ timeout = 5000, ...opts }) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = http.request(requestOptions(opts));
    } catch (e) {
      // http.request rifiuta subito intestazioni con caratteri non validi (chiave incollata male)
      reject(codedError(e.message, e.code === 'ERR_INVALID_CHAR' ? 'EBADKEY' : (e.code || 'EINVAL')));
      return;
    }
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy(codedError('response too large', 'ETOOLARGE'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, codedError('response aborted', 'ECONNRESET')));
    });
    req.setTimeout(timeout, () => req.destroy(codedError('timeout', 'ETIMEDOUT')));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

/** Motivo di un errore HTTP, con gli stessi nomi usati per lo stato del collegamento. */
export function reasonForStatus(status) {
  if (status === 401) return 'badKey';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notPtz';
  if (status === 409) return 'refused';
  return 'error';
}
