#!/bin/sh
# pi-extras auto-update launcher v1
#
# `node <pi-extras>/lib/auto-update/cli.ts enable` installs this file as
# ~/.local/bin/pi. It runs Pi from the auto-update store, starts Pi again
# when a session asks for a restart (to move to a new Pi version), and turns
# `pi update` into an update check. Remove it with the `disable` command.
STORE='@STORE@'
FALLBACK_PI='@FALLBACK_PI@'
FALLBACK_EXTRAS='@FALLBACK_EXTRAS@'
ENABLE_NODE='@NODE@'

MAX_RESTARTS=3
RESTART_WINDOW_S=60

# Ctrl+C goes to Pi (the foreground process group) and must not end this
# loop. A trap with a command, not an ignored signal: children would
# inherit an ignored signal.
trap ':' INT

PI_EXTRAS_RESTART_TOKEN=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
[ -n "$PI_EXTRAS_RESTART_TOKEN" ] || PI_EXTRAS_RESTART_TOKEN="$$-$(date +%s)"
export PI_EXTRAS_RESTART_TOKEN
# Pi asks for a restart only when this launcher is its parent; a Pi that a shell job starts inherits the token, not the parent.
PI_EXTRAS_LAUNCHER_PID=$$
export PI_EXTRAS_LAUNCHER_PID

pi_bin() {
	if [ -x "$STORE/pi-current/bin/pi" ]; then
		printf '%s\n' "$STORE/pi-current/bin/pi"
	else
		printf 'pi-extras launcher: %s is missing. Starting %s.\n' "$STORE/pi-current" "$FALLBACK_PI" >&2
		printf '%s\n' "$FALLBACK_PI"
	fi
}

node_bin() {
	if [ -x "$ENABLE_NODE" ]; then printf '%s\n' "$ENABLE_NODE"; else printf '%s\n' node; fi
}

# `pi update` (Dotfleet runs it before each launch) only starts a check: a
# detached, low-priority process, so the launch does not wait for installs.
if [ "${1-}" = "update" ]; then
	EXTRAS="$STORE/extras-current"
	[ -f "$EXTRAS/lib/auto-update/cli.ts" ] || EXTRAS="$FALLBACK_EXTRAS"
	set -- "$(node_bin)" "$EXTRAS/lib/auto-update/cli.ts" check --force
	command -v nice >/dev/null 2>&1 && set -- nice -n 10 "$@"
	command -v ionice >/dev/null 2>&1 && set -- ionice -c3 "$@"
	command -v setsid >/dev/null 2>&1 && set -- setsid "$@"
	"$@" </dev/null >/dev/null 2>&1 &
	printf '%s\n' "pi-extras: Pi and its packages update automatically. An update check started in the background. Use /pi-extras update in Pi to see the result." >&2
	exit 0
fi

# While auto-update manages Pi, Pi's own "New version ... Run pi update"
# banner is noise. The cycle keeps this marker in step with `pi` in the config.
if [ -e "$STORE/pi-managed" ]; then
	PI_SKIP_VERSION_CHECK=1
	export PI_SKIP_VERSION_CHECK
fi

REQUEST="$STORE/restart/$PI_EXTRAS_RESTART_TOKEN"
restarts=0
window_start=$(date +%s)

"$(pi_bin)" "$@"
code=$?
while [ -f "$REQUEST" ]; do
	session=$(sed -n 1p "$REQUEST")
	# What the new Pi says once it runs: a new session has no file yet to read it from.
	note=$(sed -n 2p "$REQUEST")
	rm -f "$REQUEST"
	[ -n "$session" ] || exit "$code"
	now=$(date +%s)
	if [ $((now - window_start)) -ge "$RESTART_WINDOW_S" ]; then
		window_start=$now
		restarts=0
	fi
	restarts=$((restarts + 1))
	if [ "$restarts" -gt "$MAX_RESTARTS" ]; then
		printf 'pi-extras launcher: Pi restarted %s times in %s s. No more restarts. To continue, run: pi --session %s\n' "$MAX_RESTARTS" "$RESTART_WINDOW_S" "$session" >&2
		exit "$code"
	fi
	printf '%s\n' "pi-extras launcher: starting Pi again for the update." >&2
	PI_EXTRAS_UPDATE_DONE=$note "$(pi_bin)" --session "$session"
	code=$?
done
exit "$code"
