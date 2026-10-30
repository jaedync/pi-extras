# Review

The gates measure what can be measured. The review catches what they cannot: a shot that shows
the wrong thing, a payoff that goes by too fast, a caption that says what the picture already
says. Review as the viewer, who sees the video once, often on a phone.

## 1. Look at the sheets

`wv review proj` writes these into `proj/.hyperframes/artifacts/review-<stamp>/` and prints
their paths (a short video has one beat sheet, `review-beats.jpg`; a long one has
`review-beats-1.jpg`, `review-beats-2.jpg`, ...):

- the beat sheets: each shot just after it starts and at its middle, labelled with the time;
- the seam sheets: five frames across each shot cut (`review-seam-01.jpg`, ...), one sheet per
  cut, labelled with the time of each frame;
- the phone sheet: the beats at 360 px wide.

The cut list comes from `plan.json`, not from the composition: a caption, a beat marker or a
voice line is not a cut, so a 7-shot video gets about 8 seam sheets, not 26. The command collects
every still in one browser session, so it takes seconds. Use `--out <dir>` to keep the sheets in a
folder of your choice.

Known artifact: on a few beats the snapshot shows the whole frame shifted and enlarged (the
captions move too). The render does not have it. When a beat looks like that, extract the same
time from the render before you write a note:
`ffmpeg -ss <t> -i walkthrough.mp4 -frames:v 1 frame.png`.

## 2. Ask these questions, one pass each

| Question | What it catches |
|---|---|
| Does each shot show what its caption names? | The camera on the wrong control; the result off screen |
| Is the payoff the clearest frame of the video? | The result shown at the overview, too small or too short |
| Can a stranger follow it with the sound off? | A step that only the voice explains; a jump between states |
| Can every caption be read on the phone sheet? | Long captions, low contrast |
| Is anything on screen that is not the story? | Toasts, dev banners, a real name or email, a loading spinner |
| Does the cursor arrive before each change? | A change with no visible cause |

## 3. Write notes, then fix

One line for each problem: `t=4.2s · where · problem → exact change`.

- **P0**: wrong, unreadable, private data on screen, the payoff missing.
- **P1**: weak: a dull frame on the payoff, a caption that repeats the picture.
- **P2**: polish.

Fix every P0 and the P1s worth the time. Fix in the flow or `shots.json`, compose, run the gates,
and look again only at what changed. A second full pass only when a P0 is still open.

## 4. The fresh review

When you can start a subagent, give it only the sheet images and `shots.json`. Ask for P0 and P1
lines in the format above and nothing else. Do not give it your notes.

## 5. Watch it move: the preview

The sheets are stills. Motion errors (a jump, a cursor that overshoots, a camera move that
starts before the caption ends) show only in a video. `wv preview proj` writes `proj/preview.mp4`
at 640x360 and 30 fps in about a minute. Watch it once, and write a note for anything that reads
wrong; its small text is not a caption or readability problem, so judge those on the sheets and
the render.

## 6. Check the render

The sheets show the composition. The viewer sees the MP4. After `wv render`, make one sheet
from the MP4 (a frame every 1.25 s, with the time) and look at it once:

```sh
ffmpeg -v error -i walkthrough.mp4 -vf "fps=0.8,scale=640:-1,drawtext=text='%{pts\:hms}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x8" -frames:v 1 render-sheet.jpg
```

## 7. The delivery note

Say what the gates measured, what you only looked at, what nobody checked (you cannot hear the
voice: say so), and the weakest shot.
