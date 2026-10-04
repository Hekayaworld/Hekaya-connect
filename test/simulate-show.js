// Hekaya Connect v1 — full show simulation: 40 phones, the admin and the theatre screen.
// Exercises every control. Phones get deliberately wrong clocks and jittery Wi-Fi.
// Usage: node test/simulate-show.js [http://localhost:3000] [PIN]
const { io } = require('socket.io-client');
const FX = require('../public/effects.js');

const URL = process.argv[2] || 'http://localhost:3000';
const PIN = process.argv[3] || process.env.ADMIN_PIN || '1234';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
let failures = 0, passes = 0;
function check(cond, msg) { console.log((cond ? '  PASS ' : '  FAIL ') + msg); cond ? passes++ : failures++; }
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const opts = { transports: ['websocket'], forceNew: true, reconnection: false };

function makePhone(label, extraDelay = 0) {
  const skew = rand(-5000, 5000);
  const clock = () => Date.now() + skew;
  const s = io(URL, opts);
  const ph = { label, s, skew, offset: 0, scene: null, me: null, secret: null, live: null, changes: [], last: null, sceneLog: [] };
  const jitter = () => rand(2, 40) + extraDelay;
  ph.serverNow = () => clock() + ph.offset;
  ph.sync = async () => {
    let best = null;
    for (let i = 0; i < 8; i++) {
      const r = await new Promise((res) => {
        const t0 = clock();
        setTimeout(() => s.timeout(2000).emit('sync', t0, (err, st) => setTimeout(() => {
          if (err) return res(null);
          const t1 = clock(); res({ rtt: t1 - t0, off: st - (t0 + t1) / 2 });
        }, jitter())), jitter());
      });
      if (r && (!best || r.rtt < best.rtt)) best = r;
      await wait(15);
    }
    ph.offset = best.off; s.emit('rtt', Math.round(best.rtt));
  };
  s.on('scene', (sc) => setTimeout(() => { ph.scene = sc; ph.sceneLog.push(sc); }, rand(0, 250) + extraDelay));
  s.on('me', (m) => { ph.me = m; });
  s.on('secret', (x) => { ph.secret = x; });
  s.on('secretClear', () => { ph.secret = null; });
  s.on('live', (l) => { ph.live = l; });
  s.on('reset', () => { ph.scene = null; ph.reset = true; });
  ph.timer = setInterval(() => {
    const st = FX.seatColour(ph.scene, ph.n, ph.serverNow());
    const c = st ? st.color : null;
    if (c !== ph.last) { ph.last = c; ph.changes.push({ c, t: Date.now() }); }
  }, 16);
  ph.join = (seat = label) => new Promise((resolve) => {
    const go = () => s.emit('join', { seat, deviceId: 'dev-' + label }, (r) => { if (r && r.ok) { ph.n = r.seat; ph.scene = r.scene; ph.me = r.me; } resolve(r); });
    s.connected ? go() : s.once('connect', go);
  });
  ph.close = () => { clearInterval(ph.timer); s.close(); };
  return ph;
}

(async () => {
  console.log(`Hekaya Connect v1 — full show test against ${URL}\n`);
  const layout = await (await fetch(URL + '/api/layout')).json();
  const labels = layout.labels.slice(1);
  const N = layout.count;

  const adminS = io(URL + '/admin', { ...opts, auth: { pin: PIN } });
  const A = { seats: null, scene: null, live: null, gifts: null, notices: [] };
  adminS.on('seats', (d) => { A.seats = d; });
  adminS.on('scene', (s) => { A.scene = s; });
  adminS.on('live', (l) => { A.live = l; });
  adminS.on('gifts', (g) => { A.gifts = g; });
  adminS.on('notice', (n) => { A.notices.push(n); });
  await new Promise((r) => adminS.on('connect', r));
  const cmd = (ev, p) => adminS.emit(ev, p || {});

  const screenS = io(URL + '/screen', opts);
  const SC = { scene: null, live: null, seats: null };
  screenS.on('scene', (s) => { SC.scene = s; });
  screenS.on('live', (l) => { SC.live = l; });
  screenS.on('seats', (d) => { SC.seats = d; });
  await new Promise((r) => screenS.on('connect', r));

  cmd('resetShow'); await wait(300);

  // ---------- Joining ----------
  console.log('Joining');
  check(N === 40 && labels[0] === 'A01' && labels[39] === 'E08', `layout has ${N} seats, ${labels[0]} … ${labels[39]}`);
  const bad = await new Promise((r) => { const s = io(URL + '/admin', { ...opts, auth: { pin: 'x' } }); s.on('connect_error', (e) => { r(e.message); s.close(); }); s.on('connect', () => { r('ok'); s.close(); }); });
  check(bad === 'Wrong PIN', 'admin refuses a wrong PIN');
  const phones = labels.map((l) => makePhone(l));
  const joins = await Promise.all(phones.map((p, i) => p.join(i % 3 === 0 ? l2loose(p.label) : p.label)));
  check(joins.every((r) => r.ok), 'all 40 phones joined (including typed as "a1", "B 2" style)');
  await wait(300);
  check(A.seats.online === 40 && SC.seats.online === 40, 'control laptop and theatre screen both show 40 / 40 connected');
  const ghost = makePhone('Z99'); const g = await ghost.join('Z99'); ghost.close();
  check(!g.ok, 'non-existent seat Z99 refused');
  const dup = makePhone('A05'); dup.s.io.opts.query = {}; const d2 = await new Promise((r) => dup.s.once('connect', () => dup.s.emit('join', { seat: 'A05', deviceId: 'intruder' }, r)));
  check(!d2.ok && /already connected/.test(d2.error), 'second phone cannot take live seat A05'); dup.close();
  await Promise.all(phones.map((p) => p.sync()));
  const syncErr = phones.map((p) => Math.abs(p.offset + p.skew));
  check(Math.max(...syncErr) < 30, `clocks synced (wrong by up to ±5 s before): worst error ${Math.max(...syncErr).toFixed(0)} ms`);

  // ---------- COLOR ----------
  console.log('\nCOLOR');
  cmd('color', { color: '#1e5bff' }); await wait(400);
  check(phones.every((p) => p.last === '#1e5bff'), 'all 40 phones blue');

  // ---------- WAVE ----------
  console.log('\nWAVE');
  for (const [order, stepMs] of [['forward', 80], ['rows', 250]]) {
    cmd('color', { color: '#000000' }); await wait(400);
    phones.forEach((p) => { p.changes = []; });
    cmd('wave', { color: '#ffb800', base: '#000000', order, mode: 'flash', stepMs, holdMs: 300, loops: 1 });
    await wait(300);
    const sc = A.scene;
    await wait(600 + FX.waveTotal(sc) + 400);
    const errs = phones.map((p) => { const on = p.changes.find((c) => c.c === '#ffb800'); return on ? Math.abs(on.t - FX.waveOnset(sc, p.n)) : 9999; });
    check(Math.max(...errs) < 45, `${order === 'rows' ? 'row by row (A→E)' : 'seat A01 → E08'}: every phone lit within ${Math.max(...errs).toFixed(0)} ms of plan (median ${median(errs).toFixed(0)} ms)`);
    if (order === 'rows') {
      const t = (lab) => phones.find((p) => p.label === lab).changes.find((c) => c.c === '#ffb800').t;
      check(Math.abs(t('A01') - t('A08')) < 50 && t('B01') - t('A01') > 180, 'whole rows light together, front row first');
    }
  }

  // ---------- SPARKLE ----------
  console.log('\nSPARKLE');
  cmd('sparkle', { colors: ['#ffffff', '#ffb800'], base: '#000000', density: 0.3, slotMs: 200, durationMs: 0 });
  await wait(1500);
  const sc = A.scene;
  // Sample in the middle of a 200 ms slot (not right on a boundary)
  const el = Date.now() - sc.startAt;
  const t = sc.startAt + (Math.floor(el / sc.slotMs) + 1) * sc.slotMs + sc.slotMs / 2;
  const dt = t - Date.now();
  let agree = 0, litCount = 0;
  for (const p of phones) {
    const mine = FX.sparkleColour(p.scene, p.n, p.serverNow() + dt).color;
    const truth = FX.sparkleColour(sc, p.n, t).color;
    if (mine === truth) agree++;
    if (truth !== '#000000') litCount++;
  }
  check(agree === 40, `phones agree on which seats sparkle (${agree}/40 match the plan)`);
  check(litCount > 2 && litCount < 30, `about 30% of phones lit at a moment (${litCount}/40)`);
  const distinct = new Set(phones.map((p) => p.changes.length));
  check(phones.every((p) => p.changes.length >= 2) || distinct.size > 1, 'sparkle keeps changing over time');

  // ---------- PATTERN ----------
  console.log('\nPATTERN');
  cmd('pattern', { kind: 'rows', colors: ['#ff1f3d', '#1e5bff', '#12d66b'] }); await wait(400);
  const byLabel = (l) => phones.find((p) => p.label === l);
  check(byLabel('A03').last === '#ff1f3d' && byLabel('B03').last === '#1e5bff' && byLabel('C07').last === '#12d66b' && byLabel('D01').last === '#ff1f3d', 'rows get different colours (A red, B blue, C green, D red …)');
  cmd('pattern', { kind: 'halves', colors: ['#ffffff', '#8a2bff'] }); await wait(400);
  check(byLabel('C02').last === '#ffffff' && byLabel('C07').last === '#8a2bff', 'left half / right half split');

  // ---------- MESSAGE ----------
  console.log('\nMESSAGE');
  cmd('message', { text: 'مرحبا! Welcome to Hekaya', color: '#5b2bd6' }); await wait(400);
  check(phones.every((p) => p.scene.type === 'message' && p.scene.text === 'مرحبا! Welcome to Hekaya'), 'message (Arabic + English) on all 40 phones');
  check(SC.scene.type === 'message', 'theatre screen shows the message too');

  // ---------- SECRET ----------
  console.log('\nSECRET');
  cmd('secret', { seat: 18, text: 'Stand up when the lights go red.' }); await wait(300);
  const target = phones.find((p) => p.n === 18);
  check(target.secret && target.secret.text.startsWith('Stand up'), `${target.label} received the secret`);
  check(phones.filter((p) => p.secret).length === 1, 'nobody else received it');
  check(A.seats.seats[17].secret === 'sent', 'operator sees "sent"');
  target.s.emit('secretSeen', { id: target.secret.id }); await wait(300);
  check(A.seats.seats[17].secret === 'seen', 'operator sees "seen" after the guest taps Got it');

  // ---------- IMAGE ----------
  console.log('\nIMAGE');
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360f8cf00000301010018dd8db40000000049454e44ae426082', 'hex');
  const up = await fetch(URL + '/api/upload', { method: 'POST', headers: { 'x-admin-pin': PIN, 'content-type': 'image/png' }, body: png });
  const upj = await up.json();
  check(up.ok && /^\/uploads\//.test(upj.url), 'image upload accepted');
  const badUp = await fetch(URL + '/api/upload', { method: 'POST', headers: { 'x-admin-pin': PIN, 'content-type': 'image/png' }, body: Buffer.from('not an image at all') });
  check(badUp.status === 415, 'non-image file rejected');
  const noPin = await fetch(URL + '/api/upload', { method: 'POST', body: png });
  check(noPin.status === 401, 'upload without PIN rejected');
  cmd('image', { url: upj.url, fit: 'contain' }); await wait(400);
  check(phones.every((p) => p.scene.type === 'image' && p.scene.url === upj.url), 'image pushed to all 40 phones');
  const img = await fetch(URL + upj.url);
  check(img.ok && img.headers.get('content-type').includes('png'), 'phones can download the image');

  // ---------- COUNTDOWN ----------
  console.log('\nCOUNTDOWN');
  cmd('countdown', { seconds: 5, label: 'Curtain up in', endText: 'SHOWTIME' }); await wait(1800);
  const remaining = phones.map((p) => Math.ceil((p.scene.endAt - p.serverNow()) / 1000));
  check(new Set(remaining).size <= 2 && remaining.every((r) => r >= 3 && r <= 5), `all phones show the same second (${[...new Set(remaining)].join('/')})`);
  const ends = phones.map((p) => p.scene.endAt - p.serverNow());
  check(Math.max(...ends) - Math.min(...ends) < 60, `countdown end moments agree within ${(Math.max(...ends) - Math.min(...ends)).toFixed(0)} ms`);

  // ---------- VOTE ----------
  console.log('\nVOTE');
  cmd('voteStart', { question: 'Which ending?', options: [{ label: 'Happy', color: '#12d66b' }, { label: 'Twist', color: '#8a2bff' }, { label: 'Tragic', color: '#ff1f3d' }] });
  await wait(500);
  const vid = A.scene.id;
  phones.forEach((p, i) => p.s.emit('vote', { id: vid, choice: i < 22 ? 0 : i < 34 ? 1 : 2 }));
  await wait(400);
  phones[0].s.emit('vote', { id: vid, choice: 1 }); // changes mind
  phones[1].s.emit('vote', { id: vid, choice: 7 }); // invalid option ignored
  phones[1].s.emit('vote', { id: 999, choice: 1 }); // stale vote ignored
  await wait(500);
  check(A.live && A.live.kind === 'vote' && A.live.voters === 40, `40 votes counted, one per seat (got ${A.live && A.live.voters})`);
  check(JSON.stringify(A.live.counts) === '[21,13,6]', `tally after one changed vote: ${JSON.stringify(A.live.counts)}`);
  check(SC.live && SC.live.kind === 'vote' && SC.live.voters === 40, 'theatre screen receives the live tally');
  check(phones[0].me.vote === 1, 'a phone knows its own vote');
  cmd('voteClose'); await wait(300);
  phones[5].s.emit('vote', { id: vid, choice: 2 }); await wait(400);
  check(A.live.counts[2] === 6 && A.scene.state === 'closed', 'votes after closing are ignored');
  cmd('voteResults'); await wait(400);
  check(phones.every((p) => p.scene.showResults && JSON.stringify(p.scene.tally) === '[21,13,6]'), 'results shown on all phones');
  cmd('votePattern'); await wait(400);
  check(phones[0].last === '#8a2bff' && phones[39].last === '#ff1f3d' && phones[2].last === '#12d66b', 'phones light in the colour they voted for');

  // ---------- BUZZER ----------
  console.log('\nBUZZER');
  cmd('buzzerArm'); await wait(400);
  const bid = A.scene.id;
  phones[3].s.emit('buzz', { id: bid, at: phones[3].serverNow() }); // jumps the gun
  await wait(200);
  check(phones[3].me.falseStart === true, `${phones[3].label} tapped before GO → false start, locked out`);
  cmd('buzzerGo'); await wait(250);
  const goAt = A.scene.goAt;
  // Seat with SLOW Wi-Fi taps first (reaction 180 ms) but its message arrives 150 ms late.
  // A seat with fast Wi-Fi taps later (220 ms) and arrives first. Fair result: the slow-Wi-Fi seat wins.
  const fast = phones[10], slow = phones[25];
  const at = (ms) => goAt + ms;
  await wait(Math.max(0, goAt - Date.now()));
  setTimeout(() => fast.s.emit('buzz', { id: bid, at: at(220) }), 225);
  setTimeout(() => slow.s.emit('buzz', { id: bid, at: at(180) }), 180 + 150);
  setTimeout(() => phones[3].s.emit('buzz', { id: bid, at: at(100) }), 120); // locked-out seat tries again
  for (let i = 30; i < 36; i++) setTimeout(() => phones[i].s.emit('buzz', { id: bid, at: at(300 + i) }), 310 + i);
  await wait(1200);
  check(A.scene.state === 'done' && A.scene.winner.label === slow.label, `winner is ${A.scene.winner && A.scene.winner.label} (fastest reaction, despite slower Wi-Fi)`);
  check(A.scene.winner.ms === 180, `reaction time ${A.scene.winner.ms} ms recorded`);
  check(!A.scene.top.some((r) => r.label === phones[3].label), 'false-start seat excluded');
  check(slow.me.buzz && slow.me.buzz.place === 1 && fast.me.buzz.place === 2, 'each phone learns its own place');
  check(SC.scene.type === 'buzzer' && SC.scene.winner.label === slow.label, 'theatre screen shows the winner');

  // ---------- TAP ----------
  console.log('\nTAP');
  cmd('tapStart', { seconds: 5, teams: 'rows' }); await wait(400);
  const ts = A.scene;
  check(ts.startAt - Date.now() > 2500, 'phones get a 3-2-1 before tapping starts');
  await wait(ts.startAt - Date.now() + 50);
  const t0 = Date.now();
  const tapTimer = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    phones.forEach((p, i) => {
      const rate = i === 7 ? 9 : i < 8 ? 6 : 3 + (i % 3); // row A taps fastest; seat A08 best
      p.s.emit('taps', { id: ts.id, count: Math.floor(el * rate) });
    });
    phones[39].s.emit('taps', { id: ts.id, count: 5000 }); // cheater
  }, 150);
  await wait(ts.endAt - Date.now() + 200);
  clearInterval(tapTimer);
  await wait(1200);
  const honest = A.live.top.filter((r) => r.n !== 40);
  check(A.scene.state === 'done' && A.scene.winner && honest[0].label === 'A08', `fastest honest tapper is ${honest[0].label} with ${honest[0].count} taps`);
  const cheat = A.live.all[40];
  check(cheat <= 5 * 14 + 4, `impossible tap rate capped at the human limit (tampered phone counted ${cheat}, not 5000)`);
  check(A.scene.teamResults[0].name === 'Row A', `team result: ${A.scene.teamResults.map((t) => t.name + ' ' + t.avg).join(', ')}`);
  check(phones[7].me.taps === A.live.all[phones[7].n], 'each phone knows its own tap count');

  // ---------- SHAKE ----------
  console.log('\nSHAKE');
  cmd('shakeStart', { difficulty: 'easy', label: 'Light the lantern!' }); await wait(400);
  const sh = A.scene;
  let rounds = 0;
  while (A.scene.state !== 'done' && rounds < 120) {
    phones.forEach((p) => p.s.emit('shake', { id: sh.id, v: 0.8 }));
    phones[0].s.emit('shake', { id: sh.id, v: 1 }); // spamming faster than 5/s is ignored
    await wait(210); rounds++;
  }
  const secs = (rounds * 210 / 1000).toFixed(1);
  check(A.scene.state === 'done', `40 phones shaking hard filled the meter in ${secs} s (easy target ≈ 3.75 s)`);
  check(Number(secs) > 3 && Number(secs) < 6, 'meter fills at the expected rate (spam ignored)');
  check(phones[20].live && phones[20].live.kind === 'shake', 'phones receive the shared meter');
  check(SC.live.kind === 'shake' && SC.live.progress === 1, 'theatre screen meter reaches 100%');

  // ---------- WINNER ----------
  console.log('\nWINNER');
  phones[39].close(); phones[38].close(); await wait(400); // E07, E08 leave
  const seen = new Set();
  for (let r = 0; r < 4; r++) {
    cmd('winnerDraw', { prize: 'Backstage tour', excludePrevious: true, spinMs: 2000 });
    await wait(400);
    check(A.scene.state === 'spinning' && !A.scene.winner, `draw ${r + 1}: spinning, winner kept secret until reveal`);
    await wait(2500);
    const w = A.scene.winner;
    seen.add(w.label);
    check(w && w.n <= 38, `draw ${r + 1}: ${w.label} — a connected seat`);
  }
  check(seen.size === 4, 'skip previous winners: 4 different winners');
  const wp = phones.find((p) => p.label === [...seen][3]);
  check(wp.last === '#ffb800' && phones.filter((p) => p.n <= 38 && p !== wp).every((p) => p.last === '#000000'), 'winner phone goes gold, others dark');

  // ---------- GIFT DROP ----------
  console.log('\nGIFT DROP');
  cmd('giftDrop', { title: 'Opening night gifts', prizes: [{ name: 'Free popcorn', qty: 3 }, { name: 'Signed poster', qty: 2 }], consolation: 'Thanks for coming!' });
  await wait(500);
  const live38 = phones.slice(0, 38);
  const prizes = live38.filter((p) => p.me.gift && p.me.gift.isPrize);
  check(live38.every((p) => p.me.gift), 'every connected phone got a gift');
  check(prizes.length === 5 && prizes.filter((p) => p.me.gift.prize === 'Free popcorn').length === 3, '3 popcorn + 2 posters handed out, rest get a thank-you');
  const codes = prizes.map((p) => p.me.gift.code);
  check(new Set(codes).size === 5 && codes.every((c) => /^HK-[A-Z0-9]{4}$/.test(c)), `unique redemption codes (${codes.join(' ')})`);
  check(A.gifts && A.gifts.length === 38 && A.gifts.filter((x) => x.isPrize).length === 5, 'operator sees full assignment table');
  prizes[0].s.emit('giftOpen', { id: A.scene.id }); await wait(500);
  check(SC.live.kind === 'gift' && SC.live.prizesOpened.length === 1, 'theatre screen announces a prize once it is opened');
  // Reconnect keeps the same gift
  const keep = prizes[1]; const before = keep.me.gift.code; keep.close();
  await wait(300);
  const again = makePhone(keep.label); await again.join(keep.label);
  check(again.me.gift && again.me.gift.code === before, 'phone that reconnects gets the same gift back');
  again.close();

  // ---------- Results CSV ----------
  const csv = await (await fetch(URL + '/api/results.csv?pin=' + PIN)).text();
  check(/vote/.test(csv) && /buzzer/.test(csv) && /tap/.test(csv) && /winner/.test(csv) && /HK-/.test(csv), 'results CSV has votes, buzzer, tap, winners and gift codes');

  // ---------- Reset ----------
  cmd('resetShow'); await wait(500);
  check(live38.filter((p) => p !== keep).every((p) => p.reset), 'reset sends every phone back to the seat screen');
  check(A.seats.online === 0, 'seat map cleared');

  phones.forEach((p) => p.close()); adminS.close(); screenS.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// "A01" -> "a1" / "B 2" style, to test forgiving seat entry
function l2loose(l) { const r = l[0], n = Number(l.slice(1)); return Math.random() < 0.5 ? r.toLowerCase() + n : r + ' ' + n; }
