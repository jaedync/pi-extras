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

# Pi asks for a restart only when this launcher is its parent; a Pi that a shell job starts inherits the token, not the parent.
PI_EXTRAS_LAUNCHER_PID=$$
export PI_EXTRAS_LAUNCHER_PID

# Sessions read and write this store, also when their XDG_DATA_HOME differs.
PI_EXTRAS_UPDATE_STORE=$STORE
export PI_EXTRAS_UPDATE_STORE

# A lease on the Pi folder that this launcher starts, so GC keeps that
# folder also for a Pi that does not load pi-extras (it writes no lease of
# its own, and its process title "pi" hides its path from the process
# scan). It counts while this shell lives with the start time written in
# it: the same rule as a session lease, and the launcher lives as long as
# its Pi. The EXIT trap removes it; a killed launcher's lease is dead and
# the next GC removes it.
LEASE_DIR="$STORE/leases"
LEASE="$LEASE_DIR/launcher-$$.json"
LEASE_TMP="$LEASE_DIR/.launcher-$$.tmp"

# The start time as lib/auto-update/leases.ts reads it: field 22 of
# /proc/<pid>/stat (counted after the command name in parentheses), or
# `ps -o lstart=` in the C locale, without the spaces around it.
start_time() {
	if [ -r "/proc/$$/stat" ]; then
		sed 's/.*) //' "/proc/$$/stat" | cut -d ' ' -f 20
	else
		LC_ALL=C ps -o lstart= -p "$$" 2>/dev/null | sed 's/^ *//; s/ *$//'
	fi
}

json_text() {
	printf '%s' "$1" | sed 's/[\\"]/\\&/g'
}

# Temp file, then mv: GC never reads half a lease. Only in a store that
# exists: a launcher whose store is gone must not make an empty one. A path
# with a control character gives a file that does not parse, which GC
# removes: that Pi is then not protected, as without this lease.
write_lease() {
	[ -n "$LEASE_START" ] && [ -d "$STORE" ] || return 0
	(
		umask 077
		{ [ -d "$LEASE_DIR" ] || mkdir "$LEASE_DIR"; } &&
			printf '{"pid":%s,"start":"%s","piDir":"%s","releases":[],"mode":"launcher","updatedAt":%s000}\n' "$$" "$(json_text "$LEASE_START")" "$(json_text "$1")" "$(date +%s)" > "$LEASE_TMP" &&
			mv -f "$LEASE_TMP" "$LEASE"
	) 2>/dev/null || rm -f "$LEASE_TMP"
}

# Sets PI (and the lease) before each start. The real folder, not the
# pi-current link: the folder can change between restarts.
pick_pi() {
	real=$(cd -P "$STORE/pi-current" 2>/dev/null && pwd -P)
	if [ -n "$real" ] && [ -x "$real/bin/pi" ]; then
		PI="$real/bin/pi"
		write_lease "$real"
	else
		printf 'pi-extras launcher: %s is missing. Starting %s.\n' "$STORE/pi-current" "$FALLBACK_PI" >&2
		PI=$FALLBACK_PI
		rm -f "$LEASE"
	fi
}

node_bin() {
	if [ -x "$ENABLE_NODE" ]; then printf '%s\n' "$ENABLE_NODE"; else printf '%s\n' node; fi
}

# `pi update` (by hand, or from a pre-launch update hook) only starts a check:
# a detached, low-priority process, so the caller does not wait for installs.
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

LEASE_START=$(start_time)
trap 'rm -f "$LEASE" "$LEASE_TMP"' EXIT
# A TERM or HUP to this shell alone: sh runs the trap once the foreground
# Pi has ended, so the lease stays while Pi runs. Then no restart.
trap 'finish 143' TERM
trap 'finish 129' HUP

REQUEST_DIR="$STORE/restart"
REQUEST=

# Before each Pi start: a new random token. The Pi of this start writes its
# restart request to restart/<token>, so a file left over from an earlier
# start, or one put there by something else, never matches. No file times
# are compared.
new_token() {
	PI_EXTRAS_RESTART_TOKEN=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
	[ -n "$PI_EXTRAS_RESTART_TOKEN" ] || PI_EXTRAS_RESTART_TOKEN="$$-$(date +%s)-$restarts"
	export PI_EXTRAS_RESTART_TOKEN
	REQUEST="$REQUEST_DIR/$PI_EXTRAS_RESTART_TOKEN"
}

# A restart only after a clean exit: a Pi that crashed after it wrote its
# request is not started again, and its exit code passes through.
restart_wanted() {
	[ "$code" -eq 0 ] && [ -f "$REQUEST" ]
}

finish() {
	[ -z "$REQUEST" ] || rm -f "$REQUEST"
	exit "$1"
}

restarts=0
window_start=$(date +%s)
last_target=
same_target=0

new_token
pick_pi
"$PI" "$@"
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
	new_token
	pick_pi
	PI_EXTRAS_UPDATE_DONE=$note "$PI" "$@" --session "$session"
	code=$?
done
finish "$code"
