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
Idle polls update proximity but do not persist a fired warning or queue instructions
for a future model. Delivery checks the active provider/model family at the shared
request-context boundary, including automated wakeups and queued follow-ups. New
notices enter that request immediately and are persisted/displayed at Pi's safe
turn boundary without steering or starting an extra request. The context projection also omits automatic notices
that no longer govern the selected model or whose window has since reset,
including older queued notices, while
preserving raw session history and explicit requested usage snapshots.

## Cache Compaction

The latest full request transcript and non-conversation provider payload fields
are kept in memory only, never persisted or logged. This can include private tool
output and provider metadata, just like Pi's normal in-memory context. The
conversation body is not retained a second time inside the payload snapshot.
Filtered routing headers stay in memory only. Authorization, cookies, API keys
and token-, key-, secret- or signature-like header names are never captured.
Snapshots are replaced on each request and cleared on compaction, session
start/shutdown/reload, tree navigation, model and thinking-level changes.

Summarization sends the captured transcript, finalized replies/tool results, and
a summary instruction to the same configured model and endpoint with the same
session ID. Manual `/compact`, after-turn threshold and pre-prompt threshold
compactions can use this path; retained unsent input stays out of the summary
request. It does not read credential files or change ordinary requests.
Authentication is resolved by Pi for the summary request. Preserved provider
fields include tool declarations, but the instruction forbids tool use and any summary
with a tool call is rejected without executing it. Errors are reported only as
fixed categories, never provider text or request bodies.

Only summaries, file lists, normal usage and `details.cachePrefix: true` enter
the session file. No new network destination, telemetry, timer or disk cache is
created. Cache hits and expiry cannot be guaranteed. Unsafe, cold or unsupported
requests use Pi's default summarization. Other fallbacks include overflow
recovery,
model/branch/session changes, insufficient context-window space and unusable
replies. A failed prefix attempt spends provider usage before that fallback,
but its usage is not recorded in session totals.
Disable with `cacheCompaction.enabled: false`.

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

`PI_OFFLINE` skips setup; voice then uses only what is already installed.
Nothing downloads on hosts without an audio input.

Sessions talk to the daemon over a Unix socket in `PI_VOICE_HOME` that only your
user can open. The daemon exits when it goes unused or no Pi session is open.
Over SSH on macOS, capture runs as a per-dictation launchd job in your GUI
session that streams audio over another user-only socket; the job is removed
when the dictation ends, and jobs left by a crashed session are cleaned up on
the next start. macOS asks you to allow `ffmpeg` to use the microphone.

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

## Windows Use

Off unless `PI_WINDOWS_USE=on`, and only in WSL. When enabled, the agent can
see and operate every Hyper-V VM on the host that the Windows user can manage:
it reads UI trees and screenshots, types, clicks and runs PowerShell in the
signed-in guest session, and presses keys and clicks on each VM's console,
including on sign-in and UAC screens when a fresh check confirms the console
session. Enhanced/remote sessions receive guest input only; console input,
console sign-in, console UAC and console repair are refused. A locked or
disconnected remote session needs the user to reconnect/unlock it. There is no
per-VM approval: opting in
covers every VM, unless `PI_WINDOWS_USE_VMS` names the only ones the tool may
list or act on. That limit binds the tool, not an agent that also has a shell,
which can run `powershell.exe` itself. Screenshots and guest text enter the conversation only when
the agent's script emits them.

Setting up a VM installs uv and Windows-MCP for the signed-in guest user,
registers a logon task that runs it (also started by a `pi-windows-use` value
under the user's `Run` key, since the task's logon trigger proved unreliable
after restarts), and adds an inbound firewall rule
(`pi-windows-use`) for its TCP port from the local subnet only. The server
requires a bearer key: 32 random bytes generated on the host, kept in
`%LOCALAPPDATA%\pi-extras\windows-use\<vm>.key` for the Windows user, and in
the guest user's `%USERPROFILE%\.windows-mcp\config.toml`. The key is typed
into the guest inside the bootstrap, only after Windows OCR on the host reads
an administrator's PowerShell window on the console (without OCR it is typed
unchecked). When the VM's key-value exchange works, the bootstrap itself goes
over it instead, as `PiWindowsUse-*` items in the guest's
`HKLM\SOFTWARE\Microsoft\Virtual Machine\External`. Every signed-in guest
user can read those items, so they hold the installer without its key. Only
a short stub is typed: the key, the installer's SHA-256 (the stub refuses a
payload that doesn't match), and the code that joins and runs it. The next
setup removes the items. The typed stub shows the key on the console, so the
bootstrap clears the screen and its scrollback before doing anything else. A
stub that refuses its payload clears the screen too, then reports the refusal;
the next setup types the whole installer instead. That setup also installs
the Hyper-V socket relay. The relay is started only through its scheduled
task, which runs at the server's run level, never directly by the elevated
setup shell. PSReadLine is disabled only in this temporary shell before the
sensitive command is typed; the bootstrap also removes matching prior history.
The new key stays in host memory during typing. The active key file is replaced
atomically after the complete command is queued, so interrupted partial typing
leaves the existing server's authentication usable. A failure after queuing can
still have started the install; do not blindly replay it. The key never enters
the conversation. Anyone who holds it and can reach the
guest's port gets the guest user's full PowerShell, so treat other VMs on the
same virtual switch as able to try.

The host's PowerShell scripts run from a copy under
`%LOCALAPPDATA%\pi-extras\windows-use\scripts\<hash>`, because Windows
PowerShell starts them about three seconds slower over `\\wsl.localhost`.
Each version gets its own folder, named for the scripts' content. Before
every start, the copy is compared with the package's files and rewritten if
it differs, which undoes a stale or damaged copy. It doesn't stop a process
running as the same Windows user, which could also change the file between
the check and the start, or read the key beside it. When no copy can be made, the
scripts run from the package's folder, and `/windows-use` says why.

With `PI_WINDOWS_USE_ELEVATED=on` the logon task runs Windows-MCP at its
highest run level: with the administrator rights of a guest user who is an
administrator, without a UAC prompt. Its PowerShell, its input to elevated
windows, and the apps it launches then have those rights, and so does anyone
holding the key. Without the setting, an agent can still get them by
answering a UAC prompt (below), but a stolen key can't.

While it runs, the bootstrap reports its progress to the host through Hyper-V
key-value exchange, as the value `PiWindowsUse` under
`HKLM\SOFTWARE\Microsoft\Virtual Machine\Guest` in the guest. The value holds
a run id and a status line, and on failure the installer's last output lines,
never the key. The host reads it to stop a failed install at once.

Requests to the guest go from the host, without a proxy and without following
redirects, so the key goes only to the guest's address. This remains an IP/TCP
transport, not a VPN-independent PowerShell Direct relay.

Before guest tools run, a read-only PowerShell query compares the server's
session with `WTSGetActiveConsoleSessionId` and reads its WTS connection state.
This detects a desktop moving to enhanced/RDP mode without restarting the
server. A failed/malformed query is not interpreted as an unlocked desktop.
Console actions require fresh confirmation, not a cached console observation.
When the server is unavailable, setup/repair requires a visible console
desktop, and a remembered remote session still blocks that fallback. An
ambiguous lock/sign-in screen gets no keys or clicks. Initial enhanced-session
setup remains unresolved without an authorized guest execution channel; no
guest credentials or password policies are changed by these checks.

Only a freshly confirmed console session can be signed in. The taskbar check
prevents a Sign in click on a desktop, and at most two attempts are made.
`win.login` and `win.setup` do not override session protection. These checks
are observations before actions, not an atomic lock on Windows session moves;
avoid changing session mode or competing for input while the agent runs.

Recovery may restart parts of the guest without asking: Start and its search
(`SearchHost` and `StartMenuExperienceHost`, which Windows starts again on
demand) when they stall a snapshot, and Windows-MCP itself, from the console's
Run box as the signed-in user, when it answers nothing. The Run box is read
with OCR before the restart command is typed; without OCR nothing is typed.
The restart ends and reruns the logon task, which first stops any server
still running: the signed-in user can't stop one that has administrator
rights. A server whose rights don't match `PI_WINDOWS_USE_ELEVATED` is
reinstalled, once per session, only at the console. A rights mismatch in an
enhanced session is reported rather than triggering console repair. Shell UI
restarts and UAC detection are scoped to the server's own Windows session.

`win.console.ocr` runs Windows OCR locally on the host through `ocr.psm1`.
In enhanced mode its source is Windows-MCP's guest-session PNG, sent over the
existing stdio channel without a temporary image file. PNG size/dimensions
are bounded before decoding. OCR points account for downscaling and monitor
origins. Console screenshots use the guest image in that mode too; failures
never substitute a console lock screen. Its text enters the conversation only
when the agent's script emits it. Secure-desktop captures in enhanced mode
require user action in the same VM Connect window.

`win.uac` answers UAC consent prompts with the console keyboard only in a
freshly confirmed console session. It cannot answer an enhanced session's
prompt: the user must do so in VM Connect. At the console it reaches the secure
desktop (the agent could press the same keys through
`win.console.key`). That elevates whatever asked, so treat an agent with
Windows use as able to run anything as an administrator of the guest when its
user is one. It never types credentials.

Agent scripts run in the same isolated V8 context as computer use.

## Shell Jobs

Commands execute locally without stdin or a TTY. Jobs use process groups so they
can be cancelled; do not detach again inside a job. Logs live in temporary files
and may contain whatever a command prints, including secrets. Bounded completion
snippets and requested logs enter the conversation. Do not use these tools for
commands that print credentials. A job's id, and its log file's name, is made
from its title or command. `/reload` retains managed jobs; leaving the
session stops them according to the extension lifecycle.

The Bash Default Timeout extension does not sandbox commands. It only supplies
a default timeout for calls that omit one. Explicit timeouts remain unchanged.

## Subagents

Children are Pi sessions in the same process, with your permissions. A child
gets the parent's active tools except mesh, goal, desktop-control, background
job and subagent tools, and `childToolsExclude`; read-only children lose
`bash`, `edit` and `write`. Only the extensions that provide one of its tools
load into a child, plus a quota guard that never hibernates for quotas; it
waits out short rate limits within the bounded backoff described above. Your context files (`AGENTS.md`) and skills load as they do
for the parent. Children use the parent's model credentials.

Child sessions are written under
`PI_CODING_AGENT_DIR/sessions/subagents/<parent session id>/`. The run log,
`PI_CODING_AGENT_DIR/subagents/runs.jsonl`, keeps the first 200 characters of
each task, the model, timings, tool-call counts, usage, the session path and
any error. Delete either whenever you like. Nothing is sent anywhere except
the child's own model requests.

A forked child's system prompt carries a condensed copy of the conversation:
user and assistant text and one line per tool call, not tool output.

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
- A marker line is a record separator byte, `PI:`, a random nonce made for that
  call, and the step number and exit code. Markers are printed to stdout and
  removed from the output before Pi, the model or the row sees it. Only markers
  with the call's own nonce are removed, so a program that prints something
  similar is left alone.

The splitter is conservative: heredocs, `if`, `for`, `while` and `case`
blocks, background `&`, function definitions, `exit`, `set` and other commands
that depend on the shell's own state, and lists longer than 12 steps run
exactly as written. `/tool-display chains off` turns the rewrite off, and
`/tool-display off` or `PI_TOOL_DISPLAY=off` turns off Tool Display entirely.

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
last version it showed to `releaseNotes.seen` in `pi-extras.json`. The notes
are a custom entry in the session file; they are not sent to the model.

## Reporting

Do not open a public issue containing tokens, session links, auth files, raw
session transcripts or private paths. For a sensitive report, first request a
private reporting channel without including the sensitive payload.
