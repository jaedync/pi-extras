/**
 * Live repro of finding F4 (formal/subagents-mail/README.md): the cancel
 * mode of repro-f3.mts.
 *   node formal/subagents-mail/repro-f4.mts           # an extension cancels the /compact that stopped main's turn
 *   node formal/subagents-mail/repro-f4.mts control   # /compact while the turn streams: main is reminded
 * Exit 1: main never replies to the note.
 */
process.argv[2] ??= "cancel";
await import("./repro-f3.mts");
