// Generates build/icon.ico from scratch (no image libraries / external tools
// needed) so the app has a branded icon instead of the default Electron one.
// Draws a simple navy rounded-square mark with two DEV/QA bars, matching the
// app's own color palette (--navy/--blue/--teal in PI_SysMgm_Team_Capacity.html).
// Re-run with `npm run icon` whenever the design needs to change.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const NAVY = [0x0f, 0x17, 0x2a];
const BLUE = [0x25, 0x63, 0xeb];
const TEAL = [0x0d, 0x94, 0x88];
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor for anti-aliasing

function inRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= r * r;
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  // Bars: two side-by-side rounded-top bars sitting on a shared baseline.
  const padX = size * 0.26, padBottom = size * 0.24, padTop = size * 0.30;
  const gap = size * 0.10;
  const barW = (size - padX * 2 - gap) / 2;
  const baseline = size - padBottom;
  const blueTop = padTop + size * 0.18;   // shorter bar
  const tealTop = padTop;                  // taller bar
  const blueX0 = padX, blueX1 = padX + barW;
  const tealX0 = padX + barW + gap, tealX1 = tealX0 + barW;

  function barCoverage(x, y, x0, x1, top) {
    return (x >= x0 && x <= x1 && y >= top && y <= baseline) ? 1 : 0;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0, blueCov = 0, tealCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (inRoundedRect(px, py, size, size, r)) bgCov++;
          blueCov += barCoverage(px, py, blueX0, blueX1, blueTop);
          tealCov += barCoverage(px, py, tealX0, tealX1, tealTop);
        }
      }
      const n = SS * SS;
      bgCov /= n; blueCov /= n; tealCov /= n;
      let rC = NAVY[0], gC = NAVY[1], bC = NAVY[2], a = bgCov;
      // Composite bars over the navy background (bars are drawn only where bg exists).
      if (blueCov > 0) { rC = BLUE[0]; gC = BLUE[1]; bC = BLUE[2]; a = Math.max(a, blueCov); }
      if (tealCov > 0) { rC = TEAL[0]; gC = TEAL[1]; bC = TEAL[2]; a = Math.max(a, tealCov); }
      const i = (y * size + x) * 4;
      buf[i] = rC; buf[i + 1] = gC; buf[i + 2] = bC; buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// ── Minimal PNG encoder (RGBA8, filter type 0) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── ICO container (PNG-compressed entries, supported since Windows Vista) ──
function buildICO(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + count * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

const images = SIZES.map(size => ({ size, png: encodePNG(drawIcon(size), size) }));
const ico = buildICO(images);
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log('Wrote', path.join(outDir, 'icon.ico'), '(' + ico.length + ' bytes,', SIZES.join('/') + 'px)');
