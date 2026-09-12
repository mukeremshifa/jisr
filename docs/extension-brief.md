# Jisr, extension brief: design pass and the remaining features

> This is the v2 extension brief, re-derived against the repository as it
> actually stands on 2026-09-12. The original was written against an imagined
> M2 checkpoint and several of its assumptions are false here. Where it and
> this document disagree, this document is right, and section 1 says why.
>
> If you are a fresh session: read this file, then `README.md`,
> `docs/decisions.md`, `packages/core/src/config.ts`, `packages/db/src/schema.ts`
> and `packages/integrations/src/slack/blocks.ts`. Do not trust the README's
> milestone table as a description of the commit history (section 1.4).

---

## 0. Prime directive

The core loop already works. **Nothing in this document may break it.** A judge
watching the two minute video must see a worker's voice note become a Slack card,
a manager's tap become a voice note back, and a broadcast get acknowledged. If
any change in here puts that at risk, switch the change off behind its flag and
move on.

Three rules that override everything below:

1. **Every addition ships behind a feature flag**, default off in `.env.example`,
   turned on only after it works. One flag per part: `FEATURE_PROOF_OF_FIX`,
   `FEATURE_HEAT_AUTOPILOT`, `FEATURE_VOICE_COMMANDS`, `FEATURE_CLUSTERING`,
   `FEATURE_DOC_EXPLAINER`, `FEATURE_BACKTRANSLATE_CHECK`, `FEATURE_PAYDAY_CHECK`,
   `FEATURE_CALL_FALLBACK`, `FEATURE_BREAK_GLASS`, `FEATURE_GUARDRAIL_PII`,
   `FEATURE_WALL_BOARD`, `FEATURE_AGENT_TRACE`, `FEATURE_TEAMS`.
2. **Migrations are additive only.** New tables and nullable columns. Never drop
   or rename a column the core loop reads, and never rewrite the tenant pattern:
   every write still goes through `withTenant()`.
3. **Commit after each part**, with `pnpm typecheck` and `pnpm test` green. If a
   part is not finished, commit it switched off and move to the next one.

Do not refactor working code for taste. Do not rename environment variables. Do
not restructure folders.

---

## 1. Where the project actually is

The original brief says to start this pass "once M2 is green". That is stale.
Read this section before planning anything.

### 1.1 What is already built

Past M4, not M2. Working today: the full intake loop (transcribe, understand,
clarify, read back, route), one-tap actions from a fixed catalog, the voice
reply, SLA escalation through waitpoint tokens, broadcasts with acknowledgement
tracking, the emergency path, F1 tap-to-report with QR stickers, F2 speak-up with
a sealed identity, F3 two-person pay with CIBA and hash binding, and F4 the ops
dashboard with "Ask Jisr". Then a hardening pass, three failure drills, and the
docs.

Since the v2 build, one further commit added **Meta and Kapso as WhatsApp
carriers** alongside Twilio, behind `WHATSAPP_PROVIDER` and a single
`sendWhatsAppMessage` / `downloadWhatsAppMedia` interface
(`packages/integrations/src/whatsapp.ts`). Every feature below that sends a voice
note goes through that interface and must not know which carrier is live.

There are **28 Trigger.dev tasks** already, all event-triggered.

### 1.2 Verified health, as of this writing

| Check | State |
|---|---|
| `pnpm typecheck` | Clean, workspace and dashboard |
| `pnpm test` | 126 tests, **1 failing**, but flaky rather than broken (section 2, step 0) |
| Banned fonts and icon libraries | Already absent. Verified by grep |
| `pnpm doctor` | **Does not exist.** The original brief says "extend" it |
| Tracked `.bak` files | **7 of them, committed to git** |
| Em dashes | Present in roughly 30 tracked files, including the Slack blocks |

### 1.3 What the original brief got wrong about the schema

Each of these is stated in the original as though it were already true. None of
them are. All are cheap, but they are work, and they belong in one migration
(section 3).

- **`broadcasts` has no `kind` column.** B2 and B7 both say "reuse `broadcasts`
  with `kind = 'heat'` / `'payday'`". That column must be added.
- **No scheduled task infrastructure exists at all.** B2 and B7 need
  `schedules.task` from zero: timezone keying, per-day idempotency, and a manual
  trigger each. The first of the two to be built pays for both, which is why
  they are now adjacent in the order.
- **`media.kind`** is `['image', 'audio_in', 'audio_out']`. B1 needs `'after'`
  and B5 needs `'document'`.
- **`IntakeIntent`** has no `command` member. B3 needs one.
- **`sites.lat` / `lng` / `timezone` do exist**, as the original says. B2 is
  correct there.
- **`closed → reopened` is already a legal transition**
  (`packages/core/src/state-machine.ts`). B1 is cheaper than it reads.
- **`case_events` already records everything B13's trace needs.** The trace is
  display work over existing rows, writing nothing new.

### 1.4 The README history problem

The README's "Built during the hackathon" section presents milestones M0 to M4
and claims `git log --oneline` shows them in order. **It does not.** The
repository has two commits: an initial squashed import dated 2026-09-11, and one
commit dated 2026-09-12. The v2 build has no per-milestone history here.

The user has deferred the README rewrite until this pass is done. So: **do not
touch the README's milestone section during this pass**, and do not manufacture
commits to satisfy it. When the README is rewritten at the end, that section
should describe what was built without implying a commit-by-commit trail.
Definition-of-done item 10 in the original brief is unsatisfiable as written and
is replaced in section 8 here.

### 1.5 What the original brief got wrong in your favour

**B12 Teams is much cheaper than "pure stretch".**
`@copilotkit/channels-teams` is already resolved in the dependency tree as a
transitive dependency of `@copilotkit/channels`. It needs promoting to a direct
dependency of the gateway, not discovering. It has moved up the order.

**B10's Python extension is not installed.** `@trigger.dev/build` is not a direct
dependency. B10 needs it added before the guardrail step can run.

---

## 2. Order of work

Work strictly in this order. It is sorted by what a judge can see, by what the
rubric rewards, and by real cost measured against this repository, which is why
it differs from the original brief's order.

The user has said to build **all fourteen parts** and has accepted the time this
takes. So there are no time boxes below. Two rules stand in their place: commit
after every part, and if a part stalls, switch its flag off, commit it, write one
line in `docs/decisions.md`, and go to the next one. Do not let one part block
the thirteen behind it.

| Step | Part | Why it sits here |
|---|---|---|
| 0 | Pre-flight, section 2.1 | Four things the definition of done gates on that no feature delivers |
| 1 | The migration, section 3 | Every additive column and enum value at once, so no later part waits on a migration |
| 2 | Section 4, the design system, on the four surfaces | Every judge sees Slack and the dashboard. Design lifts all four scoring criteria at once |
| 3 | B1 proof of fix | The single best demo beat, and cheap: `reopened` already exists |
| 4 | B13 agent trace and wall board | Reads existing `case_events`. Writes nothing. The shot the video opens on |
| 5 | B2 heat and midday break autopilot | Builds the scheduled-task infrastructure that B7 then reuses |
| 6 | B7 payday check | Adjacent to B2 on purpose: same infrastructure, second use, nearly free |
| 7 | B3 voice commands | Makes the worker side feel like a real assistant |
| 8 | B4 incident clustering | Turns noise into signal, reads as intelligence |
| 9 | B6 round trip translation check | The trust story for a translation product |
| 10 | B5 payslip and notice explainer | Second vision use, strong screenshot |
| 11 | B12 Microsoft Teams | Moved up from last. The adapter is already in the tree |
| 12 | B11 chaos tests with aimock | Proof the fallbacks are real |
| 13 | B10 PII guardrail through Mozilla any-guardrail | The ninth sponsor |
| 14 | B9 break glass reveal | Completes the speak up story |
| 15 | B8 call fallback | Highest risk, and gated on a credential that may not exist. Section 5, B8 |

Announce which step you are starting, in one line, and do not narrate more than
that.

### 2.1 Step 0, pre-flight

Four things the original brief assumes are done. Each is small. All four are
prerequisites for the definition of done, so they come first.

1. **Fix the flaky test.** `tests/llm-fallback.test.ts` fails its `beforeEach`
   with "Hook timed out in 10000ms" under parallel load, and passes alone in
   about 2.2 seconds. It is contention against the default `hookTimeout`, not a
   regression. Raise `hookTimeout` in `vitest.config.ts`, or isolate that file.
   Until this is fixed, "tests green" is not a signal you can trust, and every
   later step depends on that signal.
2. **Remove the tracked `.bak` files.** Seven are committed:
   `apps/gateway/package.json.bak`, `apps/gateway/src/index.ts.bak`,
   `apps/gateway/src/routes/slack.ts.bak`, `apps/worker/package.json.bak`,
   `apps/worker/src/lib/outbound.ts.bak`, `packages/core/src/actions.ts.bak`,
   `packages/db/src/repo.ts.bak`. `git rm` them and add a `.gitignore` rule.
3. **Write `pnpm doctor`.** It does not exist. Section 5 of the original brief
   says to extend it and the definition of done requires it green, so it has to
   be written before it can be extended. It checks: database reachable and
   migrated, the three crypto keys present and 32 bytes, the configured
   `WHATSAPP_PROVIDER`'s credentials complete, Slack reachable, FGA reachable,
   and one line per feature flag that is on saying whether its dependencies are
   satisfied. Green means demo ready.
4. **Sweep the em dashes, then guard them.** They are in roughly 30 tracked
   files, including 8 in `packages/integrations/src/slack/blocks.ts`, which
   means they are in the Slack cards a judge reads. Two cautions. First, do not
   `sed` blindly across prose: an em dash between clauses usually becomes a
   comma or a full stop, not a hyphen, and a careless global replace will mangle
   the README and the docs. Read each one. Second, **today's commit introduced
   new ones** (`packages/integrations/src/meta.ts`, `packages/integrations/src/kapso.ts`),
   so a one-time sweep will not hold. Add a CI grep that fails the build on an em
   dash in a tracked source or doc file, in the same workflow as gitleaks.

Commit step 0 as one commit before starting step 1.

---

## 3. The migration

One migration, written once, before any feature work. Every addition below is
known now, and doing them together means no later part stalls waiting on a
schema change. Additive only: new tables, nullable columns, new enum values.
`company_id` on every tenant table, RLS policies matching the existing ones in
`packages/db/sql/0002_rls.sql`, and the app role granted only what it needs.

**New nullable columns**

- `cases.reopen_count` integer not null default 0 (B1)
- `cases.fix_confirmed_at` timestamptz (B1)
- `cases.cluster_id` uuid, nullable, references `clusters` (B4)
- `broadcasts.kind` text, nullable (B2, B7)
- `workers.speech_rate` numeric (B3)
- `workers.quiet_until` timestamptz (B3)
- `messages.tts_media_id` uuid references `media` (B3)
- `messages.backtranslation_risk` text (B6)
- `messages.backtranslation_note` text (B6)
- `sites.teams_channel_id` text (B12)

**New enum values**

- `media_kind`: add `'after'` (B1) and `'document'` (B5)
- `IntakeIntent` in `packages/core/src/schemas.ts`: add `'command'` (B3). This is
  a Zod enum, not a database enum, but it changes model output validation, so
  treat it with the same care.

**New tables**

- `clusters` (id, company_id, site_id, category, opened_at, slack_message_ts,
  severity) (B4)
- `reveal_requests` (id, company_id, case_id, requested_by, reason, approved_by,
  status, auth_req_id, created_at, decided_at) (B9)
- `call_attempts` (id, company_id, broadcast_delivery_id, status, duration_seconds,
  result, created_at) (B8)

Adding a value to a Postgres enum cannot run inside a transaction block in older
versions and cannot be rolled back. Check how `pnpm db:migrate` wraps statements
before writing the enum changes, and if it wraps everything in one transaction,
split the enum additions into their own migration file that runs first.

---

## 4. The design system

Unchanged from the original brief in intent. One thing is different: there is
already a design direction in the code, and section 4.3 tells you what to do
about it.

### 4.1 What you are designing

Four surfaces, in order of how much a judge will see them:

1. **Slack**, where supervisors and HR live. Block Kit. The most watched surface.
2. **The ops dashboard**, Next.js, for HR and ops. The second most watched, and
   the one that can look either crafted or templated.
3. **WhatsApp messages**, the worker surface. The design here is voice and words,
   not pixels: length, order, tone, and what gets said first.
4. **The printed sticker sheet**, an artifact a judge can hold. Cheap to do well
   and nobody else will have one.

### 4.2 Subject grounding

Jisr is not a SaaS dashboard. It is the paperwork of a worksite, made to answer
back. Its world: gate registers, shift ledgers, carbon copy duplicate forms,
stamped approvals, site notice boards where the same notice is pinned in five
languages, timesheets ruled in columns, safety signage built for glare and
distance.

Two ideas carry the identity. Use both.

**The spine.** Every place a worker's words appear, they sit beside the English
in two columns, divided by one full height vertical rule, with the audio control
living inside that rule. Parallel text, the way a bilingual edition sets a poem
against its translation. This is the product's whole thesis made visible. It
appears in the dashboard case view, in the Slack card, and on the sticker.

**The stamp.** State changes are stamped, not badged. A thin outlined rectangle,
slightly rotated, containing the state and the time, set in the mono face: the
approvals stamp on a pay correction, the sealed stamp on a speak up report, the
closed stamp on a resolved case. One stamp per object, never decorative.

If you can justify a stronger direction from the same world, propose it in one
short paragraph before you build, then build that instead. Do not propose a
direction that is merely a different color.

### 4.3 Two pass process, adapted

The original says to write the design plan "before writing any CSS". That
instruction was written for a codebase with no design. This one has one:
`apps/dashboard/app/globals.css` is already grayscale-first, already has exactly
one loud color, already bans radius above 4px, and already has a `.bridge` class
which **is the spine**, under a different name.

So the process is the same two passes, but the first pass documents and critiques
what exists rather than inventing from nothing. Rewriting it from scratch would
risk a working dashboard for taste, which section 0 forbids.

**Pass one, the plan.** Write `docs/design.md` containing:

- **What is already there**, honestly: the existing tokens, what they get right,
  and what is generic about them.
- **Palette:** 5 or 6 named hex values, each with the reason it is that value,
  and for each one whether it is kept, moved, or new against the current CSS.
- **Type:** the families and their jobs, including which script each fallback
  covers. Note that the current CSS uses Noto throughout; section 4.4 asks for
  Plex for the interface with Noto as script siblings, so this is a real change.
- **Layout:** one paragraph, plus ASCII wireframes for the case view, the
  overview, and the Slack case card.
- **Principles:** four or five lines that would let another person make a
  consistent decision you did not anticipate.

**Pass two, the critique.** Read your own plan and ask: would I have produced
roughly this for any operations tool? For every part where the answer is yes,
revise it and write down what changed and why. Only then write code.

### 4.4 Tokens

The current CSS is close but not identical to the brief's starting tokens. Use
these unless your plan argues for better ones, in which case say so in
`docs/design.md`.

```
--paper        #EEEFEA   cool oat, the ruled ledger sheet, not cream
--paper-rule   #E6E8E1   the alternating band on a ruled ledger
--rule         #CBCFC5   hairline
--ink          #152233   blue black, the color of iron gall ledger ink
--ink-2        #4C5A68   secondary text
--ink-3        #7C8894   labels and metadata
--stamp        #9B2019   the only loud color, means act now: overdue, critical
```

The existing file uses `--color-paper: #fbfbfa`, `--color-ink: #16150f` and
`--color-act: #c0392b`, which are warmer and lighter. Moving to the values above
is a deliberate shift toward the ledger, away from white. Make the change in one
place, in `@theme`, and let it propagate.

Rules for color:

- Design the whole thing in grayscale first. Add `--stamp` last, and only where
  it means act now.
- `--stamp` never fills a large area. It appears as a rule, an outline, a stamp,
  or a single word.
- There is no second accent. Resolved and normal states are carried by ink weight
  and position, not by green.
- Do not add a dark mode. One mode, done well.

Type:

- **IBM Plex Sans** for the interface, with **IBM Plex Sans Devanagari** and
  **IBM Plex Sans Arabic** as script siblings, plus **Noto Sans Malayalam**,
  **Noto Sans Bengali**, **Noto Sans Tamil** and **Noto Nastaliq Urdu** for the
  scripts Plex does not cover.
- **IBM Plex Mono** for case IDs, timestamps, amounts, hashes, and stamps.
  Tabular figures everywhere a number can change. The current CSS uses a generic
  `ui-monospace` stack; this is a real change.
- Scale: 12, 14, 16, 20, 24, 32. Headings at line height 1.15 to 1.25, body at
  1.55.
- Per script leading: Malayalam, Bengali and Tamil need roughly 0.15 more line
  height than Latin, and Nastaliq Urdu needs roughly 0.6 more. Set this per
  language, do not let one value serve all scripts.
- Verify every script actually renders before you ship. A row of boxes on stage
  is worse than plain English. `pnpm language-test` already exists and renders a
  sentence per language; extend it rather than writing a second one.

Spacing: 4, 8, 16, 24, 32, 48, 64, and nothing else. The existing `@theme` block
already defines exactly this scale, so it stays. Radius: 0 on everything, no
exceptions, which means removing the `border-radius: 4px` on `.card` and the
`2px` on the focus ring. Depth comes from hairlines and background bands, never
from shadows.

### 4.5 Banned, no exceptions

The client has rejected all of this by name. Treat a violation as a bug.

Harsh gradients. Lucide or any icon library. Em dashes anywhere, including UI
copy, README, comments and commit messages. Inter, Geist or Space Grotesk. A
colored stripe down the left edge of a card. Invented testimonials. Bento grids.
Fake terminal windows. The rhetorical shape "it is not X, it is Y". Checkmark
bullets. Three pricing tiers. Soft corner radius. Radial orbs. Dot grid
backgrounds. Sparkle icons. Animated arrows. Neon colors. Generic pastels.

Also banned, because they are the current generated defaults:

Warm cream background with a terracotta accent near #D97757. Identical rounded
cards with the same soft gray shadow. Tracked out all caps eyebrow labels above
headings. Meta strings joined with middle dots. An arrow appended to button text.
Tinted near black standing in for black. One word in a headline colored or
italicized for emphasis. Numbered markers 01, 02, 03 on content that is not a
sequence. Fade and slide up entrance animations on every section.

Two of these already need fixing in the existing code, found by reading it:
`.label` uses `letter-spacing: 0.02em` on an 11px gray label, which is the
tracked-out eyebrow; and the layout header joins the actor name and sign-out with
a middle dot. Both go.

One ambiguity in the client's list: it bans "no skeleton loaders". Read that as a
ban on the absence of loading states, not on skeletons. So: never show a bare
spinner or an empty screen while data loads. Show the real structure of the page
with quiet placeholders and a determinate progress line.

Two tensions to navigate deliberately, since zero radius and hairlines are
themselves a known generated look: the thing that makes this not a generic
broadsheet is the spine, the ledger row rhythm, and the printed artifacts. Spend
your boldness there and keep everything else quiet. Before you call a screen
done, remove one thing from it.

### 4.6 Icons

There is no icon library, and the grep confirms none is installed. Keep it that
way. Draw at most eight glyphs yourself as inline SVG, 1.5px strokes, square
caps, on a 16px grid: audio, photo, location, clock, person, site, alert, sealed.
Everything else is a word. A word is clearer than an unfamiliar glyph to a room
of judges reading at speed.

### 4.7 Motion

One orchestrated moment, not scattered effects. Choose the arrival of a new case:
a new row enters the board by drawing its hairline first, then its text, in about
220ms. Everything else is instant. Transitions only on what a person just did
(opening, expanding, confirming). Respect `prefers-reduced-motion: reduce` by
removing motion, not by shortening it.

### 4.8 Every state is designed

For each list and each panel, build all five: loading (as in 4.5), empty, one
item, many items, and error. Empty states say what will fill them and how, in the
interface's voice. Errors say what happened and what to do next, never apologize,
and never show a stack trace.

### 4.9 Copy rules

Sentence case everywhere. Active voice. A button names exactly what happens, and
the same word is used in the confirmation, so "Send" produces "Sent". Plain
words: Cases, Broadcasts, Pay approvals, Stickers, Audit log. No system
vocabulary in the interface: a person sees "waiting for HR", never "waitpoint
token pending". Numbers are formatted once, in one helper, including AED amounts
and hours.

### 4.10 The dashboard, screen by screen

Keep every existing route working. The routes today are `/`, `/cases`,
`/cases/[publicId]`, `/broadcasts`, `/pay`, `/stickers` and `/audit`. Apply the
system, then add what is listed here.

- **Overview.** Not a row of metric cards. A single ledger of what needs a person
  right now, newest first, with the counts set as a line of running text above
  it. The one loud thing on the page is the count of cases past their SLA.
- **Cases list.** A ruled table, not cards. Columns: case ID in mono, category,
  site, age, state, who it is waiting on. Row height at least 44px so it is
  legible from the back of a room.
- **Case view.** The spine is here. Left column the worker's words in their
  script, right column the English, one full height rule between them holding the
  audio control. The existing `.bridge` class is the starting point. Evidence
  photos sit below at a consistent width. The state stamp sits top right. The
  agent trace (B13) runs down the margin.
- **Broadcasts.** The translation preview is a stack of parallel text rows, one
  per language, so a person can see all of them at once before pressing Send. The
  acknowledgement view is a list of names with time to acknowledge, not a pie
  chart. Note `apps/dashboard/components/ack-chart.tsx` exists; replace what it
  renders, do not add a second component beside it.
- **Pay approvals.** Read only, as before. Show both approvers, the short hash,
  and the stamp. Make the two person rule legible at a glance: two names, two
  times.
- **Stickers.** Print stylesheet actually tested at A4. `scripts/generate-stickers.ts`
  already writes `tmp/stickers.html` and carries its own inline CSS, so it needs
  the same tokens applied there, not only in the dashboard. The sticker is: QR,
  the asset label, the code in mono, a three step pictogram strip, and one short
  line in five languages. It has to survive being photocopied, so no gray fills
  under 20 percent.
- **Wall board** (B13), a new route.

### 4.11 Slack, which is design too

Block Kit is a constrained system, so craft shows in ordering and restraint. The
builders are in `packages/integrations/src/slack/blocks.ts`.

- **One card, one job.** Header line with severity, category, site and asset.
  Then the English summary. Then the worker's own words as a quoted context block
  with the language named. Then evidence. Then actions. Then a single context line
  with the case ID and the SLA time.
- **Escaping stays as it is.** Worker text is escaped so it can never produce a
  mention or a fake link. `slackQuote` and its length cap are covered by
  `tests/slack-escaping.test.ts`; do not change their behaviour.
- **Buttons:** at most three plus overflow. The primary action uses Slack's
  primary style, destructive uses danger, and everything else is plain. Never two
  primary buttons.
- **After a click the card rewrites itself** into its resolved state, showing who
  acted and when, with the buttons removed. A card that still offers buttons
  after a decision looks broken on camera.
- **Threads carry the conversation**, the card carries the state. Never post a
  second card for the same case.
- **Emoji:** at most one per card, in the header, as a severity marker. No
  decorative emoji anywhere else.

### 4.12 WhatsApp, where design is words

- Voice note first, text underneath, always the same order.
- At most two short sentences per message, one idea each.
- The first sentence says the thing that matters. Never open with a greeting.
- Ask one question at a time. Never present a menu.
- Say what happens next and when: "a technician will come today at 4pm", not
  "your request has been logged".
- Never use system words: no case ID unless the worker asks for it, no state
  names, no English jargon inside another language.
- Every safety critical string (the emergency reply, the yes or no prompt, the
  acknowledgement prompt) is checked by a native speaker on the team, and the
  reviewed strings are recorded in `docs/decisions.md`. These live in
  `packages/core/src/messages.ts` and are static on purpose. `docs/decisions.md`
  already records that they have **not** been reviewed by a speaker of each
  language. Closing that gap is part of this pass.

### 4.13 Quality floor

Responsive down to a phone, because a supervisor will open the dashboard on one.
Visible keyboard focus that is not the browser default outline, which the current
CSS already does. Contrast at least 4.5:1 for body text, checked, not assumed.
`dir="auto"` on every element that can hold worker text, and a correct right to
left layout for Arabic and Urdu, including which side the spine sits on. No
layout shift when audio loads.

Take screenshots as you build and look at them. If your environment cannot, open
each page once at 1440px and once at 390px and read it end to end before calling
it done.

---

## 5. The features

Build them in the order given in section 2, not the order they appear here.

Every part below inherits the cross-cutting rules in section 6. In particular:
every model call goes through `callLLM`, every outbound worker message goes
through `sendToWorker` in `apps/worker/src/lib/outbound.ts` so it works on all
three carriers, and every new action is FGA-checked before it runs.

### B1. Proof of fix

**Purpose.** A case is not closed because a manager said so. It is closed because
the worker confirms it, with evidence. This is the agent finishing its own loop,
which is the thing a chatbox cannot do.

**Trigger.** A manager marks a case resolved, or the action they chose has come
due (for example "technician at 4pm" plus the configured delay).

**Behaviour.**

1. Jisr sends the worker a voice note and text: "The technician should have come.
   Is it working now? Send a photo if you can."
2. The task waits on a token, `FIX_CONFIRM_TIMEOUT_MINUTES` (3 for the demo).
3. If a photo comes back, run one vision call comparing it with the original
   evidence photo. Return a strict schema:
   `{ resolved: boolean, sameSubject: boolean, difference: string, confidence: "low" | "medium" | "high" }`.
   Never claim a fix from a photo alone: the worker's yes or no decides, the
   photo is supporting evidence.
4. Yes: the case goes to `closed`, the Slack card rewrites to the closed state
   with the before and after photos side by side and a closed stamp. Confirmed by
   the worker, with the time.
5. No: the case reopens, posts to the same thread marked as a reopen with the
   worker's reason, and starts a fresh SLA. A reopened case is always shown as
   reopened, never as new.
6. No answer before the timeout: post to the thread that the worker has not
   confirmed, and ask once more.

**Data.** `cases.reopen_count`, `cases.fix_confirmed_at`, and a `case_events` row
for every step. Link the after photo in `media` with `kind = 'after'`. All added
in section 3.

**What is already there.** `closed → reopened` is a legal transition in
`packages/core/src/state-machine.ts`. Use `assertTransition` as every other write
site does. The waitpoint pattern is the same one `case.route` uses.

**Acceptance.** Mark a case resolved. The phone asks. Send a photo and say no.
The card shows reopened with the reason, and the SLA restarts. Repeat with yes,
and the card shows closed with both photos.

**Demo beat.** Photo of a messy thing, then a photo of the fixed thing, side by
side inside the Slack card, closed by the worker and not by the manager.

**If it fails.** Vision comparison is the optional half. If it is unreliable,
ship the yes or no confirmation alone and label the photo as evidence without a
verdict.

### B13. Agent trace and wall board

**Purpose.** Make the orchestration visible. Judges score engineering they can
see. Built early because it reads existing rows and writes nothing, so it cannot
destabilise anything.

**The trace.** In the case view, a margin column running down the left of the
case timeline, set in mono at 12px, recording every step the agent took with its
duration: transcribed 8s of Hindi, understood, asked one question, read back,
routed to Site B, waited 2m for a supervisor, relayed the decision. Where a
fallback fired, say so plainly: primary model timed out, OpenRouter answered.
Where a human decided, name them. Where a check ran, name its result. Build it
from `case_events`, which already exists and already carries `type`, `actorKind`,
`actorRef`, `payload` and `createdAt`, so nothing new is written just for
display. Add one line to the Slack card too, on resolution only: how long the
whole loop took.

**The wall board.** A new route `/board`, designed for a TV or a projector at
1920px. No navigation and no chrome, which means it must opt out of the shared
layout in `apps/dashboard/app/layout.tsx`, not fight it. Open cases as large
ruled rows, the count past SLA in the loud color, the live acknowledgement state
of today's broadcast, and a ticker of the last five agent actions in plain words.
Polls every 5 seconds. This is the shot the demo video opens on, and it is also
the thing a site office would actually mount on a wall.

**Acceptance.** The trace shows a real fallback after running
`pnpm drill:model-outage`. `/board` reads correctly from three metres away.

### B2. Heat and midday break autopilot

**Purpose.** The agent acts without any human starting it, on a rule that exists
in the real world. This is the clearest evidence that Jisr is an agent rather
than a bot.

**Rule.** The UAE midday break bans outdoor work in direct sun from 12:30 to
15:00, from 15 June to 15 September. Note that today, 2026-09-12, falls inside
that window, so this can run live. The window closes on 15 September, so if this
is demonstrated later than that, the ad hoc trigger carries the demo and the
schedule is explained rather than shown.

**Trigger.** A scheduled Trigger.dev task per site, in the site's timezone, at
12:05 and at 14:55 during the window. Plus an ad hoc run command for the demo.

**This is where the scheduled-task infrastructure gets built.** There are no
scheduled tasks in the repository today. Build it once, here, so B7 inherits it:
`schedules.task` from `@trigger.dev/sdk` v4.5.16, keyed per site with the site's
`timezone` column, idempotent per day so a redeploy cannot double send, and a
manual trigger exposed as a `pnpm` script. `apps/worker/trigger.config.ts`
already sets `dirs: ['./src/tasks']`, so a scheduled task in that folder is
picked up with no config change.

**Behaviour.**

1. Fetch today's forecast for the site's coordinates. Use Open-Meteo, which needs
   no key. Cache the result for the day. If the call fails, carry on with the
   rule alone and say so in the Slack post: the break does not depend on the
   weather.
2. At 12:05, send every worker at that site a voice note in their language: break
   starts at 12:30, where the shaded rest area is, drink water.
3. Track acknowledgements exactly as broadcasts do, reusing the existing
   `broadcast_deliveries` table and the existing `broadcast.ack` task. Do not
   build a second mechanism.
4. Post one live card to the site channel: how many acknowledged, who has not,
   and the forecast high.
5. At 14:55, send the "break ends in five minutes" message.
6. After `HEAT_ACK_REMINDER_MINUTES`, chase whoever has not acknowledged. After
   twice that, post the list to the supervisor and mark it in the audit log,
   because this is a compliance record.

**Data.** Reuse `broadcasts` and `broadcast_deliveries` with
`broadcasts.kind = 'heat'`, the column added in section 3. `sites.lat` and
`sites.lng` already exist.

**Acceptance.** Run the ad hoc command. Four phones receive four languages. The
card fills in as people reply. One person does not reply and shows up in the
chase.

**Demo beat.** Nobody touches anything, and four phones buzz at once in four
languages.

**If it fails.** Keep the schedule and drop the weather. The compliance value is
in the timing, not the temperature.

### B7. Payday check

**Purpose.** Find the salary problem before it becomes a complaint. Private
sector pay in the UAE is standardised to the first of the month, so the second is
the day to ask.

**Placed directly after B2 on purpose.** It is the same scheduled-task
infrastructure, the same broadcast tables, the same acknowledgement path. Built
second, it is nearly free. Built eleventh, as the original brief had it, it would
have paid for that infrastructure twice.

**Trigger.** A scheduled task on the 2nd of each month, plus an ad hoc run for
the demo.

**Behaviour.** Ask every worker one yes or no question by voice: did your salary
arrive. Collect answers for 24 hours. Post one summary per site: how many said
yes, how many said no, how many did not answer. A no opens a pay case
automatically, pre filled, which then follows the two person rule already built
in `apps/worker/src/tasks/pay.ts`.

**Data.** Reuse the broadcast tables with `kind = 'payday'`.

**Acceptance.** Run it ad hoc. Answer no on one phone, and a pay case appears in
Slack.

### B3. Voice commands

**Purpose.** Workers who cannot read comfortably need to control the assistant by
speaking, in their own words, with nothing to learn.

**Trigger.** Any inbound message whose intent the understand call classifies as a
command.

**Behaviour.** Extend `IntakeIntent` in `packages/core/src/schemas.ts` with
`command`, and add a `command` field: `repeat`, `slower`, `status`,
`language_change`, `stop`, `human`.

- `repeat`: resend the last outbound voice note, unchanged, from storage. Do not
  regenerate it.
- `slower`: regenerate the last message at a slower speaking rate and remember
  the preference on the worker for the rest of the session.
- `status`: speak the state of their most recent open case in plain words, with
  what happens next and when. Never read out an ID or a state name.
- `language_change`: "speak to me in Hindi" updates `workers.language` after a
  one line confirmation in the new language.
- `stop`: pause non urgent messages for this worker for 24 hours. Emergency and
  safety messages still go. Confirm what will still reach them.
- `human`: hand off. Post to the site channel that the worker asked for a person,
  with the case, and tell the worker who was told.

Commands must work in any language and in any phrasing, which is why they are
classified rather than matched to keywords. Keep a small keyword pre-check for
`stop` and `human` so they work even if the model call fails.

**Data.** `workers.speech_rate`, `workers.quiet_until`, `messages.tts_media_id`
so `repeat` can resend the exact audio. All added in section 3.

**Carrier note.** `repeat` resends stored audio. On Meta and Kapso an outbound
voice note is uploaded to the carrier's own media store and on Twilio it is a
signed GCS URL, so "resend the exact audio" means different things per carrier.
Store what `sendWhatsAppMessage` returns and resend through the same interface;
do not reach past it.

**Acceptance.** Say "I did not understand, say it again" in Hindi and get the
same audio back. Say "speak slower" and get a slower version. Ask "what happened
to my complaint" and hear the real state.

**Demo beat.** A worker asks a question about their own case and hears a real
answer, in their language, with no menu.

### B4. Incident clustering

**Purpose.** Five people reporting the same broken water tank should be one thing
a manager reads, not five. This is where the agent looks intelligent rather than
mechanical.

**Trigger.** A new case reaches `routed`.

**Behaviour.**

1. Look for open cases at the same site, in the same category, within
   `CLUSTER_WINDOW_MINUTES` (40).
2. If there are candidates, make one cheap structured call: is this the same
   underlying incident, yes or no, with a one line reason. Ask about the
   strongest candidate only, not all of them.
3. Yes: attach the new case to the existing cluster, update the existing card in
   place (5 workers, Site B, first reported 13:12), and do not post a new card.
   Tell the new reporter that others have reported the same thing and it is being
   handled, so they do not feel ignored.
4. A cluster's severity is the highest severity of its members, and it escalates
   a level once it has three or more members.
5. One decision on a cluster relays to every member of it. This is the payoff:
   one tap answers five people in four languages.

**Data.** New table `clusters` and `cases.cluster_id`, both in section 3. Never
merge a speak up case into a cluster, and never merge across sites. The speak-up
exclusion is not optional: a cluster card names its reporters, and a speak-up
case has no `worker_id` precisely so that cannot happen.

**Acceptance.** Three phones report the same problem within a minute. One card
shows 3 workers. One tap sends three voice notes in three languages.

**If it fails.** Fall back to posting normally and adding a context line saying
how many similar cases are open.

### B6. Round trip translation check

**Purpose.** The failure most likely to embarrass a translation product on stage
is a confident wrong translation. Make the product catch it before a person does.

**Trigger.** Any outbound message on a pay, safety or emergency case, and every
broadcast.

**Behaviour.**

1. Translate the message as usual.
2. Send the translated text to a different model through OpenRouter and translate
   it back to English.
3. Compare the round trip against the original with one cheap structured call
   that returns
   `{ meaningPreserved: boolean, risk: "none" | "minor" | "material", note: string }`.
4. `material`: do not send. Rewrite once, simpler and shorter, and re-check. If
   it fails again, send the English version and post to Slack that the
   translation needed a human check.
5. `minor`: send, and record the note in the case trace.
6. Never show the round trip text to the worker. It is an internal check.
7. Cap it: only on the message classes listed, never on chatty replies, and skip
   it entirely if the daily token budget circuit breaker has tripped.
   `apps/worker/src/lib/budget.ts` already implements that breaker; call it, do
   not reimplement it.

**Do not apply this to the static strings.** The emergency reply, the
acknowledgement prompt and the yes/no prompt in `packages/core/src/messages.ts`
are pre-translated on purpose, so that a life-safety message never waits on a
model. Round-tripping them at send time would reintroduce exactly the dependency
they exist to remove. They are covered by the native speaker review in section
4.12 instead.

**Data.** `messages.backtranslation_risk` and `messages.backtranslation_note`.

**Acceptance.** Force a bad translation with a test string and watch it get
caught, rewritten, and sent correctly. The trace shows both attempts.

**Demo beat.** One line in the agent trace: checked by a second model, meaning
preserved.

### B5. Payslip and notice explainer

**Purpose.** The most common question a worker has is "what does this paper
mean". Answering it costs an office half a day and costs Jisr four seconds.

**Trigger.** A photo whose understand call classifies it as `document`, or a
worker asking what a document means.

**Behaviour.**

1. One vision call reads the document into a strict schema: type (payslip,
   notice, contract page, fine, other), the line items with labels and amounts,
   the period, and anything unusual.
2. Jisr explains it as a voice note, line by line, in plain words in the worker's
   language, at most six lines. It states amounts in the currency shown. It never
   converts, never estimates, never guesses at a missing number.
3. Then one question: "Does anything here look wrong to you?" A yes opens a pay
   case with the document already attached as evidence, which flows straight into
   the two person pay rule.
4. Jisr never gives legal advice, and never says an amount is wrong. It says what
   the document says and offers to raise it.
5. Redact before storing: the Emirates ID, IBAN and phone patterns are masked in
   the stored text, exactly as the speak up path does. `packages/core/src/redact.ts`
   already implements this and `tests/speakup-redaction.test.ts` covers it. Reuse
   it.

**Data.** `media.kind = 'document'`, added in section 3, and a `case_events` row
carrying the extracted schema.

**Acceptance.** Photograph the printed fake payslip. Hear a correct six line
explanation in Hindi. Answer yes, and a pay case opens with the photo attached.

**Demo beat.** Paper goes in, understanding comes out, and it turns into an
approved correction later in the same video.

### B12. Microsoft Teams

**Purpose.** Two environments beats one, which is exactly what the theme rewards.

**Moved up from last place.** The original brief ranked this a pure stretch, not
knowing that `@copilotkit/channels-teams` is **already resolved in the dependency
tree** as a transitive dependency of `@copilotkit/channels`. It needs promoting
to a direct dependency of `apps/gateway`, not discovering. That changes it from
the riskiest item to a moderate one.

**Behaviour.** Add a Teams transport behind the existing `notifyManagers` and
`updateCaseCard` interface. That interface already exists as `SlackTransport` in
`packages/integrations/src/slack/transport.ts`, with two implementations behind
it (Web API and Channels), which is the pattern to follow. Same cards, same
actions, same authorization checks, chosen per site by `sites.teams_channel_id`,
added in section 3.

Read `docs/decisions.md` entry 1 before starting. It records exactly what the
Channels Slack adapter does and does not allow: `post`, `update` and
`onInteraction` are real, but a Channel cannot be started from inside our own
process because `ɵruntime` is internal. Expect the Teams adapter to have the same
shape and the same constraint.

If Channels proves difficult, stop and write down what blocked it. **Do not let
Teams destabilise Slack**: Slack is the surface the video depends on, Teams is
the surface that makes it two environments.

### B11. Chaos tests with aimock

**Purpose.** Prove the failure handling is real, in a form a judge can read in
ten seconds.

**Behaviour.** Record real model responses once as fixtures with CopilotKit's
aimock, then add deterministic tests that inject: a timeout on the primary model,
a malformed JSON response, a refusal, a Slack rate limit, a WhatsApp media
download failure, and a database connection drop mid task. Each test asserts the
user visible behaviour, not the internal path: the worker still gets a reply, or
a human is told, and nothing is silently dropped. Print the results as a table in
the README.

Note the media download failure is no longer Twilio-specific: it must be asserted
against `downloadWhatsAppMedia`, which covers all three carriers.

Three failure drills already exist as scripts (`pnpm drill:model-outage`,
`drill:sla-timeout`, `drill:webhook-replay`) and 14 test files already exist.
These chaos tests join them rather than replacing them.

**Acceptance.** `pnpm test` runs them offline with no network and no keys. The
existing `vitest.config.ts` already injects fake crypto keys for exactly this
reason; follow that pattern.

### B10. PII guardrail through Mozilla any-guardrail

**Purpose.** Replace the regex mask with a real detector, and give the ninth
sponsor a genuine job. `docs/decisions.md` and the README both currently say
Mozilla.ai is not integrated; this is the part that changes that.

**Behaviour.** Run any-guardrail as a Python step inside a Trigger.dev task,
using the Python build extension. **`@trigger.dev/build` is not currently a
direct dependency** and must be added to `apps/worker` first, and the extension
registered in `apps/worker/trigger.config.ts`, whose `build` block today only
marks `sharp` as external.

It screens every text that is about to leave the system boundary: Slack cards,
dashboard responses, model inputs. On a detection, mask the span and record what
class was found, never the value itself. On any failure, fall back to the
existing regex mask in `packages/core/src/redact.ts` and log which path ran. The
guardrail may not add more than 400ms to the intake path, so run it in parallel
with the work it guards where possible.

**Acceptance.** A transcript containing a dictated Emirates ID number arrives
masked in Slack, and the audit log records the class without the number.

**If it fails.** The regex mask stays, and it already works. Say plainly in the
README that the Mozilla integration was attempted and which part worked.

### B9. Break glass reveal

**Purpose.** Completes the speak up story: identity can be recovered when there
is a real reason, and never quietly.

`docs/decisions.md` entry 6 currently records that this is not built and that **no
UI path reveals a speak-up identity**. That entry must be rewritten when this
ships, not left to contradict the code.

**Behaviour.**

1. An HR user requests a reveal from the case view, and must type a reason of at
   least 40 characters.
2. A second person holding the `compliance` relation approves through Auth0
   asynchronous authorization, the same CIBA mechanism as the pay rule in
   `packages/integrations/src/auth0/ciba.ts`, with a binding message naming the
   case.
3. On approval, decrypt the sealed identity, show it once in the browser, and
   never write it to a log, a Slack message or an API response.
4. Write a critical audit event recording both people, the reason and the time.
5. Tell the reporter, in their language, that a reveal happened and who
   authorised it.
6. Deny, expire, or no distinct approver: nothing is revealed, and the request is
   recorded as refused.

**Data.** New table `reveal_requests`, in section 3.

**Authorization.** The reveal is authorized by `compliance`, not by `hr`. Note
the bug recorded in `docs/decisions.md`: a speak-up case has no site, so any
relation that resolves through a site will fail on it. `can_view_speakup` is the
relation that works; `compliance` must be modelled the same way.

**Acceptance.** Request a reveal. The compliance phone gets the prompt. Approve,
and the identity appears once. Reload the page and it is gone. The audit log has
the record, and the reporter has been told.

### B8. Call fallback

**Purpose.** A safety message that is not acknowledged is not a message. If
WhatsApp goes unread, Jisr picks up the phone.

**Last on purpose.** It is the only part gated on a credential that may not
exist, and it is the only part whose failure mode is "cannot start".

**Check this before writing any code.** The WhatsApp sandbox number cannot place
calls. This needs a voice capable Twilio number and the account's calling
permissions for the destination country. If either is missing, **stop and say so
rather than half building it**, switch the flag off, write one line in
`docs/decisions.md`, and consider the part closed. Note also that the project now
runs three WhatsApp carriers: if `WHATSAPP_PROVIDER` is `meta` or `kapso`, there
may be no Twilio account configured at all, in which case B8 needs its own
Twilio voice credentials independent of the messaging path.

**Trigger.** A safety or heat broadcast that is unacknowledged after
`CALL_FALLBACK_MINUTES`.

**Behaviour.**

1. Place a Twilio voice call to the worker.
2. The call opens by saying it is an automated message from the company, in the
   worker's language.
3. Play the same audio file already generated for the broadcast, from a signed
   URL.
4. Ask the person to say yes or press 1 to confirm they heard it, and gather both
   speech and keypad.
5. A confirmation marks the same `broadcast_deliveries` row acknowledged, so one
   acknowledgement model serves all channels.
6. No answer: leave it unacknowledged, try once more after the same interval,
   then escalate to the supervisor with the plain fact that neither WhatsApp nor
   a call reached this person.
7. Every call is logged, with its duration and result, in `call_attempts` from
   section 3.

**Do not record calls.** Section 7.

**Acceptance.** Ignore a broadcast on one phone, receive the call, press 1, and
watch the acknowledgement appear on the Slack card.

---

## 6. Cross cutting requirements

**Schema.** All additions are new tables or nullable columns, in the single
migration from section 3, with `company_id` on every tenant table, RLS policies
matching the existing ones in `packages/db/sql/0002_rls.sql`, and the app role
granted only what it needs. Every new write goes through `withTenant()`.

**Scheduling.** Heat and payday tasks are Trigger.dev scheduled tasks, keyed per
site with the site's timezone, and idempotent per day so a redeploy cannot double
send. Every scheduled task also has a manual trigger for the demo, exposed as a
`pnpm` script. None of this exists yet; B2 builds it and B7 reuses it.

**Carriers.** Every outbound worker message goes through `sendToWorker`, and
every media download through `downloadWhatsAppMedia`. A feature must never
reference Twilio, Meta or Kapso directly. This rule did not exist when the
original brief was written and is now the single easiest way to break the core
loop.

**Queues.** Outbound messaging keeps its existing concurrency limit in
`apps/worker/src/queues.ts`. New fan outs reuse it rather than creating a second
path to the same provider.

**Budget.** Every new model call goes through the existing `callLLM` wrapper in
`packages/ai/src/llm.ts` so it inherits the fallback chain, the schema
validation, the token cap and the circuit breaker. No new direct provider calls
anywhere.

**Tasks.** New Trigger.dev tasks use the existing `validatedTask` wrapper in
`apps/worker/src/lib/task-kit.ts` and reference each other by string id, which is
what keeps the lifecycle a cycle without import cycles. See `docs/decisions.md`
entry 4.

**Authorization.** Every new action is checked in FGA before it runs, denies by
default, and derives the company and site from the session or the case, never
from the client. Remember that speak-up cases have no site, so site-derived
relations fail on them.

**Doctor.** `pnpm doctor` is written in step 0 and extended by each part that
adds a dependency: the weather endpoint (B2), the voice capable Twilio number
(B8), the guardrail step (B10), the Teams channel (B12). Green means demo ready.

---

## 7. Things you must not build

These were considered and rejected. Do not add them, and do not let a model
suggestion smuggle them back in.

- Detecting emotion, stress or fatigue from a worker's voice. Nobody consented to
  that analysis. Priority comes from what people say.
- Cloning a manager's or anyone's voice. Jisr speaks in its own voice and says
  what it is.
- Any path where the agent approves pay, closes a safety case, reveals an
  identity, or sends a broadcast without a human click.
- Recording phone calls.
- Face recognition, or anything that identifies people in photos. Faces in speak
  up evidence should be blurred if you have time, never analysed.
- A worker facing app, login, or portal. The worker side stays on WhatsApp with
  nothing to install.
- Legal advice of any kind. Jisr points to the official channels.

---

## 8. Deliverables

- `docs/design.md`: the plan and the critique from section 4.3, plus the final
  tokens.
- `docs/decisions.md`: every deviation, every part that shipped switched off, and
  the native speaker review of the safety strings. Three existing entries must be
  **rewritten, not appended to**, when their parts ship: entry 6 (break-glass is
  not built) when B9 lands, the Mozilla row when B10 lands, and the "things
  deliberately not built" list, which currently names nine of the parts in this
  brief.
- `docs/demo-script.md`: rewrite the two minute storyboard around what actually
  works, opening on the wall board and closing on the model outage drill.
- `README.md`: **deferred to the end of the pass by the user.** When it is
  rewritten: add the new features to the sponsor map and the failure handling
  table, add the chaos test results table, correct the test count (it says 101,
  it is 126 plus whatever B11 adds), and rewrite the "Built during the hackathon"
  section per section 1.4.

---

## 9. Definition of done

Work through this list before you say you are finished, and report it as a table
with a yes or no per line.

1. The core loop still works end to end, with every new flag switched off.
2. It still works with every finished flag switched on.
3. The core loop works on **all three WhatsApp carriers**, or the ones that are
   configured. No feature reaches past `sendWhatsAppMessage`.
4. `pnpm typecheck`, `pnpm test` and `pnpm audit --prod --audit-level=high` are
   clean. `pnpm test` must be clean **repeatedly**, not once: the flake fixed in
   step 0 is the reason this says so.
5. `pnpm doctor` is green.
6. Every banned item in section 4.5 is absent. Search the codebase for the font
   names, for icon library imports, and for em dashes before you answer, and
   confirm the CI guard from step 0 is in place and failing on a planted em dash.
7. Every screen has a designed loading, empty and error state.
8. Arabic and Urdu render right to left correctly, and every script renders with
   no missing glyph boxes.
9. Nothing anywhere reveals a speak up reporter, except through B9's two-person
   reveal, which is audited and tells the reporter.
10. No model call can approve pay, close a safety case, reveal an identity, or
    send a broadcast.
11. No `.bak` files are tracked in git.
12. `docs/decisions.md` contradicts neither the code nor itself: the three
    entries named in section 8 are rewritten for whatever actually shipped.

The original brief's item 10, "the README's built during the event section lists
only commits made today", is dropped. It is unsatisfiable against this
repository's history and section 1.4 explains why.

---

Start with step 0, the pre-flight. Then the migration. Then the design plan:
write it, critique it, then build.
