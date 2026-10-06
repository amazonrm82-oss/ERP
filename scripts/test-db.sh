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

case "${1:-start}" in
  start)
    mkdir -p "$DIR"
    if [ "$(id -u)" = "0" ]; then chown postgres:postgres "$DIR"; fi
    if [ ! -d "$DIR/data" ]; then
      run "$BIN/initdb -D $DIR/data -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null"
    fi
    if ! run "$BIN/pg_ctl -D $DIR/data status" >/dev/null 2>&1; then
      run "$BIN/pg_ctl -D $DIR/data -o '-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$DIR' -l $DIR/log -w start" >/dev/null
    fi
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
