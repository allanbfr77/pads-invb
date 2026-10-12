// Teste automático do servidor: node smoke-test.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FALHA ') + msg); if (!cond) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wav(freq) {
  const rate = 8000, n = rate / 5, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 8000), 44 + i * 2);
  return buf;
}

function get(host, port, p, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const jget = async (...a) => { const r = await get(...a); try { r.json = JSON.parse(r.body.toString()); } catch {} return r; };

function startServer(port, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pads-'));
  const samples = path.join(tmp, 'samples', 'Teste');
  fs.mkdirSync(samples, { recursive: true });
  fs.writeFileSync(path.join(samples, 'C.wav'), wav(262));
  fs.writeFileSync(path.join(samples, 'Db.wav'), wav(277));
  fs.writeFileSync(path.join(samples, 'Cm.wav'), wav(247));
  fs.writeFileSync(path.join(samples, 'Mellow.wav'), wav(100));
  fs.writeFileSync(path.join(samples, 'leia.txt'), 'x');
  const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), PADS_DATA_DIR: tmp, PADS_SAMPLES_DIR: path.join(tmp, 'samples'), PADS_PIN: '', ...env },
  });
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('PADS IGREJA')) resolve(p); });
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('error', reject);
    setTimeout(() => reject(new Error('servidor não iniciou')), 5000);
  });
}

function client(host, port, role, pin) {
  const ws = new WebSocket(`ws://${host}:${port}`);
  const c = { ws, msgs: [], last: null, open: new Promise((r) => ws.on('open', r)) };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); if (m.type === 'state') c.last = m; });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.open.then(() => { if (pin) c.send({ type: 'auth', pin }); if (role) c.send({ type: 'hello', role }); });
  return c;
}

(async () => {
  const port = 3900 + Math.floor(Math.random() * 90);
  const srv = await startServer(port);
  try {
    console.log('Rotas');
    for (const p of ['/', '/player', '/engine.js', '/manifest.webmanifest', '/sw.js', '/icon.svg']) ok((await get('localhost', port, p)).status === 200, 'GET ' + p);
    ok((await get('localhost', port, '/nada')).status === 404, '404 em rota desconhecida');
    const qr = await get('localhost', port, '/qr.svg?url=' + encodeURIComponent('http://192.168.0.5:3000/'));
    ok(qr.status === 200 && qr.body.toString().includes('<svg'), 'QR Code gerado');
    ok((await get('localhost', port, '/qr.svg?url=' + encodeURIComponent('javascript:alert(1)'))).status === 404, 'QR recusa URL inválida');

    console.log('Samples');
    const st0 = (await jget('localhost', port, '/api/state')).json;
    ok(st0.timbres.some((t) => t.id === 'sample:Teste'), 'pasta de samples detectada como timbre');
    ok(JSON.stringify(st0.samples.Teste) === '{"maj":{"0":"C.wav","1":"Db.wav"},"min":{"0":"Cm.wav"}}', 'arquivos mapeados pela nota e pelo modo (Cm = menor; Mellow não); .txt ignorado');
    ok((await get('localhost', port, '/samples/Teste/C.wav')).headers['content-type'] === 'audio/wav', 'serve o sample como audio/wav');
    ok((await get('localhost', port, '/samples/Teste/leia.txt')).status === 404, 'não serve arquivo que não é sample');
    ok((await get('localhost', port, '/samples/Teste/..%2F..%2Fx')).status === 404, 'bloqueia caminho fora da pasta');

    console.log('WebSocket');
    const player = client('localhost', port, 'player');
    const remote = client('localhost', port, 'remote');
    await Promise.all([player.open, remote.open]); await sleep(300);
    ok(remote.last && remote.last.players === 1, 'controle vê o player conectado');
    remote.send({ type: 'key', value: 7 }); await sleep(150);
    ok(player.last.state.key === 7 && player.last.state.playing, 'tom G chega ao player e fica tocando');
    remote.send({ type: 'key', value: 99 }); await sleep(100);
    ok(player.last.state.key === 7, 'tom inválido é ignorado');
    remote.send({ type: 'volume', value: 5 }); remote.send({ type: 'tuning', value: -300 }); await sleep(100);
    ok(player.last.state.volume === 1 && player.last.state.tuning === -50, 'volume e afinação são limitados');
    remote.send({ type: 'timbre', value: 'nope' }); await sleep(80);
    ok(player.last.state.layers[0].timbre === 'warm', 'timbre inexistente é recusado');
    remote.send({ type: 'timbre', value: 'sample:Teste' }); await sleep(80);
    ok(player.last.state.layers[0].timbre === 'sample:Teste', 'timbre de samples aceito');

    console.log('Modo e pads (camadas)');
    ok(player.last.state.mode === 'maj', 'começa em modo maior');
    remote.send({ type: 'mode', value: 'min' }); await sleep(80);
    ok(player.last.state.mode === 'min' && player.last.state.key === 7, 'modo menor aceito sem mudar o tom');
    remote.send({ type: 'mode', value: 'xyz' }); await sleep(80);
    ok(player.last.state.mode === 'min', 'modo inválido é ignorado');
    remote.send({ type: 'key', value: 4 }); await sleep(80);
    ok(player.last.state.key === 4 && player.last.state.mode === 'min', 'tecla numérica mantém o modo');
    remote.send({ type: 'key', value: 'Bbm' }); await sleep(80);
    ok(player.last.state.key === 10 && player.last.state.mode === 'min', '"Bbm" toca Bb menor');
    remote.send({ type: 'key', value: 'D' }); await sleep(80);
    ok(player.last.state.key === 2 && player.last.state.mode === 'maj', '"D" volta para maior');
    remote.send({ type: 'timbre', layer: 1, value: 'strings' }); remote.send({ type: 'level', layer: 1, value: 0.4 }); await sleep(100);
    ok(player.last.state.layers[1].timbre === 'strings' && player.last.state.layers[1].level === 0.4, 'pad 2 liga com nível próprio');
    remote.send({ type: 'timbre', layer: 0, value: 'off' }); await sleep(80);
    ok(player.last.state.layers[0].timbre === 'sample:Teste', 'pad 1 não pode ser desligado');
    remote.send({ type: 'layerFade', layer: 1, which: 'in', value: 8 }); remote.send({ type: 'layerFade', layer: 1, which: 'out', value: 99 }); await sleep(100);
    ok(player.last.state.layers[1].fadeIn === 8 && player.last.state.layers[1].fadeOut === 10 && player.last.state.layers[0].fadeIn === 3, 'fade in/out por pad (limitado a 10 s)');
    remote.send({ type: 'timbre', layer: 1, value: 'off' }); await sleep(80);
    ok(player.last.state.layers[1].timbre === null, 'pad 2 pode ser desligado');
    remote.send({ type: 'timbre', layer: 5, value: 'warm' }); await sleep(60);
    ok(player.last.state.layers.length === 2, 'pad inexistente é ignorado');
    remote.send({ type: 'key', value: 7 }); await sleep(80);
    remote.send({ type: 'fadeout' }); await sleep(80);
    ok(!player.last.state.playing, 'fade out');

    console.log('Presets');
    remote.send({ type: 'preset', n: 1 }); await sleep(80);
    const l0 = player.last.state.layers[0];
    ok(l0.timbre === 'ethereal' && l0.fadeIn === 6 && l0.fadeOut === 6 && player.last.state.layers[1].timbre === null, 'preset "Oração" aplicado');
    remote.send({ type: 'preset', n: 2 }); await sleep(80);
    ok(player.last.state.layers[1].timbre === 'ethereal' && player.last.state.layers[1].level === 0.5, 'preset "Ministração" liga o pad 2');
    remote.send({ type: 'timbre', value: 'strings' }); remote.send({ type: 'volume', value: 0.33 });
    remote.send({ type: 'savePreset', n: 3, name: 'Meu <b>preset</b>' }); await sleep(120);
    const p3 = player.last.presets[3];
    ok(p3.name === 'Meu bpreset/b' && p3.layers[0].timbre === 'strings' && p3.layers[1].timbre === 'ethereal' && p3.volume === 0.33, 'preset salvo com os dois pads (nome sanitizado)');

    console.log('Repertório');
    remote.send({ type: 'setlist', items: [{ name: 'Santo', key: 'D' }, { name: 'Em Espírito', key: 'Bbm' }, { name: 'Sem tom' }] }); await sleep(100);
    ok(player.last.setlist.length === 3 && player.last.setlist[1].key === 10 && player.last.setlist[2].key === null, 'repertório salvo com tons convertidos');
    ok(player.last.setlist[1].minor === true && player.last.setlist[0].minor === false, 'repertório guarda maior/menor ("Bbm")');
    remote.send({ type: 'goto', index: 1 }); await sleep(80);
    ok(player.last.state.key === 10 && player.last.state.playing && player.last.state.setlistIndex === 1, 'goto toca o tom da música');
    ok(player.last.state.mode === 'min', 'goto também troca para o modo da música');
    remote.send({ type: 'next' }); await sleep(80);
    ok(player.last.state.setlistIndex === 2 && player.last.state.key === 10, 'próxima sem tom mantém o pad');
    remote.send({ type: 'prev' }); remote.send({ type: 'prev' }); remote.send({ type: 'prev' }); await sleep(100);
    ok(player.last.state.setlistIndex === 0 && player.last.state.key === 2, 'anterior para na primeira (D)');

    console.log('API HTTP');
    let r = await jget('localhost', port, '/api/key?k=F%23');
    ok(r.json.state.key === 6 && r.json.state.playing, '/api/key?k=F# toca F#');
    await sleep(80); ok(player.last.state.key === 6, 'mudança pela API chega ao player');
    r = await jget('localhost', port, '/api/key?k=Am');
    ok(r.json.state.key === 9 && r.json.state.mode === 'min', '/api/key?k=Am toca A menor');
    r = await jget('localhost', port, '/api/key?k=A&mode=min');
    ok(r.json.state.key === 9 && r.json.state.mode === 'min', '/api/key?k=A&mode=min');
    r = await jget('localhost', port, '/api/mode?m=maj'); ok(r.json.state.mode === 'maj', '/api/mode');
    r = await jget('localhost', port, '/api/level?layer=2&v=30'); ok(r.json.state.layers[1].level === 0.3, '/api/level do pad 2');
    r = await jget('localhost', port, '/api/timbre?id=warm&layer=2'); ok(r.json.state.layers[1].timbre === 'warm', '/api/timbre no pad 2');
    r = await jget('localhost', port, '/api/key?k=F%23');
    r = await jget('localhost', port, '/api/key?k=zzz'); ok(r.status === 400, 'tom inválido na API retorna 400');
    r = await jget('localhost', port, '/api/next'); ok(r.json.state.setlistIndex === 1, '/api/next avança o repertório');
    r = await jget('localhost', port, '/api/fadeout'); ok(!r.json.state.playing, '/api/fadeout');
    r = await jget('localhost', port, '/api/setlist', 'POST', JSON.stringify([{ name: 'A', key: 'C' }, { name: 'B', key: 'E' }]), { 'Content-Type': 'application/json' });
    ok(r.json.setlist.length === 2 && r.json.state.setlistIndex === -1, 'POST /api/setlist substitui o repertório');
    r = await jget('localhost', port, '/api/setlist', 'POST', 'não é json'); ok(r.status === 400, 'JSON inválido retorna 400');

    console.log('Origem (WebSocket entre sites)');
    const bad = new WebSocket(`ws://localhost:${port}`, { headers: { Origin: 'http://site-malicioso.example' } });
    const badResult = await new Promise((res) => { bad.on('open', () => res('aberto')); bad.on('error', () => res('recusado')); bad.on('unexpected-response', () => res('recusado')); });
    ok(badResult === 'recusado', 'conexão com Origin de outro site é recusada');

    player.ws.close(); remote.ws.close();
    srv.kill(); await sleep(300);

    console.log('PIN');
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
    const port2 = port + 100;
    const srv2 = await startServer(port2, { PADS_PIN: '4321' });
    try {
      ok((await jget('localhost', port2, '/api/state')).status === 200, 'localhost dispensa PIN');
      if (!lan) { console.log('  (sem interface de rede externa: testes de PIN remoto pulados)'); }
      else {
        ok((await jget(lan.address, port2, '/api/state')).status === 401, 'rede sem PIN: 401');
        ok((await jget(lan.address, port2, '/api/state?pin=4321')).status === 200, 'rede com PIN correto: 200');
        const c = client(lan.address, port2, 'remote');
        await c.open; await sleep(200);
        ok(c.msgs[0].type === 'hello_ack' && c.msgs[0].pinRequired && !c.msgs[0].authed, 'WebSocket de fora recebe pedido de PIN');
        c.send({ type: 'key', value: 3 }); await sleep(100);
        ok(c.msgs.some((m) => m.type === 'denied') && !c.last, 'comando sem PIN é negado e não recebe estado');
        c.send({ type: 'auth', pin: '4321' }); await sleep(150);
        ok(c.msgs.some((m) => m.type === 'auth' && m.ok) && c.last, 'PIN correto libera o controle');
        c.ws.close();
        const bruteIp = client(lan.address, port2, null);
        await bruteIp.open;
        for (let i = 0; i < 6; i++) bruteIp.send({ type: 'auth', pin: 'x' + i });
        await sleep(300);
        ok(bruteIp.msgs.some((m) => m.type === 'auth' && m.blocked), 'muitas tentativas erradas bloqueiam o IP');
        bruteIp.ws.close();
      }
    } finally { srv2.kill(); }
  } catch (e) {
    console.error(e); fail++;
  } finally { srv.kill(); }
  console.log(fail ? `\n${fail} verificação(ões) falharam` : '\nTudo certo');
  process.exit(fail ? 1 : 0);
})();
