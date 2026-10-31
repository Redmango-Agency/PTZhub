// Comandi dell'azione "Comando": nome salvato nelle impostazioni del tasto -> indirizzo di PTZ Hub.

export const COMMANDS = [
  'stop', 'home', 'next', 'prev', 'onepush',
  'zoom:in', 'zoom:out',
  'nudge:up', 'nudge:down', 'nudge:left', 'nudge:right',
];

export const DEFAULT_COMMAND = 'stop';

/** Comando valido (quelli sconosciuti diventano STOP, il più sicuro). */
export function normalizeCommand(c) {
  return COMMANDS.includes(c) ? c : DEFAULT_COMMAND;
}

/** "zoom:in" -> "zoom/in" (dopo /api/) */
export function commandPath(c) {
  return normalizeCommand(c).replace(':', '/');
}

/** Comandi che PTZ Hub rifiuta mentre si modifica un'inquadratura (STOP e fuoco funzionano sempre). */
export function blockedWhileEditing(c) {
  return !['stop', 'onepush'].includes(normalizeCommand(c));
}
