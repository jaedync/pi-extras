# Security and privacy

Pi extensions run with the same filesystem, process and network permissions as
Pi. Review the source before installing. This package adds no telemetry uploader,
remote management service, credential provisioning, or automatic updater.

## Status Plus

The footer reads the active session branch and linked local subagent evidence to
compute totals. Missing evidence remains missing; optional subagent and mesh
extensions are not required. It does not upload those transcripts.

Provider-limit polling can send authenticated requests to:

- `api.anthropic.com` for Anthropic usage, or a quota route derived from your
  configured Anthropic-compatible proxy URL.
- `chatgpt.com` for Codex usage.
- `opencode.ai` for OpenCode Go usage.
- `openrouter.ai` for remaining credits.

Set `STATUS_PLUS_POLL_LIMITS=0` to disable polling. `PI_OFFLINE` also disables it;
recorded usage and response-header limits remain available.

It uses your existing provider authentication. Codex fallback reads only the
configured Pi agent directory's `auth.json` (default `~/.pi/agent/auth.json`),
or the explicit `PI_CODEX_ACCESS_TOKEN` / `PI_CODEX_ACCOUNT_ID` overrides.
Provider endpoints are not guaranteed stable. Missing credentials, unavailable
quotas and provider errors should not prevent Pi from running.

Cost totals are recorded usage or catalog estimates, not authoritative invoices.
TTFT and throughput describe observed request timing, not server-only decoding.
Do not share diagnostic files without reviewing them for personal paths and data.

## Usage Guard

Usage Guard makes no network requests of its own. It reads the snapshots Status
Plus polls; the `usage` tool's `refresh` option asks Status Plus to poll again,
subject to the same `STATUS_PLUS_POLL_LIMITS` and `PI_OFFLINE` switches. It
writes only the `usageGuard` section of `pi-extras.json` in the Pi agent
directory (through `/usage warnings on|off`) and custom entries in the current
session file (fired warning keys and the session budget). Warnings and `/usage`
snapshots are injected into the model's context as ordinary messages, so they
are sent to your provider with the next request like any other conversation
text. They contain window labels, percentages and reset times, not credentials.

## Kagi

Credentials are read locally when a search is requested. Session links are parsed
locally, not fetched. The session cookie is sent only to approved HTTPS Kagi
search URLs; redirect destinations are restricted. No login UI or challenge
bypass is provided. Neither tokens nor raw authenticated pages belong in bug
reports. Tests use synthetic HTML and token values.

A token file should be readable only by its owner. The extension does not change
permissions, rotate credentials, or copy them elsewhere. `KAGI_TOKEN_FILE` is a
path, never the token value. Search queries are sent to Kagi and search results
enter your model context when you invoke the tool. Search results can contain
malicious instructions; they are evidence, not instructions to execute.

## Shell Jobs

Commands execute locally without stdin or a TTY. Jobs use process groups so they
can be cancelled; do not detach again inside a job. Logs live in temporary files
and may contain whatever a command prints, including secrets. Bounded completion
snippets and requested logs enter the conversation. Do not use these tools for
commands that print credentials. `/reload` retains managed jobs; leaving the
session stops them according to the extension lifecycle.

The Bash Default Timeout extension does not sandbox commands. It only supplies
a default timeout for calls that omit one. Explicit timeouts remain unchanged.

## Reporting

Do not open a public issue containing tokens, session links, auth files, raw
session transcripts or private paths. For a sensitive report, first request a
private reporting channel without including the sensitive payload.
