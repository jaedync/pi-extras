/**
 * Quoting for the one kind of shell text that wv prints: a command that the
 * user runs by hand. Single quotes protect every character except the quote
 * itself, which is written as '\'' (close, escape, reopen).
 */

/**
 * Quotes one argument for a POSIX shell.
 * @param {string} value
 */
export function quoteArg(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}
