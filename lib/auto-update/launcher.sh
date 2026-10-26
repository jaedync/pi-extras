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

# A launcher that a Pi child starts (a shell job, a nested pi) begins its
# own count; the outer launcher's values are not for its Pi.
unset PI_EXTRAS_RESTART_COUNT PI_EXTRAS_RESTART_TARGET

PI_EXTRAS_RESTART_TOKEN=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
[ -n "$PI_EXTRAS_RESTART_TOKEN" ] || PI_EXTRAS_RESTART_TOKEN="$$-$(date +%s)"
export PI_EXTRAS_RESTART_TOKEN
# Pi asks for a restart only when this launcher is its parent; a Pi that a shell job starts inherits the token, not the parent.
PI_EXTRAS_LAUNCHER_PID=$$
export PI_EXTRAS_LAUNCHER_PID

# Sessions read and write this store, also when their XDG_DATA_HOME differs.
PI_EXTRAS_UPDATE_STORE=$STORE
export PI_EXTRAS_UPDATE_STORE

# The real folder, not the pi-current link: then /proc/<pid>/cmdline names
# the Pi release that this process runs, and GC keeps it.
pi_bin() {
	real=$(cd -P "$STORE/pi-current" 2>/dev/null && pwd -P)
	if [ -n "$real" ] && [ -x "$real/bin/pi" ]; then
		printf '%s\n' "$real/bin/pi"
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

REQUEST_DIR="$STORE/restart"
REQUEST="$REQUEST_DIR/$PI_EXTRAS_RESTART_TOKEN"
STAMP="$REQUEST_DIR/.$PI_EXTRAS_RESTART_TOKEN.start"

# Before each Pi start: no request from earlier, and a stamp with the start
# time. A request counts only when it is newer than the stamp, so a file
# left over or put there before this Pi started does not restart it. A
# shell whose -nt compares whole seconds is enough: a session asks for a
# restart only after 30 s of quiet.
mark_start() {
	rm -f "$REQUEST"
	# Only in a store that exists: a launcher whose store is gone must not make an empty one.
	(umask 077 && { [ -d "$REQUEST_DIR" ] || mkdir "$REQUEST_DIR"; } && : > "$STAMP") 2>/dev/null || rm -f "$STAMP"
}

# A restart only after a clean exit: a Pi that crashed after it wrote its
# request is not started again, and its exit code passes through.
restart_wanted() {
	[ "$code" -eq 0 ] && [ -f "$REQUEST" ] && [ -f "$STAMP" ] && [ "$REQUEST" -nt "$STAMP" ]
}

finish() {
	rm -f "$REQUEST" "$STAMP"
	exit "$1"
}

restarts=0
window_start=$(date +%s)
last_target=
same_target=0

mark_start
"$(pi_bin)" "$@"
code=$?
while restart_wanted; do
	# Line 1: the session. Line 2: what the new Pi says once it runs (a new
	# session has no file yet to read it from). Line 3: the set it moves to.
	# Then one launch option per line, which the session checked against an
	# allowlist. A read loop with `set --`: nothing in the file is evaluated.
	session=
	note=
	target=
	line_no=0
	set --
	while IFS= read -r line || [ -n "$line" ]; do
		line_no=$((line_no + 1))
		case $line_no in
			1) session=$line ;;
			2) note=$line ;;
			3) target=$line ;;
			*) set -- "$@" "$line" ;;
		esac
	done < "$REQUEST"
	rm -f "$REQUEST"
	[ -n "$session" ] || finish "$code"
	now=$(date +%s)
	if [ $((now - window_start)) -ge "$RESTART_WINDOW_S" ]; then
		window_start=$now
		restarts=0
	fi
	restarts=$((restarts + 1))
	if [ "$restarts" -gt "$MAX_RESTARTS" ]; then
		printf 'pi-extras launcher: Pi restarted %s times in %s s. No more restarts. To continue, run: pi --session %s\n' "$MAX_RESTARTS" "$RESTART_WINDOW_S" "$session" >&2
		finish "$code"
	fi
	# Restarts in a row for one target, however far apart: the session stops
	# trying when it still does not run the target after a few of them.
	if [ "$target" = "$last_target" ]; then same_target=$((same_target + 1)); else same_target=1; fi
	last_target=$target
	PI_EXTRAS_RESTART_COUNT=$same_target
	PI_EXTRAS_RESTART_TARGET=$target
	export PI_EXTRAS_RESTART_COUNT PI_EXTRAS_RESTART_TARGET
	printf '%s\n' "pi-extras launcher: starting Pi again for the update." >&2
	mark_start
	PI_EXTRAS_UPDATE_DONE=$note "$(pi_bin)" "$@" --session "$session"
	code=$?
done
finish "$code"
