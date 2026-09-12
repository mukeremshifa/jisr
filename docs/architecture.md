# Architecture

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

## The shape of it

**The gateway is thin on purpose.** `apps/gateway` validates the Twilio
signature, deduplicates on `MessageSid`, rate-limits the sender, writes one row
and enqueues a task. It never calls a model, so it always answers Twilio inside a
second. Everything slow or flaky happens where it can be retried.

**Everything else is a Trigger.dev task.** Retries, timeouts and a trace come for
free, and the run is visible when something goes wrong on stage.

**Order matters, so it is enforced.** Intake runs on a queue with
`concurrencyKey = workerId`: one worker's messages are processed strictly in
order, while different workers run in parallel. Without that, a worker's "yes"
can overtake the read-back it answers.

**Every human wait is a waitpoint token with a timeout.** A manager decision is a
completed token; an SLA breach is the same token timing out. There is no polling
loop and no scheduled sweep looking for late cases. The timeout *is* the SLA.

```
case.route
  ├─ post the card to Slack
  ├─ create a waitpoint token with timeout = the SLA
  └─ wait
       ├─ completed  → apply the decision (allowlisted action, FGA-checked)
       └─ timed out  → escalate, tell the worker, wait once more on a longer token
```

**Slack has exactly two entry points.** `notifyManagers(case)` and
`updateCaseCard(case)`. Both sit on a `SlackTransport` interface with two
implementations (CopilotKit Channels, and the Slack Web API), so swapping
transports touches no caller. See `docs/decisions.md`.

## The voice-note pipeline

```
inbound:   Twilio media  →  magic-byte allowlist  →  sharp re-encode (EXIF gone)
           →  private GCS  →  transcribe (language hint from the roster)
           →  emergency pre-check  →  one structured understand call

outbound:  text  →  TTS in the worker's language (matrix decides the engine)
           →  OGG/Opus  →  private GCS  →  short-lived signed URL  →  Twilio
```

No realtime or live-translation model is used for voice notes. One transcription,
one structured call, one synthesis: each step is separately retryable, and each
one's output is stored.

## Where the decisions live

| Decision | Where |
|---|---|
| What a message means | one structured call, `packages/ai/src/prompts/understand.ts` |
| What a manager may do | the allowlisted catalog, `packages/core/src/actions.ts` |
| Who may do it | Auth0 FGA, checked before the waitpoint is completed |
| What a case may become | the state machine, `packages/core/src/state-machine.ts` |
| How much a correction is | `packages/core/src/pay.ts`, integers only, server-side |
| Which voice speaks a language | the matrix, `packages/core/src/languages.ts` |

Note what is *not* in that list: nothing a model produced decides anything on its
own. A model suggests actions by name from a fixed catalog; every parameter is
re-validated server-side, and a human presses the button.

## Tenancy

Every tenant table carries `company_id`, and every query goes through
`withTenant(companyId, …)`, which opens a transaction and sets `app.company_id`
so Postgres row-level security enforces the same boundary a second time. There
is exactly one deliberate cross-tenant read: the Twilio webhook has a phone
number and must find which company it belongs to. It reads one indexed column and
returns ids.

## Failure

| What fails | What happens |
|---|---|
| OpenAI | OpenRouter answers, and the log says which model did |
| Every model | the raw transcript reaches a human, badged "needs review" |
| Twilio retries a webhook | the `MessageSid` unique index makes it a no-op |
| Google TTS has no voice | OpenAI speaks it, and the fallback is logged |
| Speech synthesis fails entirely | the text still goes out; the failure is loud |
| Slack is unreachable | the task retries; the case is already stored |
| Ambiguous MCP is down | the approval stands, the row is not written, and Slack says so |
| A pay payload changed after approval | execution aborts, critical audit event |
| A model call is not configured | the call throws; nothing is faked |
