# Secrets handling procedure

No credentials are supplied or created by SV-017. `.env` and `.env.*` are ignored except examples;
Git ignore is only an accident barrier. Never place values in commits, PRs, board claims, shell
history, screenshots, browser code/storage, telemetry samples or support transcripts. Do not use
real identities, equipment-operation records or patient-linked information in fixtures.

## Inventory before choosing hosting

| Material | Intended boundary | Owner decision |
| --- | --- | --- |
| Migration/backup database credential | Protected operator process only | DB owner chooses existing privileged identity and approval workflow |
| Runtime DB credential | Server secret injection only | DB owner approves existing least-privilege non-owner role |
| OIDC verifier configuration | Server; issuer/audience/JWKS are configuration, signing/private client material remains secret | Identity owner selects reviewed provider, algorithms, transport and key rotation |
| Device/source verification material | Trusted server/provider adapter | Integration owner selects provisioning, scoped revocation and source rotation |
| User session token | Approved session transport only | Identity owner decides expiry, logout/revocation, refresh and browser protections |
| Rejection journal, backup and log access | Private storage/operator boundary | Operations owner decides encryption, ACLs, retention and access auditing |
| Deployment token | Existing approved operator/CI boundary | Deployment owner chooses scoped short-lived access; no setup here |

Core/auth/ingestion migration commands read `DATABASE_URL` as described in their own docs. These
values must never reach frontend configuration. The static demo needs no database secret. The
recovery drill ignores inherited PGDATABASE and overrides its own loopback routing; it refuses
DATABASE_URL, PGSERVICE, PGSERVICEFILE, PGOPTIONS and PGHOSTADDR. Use an existing protected
`PGPASSFILE` for its approved disposable-cluster identity if authentication requires it. Do not put
a password in command arguments. The drill prints only safe failures, generated cleanup targets
and aggregate hashes; it does not echo libpq stderr or environment variables.

## Owner-operated rotation

1. Inventory where the existing secret is consumed and who can rotate it. Record only secret
   identifiers/version references and owner, never values. Decide whether overlap is safe; if a
   compromise is suspected, immediate revocation may require an outage.
2. Using the chosen provider's authorized secret-management procedure, the owner rotates the
   credential/key and updates protected server injection. No CLI here creates roles, passwords,
   grants, service accounts or persistent access. Confirm runtime privileges remain unchanged.
3. Refresh/restart consumers through the reviewed release process, draining old database pools
   and checking identity/JWKS caches as applicable. Confirm authorized synthetic operations work
   and unauthorized requests remain rejected. A provider adapter must still ignore token-supplied
   roles and tenant assertions; membership is read from the database.
4. Revoke the old material and verify it no longer authenticates. For source keys, re-sign a
   legitimate retry with fresh transport nonce/time and unchanged semantic idempotency key;
   do not prune nonce/receipt history. Token expiry, logout and key revocation are distinct:
   verify actual provider behavior instead of assuming revocation invalidates every cached token.
5. Inspect secret scanning, error logs, build artifacts and monitoring for accidental exposure
   without printing values. Record the rotation version, validation, revocation result and owner.
   If rollout fails, roll forward with valid material; never reactivate a compromised key.

The current local identity and source adapters use temporary in-memory test material and reject
production. They do not implement these hosted rotation steps. A hosted rehearsal remains a gate.

## Exposure response

The incident primary informs the security/secret owner through the approved escalation route.
That owner revokes affected material, limits access, investigates logs and unauthorized activity,
and rotates every affected consumer. Removing a file or rewriting history does not revoke a key.
Preserve minimized incident evidence under approved access controls. Do not share raw requests,
bearer tokens, signatures, SQL errors or backup contents to diagnose the issue.
