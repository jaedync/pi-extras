# Compose the score in code

The owner rated two scores composed in code 8 and 7 of 10. Every library track got 2 to 6. A
composed score is the default bed. You cannot hear it, so each rule below puts a measure where
an ear would be. Say in the delivery that nobody listened.

## Commands

```bash
wv setup --music                                               # once per host: the sampled instruments
cp <skill-dir>/templates/score/score.py <film>/score.py        # start from the template
wv film build <film>                                           # out/cues.json: length and picture events
wv sound score <film>/score.py --cues <film>/out/cues.json --out <film>/score
wv sound mix <film>/out/cues.json --sfx <film>/assets/sfx --bed <film>/score/score.wav --out <film>/out/master.wav
```

The mix sees `hit-plan.json` beside `score.wav` and starts the score at 0 s, with no lift search
and no stretch: the score is already timed to the cue sheet. After a re-time, run `wv film
build`, `wv sound score` and `wv sound mix` again; no `liftAt` edit is needed.

The hit table gives each hit's frame at the film's rate: `--fps` sets it when the cue sheet has no
`fps` (the sheet from `wv film build` carries it).

`wv sound score` runs the score with the film's length (`DUR`), then checks two things. It
exits 1 when one fails:

- **Hits.** Each `[name, time_s, part]` in `hit-plan.json` must sit within 10 ms of its picture
  time in `score.wav`. The check finds the onset in the dry part (`render/<part>.wav`), then
  finds that part in the mix. Table: `score/hit-table.md`.
- **Harmony.** No avoid note over its chord, and no long note a half step from the bass
  (`notes.json`).

## Rules that mattered

1. **Plan bars from the shots.** Make the bar plan before a note. A short shot gets a short bar
   (a 2/4 bar for a 1 s shot), so each claim, the key action and the logo fall on a downbeat.
2. **One biggest hit.** Put it on the key action or the logo, and write down why.
3. **Write for this picture.** Give the picture's content a musical shape. The 8/10 score
   played the five votes as five notes (equal votes one note, outliers jump). One motif: state
   it on the first action, bring it back at the payoff. A stock genre groove gives nothing.
4. **Make room in time.** Stop the drums for about 0.9 s after the biggest hit, so the cues
   after it are heard alone. Thin the music on a quiet claim (no kick, filter closed, 4 to 6 dB
   down) and build into the payoff.
5. **Place hits by time.** `place(buf, x, t)` at the picture time, never by feel. Each hit also
   goes to its dry part in `render/`. A changed velocity can change the sample: check again.
6. **Voices with life.** No static oscillators: use `supersaw2` and `pluck2`. Double the main
   synth line with a recorded instrument 7 to 8 LU lower. Saturate the bass a little (`drive`)
   so a phone speaker plays it.
7. **Balance by LUFS.** Stem targets: drums -19, bass -21, harmony -22, lead -21.5, fx -27,
   glock -28. Then a fader ride for the form. `write_stems` trims all stems by one gain.
8. **The bed sits under the cues.** `wv sound mix` puts it at `music.db` (default -21 dB
   under the cues). The owner called that level correct. Do not raise the music to fix a weak
   section; fix the section.
9. **Cues first at a shared hit.** Let the effect's attack go first: dip the music above 1 kHz
   by about 7 dB for 0.1 s on the logo hit (`space_for_cues`).
10. **No stock chime.** A stock UI "confirmation" chime on the big moment sounds bad (owner,
    2026-10-29); `wv check` blocks the known ones. Write the moment in the score instead.
11. **Small refinements do not show.** Four fine refinements of a good score were "really hard
    to tell apart" (owner). Spend the time on the plan, the motif and the room in time.
12. **Fixed seeds.** Keep the files you checked. A rebuild of a sampled part can differ a little.

## Voices

`sc.py` (on the score's path) has the synth voices: `supersaw2`, `pluck2`, `sub_bass`,
`saw_bass`, `wood_bass`, `kick808`, `impact`, `riser`, plus `filt`, `duck_curve`, `gain_ramp`,
`reverb`/`make_ir`, `delay`, `drive`, `lufs`, `true_peak`, `master` and `write_stems`. They
need only the runtime venv (`wv setup` installs numpy, scipy, mido and pedalboard).

Sampled parts (piano, marimba, glockenspiel, drum kit) render through `sfz_render` with
`sfizz_render` and the sample sets in `$WV_MUSIC_KIT` (default
`~/.cache/pi-walkthrough-video/music-kit`: `bin/sfizz_render`, `samples/vcsl/*.sfz`,
`samples/salamander/`). Sampled notes start 9 to 23 ms late; `sfz_render` plays them early by
their measured attack. A score that plays a sampled part needs the music kit: `wv sound score`
refuses without it and says `wv setup --music`. A score with only synth voices needs no kit.

## The music kit (optional, one install)

`wv setup --music` installs the kit into `$WV_MUSIC_KIT` (default above). It needs git, cmake
and a C++ compiler, about 3 GB of free space while it works, and about 5 minutes on 16 cores.
It downloads three pinned sources and builds one binary:

| Source | Pin | Download | Licence |
|---|---|---|---|
| sfizz, built with cmake to `sfizz_render` only (no JACK, LV2, VST or tests) | `f5c6e29` | about 148 MB with its submodules | BSD-2-Clause |
| VCSL, 10 sample folders by sparse checkout (no Vibraphone: no map reads it) | `c1ea7bc` | about 207 MB | CC0 1.0 |
| Salamander Grand Piano V3, 668 files, 641 FLAC samples | `3382bf9` | 714 MB | CC BY 3.0 |

Then it writes `kit.sfz`, `marimba.sfz` and `glock.sfz` from the VCSL samples, trims the leading
silence of the piano samples (at the first sample above -66 dBFS, at most 15 ms), and renders a
short pass through each of the four SFZ files. All four must be non-silent at 48 kHz. The kit is
built in a staging folder and moves into place only when every step passed, so a failure never
leaves a half kit.

The finished kit is 732 MB on disk (the piano 691 MB, the VCSL samples 39 MB, the binary 3 MB).
It also installs the score's Python packages (numpy, soundfile, scipy, mido, pedalboard) into the
runtime venv when they are missing, so `wv setup --music` alone can render a score with a sampled
part.

The SFZ maps are byte for byte the maps of the hand-built kit, and the smoke render is bit for
bit the same WAV, so a score sounds the same on both. A second `wv setup --music` reads the kit,
runs the smoke render and skips the download.

- `wv setup --music --check` reports each part, its commit and its smoke render, and exits 1
  when one is missing.
- `wv setup --check` prints one line about the kit and never fails on the optional kit.
- The kit's `kit.json` records the three commits and the smoke result. `licenses/` holds the
  three licence files.

## Credits

Name every source in the delivery:

- The synth voices and the score: your own work, no licence needed.
- Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0: a published film that uses the piano
  must carry this line in its description or credits, and the delivery must repeat it:
  "Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0".
- VCSL (Versilian Community Sample Library), CC0 1.0: no attribution required; name it anyway.
- pedalboard is GPL-3.0: it runs as an installed tool. Do not copy its code into the film.
