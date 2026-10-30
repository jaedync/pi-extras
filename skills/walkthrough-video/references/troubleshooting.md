# Troubleshooting

## Capture

| Symptom | Cause | Fix |
|---|---|---|
| `wv capture` fails at a step with a timeout | The selector is wrong, or the element is hidden or covered | Check the selector in the app source; add a `waitFor` before the step. The last good capture in `--out` stays untouched, so you can fix the flow and capture into the same folder |
| `waitFor` times out on `window.something` | A top-level `let` or `const` is not on `window` | Use the global name itself: `() => state.ready` |
| One event spans many seconds from `startFrame` to `settleFrame` | The action was slow (a page load, a server call), or something keeps changing for the full 3 s settle | Wait for the content with `waitFor`; hide a pulsing or ticking element with `addStyleTag`; or give the shot `"speed": 2` |
| Every `settleFrame` is about 180 frames after its end | Something on the page keeps changing (a timer, a spinner, a live chart) | Normal for live apps. Hide the moving element if it is not the story |
| `stats.unique` is far below `frames / 2` | Each frame takes long to raster (large viewport, scale 3, no GPU) | Fine for UI. For smooth app animations, use `--gpu on`, or a smaller 16:9 size such as `--width 1024 --height 576` |
| `wv capture` warns "only N % of the frames show a new image" | Either the page changed the screen only a few times (a calm UI: fine), or the host could not keep up: read `stats.load`, `stats.frameMs` and `stats.canvas` in `events.json` | If the `smoothness` gate passes, nothing is wrong. If it fails, follow its Fix line: close other work, use `--gpu on` for a canvas view, or capture at `--width 1024 --height 576 --scale 2` |
| `wv capture` warns "the flow did nothing for N s" | A `wait` or a `waitFor` waited for a slow page or a long timer | Shorten the wait, wait for the content with `waitFor`, or give the idle screen a shot with a caption and a `wv.say` line |
| `capture: GPU off` | The GPU probe failed; software raster is used | Slower, same pixels. Run once with `--gpu on` to see the error |
| `wv capture` prints "warning: a wait of N frames ended after M frames" | The host drew the frames slower than the wait's wall-time budget (four times the measured cost a frame) | Wait in shorter steps, close other work, or capture at a smaller size; check the take with `--draft` first |
| A WebGL or canvas app shows black frames | The page needs the GPU | `--gpu on`; if it stays black, say so in the delivery note |
| A 3D view turns or flies off on its own | The app steers by mouse movement (pointer lock) | Stub `requestPointerLock` with `addInitScript` before the first `goto` (see the skill text), then use `key` for all input |
| A click opens a new tab, and the video stays on the old page | The link has `target="_blank"` and the new tab is not recorded | Remove the attribute in the flow before the click (see the skill text) |
| `addCookies` refuses a Secure cookie | Playwright refuses `secure: true` with an `http:` url | Pass an `https:` url for that cookie (see the skill text) |
| `poster.png` shows a loading state | The first page load settled before the app drew | Add a `waitFor` for the app's content after the first `goto` |

## Gates

| Gate that fails | Fix |
|---|---|
| `text_readable` | Do what its Fix line says. "This capture allows 1.33 at scale 2": the capture has too few pixels. Capture again with `--scale 3`, but scale 3 makes the capture longer and can drop frames, so try `--width 1024 --height 576 --scale 3` first and keep the shot short. "At that zoom only 414 px of box width fits": the box is too wide to zoom; `mark` the text itself, or a span around one sentence. A smaller `--width` also needs a larger `--scale`, and the app layout can change at a new width. A gap under 0.2 px counts as rounding, not a defect |
| `focus_in_safe` | Focus a smaller element (`mark` with a selector), or set `"focus": "overview"` on the shot |
| `camera_churn` | The camera goes in, out and in again between two close targets. Put both actions in one shot, merge them into one mark, or drop one. A shot with one focus throughout needs no move |
| `voice_fits` | Shorten the line, or split the shot |
| `dead_stretch` | Set `"speed"` on the shot, or split it so a caption changes. A still frame under a voice line does not count as dead. When the stretch is one long settle, fix the capture (see above) |
| `blank_frame` | Add a `waitFor` for the content after a navigation. If the blank frame is inside a shot, `"trim": {"start": s}` or `"trim": {"end": s}` on that shot keeps it out of the edit; `"cut": true` cuts to the next shot instead of holding. Its Fix line gives the trim number |
| A splash or launch screen shows between two pages | The app paints its own launch screen while the next page loads | Call `await wv.page.emulateMedia({ reducedMotion: "reduce" })` before that `goto`: the app then takes its no-animation path. If the screen is still there, give the next shot `"cut": true`, or trim it |
| `caption_clear` | Fix the place in `shots.json` (`"caption": {"text": "...", "place": "top"}`), shorten the caption, or split the shot. The composer moves a caption to the top by itself only when the place is not fixed. A change far from the control (a sticky bar) is not counted |
| `smoothness` | The capture kept too few new images for a shot with motion (or the frame draw p95 is 150 ms or more, so the capture could not keep up even when it looks calm): the render shows a slideshow. The Fix line names the cause. Host load: close other work and capture again. Draw time or a canvas view: `--gpu on`, and a smaller 16:9 `--width` with `--scale 2`. The app's own animation: let it take more time (a shot `speed` below 1) and keep it short. Compression of repeated frames (compose) raises this number, but it cannot create frames the capture never had |
| `camera_scale` | `index.html` does not apply the zoom in `plan.json`: run `wv compose` again and keep your hands off `plan.json` and `index.html`. The gate seeks the real timeline, so this is the frame the render would show |
| `hyperframes_check` with a font error | Run compose online once, or use a family that HyperFrames bundles (Inter, Roboto, Lato, ...) |
| `wv gates` stops with "index.html was built from another plan" | `plan.json` and `index.html` come from two different compose runs, or someone edited `plan.json` | Run `wv compose` again into the same folder, then gate and render again. Do not edit `plan.json` |

## Render

| Symptom | Cause | Fix |
|---|---|---|
| `wv render` or `wv film render` stops with "/tmp is full: N GB needed, M GB free" | HyperFrames extracts the frames of each source video (the capture, or a film's clips) to `<tmpdir>/hyperframes-extract-cache-<uid>`, and that filesystem is too small. `/tmp` is often a small RAM disk | Run the command again with `TMPDIR=<a folder on a disk with space>` (create it first), or set `HYPERFRAMES_EXTRACT_CACHE_DIR`. wv gives each render its own `wv-<pid>-<time>` folder there and deletes that folder after the render, so the other entries stay. A film without clips needs no cache |
| `hyperframes render failed: Unknown system error -122` | The same full disk. Errno -122 is EDQUOT, which reads like a code bug | Run again with `TMPDIR=<a folder on a disk with space>`. wv checks the space before it starts and names the cause after a failure |
| `GSAP is not installed at ...` or `... is missing: the project has no local GSAP` | wv loads no GSAP from a CDN, so the runtime or the project must hold it. Compose copies it, and the preview and the gates read it | Run `wv setup` (it installs GSAP), then `wv compose` again. A project from before the copy has no `assets/gsap.min.js`: compose it again |
| A render takes minutes and looks silent | 60 fps at 1080p with PNG extraction is heavy; a 30 s video takes 1 to 3 minutes | wv prints a progress line at every 10 % of the frames. For a quick look use `wv preview` |
| `wv check` fails with `staircase`: a slow drift lands in steps every N frames | The render ran with N capture workers. HyperFrames hands frames to its workers in turn, and each Chrome rasterizes a slowly scaling layer at its own scale | Render with `wv film render` and no `--workers` (it uses one worker). A lower CRF does not help: the steps are in the captured frames |
| A Ctrl-C or a closed terminal ends a render | wv stops its children first, then removes `preview.html`, the capture staging folder and this render's cache folder. It exits 130 for Ctrl-C, 129 for SIGHUP (a closed terminal) and 143 for a stop request | Expected. Nothing is left to clean by hand; run the command again. A kill with SIGKILL to the process group stops wv and its children at once, so a `preview.html` or a cache folder can stay: delete it by hand |
| A process that a render started is still running after wv stopped | wv stops the tree it can prove it started: it saves the identity (pid and start time) of each child, then takes one snapshot of the process table just before the first signal. A process that left wv's tree before that snapshot is not in it, so wv does not stop it. This can happen to a daemon that its parent orphaned earlier. wv keeps every child in its own process group, so a group kill from the caller still reaches such a process. Stop the pid by hand if it uses CPU or holds a file | Expected limit, see `references/capture.md` for flows that start long-lived processes. |
| A render or capture is killed when RAM runs out | On Linux, wv sets its OOM score to 500 at start, and Chromium, ffmpeg and the score's Python inherit it. The kernel then stops the render before the user's other processes | Expected. Give the job more RAM, or run one heavy job at a time. `WV_OOM_SCORE_ADJ` sets the score (0 to 1000), and `off` keeps the inherited score |
| The preview has small text | The preview is 640x360: captions and UI text are a third of the delivery size | Expected. Judge captions and text size on the beat sheet, the phone sheet and the render, not on the preview |

## Review findings

| Finding | Fix |
|---|---|
| `compose` warns that a shot's `"focus"` changes nothing | The mode does not fit the shot's events (a click has no caret, an overview shot has no control) | Pick another mode, or remove `"focus"` from the shot |
| The camera lands on a control, but the result appears elsewhere | Add `mark("result", { selector })` after the action, then a `wait`, and put both in the shot |
| The payoff is a short line in a corner of a large page | `mark` the line itself (the mark frames its text), then `wait` 1.5 s |
| The drawn cursor rests on the payoff or on a control the viewer expects to see clicked | Set `"cursor": "hide"` on that shot; elsewhere the cursor fades out 1.5 s after its last event by itself |
| A shot stays on the whole page and its text is too small on the phone sheet | `mark` the part the viewer must read, or capture with a smaller `--width` and `--scale 3` |
| A host name, IP address, port or localhost URL is on screen | Hide it with `addStyleTag`, or rewrite the response with `wv.page.route` |
| The browser's own UI shows (a JSON viewer bar, a PDF toolbar) | Show the data in a page of the app, or hide the bar with `addStyleTag` |
