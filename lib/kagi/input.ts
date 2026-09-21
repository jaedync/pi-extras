import { domainToASCII } from 'node:url';
import { KagiError } from './errors.js';

export interface SearchInput { query: string; limit?: number; domain?: string }
export interface ValidInput { query: string; limit: number }

const MAX_QUERY_CHARS = 512;
const MAX_DOMAIN_CHARS = 253;

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new KagiError('input');
  return n;
}

function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') throw new KagiError('input');
  const unrooted = value.trim().replace(/\.$/, '');
  const domain = domainToASCII(unrooted).toLowerCase();
  if (!domain || domain.length > MAX_DOMAIN_CHARS) throw new KagiError('input');
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new KagiError('input');
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!)) throw new KagiError('input');
  return domain;
}

export function validateInput(input: unknown): ValidInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new KagiError('input');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['query', 'limit', 'domain'].includes(key))) throw new KagiError('input');
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > MAX_QUERY_CHARS || /[\x00-\x1f\x7f]/.test(value.query)) throw new KagiError('input');
  let query = value.query.trim();
  if (value.domain !== undefined) query += ` site:${normalizeDomain(value.domain)}`;
  return { query, limit: integer(value.limit, 5, 1, 20) };
}
