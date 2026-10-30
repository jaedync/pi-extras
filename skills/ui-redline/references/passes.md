# Passes

Do the passes in this order and finish each one across the whole screen. The order matters:

- Spacing first, because color and type read differently once the rhythm is right.
- Copy before type and layout, because the length of a headline decides its size and place.
- Imagery and motion last, because they must fit a screen that already works without them.

The values below are defaults. A real design system or brand replaces them.

## 1. Spacing

- Scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96 (px). Any multiple of 4 is fine; 1 and
  2px nudges inside small controls are fine.
- Same kind, same size: all rows of a list share one height and one gap; all cards in a row
  share one padding. Set gaps on the parent (`gap`), not as margins on each child.
- Proximity shows grouping: space inside a group is smaller than space between groups. A
  section label sits closer to its own items than to the section above (for example 24px
  above, 8px below).
- Density: navigation rows 32 to 36px tall with 2 to 4px between them; compact panels 12 to
  16px padding; cards 20 to 24px; page edges 24 to 32px (16px on phones).
- Alignment: icons in one column, labels on one line, numbers right-aligned in one column.
  Remove stray `translate` and odd margins that nudge one element off the line.

## 2. Color

- Build one neutral ramp of 10 to 12 steps. In OKLCH: take the hue from the brief's setting,
  keep chroma between 0.004 and 0.015, and step the lightness. Backgrounds, surfaces, borders
  and text all come from it.
- Apps and dashboards keep surfaces close to neutral: people look at them for hours and the
  content must carry the color. Landing pages may tint surfaces further toward the setting.
- Text roles: primary (about 15:1 on the surface), secondary (about 7:1), muted (at least
  4.5:1). Map every other text color to one of these.
- One accent in the chrome, used rarely: the primary action, the selection, the one figure
  that matters. Text on the accent reaches 4.5:1; if not, darken it or put dark text on it.
  On a dark theme the primary button can be an off-white step of the ramp with dark text.
- Inside the brief's focus, color may be rich (a chart with several series, an object with
  real material), as long as each color means something.
- Semantic colors (success, warning, error) carry meaning only, and are toned down to sit in
  the palette.
- Borders: hairlines in the primary text color at 6 to 12% alpha.
- Depth: on dark themes, surface steps and hairlines, not shadows. On light themes, small
  neutral shadows (for example `0 1px 2px rgb(0 0 0 / 0.06), 0 1px 1px rgb(0 0 0 / 0.04)`).
- Remove hue gradients, gradient text, colored glows and shadows, washes and blobs. A
  gradient may only shift the tone of one neutral (for example `#2b2b2e` to `#232326`).

## 3. Icons

- Every emoji used as an icon or decoration becomes a line icon from one set: the project's
  set, else lucide. Or it goes.
- One size (16px in dense chrome, 20px in roomy chrome) and one stroke (1.5).
- Icons take the color of their text role; they never get their own colors.
- Fixed icon box and gap (8px), so labels align. Remove icons that add nothing; a category
  that needs color gets a small dot.

## 4. Copy

- Headlines say what the product does for whom, with its own nouns. Use facts already on the
  page.
- Titles name the context (the page, the period, the object), not a greeting.
- No exclamation marks. No hype words. Labels are short: "Search", not "Search anything...".
- A change says what it compares with: "+12% vs September", "3 fewer than last week".
- Buttons, labels and headings end without a period; paragraphs keep theirs.
- Mock data looks real: plausible names, amounts and dates for this product.
- Badges such as "New ✨", "PRO", "Beta 🚀" go, unless the product needs them; then they are
  quiet text.
- Claims ("Trusted by 10,000+ teams", "10x faster", five stars) need a source. Ask; if the
  user confirms, make the claim specific and quiet; if not, remove it.

## 5. Type

- One family for the interface. At most one partner: a mono for figures and meta, or a
  display face for large headlines. Keep a family that is part of a real brand; a default
  nobody chose may change to fit the tone.
- Scale: 12, 13, 14, 16, 18, 20, 24, 30, 36, 48, 60 (px). Use 5 to 7 of them on one screen.
- Weights 400 and 500; 600 for rare emphasis. Hierarchy comes from size and color.
- Sentence case. Caps only for real acronyms.
- Letter-spacing: 0 below 20px; slightly negative (-0.01 to -0.02em) only for large display
  text.
- Figures: `font-variant-numeric: tabular-nums`, one format per screen.
- Paragraph width near 65ch.

## 6. Layout

- Keep the sections and their order. Inside a section, alignment and proportion may change.
- Apps keep app proportions: the shell fills the viewport, a sidebar of 240 to 280px, fluid
  content capped near 1440 to 1600px. Never shrink an app into a narrow centered column.
- A landing hero is either a scene (one wide image from the setting with the headline in its
  calm space) or a split (text on one side, the product on the other, the visual at least
  half the width). A fully centered stack is for a short hero with no visual only.
- One primary action and at most one secondary action in a hero.
- Navigation stays quiet: logo, links, one button; "Log in" is a text link.
- The first screen is composed as a whole: no dead band at the bottom.
- On phones everything stacks in reading order, previews get simpler (fewer rows and
  columns), and no text goes below 12px.

## 7. Components and details

- Radius by size: controls 6 to 10px, cards 12 to 16px, panels 16 to 20px. An inner radius
  is the outer radius minus the inset between them (4px at least). Not everything is a pill.
- Every control has hover, active and disabled states inside the palette, and a
  `:focus-visible` style: a 2px outline in the accent with a 2px offset.
- Counts and meta: quiet text (often mono, muted), not glowing pills. Shortcuts: keycaps.
- Stat cards: a label, a figure, a change with its comparison. No sparkline, icon or mini
  chart added to fill them.
- Charts: one main chart, clearly the largest data element; the rest smaller and of a
  different kind (a ranked list, a short table). A muted grid with mono labels. One accent per
  chart on the series that matters; other series in neutral steps.
- Chart types follow the data: trend = line, comparison = bars, share = one stacked bar or a
  list with bars, one goal = a progress bar.
- The logo is the name in the interface family, plus a flat mark if there is one. No gradient
  tile and no sparkle.

## 8. Imagery

- Decorative filler goes: blobs, orbs, nebulas, floating shapes, glowing grids, robots.
- Show the product. Build a preview in code with the project's components and plausible data:
  the main screen, a key card, the result the product produces. In a split hero it sits beside
  the text; in a scene hero it rises from the bottom edge.
- Dashboards and app screens rarely need images: their focus is a chart, a figure or real
  content. Build a physical object (a payment card, a parcel label) in code.
- A generated image is for a landing hero scene, an empty state or onboarding, and only with
  an image tool and the user's yes. Show the prompt first. The image holds no text, matches the
  page background at its edges, and leaves calm space where the headline goes.

## 9. Motion

- Remove loops on things that are not live: pulse, ping, shimmer, breathing glows, floating.
- Remove `transition: all`, `hover:scale` on cards, bouncy springs, moves larger than a few
  pixels.
- Name the properties: color, background-color, border-color, opacity, transform.
- One easing (for example `cubic-bezier(0.2, 0, 0, 1)`), and durations of 120ms for feedback,
  200ms for elements that enter, 160ms for elements that leave.
- At most one entrance on load: a short fade and a rise of 4 to 8px for the main content,
  with a small stagger.
- Respect `prefers-reduced-motion`: turn entrances and tweens off under it.
