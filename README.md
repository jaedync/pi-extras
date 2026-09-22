# Pi Extras

Optional extensions and a theme for [Pi](https://pi.dev): a richer footer,
usage-limit awareness for the agent, activity and timing indicators, background
shell jobs, bounded shell execution, and Kagi subscription search.

## Install

Requires Pi **0.87.0 or newer**, Node **22.18 or newer**, npm and Git.
The shell-job extension currently targets macOS and Linux with a POSIX shell.
Windows process-group behavior has not been validated.

```sh
pi install git:github.com/jaedync/pi-extras
```

Restart Pi after installation. Use `pi config` to select extensions. Installing
adds all six extensions; it makes `quiet` available but does not select it.
Choose the theme using `/settings`. Use only one custom footer at a time.
Phase Spinner wraps an existing editor where possible; other editor extensions
can still conflict.

| Component | Behavior |
| --- | --- |
| Status Plus | Usage/cost grid, context and cache indicators, per-provider limits, optional linked subagent usage |
| Usage Guard | `usage` tool, `/usage` command, one-shot wrap-up warnings for a session budget or, when enabled, near a limit |
| Phase Spinner | Working phases, tokens/sec, time to first token, and elapsed time in the editor border |
| Shell Jobs | `shell_job_start`, `shell_job`, `/jobs`, bounded logs and completion notifications |
| Bash Default Timeout | Adds a 120-second timeout only when a bash call omitted one |
| Kagi Search | Adds `kagi_search` without replacing existing search/fetch tools |
| Quiet | Low-contrast theme with restrained accent colors |

## Updates and removal

```sh
pi update --extensions
# Or update Pi and packages together:
pi update --all
pi remove git:github.com/jaedync/pi-extras
```

An unpinned Git install follows upstream commits. Pi can detect available package
updates, but this package does not install an automatic updater or background
service. To pin a published tag, append `@v0.1.0` to the Git source once that tag
exists. Pinned installs require an explicit installation of a newer tag.
After an update, restart Pi or use `/reload`; stop active jobs before removing
the package. Removing it does not remove your credentials or change other packages.

## Configuration

- `STATUSLINE_TZ`: optional IANA timezone for footer clock/reset labels; defaults
  to the system timezone.
- `STATUS_PLUS_POLL_LIMITS=0`: disable authenticated quota polling while retaining
  recorded usage and response-header limits. `PI_OFFLINE` also suppresses polling.
- `PI_EXTRAS_USAGE_GUARD=1` or `0`: turn band warnings on or off for one run.
  See below for the persistent setting.
- `PI_CODING_AGENT_DIR/pi-extras.json` (default `~/.pi/agent/pi-extras.json`):
  persistent Usage Guard settings under `usageGuard`, written by
  `/usage warnings on|off`. Keys: `enabled` (default `false`), `bands`
  (default `[90, 95]`), `resumeMarginSeconds` (default `300`), `proximityPct`
  (default `10`).
- `PI_BASH_DEFAULT_TIMEOUT`: seconds; `0` or `off` disables the injected timeout.
  Explicit per-call timeouts are preserved.
- `PI_CACHE_RETENTION=long`: use the longer cache-warmth indicator window.
- `PHASE_SPINNER_DEBUG=1`: opt-in local timing diagnostics. Leave off normally.
- `KAGI_TOKEN_FILE`: path to your own subscription session credential. See below.
- `KAGI_TOOL_NAME=web_search`: explicit search-tool replacement. Leave unset to
  keep `kagi_search` and avoid conflicting with another search extension.

See [security and privacy](docs/security.md) before enabling provider-limit polling
or supplying search credentials. Extensions execute with your user permissions.

## Usage Guard

Usage Guard reads the limit snapshots Status Plus polls; it never fetches on its
own except when the `usage` tool is called with `refresh: true`. Only windows that
govern the active model count: provider-wide windows always, model-specific ones
(such as an Anthropic `seven_day_fable` bucket) only when the active model id
carries that family. Balances (Enterprise spend, prepaid credits) and per-minute
rate limits taken from response headers are reported but never warned on.

- `usage` tool: percent used, thresholds, reset time, seconds until reset and
  `resumeAfterSeconds` (reset plus margin) per window. `setBudget` records a
  session budget ("work until 60% of the weekly limit"); `all` includes other
  providers and non-governing windows.
- Warnings are off by default: only a session budget warns, once, when its
  window is reached. `/usage warnings on` adds band warnings (90 and 95 by
  default) and provider blocks. Each fires once per window, threshold and reset
  cycle, at turn end, as a message appended to context (no system-prompt
  change, no cache miss). Resets reported within ten minutes of each other
  count as one cycle, since proxies recompute them on every fetch. The final
  message asks the agent to wrap up and report; a model-scoped window notes
  that other models are unaffected. Fired keys and the budget persist with the
  session, so a resumed session does not repeat them.
- `/usage` queues the current snapshot for the next turn; `/usage budget 7d 60`
  and `/usage budget clear` manage the session budget; `/usage warnings on|off`
  persists the toggle.
- Polling: providers whose window sits within `proximityPct` of a threshold poll
  at their faster cadence; failed polls back off exponentially up to ten minutes.

## Kagi setup

This integration uses a **Kagi subscription session token**, not the paid Search
API. Each user must have their own Kagi account and supply their own credential.
No credential is included, requested in chat, or provisioned by installation.

1. Obtain a session link from your Kagi browser settings.
2. Save it, or just its token, in a private local file using your editor.
3. Restrict that file to your user (`chmod 600 /path/to/your/token-file`).
4. Set `KAGI_TOKEN_FILE` to that path before starting Pi. The default is
   `~/.secrets/kagi_token`.

Never paste a session link or token into a prompt, issue, shell command argument,
repository, or Pi settings. No paid Search API key is needed or accepted as a
substitute. Authentication failures, challenges and rate limits stop requests;
there is no browser bypass or account-login automation. This HTML integration is
unofficial and can break when Kagi changes its pages. Use it in accordance with
Kagi's terms and your subscription.

Search results are bounded and treated as untrusted source text. A five-minute
in-memory cache reduces repeated queries. The client uses a **cooperative I/O deadline**;
**synchronous parsing cannot be interrupted** by that timer. There is a 2 MB
response cap, but pathological HTML can still occupy the event loop.
Without a configured token, the rest of the package loads normally; invoking
`kagi_search` reports a credential error.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:install
npm run audit:package
```

Tests use synthetic credentials and isolated homes, not live accounts. The test
runner bounds each suite to two minutes. The installation smoke test uses Pi's
real package manager and an isolated home; it never starts a model request.
No build step or install lifecycle hook is needed. Pi loads TypeScript directly.
Runtime dependencies are installed by Pi; no global extension npm install is needed.

The default branch is release-ready: merged commits are updates for unpinned
users. See [contributing](CONTRIBUTING.md) and [third-party notices](THIRD_PARTY.md).
