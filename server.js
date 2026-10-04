// Hekaya Connect v1 — real-time theatre audience server (up to 40 phones)
//
//   phones  (/)        audience: join by seat (A01…), show whatever the operator triggers
//   admin   (/admin)   operator control laptop, PIN protected
//   screen  (/screen)  theatre LED screen: join QR, results, meters, reveals
//
// Controls: COLOR · WAVE · SPARKLE · PATTERN · MESSAGE · SECRET · IMAGE · COUNTDOWN
//           VOTE · BUZZER · TAP · SHAKE · WINNER · GIFT DROP

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const FX = require('./public/effects.js');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Seat layout ----------
function loadLayout() {
  try {
    return FX.buildLayout(JSON.parse(fs.readFileSync(path.join(__dirname, 'seating.json'), 'utf8')));
  } catch (e) {
    console.warn('  seating.json missing or invalid — using rows A–E × 8');
    return FX.buildLayout({ rows: ['A', 'B', 'C', 'D', 'E'].map((row) => ({ row, seats: 8 })) });
  }
}
const layout = loadLayout();
const N = layout.count;
const labelOf = (n) => (layout.seats[n] ? layout.seats[n].label : '?');
const rowOf = layout.seats.map((s) => (s ? s.rowIndex : 0));
const publicLayout = {
  count: N,
  rows: layout.rows.map((r) => ({ row: r.row, count: r.count, first: r.first })),
  labels: layout.seats.map((s) => (s ? s.label : null)),
};

// ---------- Show state (in memory; one show at a time) ----------
const seats = new Map();     // n -> { deviceId, socketId, online, joinedAt, lastSeen, rtt }
const secrets = new Map();   // n -> { id, text, color, sentAt, seen }
const pastWinners = new Set();
const showLog = [];          // results the operator can download as CSV
let scene = { type: 'idle', id: 0, at: Date.now() };
let nextId = 1;

// Per-activity state (reset whenever a new activity starts)
let votes = new Map();       // n -> option index
let buzz = null;             // { id, goAt, taps: Map n -> ms, falseStarts: Set, results }
let tap = null;              // { id, counts: Map n -> count, startAt, endAt, teams }
let shake = null;            // { id, progress, target, perSeat: Map n -> {v, at} }
let gifts = new Map();       // n -> { prize, isPrize, code, opened }
const timers = new Set();

const now = () => Date.now();
const isHex = (c) => FX.HEX.test(String(c || ''));
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
function later(ms, fn) { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); }
function clearTimers() { for (const t of timers) clearTimeout(t); timers.clear(); }
function log(kind, detail) { showLog.push({ time: new Date().toISOString(), kind, detail }); }

function onlineSeats() { const out = []; for (const [n, s] of seats) if (s.online) out.push(n); return out.sort((a, b) => a - b); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function seatList() {
  const out = [];
  for (let n = 1; n <= N; n++) {
    const s = seats.get(n);
    const sec = secrets.get(n);
    out.push({
      seat: n,
      label: labelOf(n),
      online: !!(s && s.online),
      known: !!s,
      rtt: s && s.online && s.rtt != null ? s.rtt : null,
      secret: sec ? (sec.seen ? 'seen' : 'sent') : null,
    });
  }
  return out;
}

// ---------- HTTP ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 5000, pingTimeout: 5000, maxHttpBufferSize: 1e5 });

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return 'localhost';
}
function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req && req.headers.host;
  if (!host || host.startsWith('localhost') || host.startsWith('127.')) return `http://${lanAddress()}:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${host}`;
}

app.get('/screen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'screen.html')));
app.get('/api/layout', (req, res) => res.json(publicLayout));
app.get('/api/join-url', (req, res) => res.json({ url: publicUrl(req) + '/' }));

// QR as SVG (offline). /qr.svg = general link · /qr.svg?seat=A01 = seat pre-filled
app.get('/qr.svg', async (req, res) => {
  let url = publicUrl(req) + '/';
  const n = FX.parseSeat(layout, req.query.seat);
  if (n) url += `?seat=${labelOf(n)}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(500).send('QR error'); }
});

function adminOnly(req, res, next) {
  if (String(req.get('x-admin-pin') || req.query.pin || '') === ADMIN_PIN) return next();
  res.status(401).json({ error: 'Wrong PIN' });
}

// Image upload for the IMAGE control (raw body, checked by file signature)
app.post('/api/upload', adminOnly, express.raw({ type: () => true, limit: '15mb' }), (req, res) => {
  const b = req.body;
  if (!Buffer.isBuffer(b) || b.length < 12) return res.status(400).json({ error: 'No image received' });
  let ext = null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ext = 'png';
  else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ext = 'jpg';
  else if (b.slice(0, 4).toString() === 'GIF8') ext = 'gif';
  else if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') ext = 'webp';
  if (!ext) return res.status(415).json({ error: 'Please upload a PNG, JPG, GIF or WebP image' });
  const name = crypto.randomBytes(6).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), b);
  res.json({ url: '/uploads/' + name });
});
app.get('/api/uploads', adminOnly, (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter((f) => /\.(png|jpg|gif|webp)$/.test(f))
    .map((f) => ({ url: '/uploads/' + f, t: fs.statSync(path.join(UPLOAD_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  res.json(files);
});

// Show results as CSV (votes, buzzer, tap, winners, gifts with redemption codes)
app.get('/api/results.csv', adminOnly, (req, res) => {
  const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const rows = [['time', 'activity', 'detail']].concat(showLog.map((r) => [r.time, r.kind, r.detail]));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="hekaya-connect-results.csv"')
    .send(rows.map((r) => r.map(esc).join(',')).join('\n'));
});

// ---------- Namespaces ----------
const admin = io.of('/admin');
const screen = io.of('/screen');

admin.use((socket, next) => {
  if (String(socket.handshake.auth?.pin || '') === ADMIN_PIN) return next();
  const err = new Error('Wrong PIN'); err.data = { code: 'bad_pin' }; next(err);
});

function seatsPayload() { return { seats: seatList(), online: onlineSeats().length, max: N }; }
function pushSeats() { const p = seatsPayload(); admin.emit('seats', p); screen.emit('seats', p); }
let seatsTimer = null;
function pushSeatsSoon() { if (!seatsTimer) seatsTimer = setTimeout(() => { seatsTimer = null; pushSeats(); }, 250); }

function socketOf(n) { const s = seats.get(n); return s && s.online ? io.sockets.sockets.get(s.socketId) : null; }
function toSeat(n, ev, data) { const so = socketOf(n); if (so) so.emit(ev, data); }

function setScene(next) {
  clearTimers();
  scene = { ...next, id: next.id || nextId++, at: now() };
  io.to('audience').emit('scene', scene);
  admin.emit('scene', scene);
  screen.emit('scene', scene);
  // Everyone's personal state may have changed (new vote, gift, …)
  for (const n of onlineSeats()) toSeat(n, 'me', meFor(n));
  lastLive = null;
}
function updateScene(patch) {
  scene = { ...scene, ...patch };
  io.to('audience').emit('scene', scene);
  admin.emit('scene', scene);
  screen.emit('scene', scene);
}

// ---------- Live results (throttled) ----------
let lastLive = null;
let liveTimer = null;
function buildLive() {
  switch (scene.type) {
    case 'vote': {
      const counts = scene.options.map(() => 0);
      for (const c of votes.values()) counts[c]++;
      return { kind: 'vote', id: scene.id, counts, voters: votes.size, online: onlineSeats().length };
    }
    case 'tap': {
      if (!tap) return null;
      const list = [...tap.counts].map(([n, c]) => ({ n, label: labelOf(n), count: c })).sort((a, b) => b.count - a.count);
      return { kind: 'tap', id: scene.id, top: list.slice(0, 10), teams: teamTotals(), all: Object.fromEntries(tap.counts) };
    }
    case 'shake': {
      if (!shake) return null;
      const per = {};
      const t = now();
      for (const [n, p] of shake.perSeat) per[n] = t - p.at < 600 ? Math.round(p.v * 100) / 100 : 0;
      return { kind: 'shake', id: scene.id, progress: Math.min(1, shake.progress / shake.target), perSeat: per, done: scene.state === 'done' };
    }
    case 'gift': {
      const opened = [...gifts].filter(([, g]) => g.opened);
      return {
        kind: 'gift', id: scene.id, total: gifts.size, opened: opened.length,
        prizesOpened: opened.filter(([, g]) => g.isPrize).map(([n, g]) => ({ n, label: labelOf(n), prize: g.prize })),
      };
    }
    default: return null;
  }
}
function pushLive() {
  const l = buildLive();
  if (!l) return;
  lastLive = l;
  admin.emit('live', l);
  screen.emit('live', l);
  if (l.kind === 'shake') io.to('audience').emit('live', { kind: 'shake', id: l.id, progress: l.progress, done: l.done });
}
function pushLiveSoon() { if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; pushLive(); }, 200); }

// Admin-only detail: gift assignments
function giftTable() {
  return [...gifts].map(([n, g]) => ({ n, label: labelOf(n), prize: g.prize, isPrize: g.isPrize, code: g.code, opened: g.opened }))
    .sort((a, b) => (b.isPrize - a.isPrize) || a.n - b.n);
}

// ---------- Personal state for one phone ----------
function meFor(n) {
  const me = { seat: n, label: labelOf(n) };
  if (scene.type === 'vote' && votes.has(n)) me.vote = votes.get(n);
  if (scene.type === 'buzzer' && buzz) {
    me.falseStart = buzz.falseStarts.has(n);
    if (buzz.results) {
      const i = buzz.results.findIndex((r) => r.n === n);
      if (i >= 0) me.buzz = { place: i + 1, ms: buzz.results[i].ms };
    } else if (buzz.taps.has(n)) me.buzzed = true;
  }
  if (scene.type === 'tap' && tap) me.taps = tap.counts.get(n) || 0;
  if (scene.type === 'gift' && gifts.has(n)) me.gift = gifts.get(n);
  return me;
}

function teamOf(n) {
  const s = layout.seats[n];
  if (!tap || !s) return null;
  if (tap.teams === 'rows') return 'Row ' + s.row;
  if (tap.teams === 'halves') return s.num <= Math.ceil(s.rowSize / 2) ? 'Left side' : 'Right side';
  return null;
}
function teamTotals() {
  if (!tap || tap.teams === 'solo') return [];
  const t = new Map();
  for (const n of onlineSeats().concat([...tap.counts.keys()])) {
    const name = teamOf(n);
    if (!t.has(name)) t.set(name, { name, total: 0, players: new Set() });
    t.get(name).players.add(n);
  }
  for (const [n, c] of tap.counts) t.get(teamOf(n)).total += c;
  return [...t.values()].map((x) => ({ name: x.name, total: x.total, players: x.players.size, avg: Math.round((x.total / Math.max(1, x.players.size)) * 10) / 10 }))
    .sort((a, b) => b.avg - a.avg);
}

// ---------- Audience sockets ----------
io.on('connection', (socket) => {
  let mySeat = null;
  const mine = () => mySeat && seats.get(mySeat) && seats.get(mySeat).socketId === socket.id;

  socket.on('sync', (_t, ack) => { if (typeof ack === 'function') ack(now()); });

  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const raw = payload && payload.seat;
    const n = typeof raw === 'number' ? (raw >= 1 && raw <= N ? raw : null) : FX.parseSeat(layout, raw);
    const deviceId = str(payload && payload.deviceId, 64);
    if (!n) return reply({ ok: false, error: `That seat doesn't exist. Check the label on your seat (for example ${labelOf(1)}).` });
    if (!deviceId) return reply({ ok: false, error: 'Missing device id.' });

    const existing = seats.get(n);
    if (existing && existing.online && existing.deviceId !== deviceId) {
      return reply({ ok: false, error: `Seat ${labelOf(n)} is already connected on another phone. Please check your seat or ask an usher.` });
    }
    for (const [m, s] of seats) if (s.deviceId === deviceId && m !== n) seats.delete(m);
    if (existing && existing.socketId && existing.socketId !== socket.id) {
      const old = io.sockets.sockets.get(existing.socketId);
      if (old) old.disconnect(true);
    }

    mySeat = n;
    seats.set(n, { deviceId, socketId: socket.id, online: true, joinedAt: existing ? existing.joinedAt : now(), lastSeen: now(), rtt: existing ? existing.rtt : null });
    socket.join('audience');

    // Someone arriving during a gift drop still gets a (consolation) gift
    if (scene.type === 'gift' && !gifts.has(n)) {
      gifts.set(n, { prize: scene.consolation, isPrize: false, code: null, opened: false });
    }

    reply({ ok: true, seat: n, label: labelOf(n), scene, me: meFor(n), serverTime: now() });
    const sec = secrets.get(n);
    if (sec && !sec.seen) socket.emit('secret', sec);
    if (lastLive && lastLive.kind === 'shake') socket.emit('live', { kind: 'shake', id: lastLive.id, progress: lastLive.progress, done: lastLive.done });
    pushSeats();
  });

  socket.on('leave', () => {
    if (mine()) { seats.delete(mySeat); mySeat = null; socket.leave('audience'); pushSeats(); }
  });

  socket.on('disconnect', () => {
    if (mine()) { const s = seats.get(mySeat); s.online = false; s.lastSeen = now(); pushSeats(); }
  });

  socket.on('rtt', (ms) => {
    const v = Math.round(Number(ms));
    if (mine() && v >= 0 && v < 60000 && seats.get(mySeat).rtt !== v) { seats.get(mySeat).rtt = v; pushSeatsSoon(); }
  });

  // SECRET acknowledged
  socket.on('secretSeen', (p) => {
    const sec = mySeat && secrets.get(mySeat);
    if (mine() && sec && sec.id === p?.id) { sec.seen = true; pushSeats(); }
  });

  // VOTE
  socket.on('vote', (p) => {
    if (!mine() || scene.type !== 'vote' || scene.state !== 'open' || p?.id !== scene.id) return;
    const c = Number(p.choice);
    if (!Number.isInteger(c) || c < 0 || c >= scene.options.length) return;
    votes.set(mySeat, c);
    socket.emit('me', meFor(mySeat));
    pushLiveSoon();
  });

  // BUZZER — the phone sends its synced clock reading; we compensate for Wi-Fi delay
  socket.on('buzz', (p) => {
    if (!mine() || scene.type !== 'buzzer' || !buzz || p?.id !== scene.id || buzz.results) return;
    const n = mySeat;
    if (buzz.falseStarts.has(n) || buzz.taps.has(n)) return;
    const received = now();
    const claimed = Number(p.at);
    if (scene.state === 'armed' || (Number.isFinite(claimed) && claimed < buzz.goAt - 15) || received < buzz.goAt - 15) {
      buzz.falseStarts.add(n);
      socket.emit('me', meFor(n));
      return;
    }
    let at = Number.isFinite(claimed) ? claimed : received;
    at = Math.min(Math.max(at, buzz.goAt), received); // never earlier than GO, never later than arrival
    buzz.taps.set(n, at);
    socket.emit('me', meFor(n));
    if (buzz.taps.size === 1) later(350, decideBuzzer); // short window so a phone on slower Wi-Fi isn't robbed
  });

  // TAP challenge — cumulative count, capped at a humanly possible rate
  socket.on('taps', (p) => {
    if (!mine() || scene.type !== 'tap' || !tap || p?.id !== scene.id) return;
    const t = now();
    if (t < tap.startAt - 150 || t > tap.endAt + 800) return;
    const elapsed = Math.max(0, Math.min(t, tap.endAt) - tap.startAt) / 1000;
    const cap = Math.floor(elapsed * 14) + 3; // ~14 taps/s is about the human limit
    const c = Math.min(Math.max(0, Math.floor(Number(p.count) || 0)), cap);
    if (c > (tap.counts.get(mySeat) || 0)) { tap.counts.set(mySeat, c); pushLiveSoon(); }
  });

  // SHAKE — intensity 0..1 reported ~5×/second
  socket.on('shake', (p) => {
    if (!mine() || scene.type !== 'shake' || !shake || scene.state !== 'live' || p?.id !== scene.id) return;
    const t = now();
    const prev = shake.perSeat.get(mySeat);
    if (prev && t - prev.at < 150) return;
    const v = Math.max(0, Math.min(1, Number(p.v) || 0));
    shake.perSeat.set(mySeat, { v, at: t });
    shake.progress += v * 0.2;
    if (shake.progress >= shake.target) {
      updateScene({ state: 'done' });
      log('shake', `${scene.label || 'Shake'} — goal reached`);
    }
    pushLiveSoon();
  });

  // GIFT opened
  socket.on('giftOpen', (p) => {
    if (!mine() || scene.type !== 'gift' || p?.id !== scene.id) return;
    const g = gifts.get(mySeat);
    if (g && !g.opened) { g.opened = true; socket.emit('me', meFor(mySeat)); pushLiveSoon(); admin.emit('gifts', giftTable()); }
  });
});

function decideBuzzer() {
  if (!buzz || scene.type !== 'buzzer' || buzz.results) return;
  buzz.results = [...buzz.taps].map(([n, at]) => ({ n, label: labelOf(n), ms: Math.round(at - buzz.goAt) })).sort((a, b) => a.ms - b.ms);
  const w = buzz.results[0];
  log('buzzer', `${w.label} first (${(w.ms / 1000).toFixed(3)} s)`);
  // Keep the buzzer scene running so late taps are recorded, but declare the winner now.
  scene = { ...scene, state: 'done', winner: w, top: buzz.results.slice(0, 5) };
  io.to('audience').emit('scene', scene); admin.emit('scene', scene); screen.emit('scene', scene);
  for (const n of onlineSeats()) toSeat(n, 'me', meFor(n));
}

// ---------- Theatre screen ----------
screen.on('connection', (socket) => {
  socket.on('sync', (_t, ack) => { if (typeof ack === 'function') ack(now()); });
  socket.emit('seats', seatsPayload());
  socket.emit('scene', scene);
  if (lastLive) socket.emit('live', lastLive);
});

// ---------- Operator controls ----------
const LEAD = 600; // ms ahead, so every phone has the command before an effect starts

admin.on('connection', (socket) => {
  socket.on('sync', (_t, ack) => { if (typeof ack === 'function') ack(now()); });
  socket.emit('layout', publicLayout);
  socket.emit('seats', seatsPayload());
  socket.emit('scene', scene);
  if (lastLive) socket.emit('live', lastLive);
  if (scene.type === 'gift') socket.emit('gifts', giftTable());

  const fail = (msg) => socket.emit('notice', { level: 'error', text: msg });
  const on = (ev, fn) => socket.on(ev, (p) => { try { fn(p || {}); } catch (e) { console.error(ev, e); fail('Something went wrong: ' + e.message); } });

  on('idle', () => setScene({ type: 'idle' }));

  // COLOR
  on('color', (p) => { if (isHex(p.color)) setScene({ type: 'color', color: p.color.toLowerCase() }); });

  // WAVE
  on('wave', (p) => {
    const w = FX.normaliseWave(p);
    setScene({ type: 'wave', ...w, count: N, rowOf, rowCount: layout.rows.length, startAt: now() + LEAD });
  });
  on('stopEffect', (p) => setScene({ type: 'color', color: isHex(p.color) ? p.color.toLowerCase() : '#000000' }));

  // SPARKLE
  on('sparkle', (p) => setScene({ type: 'sparkle', ...FX.normaliseSparkle(p), startAt: now() + LEAD }));

  // PATTERN
  on('pattern', (p) => {
    const kind = FX.PATTERNS.includes(p.kind) ? p.kind : 'alternate';
    const colors = (Array.isArray(p.colors) ? p.colors : []).filter(isHex).slice(0, 6);
    const map = FX.buildPattern(layout, kind, colors, crypto.randomInt(1e9));
    setScene({ type: 'pattern', kind, map, base: '#000000' });
  });

  // MESSAGE (everyone)
  on('message', (p) => {
    const text = str(p.text, 280);
    if (!text) return fail('Type a message first.');
    setScene({ type: 'message', text, color: isHex(p.color) ? p.color : '#0b0a10' });
  });

  // SECRET (one seat)
  on('secret', (p) => {
    const n = Number(p.seat);
    const text = str(p.text, 280);
    if (!layout.seats[n]) return fail('Pick a seat first.');
    if (!text) return fail('Type the secret message first.');
    const sec = { id: nextId++, text, color: isHex(p.color) ? p.color : '#5b2bd6', sentAt: now(), seen: false };
    secrets.set(n, sec);
    toSeat(n, 'secret', sec);
    log('secret', `${labelOf(n)}: ${text}`);
    pushSeats();
    if (!socketOf(n)) socket.emit('notice', { level: 'warn', text: `${labelOf(n)} isn't connected right now — they'll see it as soon as they join.` });
  });
  on('secretClear', (p) => {
    const n = Number(p.seat);
    if (secrets.delete(n)) { toSeat(n, 'secretClear', {}); pushSeats(); }
  });

  // IMAGE
  on('image', (p) => {
    const url = String(p.url || '');
    if (!/^\/uploads\/[a-f0-9]{12}\.(png|jpg|gif|webp)$/.test(url)) return fail('Upload an image first.');
    setScene({ type: 'image', url, fit: p.fit === 'cover' ? 'cover' : 'contain', caption: str(p.caption, 80) });
  });

  // COUNTDOWN
  on('countdown', (p) => {
    const seconds = Math.round(FX.clamp(p.seconds, 1, 3600, 10));
    setScene({
      type: 'countdown', seconds, endAt: now() + LEAD + seconds * 1000,
      label: str(p.label, 60), endText: str(p.endText, 40) || 'NOW!', color: isHex(p.color) ? p.color : '#d9a441',
    });
  });

  // VOTE
  on('voteStart', (p) => {
    const question = str(p.question, 120);
    const options = (Array.isArray(p.options) ? p.options : [])
      .map((o) => ({ label: str(o && o.label, 30), color: isHex(o && o.color) ? o.color : '#1e5bff' }))
      .filter((o) => o.label).slice(0, 4);
    if (!question) return fail('Type the question first.');
    if (options.length < 2) return fail('A vote needs at least two options.');
    votes = new Map();
    setScene({ type: 'vote', question, options, state: 'open', hideLive: !!p.hideLive, showResults: false });
    pushLive();
  });
  on('voteClose', () => {
    if (scene.type !== 'vote' || scene.state !== 'open') return;
    const l = buildLive();
    updateScene({ state: 'closed', tally: l.counts });
    const lead = l.counts.indexOf(Math.max(...l.counts));
    log('vote', `${scene.question} — ` + scene.options.map((o, i) => `${o.label}: ${l.counts[i]}`).join(', ') + ` → ${scene.options[lead].label}`);
    pushLive();
  });
  on('voteResults', () => {
    if (scene.type !== 'vote') return;
    updateScene({ showResults: true, tally: buildLive().counts });
  });
  on('votePattern', () => {
    if (scene.type !== 'vote') return;
    const map = {};
    for (const [n, c] of votes) map[n] = scene.options[c].color;
    setScene({ type: 'pattern', kind: 'vote', map, base: '#000000' });
  });

  // BUZZER
  on('buzzerArm', () => {
    buzz = { goAt: null, taps: new Map(), falseStarts: new Set(), results: null };
    setScene({ type: 'buzzer', state: 'armed' });
  });
  on('buzzerGo', () => {
    if (scene.type !== 'buzzer' || scene.state !== 'armed' || !buzz) return fail('Arm the buzzer first.');
    buzz.goAt = now() + LEAD;
    updateScene({ state: 'live', goAt: buzz.goAt });
  });

  // TAP challenge
  on('tapStart', (p) => {
    const seconds = Math.round(FX.clamp(p.seconds, 5, 60, 10));
    const teams = ['solo', 'rows', 'halves'].includes(p.teams) ? p.teams : 'solo';
    const startAt = now() + LEAD + 3000; // 3-2-1 on every phone first
    tap = { counts: new Map(), startAt, endAt: startAt + seconds * 1000, teams };
    setScene({ type: 'tap', state: 'live', startAt, endAt: tap.endAt, seconds, teams });
    const id = scene.id;
    later(tap.endAt - now() + 900, () => {
      if (scene.id !== id) return;
      const l = buildLive();
      const winner = l.top[0] || null;
      const teamsRes = l.teams;
      updateScene({ state: 'done', winner, top: l.top.slice(0, 5), teamResults: teamsRes });
      for (const n of onlineSeats()) toSeat(n, 'me', meFor(n));
      log('tap', winner ? `${winner.label} ${winner.count} taps` + (teamsRes.length ? ` · team ${teamsRes[0].name} (${teamsRes[0].avg} avg)` : '') : 'no taps');
      pushLive();
    });
    pushLive();
  });

  // SHAKE
  on('shakeStart', (p) => {
    const per = { easy: 3, normal: 6, hard: 12 }[p.difficulty] || 6;
    shake = { progress: 0, target: Math.max(1, onlineSeats().length) * per, perSeat: new Map() };
    setScene({ type: 'shake', state: 'live', label: str(p.label, 60) || 'Shake your phone!', difficulty: p.difficulty || 'normal' });
    pushLive();
  });
  on('shakeStop', () => { if (scene.type === 'shake') { updateScene({ state: 'done' }); pushLive(); } });

  // WINNER — random connected seat
  on('winnerDraw', (p) => {
    let pool = onlineSeats();
    if (p.excludePrevious) pool = pool.filter((n) => !pastWinners.has(n));
    if (!pool.length) return fail(p.excludePrevious ? 'Every connected seat has already won. Untick "skip previous winners".' : 'No phones are connected.');
    const n = pool[crypto.randomInt(pool.length)];
    const spinMs = Math.round(FX.clamp(p.spinMs, 2000, 10000, 4000));
    const prize = str(p.prize, 80);
    const startAt = now() + LEAD;
    const spin = FX.normaliseSparkle({ colors: ['#ffb800', '#ffffff'], density: 0.35, slotMs: 110, seed: crypto.randomInt(1e9) });
    spin.startAt = startAt;
    setScene({ type: 'winner', state: 'spinning', prize, revealAt: startAt + spinMs, pool: pool.map(labelOf), spin });
    const id = scene.id;
    later(startAt + spinMs - now(), () => {
      if (scene.id !== id) return;
      pastWinners.add(n);
      log('winner', `${labelOf(n)}${prize ? ' — ' + prize : ''}`);
      updateScene({ state: 'revealed', winner: { n, label: labelOf(n) } });
    });
  });

  // GIFT DROP — different phones, different rewards
  on('giftDrop', (p) => {
    const pool = shuffle(onlineSeats());
    if (!pool.length) return fail('No phones are connected.');
    const prizes = (Array.isArray(p.prizes) ? p.prizes : [])
      .map((x) => ({ name: str(x && x.name, 40), qty: Math.round(FX.clamp(x && x.qty, 0, N, 0)) }))
      .filter((x) => x.name && x.qty > 0);
    const consolation = str(p.consolation, 60) || 'Thank you for playing!';
    const codes = new Set();
    const code = () => {
      const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      let c;
      do { c = 'HK-' + Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join(''); } while (codes.has(c));
      codes.add(c);
      return c;
    };
    gifts = new Map();
    let i = 0;
    for (const pr of prizes) for (let k = 0; k < pr.qty && i < pool.length; k++, i++) gifts.set(pool[i], { prize: pr.name, isPrize: true, code: code(), opened: false });
    for (; i < pool.length; i++) gifts.set(pool[i], { prize: consolation, isPrize: false, code: null, opened: false });
    const title = str(p.title, 60) || 'Gift drop!';
    setScene({ type: 'gift', title, consolation, prizeCount: [...gifts.values()].filter((g) => g.isPrize).length });
    for (const row of giftTable()) if (row.isPrize) log('gift', `${row.label}: ${row.prize} (${row.code})`);
    admin.emit('gifts', giftTable());
    pushLive();
  });

  // Housekeeping
  on('clearOffline', () => { for (const [n, s] of seats) if (!s.online) seats.delete(n); pushSeats(); });
  on('resetShow', () => {
    clearTimers();
    seats.clear(); secrets.clear(); pastWinners.clear(); votes = new Map(); gifts = new Map(); buzz = tap = shake = null;
    io.to('audience').emit('reset');
    io.in('audience').socketsLeave('audience');
    scene = { type: 'idle', id: nextId++, at: now() };
    lastLive = null;
    pushSeats();
    admin.emit('scene', scene); screen.emit('scene', scene);
  });
});

server.listen(PORT, () => {
  const base = `http://${lanAddress()}:${PORT}`;
  console.log('\n  Hekaya Connect is running');
  console.log(`  Seats:              ${N} (${layout.rows.map((r) => r.row + ' ×' + r.count).join(', ')})`);
  console.log(`  Audience (phones):  ${base}/`);
  console.log(`  Admin control:      ${base}/admin`);
  console.log(`  Theatre screen:     ${base}/screen`);
  console.log(`  Printable seat QRs: ${base}/qr-sheet`);
  console.log(`  Admin PIN:          ${ADMIN_PIN === '1234' ? '1234 (default — set ADMIN_PIN to change)' : '(custom)'}\n`);
});
