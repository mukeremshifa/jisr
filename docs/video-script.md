# Two-minute video: narration and assembly

Narration is third-person product voice. Word counts are sized for TTS at about
150 words per minute, which is a natural pace with room to breathe; each beat's
budget is a **maximum**, not a target. Generate each beat as its own audio file,
then lay picture against it in CapCut.

Total narration: **277 words / about 1:51** at 150 wpm, leaving air across the cuts.

Source timecodes refer to `tmp/capture/wa/phone.mp4` (the cropped phone
recording), which is what CapCut should import, not the original `0912.mp4`.

---

## Beat 1 — The problem  ·  0:00–0:12  ·  36 words

> "The water tank on a labour site has been empty since morning. A worker can
> report it, but only by text, in a language he may not write, on a form nobody
> gave him. So it doesn't get reported."

**Picture:** `title-problem.png` (generated), held. Optional slow push in.

---

## Beat 2 — He speaks, in his own language  ·  0:12–0:34  ·  52 words

> "With Jisr, he reports it in Hindi, on WhatsApp. No app to install, no form,
> no English. Jisr understands it, and reads the case back to him in his own
> language to check it got the details right. He replies yes. That confirmation
> is the whole interaction."

**Picture:** `phone.mp4`
- `0:00–0:07` → his Hindi message lands
- `0:07–0:14` → Jisr's read-back appears in Hindi
- `0:14–0:18` → "Yes"
- Speed: 1.0x. Cut on message arrivals, not mid-bubble.

---

## Beat 3 — The supervisor sees structure  ·  0:34–0:56  ·  60 words

> "His supervisor doesn't see a translation request. In Slack, the report has
> already become a case: category, severity, site, a plain English summary, and
> the worker's own words kept underneath. The buttons are chosen for this case,
> from a fixed catalogue, and every one is re-validated on the server. A response
> is due at a stated time."

**Picture:** Slack stills, slow pan on each
- `slack-01-card.png` — 9s. The hero card: four buttons ("Assign site
  supervisor", "Visit today", "Confirm affected workers", "Reply in my own
  words"), the Hindi quote, "First response due 14:24". Hold, then push in on
  the button row.
- `slack-02-reply-modal.png` — 7s, the reply box with "I will send a technician
  this afternoon." and the line about sending it as a voice note plus text.
- `slack-03-actioned.png` — 6s, "Decision sent to the worker"

---

## Beat 4 — He hears the answer  ·  0:56–1:14  ·  43 words

> "The decision comes back as a voice note, in Hindi, in the same thread he
> started. He never typed, never read, never opened anything but WhatsApp.
> Every step that could be removed from him, was."

**Picture:** `phone.mp4` `0:32–0:47`, the voice note playing with the waveform
advancing. This is the shot that proves the audio is real: do not speed it up,
and do not cut before the progress bar has visibly moved.

---

## Beat 5 — It holds when things break  ·  1:14–1:38  ·  57 words

> "The models behind this fail. So Jisr is built to expect it. When the primary
> provider is revoked mid-run, a fallback answers and the worker notices nothing.
> When every provider is gone, the report still reaches a human, marked for
> review. Nothing here is mocked: this is the drill, running live."

**Picture:** `drill-model-outage.mp4`, full 12.3s, then hold the final frame.
Let the three results land one at a time; the colour does the work.

---

## Beat 6 — Reach, the board, and the close  ·  1:38–2:00  ·  54 words

> "One message reaches every worker in the language they speak, and Jisr tracks
> who has heard it. Every case lands on one board, the worker's own words beside
> the English. Workers install nothing and read nothing. Managers decide with one
> tap. All the complexity lives inside the agent."

**Picture:**
- `slack-04-broadcast.png` — 5s. One English message, five languages listed, and
  acknowledgements counted per worker. The only frame where the fan-out is
  visible, so give it a beat of its own before the board.
- `cases-full.png` — 6s, slow pan down the tall board
- `case-detail.png` — 7s, settle on the Hindi/English bridge row
- `title-close.png` (generated) — 4s

---

## Assembly notes

- **Canvas** 1920×1080. The phone clip is 1080×1330 portrait: place it centred
  with the dashboard or a flat dark ground behind it, never stretched to fill.
- **Captions** burned in, always. The Hindi is the point and no judge reads it.
  Caption the Hindi lines with their English meaning as they appear on screen,
  separately from the narration captions.
- **Speed ramps** are only needed inside `phone.mp4` where nothing changes for
  several seconds. Ramp visibly (2x) rather than hard-cutting, so it doesn't read
  as hiding a failure.
- **Music** low, under -22 LUFS, out entirely under beat 5 so the drill lands dry.
