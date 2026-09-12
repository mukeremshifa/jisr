# Decisions

Every deviation from the build brief, and everything installed. Each entry says
what was decided, why, and what it costs.

---

## Deviations from the brief

### 1. Slack transport: Web API primary, CopilotKit Channels for the conversation

**Brief:** "Manager channel: Slack via the CopilotKit Channels SDK… keep a plain
Slack Web API fallback behind one interface."

**Decision.** Both are implemented behind one `SlackTransport` interface
(`packages/integrations/src/slack/transport.ts`), and the two entry points the
brief specifies, `notifyManagers(case)` and `updateCaseCard(case)`, sit on top
of it, so swapping transports touches no caller.

The Channels Slack adapter turned out to expose `post`, `update` and
`onInteraction`, so proactive card posting through Channels is real, not a
theory: `apps/gateway/src/channels/runtime.ts` renders our Block Kit cards
through it with `Slack.Raw` when a Slack app token is configured. What Channels
does *not* allow is starting a Channel from inside our own process. A Channel is
runtime-driven (`ɵruntime` is marked internal) and is meant to be loaded by the
CopilotKit Channels runtime. So the conversational surface lives in
`apps/gateway/src/channels/jisr.channel.ts`, which that runtime loads, and the
Web API transport is the default for proactive posting.

**Cost.** Two code paths for posting. Mitigated by the single interface and by
both paths rendering the same Block Kit.

### 2. `/jisr broadcast` scoping differs between the two Slack paths

A Channels command handler replies into its own thread and is not given the raw
channel id. The HTTP command route (`/slack/commands`) does get one, so it scopes
the broadcast to that channel's site, exactly as the brief describes. Through
Channels, the target sites fall back to the requester's own FGA-allowed sites.
Both paths are still FGA-checked; the Channels path is simply less precise.

### 3. Task payloads use Zod's default strip, not `.strict()`

The brief asks for strict schemas that reject unknown keys. That is enforced at
every *external* boundary: model output, Slack button values, webhook bodies, and
the action catalog. Internal Trigger.dev payloads use Zod's default strip
behaviour, so unknown keys are dropped before a handler sees them, the same
protection, without the compile cost of `.strict()` on large nested objects.

### 4. `schemaTask` replaced by a thin `validatedTask` wrapper

`apps/worker/src/lib/task-kit.ts` wraps `task()` and parses the payload with Zod
inside `run`. The guarantee is identical, no task body sees an unvalidated
payload, and tasks reference each other by string id, which is what lets the
lifecycle be a cycle (intake → case → pay → case) without import cycles.

### 5. Static translations for three worker-facing strings

The emergency reply, the acknowledgement prompt and the yes/no prompt are
pre-translated in `packages/core/src/messages.ts` rather than generated. A
life-safety message must not wait on a model, and an acknowledgement prompt must
be identical every time so "OK" means the same thing.

**These translations need a native-speaker review before a real deployment.**
They were written at build time, not verified by a speaker of each language.

### 6. Break-glass identity reveal is not built

The brief lists it as a stretch goal. It is not implemented, and so **no UI path
reveals a speak-up identity**. `sealed_identities` is written by the speak-up task
and read only by the relay, at send time.

### 7. One company per Slack workspace

`DEFAULT_COMPANY_ID` resolves Slack interactions to a company, because a Slack
payload carries no tenant of its own. Multi-tenant Slack would key this off the
installation id. Everything else in the codebase is already multi-tenant: every
table carries `company_id`, and every query goes through `withTenant`.

### 8. Audio duration is estimated, not measured

`estimateAudioSeconds` derives seconds from bytes and a codec bitrate. Reading a
true duration needs a demuxer. The estimate over-counts rather than under-counts,
so the per-worker daily audio budget errs towards being strict.

### 9. The em dash ban is enforced by CI, and the middle dot ban is scoped

The client rejected em dashes by name in every surface. A one-time sweep does
not hold: the WhatsApp carrier commit reintroduced them the same week. So
`scripts/check-banned.ts` runs in CI beside gitleaks and fails the build on the
first em dash in any tracked file, and on the rejected fonts and icon libraries.
The sweep that preceded it touched 73 files. Each em dash was read in context
and replaced with a comma or a full stop, never a hyphen.

Two scoping decisions inside that guard:

- **The UI null placeholder was an em dash**, in seven dashboard files
  (`?? '-'` in tables). That is not punctuation, it is a "no value" mark in a
  ruled table, so it became an en dash, which the client did not ban.
- **The middle dot ban applies to prose and interface copy, not to drawings.**
  The ASCII architecture diagrams in `README.md` and `docs/architecture.md` use
  the dot as a separator inside a picture. The guard skips fenced code blocks
  for that rule only. Every real instance was removed, including the two the
  extension brief names: the layout header joining the actor name to sign-out,
  which is now a hairline, and the Slack card header meta.

### 10. `pnpm doctor` probes rather than reading environment variables

The brief asks for a doctor that means "demo ready". A check that only reads
`process.env` cannot say that, so where a call is cheap and has no side effect,
doctor makes a real one: it connects to the database and counts tables and RLS
policies, calls Slack `auth.test`, asks FGA for a relation it should deny, and
round-trips the crypto keys including a cross-key decryption that must fail.
Where a call would cost money or send a message to a worker (the models, the
WhatsApp carrier) it verifies the credentials are complete and says so.

Warnings never fail the run: a feature that is switched off is not a problem.
Only failures set a non-zero exit code.

---

## A bug worth recording

**Two zod versions in one workspace cost a 60-second typecheck.**
`packages/core` was pinned to `zod@3.24.1` while every other package used
`3.25.76`. Comparing schema types across the two copies took the compiler from
0.5M type instantiations to **10.5M**, and TS2589 "excessively deep" errors
landed on lines that had nothing to do with the cause. Pinning one version
(`pnpm.overrides.zod`) brought it back to 492K and under three seconds.

If a TypeScript build in this repo suddenly gets slow, check for duplicate copies
of a type-heavy dependency first.

---

## Bugs found by the hardening pass

Recorded because each one would have failed silently on stage:

1. **Buttons that needed words could never be pressed.** "Reply in my own words"
   and "Ask the reporter" carried empty text, which the action catalog correctly
   rejected, so the click did nothing. They now open a modal instead, and the
   text exists before the action is valid.
2. **Modal submissions had no tenant.** A Slack `view_submission` carries no
   channel or message, so the company could not be resolved and every modal
   reply was dropped. The company now travels in `private_metadata`.
3. **HR could not act on a speak-up report.** The check was `can_act`, which
   resolves through a site, and a speak-up case has none. It is now
   `can_view_speakup`, the same relation that let them see the report.
4. **Speak-up had no waitpoint at all**, so there was nothing for an HR button to
   complete. `speakup.await` now holds one, sharing the decision loop with
   `case.route`.
5. **The emergency card's "I am going now" button was un-pressable**: `assign`
   required a staff UUID the button could not know. Omitting it now means
   "assign to whoever clicked".
6. **A missing `TWILIO_AUTH_TOKEN` made every webhook 500** instead of rejecting
   it. Signature validation now returns a reason rather than throwing, and a
   deployment with no token rejects with a critical audit event.
7. **The audit helper could take down the request it was describing.** `getDb()`
   was a default argument, so it ran *before* the try/catch meant to contain it.
8. **`slackQuote` could exceed its own length cap** by appending an ellipsis past
   the limit. Caught by a unit test.
9. **Four high-severity transitive advisories** (`undici`, `ws`, via CopilotKit
   and Trigger.dev), pinned out with pnpm overrides rather than forking a
   sponsor SDK.

## Installed tooling

| What | Why |
|---|---|
| `pnpm` workspaces, TypeScript 5.9 strict, Vitest 3 | The stack the brief asks for |
| `gitleaks` (CI + config) | The repo is public; a leaked key is the one unrecoverable mistake |
| Dependabot | Weekly grouped updates, committed lockfile |
| `qrcode` | Sticker sheet generation (F1) |

No Claude Code skills, plugins or MCP servers were installed for this build. The
SDK surfaces that mattered (Trigger.dev v4 waitpoints and queues, CopilotKit
Channels, the Auth0 Next.js SDK v4, CopilotKit's runtime) were verified by
reading the installed packages' own type definitions, which is the same source a
docs server would summarise and is current by construction.

---

## Versions pinned

Sponsor SDKs and security-critical libraries are pinned to exact versions:

```
@trigger.dev/sdk 4.5.16      openai 7.15.0          twilio 6.1.1
@copilotkit/* 1.71.0         @copilotkit/channels 0.9.2
exa-js 2.19.0                @openfga/sdk 0.9.7     @auth0/nextjs-auth0 4.29.0
@modelcontextprotocol/sdk 1.30.0
sharp 0.35.4                 file-type 22.0.2       zod 3.25.76 (overridden)
```

Model ids are **not** pinned in code: they come from env
(`OPENAI_REASONING_MODEL`, `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_TTS_MODEL`,
`OPENROUTER_FALLBACK_MODELS`), with documented defaults in
`packages/core/src/config.ts`.

---

## Things deliberately not built

Proof-of-fix loop, heat autopilot, incident clustering, payslip explainer, voice
commands, round-trip translation check, phone-call fallback, Microsoft Teams,
face blurring, data export. The interfaces are open for them: the action catalog
takes new entries, the language matrix is data, and the transport interface would
take a Teams adapter without touching a caller.
