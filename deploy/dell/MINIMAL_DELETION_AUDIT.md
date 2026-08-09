# Minimal Deletion Audit

## Approved choice

Deletion uses a minimal event record plus operational removal of the generated
authorization file. The purpose is to prove that a deletion occurred without
retaining enough information to reconstruct the deleted authorization.
The same rule applies when an authorization is deleted directly or as part of
deleting its client: each authorization produces its own minimal event.

This is data minimization, not de-identification. `auth_request_id` and
`trace_id` remain regulated, linkable metadata and must stay within the same
restricted Dell boundary as the rest of Authorization Manager.

## Durable audit record

`auth_request_deletions` retains only:

- an audit event ID;
- the deleted authorization ID;
- the deletion timestamp; and
- a server-validated trace UUID.

It deliberately excludes client identifiers, form payloads, clinical status,
fax metadata, IntakeQ state, PDF paths, request IP addresses, and user-agent
strings. Arbitrary client-provided trace text is rejected so it cannot become a
new payload-storage channel.

A trusted staff subject is not yet retained. That field must not be added until
the dashboard and Authorization Manager share a signed actor assertion with
issuer, audience, request binding, expiry, key rotation, and replay protection.

Until that contract exists, the production launch configuration denies every
API `DELETE` request before route or database lookup and hides the corresponding
UI controls. The minimal deletion audit remains tested and available for a
future controlled re-enable; it is not sufficient by itself to authorize
destructive actions at initial go-live.

## File cleanup outbox

The audit table never stores a PDF path. A separate
`auth_request_file_cleanup` outbox may hold the managed path only while file
removal is pending. Deletion and outbox creation occur in one serialized SQLite
transaction on a dedicated database connection, so unrelated request writes
cannot be absorbed into its commit or rollback. The service then:

1. confirms the path is inside the configured output directory;
2. removes the file, treating an already-missing file as complete;
3. removes the outbox row after success; or
4. retains attempts, last-attempt time, and a non-sensitive error code for a
   later retry.

`/api/system/status` exposes only the pending cleanup count, never paths or
payloads. Startup retries pending cleanup before the service begins listening.

## Legacy migration

On first startup against the legacy schema, the application rebuilds the audit
table with the four approved columns, preserves the event ID, authorization ID,
and timestamp, and clears legacy trace text because it was not previously
server-validated. It then enables SQLite secure deletion, checkpoints/truncates
the WAL, and vacuums the active database. A migration failure prevents the
production listener from starting.

The migration is destructive to the duplicated legacy audit payload. Deployment
must therefore be an explicit operator-approved step. Before deployment, record
the disposition of snapshots, image backups, exported databases, logs, and
rollback media. Do not create another unapproved PHI-bearing backup merely to
run the migration, and do not retain rollback media that would silently restore
the prohibited audit payload.

The migration changes the active SQLite database only. It cannot purge copies
held in external backup systems or Git history.

## Retention still required

Minimal rows are not permission to retain them forever. The privacy/security
owner still needs to approve a retention period and purge authority based on
the organization's legal, contractual, investigation, and incident-response
requirements. Until that decision is recorded, do not add an automatic
time-based purge that could destroy required security evidence.

## Synthetic verification

Automated tests use temporary SQLite databases and synthetic markers to prove:

- the legacy payload columns and marker bytes are removed from the active
  database and WAL/journal files;
- one concurrent deletion creates exactly one audit event;
- managed PDFs are removed and successful outbox rows are cleared;
- cleanup failures remain visible and retryable;
- failed migrations do not start the service; and
- live PHI, PDFs, uploads, backups, or logs are never needed for verification.
