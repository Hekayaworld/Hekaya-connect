# Hekaya Connect v1

Live audience phones for Hekaya's 40-seat theatre. No app, no login.

```
40 phones → QR code → web page → control laptop → theatre screen
```

Three pages, all served by one small program on the control laptop:

| Page | Who uses it | Address |
|---|---|---|
| Audience | Guests' phones | `http://<laptop-ip>:3000/` |
| Control | Operator (PIN) | `http://<laptop-ip>:3000/admin` |
| Theatre screen | Main LED screen | `http://<laptop-ip>:3000/screen` |
| Seat QR sheet | Print once | `http://<laptop-ip>:3000/qr-sheet` |

## Set up

1. Install **Node.js LTS** from nodejs.org on the control laptop.
2. In this folder, once: `npm install`
3. Start: `npm start`. The terminal prints all four links using the laptop's Wi-Fi address.
4. Laptop, LED-screen computer and audience phones on the **same Wi-Fi** (not a guest network).
5. Open the theatre screen page on the computer feeding the LED wall and click once for full screen.

Default PIN is **1234**. To change it — Mac: `ADMIN_PIN=4821 npm start` · Windows, two lines: `set ADMIN_PIN=4821` then `npm start`.

Tip: give the laptop a fixed IP on the router so printed QR codes keep working every show.

## Seats

Seats are labelled **A01–E08** (rows A–E, 8 seats each, row A nearest the stage). Change `seating.json` to match the room — for example a row of 6 or a row F — then restart. Waves, "by row" patterns and team games follow this layout.

Guests pick their row and seat number with big buttons, or scan the QR on their seat card (seat pre-filled). Two phones can't claim the same seat, and a phone that drops off Wi-Fi or refreshes rejoins its seat automatically.

## The 14 controls

**Lights tab**
- 🔵 **Color** — every phone one colour. Keys B R G Y P K W X.
- 🌊 **Wave** — colour travels A01 → E08, row by row, from the centre, back and forth… Flash or Fill, speed, repeat or loop. Key V starts, S stops.
- ✨ **Sparkle** — random phones twinkle in the colours you pick; set how many and how fast.
- 🎨 **Pattern** — different seats get different colours: alternate, by row, left/right, checkerboard, random, rainbow.

**Messages tab**
- 📩 **Message** — text to every phone (Arabic and English).
- 🤫 **Secret** — click a seat on the audience map and send a private message only that seat sees. You see 🤫 when sent and ✓ when they tap "Got it". A guest who isn't connected yet gets it when they join.
- 🖼️ **Image** — upload a PNG/JPG/GIF/WebP and push it to every phone and the theatre screen.
- ⏱️ **Countdown** — every phone and the screen count down together, flash at zero, then show your end text.

**Games tab**
- 🗳️ **Vote** — 2–4 coloured options; one vote per seat (guests can change their mind while it's open). Live bars on the theatre screen (or hidden until you close). Then: show results on phones, or **light phones by vote** so the room shows the result in colour.
- 🔴 **Buzzer** — Arm (phones show a grey "wait" button), then GO (or Space). First tap wins. Tapping early knocks a seat out. Reaction time is measured on each phone's synced clock, so a seat on slower Wi-Fi isn't robbed.
- 👆 **Tap** — 3-2-1 on every phone, then tap as fast as possible for 5–30 s. Everyone for themselves, row vs row, or left vs right (teams ranked by average taps per person). Impossible tap rates are capped.
- 📱 **Shake** — the whole audience fills a meter on the theatre screen. See the note below.

**Prizes tab**
- 🎁 **Winner** — drum roll on every phone and a slot-machine reveal on the screen, then one random connected seat wins. Can skip seats that already won tonight.
- 🎁 **Gift drop** — list prizes and quantities (e.g. 3 × popcorn, 2 × poster). Each connected phone gets a gift box to open; prize winners get a code like **HK-7Q2M** to show at the counter, everyone else gets your thank-you message.

**Setup tab** — join QR, theatre screen link, seat QR sheet, **Download results (CSV)** (votes, buzzer and tap winners, prize winners with codes, secrets sent), Clear lost seats, Reset show.

The **Live** panel under the seat map shows results and next-step buttons for whatever is running. **Waiting screen (Esc)** and **Blackout (X)** are always in the header.

## Shake: motion sensors need HTTPS

Phone browsers only allow the motion sensor on secure (https) pages. On the plain local Wi-Fi setup, phones automatically switch to **"TAP FAST!"** for the shake game, which still fills the meter. For real shaking, serve the app over https — for example through a Cloudflare Tunnel or a local certificate. HTTPS also lets phones keep their screens awake. Ask us when you're ready and we'll set it up for your venue.

## Test without 40 phones

With the server running, in a second terminal: `npm test`
It runs a full simulated show (70 checks): 40 phones with wrong clocks and jittery Wi-Fi go through every control, including timing accuracy, fairness of the buzzer, tap-rate caps, secret targeting, gift codes and reconnects.

## Known limits

- iPhones don't let web pages go truly full-screen; colours fill the page under the browser bar.
- Without HTTPS, ask guests to switch off auto-lock (see above).
- Show state lives in the laptop's memory: restarting clears seats, winners and gifts. Download results before resetting or closing.
- The theatre screen page needs no PIN — keep the laptop on the venue's private Wi-Fi.
