# The reference films

Twelve public launch films, measured frame by frame on 2026-10-28. They are the bar. `wv measure`
prints your film's numbers beside their range, from `films.json` (the same data as the table
below). Watch the ones whose device fits your product before you plan: the links go to the
publisher's own upload.

Take the reason behind a device, not the device. A film about a scrum-poker app does not need a
3D laptop; it needs the same clarity: one claim, one proof, at a size a phone can read.

## The device of each film

| Film | Link | The device | Take from it |
|---|---|---|---|
| Apple MacBook Pro (2026) | https://youtu.be/JlS6RmAJKnE | 3D renders of the device on black, one short claim per shot, the feature name typed in the centre. | One claim per shot. Black and silence make a claim feel large. |
| Arc 1.0 (2023) | https://youtu.be/n5Vwrj1gEWs | Archival footage in rounded card frames, then kinetic type, then the app in a device mockup. | A story before the product. Type on a beat, then proof. |
| Cursor 3 (2026) | https://youtu.be/UxbULt_hCdA | A founder interview cut against full-frame screen recordings. The only raw-UI film in the set. | Raw UI works only with a voice that carries the argument. |
| Figma Config 2025 | https://youtu.be/NHodnYFUT_I | A fast launch montage. Each launch gets a colour field, a kinetic title and a UI moment. | A system: the same three beats per idea, with varied lengths. |
| Figma Motion (2026) | https://youtu.be/l3HuAYXyOTo | The app reskinned as fake projects, with motion trails and a timeline. Type cards on black. 12 fps on purpose. | The product's own subject (motion) is the film's style. |
| Framer (2025) | https://youtu.be/8AHPXm9Y6mI | Slow 3D gradient shapes, one big claim, then the real editor with a camera push and a cursor. | One claim, then the real tool, with one move into the action. |
| Linear Agent (2026) | https://youtu.be/mRql2VJ99gM | The real app in a tilted 3D plane on dark, one continuous drift, then a type card. | A one-take film: no cuts, a calm camera, the UI as the hero. |
| Notion AI (2024) | https://youtu.be/S92KX8-Hmlc | A white page, one claim per shot, app windows that slide in beside a solid colour panel. | Stillness: 81 % of the film is still, and it reads as calm, not dead. |
| Raycast (2025) | https://youtu.be/Mi173xGb0ZA | Macro crops of one search bar, tilted in 3D with reflections, then mono type on black. | One element of the UI, very large, is enough for a whole film. |
| Screen Studio (2026) | https://youtu.be/7AnqbpeJoHc | Live action of a person at a desk, then the app floating on a gradient with captions. | Fast cuts (0.6 s median) with an irregular rhythm (CV 1.38). |
| Vercel Product Tour (2022) | https://youtu.be/3m1FcGW6V4g | One long screen recording framed on a dark surround, with tooltips and a logo card. | A framed recording with a surround never looks like a raw screen. |
| Vercel v0 (2023) | https://youtu.be/By9wCB9IZp0 | A white page, a typed prompt as the only subject, then the app in a floating window. | The input is the story: typing is a strong shot. |

## What they share

- **Two families.** Montage films cut 27 to 38 times a minute; one-take films cut 0 to 2 times
  and move the camera in a held frame. Four films sit between. Pick the family first.
- **The rhythm is not even.** Shot length CV is 0.34 to 1.38 in the montage and middle films
  (median 0.67). An even rhythm (CV under 0.3) reads as a metronome.
- **A third is still.** The median film is still for 34 % of its runtime. The longest still hold
  is 0.6 to 3.1 s.
- **Moves are short.** About a quarter of the runtime is in a camera move; a move lasts about
  0.3 to 1.5 s (median 0.64 s), and its peak speed comes early (median at 0.3 of the move).
- **Zoom is small.** The median film magnifies 1.33x at most inside a shot. The 3x and 4x numbers
  of Apple, Vercel v0 and Screen Studio are 3D product motion or live action, not a camera on UI.
- **The UI is never raw for long.** 11 of 12 show the UI zoomed, framed or on a ground. Type is
  about a quarter of the runtime, and every film ends on a type or logo card.
- **Sound never stops.** Every film has a bed from the first frame to the last. Music-only films
  sit at about -16 LUFS. 9 of 12 have no voiceover. Cuts do not snap to the beat (the share on a
  beat is at chance level).

## The numbers

Camera numbers come from estimator v3 (the one in `wv measure`). The shot CV is the standard
deviation of shot length over its mean. The last row is the golden Pointer film, made by hand
before this kit, which the owner rated 7 of 10.

| Film | Family | Length s | Cuts/min | Shot median s | Shot CV | In a move | Move median s | Zoom max | Ease peak | Still | Longest hold s | LUFS | Voice |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AppleMacBookPro | montage | 59.85 | 27.1 | 1.57 | 0.92 | 33 % | 0.43 | 3.23x | 0.16 | 13 % | 1.03 | -16 | no |
| Arc1.0 | montage | 34.29 | 31.5 | 1.43 | 0.65 | 27 % | 0.65 | 1.40x | 0.54 | 38 % | 0.87 | -11.5 | no |
| Cursor3 | between | 90.35 | 17.9 | 3.15 | 0.42 | 17 % | 0.85 | 2.00x | 0.45 | 30 % | 3.13 | -27.3 | yes |
| FigmaConfig25 | montage | 81.13 | 37.7 | 1.42 | 0.58 | 25 % | 0.5 | 1.14x | 0.27 | 12 % | 0.58 | -15.7 | no |
| FigmaMotion | between | 68.09 | 19.4 | 2.83 | 0.34 | 36 % | 0.5 | 1.21x | 0.21 | 6 % | 0.67 | -13.4 | no |
| FramerThats | between | 37.51 | 16 | 2.71 | 0.69 | 46 % | 1.02 | 1.62x | 0.29 | 8 % | 0.79 | -15.7 | yes |
| LinearAgent | one-take | 54.87 | 2.2 | 9.75 | 0.93 | 25 % | 1.05 | 1.05x | 0.25 | 18 % | 1.63 | -28.9 | no |
| NotionAI | between | 56.59 | 17 | 2.34 | 0.7 | 6 % | 0.29 | 1.14x | 0.29 | 81 % | 2 | -22.4 | no |
| Raycast26 | one-take | 38.55 | 1.6 | 19.27 | 0.54 | 36 % | 1.5 | 1.26x | 0.6 | 37 % | 2.53 | -13.2 | no |
| ScreenStudio | montage | 45.29 | 34.4 | 0.63 | 1.38 | 11 % | 0.63 | 4.15x | 0.64 | 51 % | 0.93 | -13.7 | yes |
| VercelTour | one-take | 41.29 | 1.5 | 20.64 | 0.9 | 4 % | 0.33 | 1.01x | 0.3 | 67 % | 2.72 | -17.4 | no |
| Vercelv0 | one-take | 47.47 | 0 | 47.47 |  | 26 % | 0.92 | 3.47x | 0.47 | 54 % | 2.5 | -16.7 | no |
| *pointer-golden* | montage | 30 | 28 | 2 | 0.18 | 25 % | 0.82 | 1.29x | 0.25 | 33 % | 0.57 | -16.6 | no |

Medians of the 12: 17.4 cuts a minute, shot median 2.77 s, 25 % in a move, move median 0.64 s,
zoom max 1.33x, ease peak 0.30, 34 % still, longest hold 1.33 s, -15.8 LUFS, 129 BPM.

## How they were measured

Cuts: PySceneDetect ContentDetector at 27. Camera: ORB matches frame to frame, a similarity fit by
RANSAC that resets at every cut, ECC as the fallback on flat UI (calibrated to 0.2 % on a known
zoom). Still: ffmpeg freezedetect (n=0.001, d=0.15 s). Loudness: EBU R128. The device lines are
judgement from contact sheets, not an instrument.
