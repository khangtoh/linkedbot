#!/usr/bin/env bash
# Local package + deploy pipeline for InstaCloud.
#   scripts/deploy.sh                 # every stage: check package provision secrets deploy verify
#   scripts/deploy.sh check package   # only the named stages
# The image is built remotely from the Dockerfile, so no local Docker is needed.
# Every stage is safe to re-run: existing projects, services and secrets are left alone.
# Env: INSTA (CLI command, default "insta"), LINKEDBOT_PROJECT, LINKEDBOT_SERVICE, LINKEDBOT_VOLUME_GI.
set -euo pipefail
cd "$(dirname "$0")/.."

read -ra INSTA <<<"${INSTA:-insta}"
PROJECT=${LINKEDBOT_PROJECT:-linkedbot}
SERVICE=${LINKEDBOT_SERVICE:-app}
VOLUME_GI=${LINKEDBOT_VOLUME_GI:-1}
PORT=8080 # must match EXPOSE in the Dockerfile

say() { printf '\n== %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

service_json() {
  "${INSTA[@]}" service list --json |
    jq -c --arg n "$SERVICE" 'first(.. | objects | select(.type? == "compute" and .name? == $n))'
}

has_secret() {
  "${INSTA[@]}" secrets list --json |
    jq -e --arg n "$1" '[.. | strings, (objects | keys[])] | index($n) != null' >/dev/null
}

# Sets secret $1 once: from the local environment if exported, else generated when $2 is "generate".
# Never overwrites: rotating LINKEDBOT_PASSPHRASE would make the saved session vault unreadable.
ensure_secret() {
  local name=$1 value=${!1:-}
  if has_secret "$name"; then echo "  $name: already set"; return; fi
  if [ -z "$value" ] && [ "${2:-}" = generate ]; then value=$(openssl rand -hex 32); fi
  if [ -z "$value" ]; then echo "  $name: skipped (export it and re-run this stage to add it)"; return; fi
  printf '%s' "$value" | "${INSTA[@]}" secrets set "$name" >/dev/null
  echo "  $name: set"
}

stage_check() {
  say "check: typecheck + compile"
  [ -d node_modules ] || npm ci
  npm run typecheck
  npm run build
}

stage_package() {
  say "package: validate the Docker build context"
  "${INSTA[@]}" build . --port "$PORT"
}

stage_provision() {
  say "provision: project + compute service with a persistent /data volume"
  "${INSTA[@]}" status --json | jq -e '.user' >/dev/null || die "not logged in. Run: insta login"
  [ -f .insta/project.json ] || "${INSTA[@]}" project create "$PROJECT"
  if [ -n "$(service_json)" ]; then
    echo "  compute/$SERVICE: already exists"
  else
    "${INSTA[@]}" service add compute "$SERVICE" --port "$PORT" --volume "$VOLUME_GI"
  fi
}

stage_secrets() {
  say "secrets: runtime configuration for compute/$SERVICE"
  ensure_secret LINKEDBOT_PASSPHRASE generate # encrypts the session vault on the volume
  ensure_secret LINKEDBOT_API_TOKEN generate  # bearer token for the HTTP API
  ensure_secret ANTHROPIC_API_KEY             # only the "agent" job needs it
}

stage_deploy() {
  say "deploy: remote image build + rollout"
  "${INSTA[@]}" deploy . --group "$SERVICE" --port "$PORT"
}

stage_verify() {
  say "verify: wait for the service to answer"
  local domain url code=000
  domain=$(service_json | jq -r '.domain // empty')
  [ -n "$domain" ] || die "compute/$SERVICE has no domain yet. Has it been deployed?"
  url="https://${domain#https://}"
  for _ in $(seq 30); do # scale-to-zero: the first hit can be a cold start
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url/healthz" || true)
    [ "$code" = 200 ] && break
    sleep 3
  done
  [ "$code" = 200 ] || die "$url/healthz answered $code. See: insta compute logs $SERVICE --limit 100"
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url/status" || true)
  [ "$code" = 401 ] || die "$url/status answered $code without a token (expected 401)"
  echo "live: $url"
}

command -v jq >/dev/null || die "jq is required"
STAGES=(check package provision secrets deploy verify)
[ $# -gt 0 ] && STAGES=("$@")
for s in "${STAGES[@]}"; do
  declare -F "stage_$s" >/dev/null || die "unknown stage: $s (stages: check package provision secrets deploy verify)"
  "stage_$s"
done
