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

## Tool Display

Tool Display re-registers Pi's built-in `read`, `bash`, `edit`, `write`,
`grep`, `find` and `ls` tools with the definitions Pi itself builds, including
the shell path, command prefix and image settings from your settings files
(project settings only when the project is trusted), and replaces how their
rows are drawn. It sends nothing anywhere. Command text, file contents and tool
output shown in rows are stripped of terminal control sequences before they
are drawn.

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

## Release Notes

Release Notes reads `CHANGELOG.md` from the installed package and writes the
last version it showed to `releaseNotes.seen` in `pi-extras.json`. The notes
are a custom entry in the session file; they are not sent to the model.

## Reporting

Do not open a public issue containing tokens, session links, auth files, raw
session transcripts or private paths. For a sensitive report, first request a
private reporting channel without including the sensitive payload.
