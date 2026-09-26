#!/bin/bash
# Stage one real Pi session for the preview image and capture it as ANSI frames.
# Pi runs every extension from this checkout against fake-anthropic.mjs (scripted
# turns, no model calls) and dictates a `say` recording through the real voice
# daemon. Everything lives in a temporary directory; the real agent dir, voice
# home and tmux server are never touched.
# Needs macOS (say), tmux, ffmpeg, pi, and a provisioned voice model (/voice setup).
# Usage: stage.sh <frames-dir>
set -euo pipefail
FRAMES=$(mkdir -p "$1" && cd "$1" && pwd -P)
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(cd "$HERE/../.." && pwd -P)
VOICE_HOME=${PI_VOICE_HOME:-$HOME/.cache/pi-extras/voice}
# npm run puts node_modules/.bin first, which would stage the dev-dependency Pi instead of the installed one.
PATH=$(printf %s "$PATH" | tr : '\n' | grep -v '/node_modules/\.bin$' | paste -sd : -)
PI=$(command -v pi)
FFMPEG=$(command -v ffmpeg)
PORT=${FAKE_PORT:-3499}
# The voice row names the mic, and the system default is often a personal headset ("Name's AirPods").
MIC=${PREVIEW_MIC:-MacBook Pro Microphone}
COLS=112 ROWS=44
SESSION=pi-extras-preview
SPEECH="Once the suite is green, bump the patch version. [[slnc 700]] Then draft the changelog entry, and keep it short."
PROMPT="run the tests in the background, then give the model name in the footer a bit more room"

# /tmp rather than $TMPDIR keeps the per-user temp path out of the committed frame. -P: the footer
# prints ~ only when the cwd resolves under HOME, and /tmp is a symlink on macOS.
T=$(cd "$(mktemp -d /tmp/pi-extras-demo.XXXXXX)" && pwd -P)
cleanup() {
	tmux -L $SESSION kill-server 2>/dev/null || true
	{ kill "${FAKE:-}" "${DAEMON:-}"; wait; } 2>/dev/null || true
	rm -rf "$T"
}
trap cleanup EXIT

mkdir -p "$T/tmp" "$T/home" "$T/agent/themes" "$T/voice/sessions" "$T/bin"
git clone -q "$REPO" "$T/home/pi-extras"
# The preview shows a release, and releases ship from main, whatever branch this runs on.
git -C "$T/home/pi-extras" checkout -q -B main
ln -s "$REPO/node_modules" "$T/home/pi-extras/node_modules"
cat > "$T/agent/models.json" <<EOF
{ "providers": { "anthropic": { "baseUrl": "http://127.0.0.1:$PORT", "apiKey": "staged", "headers": {} } } }
EOF
# lastChangelogVersion: without it the first start shows Pi's changelog instead of a clean session.
cat > "$T/agent/settings.json" <<EOF
{ "defaultProvider": "anthropic", "defaultModel": "claude-opus-5-5", "defaultThinkingLevel": "high",
  "theme": "quiet", "tuiMode": "fullscreen", "fullscreenScrollbar": "always", "hideThinkingBlock": true,
  "quietStartup": true, "defaultProjectTrust": "always", "lastChangelogVersion": "$("$PI" --version)", "enableInstallTelemetry": false }
EOF
# Likewise for pi-extras' own release notes.
cat > "$T/agent/pi-extras.json" <<EOF
{ "releaseNotes": { "seen": "$(node -p "require('$REPO/package.json').version")" } }
EOF
cp "$REPO/themes/quiet.json" "$T/agent/themes/"
cp "$VOICE_HOME/tiers.json" "$T/voice/"
# A saved mic that is not connected falls back to the system default, and so to its name.
MIC="$MIC" node --input-type=module -e "import { listMics } from '$REPO/lib/voice/mics.ts';
if (!listMics(false).devices.includes(process.env.MIC)) { console.error('mic not connected: ' + process.env.MIC + '; set PREVIEW_MIC'); process.exit(1); }"
node -e 'console.log(JSON.stringify({ mic: process.argv[1] }))' "$MIC" > "$T/voice/settings.json"
# The staged Pi must record the scripted speech, never the real microphone. Voice tries PvRecorder
# before ffmpeg, and PvRecorder opens the mic whenever this terminal may use it. Here it can still
# list devices, so the row names the mic, but it cannot open one, so capture falls back to the shim.
cat > "$T/no-mic.cjs" <<'EOF'
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
	const loaded = load.call(this, request, ...rest);
	if (request !== "@picovoice/pvrecorder-node") return loaded;
	class StagedRecorder extends loaded.PvRecorder {
		start() {
			throw new Error("the preview stage records the scripted speech, not the microphone");
		}
	}
	return { ...loaded, PvRecorder: StagedRecorder };
};
EOF

# The "microphone": 0.6 s of silence, the speech, then a second of silence, streamed in real time.
say -o "$T/speech.aiff" "$SPEECH"
"$FFMPEG" -loglevel error -y -f lavfi -t 0.6 -i anullsrc=r=16000:cl=mono -i "$T/speech.aiff" \
	-filter_complex "[1:a]aresample=16000,pan=mono|c0=c0[s];[0:a][s]concat=n=2:v=0:a=1" -f s16le -ar 16000 -ac 1 "$T/speech.raw"
head -c 960000 /dev/zero >> "$T/speech.raw"
printf '#!/bin/sh\nfor a; do last=$a; done\nexec %s -nostdin -re -f s16le -ar 16000 -ac 1 -i %s/speech.raw -f s16le -loglevel error "$last"\n' \
	"$FFMPEG" "$T" > "$T/bin/ffmpeg"
chmod +x "$T/bin/ffmpeg"

FAKE_PORT=$PORT node "$HERE/fake-anthropic.mjs" > "$T/fake.log" 2>&1 & FAKE=$!
"$VOICE_HOME/env/bin/python" "$REPO/lib/voice/daemon/voice_daemon.py" --home "$T/voice" > "$T/daemon.log" 2>&1 & DAEMON=$!
for _ in $(seq 50); do [ -S "$T/voice/daemon.sock" ] && break; sleep 0.1; done

EXTS=$(node -p "require('$REPO/package.json').pi.extensions.map((e) => '-e $REPO/' + e).join(' ')")
# A private tmux server, so extended-keys can be on without touching the user's tmux.
tmux -L $SESSION -f /dev/null new -d -s $SESSION -x $COLS -y $ROWS -c "$T/home/pi-extras" \
	"tmux set -s extended-keys on; tmux set -g extended-keys-format csi-u; env TMPDIR=$T/tmp HOME=$T/home PATH=$T/bin:$PATH NODE_OPTIONS=--require=$T/no-mic.cjs COLORTERM=truecolor npm_config_update_notifier=false PI_CODING_AGENT_DIR=$T/agent PI_VOICE_HOME=$T/voice $PI -ne $EXTS"

record() {
	local n=0
	while tmux -L $SESSION has-session -t $SESSION 2>/dev/null; do
		tmux -L $SESSION capture-pane -e -p -t $SESSION > "$FRAMES/$(printf %04d $n).ansi" 2>/dev/null || true
		n=$((n + 1)); sleep 0.25
	done
}
sleep 7
record & REC=$!
tmux -L $SESSION send-keys -t $SESSION -l "$PROMPT"
sleep 1.2; tmux -L $SESSION send-keys -t $SESSION Enter
sleep 8; tmux -L $SESSION send-keys -t $SESSION C-Space
sleep 11; tmux -L $SESSION send-keys -t $SESSION C-Space
sleep 12
tmux -L $SESSION kill-server; wait $REC 2>/dev/null || true
echo "staged $(ls "$FRAMES" | wc -l | tr -d ' ') frames"
