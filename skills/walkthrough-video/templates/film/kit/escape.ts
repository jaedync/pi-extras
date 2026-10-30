/**
 * Escapes text that a scene puts into html(). Storyboard text is data: a "<"
 * in a title must show as a character, not open a tag. Scenes that mount nodes
 * with textContent need none of this.
 */
export function esc(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
