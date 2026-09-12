# Demo script, two minutes

A storyboard for the features that actually work. Set `DEMO_SLA_MINUTES=3` so an
escalation lands inside the demo.

Two beats are **not** in this cut. Two-person pay (F3) needs an Auth0 CIBA
application, so `FEATURE_PAY_TWO_PERSON=false` in `.env` turns it off and
`pnpm doctor` stays green. Speak-up (F2) needs a second phone rostered in a
second language. Both features are built, and stay described in `README.md`
and `docs/security.md`.

**Before you start**

- `pnpm doctor` green.
- One phone on WhatsApp, on the roster as `hi`.
- Slack open on the Site B channel and the dashboard.
- Print `tmp/stickers.html` (`pnpm stickers R214`) and stick R214 on something.

---

### 0:00 The problem, in one line

> "A worker who can't read comfortably has a broken AC and no way to report it.
> His supervisor gets forty WhatsApp messages a day in five languages. Jisr sits
> between them."

---

### 0:10 Scan, send, speak *(F1, C1)*

Scan the R214 sticker on camera. WhatsApp opens with `JISR-R214` already typed.
Press send.

Jisr replies by voice: **"कमरा 214, ब्लॉक C, मिल गया। बताइए क्या समस्या है।"**

Send a voice note: *"AC दो दिन से बंद है, बहुत गर्मी है।"*

> "He never typed a word, never told us where he was, and never filled in a form."

---

### 0:30 Read it back, then route it *(C1, C2)*

Jisr reads the case back in Hindi and asks yes or no. Say **"हाँ"**.

Slack, Site B channel:

```
🟠 Maintenance, High, Room 214, Block C (Site B)        JS-7F3K
AC not working for two days; room is very hot.
"AC दो दिन से बंद है, बहुत गर्मी है", confirmed by worker (Hindi)
[Send technician today 4 PM]  [Ask for a photo]  [Reply in my own words]
First response due 14:32
```

> "The buttons aren't free text. The model picks from a fixed catalog, and every
> parameter is re-validated on the server."

---

### 0:50 One tap, and he hears the answer *(C3)*

Tap **Send technician today 4 PM**. The phone gets a voice note:
**"टेक्नीशियन आज शाम 4 बजे आएगा।"**

> "Two taps for the supervisor. A voice note in his own language for the worker.
> Nobody switched apps."

---

### 1:05 When things break *(C8, and the drills)*

Run `pnpm drill:model-outage` on screen:

```
1. Normal                      answered by openai
2. Primary revoked             answered by openrouter    ← the fallback, live
3. Every provider revoked      worker's report still reaches a human,
                               badged "needs review"
```

> "Nothing is mocked. When the model is gone, the report still reaches a person,
> it just arrives untranslated with a badge on it."

---

### 1:30 The board

Show the dashboard: open cases by site, what's past SLA in the one loud colour,
and the bridge row, his words in Devanagari beside the English.

Ask Jisr: **"What's still open at Site B?"** A table renders inline.

> "Every feature removes a step for someone. The worker never installs anything,
> never reads, never fills in a form. The manager decides with one tap. All the
> complexity lives inside the agent."

---

## If something fails on stage

| Problem | Say this, then do this |
|---|---|
| WhatsApp is slow | "The gateway answered the carrier in under a second." Show the Trigger.dev run. |
| A voice note doesn't arrive | The text still does. Point at it: the failure is loud, not silent. |
| Slack doesn't update | Show the dashboard; it reads the same database. |
| The model is slow | Set `FORCE_LLM_FALLBACK=true` and carry on, that *is* the demo. |
