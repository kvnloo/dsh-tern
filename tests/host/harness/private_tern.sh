#!/usr/bin/env bash
# Test-only real Tern acceptance in private headless Sway. Never uses host UI.
set -euo pipefail
umask 077
MODE="${1:-live}"
if [[ "$MODE" != live && "$MODE" != replay ]]; then
  echo "usage: $0 live | replay /absolute/private/sdk.jsonl" >&2
  exit 2
fi
if [[ "$MODE" == replay ]]; then
  [[ -n "${2:-}" && "${2:0:1}" == / && -f "$2" ]] || {
    echo "replay requires existing ABSOLUTE SDK JSONL" >&2
    exit 2
  }
fi
for binary in sway tern pnpm python3 git; do
  command -v "$binary" >/dev/null || {
    echo "missing external prerequisite: $binary" >&2
    exit 2
  }
done
[[ "$(uname -s)" == Linux ]] || { echo "private Sway requires Linux" >&2; exit 2; }
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
BASE="${DSH_TUI_EVIDENCE_DIR:-}"
if [[ -z "$BASE" ]]; then
  BASE="$(mktemp -d "${TMPDIR:-/tmp}/dsh-tsp-native.XXXXXXXX")"
else
  [[ ! -e "$BASE" ]] || {
    echo "evidence target already exists, refusing overwrite: $BASE" >&2
    exit 2
  }
  mkdir -m 700 -p -- "$BASE"
fi
BASE="$(cd "$BASE" && pwd -P)"
chmod 700 "$BASE"
mkdir -m 700 -p "$BASE"/{runtime,home,cache,config,agents,sessions,tern,control,log}
CONTROL="$BASE/runtime/tern-private.sock"
SWAY_PID=""
TERN_PID=""
cleanup() {
  if [[ -n "$TERN_PID" ]]; then kill "$TERN_PID" 2>/dev/null || true; wait "$TERN_PID" 2>/dev/null || true; fi
  if [[ -n "$SWAY_PID" ]]; then kill "$SWAY_PID" 2>/dev/null || true; wait "$SWAY_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

cat > "$BASE/sway.conf" <<'CONF'
xwayland disable
output * resolution 1280x800
default_border pixel 1
focus_follows_mouse no
CONF

# Never inherit provider credentials, host display, user Tern daemon,
# multiplexer sockets, login state, desktop focus or browser profiles.
SAFE_ENV=(
  "PATH=$PATH" "HOME=$BASE/home"
  "XDG_RUNTIME_DIR=$BASE/runtime" "XDG_CACHE_HOME=$BASE/cache"
  "XDG_CONFIG_HOME=$BASE/config" "WLR_BACKENDS=headless"
  "WLR_RENDERER=pixman" "WLR_LIBINPUT_NO_DEVICES=1"
  "LANG=C.UTF-8" "TERM=xterm-256color"
  "DSH_HOME=$BASE/home/dsh" "DSH_AGENTS_HOME=$BASE/agents"
  "DSH_TUI_TEST_STORE=$BASE/sessions"
  "DSH_TELEMETRY_DISABLED=1"
  "DSH_TSP_RECORD=$BASE/log/metadata.jsonl"
  "DSH_TSP_RECORD_FULL=$BASE/log/dsh-sdk-wire.jsonl"
  "TERN_TSP=1"
)

env -i "${SAFE_ENV[@]}" sway --config "$BASE/sway.conf" >"$BASE/log/sway.log" 2>&1 &
SWAY_PID="$!"
FOUND=""
for _ in {1..100}; do
  for socket in "$BASE/runtime"/wayland-*; do
    [[ -S "$socket" ]] && FOUND="$(basename "$socket")" && break
  done
  [[ -n "$FOUND" ]] && break
  kill -0 "$SWAY_PID" 2>/dev/null || {
    echo "private Sway exited; inspect $BASE/log/sway.log" >&2
    exit 1
  }
  sleep 0.05
done
[[ -n "$FOUND" ]] || { echo "private Wayland socket absent" >&2; exit 1; }
SAFE_ENV+=("WAYLAND_DISPLAY=$FOUND")
printf '%s\n' "$FOUND" >"$BASE/control/private-wayland-display"

env -i "${SAFE_ENV[@]}" tern serve --control "$CONTROL" --out "$BASE/tern" \
  >"$BASE/log/tern-serve.log" 2>&1 &
TERN_PID="$!"
for _ in {1..100}; do
  [[ -S "$CONTROL" ]] && break
  kill -0 "$TERN_PID" 2>/dev/null || {
    echo "private Tern serve exited; inspect $BASE/log/tern-serve.log" >&2
    exit 1
  }
  sleep 0.05
done
[[ -S "$CONTROL" ]] || { echo "private Tern control socket absent" >&2; exit 1; }

ctl() {
  local label="$1"
  shift
  local reply
  reply="$(env -i "${SAFE_ENV[@]}" tern ctl --control "$CONTROL" "$@" \
    2>>"$BASE/log/tern-ctl.err")"
  printf '%s\t%s\n' "$label" "$reply" >>"$BASE/control/replies.tsv"
  printf '%s' "$reply" | python3 -c \
    'import json,sys; obj=json.load(sys.stdin); sys.exit(0 if obj.get("ok") is True else 1)' || {
    echo "Tern ctl failed at $label: $reply" >&2
    return 1
  }
  printf '%s\n' "$reply"
}
inspect() {
  local label="$1"
  for command in state tree dump css a11y stats; do
    ctl "$label-$command" "$command" >"$BASE/control/$label-$command.json"
  done
  ctl "$label-shot" shot "$label" >"$BASE/control/$label-shot.json"
}

# Actual shipped profile, real public services, existing keyless LLM fixture.
cat >"$BASE/launch-dsh.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$REPO"
exec pnpm dsh --profile tui --patch "$REPO/apps/cli/tests/profiles/tui/fixtures/cordis.yml"
EOF
chmod 700 "$BASE/launch-dsh.sh"
cat >"$BASE/log-pane.sh" <<EOF
#!/usr/bin/env bash
exec tail -n +1 -f "$BASE/log/tern-serve.log"
EOF
chmod 700 "$BASE/log-pane.sh"

ctl ready ready >/dev/null
ctl log-pane-split split right >/dev/null
ctl log-pane-command run "$BASE/log-pane.sh" >/dev/null
ctl app-pane-focus focus left >/dev/null
if [[ "$MODE" == replay ]]; then
  printf '%s\n' 'REPLAY ONLY: not a live DSH process' > "$BASE/control/mode"
  cp -- "$2" "$BASE/log/replay-source.jsonl"
  chmod 600 "$BASE/log/replay-source.jsonl"
  ctl replay-start surface-play "$BASE/log/replay-source.jsonl" >/dev/null
  ctl replay-settle wait 500 >/dev/null
  inspect replay
else
  printf '%s\n' 'LIVE: shipped dsh --profile tui plus real SDK' > "$BASE/control/mode"
  ctl app-launch run "$BASE/launch-dsh.sh" >/dev/null
  ctl app-start wait 1500 >/dev/null
  inspect live-start
  ctl prompt-alpha type alpha >/dev/null
  ctl alpha-send key Enter >/dev/null
  ctl alpha-settle wait 1200 >/dev/null
  inspect live-alpha
  ctl atomic-prompt commit "atomic fixture" Enter >/dev/null
  ctl atomic-settle wait 1200 >/dev/null
  inspect live-atomic
  ctl fixture-error type "[failure]" >/dev/null
  ctl fixture-error-send key Enter >/dev/null
  ctl error-settle wait 1200 >/dev/null
  inspect live-failure
  ctl viewport-resize resize 1024 768 >/dev/null
  ctl pane-resize resize right >/dev/null
  ctl log-pane-focus focus right >/dev/null
  ctl app-pane-refocus focus left >/dev/null
  inspect live-resize
  ctl rename-live session rename dsh-fixture >/dev/null
  ctl hide-session session new dsh-log >/dev/null
  ctl show-session session switch dsh-fixture >/dev/null
  inspect live-reshow
  # ctl reconnect here proves controller reattach, NOT daemon/PTY restart.
fi
env -i "${SAFE_ENV[@]}" tern --version >"$BASE/control/tern-version"
sha256sum "$(command -v tern)" | cut -d " " -f 1 >"$BASE/control/tern-binary-sha256"
env -i "${SAFE_ENV[@]}" git -C "$REPO" rev-parse HEAD >"$BASE/control/git-sha"
printf '%s\n' "$MODE" >"$BASE/control/evidence-mode"
ctl stop-tern quit >"$BASE/control/quit.json" || true
printf 'private evidence: %s\n' "$BASE"
