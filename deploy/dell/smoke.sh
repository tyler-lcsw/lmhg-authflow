#!/usr/bin/env bash
set -euo pipefail

DASHBOARD_BASE_URL="${DASHBOARD_BASE_URL:-https://dashboard.lmhg.app}"
AUTH_ISSUER_URL="${AUTH_ISSUER_URL:-https://auth.lmhg.app}"
EXPECTED_ISSUER="${EXPECTED_ISSUER:-https://auth.lmhg.app}"
EXPECTED_CLIENT_ID="${EXPECTED_CLIENT_ID:-374343961315180547}"
EXPECTED_CALLBACK_URL="${EXPECTED_CALLBACK_URL:-https://dashboard.lmhg.app/api/callback}"
AUTH_MANAGER_DIRECT_URL="${AUTH_MANAGER_DIRECT_URL:-http://127.0.0.1:3100}"
EXPECTED_PRIVATE_HOSTNAME="${EXPECTED_PRIVATE_HOSTNAME:-dell-4229}"
AUTH_FORMS_API_TOKEN="${AUTH_FORMS_API_TOKEN:-}"
SMOKE_SCOPE="${SMOKE_SCOPE:-public}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER_HOST="$(hostname -s)"
RUNNER_USER="$(id -un)"
SOURCE_COMMIT="$(git -C "$PROJECT_ROOT" rev-parse --verify HEAD 2>/dev/null || printf 'unknown')"
failures=0

case "$SMOKE_SCOPE" in
  public|private|all) ;;
  *)
    printf "smoke=fail reason=invalid_scope scope=%s expected=public,private,all\n" "$SMOKE_SCOPE"
    exit 2
    ;;
esac

printf "evidence timestamp=%s runner=%s:%s commit=%s scope=%s command=%s\n" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUNNER_HOST" "$RUNNER_USER" \
  "$SOURCE_COMMIT" "$SMOKE_SCOPE" "$0"

probe_status() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local status

  if ! status="$(curl -sS --max-time 12 -o /dev/null -w "%{http_code}" "$url")"; then
    status="transport_error"
  fi
  printf "%s status=%s expected=%s\n" "$label" "$status" "$expected"
  if [[ "$status" != "$expected" ]]; then
    failures=$((failures + 1))
  fi
}

probe_discovery() {
  local issuer

  issuer="$(curl -fsS --max-time 12 "$AUTH_ISSUER_URL/.well-known/openid-configuration" \
    | node -e 'let body=""; process.stdin.on("data", c => body += c); process.stdin.on("end", () => { const parsed = JSON.parse(body); process.stdout.write(parsed.issuer || ""); });' \
    || true)"
  printf "oidc_discovery issuer=%s expected=%s\n" "$issuer" "$EXPECTED_ISSUER"
  if [[ "$issuer" != "$EXPECTED_ISSUER" ]]; then
    failures=$((failures + 1))
  fi
}

probe_login_start() {
  local headers_file status location validation
  headers_file="$(mktemp)"

  if ! status="$(curl -sS --max-time 12 -D "$headers_file" -o /dev/null -w "%{http_code}" "$DASHBOARD_BASE_URL/api/login")"; then
    status="transport_error"
  fi
  location="$(awk 'tolower($1) == "location:" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$headers_file")"
  rm -f "$headers_file"

  validation="$(node -e '
    const [location, issuer, clientId, callback] = process.argv.slice(1);
    try {
      const target = new URL(location);
      const expectedOrigin = new URL(issuer).origin;
      const valid = target.origin === expectedOrigin
        && target.pathname === "/oauth/v2/authorize"
        && target.searchParams.get("client_id") === clientId
        && target.searchParams.get("redirect_uri") === callback;
      process.stdout.write(valid ? "valid" : "invalid");
    } catch {
      process.stdout.write("invalid");
    }
  ' "$location" "$AUTH_ISSUER_URL" "$EXPECTED_CLIENT_ID" "$EXPECTED_CALLBACK_URL")"

  printf "dashboard_login_start status=%s expected=302 location_contract=%s expected=valid\n" "$status" "$validation"
  if [[ "$status" != "302" || "$validation" != "valid" ]]; then
    failures=$((failures + 1))
  fi
}

private_runner_is_authorized() {
  local url_validation

  if [[ "$RUNNER_HOST" != "$EXPECTED_PRIVATE_HOSTNAME" ]]; then
    printf "private_checks=fail reason=wrong_runner actual=%s expected=%s\n" "$RUNNER_HOST" "$EXPECTED_PRIVATE_HOSTNAME"
    failures=$((failures + 1))
    return 1
  fi

  url_validation="$(node -e '
    try {
      const target = new URL(process.argv[1]);
      const allowed = target.protocol === "http:"
        && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
      process.stdout.write(allowed ? "valid" : "invalid");
    } catch {
      process.stdout.write("invalid");
    }
  ' "$AUTH_MANAGER_DIRECT_URL")"
  if [[ "$url_validation" != "valid" ]]; then
    printf "private_checks=fail reason=non_loopback_url\n"
    failures=$((failures + 1))
    return 1
  fi

  printf "private_checks=authorized runner=%s url=loopback\n" "$RUNNER_HOST"
}

probe_safe_status_with_token() {
  local status

  if [[ -z "$AUTH_FORMS_API_TOKEN" ]]; then
    printf "auth_manager_safe_status skipped=no_token\n"
    return
  fi

  if ! status="$(curl -sS --max-time 12 -o /dev/null -w "%{http_code}" \
    -H "x-auth-token: $AUTH_FORMS_API_TOKEN" \
    "$AUTH_MANAGER_DIRECT_URL/api/system/status")"; then
    status="transport_error"
  fi
  printf "auth_manager_safe_status status=%s expected=200\n" "$status"
  if [[ "$status" != "200" ]]; then
    failures=$((failures + 1))
  fi
}

run_public_checks() {
  probe_discovery
  probe_login_start
  probe_status "dashboard_health" "$DASHBOARD_BASE_URL/api/health" "200"
  probe_status "dashboard_me_unauthenticated" "$DASHBOARD_BASE_URL/api/me" "401"
  probe_status "dashboard_shell_unauthenticated" "$DASHBOARD_BASE_URL/dashboard" "401"
  probe_status "modules_shell_unauthenticated" "$DASHBOARD_BASE_URL/modules" "401"
  probe_status "auth_manager_confirm_unauthenticated" "$DASHBOARD_BASE_URL/confirm/authorization-manager" "401"
  probe_status "auth_manager_proxy_unauthenticated" "$DASHBOARD_BASE_URL/api/legacy/auth-manager/" "401"
}

run_private_checks() {
  if ! private_runner_is_authorized; then
    return
  fi
  probe_status "auth_manager_direct_root" "$AUTH_MANAGER_DIRECT_URL/" "200"
  probe_status "auth_manager_direct_api_without_token" "$AUTH_MANAGER_DIRECT_URL/api/system/status" "401"
  probe_safe_status_with_token
}

if [[ "$SMOKE_SCOPE" == "public" || "$SMOKE_SCOPE" == "all" ]]; then
  run_public_checks
fi
if [[ "$SMOKE_SCOPE" == "private" || "$SMOKE_SCOPE" == "all" ]]; then
  run_private_checks
fi

if [[ "$failures" -gt 0 ]]; then
  printf "smoke=fail failures=%s\n" "$failures"
  exit 1
fi

printf "smoke=ok\n"
