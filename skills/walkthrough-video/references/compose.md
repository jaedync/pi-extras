# Quick mode: compose a screen walkthrough

`wv compose` makes a plain screen walkthrough from a capture and a shot list: it plans the
camera, the cursor, the captions, the voice timing and the intro and outro cards, and `wv gates`
checks the result. Use it for a tutorial, a README clip or a feature video with a voiceover. It is
not a launch film: for that, use the film path in `SKILL.md`.

Write the flow first (`references/capture.md`).

## The work loop

1. **Read the app.** Find the flow's selectors in the source. With no source, open the page with
   a short Playwright script and list the elements you need. Take the brand colours (CSS variables
   such as `--bg`, `--text`, `--accent`) and the font family.
2. **Write `flow.mjs`** (see `references/capture.md`). Use seeded, fake data: no real names, emails, tokens,
   host names or IP addresses.
3. **Capture:** `APP_URL=http://localhost:3000 wv capture flow.mjs --out cap` (defaults: 1280 x
   720 CSS px, scale 2, 60 fps). Keep the size 16:9 (for example 1024 x 576); compose refuses
   another aspect ratio. The flow reads `process.env`; set what it needs on the command
   line. Open `cap/poster.png` (the first frame after the first page load settles) and read
   `cap/events.json`. Click, type and hover events have a `target` box; goto, wait and key events
   do not. `settleFrame - startFrame` stays under about 200 frames; the settle stops at 3 s, so a
   longer span means the action itself was slow. A capture writes into a staging folder and moves
   the files into `--out` only when it succeeds, so a failed round never deletes the last good one.
   The last lines of `wv capture` give the host load and two warnings: fewer than 5 % of the frames
   show a new image, or the flow did nothing for more than 10 s. The first is fine for a calm UI
   and a problem for a canvas or WebGL view; the `smoothness` gate tells the two apart. The second
   means a `wait` or a `waitFor` took very long: shorten it, or give the idle screen a shot.
4. **Write `shots.json`** (see "Shots") and, for a voiceover, `voice-script.json`:
   `[{ "id": "l1", "text": "One short sentence." }, ...]`.
5. **Voice (optional):** `wv voice voice-script.json --out voice` (default voice `am_michael`).
6. **Compose:** `wv compose cap --shots shots.json --out proj [--voice voice]`. Compose into the
   same folder each round; do not delete it, because the review sheets of earlier rounds live in it.
7. **Gates:** `wv gates proj --capture cap`. Fix every FAIL with its `Fix:` line, then run it
   again. A SKIP means the video has nothing for that gate to check (for example, no clicks).
   Change the flow, `shots.json` or the voice script; do not edit `plan.json` or `index.html`.
8. **Review:** `wv review proj` writes the beat sheet, the phone sheet and one seam sheet per shot
   cut, prints their paths, and takes seconds. Follow `references/review.md`. Then, when you can
   start a subagent, give a fresh one only the sheets and `shots.json`, and ask for P0 and P1
   lines in the same format.
9. **Preview, then render:** `wv preview proj` writes `proj/preview.mp4` at 640x360 and 30 fps in
   about a minute: watch the whole video and fix what the sheets hid. Then
   `wv render proj --out walkthrough.mp4` (60 fps, PNG frame extraction). `--gif` makes a 15 fps
   GIF for a README. Check the render itself (`references/review.md`, step 6).
10. **Deliver** the MP4 path, the gate result, and the review notes you kept. Publish it as an
    artifact only when the user asks for a link.

## Shots

```json
{
  "look": { "ground": "#faf5f2", "ink": "#3a2e28", "accent": "#bd5937", "font": "Karla" },
  "intro": { "title": "Pointer", "sub": "Scrum poker in twenty seconds" },
  "outro": { "title": "pointer.jaedyn.me", "sub": "Free. No sign-up." },
  "shots": [
    { "events": ["e2", "e3"], "caption": "Name yourself and the round", "voice": "l1" },
    { "events": ["e4"], "caption": "Create the room", "voice": "l2" }
  ]
}
```

- 3 to 7 shots. One shot is one idea: the events that make it, in order. Leave out events that
  are not part of any shot; the composer speeds up the time between shots.
- A caption shows for its whole shot. A caption that names a result ("No match") belongs to a
  shot that starts when the result is on screen: put the `mark` and the hold in a shot of their
  own, and caption the action before it ("Reveal the cards").
- Caption: 2 to 6 words. Start with a verb, or name the result. It stays on screen at least
  0.5 s + 0.3 s a word; the composer holds the picture when it needs more time. A caption ends
  with its own shot, never in the next one. Captions sit at the bottom, and move to the top when
  a control of their shot is under them. To fix the place yourself, write
  `"caption": {"text": "Create the room", "place": "top"}`; the composer then keeps it there.
- Voice line (`voice` names an id in the voice script): one or two short sentences, 19 words or
  fewer. Say why, not what the viewer already sees. The composer holds the picture for the line,
  plus 0.45 s.
- `look.cursor` is `"dark"` (the default, for a light page) or `"light"` (for a dark page): it is
  the fill of the drawn cursor, not the app's own cursor. `look.ground`, `look.ink` and
  `look.accent` must be `#hex` colours with 3, 6 or 8 digits: the page writes them straight into
  CSS, so any other value is a validation error, not a default. `look` comes from the app's own
  CSS, and `font` is a Google Fonts family of up to 60 letters, digits and spaces; the composer
  downloads it
  into the project. For a system font, pick the nearest Google family (Georgia: `Gelasio`;
  Helvetica, Arial or `system-ui`: `Inter`). Offline, it falls back to Inter and warns.
- `focus` on a shot (`auto`, `target`, `caret`, `changed`, `overview`) overrides the camera's
  choice for the shot's actions, marks included. Leave it out unless the review shows a wrong
  frame; compose prints a warning when the mode changes nothing (for example `"caret"` on an
  event that has no caret).
- `speed` on a shot (for example 2) plays a slow but needed step faster.
- `trim` on a shot keeps only part of its picture: `"trim": {"start": 0.5, "end": 2.5}` cuts the
  first and the last seconds of the shot (seconds into the shot, as it plays). Use it for a blank
  launch frame or a slow tail. A trim that cuts an event away prints a warning.
- `cut`: `true` on a shot starts it on a hard cut: the camera is in place on its first frame, with
  no 0.7 s move. Use it when the app jumps to a new screen and a camera move would show it half
  painted.
- `cursor` on a shot: `"hide"` keeps the drawn cursor off screen for that shot (a payoff shot
  with no pointer action, or a control the viewer must not think is about to be clicked).
- Length: intro 2.2 s, outro 2.4 s, and the shots. Do not add actions only to make the video
  longer: the length follows the story.

## What the composer decides (do not fight it)

- Zoom: at least 1.25 on a focused control, and enough to bring its text to 28 px at 1080; never
  past the capture's real pixels (1.33 at scale 2 and 1280 px) and never so far that the box
  leaves the title-safe area. The `text_readable` Fix line says which limit applied, and how wide
  a box still fits at the zoom the text needs. Compose and the gates share a 0.2 px margin, so a
  size that compose accepts never fails the gate on rounding.
- Camera moves: 0.7 s, `power3.inOut`, straight paths, no move when the next target is already
  framed. A click, a key or a scroll that fills the screen pulls back to the whole page, but not
  before the shot's caption and voice line end, and not when another focus window starts within
  1.5 s (the camera then moves straight from one to the next). A wait keeps the last focus. The
  gates read the same eased move the render makes, so their zoom numbers match the picture.
- The last shot keeps its focus until the outro card, so the payoff stays on screen to the end.
- Cursor: travels 0.45 s, lands 0.12 s before the action, presses with a ripple in the accent. It
  fades out 1.5 s after the last pointer event and fades back in before the next one, so it does
  not park on the payoff.
- Gaps: idle time up to 0.5 s plays at 1x; longer gaps are sped up to 0.4 s.
- Repeated frames: the same rule applies inside a shot. A busy host, a slow WebGL draw or a big
  `--scale` makes the pump write the same image for many frames; a run of them between two actions
  is compressed to 0.4 s, like a gap. Runs that touch an action, a mark or the planned part of a
  `wait` are left alone (a `wait(400)` keeps its 400 ms, and the seconds a busy host added to it
  are compressed), and compression never takes time that the caption, the voice line or 0.8 s of
  picture needs. The camera, the cursor, the captions and the voice read the compressed clock.
- The last result stays on screen for at least 2 s.

## Rendering

`wv render` writes a progress line every percent (the frame counter of HyperFrames) and one every
10 s, so a long render is not silent. Before it starts, it estimates the HyperFrames frame cache
(frames x output pixels x 4 bytes) and refuses when the temp filesystem cannot hold it:
`/tmp is full: 4.8 GB needed, 1.9 GB free`, with the cache path. Each render extracts into its
own folder there (`wv-<pid>-<time>`), and wv deletes only that folder, after a good render and after
a failure. `--keep-cache` keeps it for a look inside; no later render reads it, so delete it by hand.
The other entries belong to other programs. A render that fails with
`Unknown system error -122` is the same full disk (EDQUOT), and wv says so.

`wv preview` renders the same composition at 640x360 and 30 fps with quality draft and no page
motion blur, into `proj/preview.mp4`. Use it for the first look at the whole video, a gate fix
that you want to see move, or a quick check of the voice timing. It writes a temporary
`preview.html` beside `index.html` and removes it again, because HyperFrames refuses a project
with two root compositions. It is not the delivery file: its text is small, so read the captions
on the beat sheet and the render, not on the preview.

## Gates

`cursor_on_target`, `focus_in_safe`, `no_upscale`, `text_readable`, `blank_frame`,
`dead_stretch`, `camera_churn`, `voice_fits`, `caption_clear`, `smoothness`, `camera_scale`,
`hyperframes_check`. They measure the plan and the frames. `camera_scale` loads `index.html` in
Chromium, seeks the real timeline and reads the zoom of the camera at every key: it fails when the
project on disk does not show what `plan.json` says, so a bad camera fails in a second instead of
after a render. They do not measure what is outside a focus window: a shot that stays on
the whole page is checked only by the review (the phone sheet). `cursor_on_target` and `voice_fits`
check that the plan agrees with the capture; they do not look at the picture. `dead_stretch`
allows a still picture for up to 6 s under a voice line, and 3 s without one; do not add hovers or
moves to fill time. `camera_churn` fails when the camera makes more than two moves inside 2 s. `smoothness` counts the
new images a shot shows per second of its picture: a shot with motion needs 20 or more. A UI that
changes in steps, with pauses of half a second or more, is not motion and the gate skips it, and
so is a shot that shows one picture. A capture whose frame draw took 150 ms or more at p95 counts
as motion even when its still runs are long: the host or the page stalled it. Its Fix line names
the cause (the host load, the draw time, or the app's own animation) and the way out.

## Rules for the quick mode

- Do not edit `index.html` by hand for timing. Change the flow, `shots.json` or the voice script,
  and compose again. A one-off style change (a colour) is fine; say so.
- The gates and the review are the check. "It looks right" is not a check.
- Read `references/review.md` before step 8, and `references/troubleshooting.md` when a
  capture or a gate fails.
