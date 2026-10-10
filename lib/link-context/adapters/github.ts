/**
 * GitHub through its REST API: repositories with their README, issues and pull
 * requests with comments, files, directories, commits, releases and gists.
 * `GITHUB_TOKEN` or `GH_TOKEN` raises the anonymous limit of 60 requests an
 * hour; nothing else is read for credentials. Other pages go to the web adapter.
 */
import { get, getJson, PLAIN_UA } from "../http.ts";
import { renderThread, type Reply } from "../post.ts";
import { isoDate, stats } from "../text.ts";
import type { AdapterContext, Pulled } from "../types.ts";

const API = "https://api.github.com";
const MAX_FILE_CHARS = 200_000;
const MAX_PATCH_CHARS = 4_000;

export class NotHandled extends Error {}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
/** Each part of a repository path encoded, so `..` or `?` in a link can never reach another API route. */
const encodePath = (path: string) => path.split("/").filter((part) => part && part !== "." && part !== "..").map(encodeURIComponent).join("/");

function headers(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

interface User { login?: string }
interface Issue { title?: string; body?: string | null; user?: User; created_at?: string; state?: string; comments?: number; html_url?: string; labels?: { name?: string }[]; pull_request?: unknown; reactions?: { total_count?: number } }
interface Comment { body?: string | null; user?: User; created_at?: string; reactions?: { total_count?: number } }
interface Pull { merged?: boolean; additions?: number; deletions?: number; changed_files?: number; head?: { label?: string }; base?: { label?: string } }

function ghFetch(ctx: AdapterContext) {
	const options = { signal: ctx.signal, fetcher: ctx.fetcher, agents: [PLAIN_UA], headers: headers() };
	return {
		json: <T>(path: string) => getJson<T>(`${API}${path}`, options),
		raw: async (path: string) => (await get(`${API}${path}`, { ...options, headers: { ...options.headers, Accept: "application/vnd.github.raw" } })).body,
	};
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);

async function issue(owner: string, repo: string, number: string, ctx: AdapterContext): Promise<Pulled> {
	const gh = ghFetch(ctx);
	const base = `/repos/${owner}/${repo}`;
	const item = await gh.json<Issue>(`${base}/issues/${number}`);
	const isPull = !!item.pull_request;
	const pull = isPull ? await gh.json<Pull>(`${base}/pulls/${number}`).catch(() => undefined) : undefined;
	const facts = [`state: ${pull?.merged ? "merged" : item.state}`];
	if (item.labels?.length) facts.push(`labels: ${item.labels.map((label) => label.name).join(", ")}`);
	if (pull) facts.push(`${pull.head?.label} → ${pull.base?.label}`, `${pull.changed_files} files, +${pull.additions} −${pull.deletions}`);
	const comments = ctx.options.comments > 0 && item.comments ? await gh.json<Comment[]>(`${base}/issues/${number}/comments?per_page=${Math.min(100, ctx.options.comments)}`) : [];
	const replies: Reply[] = comments.map((comment) => ({ post: { author: comment.user?.login ?? "ghost", date: isoDate(comment.created_at), text: comment.body ?? "", stats: stats([["reactions", comment.reactions?.total_count || undefined]]) }, depth: 0 }));
	const post = { author: item.user?.login ?? "ghost", date: isoDate(item.created_at), url: item.html_url, text: `# ${item.title}\n${facts.join(" · ")}\n\n${item.body ?? ""}`, stats: stats([["comments", item.comments]]) };
	return { platform: "github", title: `${owner}/${repo}#${number}: ${item.title}`, url: item.html_url ?? "", markdown: renderThread([], post, replies, undefined, item.comments) };
}

async function repository(owner: string, repo: string, ctx: AdapterContext): Promise<Pulled> {
	const gh = ghFetch(ctx);
	const info = await gh.json<{ full_name?: string; description?: string; stargazers_count?: number; forks_count?: number; language?: string; topics?: string[]; html_url?: string; pushed_at?: string; license?: { spdx_id?: string } }>(`/repos/${owner}/${repo}`);
	const readme = await gh.raw(`/repos/${owner}/${repo}/readme`).catch(() => "");
	const facts = [stats([["stars", info.stargazers_count], ["forks", info.forks_count]]), info.language, info.license?.spdx_id, info.pushed_at ? `last push ${isoDate(info.pushed_at)}` : undefined].filter(Boolean).join(" · ");
	const topics = info.topics?.length ? `\nTopics: ${info.topics.join(", ")}` : "";
	return { platform: "github", title: info.full_name ?? `${owner}/${repo}`, url: info.html_url ?? `https://github.com/${owner}/${repo}`, markdown: `# ${info.full_name}\n${info.description ?? ""}\n${facts}${topics}\n\n## README\n\n${clip(readme, MAX_FILE_CHARS) || "(no README)"}` };
}

async function file(owner: string, repo: string, ref: string, path: string, ctx: AdapterContext): Promise<Pulled> {
	const gh = ghFetch(ctx);
	const body = await gh.raw(`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
	const extension = /\.([\w]+)$/.exec(path)?.[1] ?? "";
	const url = `https://github.com/${owner}/${repo}/blob/${ref}/${path}`;
	return { platform: "github", title: `${owner}/${repo}: ${path}`, url, markdown: `# ${path}\n${owner}/${repo} at ${ref}\n\n\`\`\`\`${extension}\n${clip(body, MAX_FILE_CHARS)}\n\`\`\`\`` };
}

async function directory(owner: string, repo: string, ref: string, path: string, ctx: AdapterContext): Promise<Pulled> {
	const entries = await ghFetch(ctx).json<{ name?: string; type?: string; size?: number }[]>(`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
	const lines = entries.map((entry) => `- ${entry.name}${entry.type === "dir" ? "/" : ` (${entry.size} bytes)`}`);
	return { platform: "github", title: `${owner}/${repo}/${path}`, url: `https://github.com/${owner}/${repo}/tree/${ref}/${path}`, markdown: `# ${owner}/${repo}/${path} at ${ref}\n\n${lines.join("\n")}` };
}

async function commit(owner: string, repo: string, sha: string, ctx: AdapterContext): Promise<Pulled> {
	const data = await ghFetch(ctx).json<{ html_url?: string; commit?: { message?: string; author?: { name?: string; date?: string } }; stats?: { additions?: number; deletions?: number }; files?: { filename?: string; status?: string; patch?: string }[] }>(`/repos/${owner}/${repo}/commits/${sha}`);
	const files = (data.files ?? []).map((f) => `### ${f.status} ${f.filename}\n\n\`\`\`diff\n${clip(f.patch ?? "(binary or too large)", MAX_PATCH_CHARS)}\n\`\`\``);
	const head = `# Commit ${sha.slice(0, 12)}\n${data.commit?.author?.name} · ${isoDate(data.commit?.author?.date)} · +${data.stats?.additions} −${data.stats?.deletions}\n\n${data.commit?.message ?? ""}`;
	return { platform: "github", title: `${owner}/${repo}@${sha.slice(0, 12)}`, url: data.html_url ?? "", markdown: [head, ...files].join("\n\n") };
}

async function release(owner: string, repo: string, tag: string, ctx: AdapterContext): Promise<Pulled> {
	const data = await ghFetch(ctx).json<{ name?: string; tag_name?: string; body?: string; published_at?: string; html_url?: string; author?: User }>(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
	return { platform: "github", title: `${owner}/${repo} ${data.name || data.tag_name}`, url: data.html_url ?? "", markdown: `# ${data.name || data.tag_name}\n${owner}/${repo} · ${data.author?.login} · ${isoDate(data.published_at)}\n\n${data.body ?? ""}` };
}

export async function pullGist(id: string, ctx: AdapterContext): Promise<Pulled> {
	if (!/^[0-9a-f]{6,64}$/i.test(id)) throw new NotHandled();
	const data = await ghFetch(ctx).json<{ description?: string; html_url?: string; owner?: User; files?: Record<string, { filename?: string; language?: string; content?: string; truncated?: boolean }> }>(`/gists/${id}`);
	const files = Object.values(data.files ?? {}).map((f) => `## ${f.filename}\n\n\`\`\`\`${(f.language ?? "").toLowerCase()}\n${clip(f.content ?? "", MAX_FILE_CHARS)}\n\`\`\`\``);
	return { platform: "github", title: `Gist ${data.description || id}`, url: data.html_url ?? "", markdown: `# ${data.description || "Gist"}\nby ${data.owner?.login ?? "anonymous"}\n\n${files.join("\n\n")}` };
}

export async function pullGithub(owner: string, repo: string, rest: readonly string[], ctx: AdapterContext): Promise<Pulled> {
	const [section, a, ...more] = rest;
	if (!NAME.test(owner) || !NAME.test(repo) || /^\.{1,2}$/.test(owner) || /^\.{1,2}$/.test(repo)) throw new NotHandled();
	if (!section) return repository(owner, repo, ctx);
	if ((section === "issues" || section === "pull") && a && /^\d+$/.test(a)) return issue(owner, repo, a, ctx);
	if (section === "blob" && a && more.length) return file(owner, repo, a, more.join("/"), ctx);
	if (section === "tree" && a) return directory(owner, repo, a, more.join("/"), ctx);
	if (section === "commit" && a && /^[0-9a-f]{7,40}$/i.test(a)) return commit(owner, repo, a, ctx);
	if (section === "releases" && a === "tag" && more[0]) return release(owner, repo, more.join("/"), ctx);
	throw new NotHandled();
}
