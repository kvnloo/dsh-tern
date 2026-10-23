#!/usr/bin/env bash
# Private real-Tern dogfood. No user compositor, daemon, credentials or input.
set -euo pipefail
umask 077
usage() {
  cat >&2 <<'USAGE'
usage: private_tern.sh live | startup | replay /ABSOLUTE/private/sdk.jsonl
  live     canonical keyless alpha/beta/failure Session + normal /quit
  startup  actual empty-workspace TSP q/r/inline/frame/ACK, no user prompt
  replay   REPLAY ONLY through Tern surface-play; never starts DSH
Trusted explicit overrides (all executables must be absolute):
  DSH_TUI_EVIDENCE_DIR          new absolute owner-only output directory
  DSH_TUI_TERN_BIN              executable Tern CLI
  DSH_TUI_SWAY_BIN              executable Sway
  DSH_TUI_SWAY_LIBRARY_PATH     absolute wlroots/Sway library directory
  DSH_TUI_LAUNCHER              executable full DSH launcher, e.g. approved
                                SSH -T/PTy relay to an MBP built keyless CLI
  DSH_TUI_LAUNCHER_LOCATION     local|remote
  DSH_TUI_LAUNCHER_SOURCE_SHA   attested 40-hex DSH source head
  DSH_TUI_LAUNCHER_ARTIFACT_SHA256  attested 64-hex launcher/build SHA256
  DSH_TUI_LAUNCHER_PROVENANCE   nonempty origin/SSH/build description

Without an override, requires prebuilt apps/cli/lib/bin.js and node_modules.
No install/build/flock on groot. A remote wrapper must itself launch the
real keyless profile with its remote fixture path, and its inaccessible DSH
Session/SDK files will be EXPLICITLY UNCOLLECTED, not local live proof.
A live or startup run never calls feed/commit as native send evidence.
USAGE
}
MODE="${1:-}"
case "$MODE" in
 live|startup) [[ $# -eq 1 ]] || { usage; exit 2; };;
 replay) [[ $# -eq 2 && "$2" = /* && -f "$2" && ! -L "$2" ]] ||
   { usage; exit 2; };;
 --help|-h) usage; exit 0;;
 *) usage; exit 2;;
esac
[[ "$(uname -s)" == Linux ]] || { echo "headless Sway requires Linux" >&2; exit 2; }
for binary in python3 git node sha256sum swaymsg; do
  command -v "$binary" >/dev/null || { echo "missing prerequisite: $binary" >&2; exit 2; }
done
SWAY="${DSH_TUI_SWAY_BIN:-$(command -v sway || :)}"
TERN="${DSH_TUI_TERN_BIN:-$(command -v tern || :)}"
for bin in "$SWAY" "$TERN"; do
  [[ "$bin" = /* && -x "$bin" ]] ||
    { echo "qualify the exact Sway/Tern executable path" >&2; exit 2; }
done
if [[ -n "${DSH_TUI_SWAY_LIBRARY_PATH:-}" ]]; then
  [[ "$DSH_TUI_SWAY_LIBRARY_PATH" = /* && -d "$DSH_TUI_SWAY_LIBRARY_PATH" ]] ||
    { echo "Sway library path must be a real absolute directory" >&2; exit 2; }
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
SOURCE_SHA="$(git -C "$REPO" rev-parse HEAD)"
LAUNCHER="${DSH_TUI_LAUNCHER:-}"
if [[ "$MODE" == replay && -n "$LAUNCHER" ]]; then
  echo "replay never runs a DSH launcher; remove DSH_TUI_LAUNCHER" >&2
  exit 2
fi
if [[ -z "$LAUNCHER" ]]; then
  CLI="$REPO/apps/cli/lib/bin.js"
  LOCATION=local
  HASH_ORIGIN=measured-locally
  if [[ "$MODE" == replay ]]; then
    HASH="$(sha256sum "$SCRIPT_DIR/private_tern.sh" | cut -d' ' -f1)"
    PROVENANCE="REPLAY ONLY: harness script hash; no DSH CLI used or attested"
  else
    [[ -f "$CLI" && -d "$REPO/node_modules" ]] ||
      { echo "local built/source prerequisites absent: $CLI and node_modules" >&2; exit 2; }
    # A CLI file hash alone cannot bind a binary to the current Git head.
    # The complete root build writes a source/version/client-artifact record
    # only after build:lib finishes. Refuse a missing or stale build record.
    node --input-type=module - "$REPO" "$SOURCE_SHA" "$CLI" <<'JS'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [root, head, cli] = process.argv.slice(2)
const { readClientBuildRecord } = await import(pathToFileURL(join(root, 'scripts/client-build-environment.ts')).href)
const record = readClientBuildRecord(root)
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (record.environment.DSH_CLIENT_COMMIT_HASH !== head.slice(0, 7)
    || record.environment.DSH_CLIENT_VERSION !== version
    || record.environment.DSH_CLIENT_GIT_DIRTY === 'true'
    || statSync(cli).mtimeMs > statSync(join(root, '.dsh-build/client-build-environment.json')).mtimeMs) {
  throw new Error('local CLI build record is stale or inconsistent with source/build')
}
JS
    HASH="$(sha256sum "$CLI" | cut -d' ' -f1)"
    PROVENANCE="measured CLI hash; complete root build record checked against commit, version and client artifact hashes"
  fi
else
  [[ "$LAUNCHER" = /* && -x "$LAUNCHER" ]] ||
    { echo "trusted launcher must be an absolute executable" >&2; exit 2; }
  LOCATION="${DSH_TUI_LAUNCHER_LOCATION:-}"
  SOURCE_SHA="${DSH_TUI_LAUNCHER_SOURCE_SHA:-}"
  HASH="${DSH_TUI_LAUNCHER_ARTIFACT_SHA256:-}"
  PROVENANCE="${DSH_TUI_LAUNCHER_PROVENANCE:-}"
  [[ "$LOCATION" == local || "$LOCATION" == remote ]] ||
    { echo "declare launcher location local|remote" >&2; exit 2; }
  [[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ && "$HASH" =~ ^[a-f0-9]{64}$ && -n "$PROVENANCE" ]] ||
    { echo "explicit launcher source SHA, build SHA256, provenance required" >&2; exit 2; }
  if [[ "$LOCATION" == local ]]; then
    [[ "$SOURCE_SHA" == "$(git -C "$REPO" rev-parse HEAD)" &&
       "$HASH" == "$(sha256sum "$LAUNCHER" | cut -d' ' -f1)" ]] ||
      { echo "local override hash/source not measured on this checkout" >&2; exit 2; }
    HASH_ORIGIN=measured-locally
  else
    HASH_ORIGIN=declared-remote
  fi
fi
BASE="${DSH_TUI_EVIDENCE_DIR:-}"
if [[ -n "$BASE" ]]; then
  [[ "$BASE" = /* && ! -e "$BASE" && ! -L "$BASE" ]] ||
    { echo "evidence path must be new and absolute" >&2; exit 2; }
  mkdir -m 700 -- "$BASE"
else
  BASE="$(mktemp -d "${TMPDIR:-/tmp}/dsh-tsp-native.XXXXXXXX")"
fi
BASE="$(cd "$BASE" && pwd -P)"
mkdir -m 700 -- "$BASE"/{runtime,home,cache,config,agents,sessions,tern,control,log,workspace}
WORKSPACE="$BASE/workspace"
SWAY_PID=""
TERN_PID=""
SWAY_START=""
TERN_START=""
process_start() {
  python3 - "$1" <<'PY'
import sys
try:
 with open("/proc/"+sys.argv[1]+"/stat",encoding="utf-8") as stream:
  print(stream.read().rsplit(")",1)[1].split()[19])
except (OSError,IndexError):
 pass
PY
}
terminate_owned() {
  local pid="$1" start="$2"
  [[ -n "$pid" ]] || return 0
  if [[ -n "$start" ]]; then
    # A pidfd pins process identity; never kill a recycled numeric PID.
    python3 - "$pid" "$start" <<'PY'
import os,signal,sys
pid=int(sys.argv[1]); expected=sys.argv[2]
try:
 fd=os.pidfd_open(pid)
except (OSError,AttributeError):
 sys.exit(0)
try:
 try:
  with open(f"/proc/{pid}/stat",encoding="utf-8") as stream:
   actual=stream.read().rsplit(")",1)[1].split()[19]
  if actual==expected:
   signal.pidfd_send_signal(fd,signal.SIGTERM)
 except (OSError,IndexError,AttributeError,ProcessLookupError):
  pass
finally:
 os.close(fd)
PY
  fi
  wait "$pid" 2>/dev/null || :
}
cleanup() {
  terminate_owned "$TERN_PID" "$TERN_START"
  terminate_owned "$SWAY_PID" "$SWAY_START"
}
trap cleanup EXIT
printf '%s\n' "$SOURCE_SHA" >"$BASE/control/git-sha"
"$TERN" --version >"$BASE/control/tern-version"
sha256sum "$TERN" | cut -d' ' -f1 >"$BASE/control/tern-binary-sha256"
if [[ "$MODE" == replay ]]; then
 EVIDENCE_MODE=replay; SCOPE=replay-only
else
 EVIDENCE_MODE=live; SCOPE=$([[ "$MODE" == startup ]] && echo startup-no-prompt || echo live-functional)
fi
printf '%s\n' "$EVIDENCE_MODE" >"$BASE/control/evidence-mode"
printf '%s\n' "$MODE" >"$BASE/control/mode"
python3 - "$BASE" "$SOURCE_SHA" "$HASH" "$LOCATION" "$HASH_ORIGIN" "$PROVENANCE" "$SCOPE" "$MODE" <<'PY'
import json,os,stat,sys,uuid
from pathlib import Path
base,source,artifact,location,origin,provenance,scope,mode=sys.argv[1:]
ctl=Path(base)/"control"
# Local startup metadata is measured before launch, not inferred from Git.
workspace=Path(base)/"workspace"
sessions=Path(base)/"sessions"
if location=="local" and mode!="replay":
 for folder in (workspace,sessions):
  info=folder.lstat()
  if (not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or
      info.st_mode & 0o077 or any(folder.iterdir())):
   raise SystemExit("local starting workspace/Session store is not empty and owner-only")
workspace_start=({"empty":True,"prior_events":0} if location=="local" and mode!="replay"
                 else {"empty":False,"prior_events":0 if location=="local" else None})
(ctl/"launcher.json").write_text(json.dumps(dict(
 source_sha=source,artifact_sha256=artifact,location=location,
 hash_origin=origin,provenance=provenance),indent=2)+"\n")
(ctl/"capture.json").write_text(json.dumps(dict(
 capture_id=str(uuid.uuid4()),scope=scope,
 model_id=("not-invoked-replay" if mode=="replay" else
           "tui-fixture/deterministic" if location=="local" else "remote-model-unverified"),
 workspace_start=workspace_start,
 collector="local-process" if location=="local" else "remote-uncollected",
 wire_file=("log/replay-source.jsonl" if mode=="replay" else
            "log/dsh-sdk-wire.jsonl" if location=="local" else None)),indent=2)+"\n")
PY
: >"$BASE/control/replies.tsv"
cat >"$BASE/sway.conf" <<'CONF'
xwayland disable
output * resolution 1280x800
default_border pixel 1
focus_follows_mouse no
CONF
SAFE_ENV=(
 "PATH=$PATH" "HOME=$BASE/home" "XDG_RUNTIME_DIR=$BASE/runtime"
 "XDG_CONFIG_HOME=$BASE/config" "XDG_CACHE_HOME=$BASE/cache"
 "WLR_BACKENDS=headless" "WLR_RENDERER=pixman" "WLR_LIBINPUT_NO_DEVICES=1"
 "LANG=C.UTF-8" "TERM=xterm-256color"
 "DSH_HOME=$BASE/home/dsh" "DSH_AGENTS_HOME=$BASE/agents"
 "DSH_TUI_TEST_WORKSPACE=$WORKSPACE" "DSH_TUI_TEST_STORE=$BASE/sessions" "DSH_TELEMETRY_DISABLED=1"
 "DSH_TSP_RECORD=$BASE/log/metadata.jsonl"
 "DSH_TSP_RECORD_FULL=$BASE/log/dsh-sdk-wire.jsonl" "TERN_TSP=1"
)
if [[ -n "${DSH_TUI_SWAY_LIBRARY_PATH:-}" ]]; then
 SAFE_ENV+=("LD_LIBRARY_PATH=$DSH_TUI_SWAY_LIBRARY_PATH")
fi
env -i "${SAFE_ENV[@]}" "$SWAY" --config "$BASE/sway.conf" >"$BASE/log/sway.log" 2>&1 &
SWAY_PID=$!
SWAY_START="$(process_start "$SWAY_PID")"
[[ -n "$SWAY_START" ]] || { echo "cannot pin owned Sway start identity" >&2; exit 1; }
FOUND=""
for _ in {1..100}; do
 for sock in "$BASE/runtime"/wayland-*; do
   [[ -S "$sock" ]] && FOUND="$(basename "$sock")" && break
 done
 [[ -z "$FOUND" ]] || break
 kill -0 "$SWAY_PID" 2>/dev/null ||
   { echo "owned Sway exited" >&2; exit 1; }
 sleep 0.05
done
[[ -n "$FOUND" && -S "$BASE/runtime/$FOUND" ]] ||
 { echo "owned private Wayland socket absent" >&2; exit 1; }
IPC="$BASE/runtime/sway-ipc.$(id -u).$SWAY_PID.sock"
[[ -S "$IPC" ]] ||
 { echo "IPC socket not attributable to owned Sway PID $SWAY_PID" >&2; exit 1; }
kill -0 "$SWAY_PID"
env -i "${SAFE_ENV[@]}" swaymsg -s "$IPC" -t get_outputs >"$BASE/control/sway-info.json"
python3 - "$BASE/control/sway-info.json" <<'PY'
import json,sys
outputs=json.load(open(sys.argv[1]))
if not isinstance(outputs,list) or not any(
 isinstance(o,dict) and o.get("active") is True and
 str(o.get("name","")).startswith("HEADLESS-") for o in outputs):
 raise SystemExit("NO active HEADLESS output from owned Sway socket")
PY
SAFE_ENV+=("WAYLAND_DISPLAY=$FOUND" "SWAYSOCK=$IPC")
printf '%s\n' "$FOUND" >"$BASE/control/private-wayland-display"
CONTROL="$BASE/runtime/tern-private.sock"
env -i "${SAFE_ENV[@]}" "$TERN" serve --control "$CONTROL" --out "$BASE/tern" \
 >"$BASE/log/tern-serve.log" 2>&1 &
TERN_PID=$!
TERN_START="$(process_start "$TERN_PID")"
[[ -n "$TERN_START" ]] || { echo "cannot pin owned Tern start identity" >&2; exit 1; }
for _ in {1..100}; do
 [[ ! -S "$CONTROL" ]] || break
 kill -0 "$TERN_PID" 2>/dev/null || { echo "owned Tern exited" >&2; exit 1; }
 sleep 0.05
done
[[ -S "$CONTROL" ]] || { echo "owned private Tern socket absent" >&2; exit 1; }
# Tern ctl joins argv into its scenario grammar, NOT a POSIX shell.
# Scenario string literals use double quotes and JSON-compatible escaping.
# surface-play consumes a filename directly; do not add shell quotes.
scenario_quote() {
 python3 - "$1" <<'PY'
import json,sys
print(json.dumps(sys.argv[1]))
PY
}
# run is different: Tern decodes the scenario string FIRST, then sends the
# decoded value to its pane shell. Quote the trusted executable path as ONE
# POSIX shell word, THEN encode the entire command for the scenario parser.
# Never eval arbitrary command fragments.
run_quote() {
 python3 - "$1" <<'PY'
import json,shlex,sys
print(json.dumps(shlex.quote(sys.argv[1])))
PY
}
ctl() {
 local label="$1"; shift
 local reply
 reply="$(env -i "${SAFE_ENV[@]}" "$TERN" ctl --control "$CONTROL" "$@" \
   2>>"$BASE/log/tern-ctl.err")"
 printf '%s\t%s\n' "$label" "$reply" >>"$BASE/control/replies.tsv"
 printf '%s' "$reply" | python3 -c \
   'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r.get("ok") is True else 1)' ||
   { echo "Tern ctl refused $label: $reply" >&2; return 1; }
 printf '%s\n' "$reply"
}
inspect() {
 local label="$1"
 for command in state tree dump css a11y stats; do
   ctl "$label-$command" "$command" >"$BASE/control/$label-$command.json"
 done
 ctl "$label-shot" shot "$label" >"$BASE/control/$label-shot.json"
}
# Linux /proc TTY foreground process-group, explicitly parented by THIS tern
# serve PID. A generic 'ready' response alone is NOT a shell preflight.
shells() {
 python3 - "$TERN_PID" <<'PY'
import json,os,sys
parent=int(sys.argv[1])
rows={}
for name in os.listdir("/proc"):
 if not name.isdecimal(): continue
 try:
  t=open("/proc/"+name+"/stat").read().rsplit(")",1)[1].split()
  rows[int(name)]=(int(t[1]),int(t[2]),int(t[4]),int(t[5]),
                   open("/proc/"+name+"/comm").read().strip())
 except (OSError,ValueError,IndexError): pass
def descendant(pid):
 seen=set()
 while pid in rows and pid not in seen:
  seen.add(pid); pid=rows[pid][0]
  if pid==parent: return True
 return False
print(json.dumps(sorted(pid for pid,(_,pgid,tty,tpgid,comm) in rows.items()
 if descendant(pid) and tty!=0 and pgid==tpgid and
 comm in ("bash","sh","zsh","fish","dash","ksh"))))
PY
}
ctl initial-ready ready >/dev/null
shells >"$BASE/control/shells-before.json"
ctl new-fixture-shell session new dsh-fixture >/dev/null
ctl fresh-ready ready >/dev/null
shells >"$BASE/control/shells-after.json"
python3 - "$BASE/control/shells-before.json" "$BASE/control/shells-after.json" \
 "$BASE/control/foreground-shell.json" <<'PY'
import json,sys
old,new=(set(json.load(open(p))) for p in sys.argv[1:3])
fresh=new-old
if len(fresh)!=1:
 raise SystemExit("unable to prove ONE fresh foreground shell on owned Tern PTY: "+str(fresh))
with open(sys.argv[3],"x") as out:
 json.dump({"foreground_shell_pid":next(iter(fresh)),"verified_from":"owned /proc PTY TPGID",
            "new_session":True},out)
PY
ctl pre-run-state state >"$BASE/control/pre-run-state.json"
shells >"$BASE/control/shells-before-run.json"
python3 - "$BASE/control/foreground-shell.json" "$BASE/control/shells-before-run.json" <<'PY'
import json,sys
pid=json.load(open(sys.argv[1]))["foreground_shell_pid"]
if pid not in json.load(open(sys.argv[2])):
 raise SystemExit("fresh intended shell no longer foreground before run")
PY

# Local default runs the *built* real CLI and exact public keyless patch.
# A qualified override is one self-contained executable, not an eval string.
cat >"$BASE/launch-dsh.sh" <<EOF
#!/usr/bin/env bash
set -uo pipefail
cd $(printf '%q' "$WORKSPACE")
EOF
if [[ -z "$LAUNCHER" ]]; then
 printf 'node %q --profile tui --patch %q\n' "$CLI" \
   "$REPO/apps/cli/tests/profiles/tui/fixtures/cordis.yml" >>"$BASE/launch-dsh.sh"
else
 printf '%q\n' "$LAUNCHER" >>"$BASE/launch-dsh.sh"
fi
cat >>"$BASE/launch-dsh.sh" <<EOF
status=\$?
printf '{"exit_code":%s,"source":"owned-launch-wrapper"}\n' "\$status" >$(printf '%q' "$BASE/control/exit.json")
exit "\$status"
EOF
chmod 700 "$BASE/launch-dsh.sh"

# For SDK record format see @stencil-hq/tern's public ConnectOptions.record.
wire_ready() {
 python3 - "$BASE/log/dsh-sdk-wire.jsonl" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
if not p.is_file(): raise SystemExit(1)
try: rows=[json.loads(x) for x in p.read_text().splitlines() if x.strip()]
except (ValueError,OSError): raise SystemExit(1)
needed={("out","q"),("in","r"),("out","o"),("out","f")}
have={(r.get("dir"),r.get("verb")) for r in rows}
if not needed<=have or not any(r.get("dir")=="in" and
 r.get("verb")=="e" and r.get("body",{}).get("ev")=="ack" for r in rows):
 raise SystemExit(1)
PY
}
semantic_ready() {
 local label="$1"
 ctl "$label-tree" tree >"$BASE/control/$label-tree.json" || return 1
 python3 - "$BASE/control/$label-tree.json" <<'PY'
import json,sys
data=json.dumps(json.load(open(sys.argv[1])),ensure_ascii=False)
if "dock.composer" not in data and "sf-dock" not in data:
 raise SystemExit(1)
PY
}
replay_ready() {
 # Complete recordings end in out/x CLOSE and no longer have a live dock.
 # Require a retained main semantic node/role and a real readable state.
 ctl replay-probe-tree tree >"$BASE/control/replay-probe-tree.json" || return 1
 ctl replay-probe-state state >"$BASE/control/replay-probe-state.json" || return 1
 python3 - "$BASE/control/replay-probe-tree.json" "$BASE/control/replay-probe-state.json" <<'PY'
import json,re,sys
tree=json.dumps(json.load(open(sys.argv[1])),ensure_ascii=False)
state=json.dumps(json.load(open(sys.argv[2])),ensure_ascii=False)
if not re.search(r"main\.[A-Za-z0-9]|sf-main|dsh\.session|dsh\.transcript",tree):
 raise SystemExit(1)
if not state or state=="null":
 raise SystemExit(1)
PY
}
await_native() {
 local begin="$SECONDS"
 until { wire_ready && semantic_ready startup-probe; }; do
   [[ "$((SECONDS-begin))" -lt 45 ]] ||
     { echo "no semantic q/r/open/frame/ACK native readiness" >&2; exit 1; }
 done
}
# Query the *actual* Session JSONL; not a Tern screenshot, text search, timer,
# replay, or fixture-emitted fake message.
session_exact() {
 python3 - "$BASE/sessions" "$1" "$2" <<'PY'
import json,re,sys
from pathlib import Path
root=Path(sys.argv[1]); want_users=json.loads(sys.argv[2]); want_assist=json.loads(sys.argv[3])
paths=sorted((p for p in root.rglob("*") if re.fullmatch(
 r"session(?:\.v[1-9]\d*)?\.jsonl",p.name)),key=lambda p:p.stat().st_mtime_ns,
 reverse=True)
if not paths: raise SystemExit(1)
try: events=[json.loads(s) for s in paths[0].read_text().splitlines() if s.strip()]
except (ValueError,OSError): raise SystemExit(1)
if not events or events[0].get("type")!="session": raise SystemExit(1)
def content(blocks):
 if not isinstance(blocks,list): return ""
 return "".join(b.get("text","") for b in blocks if isinstance(b,dict) and b.get("type")=="text")
users=[content(e.get("data",{}).get("content")) for e in events[1:]
 if e.get("type")=="user/message" and
 e.get("data",{}).get("source",{}).get("kind")=="user"]
assist=[content(e.get("data",{}).get("message",{}).get("content")) for e in events[1:]
 if e.get("type")=="assistant/message"]
turns=sum(e.get("type")=="turn/end" for e in events[1:])
if users!=want_users or assist!=want_assist or turns<len(users):
 raise SystemExit(1)
PY
}
await_session() {
 local label="$1" users="$2" assistants="$3" begin="$SECONDS"
 until session_exact "$users" "$assistants"; do
   [[ "$((SECONDS-begin))" -lt 45 ]] ||
     { echo "$label: canonical users/replies/turn-end mismatch" >&2; exit 1; }
 done
 semantic_ready "$label"
 inspect "$label"
}
await_exit() {
 local begin="$SECONDS"
 until [[ -f "$BASE/control/exit.json" ]]; do
   [[ "$((SECONDS-begin))" -lt 45 ]] ||
     { echo "DSH /quit did not return control to owned shell" >&2; exit 1; }
 done
 python3 - "$BASE/control/exit.json" <<'PY'
import json,sys
if json.load(open(sys.argv[1])).get("exit_code") != 0:
 raise SystemExit("normal DSH /quit was not exit 0")
PY
}
if [[ "$MODE" == replay ]]; then
 python3 - "$2" <<'PY'
import os,stat,sys
p=os.lstat(sys.argv[1])
if not stat.S_ISREG(p.st_mode) or p.st_uid!=os.getuid() or p.st_mode & 0o077:
 raise SystemExit("replay source must be owner-only regular JSONL")
PY
 cp -- "$2" "$BASE/log/replay-source.jsonl"
 chmod 600 "$BASE/log/replay-source.jsonl"
 ctl replay-start surface-play "$(scenario_quote "$BASE/log/replay-source.jsonl")" >/dev/null
 begin="$SECONDS"
 until replay_ready; do
   [[ "$((SECONDS-begin))" -lt 45 ]] ||
     { echo "replayed semantic tree absent; still REPLAY ONLY" >&2; exit 1; }
 done
 inspect replay
else
 ctl app-launch run "$(run_quote "$BASE/launch-dsh.sh")" >/dev/null
 if [[ "$LOCATION" == local ]]; then
   await_native
 else
   # Remote recorder writes to remote paths and is NOT a local record.
   # Tern state may show remote content; never claim local wire/Session proof.
   begin="$SECONDS"
  until semantic_ready remote-start; do
   [[ "$((SECONDS-begin))" -lt 45 ]] ||
     { echo "remote semantic readiness absent (uncollected)" >&2; exit 1; }
  done
 fi
 inspect live-start
 if [[ "$MODE" == live ]]; then
   [[ "$LOCATION" == local ]] ||
     { echo "remote functional Session assertions require a trusted copy; refusing proof" >&2; exit 2; }
   ctl alpha-type type alpha >/dev/null
   ctl alpha-send key Enter >/dev/null
   await_session live-alpha '["alpha"]' '["echo: alpha"]'
   ctl beta-type type beta >/dev/null
   ctl beta-send key Enter >/dev/null
   await_session live-beta '["alpha","beta"]' '["echo: alpha","echo: beta"]'
   ctl failure-type type "[failure]" >/dev/null
   ctl failure-send key Enter >/dev/null
   await_session live-failure '["alpha","beta","[failure]"]' '["echo: alpha","echo: beta"]'
   # Preserve the real Tern split/focus/hide/show controls. Resize the
   # viewport with its numeric W H only; do not call shadowed resize right.
   cat >"$BASE/log-pane.sh" <<EOF
#!/usr/bin/env bash
exec tail -n +1 -f $(printf '%q' "$BASE/log/tern-serve.log")
EOF
   chmod 700 "$BASE/log-pane.sh"
   ctl log-pane-split split right >/dev/null
   ctl log-pane-run run "$(run_quote "$BASE/log-pane.sh")" >/dev/null
   ctl app-pane-focus focus left >/dev/null
   inspect live-split
   ctl viewport-resize resize 1024 768 >/dev/null
   inspect live-resize
   ctl hide-session session new dsh-log >/dev/null
   ctl show-session session switch dsh-fixture >/dev/null
   ctl app-pane-refocus focus left >/dev/null
   inspect live-reshow
 fi
 ctl normal-quit-type type "/quit" >/dev/null
 ctl normal-quit-send key Enter >/dev/null
 await_exit
fi
ctl stop-owned-tern quit >"$BASE/control/quit.json" || :
printf 'private evidence: %s\n' "$BASE"
