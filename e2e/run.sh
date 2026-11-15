#!/bin/bash
# End to end against a real LiveKit: starts the livekit-server that compose.yaml pins in Docker, with Redis and the
# Egress it pins when E2E_EGRESS=1 (as in CI), and runs Meet's server against them (e2e/livekit.ts). LiveKit's own
# command line tool joins rooms as browsers would, publishing a test video. Needs Docker. Exits non-zero on failure.
set -u
cd "$(dirname "$0")/.."
LK_IMAGE=$(sed -n 's/^ *image: \(livekit\/livekit-server:[^ ]*\).*$/\1/p' compose.yaml)
EG_IMAGE=$(sed -n 's/^ *image: \(livekit\/egress:[^ ]*\).*$/\1/p' compose.yaml)
REDIS_IMAGE=$(sed -n 's/^ *image: \(redis:[^ ]*\).*$/\1/p' compose.yaml)
export CLI_IMAGE=${E2E_CLI_IMAGE:-livekit/livekit-cli:v2.19.1}
export LK_PORT=${E2E_LK_PORT:-17880}
export MEET_PORT=${E2E_MEET_PORT:-18299}
export NET=meet-e2e
export SECRET="e2e-$(openssl rand -hex 24)"
DIR=""
cleanup() {
  docker rm -f meet-e2e-lk meet-e2e-redis meet-e2e-egress $(docker ps -aq --filter name=meet-e2e-p-) >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  [ -z "$DIR" ] || rm -rf "$DIR"
}
cleanup
# Where Egress writes and Meet reads: the same path on both sides, open to Egress's own user.
export DIR=$(mktemp -d)
chmod 0777 "$DIR"
[ -n "${E2E_KEEP:-}" ] || trap cleanup EXIT
docker network create "$NET" >/dev/null
docker run -d --name meet-e2e-redis --network "$NET" "$REDIS_IMAGE" >/dev/null
CONFIG="port: 7880
rtc: { tcp_port: 7881, port_range_start: 50000, port_range_end: 50020, use_external_ip: false }
redis: { address: meet-e2e-redis:6379 }
room: { departure_timeout: 5 }
webhook: { api_key: meet, urls: ['http://host.docker.internal:$MEET_PORT/api/v1/livekit/webhook'] }
prometheus_port: 6789"
docker run -d --name meet-e2e-lk --network "$NET" --add-host host.docker.internal:host-gateway \
  -p "127.0.0.1:$LK_PORT:7880" -p "127.0.0.1:$((LK_PORT + 1)):6789" \
  -e LIVEKIT_KEYS="meet: $SECRET" -e LIVEKIT_CONFIG="$CONFIG" "$LK_IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -sf "http://localhost:$LK_PORT/" >/dev/null && break; sleep 1; done
echo "# $LK_IMAGE on port $LK_PORT"
if [ -n "${E2E_EGRESS:-}" ]; then
  docker run -d --name meet-e2e-egress --network "$NET" --cap-add SYS_ADMIN -v "$DIR:$DIR" \
    -e EGRESS_CONFIG_BODY="$(printf 'api_key: meet\napi_secret: %s\nws_url: ws://meet-e2e-lk:7880\nredis:\n  address: meet-e2e-redis:6379\n' "$SECRET")" \
    "$EG_IMAGE" >/dev/null
  echo "# $EG_IMAGE"
  export EGRESS=1
fi
docker pull -q "$CLI_IMAGE" >/dev/null
node e2e/livekit.ts
status=$?
[ $status -eq 0 ] || { docker logs --tail 40 meet-e2e-lk; [ -n "${E2E_EGRESS:-}" ] && docker logs --tail 40 meet-e2e-egress; }
exit $status
