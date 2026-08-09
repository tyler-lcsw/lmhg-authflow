# Dell Deployment

Authorization Manager is deployed on Dell as a private legacy service and is
accessed by staff through the staff dashboard, not through a standalone browser
OIDC client.

## Live Runtime

- Public staff entrypoint: `https://dashboard.lmhg.app/`
- Public login route: `https://dashboard.lmhg.app/api/login`
- ZITADEL issuer: `https://auth.lmhg.app`
- Staff dashboard OIDC client id: `374343961315180547`
- Staff dashboard ZITADEL project id: `374342710909206531`
- Staff dashboard redirect URI: `https://dashboard.lmhg.app/api/callback`
- Legacy dashboard route: `https://dashboard.lmhg.app/api/legacy/auth-manager/`
- Dell host-local service URL: `http://127.0.0.1:3100/`
- Dell dashboard upstream: `http://127.0.0.1:3100`
- Runtime data path: `/srv/primary/services/authorization-manager/data`
- Runtime token path: `/srv/primary/services/authorization-manager/secrets/api-token`

The SQLite database, uploads, generated output, and logs are PHI-bearing runtime
data. Do not open, query, dump, transform, summarize, or inspect their contents
during deployment or smoke checks.

Deletion uses the approved minimal-event design and a durable file-cleanup
outbox. Review [MINIMAL_DELETION_AUDIT.md](./MINIMAL_DELETION_AUDIT.md) before
running the destructive legacy-audit migration or approving backup disposition.

The container listens on `0.0.0.0:3000` inside its private Compose network so
Docker can forward traffic to it. The host publishes that port only as
`127.0.0.1:3100`; it must not be published on a LAN or Tailscale address.
Production requires the mounted API token. The explicit tokenless development
override (`AUTH_FORMS_ALLOW_TOKENLESS_LOOPBACK=1`) is loopback-only and is not
an approved Dell deployment setting.

Build from a clean, exact checkout and embed its revision in the image:

```sh
AUTH_FORMS_VCS_REF="$(git rev-parse HEAD)" docker compose -f deploy/dell/compose.yaml up -d --build
```

The resulting image label `org.opencontainers.image.revision` is safe release
metadata and must match the approved source commit.

## Auth Flow

ZITADEL authenticates users into the staff dashboard. The dashboard creates an
opaque HttpOnly application session, maps ZITADEL project roles to dashboard
roles, requires `authorization_operator` for the Authorization Manager module,
requires a short-lived session-bound ePHI
confirmation, and then proxies `/api/legacy/auth-manager/*` to Authorization
Manager while injecting the legacy `x-auth-token` server-side.

Do not create a separate Authorization Manager OIDC client for browser traffic.
The browser must not receive the legacy service token or any ZITADEL tokens.

Approved initial ZITADEL policy for staging users:

- public self-registration remains disabled;
- users, including administrators, are created administratively;
- the user's email address is their username;
- username/password login is the only initial authentication method;
- password resets are performed by an administrator, not through self-service;
- every temporary password must be replaced on first login; the API
  equivalent for ZITADEL v2 user creation is
  `human.password.changeRequired=true`;
- assign `authorization_operator` to the staging smoke user that needs
  Authorization Manager access; do not grant `developer` for this purpose;
- 2FA is intentionally deferred and will be added later as a ZITADEL policy;
  it is not silently treated as active during this password-only stage.

## Smoke Checks

Run the metadata-only public edge checks from any authorized workstation:

```sh
./deploy/dell/smoke.sh
```

The default public scope checks status codes, OIDC discovery, the exact login
redirect contract, and protected dashboard gates. It does not follow redirects
and it does not bypass TLS certificate verification.

Run private connector checks on Dell itself:

```sh
SMOKE_SCOPE=private ./deploy/dell/smoke.sh
```

The private scope refuses to run unless the short hostname matches
`dell-4229` and `AUTH_MANAGER_DIRECT_URL` is loopback. Use `SMOKE_SCOPE=all` on
Dell to run both sets. The helper never calls PHI-returning app APIs. If you
intentionally provide `AUTH_FORMS_API_TOKEN` in the environment, private scope
also checks the safe `/api/system/status` endpoint. Output records a UTC
timestamp, runner identity, source commit, scope, and sanitized expected/actual
results.

Final staging login smoke is manual because it needs a real ZITADEL session:

1. In ZITADEL, administratively create or select a non-PHI test user whose email
   address is the username, assign a temporary password, and require a password
   change on first login. Do not enable self-service password reset.
2. Assign the user the `authorization_operator` role in ZITADEL project
   `374342710909206531`.
3. Open `https://dashboard.lmhg.app/api/login`.
4. Complete the first-login password reset.
5. Confirm `/api/modules` shows `authorization-manager`.
6. Open `Authorization Manager`, accept the ePHI confirmation, and verify the
   app shell loads. Do not use a PHI API response as smoke evidence.
