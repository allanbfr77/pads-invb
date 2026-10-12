// Corta MP3 longos da pasta samples/ em trechos curtos, sem recodificar (sem perda de qualidade).
//   node cortar-samples.js            -> trechos de 30 s
//   node cortar-samples.js 45         -> trechos de 45 s
// Os originais vão para samples/.originais/<conjunto>/ (pastas que começam com ponto são ignoradas pelo app).
'use strict';
const fs = require('fs');
const path = require('path');

const SECONDS = Math.max(8, Number(process.argv[2]) || 30);
const SKIP_START = 5; // pula o começo (entrada/ruído) do arquivo original
const SAMPLES_DIR = process.env.PADS_SAMPLES_DIR || path.join(__dirname, 'samples');

const BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],      // MPEG1 camada 3
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],          // MPEG2/2.5 camada 3
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }; // por versão

// lista os quadros do MP3: { off, len, dur }
function frames(buf) {
  let p = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    p = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  const out = [];
  while (p + 4 <= buf.length) {
    const h = buf.readUInt32BE(p);
    const ver = (h >> 19) & 3, layer = (h >> 17) & 3, bi = (h >> 12) & 15, si = (h >> 10) & 3, pad = (h >> 9) & 1;
    if ((h >>> 21) !== 0x7ff || ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) { p++; continue; } // procura o próximo quadro válido
    const v1 = ver === 3, rate = RATES[ver][si], br = BITRATES[v1 ? 1 : 2][bi] * 1000;
    const len = Math.floor((v1 ? 144 : 72) * br / rate) + pad;
    if (p + len > buf.length) break;
    out.push({ off: p, len, dur: (v1 ? 1152 : 576) / rate });
    p += len;
  }
  return out;
}

function cut(file) {
  const buf = fs.readFileSync(file);
  const fr = frames(buf);
  if (fr.length < 10) return { skip: 'não parece um MP3 válido' };
  const total = fr.reduce((a, f) => a + f.dur, 0);
  if (total <= SECONDS + 2) return { skip: `já é curto (${Math.round(total)} s)` };
  const body = fr.slice(1); // o 1º quadro costuma ser o cabeçalho Xing/Info (sem áudio)
  let t = 0, i = 0;
  while (i < body.length && t < SKIP_START) t += body[i++].dur;
  const parts = [];
  t = 0;
  for (; i < body.length && t < SECONDS; i++) { parts.push(buf.subarray(body[i].off, body[i].off + body[i].len)); t += body[i].dur; }
  return { data: Buffer.concat(parts), from: total, to: t };
}

let done = 0;
for (const d of fs.existsSync(SAMPLES_DIR) ? fs.readdirSync(SAMPLES_DIR, { withFileTypes: true }) : []) {
  if (!d.isDirectory() || d.name.startsWith('.')) continue;
  const dir = path.join(SAMPLES_DIR, d.name);
  for (const f of fs.readdirSync(dir)) {
    if (!/\.mp3$/i.test(f)) continue;
    const file = path.join(dir, f);
    const r = cut(file);
    if (r.skip) { console.log(`  pulou  ${d.name}/${f}: ${r.skip}`); continue; }
    const bkDir = path.join(SAMPLES_DIR, '.originais', d.name);
    fs.mkdirSync(bkDir, { recursive: true });
    const bk = path.join(bkDir, f);
    if (fs.existsSync(bk)) { console.log(`  pulou  ${d.name}/${f}: já existe um original guardado`); continue; }
    fs.renameSync(file, bk);
    fs.writeFileSync(file, r.data);
    console.log(`  cortou ${d.name}/${f}: ${Math.round(r.from)} s -> ${Math.round(r.to)} s (${(r.data.length / 1048576).toFixed(1)} MB)`);
    done++;
  }
}
console.log(done ? `\n${done} arquivo(s) cortado(s). Originais em ${path.join(SAMPLES_DIR, '.originais')}\nAgora clique em "Recarregar samples" no player.` : '\nNada para cortar.');
