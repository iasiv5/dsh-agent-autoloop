#!/bin/sh
# Stage E install smoke, plugin edition: a fresh throwaway DSH_HOME gets the plugin installed, composed into the
# profile, booted once (activation proves the lock + config + kernel wiring), then uninstalled — nothing outside the
# temp home is touched. Requires the `dsh` CLI on PATH. Usage: sh dsh/scripts/install-smoke.sh <repo-root>
set -u
ROOT=${1:?usage: install-smoke.sh <repo-root>}
DSH_HOME=$(mktemp -d "${TMPDIR:-/tmp}/autoloop-smoke-XXXXXX")
export DSH_HOME
fail() { echo "install-smoke: FAIL — $1"; kill "$BOOT_PID" 2>/dev/null; rm -rf "$DSH_HOME"; exit 1; }

echo "== 1. install into a fresh profile =="
dsh plugin --profile web add "$ROOT/dsh" >/dev/null 2>&1 || fail "plugin add"
grep -q '"@iasiv5/dsh-agent-autoloop"' "$DSH_HOME/profiles/web/package.json" || fail "dependency not recorded"

echo "== 2. composed profile contains the plugin layer =="
dsh --profile web --dump-config 2>/dev/null | grep -q 'agent-autoloop' || fail "dump-config lacks the layer"

echo "== 3. trusted rules config, then boot =="
mkdir -p "$DSH_HOME/profiles/web/data/agent-autoloop"
python3 - "$DSH_HOME/profiles/web/data/agent-autoloop/config.json" <<'PY' || fail "config write"
import json, sys
rules = {
    "timezone": "UTC",
    "askFirst": [],
    "sources": {"local": {"name": "local"}},
    "agents": {"dsh": {"name": "DSH", "worker": "dsh", "use": "dsh", "access": "edit"}},
    "channels": {},
    "rules": [{"name": "smoke", "when": {"source": "local", "types": ["smoke.*"]}, "to": "dsh", "cwd": "/tmp", "prompt": "smoke."}],
    "elsewhere": [],
}
json.dump({"capacity": 1, "worker": "dsh", "rules": rules}, open(sys.argv[1], "w"))
PY
dsh --profile web --no-open --port 0 >"$DSH_HOME/boot.log" 2>&1 &
BOOT_PID=$!
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 2
  grep -q "agent-autoloop" "$DSH_HOME/boot.log" 2>/dev/null && ! kill -0 "$BOOT_PID" 2>/dev/null && fail "boot process died"
  [ -f "$DSH_HOME/profiles/web/data/agent-autoloop/lock" ] && break
done
[ -f "$DSH_HOME/profiles/web/data/agent-autoloop/lock" ] || fail "plugin never activated (no data lock)"
grep -q "did not activate" "$DSH_HOME/boot.log" && fail "activation warning in boot log"
echo "   activated: data lock present"

echo "== 4. uninstall =="
kill "$BOOT_PID" 2>/dev/null
wait "$BOOT_PID" 2>/dev/null
sleep 1
[ -f "$DSH_HOME/profiles/web/data/agent-autoloop/lock" ] && fail "lock survived shutdown"
dsh plugin --profile web remove @iasiv5/dsh-agent-autoloop >/dev/null 2>&1 || fail "plugin remove"
dsh --profile web --dump-config 2>/dev/null | grep -q 'agent-autoloop' && fail "layer still composed after removal"
echo "   removed: layer gone from the composed profile; data dir kept"

rm -rf "$DSH_HOME"
echo "install-smoke: PASS"
