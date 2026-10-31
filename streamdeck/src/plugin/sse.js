// Lettore di Server-Sent Events (formato text/event-stream) che riceve il testo a pezzi:
// le righe e gli eventi possono essere spezzati in qualsiasi punto tra un pezzo e l'altro.

export class SseParser {
  /**
   * @param {{ onEvent: (ev: {event: string, data: string, id: string}) => void, onComment?: (text: string) => void }} handlers
   */
  constructor({ onEvent, onComment } = {}) {
    this.onEvent = onEvent || (() => {});
    this.onComment = onComment || (() => {});
    this.buf = '';
    this.skipLF = false; // il pezzo precedente finiva con \r: un \n subito dopo fa parte dello stesso a capo
    this.reset();
    this.lastId = '';
  }

  reset() {
    this.data = [];
    this.event = '';
    this.hasData = false;
  }

  /** @param {string} text */
  push(text) {
    if (!text) return;
    let s = text;
    if (this.skipLF) {
      if (s[0] === '\n') s = s.slice(1);
      this.skipLF = false;
    }
    this.buf += s;
    let start = 0;
    const b = this.buf;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c !== '\n' && c !== '\r') continue;
      this.line(b.slice(start, i));
      if (c === '\r') {
        if (i + 1 < b.length) {
          if (b[i + 1] === '\n') i++;
        } else {
          this.skipLF = true;
        }
      }
      start = i + 1;
    }
    this.buf = b.slice(start);
  }

  line(l) {
    if (l === '') {
      if (this.hasData) {
        const data = this.data.join('\n');
        const event = this.event || 'message';
        const id = this.lastId;
        this.reset();
        this.onEvent({ event, data, id });
      } else {
        this.reset();
      }
      return;
    }
    if (l[0] === ':') {
      this.onComment(l.slice(1).trim());
      return;
    }
    const at = l.indexOf(':');
    const field = at < 0 ? l : l.slice(0, at);
    let value = at < 0 ? '' : l.slice(at + 1);
    if (value[0] === ' ') value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        this.hasData = true;
        break;
      case 'event':
        this.event = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        break; // "retry" e campi sconosciuti: il ritardo lo decide il plugin
    }
  }
}
