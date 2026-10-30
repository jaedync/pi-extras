# The fresh review

The reviewer did not do the work, so it sees the screen as a user does. Give it files, not
your opinion of them. With a subagent tool, start a read-only reviewer on a strong model and
paste the prompt below with the paths filled in. Without one, answer the same questions
yourself and write "self-review, not independent" in the report.

## Prompt

```text
You review a redesign of one web screen. You did not do the work. Be specific and strict;
do not praise. Use plain, short sentences.

Files:
- Brief: <path to the brief, or paste it>
- Before: <before/desktop.png>, <before/mobile.png>
- After: <after/desktop.png>, <after/mobile.png>, <after/desktop-redline.png>
- Measured compare: <output of redline compare>
- Code of the after screen: <paths> (read only if a point needs it)

Open every image. Then answer:

1. Template test: swap the product name for a competitor's. Does the after screen still fit
   them? Which elements make it this product's, and which are generic?
2. Brief: does the after follow the tone, setting, focus and mark? Name each place it does
   not.
3. Focal point: where does the eye land first, second, third? Is that the right order for the
   job in the brief?
4. Quiet chrome: does any navigation, button, border or label compete with the focus?
5. Leftover signs: gradients between hues, glows, emoji, tracked caps, shouty or hype copy,
   decorative blobs, looping motion, unsourced claims. Name each one with its location.
6. New problems: anything the redesign broke or made worse (lost content, lost features, a
   changed section order, worse contrast, broken mobile layout, a new trend look such as glass
   or bento).
7. Craft: alignment, spacing rhythm, type scale, radius, figures, chart quality. Name the
   worst three with a fix each, with exact values.
8. Mobile: does the phone layout read in order with nothing cut off or too small?

Output: a list of points, each with a severity (critical, high, medium, low), the location
on the screen, what is wrong and the fix. Critical = content or function lost, or the brief
ignored. High = a clear sign of generated UI left, or a defect a user notices at once. End
with one line: "ship", "ship after the high points", or "redo the direction".
```

## After the review

- Fix every critical and high point, then run the audit and the compare again.
- A point you reject goes in the report with the reason.
- Do not run a second review round unless the first one said "redo the direction".
