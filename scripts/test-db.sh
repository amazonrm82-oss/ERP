#!/usr/bin/env bash
# Starts / stops a throwaway local PostgreSQL for `npm run test:db`.
# It lives in a temp directory, listens on 127.0.0.1 only, and has nothing to
# do with any Supabase project. Deleting the directory deletes everything.
set -euo pipefail

PORT="${TEST_DB_PORT:-54329}"
DIR="${TEST_DB_DIR:-/tmp/crm-saas-pgtest}"
BIN="$(pg_config --bindir 2>/dev/null || true)"
if [ -z "$BIN" ] || [ ! -x "$BIN/initdb" ]; then
  BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$BIN" ] || [ ! -x "$BIN/initdb" ]; then
  echo "PostgreSQL server binaries not found (need initdb, pg_ctl)." >&2
  exit 1
fi

# PostgreSQL refuses to run as root; fall back to the postgres system user.
run() {
  if [ "$(id -u)" = "0" ]; then su postgres -c "$*"; else bash -c "$*"; fi
}

fail() {
  echo "test database: $*" >&2
  exit 1
}

# True when something already accepts connections on 127.0.0.1:$PORT (a postgres or anything else).
port_taken() {
  "$BIN/pg_isready" -q -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && return 0
  # pg_isready answers 2 for "no response"; also try a plain TCP connect for a server that is not postgres
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1
}

# The postmaster of $DIR/data must be alive, listen on $PORT, and be the server that answers there:
# postmaster.pid names the port (line 4), and the server on the port reports this data directory.
verify_owner() {
  local pidfile="$DIR/data/postmaster.pid" pid port answer want
  [ -f "$pidfile" ] || fail "no postmaster.pid in $DIR/data after start (see $DIR/log)"
  pid="$(sed -n 1p "$pidfile")"
  port="$(sed -n 4p "$pidfile")"
  kill -0 "$pid" 2>/dev/null || fail "the postmaster of $DIR/data (pid $pid) is not running (see $DIR/log)"
  [ "$port" = "$PORT" ] || fail "the cluster in $DIR/data listens on port $port, not $PORT; stop it first (TEST_DB_PORT / TEST_DB_DIR)"
  "$BIN/pg_isready" -q -h 127.0.0.1 -p "$PORT" || fail "nothing answers on 127.0.0.1:$PORT after start (see $DIR/log)"
  answer="$(PGCONNECT_TIMEOUT=5 "$BIN/psql" -X -A -t -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -c 'show data_directory' 2>/dev/null || true)"
  want="$(cd "$DIR/data" && pwd -P)"
  [ -n "$answer" ] && [ "$(cd "$answer" 2>/dev/null && pwd -P)" = "$want" ] \
    || fail "the server on 127.0.0.1:$PORT is not the cluster in $DIR/data (it reports '${answer:-nothing}'); refusing"
}

case "${1:-start}" in
  start)
    mkdir -p "$DIR"
    if [ "$(id -u)" = "0" ]; then chown postgres:postgres "$DIR"; fi
    if [ ! -d "$DIR/data" ]; then
      run "$BIN/initdb -D $DIR/data -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null"
    fi
    if ! run "$BIN/pg_ctl -D $DIR/data status" >/dev/null 2>&1; then
      # never start next to another server: its port would answer for us, and test:db would rebuild its database
      if port_taken; then
        fail "port $PORT on 127.0.0.1 is already in use by another server; pick a free TEST_DB_PORT (check with pg_isready -h 127.0.0.1 -p $PORT)"
      fi
      run "$BIN/pg_ctl -D $DIR/data -o '-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$DIR' -l $DIR/log -w start" >/dev/null \
        || fail "pg_ctl could not start the cluster in $DIR/data on port $PORT (see $DIR/log)"
    fi
    verify_owner
    echo "test database ready: postgres://postgres@127.0.0.1:$PORT"
    ;;
  stop)
    run "$BIN/pg_ctl -D $DIR/data -m fast stop" >/dev/null 2>&1 || true
    echo "test database stopped"
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 1
    ;;
esac
