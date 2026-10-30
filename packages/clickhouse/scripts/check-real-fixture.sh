#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { echo 'Real ClickHouse proof requires Linux.' >&2; exit 1; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
: "${CLICKHOUSE_NODE20:?Node20 runtime path required}"
: "${CLICKHOUSE_FIXTURE_ADMIN_PASSWORD:?Fresh Node-only admin secret required}"
: "${CLICKHOUSE_PROOF_DIR:?Private proof directory required}"
[[ "$CLICKHOUSE_FIXTURE_ADMIN_PASSWORD" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || exit 1
[[ "$("$CLICKHOUSE_NODE20" --version)" == v20.0.0 ]] || exit 1
[[ "$(node --version)" == v24.* ]] || exit 1
export CLICKHOUSE_PASSWORD="$CLICKHOUSE_FIXTURE_ADMIN_PASSWORD"
export CLICKHOUSE_FIXTURE_IMAGE='clickhouse/clickhouse-server:26.10.3.7@sha256:739e099abd1157390960a59e4532d21781d8fde57e6e4151cb920ea02c30b1ce'
export CLICKHOUSE_BROWSER_PORT=14389
umask 077
mkdir -p "$CLICKHOUSE_PROOF_DIR"
private=$(mktemp -d /tmp/dalgo-clickhouse-ts.XXXXXX)
fixture="dalgo-ts-clickhouse-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
created=false
redact() {
  # Private raw logs are never uploaded. Cap every retained line and file;
  # redact both the exact fresh secret and recognizable credential fields.
  sed "s/$CLICKHOUSE_FIXTURE_ADMIN_PASSWORD/[redacted]/g" "$1" | LC_ALL=C awk '
    NR <= 100 { if (tolower($0) ~ /password|authorization|access_token|secret_key|stack trace|stacktrace/) print "[redacted diagnostic]"; else print substr($0,1,512) }
  ' > "$2"
}
capture() {
  local name=$1
  shift
  local result=0
  (ulimit -f 1024; timeout --kill-after=2s 120s "$@" > "$private/$name.raw" 2>&1) || result=$?
  redact "$private/$name.raw" "$CLICKHOUSE_PROOF_DIR/$name.log"
  cat "$CLICKHOUSE_PROOF_DIR/$name.log"
  return "$result"
}
resource_guard() {
  timeout --kill-after=1s 5s docker inspect --format '{"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}},"oomKilled":{{.State.OOMKilled}},"running":{{.State.Running}}}' "$fixture" > "$CLICKHOUSE_PROOF_DIR/container.json" || return 1
  jq -e '.memory==2147483648 and .memorySwap==2147483648 and .nanoCpus==2000000000 and .pidsLimit==128 and .oomKilled==false and .running==true' "$CLICKHOUSE_PROOF_DIR/container.json" >/dev/null || return 1
  timeout --kill-after=1s 5s docker exec "$fixture" sh -c '
    test -r /sys/fs/cgroup/pids.events && test -r /sys/fs/cgroup/memory.events || exit 1
    while read -r name value; do case "$name" in max) printf "pids_max %s\n" "$value" ;; esac; done < /sys/fs/cgroup/pids.events
    while read -r name value; do case "$name" in oom|oom_kill) printf "%s %s\n" "$name" "$value" ;; esac; done < /sys/fs/cgroup/memory.events
  ' > "$private/resource-events" || return 1
  LC_ALL=C awk '
    NF!=2 || $1!~/^(pids_max|oom|oom_kill)$/ || $2!~/^[0-9]+$/ {bad=1}
    {counts[$1]++; values[$1]=$2}
    END {split("pids_max oom oom_kill",keys," "); for(i=1;i<=3;i++) if(counts[keys[i]]!=1 || values[keys[i]]!=0) bad=1;
      if(bad) exit 1; printf "{\"pidsMaxEvents\":%d,\"oomEvents\":%d,\"oomKillEvents\":%d}\n",values["pids_max"],values["oom"],values["oom_kill"]}
  ' "$private/resource-events" > "$CLICKHOUSE_PROOF_DIR/resources.json"
}
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  local resources=false removed=false remaining
  if [[ "$created" == true ]]; then
    if resource_guard; then resources=true; else result=1; fi
    if [[ "$result" != 0 ]]; then
      (ulimit -f 1024; timeout --kill-after=1s 5s docker logs --tail 100 "$fixture" > "$private/server.raw" 2>&1) || true
      redact "$private/server.raw" "$CLICKHOUSE_PROOF_DIR/server.log"
    fi
    if timeout --kill-after=2s 10s docker rm -f "$fixture" >/dev/null 2>&1; then
      if remaining=$(timeout --kill-after=1s 3s docker container ls --all --filter "name=^/${fixture}$" --format '{{.Names}}') && [[ -z "$remaining" ]]; then removed=true; fi
    fi
    [[ "$removed" == true ]] || result=1
  else
    removed=true
  fi
  printf '{"containerRemoved":%s,"resourceGuardPassed":%s,"exitCode":%d}\n' "$removed" "$resources" "$result" > "$CLICKHOUSE_PROOF_DIR/cleanup.json"
  rm -rf -- "$private"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Exact public SDK fixture bytes; TS CORS/admin isolation stays in overlays.
sha256sum --check <<'HASHES'
a03c14ee8cf183910c8ae3b05bde5a95d8f3c6f7e9c01a6be33c27633e0e15dd  test/fixtures/upstream/init.sql
a1d9d02e6ce31b7f6bfb5e1af6fe48055a54437fbc400c41ebd3e6d57a52cdb9  test/fixtures/upstream/access.xml
c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4  test/fixtures/upstream/LICENSE
HASHES
(ulimit -f 1024; timeout --kill-after=5s 180s docker pull "$CLICKHOUSE_FIXTURE_IMAGE" > "$private/pull.raw" 2>&1)
created=true
timeout --kill-after=2s 15s docker run --detach --name "$fixture" --memory=2g --memory-swap=2g --cpus=2 --pids-limit=128 \
  --publish 127.0.0.1::8123 --env CLICKHOUSE_SKIP_USER_SETUP=1 --env CLICKHOUSE_PASSWORD --env CLICKHOUSE_FIXTURE_ADMIN_PASSWORD \
  --mount "type=bind,source=$root/test/fixtures/upstream/init.sql,target=/docker-entrypoint-initdb.d/01-fixture.sql,readonly" \
  --mount "type=bind,source=$root/test/fixtures/upstream/access.xml,target=/etc/clickhouse-server/config.d/adapter-access.xml,readonly" \
  --mount "type=bind,source=$root/test/fixtures/browser-cors.xml,target=/etc/clickhouse-server/config.d/browser-cors.xml,readonly" \
  --mount "type=bind,source=$root/test/fixtures/admin-auth.xml,target=/etc/clickhouse-server/users.d/ts-admin-auth.xml,readonly" \
  "$CLICKHOUSE_FIXTURE_IMAGE" > "$private/container-id"
ready=false
for attempt in {1..60}; do
  if (ulimit -f 1024; timeout --kill-after=1s 2s docker exec "$fixture" sh -c '
    case "$(cat /proc/1/comm)" in clickhouse|clickhouse-serv) ;; *) exit 1 ;; esac
    exec clickhouse-client --user fixture_reader --password synthetic-reader --query "SELECT count() FROM explore.events"
  ' > "$private/readiness.raw" 2>&1) && grep -qx 3 "$private/readiness.raw"; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'ClickHouse fixture did not finish initialization.' >&2; exit 1; }
mapping=$(timeout --kill-after=1s 3s docker port "$fixture" 8123/tcp)
[[ "$mapping" =~ ^127\.0\.0\.1:[0-9]+$ ]] || exit 1
export CLICKHOUSE_TEST_URL="http://$mapping"
resource_guard
capture node20 "$CLICKHOUSE_NODE20" scripts/real-clickhouse.mjs
capture node24 node scripts/real-clickhouse.mjs
capture chromium node scripts/real-clickhouse-browser.mjs
# Each runner writes a bounded redacted receipt only after all real assertions.
for proof in node20 node24 chromium; do
  jq -e '.version=="26.10.3.7" and .lateProof.errorCode=="framing" and .lateProof.httpStatus==200 and .serverCancellationObserved=={"before":1,"after":0}' "$CLICKHOUSE_PROOF_DIR/$proof.json" >/dev/null
done
