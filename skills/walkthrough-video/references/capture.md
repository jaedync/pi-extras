# Capture: flows

`wv capture flow.mjs --out cap` records the real app frame by frame and logs every action on the
same clock. Use it for the shots of a film where "this is the real app" matters, and for the
quick mode (`references/compose.md`).

```
APP_URL=http://localhost:3000 wv capture flow.mjs --out cap [--width 1280 --height 720] [--scale 2] [--fps 60] [--clock virtual|real]
```

The capture writes `capture.mp4`, `events.json` and `poster.png`. It writes into a staging
folder and moves the files into `--out` only when it succeeds, so a failed round never deletes
the last good one. The flow reads `process.env`; set what it needs on the command line.

## The clock

The default clock is `virtual`. Before the page loads, the capture replaces `Date`,
`performance.now`, `setTimeout`, `setInterval` and `requestAnimationFrame` with a clock that moves
exactly one frame (1/fps s) for each captured frame. It also owns the CSS animations and the Web
Animations of the page: each one is paused and set to the frame time. So the captured clip shows
exactly one frame of app time per frame, on a fast or a loaded host, and a timer, a transition
and a canvas animation stay in step.

- `wv.wait(ms)` lets virtual time pass, frame by frame. A page timer of 2 s takes 2 s of clip.
- A document that loads during the capture (a navigation or a reload) starts its clock at the
  capture time of the frame before it loaded. A timer that its script sets at load fires at its
  real offset, and `Date.now()` does not go back.
- `type()` presses each key on its own frame, at `delayMs` of app time.
- An app that needs wall time (a WebSocket server that answers with real latency, a video
  element) still works: the frames wait for it, and the clip shows the answer when it comes.
- `--clock real` turns the virtual clock off. Use it only to compare, or when an app breaks under
  the virtual clock; say so in the delivery.
- The clock runs in the top document only. A child document (an embedded map, player, payment
  form or same-origin app frame) keeps real time: its timers and animation frames fire on the
  host's clock, so they can move at a different rate from the captured frames, or not at all when
  the host is busy. If an embedded widget matters in a shot, capture with `--clock real`, or
  show it as a still image.
- Three clocks stay on real time in the top document too: `event.timeStamp`,
  `document.timeline.currentTime` and `requestIdleCallback`. An app that measures a drag, a double
  click or an animation's start from `event.timeStamp` against `performance.now()` sees the real
  gap between the frames, not 1/fps s. Such an app can read a double click as too slow, or a
  flick as very fast; use `--clock real` for it, or check the result on the capture.

## For a film

- Capture at the film's frame rate (`--fps 60` for a 60 fps film) and at the size the shot shows
  the app. A 1920x1080 film that shows the app full frame needs `--width 1280 --height 720
  --scale 2` (the scale is an integer from 1 to 4).
- Copy `events.json` beside the clip as `<clip name>.events.json`. It holds the app's text
  boxes after each settle (`texts`), and `wv check --page` fails app text that the film draws
  under 30 px. A 16 px app label needs about 2x on screen: frame tighter or push in. A HUD
  label at the frame edge leaves the frame when you push in; raise its size in the flow instead,
  and capture again:
  `await wv.page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: "#mach { font-size: 16px !important }" }))));`
- A value that changes on its own (a speed readout, a counter, a timer) has a sample only after
  each settled step. Add `--text-every 250` to sample the text every 250 ms of app time, and
  give the shot `follow: "<selector>"`: `wv film build` then tells you where the value stops.
- A slow page (WebGL or a canvas in software raster) costs seconds a frame: film2's flights took
  1.5 to 4.5 s a frame, and 6 to 15 min a clip. Make a `--draft` capture first: wall clock,
  scale 1, 10 fps, about a minute, and `sheet.jpg` shows the whole take (a crash into a wall, a
  tile that never loads) before you spend the frame-exact capture on it. During a capture, a
  progress line every 10 s gives the frame, the app time and the cost of a frame. A wait gets
  four times the measured cost of its frames in wall time (at least 120 s), and capture warns
  when a wait still ends short. Capture at 30 fps for a 30 fps film, keep clips short, and run
  each capture in its own memory limit (`systemd-run --user --scope -p MemoryMax=6G`).
- Capture short: the one action that is the proof, with a second of calm before and after. The
  film trims the clip with `clip.from` and the shot length.
- For a match cut from a recreation into the clip, measure the element in the first frame of the
  clip (its box in `events.json`, or by colour in `poster.png`) and end the recreated shot with
  the element at that size and place.
- Check the first frames of the clip at the cut: `wv check` blocks a repeated picture at a cut.

## Flows

```js
// flow.mjs
export default async function (wv) {
  await wv.goto(process.env.APP_URL, { name: "open" });
  await wv.type("#player-name", "Alice", { name: "name" });
  await wv.click("#create", { name: "create" });
  const roomUrl = wv.page.url();               // a URL the app made
  const guest = await wv.secondary();          // a second user: a Playwright Page, not recorded
  await guest.goto(roomUrl);
  await guest.fill("#player-name", "Bob");
  await guest.click("#join");
  await wv.waitFor(() => document.querySelectorAll(".player").length === 2, { name: "joined" });
  await wv.mark("result", { selector: "#result-cards" }); // the payoff: the camera frames it
  await wv.wait(1500, { name: "hold" });                  // the camera stays on the payoff
}
```

| Call | What it does |
|---|---|
| `goto(url, { name })` | Navigate; the camera shows the whole page |
| `click(selector, { name, label })` | Scroll into view, move the real mouse there, click |
| `type(selector, text, { name, delayMs })` | Click, then press real keys (70 ms apart) |
| `hover(selector, { name })` | Move the real mouse onto the element |
| `key(key, { name, holdMs })` | Press a key (`"Enter"`, `"Digit3"`, `"ArrowUp"`); the mouse stays still |
| `scroll(selector \| { y }, { name })` | Scroll an element into view, or the page by `y` px |
| `wait(ms, { name })` | Let the app run; the camera stays where it is |
| `waitFor(fn \| selector, { name, timeoutMs, state })` | Wait for a page condition or an element |
| `mark(name, { selector })` | Record where the text of `selector` is now; the camera frames it. On an input or textarea it records the value text, not the whole field. With no selector, a point in time only |
| `say(text)` | Write a cue line to `events.json` at the current frame. It does not make a voice line: those come from the voice script |
| `mark(name, { selector, caption })` | `caption` is a short note for you and the review, not a video caption: video captions come from `shots.json` |
| `secondary()` | A second browser page for another user; not recorded |
| `page` | The recorded Playwright Page, for anything else (`addStyleTag`, `route`, `url()`) |

- Each action returns its event; ids are `e1`, `e2`, ... in call order. Read them from
  `events.json` when you write the shots. An event has `kind` (`goto`, `click`, `type`, `hover`,
  `scroll`, `wait`, `mark`, `key`), `name`, `startFrame`, `endFrame`, `settleFrame`, `target`,
  `caret`, `changed`, `fontPx`, `text`, `label` and `caption`. `target`, `caret` and `changed` are
  CSS px boxes or null; `fontPx` is the computed font size of the element the action touched.
- `waitFor(fn)` runs `fn` in the page. Read app state by its global name (`state.room`), not as
  `window.state`: a top-level `let` or `const` is not a property of `window`.
- The real mouse moves before each click and hover, so hover states are real. The capture draws no
  cursor; the composer draws it.
- **Pointer-lock and mouse-steered apps** (games, 3D viewers, flight sims): after the app takes the
  mouse, every mouse move steers it. Stub the lock before the page loads, then use `key` for input:

  ```js
  await wv.page.addInitScript(() => {
    Element.prototype.requestPointerLock = function () {
      Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => this });
      document.dispatchEvent(new Event("pointerlockchange"));
      return Promise.resolve();
    };
    document.exitPointerLock = () => {};
  });
  await wv.goto(process.env.APP_URL, { name: "open" });
  ```

  Do not `hover` or `click` on the canvas after the app takes the mouse.
- **A link that opens a new tab** (`target="_blank"`): the new tab is not recorded. Remove the
  attribute in the flow, then click: `await wv.page.evaluate(() => document.querySelectorAll("a[target]").forEach((a) => a.removeAttribute("target")))`.
- **A Secure cookie over http**: Playwright refuses `secure: true` with an `http:` url. Pass an
  https url to `addCookies`: `await wv.page.context().addCookies([{ name, value, url: "https://inbox.localhost:8181", secure: true }])`.
- **A long paragraph that must read**: a `mark` frames the text's line boxes, and a wrapping
  paragraph fills its whole column. Wrap the sentence you need in a span in the flow
  (`await wv.page.evaluate(() => { ... })`, or a class from `addStyleTag`) and mark the span.
- Mark the payoff (the result the video exists to show) with `mark` and the selector of the text
  or element the viewer must read, and hold it with a `wait` after the mark. A mark on a short line
  inside a wide block frames only the line. A mark on an input or a textarea frames the text of its
  value, not the empty rest of the field.
- Hide what is not the story before the first action: cookie banners, dev overlays, toasts,
  pulsing badges. Use `wv.page.addStyleTag({ content: "... { display: none !important }" })`.
- Passwords: `type` into a password field keeps only the length in `events.json`. Pass
  `{ secret: true }` for any other secret field.
- Private data: hide or replace host names, IP addresses, ports, localhost URLs, emails and real
  names. For a page you do not control, rewrite its response with
  `wv.page.route(url, async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: ... }) })`.
- One flow is one story of 15 to 45 seconds of app time. Long setup belongs in the flow before
  the first shot; the composer speeds up the time between shots.

