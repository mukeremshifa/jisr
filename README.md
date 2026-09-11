# Jisr

**Jisr** (Arabic جسر, "bridge") is an AI agent that sits between frontline
workers and their managers. Workers stay on WhatsApp, in their own language, with
voice notes and photos and a QR sticker on a door — many of them don't read
comfortably, and Jisr never asks them to. Supervisors and HR stay in Slack, where
a messy multilingual voice note has already become a structured case card with
two or three buttons on it. Jisr routes each case to the right people, relays
their decision back as a voice note in the worker's language, and follows up
until it's closed. The rule we held ourselves to throughout: **every feature
removes a step for someone and never adds one.** Workers install nothing, read
nothing and fill in nothing; managers decide with one tap; all the complexity
lives inside the agent.

Built for the UAE, where the workforce is WhatsApp-first and deeply multilingual,
and where the labour rules are specific — the midday outdoor-work break from
15 June to 15 September, 12:30–3:00 PM, is in the handbook Jisr answers from.

---

## Architecture

```
 Workers (WhatsApp)                                              Supervisors / HR (Slack)
  voice · photo · text · location · sticker code                   cards · buttons · threads
        │                                                                     ▲
        ▼                                                                     │
 Twilio ──webhook──▶ Gateway (Hono, Cloud Run) ──trigger──▶ Trigger.dev tasks ─┤
        ▲            validate · dedupe · persist            intake · case lifecycle
        │            hosts the Channels runtime             broadcast · speak-up relay
        └── voice notes (signed GCS URLs) ◀──────────────── pay approval · execution
                                                                   │
        OpenAI · OpenRouter · Google TTS · Exa · Auth0 (FGA + CIBA) · Ambiguous (MCP)
                          Postgres (Neon) · Google Cloud Storage (private)

 HR / ops ──▶ Ops dashboard (Next.js + CopilotKit, Cloud Run) ──▶ same database, same FGA checks
```

Three decisions shape everything else, and `docs/architecture.md` explains them
properly:

- **The gateway is thin.** It validates the Twilio signature, deduplicates on
  `MessageSid`, rate-limits, stores one row and enqueues. It never calls a model,
  so it always answers Twilio inside a second.
- **Every human wait is a waitpoint token with a timeout.** A manager decision is
  a completed token; an SLA breach is that same token timing out. No polling, no
  sweep job looking for late cases.
- **A worker's messages are processed in order.** Intake runs on a queue keyed by
  worker id, so a "yes" can never overtake the read-back it answers.

---

## What each sponsor does here

| Sponsor | What it actually does in Jisr |
|---|---|
| **OpenAI** | Transcribes voice notes with the worker's roster language as a hint; the one structured "understand" call that turns a transcript into a case; vision for reading hours off a timesheet photo; speech for the reply |
| **OpenRouter** | The fallback chain. When OpenAI errors or times out, the same Zod schema is enforced against an ordered list of models, and the log records which one answered |
| **CopilotKit** | Channels carries the manager surface in Slack — the `/jisr` command, case-card interactions, replies in a thread — and the dashboard's "Ask Jisr" sidebar, whose tools run as the signed-in user |
| **Trigger.dev** | Every piece of agent work. Queues with a per-worker concurrency key, waitpoint tokens as SLAs, idempotency keys for Twilio retries and broadcast fan-out, and a trace when something goes wrong on stage |
| **Auth0** | Universal Login for the dashboard; **FGA** for every authorization decision, failing closed; **CIBA** for the second pay approval, on HR's phone, with the payload hash in `authorization_details` |
| **Exa** | Grounds policy answers in official UAE sources, restricted to an allowlist of domains that is enforced in the request *and* again on every result |
| **Ambiguous** | The payroll adjustments sheet an approved correction is written to, and case task mirroring — over MCP, calling `tools/list` first rather than guessing tool names |
| **Google Cloud** | Cloud Run for both services, a private GCS bucket for all media with V4 signed URLs, and Chirp 3 HD voices for the languages the matrix routes to Google |
| **Mozilla.ai** | Not integrated. `any-guardrail` for PII detection was the last item on the list and the build window ended first |

---

## Running it locally

```bash
pnpm install
cp .env.example .env          # then fill it in — see below
pnpm db:migrate               # Drizzle migrations, then roles and RLS
pnpm seed                     # prints DEFAULT_COMPANY_ID and the staff ids

pnpm dev:gateway              # Hono on :8080
pnpm dev:worker               # Trigger.dev tasks
pnpm dev:dashboard            # Next.js on :3000
```

**The minimum to see a voice note become a Slack card:** `DATABASE_URL`, the
three 32-byte crypto keys (`openssl rand -base64 32` each), `OPENAI_API_KEY`,
the four `TWILIO_*` values, `TRIGGER_SECRET_KEY`, `GCS_BUCKET`,
`PUBLIC_GATEWAY_URL`, and either `SLACK_BOT_TOKEN` or `INTELLIGENCE_API_KEY`.

After seeding, set `DEFAULT_COMPANY_ID`, fill in `fga/tuples.json` from the staff
ids the seed prints (see `fga/README.md`), and point each site's Slack channel at
a real channel.

**Point Twilio at it.** Inbound → `PUBLIC_GATEWAY_URL/webhooks/twilio/whatsapp`,
status callback → `/webhooks/twilio/status`.

```bash
pnpm typecheck          # the whole workspace, including the dashboard
pnpm test               # 101 unit and integration tests
pnpm stickers           # writes an A4 sticker sheet to tmp/stickers.html
pnpm language-test      # renders one sentence through both TTS engines, per language
```

Real phone numbers go in `seed/roster.local.csv`, which is gitignored. The
tracked `roster.example.csv` contains reserved test numbers only.

---

## When things fail

| What fails | What the user experiences |
|---|---|
| OpenAI is down or slow | Nothing visible. OpenRouter answers; the log records which model did |
| Every model provider is down | The worker's report still reaches a human — the raw transcript, badged "needs review" |
| A transcript is garbled | "I couldn't hear that clearly. Please send it again as a voice note." |
| Speech synthesis fails | The text still goes out. A worker who can't read gets less, but the failure is in the logs, not silent |
| Google has no voice for a language | OpenAI speaks it instead, and the fallback is logged |
| Twilio retries a webhook | Nothing happens twice. The `MessageSid` unique index makes the retry a no-op |
| Slack is unreachable | The task retries. The case is already stored and shows on the dashboard |
| Nobody answers a case | The waitpoint times out: the escalation channel gets the card, and the worker is told it's with a senior manager |
| The worker never answers a question | After 30 minutes the case routes anyway, badged "unconfirmed" |
| A worker floods the number | 20 messages an hour, 600 audio seconds a day. One notice, then silence, and an audit event |
| The company's daily token budget trips | "HR will review this", and ops is alerted. Jisr stops calling models rather than spending |
| An unknown number messages | One reply an hour: "This number is for <Company> staff." Nothing reveals whether a number is on the roster |
| An unrecognised sticker is scanned | "I don't recognise this sticker. Tell me where you are." — plus an audit event, because it may mean tampering |
| Somebody tries to talk Jisr out of its rules | The case is flagged and audited, and nothing changes. The worker-facing agent has no tool that can approve, pay, reveal or close |
| A pay amount changes after approval | Execution aborts, a critical audit event is written, and Slack says so. Nothing is paid |
| No second approver exists for a pay correction | It stays pending and says so. There is no fallback to one person approving twice |
| Ambiguous is unreachable at execution | The approval stands, the row isn't written, and the Slack thread says exactly that |

---

## Security

The repository is public and the product handles workers' personal data, so:
phone numbers are AES-256-GCM encrypted and looked up by HMAC; speak-up
identities are sealed under a **separate** key and decrypted only to deliver a
reply; every authorization decision goes through Auth0 FGA and **fails closed**;
uploads are allowlisted by magic bytes and re-encoded so EXIF never reaches
storage; amounts are computed server-side and bound to approval by a SHA-256;
and every query runs inside a tenant-scoped transaction with Postgres row-level
security behind it.

Full detail, including the Auth0 tenant checklist: **[`docs/security.md`](docs/security.md)**.

---

## Built during the hackathon

Started from an empty repository at the event. The milestone commits:

| Milestone | What worked at that commit |
|---|---|
| **M0** | Monorepo, CI with gitleaks and a dependency audit, the database schema with least-privilege roles and RLS, and the thin gateway validating Twilio signatures |
| **M1** | **First light.** A WhatsApp voice note becomes a structured English case card in the right Slack channel, via Trigger.dev, with an OpenRouter fallback that can be forced from env |
| **M2** | Clarify, read-back, one-tap actions, the voice reply, SLA escalation, broadcasts with acknowledgement tracking, the emergency path, the first-contact notice, and F1 tap-to-report |
| **M3** | F2 speak-up with a sealed identity, F3 two-person pay with CIBA and hash binding, and F4 the ops dashboard with "Ask Jisr" |
| **M4** | Hardening: fail-closed webhook validation, the audit path made non-fatal, high-severity transitive advisories pinned out, three failure drills, and the docs |

`git log --oneline` shows them in order.

---

## Also in `docs/`

- [`architecture.md`](docs/architecture.md) — how the pieces fit, and where each decision lives
- [`security.md`](docs/security.md) — the full security posture and the Auth0 checklist
- [`decisions.md`](docs/decisions.md) — every deviation from the brief, and why
- [`demo-script.md`](docs/demo-script.md) — the two-minute storyboard
- [`social-post.md`](docs/social-post.md) — a draft post for after the demo

---

Jisr always identifies itself as an assistant, never as a person, and never
promises an outcome a manager hasn't decided.
