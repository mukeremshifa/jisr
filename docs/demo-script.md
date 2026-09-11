# Demo script — two minutes

A storyboard for the features that actually work. Set `DEMO_SLA_MINUTES=3` so an
escalation lands inside the demo.

**Before you start**

- Two phones joined to the Twilio WhatsApp sandbox, on the roster with different
  languages (Hindi and Urdu read well on camera).
- Slack open on the Site B channel, the HR speak-up channel and the dashboard.
- Print `tmp/stickers.html` and stick R214 on something.
- One HR account enrolled in Auth0 Guardian, distinct from the supervisor account.

---

### 0:00 — The problem, in one line

> "A worker who can't read comfortably has a broken AC and no way to report it.
> His supervisor gets forty WhatsApp messages a day in five languages. Jisr sits
> between them."

---

### 0:10 — Scan, send, speak *(F1, C1)*

Scan the R214 sticker on camera. WhatsApp opens with `JISR-R214` already typed.
Press send.

Jisr replies by voice: **"कमरा 214, ब्लॉक C — मिल गया। बताइए क्या समस्या है।"**

Send a voice note: *"AC दो दिन से बंद है, बहुत गर्मी है।"*

> "He never typed a word, never told us where he was, and never filled in a form."

---

### 0:30 — Read it back, then route it *(C1, C2)*

Jisr reads the case back in Hindi and asks yes or no. Say **"हाँ"**.

Slack, Site B channel:

```
🟠 Maintenance · High · Room 214, Block C (Site B)        JS-7F3K
AC not working for two days; room is very hot.
"AC दो दिन से बंद है, बहुत गर्मी है" — confirmed by worker (Hindi)
[Send technician today 4 PM]  [Ask for a photo]  [Reply in my own words]
First response due 14:32
```

> "The buttons aren't free text. The model picks from a fixed catalog, and every
> parameter is re-validated on the server."

---

### 0:50 — One tap, and he hears the answer *(C3)*

Tap **Send technician today 4 PM**. The phone gets a voice note:
**"टेक्नीशियन आज शाम 4 बजे आएगा।"**

> "Two taps for the supervisor. A voice note in his own language for the worker.
> Nobody switched apps."

---

### 1:05 — Speak up, with the identity sealed *(F2)*

On the second phone, in Urdu: *"میں اپنا نام نہیں بتانا چاہتا۔ سائٹ بی پر ہمیں دوپہر ایک بجے دھوپ میں کام کروایا جا رہا ہے۔"*

The HR speak-up channel shows:

```
🟠 Speak-up report — identity sealed                     JS-4K8P
Workers at Site B are being made to work in direct sun around 1 PM.
🔒 The reporter is hidden. Reply in this thread and I will relay your
   questions without revealing who they are.
🔊 Re-voiced summary (synthetic voice)
```

Show the Site B channel: **nothing**. Show the worker id column in the database:
**null**.

> "This is a possible midday-break violation — and it may be about that site's
> supervisor, so it never goes to that site's channel. The name is encrypted
> under a different key from the one protecting phone numbers, and only the relay
> task ever decrypts it."

---

### 1:25 — Pay, and two different people *(F3)*

First phone: *"मेरे अगस्त के 12 घंटे ओवरटाइम सैलरी में नहीं आए"* plus a photo of a
timesheet.

Supervisor card: **12.00 hours · AED 127.50** — computed on the server from the
roster rate, not read off the photo. Tap **Approve correction**.

The HR phone buzzes: **`JISR 9Q2M 12h OT W-0142 AED127.50`**. Approve it.

The payroll sheet row appears with identical numbers. The worker hears:
**"आपके अगस्त के 12 ओवरटाइम घंटे मंज़ूर हो गए हैं।"**

> "Two distinct humans, enforced by excluding the first approver by id and by
> email. And the approval is bound to a hash of the exact numbers — change the
> amount after approval and the payment aborts with a critical audit event."

---

### 1:45 — When things break *(C8, and the drills)*

Run `pnpm tsx scripts/drill-model-outage.ts` on screen:

```
1. Normal                      answered by openai
2. Primary revoked             answered by openrouter    ← the fallback, live
3. Every provider revoked      worker's report still reaches a human,
                               badged "needs review"
```

> "Nothing is mocked. When the model is gone, the report still reaches a person —
> it just arrives untranslated with a badge on it."

---

### 1:55 — The board

Show the dashboard: open cases by site, what's past SLA in the one loud colour,
and the bridge row — his words in Devanagari beside the English.

Ask Jisr: **"What's still open at Site B?"** A table renders inline.

> "Every feature removes a step for someone. The worker never installs anything,
> never reads, never fills in a form. The manager decides with one tap. All the
> complexity lives inside the agent."

---

## If something fails on stage

| Problem | Say this, then do this |
|---|---|
| WhatsApp is slow | "The gateway answered Twilio in under a second — this is Twilio's sandbox." Show the Trigger.dev run. |
| A voice note doesn't arrive | The text still does. Point at it: the failure is loud, not silent. |
| Slack doesn't update | Show the dashboard; it reads the same database. |
| The model is slow | Set `FORCE_LLM_FALLBACK=true` and carry on — that *is* the demo. |
