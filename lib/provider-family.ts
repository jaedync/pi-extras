/**
 * Provider families. Pi tells apart provider ids that reach one plan (the
 * Anthropic API login, the Claude Code CLI and a Claude Code proxy; the Codex
 * login and Sign in with ChatGPT), but pi-extras treats each such group as
 * one provider: one limit reading, one poll, one footer row. Every family
 * decision in the repo goes through this table. Pi-level decisions (the model
 * reference sent to Pi, a credential lookup, `/login` hints) keep the real id.
 */

/** Family id first: it names the shared limit poll, its file and the footer row. */
const FAMILIES: readonly (readonly string[])[] = [
	["anthropic", "claude-code", "meridian"],
	["openai-codex", "openai"],
];

const FAMILY_OF: ReadonlyMap<string, string> = new Map(FAMILIES.flatMap((members) => members.map((id) => [id, members[0]!] as const)));

/** The family a provider id belongs to; any id the table does not list is its own family. */
export function providerFamily(provider: string): string;
export function providerFamily(provider: string | undefined): string | undefined;
export function providerFamily(provider: string | undefined): string | undefined {
	return provider === undefined ? undefined : FAMILY_OF.get(provider) ?? provider;
}

/** The provider ids of a family, its own id first. */
export function familyMembers(family: string): string[] {
	return [...(FAMILIES.find((members) => members[0] === family) ?? [family])];
}

/** True when both ids are set and belong to one family. */
export const sameFamily = (left: string | undefined, right: string | undefined): boolean =>
	left !== undefined && right !== undefined && providerFamily(left) === providerFamily(right);

/** True for the id that names a family of several providers (`anthropic`, `openai-codex`). */
export const isFamilyId = (id: string): boolean => FAMILIES.some((members) => members[0] === id);
