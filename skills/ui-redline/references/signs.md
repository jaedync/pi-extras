# Signs

Two kinds of sign. **Measured** signs are rules of `redline audit`: the id is the rule id in
`audit.json`, `redline rules` and `.redline.json`. **Judged** signs are the ones only a person
can see; read them on the screenshots every time.

Each measured rule lists what it reads, then its known false positives. A false positive
stays a finding in the output; say in the report why you left it.

## Measured: color

| Rule | Reads | False positives |
| --- | --- | --- |
| `hue-gradient` (high) | A background gradient with two or more stops of clear hue (OKLCH chroma ≥ 0.08) at least 30° apart. | A real brand gradient that the user confirms. A chart or image drawn with CSS. |
| `gradient-text` (high) | `background-clip: text` over a gradient with a transparent text fill. | None known. |
| `colored-glow` (high) | An outer box-shadow, text-shadow or drop-shadow with a blur of 6px or more in a clear hue. | A focus ring drawn with a blurred colored shadow (use an outline instead). |
| `color-wash` (medium) | A radial or conic gradient of a hue over 5% or more of the viewport, or `blur(16px+)` on a colored fill. | A real photo-like backdrop that the brief calls for. |
| `low-contrast` (high) | WCAG 2 contrast of text against its own and its ancestors' backgrounds: 4.5:1, or 3:1 from 24px (18.66px bold). Over a gradient, the worst stop. | Disabled controls (WCAG exempts them). Text that sits over a positioned layer from elsewhere in the page: the tool reads only ancestors. Text over an image is not measured; the audit prints a note. |
| `text-colors` (medium) | More than 5 distinct text colors (OKLab distance ≥ 0.03), not counting text on its own fill. | A data screen with many semantic text colors. |
| `accent-hues` (medium) | More than 3 hue families (30° bins) used on 2 or more elements each, in text, fills and borders. | A category color system that the product needs (labels, calendars). |
| `neon-border` (medium) | 3 or more elements with a saturated border (chroma ≥ 0.12, alpha ≥ 0.5). | Many selected chips in a multi-select. |

## Measured: type

| Rule | Reads | False positives |
| --- | --- | --- |
| `font-sizes` (medium) | More than 7 distinct font sizes on text. | A long article page with a full heading scale. |
| `heavy-weight` (medium) | Text at weight 800 or more. | A display face that is meant to be heavy (raise `min` in `.redline.json`). |
| `font-weights` (low) | More than 3 weights. | |
| `font-families` (low) | More than 2 non-mono families. | Fallback fonts that a slow load shows. |
| `tracked-caps` (medium) | Uppercase (by transform, or 4 or more capital letters) with letter-spacing ≥ 0.05em. | A brand that sets small caps labels on purpose. |
| `tight-small-text` (low) | Letter-spacing tighter than -0.02em at 18px or less. | |
| `tiny-text` (medium) | Text below 11px, at both sizes. | Legal footnotes the user wants small. |
| `tabular-figures` (low) | 3 or more number-only texts without `tabular-nums`. | Figures that never change and never stack. |
| `mixed-number-format` (low) | Money with and without decimals on one screen. | Prices next to totals in a cart, where cents matter. |
| `long-lines` (low) | Paragraph text of 160+ characters in a box over about 90 characters wide. | |

## Measured: spacing and details

| Rule | Reads | False positives |
| --- | --- | --- |
| `off-grid` (medium) | Padding, vertical margins, small horizontal margins and flex/grid gaps that are not a multiple of the grid (4px). 1, 2, 6 and 10px pass. | Values from `em` units on purpose, an exact centering offset. Change `grid` for a 2px or 8px system. |
| `uneven-siblings` (medium) | Three or more siblings with the same tag and classes but different padding, or rows of one width with different heights. | Rows that wrap to two lines on purpose. |
| `uneven-rhythm` (medium) | Three or more alike siblings in a column or a row with gaps that differ by more than 2px. Gaps over 64px (sections) and flush rows (most gaps 0) pass. | A list with a deliberate group break: give the group its own parent. |
| `nested-radius` (low) | A rounded box inside a rounded box, near its corner, whose radius is not about the outer radius minus the inset. | |
| `radius-count` (low) | More than 5 distinct corner radii, pills excluded. | |
| `focus-ring` (high) | Tab through up to 15 controls; for each, focus must change something on screen. | A control that shows focus by a change in a child element. |

## Measured: icons and copy

| Rule | Reads | False positives |
| --- | --- | --- |
| `emoji` (high) | Emoji in interface text (symbols below U+2300 such as ©, ™ and arrows pass; code blocks pass). | User content, such as chat messages and reactions. |
| `icon-sizes` (low) | More than 2 sizes among SVG icons of 40px or less. | |
| `icon-strokes` (low) | More than 1 stroke width among line icons. | Icons from two sets on purpose (rare). |
| `exclamation` (medium) | `!` in interface text. | Quoted user content, a product name with `!`. |
| `hype-words` (medium) | supercharge, seamless, unlock, unleash, magic, revolutionize, game-changing, effortless, next-gen, cutting-edge, skyrocket, blazing fast, AI-powered, 10x. | A word used literally (a magic-link login). |
| `unverified-claims` (medium) | "trusted/loved/used by", "10,000+ teams", "10x faster", rows of stars, "#1", "world's leading". | Never a false positive to ask about: ask the user. |
| `greeting` (medium) | A heading that starts with welcome, hi, hey, hello or good morning. | |
| `trailing-period` (low) | A period at the end of a button, label or heading of 6 words or less. | A brand voice that ends labels with periods: turn the rule off and say so. |
| `placeholder-data` (medium) | `[X]`, `123,456`, lorem ipsum, John or Jane Doe, `$0,000`. | |

## Measured: motion and layout

| Rule | Reads | False positives |
| --- | --- | --- |
| `looping-animation` (medium) | An infinite CSS animation outside `aria-busy`, progressbar, status and alert regions. | A live indicator outside those roles: add the role. |
| `transition-all` (low) | `transition-property: all` with a duration. | |
| `layout-transition` (medium) | Transitions on width, height, position, margins, padding, flex-basis. | An accordion that animates height on purpose (prefer `grid-template-rows` or transform). |
| `motion-curves` (low) | More than 2 easing curves or 4 durations. | |
| `mobile-viewport` (high, mobile) | No `<meta name="viewport" content="width=device-width">`. | |
| `horizontal-overflow` (high) | Content wider than the screen. | |
| `clipped-text` (medium) | Text cut off by `overflow: hidden` with no ellipsis. | |
| `tap-target` (medium, mobile) | A control smaller than 24×24px whose 24px circle touches another target (WCAG 2.5.8 with its spacing exception). Links inside a sentence pass. | |

## Judged: look at the screenshots

The tool cannot see these. Check each one on the before and the after screenshots.

- **Template composition.** Headline, subline, two buttons and a picture, all stacked and
  centered; three equal feature cards with an icon, a bold title and a vague line each; a
  row of equal stat cards with a sparkline in every card.
- **Decorative imagery.** Glossy 3D blobs, orbs, liquid chrome, nebulas, glowing grids,
  robots or brains for anything AI. The tool does not read images.
- **A headline that fits any product.** Swap in another product's name: if the headline still
  works, it says nothing.
- **A product preview that is not the product.** Fake windows full of grey bars, or a
  screenshot of a different screen.
- **No focal point.** Everything has the same weight, so the eye has nowhere to land; or
  every element is highlighted, so nothing stands out.
- **The pill badge above the headline** ("✨ Introducing X 2.0") and avatar rows with
  stars under the buttons.
- **Hover and press states.** The tool does not hover. Read the CSS for `hover:scale`,
  bouncy springs and moves of more than a few pixels; `redline scan` finds most of them.
- **Charts.** A rainbow of bars in one series, glowing bars, uppercase axis labels, two
  charts of the same size and kind side by side.
- **Dark and light.** If the product has both themes, audit both (`--scheme dark`).
- **The template look after cleanup.** Pure grey, Inter, white text and the old brand color
  on one button, on a product whose setting is warm or bright. Clean but anonymous is the
  next template: push the brief.
