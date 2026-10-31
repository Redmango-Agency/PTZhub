// Parti del Property Inspector che non toccano la pagina (provate nei test).

export function cameraLabel(state, tr) {
  if (state === 'connected') return tr('pi.cam.connected');
  if (state === 'connecting') return tr('pi.cam.connecting');
  return tr('pi.cam.other');
}

/** Testo e colore della riga di stato da un messaggio "status" o "testResult" (msg.test = true). */
export function describe(msg, tr) {
  const online = msg.test ? msg.ok : msg.status && msg.status.state === 'online';
  if (online) {
    const vars = { addr: msg.address, n: msg.presetCount, camera: cameraLabel(msg.camera, tr) };
    let text = tr(msg.presetCount === 1 ? 'pi.ok1' : 'pi.ok', vars);
    if (msg.editing) text += ` ${tr('pi.editing')}`;
    return { cls: 'ok', text };
  }
  if (!msg.test && msg.status && msg.status.state === 'connecting') return { cls: 'wait', text: tr('pi.connecting', { addr: msg.address }) };
  if (!msg.test && msg.status && msg.status.state === 'idle') return { cls: 'wait', text: tr('pi.idle') };
  const reason = (msg.test ? msg.reason : msg.status && msg.status.reason) || 'unreachable';
  return { cls: 'err', text: tr(`pi.reason.${reason}`, { addr: msg.address, port: msg.port }) };
}

/** Voci dell'elenco inquadrature: "N · Nome", più quella scelta se nel frattempo è stata eliminata. */
export function presetOptions(msg, settings, tr) {
  const id = (settings && settings.presetId) || '';
  const opts = [];
  if (msg && msg.online) {
    if (!msg.presets.length) opts.push({ value: '__none', label: tr('pi.presetNone'), disabled: true });
    for (const p of msg.presets) opts.push({ value: p.id, label: `${p.index} · ${p.name}` });
    if (id && !msg.presets.some((p) => p.id === id)) {
      opts.push({
        value: id,
        label: settings.presetName ? tr('pi.presetDeleted', { name: settings.presetName }) : tr('pi.presetDeletedNoName'),
      });
    }
  } else {
    if (id) opts.push({ value: id, label: settings.presetName || id });
    opts.push({ value: '__offline', label: tr('pi.presetOffline'), disabled: true });
  }
  return opts;
}
