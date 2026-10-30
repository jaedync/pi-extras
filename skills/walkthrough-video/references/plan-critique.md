# Plan review: the brief for a fresh reviewer

You are a fresh reviewer of a launch film that is not rendered yet. You did not plan it. You get
the plan: the storyboard and the real footage that the author captured for it. Find the problems
that will show in the film, now, while a change costs a line and not a render.

Every file you need is in this folder, so you need no ffmpeg and no write access:

- `plan.md`: the storyboard as planned: each shot's start, length, intent (`what`), clip and the
  part of the clip that it shows; the family, the planned pace and the proof shot.
- `clips/<shot>.jpg`: one contact sheet per footage shot: the part of the clip that the shot
  shows, at even steps, each frame with its shot time and its clip time.
- `clips/<shot>.txt`: the app's text in that part of the clip (a HUD readout, a label), each
  sample with its time, and the inputs (key, click, type, scroll) with their times.
- `advice.txt`: what `wv film build` already found (advice, not defects).
- `stills.jpg`: the recreated shots at phone size, when the author made stills.
- `films.md`: the 12 reference films, their devices and their measured numbers.
- the taste text, at the end of this brief. The owner's notes in it win.

## Ask these questions, one pass each

1. **The story.** From `plan.md` alone: what is the one idea? Does each shot move it forward? Is
   the category said in the first 3 s?
2. **Proof of control.** Is there a shot where the viewer sees an input (a key, a click, a drag)
   and its effect on screen? Look at the inputs in `clips/*.txt` and the times that each shot
   shows. A film of results only (the app already flying, already sorted) proves less than one
   input and its effect. For a game or a simulator this is the proof.
3. **The subject size.** In each contact sheet, find the subject (the thing the shot is about).
   At phone size (the sheet cells are about phone width) can you see it, and what it does? A
   subject under about 5 % of the frame width is a speck on a phone.
4. **Motion inside the shots.** Does each footage shot keep changing to its last frame, or does it
   stall (the same picture, a readout that stops)? Name the shot time where it stops. Do the
   shots move in different ways (a turn, a climb, a reveal), or the same way every time?
5. **The pace family.** `plan.md` gives the planned cuts a minute and the band. A montage cuts
   27 to 38 times a minute; a one-take holds one frame. Few good films sit between the two. If
   the plan is in the middle, is the reason in the storyboard good enough?
6. **The strongest moment.** Which shot is the strongest picture, and where is it (seconds and a
   share of the runtime)? Is it in the last third? Is it large and long enough to land?

## What to write

At most 10 notes, the most important first. One note is one line:

```
P1 | shot "orbit", 2.4 to 4.6 s | The readout stops at 24,600 for 2.2 s, so the climax stalls. | Taste 2. | Cut the shot at 2.6 s; give the time to a closer take.
```

- **P0**: the plan cannot make a good film: no proof, a subject no viewer can see, the wrong
  story.
- **P1**: the film will be clearly weaker than the reference films here.
- **P2**: polish.

Each note gives the shot and the time, what you see, why it matters (a taste rule or a reference
film), and one fix: a new capture, a new trim, a shot to cut, a length to change. Then write:

- **The idea**: in one sentence, as you understood it.
- **The one change** that would make the film better than any other change.

Do not praise and do not rewrite the film.
