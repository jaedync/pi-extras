/**
 * Boundary checks for gov_search arguments. The API checks the filter values
 * too, but a local check gives a clear reason without a request, and keeps
 * text that is not a plain value (control characters, very long strings) out
 * of the request body.
 */
import { domainToASCII } from "node:url";
import { errors } from "./errors.ts";

export const COURT_TYPES = [
	"federal-supreme",
	"federal-appellate",
	"federal-district",
	"federal-bankruptcy",
	"federal-special",
	"military",
	"state-supreme",
	"state-appellate",
	"state-trial",
	"state-special",
	"state-attorney-general",
] as const;
export type CourtType = (typeof COURT_TYPES)[number];

export const DEFAULT_K = 10;
export const MAX_K = 100;
export const MAX_QUERY_CHARS = 1000;
const MAX_CITES_CHARS = 200;
const MAX_DOMAIN_CHARS = 253;
const KEYS = ["query", "k", "jurisdiction", "court", "courtType", "cites", "domain"] as const;
const CONTROL = /[\x00-\x1f\x7f]/;

export interface GovFilters {
	jurisdiction?: string;
	court?: string;
	courtType?: CourtType;
	cites?: string;
	domain?: string;
}

export interface GovInput extends GovFilters {
	query: string;
	k: number;
}

function text(value: unknown, name: string, maxChars: number): string {
	if (typeof value !== "string") throw errors.input(`${name} must be a string`);
	const trimmed = value.trim();
	if (!trimmed) throw errors.input(`${name} must not be empty`);
	if (trimmed.length > maxChars) throw errors.input(`${name} is longer than ${maxChars} characters`);
	if (CONTROL.test(trimmed)) throw errors.input(`${name} must not contain control characters`);
	return trimmed;
}

function jurisdiction(value: unknown): string {
	const code = text(value, "jurisdiction", 40).toLowerCase();
	if (!/^us(?:-[a-z]{2})?$/.test(code)) throw errors.input("jurisdiction must be us (federal) or us- plus a two-letter state or territory code, for example us-ca");
	return code;
}

function court(value: unknown): string {
	const id = text(value, "court", 40).toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw errors.input("court must be a CourtListener court id, for example scotus, ca9 or nysd");
	return id;
}

function courtType(value: unknown): CourtType {
	const type = text(value, "courtType", 40).toLowerCase();
	const known = COURT_TYPES.find((entry) => entry === type);
	if (!known) throw errors.input(`courtType must be one of ${COURT_TYPES.join(", ")}`);
	return known;
}

function domain(value: unknown): string {
	const raw = text(value, "domain", MAX_DOMAIN_CHARS).replace(/\.$/, "");
	// domainToASCII parses like a URL host and drops a path, so the characters of one are refused first.
	const ascii = /[\s/\\:?#@%]/.test(raw) ? "" : domainToASCII(raw).toLowerCase();
	const labels = ascii.split(".");
	const valid = ascii.length > 0 && ascii.length <= MAX_DOMAIN_CHARS && labels.length >= 2
		&& labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
		&& /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!);
	if (!valid) throw errors.input("domain must be a site name such as irs.gov, with no scheme or path");
	return ascii;
}

function count(value: unknown): number {
	if (value === undefined) return DEFAULT_K;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_K) throw errors.input(`k must be a whole number from 1 to ${MAX_K}`);
	return value;
}

export function validateInput(input: unknown): GovInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw errors.input("arguments must be an object");
	const value = input as Record<string, unknown>;
	const unknown = Object.keys(value).filter((key) => !(KEYS as readonly string[]).includes(key));
	if (unknown.length) throw errors.input(`unknown field ${unknown.slice(0, 3).map((key) => JSON.stringify(key.slice(0, 40))).join(", ")}`);
	const result: GovInput = { query: text(value.query, "query", MAX_QUERY_CHARS), k: count(value.k) };
	const present = (key: keyof GovFilters) => value[key] !== undefined && value[key] !== null;
	return {
		...result,
		...(present("jurisdiction") ? { jurisdiction: jurisdiction(value.jurisdiction) } : {}),
		...(present("court") ? { court: court(value.court) } : {}),
		...(present("courtType") ? { courtType: courtType(value.courtType) } : {}),
		...(present("cites") ? { cites: text(value.cites, "cites", MAX_CITES_CHARS) } : {}),
		...(present("domain") ? { domain: domain(value.domain) } : {}),
	};
}

/** The JSON body for POST /v2/search/gov: only the fields the API knows, so it never answers 400 for an extra key. */
export function requestBody(input: GovInput): string {
	const body: Record<string, string | number> = { query: input.query, k: input.k };
	for (const key of ["jurisdiction", "court", "courtType", "cites", "domain"] as const) {
		const filter = input[key];
		if (filter !== undefined) body[key] = filter;
	}
	return JSON.stringify(body);
}
