# Computer Use attribution

The `computer_use({ code })` interface, its method list and the worker-based
script runner follow https://github.com/tmustier/codex-computer-use-mcp, MIT,
Copyright (c) 2026 Thomas Mustier. The launchd transport, direct MCP client and
session handling here are new; the code was written for this package.

# Parser research attribution

Selector vocabulary and grouped-result extraction were informed by:
- https://github.com/mjakl/pi-kagi-search (deprecated), MIT, Copyright (c) 2026 Michael Jakl.
- https://github.com/czottmann/kagi-ken, MIT, Copyright (c) 2025 Carlo Zottmann.

The HTTP safety, bounded client, queue/cache and tests here are new. No upstream credential persistence/login UI was reused. `node-html-parser` 7.0.2 is a locked runtime dependency with its own license in node_modules.

# Pi system folding attribution

The system-state fold in `lib/cache-compaction/system-fold.ts` adapts
`getCurrentSystemMessage` and `getCurrentTools` from
https://github.com/earendil-works/pi/blob/v0.99.2/packages/ai/src/utils/transcript.ts,
MIT, Copyright (c) 2025 Mario Zechner. The entry-position mapping here is new.

# Social preview upload attribution

`scripts/preview/upload.mjs` follows the GitHub settings-page flow of
https://github.com/ibrews/gh-social-upload, MIT, Copyright (c) 2026 Alex
Coulombe: the Social preview selectors, the upload-completion signal and the
saved Playwright session. That tool adapts
https://github.com/AnswerDotAI/gh-social-preview (ISC, Jeremy Howard), whose
renewal of the saved session after each upload is followed here too. The due
check, rendering, confirmation and session file handling here are new.

# Walkthrough video runtime packages

The `walkthrough-video` skill bundles none of these. `wv setup` installs pinned
versions into `~/.cache/pi-walkthrough-video` on first use, each under its own
license: `hyperframes` (Apache-2.0, HeyGen), `playwright-core` (Apache-2.0,
Microsoft), `gsap` (GreenSock standard no-charge license, not an OSI license),
`typescript` (Apache-2.0, Microsoft) for the film project's type check,
`kokoro-onnx` (MIT), `onnxruntime` (MIT), `numpy` (BSD-3-Clause), `soundfile`
(BSD-3-Clause), `scipy` (BSD-3-Clause), `mido` (MIT), `pedalboard` (GPL-3.0,
Spotify: installed for the score kit, not linked into this package),
`opencv-python-headless` (Apache-2.0) and the Kokoro-82M voice model
(Apache-2.0). It also installs `chromium-headless-shell` and `chromium`
(BSD-3-Clause plus its third-party notices, Google) for the browser.

`wv setup --music` (optional) builds and downloads the music kit into the
same cache. It builds `sfizz` from source, with its submodules, into
`sfizz_render` (BSD-2-Clause, sfztools), and downloads the VCSL sample
folders (CC0 1.0, Versilian Studios, https://github.com/sgossner/VCSL) and
the Salamander Grand Piano V3 (CC BY 3.0, Alexander Holm,
https://github.com/sfzinstruments/SalamanderGrandPiano). It writes its own
SFZ maps over the CC0 samples. The kit trims the leading silence of each piano
sample, so a hit lands on its frame, and plays the samples in a score that the
film's author composes. A published film that uses the piano must carry this
line in full, because the licence asks for the licence link and the changes:

    Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Source: https://github.com/sfzinstruments/SalamanderGrandPiano. Changes: leading silence trimmed; used as samples in a composed score.

`wv compose` writes Google Fonts (SIL Open Font License 1.1) into the project
page from the fonts it fetched at capture time; it copies no font files into
this package. The composer writes HyperFrames projects; it copies no
HyperFrames code.

## MIT License notice for the referenced implementations

Copyright (c) 2026 Thomas Mustier
Copyright (c) 2026 Alex Coulombe
Copyright (c) 2026 Michael Jakl
Copyright (c) 2025 Carlo Zottmann
Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# UI Redline

The `ui-redline` skill was prompted by the idea of a design-review skill for
generated UI in https://github.com/heydamir/unslop (CC BY 4.0, Damir
Sokolovsky). ui-redline copies no text, rule list, example or code from it:
its measured rules, scripts, brief, passes and review prompt were written for
this package. `redline setup` installs pinned `playwright-core` (Apache-2.0,
Microsoft) and `chromium-headless-shell` (BSD-3-Clause plus its third-party
notices, Google) into `~/.cache/pi-ui-redline` on first use; the skill bundles
neither.
