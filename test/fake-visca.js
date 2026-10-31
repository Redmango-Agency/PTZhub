'use strict';
// Telecamera VISCA simulata (UDP raw, TCP raw, Sony VISCA over IP) per i test.
const dgram = require('dgram');
const net = require('net');
const { toNibbles, fromNibbles, splitMessages } = require('../src/main/visca');

function createFakeCamera({ udpPort = 11259, tcpPort = 15678, sonyPort = 15381, panDigits = 4, twoSockets = false, verbose = false } = {}) {
  const st = { pan: 0, tilt: 0, zoom: 0, focus: 0x1000, focusAuto: true, slots: {}, log: [], busy: 0, rejected: 0 };
  // simula le camere con 2 socket di esecuzione: pan/tilt assoluto e zoom diretto restano occupati per un po'
  const occupy = (ms) => { st.busy++; setTimeout(() => { st.busy--; }, ms); };

  function handle(msg) {
    const replies = [];
    const cmd = Array.from(msg);
    st.log.push(cmd.map((b) => b.toString(16).padStart(2, '0')).join(' '));
    const [, cat, grp, op, ...rest] = cmd;
    if (verbose) console.log(st.log[st.log.length - 1]);
    if (cat === 0x09) {
      if (grp === 0x04 && op === 0x00) replies.push([0x90, 0x50, 0x02, 0xff]);
      else if (grp === 0x06 && op === 0x12) replies.push([0x90, 0x50, ...toNibbles(st.pan, panDigits), ...toNibbles(st.tilt, 4), 0xff]);
      else if (grp === 0x04 && op === 0x47) replies.push([0x90, 0x50, ...toNibbles(st.zoom, 4), 0xff]);
      else if (grp === 0x04 && op === 0x38) replies.push([0x90, 0x50, st.focusAuto ? 0x02 : 0x03, 0xff]);
      else if (grp === 0x04 && op === 0x48) replies.push([0x90, 0x50, ...toNibbles(st.focus, 4), 0xff]);
      else replies.push([0x90, 0x60, 0x02, 0xff]);
      return replies;
    }
    if (cat === 0x01) {
      const isLong = (grp === 0x06 && op === 0x02) || (grp === 0x04 && op === 0x47);
      if (twoSockets && st.busy >= 2) {
        st.rejected++;
        return [[0x90, 0x60, 0x03, 0xff]];
      }
      if (twoSockets && isLong) occupy(400);
      replies.push([0x90, 0x41, 0xff]);
      if (grp === 0x06 && op === 0x01) {
        const [, , pd, td] = rest;
        if (pd === 0x01) st.pan -= 100; else if (pd === 0x02) st.pan += 100;
        if (td === 0x01) st.tilt += 50; else if (td === 0x02) st.tilt -= 50;
        st.pan &= (1 << (4 * panDigits)) - 1;
        st.tilt &= 0xffff;
      } else if (grp === 0x06 && op === 0x02) {
        const nib = rest.slice(2, rest.length - 1);
        st.pan = fromNibbles(nib.slice(0, panDigits));
        st.tilt = fromNibbles(nib.slice(panDigits));
      } else if (grp === 0x06 && op === 0x04) {
        st.pan = 0; st.tilt = 0;
      } else if (grp === 0x04 && op === 0x47) {
        st.zoom = fromNibbles(rest.slice(0, 4));
      } else if (grp === 0x04 && op === 0x48) {
        st.focus = fromNibbles(rest.slice(0, 4));
      } else if (grp === 0x04 && op === 0x38) {
        st.focusAuto = rest[0] === 0x02;
      } else if (grp === 0x04 && op === 0x07) {
        if ((rest[0] & 0xf0) === 0x20) st.zoom = Math.min(0x4000, st.zoom + 0x200);
        if ((rest[0] & 0xf0) === 0x30) st.zoom = Math.max(0, st.zoom - 0x200);
      } else if (grp === 0x04 && op === 0x3f) {
        const [sub, n] = rest;
        if (sub === 0x01) st.slots[n] = { pan: st.pan, tilt: st.tilt, zoom: st.zoom };
        if (sub === 0x02 && st.slots[n]) Object.assign(st, st.slots[n]);
      }
      replies.push([0x90, 0x51, 0xff]);
    }
    return replies;
  }

  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, r) => {
    for (const m of splitMessages(msg).messages) {
      for (const rep of handle(m)) udp.send(Buffer.from(rep), r.port, r.address);
    }
  });
  udp.bind(udpPort);

  const sony = dgram.createSocket('udp4');
  sony.on('message', (msg, r) => {
    const type = msg.readUInt16BE(0);
    const seq = msg.readUInt32BE(4);
    if (type === 0x0200) {
      const h = Buffer.from([0x02, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0x01]);
      sony.send(h, r.port, r.address);
      return;
    }
    const payload = msg.subarray(8);
    for (const rep of handle(payload)) {
      const h = Buffer.alloc(8);
      h.writeUInt16BE(0x0111, 0);
      h.writeUInt16BE(rep.length, 2);
      h.writeUInt32BE(seq, 4);
      sony.send(Buffer.concat([h, Buffer.from(rep)]), r.port, r.address);
    }
  });
  sony.bind(sonyPort);

  const tcp = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const { messages, rest } = splitMessages(buf);
      buf = Buffer.from(rest);
      for (const m of messages) for (const rep of handle(m)) sock.write(Buffer.from(rep));
    });
    sock.on('error', () => {});
  });
  tcp.listen(tcpPort);

  return {
    state: st,
    close() { udp.close(); sony.close(); tcp.close(); },
  };
}

module.exports = { createFakeCamera };

if (require.main === module) {
  createFakeCamera({ udpPort: 1259, tcpPort: 5678, sonyPort: 52381, verbose: !!process.env.FAKE_LOG });
  console.log('Camera VISCA simulata in ascolto su UDP 1259, TCP 5678, Sony 52381');
}
