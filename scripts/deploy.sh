#!/usr/bin/env bash
# Local package + deploy pipeline for InstaCloud.
#   scripts/deploy.sh                 # every stage: check package provision secrets deploy verify
#   scripts/deploy.sh check package   # only the named stages
#   scripts/deploy.sh token           # extra stage: replace the API token (restarts the service)
# The image is built remotely from the Dockerfile, so no local Docker is needed.
# Every stage is safe to re-run: existing projects, services and secrets are left alone.
# Env: INSTA (CLI command, default "insta"), LINKEDBOT_PROJECT, LINKEDBOT_SERVICE, LINKEDBOT_VOLUME_GI,
#      LINKEDBOT_BRANCH (an InstaCloud preview branch to deploy and verify instead of the linked one).
set -euo pipefail
cd "$(dirname "$0")/.."

read -ra INSTA <<<"${INSTA:-insta}"
PROJECT=${LINKEDBOT_PROJECT:-linkedbot}
SERVICE=${LINKEDBOT_SERVICE:-app}
VOLUME_GI=${LINKEDBOT_VOLUME_GI:-1}
PORT=8080 # must match EXPOSE in the Dockerfile
BRANCH=()
[ -n "${LINKEDBOT_BRANCH:-}" ] && BRANCH=(--branch "$LINKEDBOT_BRANCH")

say() { printf '\n== %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

service_json() {
  "${INSTA[@]}" service list "${BRANCH[@]}" --json |
    jq -c --arg n "$SERVICE" 'first(.. | objects | select(.type? == "compute" and .name? == $n))'
}

has_secret() {
  "${INSTA[@]}" secrets list --json |
    jq -e --arg n "$1" '[.. | strings, (objects | keys[])] | index($n) != null' >/dev/null
}

# Four random words (about 52 bits) from scripts/wordlist.txt, the EFF long wordlist (CC BY 3.0 US)
# minus its hyphenated entries. Redrawn until it meets the server's 24-character minimum.
gen_words() {
  node -e '
    const { randomInt } = require("node:crypto");
    const words = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    let token;
    do token = Array.from({ length: 4 }, () => words[randomInt(words.length)]).join("-");
    while (token.length < 24);
    console.log(token);
  ' scripts/wordlist.txt
}

# Sets secret $1 once: from the local environment if exported, else generated when $2 is "hex" or "words".
# Never overwrites: rotating LINKEDBOT_PASSPHRASE would make the saved session vault unreadable.
ensure_secret() {
  local name=$1 value=${!1:-}
  if has_secret "$name"; then echo "  $name: already set"; return; fi
  if [ -z "$value" ] && [ "${2:-}" = hex ]; then value=$(openssl rand -hex 32); fi
  if [ -z "$value" ] && [ "${2:-}" = words ]; then value=$(gen_words); fi
  if [ -z "$value" ]; then echo "  $name: skipped (export it and re-run this stage to add it)"; return; fi
  printf '%s' "$value" | "${INSTA[@]}" secrets set "$name" >/dev/null
  echo "  $name: set"
}

stage_check() {
  say "check: typecheck + compile (server and studio)"
  [ -d node_modules ] || npm ci
  npm run typecheck
  npm run build
  npm run build:web
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
  ensure_secret LINKEDBOT_PASSPHRASE hex  # encrypts the session vault on the volume
  ensure_secret LINKEDBOT_API_TOKEN words # bearer token for the HTTP API
  ensure_secret ANTHROPIC_API_KEY         # only the "agent" job needs it
}

# Not part of the default run: replaces the API token, which restarts the service.
stage_token() {
  say "token: replace LINKEDBOT_API_TOKEN with four new random words"
  gen_words | "${INSTA[@]}" secrets set LINKEDBOT_API_TOKEN >/dev/null
  echo "  LINKEDBOT_API_TOKEN: replaced. Read it with: insta secrets --print | grep LINKEDBOT_API_TOKEN"
}

app_url() {
  local domain
  domain=$(service_json | jq -r '.domain // empty')
  [ -n "$domain" ] || die "compute/$SERVICE has no domain yet. Has it been deployed?"
  echo "https://${domain#https://}"
}

# True once /healthz is answered by a process that started at or after $1 (epoch seconds).
serving_build_since() {
  local url started
  url=$(app_url)
  for _ in $(seq 30); do # scale-to-zero: the first hit can be a cold start
    started=$(curl -s -m 10 -o /dev/null -D - "$url/healthz" | tr -d '\r' | sed -n 's/^x-linkedbot-started: *//p')
    [ -n "$started" ] && [ "$started" -ge "$1" ] && return 0
    sleep 3
  done
  return 1
}

stage_deploy() {
  say "deploy: remote image build + rollout"
  local since
  since=$(date -u +%s)
  "${INSTA[@]}" deploy . "${BRANCH[@]}" --group "$SERVICE" --port "$PORT"
  # The platform has been seen recording a new image without moving the machine onto it
  # (reported to InstaCloud). Wait for a process started after this deploy began; restart once if none.
  serving_build_since "$since" && return
  echo "  compute/$SERVICE is still serving the previous build; restarting it onto the new image"
  "${INSTA[@]}" compute restart "$SERVICE" "${BRANCH[@]}"
  serving_build_since "$since" || die "compute/$SERVICE is not serving the new build. See: insta compute logs $SERVICE"
}

stage_verify() {
  say "verify: wait for the service to answer"
  local url code=000
  url=$(app_url)
  for _ in $(seq 30); do # scale-to-zero: the first hit can be a cold start
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url/healthz" || true)
    [ "$code" = 200 ] && break
    sleep 3
  done
  [ "$code" = 200 ] || die "$url/healthz answered $code. See: insta compute logs $SERVICE --limit 100"
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url/status" || true)
  [ "$code" = 401 ] || die "$url/status answered $code without a token (expected 401)"
  # Auth, MCP over both protocol versions and OAuth discovery; the token is injected, never written.
  "${INSTA[@]}" run "${BRANCH[@]}" -- npx tsx scripts/smoke.ts "$url" || die "smoke test failed for $url"
  echo "live: $url"
}

command -v jq >/dev/null || die "jq is required"
STAGES=(check package provision secrets deploy verify)
[ $# -gt 0 ] && STAGES=("$@")
for s in "${STAGES[@]}"; do
  declare -F "stage_$s" >/dev/null || die "unknown stage: $s (stages: check package provision secrets deploy verify token)"
  "stage_$s"
done
