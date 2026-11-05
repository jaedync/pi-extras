# Decision log

Keep the log in `.untangle/decisions.md`. Write the problems first (step 3).
Then write each fix above the problems that it solves (step 4). Then fill in
the commit and the result as you go (step 5).

## The list of problems

```md
- `ui/LogoutDialog.tsx:30` waits 100ms after closing and hopes the message input can take focus by then.
- `ui/Toolbar.tsx:40` and `ui/Menu.tsx:22` call the same actions, each with its own check for when they are disabled.
- `checkout/submit.ts:9` depends directly on `payments/stripe.ts`.
- `shortcuts/keymap.ts:18` has a switch with one case for each action, separate from the menu's list.
- `ui/CommandPalette.tsx:55` keeps its own list of actions, and it is missing the newer ones.
- `ui/SettingsDialog.tsx:61` sets a global `skipRefocus` flag to stop the logout dialog that it opens from sending focus to the message input.
- `history/undo.ts:30` has a special case for each action that can be undone.
- `refunds/refund.ts:22` wraps each Stripe call in `if (order.provider === "paypal")`.
- Each action handler must call `track()` by hand, and some do not.
- `ui/Toolbar.test.tsx` and `ui/Menu.test.tsx` test the same actions separately.
```

## The same list with the fixes

```md
- Make the general `Dialog` give focus back to the element that had it before it opened, so the wait and the flag can both go.
  - risk: focus order in nested dialogs. guard: new test `Dialog.test.tsx` "nested dialogs restore focus in order".
  - commit: <sha>. result: done; both special cases removed.
  - `ui/LogoutDialog.tsx:30` waits 100ms after closing and hopes the message input can take focus by then.
  - `ui/SettingsDialog.tsx:61` sets a global `skipRefocus` flag to stop the logout dialog that it opens from sending focus to the message input.
- Define a `PaymentProvider` interface that Stripe and PayPal both implement, so checkout and refunds no longer know which one they use.
  - risk: refund amounts for PayPal orders. guard: characterization tests in `refunds/refund.test.ts`, committed first.
  - `checkout/submit.ts:9` depends directly on `payments/stripe.ts`.
  - `refunds/refund.ts:22` wraps each Stripe call in `if (order.provider === "paypal")`.
- Make each user action a command with a name, a handler and an undo, so the toolbar, the menu, the shortcuts, the palette and the undo history all run from one list.
  - `ui/Toolbar.tsx:40` and `ui/Menu.tsx:22` call the same actions, each with its own check for when they are disabled.
  - `shortcuts/keymap.ts:18` has a switch with one case for each action, separate from the menu's list.
  - `ui/CommandPalette.tsx:55` keeps its own list of actions, and it is missing the newer ones.
  - `history/undo.ts:30` has a special case for each action that can be undone.
  - Each action handler must call `track()` by hand, and some do not.
  - `ui/Toolbar.test.tsx` and `ui/Menu.test.tsx` test the same actions separately.
```

## Other sections

Add these below the fixes:

- **Kept special cases:** each special case that the system still needs, with
  the reason.
- **Not fixed:** each problem that you did not fix, with the reason (too
  risky without a test, outside the area, the user's decision).
- **Interface changes, bugs fixed, removed comments, removed tests:** one line
  each. A removed test has its mutation probe.
- **Review rounds:** for each round, the findings, which were confirmed, and
  what changed.
