# Taste

This file says what a good launch film is and why. It is not a recipe: every rule here has a
reason, and a film may break a rule when the reason does not apply. Write in the critique which
rule you broke and why.

`wv taste` prints this file and then the owner's own notes. The owner's notes win over this file.
Each note the owner gives about a film goes in with `wv taste --add "..."`, so the same mistake
does not come back in the next film.

## 1. What the film is for

A launch film makes one person want to try the product, in 20 to 90 s, often with the sound off
and on a phone. It is an argument, not a tour:

- One promise, said early, in the fewest words.
- Proof: the product keeps the promise, on screen, with real UI.
- An end card with the name and where to get it.

The viewer must understand each shot at first sight. A shot that needs a second look is a shot
that loses the viewer.

Floors. The idea is yours; these hold for every idea:

- **Say what it is in the first 3 s.** The category in plain words ("Scrum poker for your
  team"), on screen, before the first claim. Reason: a film that named its category at 23 s
  scored 4; the same product named at 1 s scored 7.
- **Every claim reads without the product's jargon.** If a claim needs the field to read ("Then
  hear the 8"), let the product say it in its own UI. Reason: the app's own line "Lowest 3: Ana ·
  Highest 8: Priya. Hear both sides." is the claim and the proof at once.
- **The strongest picture comes in the last third.** Put weaker proof before the climax, not
  after it. Reason: the film rated 4 flipped its cards at 37 % and ended on a form and an empty
  room.
- **Show the input and its effect.** Proof of control is one shot where the viewer sees the
  input (a key, a click, a drag) and what it does, not only the result. For a
  game or a simulator this is the proof: a key press is invisible, so draw the key on screen as
  it goes down, then hold on the change it makes. Name the shot in the storyboard's `proof`. Reason
  (kit guidance, not an owner note): the Earth Flight film showed only flight that was already
  under way, and three fresh critics each named "no proof of control" and scored it 6.
- **The subject must be visible at phone size.** The thing a shot is about fills at least about
  5 % of the frame width at its largest; on a phone, 5 % of 480 px is 24 px. Capture closer,
  frame tighter or rebuild it large. Name it in the shot's `subject` so the build measures it.
  Reason (kit guidance): the Earth Flight climax showed its flyer about 21 px wide (5 px on a
  phone), and all three critics named it.
- **One world.** The same names, deck and values in every shot. Reason: the film rated 4 showed
  a Fibonacci hand, then a T-shirt-size capture.

## 2. Rhythm

- **Pick a family first.** The reference films split into montage films (27 to 38 cuts a minute,
  shots of 0.6 to 1.6 s) and one-take films (0 to 2 cuts, the camera travels in a held frame).
  Few good films sit between the two. Reason: a middle pace reads as neither energy nor calm.
- **Vary the shot lengths.** Shot length CV in 8 montage and middle films is 0.34 to 1.38 (median
  0.67). A CV under 0.3 is a metronome. Reason: the owner's note on the golden film ("the pacing
  feels off") measured as 13 of 15 shots at exactly 2.0 s, CV 0.18. Give each shot the time its
  content needs: a claim of three words is short, a proof with a result is long.
- **Hold to read twice.** A claim needs about 2 s at phone size: the words are up by 0.4 s, then
  the eye reads it twice. A 1 s claim reads once at most.
- **Stillness is a tool.** About a third of a reference film's runtime is still (median 34 %),
  the longest hold is about 1.3 s. A film that moves every frame reads as busy. Plan the stills:
  declare them as `holds` in the storyboard, so `wv check` knows they are meant.
- **Cuts do not snap to the beat.** In the reference films, cuts land on a beat no more often than
  chance. Shot lengths in beats give the film a pulse; the cut itself follows the picture. Put the
  music's biggest lift on the end card instead (back-timing).

## 3. Cuts

- **Cut on action.** The first frame after a cut already moves. An entrance starts a few frames
  before the cut (`LEAD` in the kit). Reason: a still first frame reads as a hitch. The owner's
  note "some transitions are not fully smooth" measured as repeated frames at 7 of 14 cuts.
- **No repeated frames at a cut, no unplanned freeze.** `wv check` blocks both. A freeze of
  0.25 s at a match cut reads as a dropped frame, not as a pause.
- **A match cut turns a recreation into proof.** End the recreated shot on an element at a known
  size and place; open the captured shot with the same element at the same size and place. The
  viewer sees the mockup become the real product.
- **Alternate the grounds.** The brand ground for claims, the app surface for product. The change
  of ground is a visual beat, so a cut between two shots on the same ground needs a reason.

## 4. Camera

- **One move per shot, at most.** A move starts, arrives and stops. The median reference move
  lasts 0.64 s (0.3 to 1.5 s), with its peak speed at about 0.3 of the move: a quick start that
  settles slowly. About a quarter of the runtime is in a move (median 25 %, range 4 to 46 %).
- **Zoom gently.** The median reference film magnifies 1.33x at most inside a shot; most stay
  under 1.6x. The larger numbers (Apple 3.2x, Screen Studio 4.2x) are 3D product motion and live
  action, not a camera on a screen. A punch-in of 2x or 3x on a screen recording reads as a tool
  demo, not as a film. To make UI large, build it large (recreate it at 2.5x to 3x), do not zoom
  into pixels.
- **Drift on holds.** A 3 to 6 % drift keeps a held shot alive. The kit's `drift` uses
  `ctx.ease.drift`: it leaves the cut fast and keeps a floor speed to the end. An in-out ease
  barely moves in its first frames, and a plain ease-out stops in its last 0.2 s, which
  `wv check` reads as a freeze.

## 5. Type

- **Type carries the argument.** About a quarter of a reference film is kinetic type, and every
  one ends on a type or logo card.
- **Few words.** A claim is 2 to 5 words. If it needs a comma, it is two claims.
- **Large.** A claim fills 50 to 70 % of the frame width, at 140 to 180 px in a 1080 frame.
  Reason: the claims of the film rated 7 were 138 to 182 px and 50 to 70 % wide; the film rated 4
  had 117 to 137 px and 36 to 49 %. No text under 30 px (`wv check` blocks it):
  the phone sheet shows the frame at 480 px wide, where 30 px is 8 px.
- **The product's display face, the product's accent.** The full stop of a claim can be the
  product's accent dot. No font and no colour from outside the product.

## 6. The product's own look and motion

- **No invented colour.** Every colour comes from the product's CSS (`wv lift`), or is a neutral
  grey. `wv check --page` blocks the rest. Reason: in the golden film a script found 13 invented
  values that looked right by eye.
- **Move like the product moves.** Use the product's own curves (its springs and eases from
  `tokens.json`) and its own keyframes (a card deal, a pop, a flip). The film then feels like the
  product, because it moves like it.
- **Recreate where it must read; capture where it must be real.** Recreated UI (the app's markup
  and `app.css`) is sharp at 3x, every state is on the timeline, and type can be sized for a
  phone. Captured UI proves "this is the real app". Use capture for one or two moments of proof.
- **Fake, seeded data.** Real-looking names, no real people, no emails, no hosts or ports, no keys
  (`wv check --page` scans for them). A local address in an invite link is a common leak.

## 7. Sound

- **A music bed from the first frame to the last.** Room tone is not a bed. Reason: the film
  rated 4 had cues and room tone only, under -30 LUFS for 75 % of its length; the same picture
  as the film rated 7 scored 8 with a composed score. Compose one (`references/score.md`) when
  no licensed bed is as good. A film without a bed needs `music: { none: "<the owner's
  reason>" }`, and `wv check` blocks the rest.
- **Cues on picture events, not on moves.** Clicks, keys, landings, ticks, flips, one end hit.
  Camera moves and claims are silent. Reason: a whoosh on every move is noise, and it makes the
  real events less clear.
- **Each cue on its event, to the frame, at its own level.** Raw takes differ by up to 9 dB; set
  the peak of each cue. Rotate the files of a family (round robin), so a repeat does not sound
  like a machine.
- **The bed sits under the cues and lands on the end card.** Fader about -21 dB under the cues,
  fade in 0.3 s, fade out 1.4 s, the biggest lift on the end card.
- **No stock UI chime on the big moment.** The owner disliked the generic "confirmation" chime
  that played just after the card flip. The biggest moment belongs to the score, or to a physical
  sound that matches the picture (cards, paper, a switch).
- **Master at -16 LUFS, true peak -1 dBTP or lower.**
- **The music must be good.** The owner rejected all three beds of the golden film ("the music
  sounds awful"): a game track and two first-attempt model beds. A weak bed pulls the whole film
  down. If no good bed is at hand, say so in the delivery; do not hide a weak bed under the cues.

## 8. Freedom

The owner's note on the golden film: "Give more control back to the model. Prompt it better, and
give it more freedom." The golden film followed 40 fixed rules and had no idea of its own. So:

- Find the one idea that this product's film is about (a deal of cards, a flight, a pile of
  documents that sorts itself) and build the film around it.
- Use the instruments for the mechanical work and the checks for the defects. Every other
  decision is yours. Say each decision in the storyboard's `what` line, so the reviewer can judge
  the intent, not only the result.

## 9. Owner notes

The owner's notes are below this line, or in the notes file that `wv taste` prints after this
file. Each note gives the film, the date and the words.

- 2026-10-28, golden Pointer film, rated 7 of 10: "much better than the old videos, a bit worse
  than the reference films".
- 2026-10-28, golden Pointer film: "The music sounds awful."
- 2026-10-28, golden Pointer film: "Some transitions are not fully smooth."
- 2026-10-28, golden Pointer film: "The pacing feels off." (Also: the overall pace is right.)
- 2026-10-28: "Give more control back to the model. Prompt it better, and give it more freedom."
- 2026-10-29, golden Pointer film with the composed score "Pulse" (blind round 1): 8 of 10, the
  best of 8 beds. A second composed score (felt piano and wood) got 7; library tracks got 2 to 6.
- 2026-10-29, the same film: the reveal cue just after the card flip (a stock UI "confirmation"
  chime) "sounds bad, don't love it."
- 2026-10-29, blind round 2 (four refinements of "Pulse"): "really hard for me to tell the
  difference between any of these." The original kept the top rating (6); the boldest rewrite got
  the lowest (4). Fine changes to a good score are not worth a round.
- 2026-10-29, the first film from the new kit (Pointer, made by a fresh agent with freedom, one
  critique round, sound effects and room tone, no music): 4 of 10, worse than the golden film.
