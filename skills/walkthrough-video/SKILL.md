---
name: walkthrough-video
description: Direct a short launch film or product walkthrough video of a web app, the way Apple, Linear or Figma make theirs. You write the film as code (a typed storyboard and scene modules on the product's own look), with instruments for frame-exact capture of the real app, brand lift, a sound mix, defect checks and measures against 12 reference films, and a critique by a fresh reviewer. A quick mode composes a plain screen walkthrough with captions and a voiceover. Use when the user asks for a launch film, product film, demo, walkthrough, screencast, feature video, README GIF or tutorial clip of a web app or site.
---

# Launch films of web apps

You are the director. The film is yours: its idea, its rhythm, its words and its shots. The tool
does the mechanical work (capture, brand, sound, render) and finds the defects. It does not make
film decisions for you.

All commands: `node <skill-dir>/scripts/wv.mjs <command>` (below: `wv`). Every command takes
`--help`. Run `wv setup` once per host (`wv setup --check` tells you if it already ran). It
installs pinned playwright-core, HyperFrames (with esbuild), GSAP, the browsers, a Python venv
and the voice into
`~/.cache/pi-walkthrough-video`. It is the only step that downloads the tool's own files.

`wv setup --music` is the one optional download: it builds the sampled instruments for a
composed score (sfizz, VCSL and the Salamander piano, about 1 GB, 10 minutes) into the same
cache. Without it a score uses the synth voices only, and `wv sound score` says so.

Three other steps use the network: `wv lift` and `wv capture` read the app you name, and
`wv compose` downloads the look's font from Google Fonts when the family is not one of the
families that HyperFrames bundles (the files then live in the project, so the render is local).
Renders, previews, gates, checks and measures run locally, with no account and no cloud service.
wv never loads a script or a package from the network at render time: a missing GSAP or
HyperFrames is a refusal that says `run wv setup`.

## Start with taste

Run `wv taste` and read all of it before you plan. It says what a good launch film is and why:
rhythm, cuts, camera, type, the product's own look, sound, and the owner's notes on earlier
films. The owner's notes win over everything else in this skill. When the owner gives a new note
about a film, add it in the owner's words: `wv taste --add "..." --film <name>`.

Then read `references/films.md`: the 12 reference films, the device each one uses, and their
measured numbers. Pick a device for this product before you write a shot. Do not copy a film;
take its reason.

## The instruments

| Command | What it does |
|---|---|
| `wv lift <url> --out lift [--flow states.mjs]` | Reads the product's look from the live page: ground, ink, surfaces, accent, fonts (downloaded), its springs, eases and keyframes, and its stylesheet without transitions (`app.css`). With `--flow`, each `lift.state(name)` adds that state's colours, a screenshot and its markup (`markup-<state>.html`), so a scene can rebuild the real UI with the real class names. |
| `wv capture flow.mjs --out cap` | Records the real app frame by frame: `capture.mp4`, `events.json`, `poster.png`. A virtual clock moves timers, animation frames and CSS animations exactly one frame per captured frame, so a slow host drops nothing. See `references/capture.md`. |
| `wv film new <dir> --lift lift` | A film project: `storyboard.ts`, `film.ts`, `scenes/*.ts`, `kit/`, `film.css`, `brand/` (from the lift), `assets/`. |
| `wv film build <dir>` | Type-checks the project, bundles it, writes `out/index.html` (the HyperFrames page), `out/film.json` and `out/cues.json`. A wrong field fails here in a second, not after a render. |
| `wv film stills <dir>` | One sheet at phone size: the frame before each cut, the cut frame, each shot's middle. `--at 1.2,3.4` for other times. |
| `wv film preview <dir>` / `wv film render <dir>` | A 30 fps draft at full size (about 4 times faster than the master: 17 s against 69 s for a 30 s film), then the master at the storyboard's fps with one capture worker. |
| `wv sound score score.py --cues out/cues.json --out score` | Renders a score written in code (`templates/score/score.py`), then checks that every planned hit is within 10 ms of its picture time and that no note clashes with its chord. See `references/score.md`. |
| `wv sound mix out/cues.json --sfx <dir> --bed <music.wav> --out master.wav` | Places each cue on its frame at its peak, rotates the files of a family, back-times a library bed so its biggest lift lands on `music.liftAtShot` (a score from `wv sound score` starts at 0 s: it is already timed to the film, so it needs no `liftAtShot`), puts it under the cues, masters to -16 LUFS under -1.5 dBTP (room for the AAC encode). A sparse track of cues with no bed stops lower, with its peaks at the ceiling: the limiter takes at most 3 dB, and the output says `peak-bound`. `wv sound tempo` and `wv sound backtime` measure a bed. |
| `wv film mux <dir> --audio master.wav` | Puts the master on the picture: `out/film-sound.mp4`. It probes both and refuses a master that is shorter than the picture, because the mux would cut the end of the film: run `wv sound mix` again. |
| `wv film critique <dir>` | The packet for a fresh reviewer, from the rendered film: `cold/` (`timeline.jpg`, `cuts.jpg`, `film.mp4`) for a cold read before the storyboard, `frames/` (the first, middle and last frame of every shot at full size), `sound.png`, `loudness.png`, `cues.txt`, `shots.md`, `check.txt`, `measure.txt`, `anchor/`, `films.md` and `brief.md` (the reviewer's brief with the taste text of today). Each round gets its own `out/critique-N/`. The anchor is a film the owner scored: put it in a folder with `anchors.json` (`[{"file": "film.mp4", "score": 7, "name": "..."}]`) and set `WV_ANCHORS` to the folder, or use `~/.config/pi-walkthrough-video/anchors/`. |
| `wv film critique --plan <dir>` | The plan packet before the first render, from `out/film.json` and the clips: `plan.md`, `clips/<shot>.jpg` and `.txt` (each clip's part at even steps, its text samples and inputs), `advice.txt`, `films.md` and `brief.md`. In `out/plan-N/`. |
| `wv check <film.mp4> --storyboard <dir> --page <dir>/out/index.html` | Blocks a delivery for defects only (list below). Exit code 1 when it finds one. |
| `wv measure <film.mp4> --storyboard <dir>` | The film's numbers beside the reference range: cuts a minute, shot length and its spread (CV), time in a camera move, zoom, ease, frozen picture, longest hold, loudness. Advice only: each number outside the range asks "Is that a choice?". |

## The film project

```
storyboard.ts   the one source of timing: shots, lengths, parameters, holds, music
film.ts         maps scene names to scene modules
scenes/*.ts     one module per kind of shot; the template has claim, product, footage, end
kit/            types, the timeline mount, eases, small motion helpers; change it if you need to
brand/          tokens.json, brand.css (--wv-* variables, @font-face), app.css, fonts/
assets/         captured clips, images, sound files
```

- **The storyboard is data with a type.** Each shot has an `id`, a `scene`, one length (`beats`
  with the storyboard's `bpm`, `seconds` or `frames`) and a `what` line that says the shot's
  intent for the reviewer. Every other field is a parameter for its scene: text, event times in
  seconds from the shot start, sizes. `holds: [[from, to]]` declares a planned still (`[from, "end"]` holds to the shot's end, so a
  re-time keeps it), and
  `still: true` a still shot, so `wv check` lets them through. `clip: { src, from }` puts captured
  footage under the shot. `music.liftAtShot` names the shot where the bed's lift lands.
- **Say the intent in the storyboard.** `family: "montage" | "one-take" | { middle: "<why>" }`
  names the rhythm family. `proof: { shot, action }` names the shot that shows the viewer doing
  the product's key action: the input and its effect. `wv film build` prints `advice` lines (not
  defects) when one is missing, when the planned pace sits between the families with no reason,
  or when the proof shot's clip has no input while the shot is on screen. A clip shot with
  `follow: "<selector>"` names a value in the clip (a HUD readout) that should keep moving: the
  build advises when it stays within 1 % for over 1 s on screen. Capture with
  `--text-every 250` so the value has a sample every 250 ms. `subject: "<selector>"` or
  `subject: { box: [x, y, w, h] }` (clip pixels; `boxes: [{ t, box }]` per time) names what the
  shot is about: the build and `wv check --page` advise when it is under 5 % of the frame width
  at its largest (a speck on a phone).
- **A scene is a function of its shot.** `scene((ctx) => { ... })` gets the film timeline
  (`ctx.tl`, film seconds), the shot and its timing (`t0`, `t1`, `d`, `at(s)`), the shot's layer
  (`root`, `cam`), the clip (`video`), the brand tokens and eases (`ctx.ease.spring` is the
  product's own spring), `html()`, `$()`, `$$()`, and `cue(sound, s, { peak })` for a sound on a
  picture event. Place every tween with `ctx.at()` or `ctx.t0`; nothing runs on its own clock.
- **The kit is a start, not a frame.** `kit/motion.ts` has `place`, `splitWords`, `riseWords`, `pop`,
  `drift`, `move`, `typeOn` and `LEAD` (entrances start 0.1 s before the cut, so the cut lands on
  action). Your own tween at a negative shot time goes through `place(ctx, seconds, (tl, at) =>
  ...)`: on the first shot it plays from part way in, so the film does not move 0.1 s later.
  Write new scenes and helpers for this film's idea. The template's four scenes are
  examples; most films replace them.
- **Rebuild the UI, do not screenshot it.** Set `appCss: true` in the storyboard, paste the
  markup from `markup-<state>.html` into a scene and keep the app's class names: `app.css` styles
  it. Its global rules (`body`, `*`) reach the film page too, so check the stills. Build it large (2.5x to 3x) for a
  phone. Use captured footage for one or two moments where "this is the real app" matters.
- **Colours and fonts come from `brand/`.** Use the `--wv-*` variables and the app's own
  variables. Any other colour, unless it is a neutral grey, fails `wv check --page`.

## The loop

1. Read the product: the app, its source if you have it, its page copy. Write the one idea of the
   film in one sentence.
2. `wv lift` (with a states flow for the views you want to rebuild), then `wv film new`.
3. Write the storyboard, with its `family` and its `proof`. Then write the scenes, one at a
   time, with `wv film build` and `wv film stills` after each one. Look at every still.
4. Capture the real app where the film needs proof (`references/capture.md`). Put the clip in
   `assets/` with its `events.json` beside it (`assets/create.mp4`, `assets/create.events.json`),
   and give its shot a `clip`. `wv check` then holds the clip's text to 30 px at the size the
   film draws it. On a slow page (WebGL without a GPU), make a `--draft` capture first.
5. **Plan review, before the first render.** Run `wv film build` and answer its `advice` lines.
   Then run `wv film critique --plan <dir>`. It needs no render: from the storyboard and the
   clips it writes `out/plan-N/` (the plan with the pace and the proof, a contact sheet of the
   part of each clip that its shot shows, with the text samples and the inputs, the advice and
   `films.md`) and a `brief.md`. The brief asks for the story, the proof of control, the subject
   size, the motion in the shots, the pace family and the place of the strongest moment. Start
   a fresh reviewer as in step 9, with only the `brief.md` path. If you cannot start an agent,
   send the path to the agent that started you, ask it to run the reviewer, and wait for the
   review. Fix the P0 and P1 notes in the plan (a new capture, a new trim) before you render: a
   stall, a small subject and a missing proof all show in the clips already.
6. `wv film preview`, and watch it at full length. Rhythm problems show only in motion.
7. Sound: every film has a music bed from the first frame to the last. Compose it
   (`references/score.md`, `wv sound score`) or pick licensed music that is as good. Place the
   cues in the scenes, then `wv film render`, `wv sound mix` and `wv film mux`.
8. `wv check` until it finds 0 defects. Then `wv measure`, and answer each advice line: change
   the film, or write in the storyboard's `what` line why it is a choice.
9. **Critique.** Run `wv film critique <dir>`. Start a fresh reviewer agent that did not make
   the film, with the strongest model you have. Give it only the path of the `brief.md` that the
   command prints, and ask it to follow that brief. Do not give it your reasons: the storyboard's
   `what` lines must carry them. If you cannot start an agent, send the `brief.md` path to the
   agent that started you, ask it to run the reviewer, and wait for the review. The packet holds
   every frame the reviewer needs, so a read-only reviewer can do it. Fix each P0 and P1 note,
   or answer it with a reason. Then run a new round with a new reviewer, until a round has no P0
   and the score is 8 or more, or three rounds have run.
10. Deliver: the MP4 path, its length, the check result, the measures, the critique notes and
   what you did about them, and where the music comes from (its licence).

## What `wv check` blocks

A defect is objective: the viewer sees or hears it as broken.

- A cut whose first frames repeat the picture (motion stops at the cut), a freeze that the
  storyboard did not plan, a ghost of the next or the last shot at a cut, a staircase (a moving
  shot whose motion lands in steps every 3 to 8 frames; `wv film render` captures with one
  worker to prevent it, so do not pass `--workers` for the master).
- A colour that is not in the product's CSS, text under 30 px at 1080 (8 px on a phone; in a clip too) or text
  cut by the frame, and private data on the page (local addresses, private IPs, emails, home
  paths, keys).
- The picture's length differs from the storyboard's by more than one frame or 25 ms, whichever is
  longer (a shot or its end is missing). The same tolerance applies to a sound track or a mixed
  master against the picture: an AAC frame of padding is allowed, no more (a stale `master.wav`
  from an older cut). A master shorter than the picture is refused at the mux.
- No sound track, clipping, a master outside -17 to -15 LUFS, or a true peak over -1 dBTP. A
  quieter master whose peaks reach the ceiling is sparse sound (cues, no bed): a note, not a
  defect.
  (`--no-audio` skips these on a picture-only render.)
- The sound floor: no music bed in the mix report (room tone is not a bed), under -30 LUFS
  momentary for over 25 % of the film, a momentary jump of over 20 LU above the 3 s before
  it, digital silence over 1.5 s (a shot with `silence: true` may be silent), and a sound that
  the owner rejected (`references/rejected-sounds.json`, plus your own list in
  `$WV_REJECTED_SOUNDS` or `~/.config/pi-walkthrough-video/rejected-sounds.json`). A film
  without a bed needs `music: { none: "<the owner's reason>" }` in the storyboard; the quiet
  share and the jump are then notes. The film without a bed scored 4 of 10.

Every line has a `Fix:` line. Style is not a defect: `wv measure` gives advice, the critique gives
judgement, and you decide.

## Quick mode: a plain screen walkthrough

For a tutorial or a README clip with captions and an optional voiceover, `wv compose` makes the
whole video from a capture and a shot list: it plans the camera, the cursor, the captions and the
timing, and `wv gates` checks it. It is not a launch film. See `references/compose.md`.

## Rules

- Never use `recordVideo` or a screen recorder: they drop frames and blur text. Use `wv capture`.
- Every HyperFrames call goes through `wv`, which turns telemetry off. Do not send HyperFrames
  feedback, do not log in, and do not suggest the HeyGen desktop app.
- Fake, seeded data only. No real names, emails, tokens, host names, IP addresses or ports in a
  frame.
- The checks and the critique are the proof. "It looks right" is not a check.
- Music must have a licence that allows this use. Name the source in the delivery, and the
  sample sets of a composed score with their licences (`references/score.md`, Credits: the
  Salamander piano needs its CC BY 3.0 line).
- Read `references/troubleshooting.md` when a capture, a build or a render fails.
