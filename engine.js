// Motor de áudio compartilhado: toca os pads a partir do estado do servidor.
// Usado pelo player (PC) e pelo "Tocar neste aparelho" do controle (celular).
function createEngine({ getSnap, onMsg = () => {}, onSuspend = () => {} }) {
  let ctx = null, master, dryBus, convolver, reverbGain, analyser;
  let layerBus = [];            // por pad: { dry, wet } (o nível do pad atua nos dois)
  let cur = [null, null];       // por pad: { key, timbre, mode, voice }
  let building = [null, null];  // por pad: assinatura do que está sendo construído
  let started = false, active = true;

  // ============================================================ síntese
  const SYNTH = {
    warm: {
      osc: [[1,'sawtooth',0.30,-7],[1,'sawtooth',0.30,7],[1.5,'sine',0.25,0],[2,'triangle',0.20,0],[0.5,'sine',0.30,0]],
      cutoff: [350, 1800], q: 0.7, lfo: 0.09, lfoDepth: 220, wet: 0.45,
    },
    strings: {
      osc: [[1,'sawtooth',0.22,-12],[1,'sawtooth',0.22,0],[1,'sawtooth',0.22,12],[1.5,'sawtooth',0.14,6],[2,'sawtooth',0.12,-6]],
      cutoff: [700, 4200], q: 0.9, lfo: 0.14, lfoDepth: 350, wet: 0.5,
    },
    ethereal: {
      osc: [[2,'sine',0.28,-4],[2,'sine',0.28,4],[3,'sine',0.18,0],[4,'triangle',0.14,0],[1,'sine',0.25,0]],
      cutoff: [1200, 7000], q: 0.5, lfo: 0.07, lfoDepth: 600, wet: 0.7,
    },
  };

  function baseFreq(k) {
    let f = 130.8128 * Math.pow(2, k / 12);   // C3
    if (k >= 7) f /= 2;                        // G..B descem uma oitava (região grave/média)
    return f;
  }
  const cutoffFor = (def, tone) => def.cutoff[0] * Math.pow(def.cutoff[1] / def.cutoff[0], tone);

  function makeImpulse(seconds = 5, decay = 3) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function rampStart(out, fade) {
    const t = ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(1, t + fade);
  }
  function rampStop(out, fade) {
    const t = ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.linearRampToValueAtTime(0, t + fade);
  }

  function createSynthVoice(key, timbreId, L) {
    const def = SYNTH[timbreId] || SYNTH.warm;
    const s = getSnap().state;
    const f0 = baseFreq(key);
    const out = ctx.createGain(); out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.Q.value = def.q; filter.frequency.value = cutoffFor(def, s.tone);

    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    lfo.frequency.value = def.lfo; lfoGain.gain.value = def.lfoDepth;
    lfo.connect(lfoGain).connect(filter.detune);

    const oscs = [];
    for (const [mult, type, gain, cents] of def.osc) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f0 * mult; o.detune.value = cents + s.tuning;
      const g = ctx.createGain(); g.gain.value = gain * 0.35;
      o.connect(g).connect(filter);
      oscs.push({ o, base: cents });
    }
    const send = ctx.createGain(); send.gain.value = def.wet;
    filter.connect(out); out.connect(L.dry); out.connect(send).connect(L.wet);
    const all = [lfo, ...oscs.map((x) => x.o)];
    all.forEach((o) => o.start());

    let dead = false;
    const dispose = () => {
      if (dead) return; dead = true;
      all.forEach((o) => { try { o.stop(); } catch {} });
      try { out.disconnect(); send.disconnect(); filter.disconnect(); } catch {}
    };
    return {
      setTone: (t) => filter.frequency.setTargetAtTime(cutoffFor(def, t), ctx.currentTime, 0.1),
      setTuning: (c) => oscs.forEach((x) => x.o.detune.setTargetAtTime(x.base + c, ctx.currentTime, 0.05)),
      start: (f) => rampStart(out, f),
      stop: (f) => { rampStop(out, f); setTimeout(dispose, (f + 0.5) * 1000); },
      dispose,
    };
  }

  // ============================================================ samples
  const sampleSets = {}; // pasta -> { sig, promise, buffers }
  const FADE_IN = new Float32Array(128), FADE_OUT = new Float32Array(128);
  for (let i = 0; i < 128; i++) { FADE_IN[i] = Math.sin((i / 127) * Math.PI / 2); FADE_OUT[i] = Math.cos((i / 127) * Math.PI / 2); }

  function ensureSamples(folder) {
    const index = (getSnap().samples || {})[folder];
    if (!index) return Promise.reject(new Error('conjunto de samples não encontrado'));
    const sig = JSON.stringify(index);
    const cached = sampleSets[folder];
    if (cached && cached.sig === sig) return cached.promise;

    const set = { sig, buffers: { maj: {}, min: {} } };
    const entries = [];
    for (const mode of ['maj', 'min']) for (const [n, file] of Object.entries(index[mode] || {})) entries.push([mode, n, file]);
    let done = 0;
    onMsg(`Carregando samples… 0/${entries.length}`);
    set.promise = Promise.all(entries.map(async ([mode, n, file]) => {
      try {
        const r = await fetch(`/samples/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`);
        if (!r.ok) throw new Error(r.status);
        set.buffers[mode][n] = await ctx.decodeAudioData(await r.arrayBuffer());
      } catch (e) { console.warn('sample falhou', file, e); }
      onMsg(`Carregando samples… ${++done}/${entries.length}`);
    })).then(() => {
      const total = Object.keys(set.buffers.maj).length + Object.keys(set.buffers.min).length;
      if (!total) throw new Error('nenhum sample pôde ser carregado');
      onMsg(`Samples prontos (${total} notas)`);
      return set;
    });
    set.promise.catch(() => { delete sampleSets[folder]; onMsg('Falha ao carregar os samples'); });
    sampleSets[folder] = set;
    return set.promise;
  }

  // Modo efetivo de um timbre: o escolhido, ou o outro se o conjunto não tiver arquivos desse modo.
  // Timbres sintetizados não dependem do modo (null).
  function effMode(timbre, mode) {
    if (!timbre || !timbre.startsWith('sample:')) return null;
    const idx = (getSnap().samples || {})[timbre.slice(7)];
    if (!idx) return mode;
    const other = mode === 'min' ? 'maj' : 'min';
    const has = (m) => Object.keys(idx[m] || {}).length > 0;
    return has(mode) || !has(other) ? mode : other;
  }

  function createSampleVoice(key, set, mode, L) {
    const s = getSnap().state;
    const buffers = Object.keys(set.buffers[mode]).length ? set.buffers[mode] : set.buffers[mode === 'min' ? 'maj' : 'min'];
    // nota disponível mais próxima; as demais são obtidas por mudança de velocidade
    let best = null, bestD = 99;
    for (const n of Object.keys(buffers).map(Number)) {
      let d = (((key - n) % 12) + 12) % 12; if (d > 6) d -= 12;
      if (Math.abs(d) < Math.abs(bestD)) { bestD = d; best = n; }
    }
    const buf = buffers[best];
    const rate = Math.pow(2, bestD / 12);
    const dur = buf.duration / rate;
    const xf = Math.min(5, dur * 0.3);

    const out = ctx.createGain(); out.gain.value = 0;
    const bus = ctx.createGain();
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
    const hs = ctx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 4000;
    bus.connect(lp); lp.connect(hs); hs.connect(out); out.connect(L.dry);
    const setTone = (t, fast) => {
      const f = t >= 0.5 ? 20000 : 300 * Math.pow(20000 / 300, t * 2);
      const g = t > 0.5 ? (t - 0.5) * 2 * 8 : 0;
      const now = ctx.currentTime, k = fast ? 0 : 0.1;
      if (fast) { lp.frequency.value = f; hs.gain.value = g; }
      else { lp.frequency.setTargetAtTime(f, now, k); hs.gain.setTargetAtTime(g, now, k); }
    };
    setTone(s.tone, true);

    let tuning = s.tuning, alive = true, first = true, nextStart = ctx.currentTime + 0.05;
    const active = new Set();
    function schedule() {
      const st = nextStart, end = st + dur;
      const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate; src.detune.value = tuning;
      const g = ctx.createGain();
      if (first) { g.gain.setValueAtTime(1, st); first = false; }
      else { g.gain.setValueAtTime(0, st); g.gain.setValueCurveAtTime(FADE_IN, st, xf); }
      g.gain.setValueCurveAtTime(FADE_OUT, end - xf, xf);
      src.connect(g).connect(bus);
      src.start(st); src.stop(end + 0.1);
      active.add(src);
      src.onended = () => { active.delete(src); try { g.disconnect(); } catch {} };
      nextStart = end - xf;
    }
    const pump = () => { while (alive && nextStart - ctx.currentTime < 4) schedule(); };
    pump();
    const timer = setInterval(pump, 250);

    let dead = false;
    const dispose = () => {
      if (dead) return; dead = true; alive = false; clearInterval(timer);
      active.forEach((a) => { try { a.stop(); } catch {} });
      try { out.disconnect(); bus.disconnect(); } catch {}
    };
    return {
      setTone,
      setTuning: (c) => { tuning = c; active.forEach((a) => a.detune.setTargetAtTime(c, ctx.currentTime, 0.05)); },
      start: (f) => rampStart(out, f),
      stop: (f) => { alive = false; clearInterval(timer); rampStop(out, f); setTimeout(dispose, (f + 0.5) * 1000); },
      dispose,
    };
  }

  async function buildVoice(want, i) {
    const L = layerBus[i];
    if (want.timbre.startsWith('sample:')) {
      const set = await ensureSamples(want.timbre.slice(7));
      return createSampleVoice(want.key, set, want.mode, L);
    }
    return createSynthVoice(want.key, want.timbre, L);
  }

  // ============================================================ estado -> áudio
  function apply() {
    if (!getSnap() || !ctx || !started) return;
    const s = getSnap().state, t = ctx.currentTime;
    master.gain.setTargetAtTime(Math.pow(s.volume, 2) * 0.9, t, 0.05);
    reverbGain.gain.setTargetAtTime(s.reverb, t, 0.1);
    s.layers.forEach((l, i) => {
      const lv = Math.pow(l.level, 2);
      layerBus[i].dry.gain.setTargetAtTime(lv, t, 0.05);
      layerBus[i].wet.gain.setTargetAtTime(lv, t, 0.05);
      if (cur[i]) { cur[i].voice.setTone(s.tone); cur[i].voice.setTuning(s.tuning); }
      if (l.timbre && l.timbre.startsWith('sample:')) ensureSamples(l.timbre.slice(7)).catch(() => {}); // pré-carrega
      applyLayer(i);
    });
  }

  async function applyLayer(i) {
    const s = getSnap().state, lay = s.layers[i];
    const want = active && s.playing && s.key !== null && lay.timbre ? { key: s.key, timbre: lay.timbre, mode: effMode(lay.timbre, s.mode) } : null;
    const c = cur[i];
    if (!want) {
      if (c) { c.voice.stop(lay.fadeOut); cur[i] = null; }
      return;
    }
    if (c && c.key === want.key && c.timbre === want.timbre && c.mode === want.mode) return;
    const sig = want.key + '|' + want.timbre + '|' + want.mode;
    if (building[i] === sig) return;
    building[i] = sig;

    let voice;
    try { voice = await buildVoice(want, i); }
    catch (e) {
      console.warn(e);
      voice = createSynthVoice(want.key, 'warm', layerBus[i]); // plano B: nunca ficar em silêncio
      onMsg('Samples indisponíveis — usando timbre sintetizado');
    } finally { if (building[i] === sig) building[i] = null; }

    const n = getSnap().state, nl = n.layers[i];
    if (!(active && n.playing && n.key === want.key && nl.timbre === want.timbre && effMode(nl.timbre, n.mode) === want.mode)) { voice.dispose(); return applyLayer(i); }
    if (cur[i]) cur[i].voice.stop(nl.fadeOut);
    voice.setTone(n.tone); voice.setTuning(n.tuning);
    voice.start(nl.fadeIn);
    cur[i] = { key: want.key, timbre: want.timbre, mode: want.mode, voice };
  }


  async function start(sinkId) {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      master = ctx.createGain(); master.gain.value = 0;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -12; limiter.knee.value = 6; limiter.ratio.value = 12; limiter.attack.value = 0.005; limiter.release.value = 0.25;
      dryBus = ctx.createGain();
      reverbGain = ctx.createGain(); reverbGain.gain.value = 0.6;
      convolver = ctx.createConvolver(); convolver.buffer = makeImpulse();
      layerBus = [0, 1].map(() => {
        const dry = ctx.createGain(), wet = ctx.createGain();
        dry.connect(dryBus); wet.connect(convolver);
        return { dry, wet };
      });
      analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      dryBus.connect(master); convolver.connect(reverbGain).connect(master);
      master.connect(limiter).connect(analyser);
      limiter.connect(ctx.destination);
      ctx.onstatechange = () => { if (ctx.state !== 'running') { started = false; onSuspend(); } };
      if (sinkId) { try { await ctx.setSinkId(sinkId); } catch {} }
    }
    try { await ctx.resume(); } catch {}
    started = ctx.state === 'running';
    if (started) apply();
    return started;
  }

  // desligado: faz fade out do que estiver tocando e ignora novos tons (o áudio continua pronto)
  function setActive(v) { active = !!v; apply(); }

  return { start, apply, setActive, get started() { return started; }, get ctx() { return ctx; }, get analyser() { return analyser; } };
}
