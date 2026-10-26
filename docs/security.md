# Security and privacy

Pi extensions run with the same filesystem, process and network permissions as
Pi. Review the source before installing. This package adds no telemetry uploader,
remote management service or credential provisioning. It does not update
itself unless you turn on [Auto-update](#auto-update). The Pull Link media
tools also update themselves; see [Pull Link](#pull-link). The Pull Link media tools install on the first video
link. Voice installs when Pi finds a microphone.

Saves to `pi-extras.json` keep the file's permissions and write through a
symbolic link to its target. A new `pi-extras.json` gets mode `0600`. A save
never writes over a file that does not parse, so a typo cannot erase the
other settings. Voice's `settings.json` follows the same rules. The Pull Link
media `state.json` is a cache of what is installed, not a settings file. The
tool moves a broken one to `state.json.corrupt-<time>`, logs it in
`provision.log`, and writes a new one after the next install.

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
recorded usage and response-header limits remain available. As in Pi, only
`PI_OFFLINE=1`, `true` or `yes` turns offline mode on.

Status Plus saves the newest poll result for each provider in
`status-plus-limits/<provider>.json` in the Pi agent directory, with mode
`0600`: window percentages, reset times, a budget or credit balance, and when
the last poll was tried. The Pi processes that share the agent directory read
it, so they poll each provider one time between them. It holds no credentials.

It uses your existing provider authentication. Codex fallback reads only the
configured Pi agent directory's `auth.json` (default `~/.pi/agent/auth.json`),
or the explicit `PI_CODEX_ACCESS_TOKEN` / `PI_CODEX_ACCOUNT_ID` overrides.
Provider endpoints are not guaranteed stable. Missing credentials, unavailable
quotas and provider errors should not prevent Pi from running.

If the footer cannot draw a frame, it shows one short line in its place.
The error name and message go to `status-plus.log` in the Pi agent directory.
A proxy's approximate reading can differ by 20 points or more from the last
usage-endpoint reading, more than normal use explains. Then that log also gets
both readings. The line has limit percentages, reset times, ages and the
proxy's status, and no credentials.

Cost totals are recorded usage or catalog estimates, not authoritative invoices.
TTFT and throughput describe observed request timing, not server-only decoding.
Do not share diagnostic files without reviewing them for personal paths and data.

## Tab Status

Tab Status sends state, theme colors, tool names, dialog titles and the first
line of a failed-turn error to the terminal through OSC sequences. Idle says
`Done` by default. `tabStatus.detail: "reply"` opts in to sending the first 80
characters of the latest assistant reply, including replies restored from
history. Control, bidi and invisible formatting characters are stripped, but
ordinary text can still contain sensitive information. iTerm2 surfaces these
details in its tabs, Session Status tool, Cockpit and status-change alerts.
This adds no network request or transcript log. Disable it with
`tabStatus.enabled: false` if that terminal-facing metadata is unsuitable.

## Usage Guard

Usage Guard reads the snapshots Status Plus polls. Two `usage` tool options
ask Status Plus to poll: `refresh` polls again, and `all` polls each scoped
model's provider that has no snapshot yet. The same `STATUS_PLUS_POLL_LIMITS`
and `PI_OFFLINE` switches apply to these polls.

For dollar figures, a `usage` call and `/usage` can send two more requests:

- With `usageDollars.tokenfold` set, it reads the key file and sends the key
  in an `x-api-key` header to `GET <url>/api/ha`. The URL must use `https`, or
  `http` to this machine only.
- When Status Plus has polled OpenRouter credits, it sends Pi's OpenRouter API
  key to `https://openrouter.ai/api/v1/key`.

Both requests refuse redirects and stop after 3 seconds. `PI_OFFLINE=1`,
`true` or `yes` stops both. The answers stay in memory for one minute. The
report's notes never contain a key, the Tokenfold URL or a response body.

Dollar figures also read the Pi session files under
`PI_CODING_AGENT_DIR/sessions` that changed in the last 8 days, subagent
sessions included. They use only the recorded cost, provider, model, time and
ID of each reply, summary and usage entry, and the model changes.

Usage Guard writes these files:

- The `usageGuard` section of `pi-extras.json` in the Pi agent directory,
  through `/usage warnings on|off`.
- Custom entries in the current session file: fired warning keys and the
  session budget.
- `meter-day.json`, `window-readings.json` and `window-sizes-v2.json` in
  `PI_CODING_AGENT_DIR/usage-dollars/`, with mode `0600`, and a `.lock` file
  beside each one while it changes it. They hold dollar amounts, percentages
  and times. Each Status Plus poll can change the first two, not only a
  `usage` call.
- Error lines in `usage-guard.log` in the Pi agent directory.

Warnings and `/usage` snapshots are injected into the model's context as
ordinary messages. So they are sent to your provider with the next request,
like any other conversation text. They contain window labels, percentages,
reset times and, in snapshots, dollar figures. They contain no credentials.
Idle polls update proximity but do not persist a fired warning or queue instructions
for a future model. Delivery checks the active provider/model family at the shared
request-context boundary, including automated wakeups and queued follow-ups. New
notices enter that request immediately and are persisted/displayed at Pi's safe
turn boundary without steering or starting an extra request. The context projection also omits automatic notices
that no longer govern the selected model or whose window has since reset,
including older queued notices, while
preserving raw session history and explicit requested usage snapshots.

## Cache Compaction

**In memory only.** The extension keeps a copy of the session's most recent
request: its transcript and its non-conversation provider fields (system
prompt, tools, reasoning settings and so on). Like Pi's own in-memory context,
this can include private tool output. It is never written to disk or logged.
It also keeps that request's routing headers, minus any whose name looks like
a credential (containing auth, cookie, token, key, secret, credential or
signature). That filter goes by header name only, so it can't guarantee the
remaining values hold nothing sensitive. The copy is replaced on every request
and cleared on compaction, session start, shutdown and reload, tree
navigation, and model or thinking-level changes.

**What it sends.** The summary request goes to the same model and endpoint,
with the same session ID, and Pi resolves its authentication as usual. It
contains the copied request, the replies and tool results since, and the
summary instruction. Tool declarations are kept so the cache matches, but the
instruction forbids tool use, and a reply that calls a tool is discarded
without running it. The extension reads no credential files, changes no
ordinary request, and adds no network destination, telemetry, timer or disk
cache.

**What it saves.** Pi saves the summary, file lists and usage, plus
`details.cachePrefix: true` on prefix-sharing success. The compaction band's
custom session entry also records the chosen path and fallback category when
Tool Display is loaded.

Each decision appends one JSON line to `cache-compaction.log` in the Pi agent
directory. It records time, session ID, provider/model, Pi's compaction reason,
the chosen path, a fixed fallback category and token estimates. Attempted
prefix-sharing responses also record stop reason and input, cache-read,
cache-write and output usage. Unknown estimates are `null`. The file is created
with mode `0600`. Log writes are best effort and never block compaction on an
unwritable file. The log has no message content, summaries, headers, payloads
or provider error text. It is local, is not uploaded and has no automatic
rotation. Remove it when you no longer need the diagnostic history.

**Limits.** Cache hits and expiry can't be guaranteed. Anything uncertain uses
Pi's own compaction. A failed attempt is billed by the provider but not
counted in the session's totals. Turn it off with
`cacheCompaction.enabled: false`. This also turns it off in children, which
always load it even when the parent excludes the extension through a package
filter or loads only `subagents.ts` with `-e`.

## Rate-limit Recovery

Detection reads finalized assistant errors, not credentials. Only structured
rate-limit types are recognized; numeric `retry_after` values are seconds.
Provider prose is not executed, injected, logged or repeated in the normalized
warning. Warnings expose only provider/model identity and reset estimates.

Native Anthropic/OpenAI HTTP adapters also receive a request-local fetch guard.
It inspects only bounded JSON 429 bodies (32 KiB, 500 ms, cancellable), never
changes global fetch or persisted provider settings, and prevents hidden client
retries before finalization. SDK responses retain their body/status with a local
non-retry header. Codex receives only validated type/timing in a structured
exception, not provider prose. Ownership-safe registration preserves dynamic
model configuration and foreign partial updates; shutdown releases the guard.
Unsupported adapters and unrecognized bodies pass through unchanged. Legacy
custom providers keep a fixed API selector so concurrent children cannot
retarget or bypass another extension's stream. Other APIs of that legacy
provider retain their own transport retries, with an internal unsupported-path
warning. Detection still handles recognized finalized errors. Reset timing
requires structured numeric fields; response headers alone are not guessed.

The same fetch guard watches Anthropic subscription streams: only
`anthropic-messages` requests to `api.anthropic.com` Messages with bearer auth
and no API key. It reads SSE event names until the first non-ping event and
passes every byte through unchanged. If only pings arrive for
`anthropicFirstEventSeconds` after the headers, it cancels that response and
fails the turn with a fixed timeout message, which Pi's own retry policy (its
attempt limit and backoff) retries. Credentials are checked for presence only,
never read or logged. After the first event, and for every other request, Pi's
stream handling is unchanged.

Automatic waiting is off by default and limited to interactive main sessions.
It uses cancellable in-process timers, not background shell processes or a
persistent service. The wait budget is at most five hours total per user-started
run, margins included. Reload, replacement and shutdown cancel; no saved timer
is restarted. Clock rollback never refunds an already completed timer; its
resume notice labels elapsed time as a lower bound. Native pi-extras children always load a quota guard that never
hibernates and fail fast on quotas, regardless of inherited settings. Other
noninteractive sessions also never auto-wait for quotas.

Short rate limits (OpenRouter upstream limits and other 429 or rate-limit
errors without a structured reset, excluding quota, billing and usage-limit
wording) use a separate bounded backoff in every session, children included:
jittered 5 to 60 s waits, at most `transientMaxWaitSeconds` (default 180, at
most 900) per streak of consecutive limits. The fetch guard reads only a 429's
`Retry-After`/`Retry-After-Ms` header and hands the number, as a minimum wait,
to the next decision in the same run within 30 s; parallel sessions never see
each other's hints, and a hint from a quota error is discarded. No body or
credential is read for this. The
replacement error names the provider and model, never provider prose, and uses
Pi's non-transient class so Pi's own retry does not also run. Waits are
cancellable in-process timers; the failed attempt is omitted from the retried
context. No extra requests are made beyond the retried one.

Meridian, a local Claude Code proxy, can fail a turn with "Claude Code returned
an error result: Reached maximum number of turns". The same backoff then sends
the turn again after 2, 5 and 10 s, at most 3 times. Other API errors are not
matched. `transientMaxWaitSeconds` does not apply, because Pi never retries this
error. A turn whose tool calls ran is never sent again, so no tool runs twice;
Pi runs no tool call of a failed reply. The replacement error names no model,
so Pi's retry, which reads status codes such as 520 in any text, does not also
run.

The `rateLimitRecovery` section of `pi-extras.json` stores policy. Pause metadata
and the resumed timing message are written to the current session. That message
enters model context before the resumed request and contains elapsed wall time,
UTC timestamps and model identities, not the raw error body. The failed assistant
stays in raw history as a normalized error and is omitted from the retried model
projection so partial tool calls cannot be replayed. Recognized quota failures
use Pi's non-transient classification to prevent two retry owners; ordinary
transient errors are unchanged. A local `rate-limit-recovery.log` in the agent
directory records only internal failure categories, never provider payloads.
There are no extra quota polls or authenticated recovery requests beyond the
resumed model request. Reset estimates are not guarantees of renewed quota.

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

## Gov Search

`gov_search` sends the query and filters to `api.firecrawl.dev` only when the
agent calls it. It is on by default; `govSearch.enabled: false` in
`pi-extras.json`, or `pi config`, turns it off. It reads the key (`FIRECRAWL_API_KEY`, else the file
`~/.secrets/firecrawl_api_key` or the path in `FIRECRAWL_API_KEY_FILE`) at each
search and sends it only in the `Authorization` header. The key is removed from
every error text, also when the API repeats it, and never goes to `details` or
a log. A key with spaces or control characters is refused before a request.
The key file should be readable only by its owner. The tool does not check or
change its permissions, as with the Kagi token file.

With a proxy set (`PI_GOV_SEARCH_PROXY` or `govSearch.proxy`), the search fails
closed: a proxy URL that is not correct, a settings file that does not parse,
or a proxy that is down or refuses stops the search, and no direct request
goes out. Only loopback, private and Tailscale addresses are allowed as the
proxy, and the URL must not hold credentials. TLS runs end to end inside the
tunnel. The proxy sees the host name, not the query or the key. Results enter
the model context as untrusted text; they can contain malicious instructions.

## Pull Link

`pull_link` sends requests when the agent calls it. Auto-pull also sends them
for the links in a message that you type or send through RPC, before the model
starts (up to 5 links for each message). It does not read the messages that
extensions send or the tasks of subagents. Set `linkContext.autoPull` to
`false`, or use `/autopull off`, to send requests only for tool calls.
Auto-pull uses the same checks as the tool, and it does not read local or
private addresses. A video link in a message can install the media tools (see
below). Auto-pulled text goes into the context without a model decision, and
it can contain malicious instructions, as tool results can.

Pull Link reads only public `http` and `https` links and refuses links with credentials. It also refuses
local names, such as `localhost` or `.local` names, and literal private,
loopback, link-local, multicast and reserved addresses. It checks each
redirect in the same way and follows at most 5. It does not resolve DNS for
these requests, so a public name that points to a private address passes. It
sends `GITHUB_TOKEN` or `GH_TOKEN` only to GitHub's API. It refuses a response
body larger than 8 MB. It reuses a result for at most 30 minutes and keeps at
most 16 results in memory. Page text, posts and comments can contain malicious
instructions.

When a page refuses the plain request (HTTP 403, 429 or 503, a bot check, a
timeout or a dropped connection), Pull Link reads it again with a local
headless Chrome or Chromium that is already installed. It does not install a
browser. Set `linkContext.browser` to `false` to turn this off.

- The browser runs the page's scripts, as a normal visit does. The site and
  its ad and analytics services see a visit from your address.
- Each read uses a new temporary profile with no cookies or logins. The tool
  removes the profile after the read.
- The browser sends each request, also each redirect and each script, through
  a proxy on `127.0.0.1` in the tool. The proxy resolves the name and refuses
  private, loopback, link-local and reserved addresses. It connects to the
  address that it checked. WebRTC can use only the proxy.
- The tool stops the browser and all its processes after 30 seconds or when
  the call is cancelled. It keeps at most 8 MB of the page.
- Running as root, the browser starts with `--no-sandbox`, because Chrome
  does not start as root with its sandbox.

The first video link downloads the media tools into
`~/.cache/pi-extras/link-context` (or under `XDG_CACHE_HOME`, or
`PI_LINK_CONTEXT_HOME`) and runs them:

- uv, when the tool finds no recent uv: from `github.com/astral-sh/uv`
  releases, pinned and SHA-256 checked.
- Python 3.12 through uv, and the newest `yt-dlp`, `youtube-transcript-api`,
  `imageio-ffmpeg` and `pillow` from PyPI. The tool does not pin these
  versions. The `bgutil-ytdlp-pot-provider` plugin from PyPI gets the version
  of the token provider below.
- The bgutil token provider: the latest release tag from GitHub's API, a
  `git clone` of that tag, `npm ci --ignore-scripts` and a TypeScript build.
  It runs with the Node that runs Pi.
- For a video without captions, `mlx-whisper` or `faster-whisper` from PyPI.
  On the first transcription, that package downloads its speech model from
  Hugging Face: `mlx-community/whisper-large-v3-turbo` on Apple silicon,
  `Systran/faster-whisper-small` on other hosts, or `linkContext.asrModel`.
  The tool does not pin or check the model. This download does not go through
  the guard proxy.

The tool updates the PyPI packages and the token provider every
`linkContext.refreshDays` days (default 3). It also updates them when a new
pi-extras version changes the package list. With `PI_OFFLINE=1`, `true` or
`yes`, it does not install, update or look up a release. It then uses only
the installed tools. But a speech model that is not in the Hugging Face cache
still downloads on the first transcription, also with `PI_OFFLINE`.

The install steps and the media tools get only a small set of variables. These
are the path, the home folder, the user name and shell, the locale and time
zone, and the temporary and `XDG_` folders. They also get the Hugging Face cache
folders and the proxy and certificate settings. Only the install steps
(`tar`, `uv`, `pip`, `git`, `npm` and the TypeScript build) also get the
`UV_`, `PIP_`, `npm_config_` and `NPM_CONFIG_` settings. yt-dlp, the media
helper and the token provider get no variable whose name contains `TOKEN`,
`PASSWORD`, `AUTH`, `SECRET` or `KEY`.

yt-dlp, its HTTP libraries and ffmpeg send each HTTP request through a guard
proxy on the loopback address. This includes redirects, manifests and
fragments. The proxy resolves each name itself and connects only to the
addresses that it checked. It refuses private, loopback, link-local,
metadata and reserved addresses.

When you set `linkContext.proxy` or a proxy variable, such as `HTTPS_PROXY`,
the guard stays on:

- The guard checks each request in the same way. Then it sends the request
  to your proxy and not to the site. `linkContext.proxy` comes before the
  variables. With `linkContext.proxy`, the tool ignores `NO_PROXY`.
- The variables follow the rules of yt-dlp. HTTPS goes to `HTTPS_PROXY`,
  then `HTTP_PROXY`, then `ALL_PROXY`. Plain HTTP goes to `HTTP_PROXY`, then
  `ALL_PROXY`. A host in `NO_PROXY` gets a direct connection after the check.
- The guard takes the place of your proxy in the settings of yt-dlp, the
  YouTube transcript client and the proxy variables. Then no client can get
  to your proxy without the check.
- Your proxy gets the IP address that the guard checked, not the name. A
  DNS answer that changes after the check cannot send your proxy to a
  private address. The guard tries IPv4 addresses first, because many proxies
  have no IPv6 route. If your proxy cannot get to one address, the guard
  tries the next one.
- An HTTP proxy gets each request in a `CONNECT` tunnel to the IP address,
  also a plain `http` request. Then the site gets its own `Host` header.
- The guard can use `http://`, `https://` (with a verified certificate),
  `socks5://`, `socks5h://`, `socks4://` and `socks4a://` proxies. A proxy
  URL without a scheme is `http://`, and `socks://` is `socks4://`, as in
  yt-dlp. The guard sends the user name and password from the URL to your
  proxy only. It does not write them in a message or a log. For other proxy
  URLs, the tool stops before it sends a request. It never connects without
  the guard.
- When your proxy fails, the request fails with a message that gives the
  host and port of the proxy and the reason.

The guard has these limits with your proxy:

- The guard finds each name with the DNS of this host, also for
  `socks5h://`. DNS lookups do not go through your proxy, and `.onion` names
  do not work. A proxy with rules for names sees only IP addresses.
- The guard cannot see a name that is private only in the network of your
  proxy.
- An HTTP proxy can get only a Basic login.
- Some proxies, such as Squid and tinyproxy with their default rules, refuse
  a `CONNECT` tunnel to port 80. Then the guard sends a plain `http` request
  with the IP address in the request line and keeps the `Host` header. Such a
  proxy makes a new `Host` header from the IP address, so some sites do not
  answer correctly.

These downloader limits apply with or without your proxy:

- The tool downloads media and captions only from `http`, `https` and `data`
  URLs. It refuses other protocols, such as `ftp://`, `rtmp://` or `rtsp://`.
- yt-dlp runs no external downloader except ffmpeg, so not `rtmpdump`,
  `aria2c`, `curl` or `mpv`.
- When ffmpeg downloads media, it reads only HTTP and HTTPS, and the encrypted
  and inline parts of HLS.
- One media download stops at 2 GiB of video or 1 GiB of audio. The tool does
  not download live streams.

The tool writes `state.json` and `provision.log` in the media folder. It keeps
downloads and frames in its `pulls` folder. Each video call removes the
folders that are older than 2 days. yt-dlp gets a copy of the
`linkContext.cookies` file in a private temporary folder. The tool removes
that copy when the media helper stops.

## Voice

Audio is transcribed on your machine and is not sent anywhere. Recordings are
held in memory only for the length of a dictation and are never written to
disk. The transcript is inserted into the editor, not submitted; it reaches
your model provider only if you send it.

Setup downloads, into `PI_VOICE_HOME` (default `~/.cache/pi-extras/voice`):

- uv from `github.com/astral-sh/uv` releases, pinned and SHA-256 checked.
- Python 3.12 through uv, and the `sherpa-onnx` and `numpy` wheels from PyPI.
  The MLX backend adds `parakeet-mlx` and its dependencies.
- Models from the `k2-fsa/sherpa-onnx` GitHub releases and, for MLX,
  `mlx-community/parakeet-tdt-0.6b-v3` on Hugging Face at a pinned revision.
  Every model file is SHA-256 checked before use.

`PI_OFFLINE=1`, `true` or `yes` skips setup; voice then uses only what is
already installed.
Setup starts on its own only when Pi finds a microphone. On Linux, that is an
ALSA capture stream, or a PulseAudio or PipeWire source that is not a monitor.
Pi runs `pactl` only when `PULSE_SERVER` is set or a server socket exists. It
names that server, so `pactl` cannot start a PulseAudio daemon. On macOS, when
Pi runs under a plain `node` binary, a child process lists the input devices.
Pi keeps the `pactl` answer and the macOS result for one day in
`PI_VOICE_HOME`. When Pi finds no microphone, nothing downloads until you start
a dictation or run `/voice setup`.

Sessions talk to the daemon over a Unix socket in `PI_VOICE_HOME` that only your
user can open. The daemon exits when it goes unused or no Pi session is open.
Over SSH on macOS, capture runs as a per-dictation launchd job in your GUI
session that streams audio over another user-only socket; the job is removed
when the dictation ends, and jobs left by a crashed session are cleaned up on
the next start. macOS asks you to allow `ffmpeg` to use the microphone.

Voice writes local logs in `PI_VOICE_HOME`: `provision.log`, `daemon.log` and
`voice.log`. They hold status lines and error messages. They do not record
audio or transcripts.

## Computer Use

Off unless `PI_COMPUTER_USE=on`, and only on macOS. When enabled, the agent can
see and operate the apps you allow: it reads their accessibility trees and
screenshots, and clicks, types and scrolls in them. Screenshots and app text
enter the conversation only when the agent's script emits them, and then reach
your model provider like any other tool output.

Before each start, the codex helper in the ChatGPT app and the Computer Use
client are checked with `codesign`: both must be validly signed by OpenAI (team
`2DC432GLL2`), and the helper must be the `codex` binary the Computer Use service
accepts. The client runs as a child of that helper, outside Codex's sandbox,
because the sandbox stops it from reaching the service. It is a one-shot
launchd job in your desktop session, wired to user-only pipes in a private
temporary directory, and is removed when it exits; jobs left by a crashed
session are removed on the next start. Agent scripts run in a separate V8
context on a worker thread with no Node globals; that is for isolation and
runaway loops, not a security boundary.

The Computer Use service asks before the agent first uses each app, and Pi
answers only with your choice. The dialog defaults to "Don't allow", shows the
service's risk warning, and closes if the call is cancelled; an answer given
after that is ignored. Without a UI, a dismissed dialog or any other kind of
request from the service, the answer is no. Agent scripts cannot reach the
dialog or the answer.

"Always allow" is kept by the service in
`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`,
shared with ChatGPT and Codex computer use. `/computer-use` changes it only
after you confirm, only when it has the exact format the ChatGPT app writes,
and by replacing it atomically; it never changes anything else there.

The apps mode in `/computer-use` applies on top of that file and is read on
every call from `pi-extras.json` in Pi's agent directory. Allow none refuses
every computer use call before the client is contacted. Allow all answers every
app request with yes for the client session only, without asking, even with
no UI, and never writes the approvals file; it needs a confirmation to turn
on. When a session sees that Allow all was turned off, it restarts its client
before the next call, so those session approvals end. Unchecking an app also
restarts the client, ending any approval it held for this session.

This is consent, not containment. Any process running as you, including an
agent with shell access, can edit these files or start the Computer Use client
itself, as it could with ChatGPT's or Codex's own integration. Keep that in
mind before giving an agent both computer use and an unrestricted shell.

## Shell Jobs

Commands execute locally without stdin or a TTY. They use the shell and
environment of Pi's bash tool. That is `shellPath` and `shellCommandPrefix`,
Pi's bin directory first in `PATH`, and the `PI_` session variables of this
session, not of a parent Pi. Jobs use process groups so they
can be cancelled; do not detach again inside a job. When a job's command exits,
the extension stops the processes still in its group. The completion then says
that it stopped them, with their number when `pgrep` can count them. Logs live
in temporary files and may contain whatever a command prints, including
secrets. Bounded completion snippets and requested logs enter the conversation.
Do not use these tools for
commands that print credentials. A job's id, and its log file's name, is made
from its title or command. `/reload` retains managed jobs; leaving the
session stops them according to the extension lifecycle.

The Bash Default Timeout extension does not sandbox commands. It only supplies
a default timeout for bash and powershell calls that omit one. Explicit
timeouts remain unchanged, also an invalid one such as `0`, so Pi reports the
problem. Subagent children apply the same default to their `bash` and
`powershell` calls, also when a package filter turns off the extension for
main.

## Subagents

Children are Pi sessions in the same process, with your permissions. A child
gets the parent's active tools except the names in `childToolsExclude` and
these:

- subagent tools: `subagent`, `message`, `stop_subagent`, `subagents_enable`,
  `bg_wait` and `subagent_supervisor`
- mesh tools: `agent_send`, `agent_request` and `list_peers`
- goal tools: `get_goal`, `create_goal`, `propose_goal_draft`,
  `complete_goal` and `update_goal_progress`
- shell job tools: `shell_job_start` and `shell_job`
- `computer_use`, `windows_use`, `usage`, `codemode` and `tool_search`

A child then gets its own `message` tool, and its own `subagent` and
`stop_subagent` when it may start subagents. A read-only child keeps only
tools that can't change your files or run commands that the model chooses.
These are Pi's `read`, `grep`, `find` and `ls`, and the search and fetch tools
`pull_link`, `kagi_search`, `web_search`, `fetch_content`,
`get_search_content` and `web_fetch`. `pull_link` can install and run its
media tools, and `fetch_content` can clone a repository into a temporary
folder. Every other tool is dropped, also `bash`, `edit`, `write`, `powershell` and unknown
extension and MCP tools. A spawn with `readOnly: true` that lists another tool
in `tools` is refused. Children load the extensions that provide their
tools, Cache Compaction and a quota guard. The guard never hibernates for
quotas; it waits out short rate limits within the bounded backoff described
above. Your context files (`AGENTS.md`), `SYSTEM.md`, `APPEND_SYSTEM.md` and
skills load as they do for the parent. A child started with `cwd` works in that directory instead: its
`AGENTS.md` and relative paths come from there, as when you start Pi there.
That directory's project settings and resources (`.pi/`, such as `shellPath`
and `shellCommandPrefix`) load only as Pi would decide at a start with no one
to ask: nothing there needs trust, you trusted the directory before, or
`defaultProjectTrust` is `"always"`. Otherwise they are not loaded. A worktree
made from a `cwd` takes the trust of the directory it was made from. A child
without a `cwd` follows the parent's trust decision. It loads the project's
`.pi/` settings and resources only when the parent trusts the project. A
worktree child without a `cwd` starts at the top of its worktree. When that
top is not the parent's directory, the child takes the trust of the
repository's top, by the rule for a `cwd`. The
same rule applies to the project's thinking settings for children and to
the project's model guide (`.pi/subagent-models.md`). It also applies to how
the agent inspector shows a chat. A
`cwd` must name an existing directory without control characters; it is
resolved to its real path before use and is never passed to a shell. A
read-only child's subagents can't make a worktree from a `cwd`, because `git worktree add` runs that
repository's hooks. Children use the parent's model credentials. When
`models.json` changed, a child launch reads it into the parent's model list
before it picks the child's model, as `/model` does. First, Pi's own loader
checks the file in a separate model list with no credentials. That list also
gets each provider that an extension registered from a configuration, because
`models.json` can also change those providers. A file with an error is not
read, so a half-saved file can't remove a custom provider of the parent. A
provider that an extension made in code keeps its own definition when the
file has an error for it.

A worktree child's `bash` commands run in an OS sandbox on macOS and on Linux
with `bwrap`. The sandbox stops unintended writes into the parent's checkout.
It is not a boundary against a hostile child. The child can still write
outside the repository, for example `~/.gitconfig`, and it runs with your
permissions.

A child started with `readOnlyShell: true` is read-only and also gets `bash`.
This works on Linux only. Each of its commands runs under bwrap with a
read-only root, an empty private `/tmp`, a new `/dev` and `/proc`, its own
network namespace with only loopback, and its own process and IPC namespaces. A seccomp filter refuses
`socket(AF_UNIX)` and `io_uring_setup`, because a read-only mount does not
stop a connection to a Unix socket: the herdr socket, the Pi broker, the user
D-Bus or a container engine could make other programs write for the child.
The filter refuses all calls of other architectures (x32 and 32-bit), and it
is known only for x86_64 and arm64; on other architectures the spawn is
refused. The filter goes to bwrap through a pipe from the command line, so
no file holds it that another child could change. Limits: the child can read
every file that you can read (as with `read`), it can open for write a FIFO
or a device node that it can see, and a command can still use CPU, memory
and time. macOS has no read-only shell: a sandbox-exec profile that allows by
default leaves Mach and XPC services (`launchctl`, `osascript`, `open`,
`cfprefsd`) that can write for the command. Where no sandbox runs, the spawn
is refused, and a child whose sandbox stops working gets a `bash` that
refuses every command.

Children can't read the sessions and reports of other agents, or main's
session. `read`, `grep`, `find` and `ls` refuse those paths before and after
the call, `edit` and `write` refuse them, and the bash of every child runs
with them hidden (bwrap or sandbox-exec), unless `hideSessions` is false.
Where no sandbox runs, the bash of a child can still read them, and the
parent sees a warning. This keeps an honest child from reading them by
accident. It is not a boundary against a hostile child: a writer child's
bash keeps the host's `/proc`, network and Unix sockets, so it can reach
those files through `/proc/<pid>/root` or through a service (for example
`systemd-run --user` over the user D-Bus). Tools other than these six are
not checked; a tool from another extension that reads local files can read
them.

Main also runs git in a child's worktree: for the report, for the check of
which files a `bash` call changed, and to make a worktree for the child's own
subagent. For these three uses, main gives git the worktree's own git folder
and the repository's shared git folder, and does not follow the worktree's
`.git` file. Main's other git calls in a worktree run only `git rev-parse`,
which follows that file but runs no program.
It also turns off fsmonitor, hooks, automatic gc and submodules. Git then
reads its config only from your own config files and the parent's repository.
The sandbox keeps those read-only, and also the worktree's `config.worktree`.
The report's apply command runs git only in the parent's checkout, on a
snapshot that main wrote. When that checkout is itself a child's worktree, the
command gives git that worktree's verified git folders too. A worktree child
can name a `cwd` for its subagents only inside its own worktree. So main never
makes a worktree in a repository that the child chose. So git in main does not run a program that the child put in the git
data or in its worktree. These are the limits:
- Your own config. A hostile child can write `~/.gitconfig`, and git in main
  then reads it.
- Systems with no sandbox (Windows, or Linux without `bwrap`). There, the
  child can also write the parent's git data.
- The edit guard has the same limit as the sandbox. A command that the child
  leaves running in the background can change a link between the check of an
  `edit` or `write` path and the write.

Child sessions are written under
`PI_CODING_AGENT_DIR/sessions/subagents/<parent session id>/`. An `index.json`
there, readable only by you, stores each child's full task, model settings,
state, session path, run count, `cwd`, checkout path, the names in `after`,
the `check` command and the last check result. A lease stops two Pi processes from driving
the same children, and a lease held under another hostname is never taken
over. `/subagents takeover` ends the owner of a lease only after you confirm,
only for a process of the same user on the same host, and never this Pi
process. It sends SIGTERM and SIGCONT, never SIGKILL, and it opens the
children only after the owner lets the lease go or exits. A `/reload` keeps children running: the new copy of the extension takes
them over in the same process and keeps the lease. When it can't, it
interrupts them. By default, only such an interruption resumes children on its
own, at most one time for each child. A restart or crash only notifies. Orphans, grandchildren,
children whose workspace moved and children whose model is no longer allowed
never resume on their own. A resumed child is told to check files first,
because an interrupted tool may have changed them. Orphan sessions restore
read-only. `subagents.resumePolicy: "notify"` turns automatic resume off.
Restoring only reads transcripts and never rewrites them. The run log,
`PI_CODING_AGENT_DIR/subagents/runs.jsonl`, keeps the first 200 characters of
each task, the model, timings, tool-call counts, usage, the session path and
any error. The file has mode 0600, and a new `subagents` directory has mode
0700. `PI_CODING_AGENT_DIR/subagents/reload.log` gets one line, with no
task text, when a `/reload` could not keep the children or did not take them
over in time. The warnings of that interruption also go there, such as a run
log or index that can't be written. The index also keeps mail to main that a
`/reload` could not hand over, until the next session start posts it. Delete
these files whenever you like. Nothing is sent anywhere except the child's own
model requests.

A forked child's system prompt carries a condensed copy of the conversation:
user and assistant text and one line per tool call, not tool output.

A check is a shell command that Subagents runs for a child when a run of the
child ends normally. Only main, or a child that can run `bash` itself, can set
one. That child must not be read-only and must have `bash` in its tools. A
`message` can set a check only on one of the sender's own subagents. So a
child in a worktree sandbox can't run a command in the directory of another
agent. The check runs through the child's own `bash` tool, in the child's
directory. It uses the `shellPath` and `shellCommandPrefix` that the child's
settings and project trust give, and the child's worktree sandbox. It gets no
stdin. A timeout stops it after 10 minutes, or after `checkTimeoutMinutes`
(60 at most). A timeout, a stop or the end of the session kills its full
process group. The files that it changes count as changes from the child's
`bash` for the edit lock. `index.json` keeps the command, so the next run of
the child runs it again. The last lines of its output go into the report and
the report file, and from there into the context of the parent.

## Tool Display

Tool Display re-registers Pi's built-in `read`, `bash`, `edit`, `write`,
`grep`, `find` and `ls` tools with the definitions Pi itself builds, including
the shell path, command prefix and image settings from your settings files
(project settings only when the project is trusted), and replaces how their
rows are drawn. It sends nothing anywhere. Command text, file contents and tool
output shown in rows are stripped of terminal control sequences before they
are drawn. To show thinking as a live tail, it wraps how Pi's assistant message
component lays out its content; what the model wrote and what is saved in the
session are unchanged.

To draw every other tool's rows, Tool Display replaces three lookups on Pi's
tool row component (`getRenderShell`, `getCallRenderer` and
`getResultRenderer`) for as long as Pi runs, in the terminal UI only. The
tools themselves, what they are sent and what they return are unchanged; only
the renderer that draws a row changes. Other extensions' renderers are still
called, with their own state, to borrow the call line and result lines shown
under the band. When one throws, the row shows the call's arguments and the
result's text instead, stripped of terminal control sequences.
`/tool-display others off` stops this for other extensions' tools.

Folded mode (`/tool-display folded on`, off by default) wraps the render of
Pi's chat container. It finds that container in Pi's layout through a widget
that draws nothing and is removed immediately. Each row still renders; the lines
of folded rows are not drawn, and the rows of an open run are drawn inside a
rule. The figures on a folded line come from Pi's saved messages (token counts
and timestamps). Nothing is sent or saved, and the model's context is
unchanged.

**Chained bash commands are rewritten before they run.** When a command is a
list of steps joined by `&&`, `||`, `;` or newlines, and the shell is `bash`,
`sh`, `zsh`, `dash`, `ksh` or `mksh`, Tool Display runs a rewritten
command in its place so it can time each step:

- It defines two shell functions, `__pi_m` and `__pi_r`, and a variable,
  `__pi_s`, at the start of the command. The steps can see them (for example
  in `set` or `declare -f` output).
- Each step is wrapped in a `{ }` group, not a subshell, so `cd` and variables
  carry over as before. The group prints a marker line before and after the
  step, and restores the exit status so `$?`, `&&` and `||` behave as written.
  The restore cannot cause an exit under `set -e`, also when `set -e` comes from
  Pi's `shellCommandPrefix`. Errexit stops the script only where it would stop it
  without the rewrite.
- Steps joined by `;` stay on one line, and steps on separate lines stay on
  separate lines. Bash skips the rest of a line after an arithmetic error. With
  this rule, the rewritten command skips the same commands.
- A marker line is a record separator byte, `PI:`, a random nonce made for that
  call, and the step number and exit code. Markers are printed to stdout and
  removed from the output before Pi, the model or the row sees it. Only markers
  with the call's own nonce are removed, so a program that prints something
  similar is left alone.

The splitter is conservative. These commands run exactly as written:

- heredocs, `if`, `for`, `while` and `case` blocks, and background `&`
- function definitions, and `exit`, `set` and other commands that depend on the
  shell's own state
- any mention of `PIPESTATUS`, `LINENO`, `BASH_LINENO`, `BASH_COMMAND` or `$_`,
  because the rewrite changes their values
- any mention of `alias` or `eval`
- a pipeline continued on the next line, and a step that ends in a bare backslash
- lists longer than 12 steps

`/tool-display chains off` turns the rewrite off, and
`/tool-display off` or `PI_TOOL_DISPLAY=off` turns off Tool Display entirely.

To show how far a wait has got, Tool Display gives each bash call's shell the
environment variable `PI_EXTRAS_RUN`, a random id made for that call. The
command and its output are unchanged; a program that prints its environment
shows the id. While the call runs, Tool Display reads `/proc` twice a second
for `sleep` processes: their command line, start time and process group, and
for each sleep its environment, to find the id. Only processes of your own user
can be read, and nothing read leaves the process. Background jobs are found by
their process group in the same scan; on macOS, `ps` lists the sleeps, and
foreground calls are not watched because macOS does not show another
process's environment.

Because stdout and stderr arrive through separate pipes, a line of stderr can
be shown under a neighboring step rather than the one that printed it. The output the model
reads is the same either way.

Each chained command's step times, exit codes and last 2,048 characters of output per step
are saved as custom entries in the session file, so a resumed session can show
them. Custom entries are not sent to the model. Tool Display writes the
`toolDisplay` section of `pi-extras.json`, and `/tool-display count` writes
`statusPlus.toolCount`.

**Codemode is not rewritten.** Its numbered call cells observe Pi's nested
execution events in TUI mode and read the active branch's existing `nestedCalls`
metadata. A bounded streaming source preview shows only Pi-decoded draft
arguments, not inferred execution. They never infer execution from JavaScript
or change tool arguments, execution, results or model context. Call durations include queue and permission
waits; overlapping lifetimes are not evidence of parallel execution. Sanitized
live argument/output previews are bounded in memory and cleared on session
start/shutdown. No nested output logs or new persistence are created. Existing
Pi metadata determines what a restored row can show; missing output is labeled
as missing. Live preview truncation is distinct from missing call history;
genuinely incomplete saved metadata remains marked incomplete. `others off` disables adoption for new codemode rows, matching the
rest of Tool Display.

## Copy Blocks

Copy Blocks changes only how replies are drawn; nothing it does reaches the
model or the session file. It writes to the clipboard only when you click a
`copy` label or run `/copy-block`, through Pi's own clipboard helper (the
system clipboard, with OSC 52 to the terminal as well). It writes no files.

## Release Notes

Release Notes reads `CHANGELOG.md` from the installed package and writes the
last version it showed to `releaseNotes.seen` in `pi-extras.json`. When that
file does not parse, it writes nothing and shows a warning instead. The notes
are a custom entry in the session file; they are not sent to the model.

## Auto-update

Auto-update is off until you run `node <pi-extras>/lib/auto-update/cli.ts
enable` in a shell. A session cannot turn it on.

### What it runs

- `npm view`, `npm config get min-release-age` and `git ls-remote --tags`
  to find new versions. npm and git run in the store folder, so the
  `.npmrc` of the project where a session started has no effect.
- `npm install -g --prefix <store folder> --ignore-scripts
  --min-release-age=0` for Pi, the same as `pi update`. The package
  installs keep your `min-release-age`, also for their dependencies.
- `npm install` for an npm package, and `git clone --depth 1` followed by
  `npm install --omit=dev` for a Git package. These run the package's
  install scripts, the same as `pi install` does. A new release of a
  package that you trust runs its code on this machine, and the test step
  runs its extensions. Pin an entry (`npm:name@1.2.3` or `git:...@v1.0.0`)
  to stop updates of that package.
- A test Pi in a temporary home folder, with `PI_OFFLINE=1`. It uses a fake
  model server on `127.0.0.1` and no account. It does not see `auth.json`.
- Each check runs as a separate process with low CPU and disk priority
  (`nice` and, on Linux, `ionice`). A command that runs too long is stopped.
  A check that runs more than 10 minutes stops its commands and ends. The
  next check removes the folder that it did not finish, and the temporary
  folder of its test Pi. The test Pi runs in its own process group, so a
  stop also stops the processes that its extensions start.
  `pi update` through the launcher starts a check the same way and does not
  wait for it.

### Credentials

Auto-update reads no credential file. `npm` and `git` use your own
configuration, so a private package uses your `.npmrc` token or your Git
credential helper. Git runs with `GIT_TERMINAL_PROMPT=0` and SSH in batch
mode, so a check never asks for a password. Error text is cleaned of
tokens and URL passwords before it goes into the log or `state.json`.

### What it changes

- `~/.local/bin/pi`: `enable` replaces the npm link with the launcher
  script. `disable` puts back the link.
- `settings.json`: the `packages` entries that it manages point to folders
  in the store. It changes only those entries and keeps their filters.
  It uses Pi's own lock on the file. `disable` puts back the original
  entries.
- `pi-extras.json`: the `autoUpdate` section.
- `pi-extras-update-undo.json` in the agent directory (mode `0600`): a copy
  of the original `packages` entries and of the old `~/.local/bin/pi`
  link target, so that `disable` works without the store. An original
  entry can hold a token URL, the same as `settings.json`. `disable`
  removes the file.
- The store (`~/.local/share/pi-extras/updates`, mode `0700`): one folder
  for each installed version, made read-only after the install, plus
  `state.json`, `update.log` (at most 256 KB), a lock file, one lease file
  for each running session (process ID, mode, session file path and the
  folders it uses) and for each running launcher (its process ID and the
  Pi folder that it started), restart requests (mode `0600`: the session file path
  and the launch options that a restart repeats) and `pi-managed` (an
  empty file; the launcher reads it).

When auto-update is off, a session creates no store and no lease. It writes
only an error line to `pi-extras.log` in the agent directory if something
fails. The checks stop with `PI_OFFLINE=1`.

The installed folders are read-only. To remove the store by hand, first run
`chmod -R u+w` on it, or use the `gc` command.

### Limits

- A new set must pass a startup test. The test does not run a model turn
  or a tool, so it cannot find a fault that shows only later. Use
  `/pi-extras update rollback` to go back.
- `npm install -g` of Pi writes over the launcher. Run `disable` first.
  The check does not repair the launcher, because the file is outside the
  store. It records the problem, and sessions show a warning.
- A lease names every release folder that the process loaded since it
  started, also after reloads. GC also keeps each folder that
  `settings.json` names. On Linux, GC also keeps a folder that a process
  maps, names in its command line, or has as its working folder. macOS has
  no such process scan: GC keeps only what the sets, the leases and
  `settings.json` name.
- The process scan finds the processes that Pi starts (for example a shell
  command or an MCP server in a release folder), but usually not Pi itself.
  Pi sets its process title to `pi`, so `/proc/<pid>/cmdline` of a Pi
  process shows only `pi` and not the path of its Pi folder. Pi reads its
  JavaScript files and does not map them. Leases protect Pi processes, and
  GC never removes the folders of the current and the previous set.
- The launcher writes a lease for the Pi folder that it starts, before it
  starts Pi and again before each restart. The lease counts while the
  launcher process lives, and the launcher lives as long as its Pi. A
  SIGTERM or SIGHUP to the launcher takes effect after its Pi stops. The
  launcher removes the lease when it stops. If the launcher is killed
  (SIGKILL), GC finds that its process is gone and removes the lease. GC
  also removes restart requests that are older than one day. Thus the launcher
  protects the Pi folder also when Pi does not load pi-extras, for example
  with `--no-extensions`.
- A Pi that you start without the launcher (for example by the full path
  of its store folder) and that does not load pi-extras has no lease. GC
  can remove its Pi folder after two more Pi updates, on Linux and on
  macOS. Package folders that such a Pi uses get the same risk.
- `disable` puts back the Pi and the package versions from before
  `enable`. These can be older than the versions in the store, and older
  versions can have known faults. Run `pi update --all` to get the newest.
- A restart does not repeat `--api-key`, because the restart request is a
  file. Such a session shows a notice instead.
- The restart token goes from the launcher to Pi in the environment. The
  launcher makes a new random token for each start of Pi. Pi removes it
  from its environment at startup, so the tools, MCP servers and shell
  jobs that Pi starts do not get it. This is not a security boundary:
  other processes of the same user can read the start environment of Pi
  in `/proc/<pid>/environ`. The launcher acts on a request only after Pi
  stops with exit code 0, and only on the request file of the token of
  that start.
- The store serves the agent directory that `enable` used. A check with a
  different `PI_CODING_AGENT_DIR` changes no `settings.json`, no marker
  and no `state.json`. It writes the reason only to `update.log`.
- macOS is not fully tested.

## Idle GC

Idle GC sends nothing anywhere and reads no session data. To get V8's
collector function, it turns on V8's `--expose-gc` flag for one moment, creates
one empty `vm` context to read `gc` from, and turns the flag off again, so
`gc` is not added to Pi's global object. When Node already runs with
`--expose-gc`, it uses that `gc` instead. It reads the process's resident size
with `process.memoryUsage.rss()`. Its only file is `idle-gc.log` in the agent
directory, written only when a collection fails. `PI_IDLE_GC=off` turns it off.

## Reporting

Do not open a public issue containing tokens, session links, auth files, raw
session transcripts or private paths. For a sensitive report, first request a
private reporting channel without including the sensitive payload.
