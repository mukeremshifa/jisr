# Security

The repository is public and the product handles frontline workers' personal
data. Everything here is a requirement, not an extra.

---

## Transport and headers

**Gateway** (`apps/gateway/src/middleware/security.ts`) uses Hono `secureHeaders`:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains`
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`
- `Permissions-Policy` disabling camera, microphone and geolocation
- **No CORS headers at all.** The gateway is server-to-server only.
- No static file serving, no `/admin`, no `/debug`, no stack traces in responses.
  Unknown routes return a bare 404; errors return a bare 500 and log the detail.
- Request bodies are capped at 64 KB on `/webhooks/*` and `/slack/*`.

**Dashboard** (`apps/dashboard/next.config.ts` + `middleware.ts`) carries the same
header set, plus a **per-request nonce CSP** with no `'unsafe-inline'` for
scripts and no third-party script origins. `img-src`/`media-src` allow
`storage.googleapis.com`, which is where signed URLs point.

---

## Webhooks

- **Twilio:** every inbound and status webhook is signature-validated against the
  exact public URL, built from `PUBLIC_GATEWAY_URL`, a value we control, rather
  than from the `Host` header, which an attacker could set. Failures are audited
  and answered with a bodyless 403.
- **Replay:** `messages.provider_sid` is unique. A retried webhook inserts
  nothing and enqueues nothing.
- **Idempotency:** the intake task is triggered with `idempotencyKey =
  intake:<MessageSid>`; broadcast fan-out uses `broadcastId:workerId`; pay
  execution uses the adjustment id.
- **Slack:** the Web API path verifies the signing secret and rejects anything
  older than five minutes (`packages/integrations/src/slack/verify.ts`).
  Interactions arriving through CopilotKit Intelligence are verified by the
  Channels runtime.

---

## Authentication and authorization

Login is **Auth0 Universal Login**. Jisr contains no password handling of its
own: no hashing, no reset links, no lockout logic.

### Auth0 tenant configuration

These are settings, not code. Apply them in the Auth0 dashboard:

- [ ] **Disable public sign-ups** on the database connection. Invite-only access
      also removes the user-enumeration surface.
- [ ] **Brute-force protection** on (locks an account after repeated failures).
- [ ] **Suspicious IP throttling** on.
- [ ] **Breached password detection** on.
- [ ] **Bot detection** on for the login flow.
- [ ] Keep the default password-reset link expiry.
- [ ] Add a **post-change-password Action** that revokes the user's sessions and
      refresh tokens.
- [ ] CIBA: a **separate application** with the CIBA grant enabled, and HR
      approvers enrolled in Guardian push.

### Sessions

Auth0 Next.js SDK v4, configured in `apps/dashboard/lib/auth0.ts`: `HttpOnly`
(always, by the SDK), `Secure` in production, `SameSite=Lax`, encrypted with
`AUTH0_SECRET`, **8-hour absolute lifetime**, non-rolling.

### CSRF

Three layers: `SameSite=Lax` cookies; Next.js's built-in Server Action origin
check narrowed to `APP_BASE_URL`; and an explicit `Origin` check on every
non-idempotent request in `middleware.ts`.

### Authorization

Every API route, server action, page and copilot tool checks **Auth0 FGA** for
the acting user, derived from the session. A role, a site or a company id sent
by a client is never read.

**FGA fails closed.** An unconfigured store, a network error or an unknown
relation all return `false` (`packages/integrations/src/auth0/fga.ts`). A check
that cannot be answered is a check that failed. This is unit-tested.

**Record access:** every record fetched by id is FGA-checked, which is what stops
an insecure direct object reference. Public ids are random
(`packages/core/src/ids.ts`, a Crockford-style alphabet, never sequential), but
randomness is not authorization, and the check is what protects the record.
"Not found" and "not allowed" return the same answer.

**Speak-up is checked with `can_view_speakup`, never `can_view`.** A supervisor
holds `can_view` on every case at their site; a speak-up report may be *about*
that supervisor.

---

## Data protection

### Field encryption

AES-256-GCM with a random 12-byte IV, stored as `[IV][tag][ciphertext]` in one
`bytea` column (`packages/db/src/crypto.ts`). Two independent keys:

| Key | Protects |
|---|---|
| `DATA_ENCRYPTION_KEY` | worker phone numbers |
| `SEALING_KEY` | speak-up reporter identities |
| `PHONE_HMAC_KEY` | HMAC-SHA256 lookup value for phones |

Leaking one must not unseal the other, so they are never interchangeable, and
unit-tested. Keys load from Secret Manager in production and must decode to
exactly 32 bytes or the process refuses to start.

A phone number is decrypted in exactly one place: `sendToWorker`, at send time.

### Database roles

- `jisr_migrator` runs DDL, used only by `pnpm db:migrate`.
- `jisr_app` has SELECT/INSERT/UPDATE on app tables, **INSERT-only on `audit_log`**,
  no DDL, no DELETE except on `rate_limits`. See
  `packages/db/sql/0001_roles.sql`.

### Tenant isolation

1. **Mandatory:** every query goes through `withTenant(companyId, …)`, which
   requires a company id and filters on it.
2. **Then:** Postgres row-level security on every tenant table with
   `company_id = current_setting('app.company_id')`, set with `SET LOCAL` inside
   that same transaction (`packages/db/sql/0002_rls.sql`).

### Input and output

- **Parameterized queries only.** Drizzle's query builder throughout; no
  `sql.raw` with user data anywhere.
- **Validated at every boundary** with Zod: webhooks, the dashboard API, task
  payloads and model output. External boundaries reject unknown keys; internal
  task payloads strip them.
- **Sanitized before storing:** NFC normalisation, control and bidi characters
  stripped, lengths capped. Text is stored as text, never HTML.
- **Escaped on output:** React's escaping, no `dangerouslySetInnerHTML`
  anywhere. In Slack, `&`, `<` and `>` are escaped and invisible characters
  removed, so worker text cannot fire `@channel` or disguise a link.
- **Trimmed responses:** per-role DTO mappers (`apps/dashboard/lib/dto.ts`). No
  raw row, phone number, reporter token or encrypted column ever leaves the
  server.

---

## Uploads

- **Allowlist:** `image/jpeg`, `image/png`, `image/webp`, `audio/ogg`,
  `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/amr`. Checked against both the
  declared type **and** the actual magic bytes (`file-type`). Everything else,
  including PDFs, is rejected with a friendly message and an audit event.
- **Sizes:** images 10 MB, audio 16 MB, audio longer than 180 seconds refused.
- **Images are re-encoded** with `sharp` (`rotate()` first, then output without
  metadata), so EXIF, including GPS, never reaches storage. This matters most
  for speak-up, where a location can identify a reporter.
- **Storage:** random opaque keys in a private bucket with uniform bucket-level
  access and public access prevention enforced. Served only through V4 signed
  URLs: 10 minutes for the dashboard, at most 1 hour for Twilio to fetch.

---

## The AI layer

- Prompts are versioned and carry an untrusted-content boundary. Transcripts,
  text read from images and Exa results are wrapped in `<untrusted_content>`
  tags, and a transcript cannot close its own boundary. The tag is neutralised
  inside the content.
- **Tool segregation.** The worker-facing agent can create and confirm its own
  case, ask questions and answer policy questions. It has no tool that approves,
  pays, reveals, broadcasts or closes. The dashboard copilot has read tools plus
  one that fills a composer; it cannot send, approve, reveal or delete.
- **Output validation.** Strict Zod schemas and enums. One repair attempt, then a
  human.
- **Data minimisation.** Phone numbers and Emirates ID numbers are scrubbed from
  every model input.
- **Usage caps** (all env-configurable): 20 inbound messages per worker per hour,
  600 audio seconds per worker per day, 180 seconds per message, 10 MB per image,
  `max_tokens` on every call, and a per-company daily token budget with a circuit
  breaker that replies "HR will review this" and alerts ops.
- **Injection handling.** A heuristic plus the model's own flag set
  `cases.injection_suspected`, badge the card and write an audit event. Content
  never grants privileges. The real defence is that the worker-facing agent has
  no privileged tools at all.

---

## The two-person rule (F3)

1. Two **distinct** humans approve. The HR approver is selected by excluding the
   step-1 supervisor by staff id **and** by email, because one person can hold
   two staff rows. If no distinct approver exists, the correction stays pending
   and Slack says so. There is no fallback to one person.
2. **Amounts are computed server-side** from the roster rate and a configured
   multiplier, in integer fils. The model reads hours from a photo; it never
   reads or produces money.
3. **The hash binds approval to execution.** The canonical payload is hashed,
   the hash travels in the CIBA `authorization_details`, and it is recomputed at
   execution. A mismatch aborts the payment and writes a critical audit event.
4. **The dashboard can show pay approvals but cannot approve them.**
5. **The worker-side agent has no pay tools.**

---

## Secrets and supply chain

- Secrets stay server-side: Secret Manager for Cloud Run, Trigger.dev environment
  variables for tasks. Nothing secret is ever in `NEXT_PUBLIC_*`.
- Logs redact secret-shaped keys and PII-scrub free text
  (`packages/core/src/logger.ts`). Phone numbers are logged as their HMAC.
- `.env*` is gitignored from the first commit; only `.env.example` is tracked, and
  every value in it is empty.
- **gitleaks** runs as a CI step with a config that also catches non-empty
  assignments to known secret variables and UAE-shaped phone numbers.
- Enable **GitHub secret scanning and push protection** on the repository.
- Real phone numbers live only in `seed/roster.local.csv`, which is gitignored.
- `pnpm audit --prod --audit-level=high` in CI, a committed lockfile, Dependabot,
  and exact pins for sponsor SDKs and security-critical libraries.
- Cloud Run service accounts get only the roles they need. To sign URLs without a
  key file, the service account needs **Service Account Token Creator on itself**.

**If anything leaks, rotate it immediately.** Rewriting git history is not enough
once a repository is public.

---

## Logging and monitoring

Security events go to `audit_log` *and* to structured JSON logs:

signature failures, auth failures, FGA denials, rate-limit hits, suspected
injections, unknown sticker codes, rejected media, pay requested, approved,
denied, expired, executed, any pay hash mismatch, emergency detections,
token-budget trips, admin changes.

Never logged: secrets, phone numbers (the HMAC instead), and anything that
identifies a speak-up reporter.

---

## Deliberately not built

Payment webhooks and server-side prices (there are no payments; the same
principles are applied to Twilio webhooks and pay amounts), a browser-visible
database key (the browser never talks to the database), and password hashing,
reset links, enumeration defences, account lockout and session reset on password
change, all of which the Auth0 configuration above handles.

The speak-up **break-glass reveal is not implemented**, so no UI path reveals a
reporter's identity.

---

## Verified, not asserted

The checks below were run against the built code, not just written down.

| Check | Result |
|---|---|
| Unknown route on the gateway | `404`, empty body |
| Unsigned Twilio webhook | `403`, empty body, audited |
| Twilio webhook when `TWILIO_AUTH_TOKEN` is missing | `403` with a **critical** audit event. It fails closed, it does not 500 |
| Unsigned Slack interactivity | `403`, audited |
| Body over 64 KB on a webhook | `413`, refused before parsing |
| Gateway response headers | CSP `default-src 'none'`, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and **no** `Access-Control-*` |
| Audit write with no database | The request still completes; the failure is logged loudly |
| FGA with no store configured | Every check returns `false`; `assertCan` throws |
| A speak-up ciphertext against the phone key | Throws, because the keys are not interchangeable |
| `pnpm audit --prod --audit-level=high` | Clean (four high-severity transitive advisories fixed with pinned overrides) |

Re-run them with `pnpm test`, and the gateway ones by booting it and curling the
paths in the table.
