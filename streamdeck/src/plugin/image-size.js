// Dimensioni di un'immagine JPEG, PNG, GIF o WebP lette dall'intestazione, senza decodificarla:
// servono per ritagliare la miniatura al centro del tasto quadrato.

/** @param {Buffer} buf @returns {{width: number, height: number} | null} */
export function imageSize(buf) {
  if (!buf || buf.length < 12) return null;
  try {
    // PNG: firma + IHDR
    if (buf.readUInt32BE(0) === 0x89504e47 && buf.length >= 24) {
      return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
    }
    // GIF
    if (buf.toString('ascii', 0, 4) === 'GIF8') {
      return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
    }
    // WebP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.length >= 30) {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return ok(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
      if (kind === 'VP8 ') return ok(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return ok((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
      }
      return null;
    }
    // JPEG: si cerca il segmento SOFn
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return ok(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
        if (len < 2) return null;
        i += 2 + len;
      }
    }
  } catch (_) {
    return null;
  }
  return null;
}

function ok(width, height) {
  return width > 0 && height > 0 ? { width, height } : null;
}
