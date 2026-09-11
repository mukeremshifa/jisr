# Draft social post

> Post from the team account after the demo. Check the handles before posting.

---

**Option A — the short one**

We built **Jisr** (Arabic: bridge) at AI Tinkerers "Agents, Everywhere".

Frontline workers in the UAE stay on WhatsApp — voice notes, photos, a QR sticker
on a door — in Hindi, Urdu, Malayalam, Tagalog, Bengali or Arabic. Their
supervisors stay in Slack. Jisr turns a messy multilingual voice note into a
structured case, routes it, and brings the decision back as a voice note in the
worker's own language.

The rule we held ourselves to: **every feature removes a step for someone and
never adds one.** Workers install nothing, read nothing, fill in nothing.
Managers decide with one tap.

Three things we're proud of:

🔒 **Speak-up mode.** A worker can report a hazard anonymously. The case carries
no worker id; the identity is sealed under a separate key and only ever decrypted
to deliver a reply. HR can ask follow-up questions without ever learning who they
are talking to.

✅ **A two-person rule for pay.** A supervisor approves, then a *different* HR
person approves on their phone via @auth0 CIBA — and the approval is bound to a
hash of the exact numbers. Edit the amount after approval and the payment aborts.

🎧 **It still works when the models don't.** @OpenAI first, @OpenRouterAI as the
fallback chain, and if every provider is gone the raw transcript still reaches a
human with a "needs review" badge. Nothing is mocked.

Built with @OpenAI · @CopilotKit · @OpenRouterAI · @ExaAILabs · @auth0 ·
@AmbiguousAI · @triggerdotdev · @mozilla · @googlecloud

Repo: <link>

---

**Option B — the one-liner with a hook**

Most frontline workers don't have a problem *reporting* things. They have a
problem with forms, apps, and languages nobody translates into.

So we built Jisr: the worker sends a voice note in Malayalam, the supervisor gets
a case card in Slack, and the decision comes back as a voice note in Malayalam.
No app, no typing, no reading.

Built in four hours at AI Tinkerers "Agents, Everywhere" with @OpenAI,
@CopilotKit, @OpenRouterAI, @ExaAILabs, @auth0, @AmbiguousAI, @triggerdotdev,
@mozilla and @googlecloud.

Repo: <link>
