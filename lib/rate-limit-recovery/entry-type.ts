/**
 * The custom entry and message type of rate-limit recovery, in a module of its own.
 * The controller writes the main session's entries and messages with it, and the
 * inline child guard writes the subagent's entries. A child that imported the
 * controller for this string would load the whole controller into every child.
 */
export const RECOVERY_TYPE = "rate-limit-recovery";
