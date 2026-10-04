// Hekaya Connect — shared effects engine (used by phones, admin, theatre screen, server and tests)
//
// Every light effect is a deterministic timeline. The server sends ONE scene with a start time in
// SERVER clock; each device (knowing its clock offset to the server) works out what colour a seat
// should show at any moment. Nothing else is sent while it runs, so Wi-Fi delays can't make it
// stutter, and a phone that rejoins mid-effect falls straight into step.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HekayaFX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var HEX = /^#[0-9a-fA-F]{6}$/;

  function clamp(n, lo, hi, dflt) {
    n = Number(n);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }
  function hex(c, d) { return HEX.test(c) ? String(c).toLowerCase() : d; }

  // ---------- Seat layout ----------
  // layout = { rows: [{row:'A', seats:8}, ...] } -> seats numbered 1..N front-to-back, left-to-right.
  function buildLayout(cfg) {
    var rows = (cfg && cfg.rows) || [];
    var seats = [null]; // 1-based
    var rowList = [];
    rows.forEach(function (r, ri) {
      var letter = String(r.row || '').toUpperCase().slice(0, 2);
      var count = Math.max(0, Math.min(40, Math.round(Number(r.seats) || 0)));
      var first = seats.length;
      for (var i = 1; i <= count; i++) {
        seats.push({ n: seats.length, label: letter + (i < 10 ? '0' : '') + i, row: letter, rowIndex: ri, num: i, rowSize: count });
      }
      rowList.push({ row: letter, index: ri, first: first, count: count });
    });
    return { seats: seats, rows: rowList, count: seats.length - 1 };
  }

  // Accepts "A01", "a1", "A 1", "A-01", "b07" -> seat number, or null.
  function parseSeat(layout, text) {
    var m = /^\s*([A-Za-z]{1,2})\s*-?\s*0*(\d{1,2})\s*$/.exec(String(text || ''));
    if (!m) return null;
    var row = m[1].toUpperCase(), num = Number(m[2]);
    for (var n = 1; n <= layout.count; n++) {
      var s = layout.seats[n];
      if (s.row === row && s.num === num) return n;
    }
    return null;
  }

  // ---------- Deterministic random ----------
  function hash3(a, b, c) {
    var h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // ---------- WAVE ----------
  var WAVE_ORDERS = ['forward', 'reverse', 'rows', 'rowsBack', 'centre', 'edges', 'pingpong'];

  function normaliseWave(p) {
    p = p || {};
    return {
      color: hex(p.color, '#1e5bff'),
      base: hex(p.base, '#000000'),
      order: WAVE_ORDERS.indexOf(p.order) >= 0 ? p.order : 'forward',
      mode: p.mode === 'fill' ? 'fill' : 'flash',
      stepMs: Math.round(clamp(p.stepMs, 15, 1500, 80)),
      holdMs: Math.round(clamp(p.holdMs, 60, 3000, 350)),
      gapMs: Math.round(clamp(p.gapMs, 0, 5000, 400)),
      loops: Math.round(clamp(p.loops, 0, 50, 1)), // 0 = until stopped
    };
  }

  // Position of a seat along the wave (0 = first to light).
  function waveIndex(w, n, pass) {
    var N = w.count;
    var half = (N + 1) / 2;
    switch (w.order) {
      case 'reverse': return N - n;
      case 'rows': return w.rowOf[n];
      case 'rowsBack': return w.rowCount - 1 - w.rowOf[n];
      case 'centre': return Math.floor(Math.abs(n - half));
      case 'edges': return Math.floor((N - 1) / 2) - Math.floor(Math.abs(n - half));
      case 'pingpong': return pass % 2 === 0 ? n - 1 : N - n;
      default: return n - 1;
    }
  }
  function waveMaxIndex(w) {
    if (w.order === 'rows' || w.order === 'rowsBack') return w.rowCount - 1;
    if (w.order === 'centre' || w.order === 'edges') return Math.floor((w.count - 1) / 2);
    return w.count - 1;
  }
  function wavePass(w) { return waveMaxIndex(w) * w.stepMs + (w.mode === 'flash' ? w.holdMs : 0); }
  function wavePeriod(w) { return wavePass(w) + w.gapMs; }
  function waveTotal(w) { return w.loops === 0 ? Infinity : w.loops * wavePeriod(w) - w.gapMs; }
  function waveOnset(w, n) { return w.startAt + waveIndex(w, n, 0) * w.stepMs; }

  function waveColour(w, n, t) {
    var elapsed = t - w.startAt;
    if (elapsed < 0) return { color: w.base, done: false };
    var per = wavePeriod(w);
    var pass = Math.floor(elapsed / per);
    if (w.loops > 0 && pass >= w.loops) {
      if (w.mode === 'flash') return { color: w.base, done: true };
      return { color: (w.loops - 1) % 2 === 0 ? w.color : w.base, done: true };
    }
    var tp = elapsed - pass * per;
    var start = waveIndex(w, n, pass) * w.stepMs;
    if (w.mode === 'flash') return { color: tp >= start && tp < start + w.holdMs ? w.color : w.base, done: false };
    var cur = pass % 2 === 0 ? w.color : w.base;
    var prev = pass === 0 ? w.base : (pass % 2 === 0 ? w.base : w.color);
    return { color: tp >= start ? cur : prev, done: false };
  }

  // ---------- SPARKLE ----------
  function normaliseSparkle(p) {
    p = p || {};
    var colors = (Array.isArray(p.colors) ? p.colors : []).filter(function (c) { return HEX.test(c); }).slice(0, 6);
    if (!colors.length) colors = ['#ffffff'];
    return {
      colors: colors.map(function (c) { return c.toLowerCase(); }),
      base: hex(p.base, '#000000'),
      density: clamp(p.density, 0.03, 0.9, 0.25),  // share of phones lit at any moment
      slotMs: Math.round(clamp(p.slotMs, 60, 2000, 220)), // how often the pattern reshuffles
      durationMs: Math.round(clamp(p.durationMs, 0, 600000, 0)), // 0 = until stopped
      seed: Math.floor(clamp(p.seed, 0, 2147483647, Math.floor(Math.random() * 1e9))),
    };
  }
  function sparkleColour(s, n, t) {
    var elapsed = t - s.startAt;
    if (elapsed < 0) return { color: s.base, done: false };
    if (s.durationMs > 0 && elapsed >= s.durationMs) return { color: s.base, done: true };
    var slot = Math.floor(elapsed / s.slotMs);
    var lit = hash3(s.seed, n, slot) < s.density;
    if (!lit) return { color: s.base, done: false };
    var ci = Math.floor(hash3(s.seed + 7, n, slot) * s.colors.length);
    return { color: s.colors[ci], done: false };
  }

  // ---------- PATTERN (different seats, different colours) ----------
  var PATTERNS = ['alternate', 'rows', 'halves', 'rainbow', 'random', 'checker'];
  function buildPattern(layout, kind, colors, seed) {
    colors = (colors || []).filter(function (c) { return HEX.test(c); });
    if (!colors.length) colors = ['#ff1f3d', '#1e5bff'];
    var map = {};
    var N = layout.count;
    for (var n = 1; n <= N; n++) {
      var s = layout.seats[n];
      var i;
      switch (kind) {
        case 'rows': i = s.rowIndex % colors.length; break;
        case 'halves': i = s.num <= Math.ceil(s.rowSize / 2) ? 0 : 1 % colors.length; break;
        case 'checker': i = (s.rowIndex + s.num) % 2 % colors.length; break;
        case 'random': i = Math.floor(hash3(seed || 1, n, 0) * colors.length); break;
        case 'rainbow': {
          var hue = Math.round(((n - 1) / Math.max(1, N)) * 330);
          map[n] = hslHex(hue, 95, 55);
          continue;
        }
        default: i = (n - 1) % colors.length; // alternate seat by seat
      }
      map[n] = colors[i];
    }
    return map;
  }
  function hslHex(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    var to = function (x) { var v = Math.round(x * 255).toString(16); return v.length < 2 ? '0' + v : v; };
    return '#' + to(f(0)) + to(f(8)) + to(f(4));
  }

  // ---------- What colour should seat n show for a light scene at time t ----------
  // Returns null for scenes that aren't simple lighting (messages, games ...).
  function seatColour(scene, n, t) {
    if (!scene) return null;
    switch (scene.type) {
      case 'color': return { color: scene.color, done: true };
      case 'wave': return waveColour(scene, n, t);
      case 'sparkle': return sparkleColour(scene, n, t);
      case 'pattern': return { color: scene.map[n] || scene.base || '#000000', done: true };
      case 'winner':
        if (scene.state === 'spinning') return sparkleColour(scene.spin, n, t);
        return { color: scene.winner && scene.winner.n === n ? '#ffb800' : '#000000', done: true };
      default: return null;
    }
  }

  function luminance(c) {
    c = String(c || '#000000').replace('#', '');
    return (0.299 * parseInt(c.slice(0, 2), 16) + 0.587 * parseInt(c.slice(2, 4), 16) + 0.114 * parseInt(c.slice(4, 6), 16)) / 255;
  }

  return {
    HEX: HEX, clamp: clamp, hash3: hash3, luminance: luminance,
    buildLayout: buildLayout, parseSeat: parseSeat,
    WAVE_ORDERS: WAVE_ORDERS, normaliseWave: normaliseWave, waveIndex: waveIndex,
    wavePass: wavePass, wavePeriod: wavePeriod, waveTotal: waveTotal, waveOnset: waveOnset, waveColour: waveColour,
    normaliseSparkle: normaliseSparkle, sparkleColour: sparkleColour,
    PATTERNS: PATTERNS, buildPattern: buildPattern,
    seatColour: seatColour,
  };
});
