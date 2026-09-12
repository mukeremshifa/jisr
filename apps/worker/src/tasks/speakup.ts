import { z } from 'zod';
import { callLLM, redactSystem, redactUser, redactionSchema, SPEAKUP_PROMPT_VERSION, synthesizeSpeech } from '@jisr/ai';
import {
  features,
  log,
  newReporterToken,
  redactPii,
  sanitizeText,
  scrubForModel,
  speakupConfirmation,
  type CaseSeverity,
} from '@jisr/core';
import { audit, encryptField, hashToken, repo, withTenant } from '@jisr/db';
import { notifyManagers, slackTransport, uploadMedia } from '@jisr/integrations';
import { chargeTokens } from '../lib/budget';
import { sendToWorker } from '../lib/outbound';
import { trigger, validatedTask } from '../lib/task-kit';
import { awaitDecisions } from './case';
import { slaDueAt } from '../lib/case-context';

/**
 * F2. Speak-up mode.
 *
 * The report reaches people who can act on it; the reporter's identity does not.
 *
 *   worker_id is NULL on the case
 *   only SHA-256(reporter token) is stored on the case
 *   AES-256-GCM(worker_id) lives in sealed_identities under SEALING_KEY,
 *     a different key from the one that protects phone numbers
 *   only the relay decrypts it, and only to address an outbound message
 *
 * Nothing in this file logs a phone number or a worker id for a speak-up case.
 */

/** Step 1: confirm the mode before collecting anything. */
export const speakupStart = validatedTask({
  id: 'speakup.start',
  schema: z.object({
    companyId: z.string().uuid(),
    workerId: z.string().uuid(),
    entry: z.enum(['keyword', 'sticker', 'understanding']),
  }),
  run: async ({ companyId, workerId, entry }) => {
    if (!features.speakup) return { started: false as const };

    const worker = await withTenant(companyId, ({ tx }) => repo(companyId, tx).workerById(workerId));
    if (!worker) return { started: false as const };

    await sendToWorker({
      companyId,
      workerId,
      textOriginal: speakupConfirmation(),
      textEn: speakupConfirmation(),
      language: worker.language,
      caseId: null,
    });

    await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).upsertSession(workerId, { speakupPending: true, lastCaseId: null }),
    );

    // The entry point is audited, the reporter is not.
    await audit({ event: 'speakup_started', companyId, details: { entry } });
    return { started: true as const };
  },
});

/** Step 2-6: redact, seal, and post an HR-only card. */
export const speakupReport = validatedTask({
  id: 'speakup.report',
  schema: z.object({
    companyId: z.string().uuid(),
    workerId: z.string().uuid(),
    messageId: z.string().uuid(),
    transcript: z.string().max(4000),
    language: z.string().max(8),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    summaryEn: z.string().max(400),
  }),
  run: async (payload) => {
    const { companyId, workerId } = payload;
    if (!features.speakup) return { reported: false as const };

    // Photos are already stripped of metadata by the media pipeline. They are
    // attached to the report by media id, never by message: a message row also
    // carries the worker id.
    const imageMediaIds = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const message = await r.messageById(payload.messageId);
      if (!message?.mediaId) return [];
      const item = await r.mediaById(message.mediaId);
      return item?.kind === 'image' ? [item.id] : [];
    });

    // --------------------------------------------------------------- redact
    let summaryEnRedacted = payload.summaryEn;
    let transcriptRedacted = payload.transcript;

    try {
      const result = await callLLM({
        task: SPEAKUP_PROMPT_VERSION,
        system: redactSystem(),
        user: redactUser({
          language: payload.language,
          summaryEn: payload.summaryEn,
          transcriptOriginal: payload.transcript,
        }),
        schema: redactionSchema,
        schemaName: 'redaction',
        maxTokens: 900,
        temperature: 0,
      });
      await chargeTokens(companyId, result.tokensUsed);
      summaryEnRedacted = result.data.summaryEnRedacted;
      transcriptRedacted = result.data.transcriptOriginalRedacted;
    } catch (error) {
      // If the model will not answer, the report still reaches HR, but only the
      // regex-masked version, and marked as such. We never post the raw text.
      log.error('speakup_redaction_failed', { error });
      summaryEnRedacted = `(automatic redaction unavailable, this summary is masked by pattern only)\n${payload.summaryEn}`;
    }

    // Belt and braces: the regex pass cannot be talked out of matching.
    summaryEnRedacted = redactPii(sanitizeText(summaryEnRedacted, 900)).text;
    transcriptRedacted = redactPii(sanitizeText(transcriptRedacted, 2000)).text;

    // ------------------------------------------------------- seal the identity
    const reporterToken = newReporterToken();
    const created = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const row = await r.createCase({
        siteId: null,
        assetId: null,
        // The whole point: no worker id on the case.
        workerId: null,
        reporterTokenHash: hashToken(reporterToken),
        isSpeakup: true,
        category: 'safety',
        severity: payload.severity as CaseSeverity,
        status: 'new',
        language: payload.language,
        summaryEn: summaryEnRedacted,
        transcriptOriginal: transcriptRedacted,
        transcriptEn: summaryEnRedacted,
        confirmedByWorker: false,
        slaDueAt: slaDueAt(payload.severity as CaseSeverity),
      });

      await r.sealIdentity(row.id, encryptField(workerId, 'sealing'));
      await r.upsertSession(workerId, { speakupPending: false, speakupCaseId: row.id, lastCaseId: null });
      await r.addEvent({ caseId: row.id, type: 'speakup_opened', actorKind: 'agent', payload: {} });
      return row;
    });

    // ------------------------------------------------- re-voice, never the original
    let revoicedMediaId: string | null = null;
    try {
      const speech = await synthesizeSpeech({ text: summaryEnRedacted, language: 'en' });
      const uploaded = await uploadMedia({
        bytes: speech.bytes,
        contentType: speech.contentType,
        extension: speech.extension,
      });
      const media = await withTenant(companyId, ({ tx }) =>
        repo(companyId, tx).insertMedia({
          gcsKey: uploaded.gcsKey,
          contentType: speech.contentType,
          bytes: speech.bytes.byteLength,
          sha256: '',
          kind: 'audio_out',
          durationSeconds: null,
        }),
      );
      revoicedMediaId = media.id;
    } catch (error) {
      log.warn('speakup_revoice_failed', { error });
    }

    await notifyManagers(companyId, created.id, {
      speakup: { summaryEnRedacted, revoicedMediaId, imageMediaIds },
    });

    await audit({
      event: 'speakup_report_filed',
      severity: 'warn',
      companyId,
      // The token hash, never the reporter.
      subject: created.publicId,
      details: { severity: payload.severity, hasAudio: Boolean(revoicedMediaId) },
    });

    const worker = await withTenant(companyId, ({ tx }) => repo(companyId, tx).workerById(workerId));
    await sendToWorker({
      companyId,
      workerId,
      textOriginal:
        'Your report has been sent to HR without your name. I will bring you their questions and answers here.',
      textEn: 'Speak-up report acknowledged.',
      language: worker?.language ?? payload.language,
      caseId: null,
    });

    // A speak-up case has no site and so no case.route. It still needs a
    // waitpoint, or HR's "Ask the reporter" would have nothing to complete.
    await trigger('speakup.await', { companyId, caseId: created.id });

    return { reported: true as const, casePublicId: created.publicId };
  },
});

/**
 * Holds the waitpoint HR's buttons complete. Speak-up has no SLA escalation:
 * there is no site supervisor to escalate to, and the report is already with the
 * only people who may see it.
 */
export const speakupAwait = validatedTask({
  id: 'speakup.await',
  schema: z.object({ companyId: z.string().uuid(), caseId: z.string().uuid() }),
  maxDuration: 3600,
  run: async ({ companyId, caseId }) => {
    const outcome = await awaitDecisions({
      companyId,
      caseId,
      firstTimeout: '55m',
      laterTimeout: '55m',
      maxRounds: 8,
    });
    return { outcome };
  },
});

/**
 * Step 7. The reporter's answer to an HR question. Redacted and re-voiced on
 * the way out, exactly like the first report.
 */
export const speakupFollowUp = validatedTask({
  id: 'speakup.followUp',
  schema: z.object({
    companyId: z.string().uuid(),
    caseId: z.string().uuid(),
    workerId: z.string().uuid(),
    transcript: z.string().max(4000),
    summaryEn: z.string().max(400),
    language: z.string().max(8),
  }),
  run: async (payload) => {
    const { companyId, caseId } = payload;

    let redacted = payload.summaryEn;
    try {
      const result = await callLLM({
        task: `${SPEAKUP_PROMPT_VERSION}:followup`,
        system: redactSystem(),
        user: redactUser({
          language: payload.language,
          summaryEn: payload.summaryEn,
          transcriptOriginal: payload.transcript,
        }),
        schema: redactionSchema,
        schemaName: 'redaction',
        maxTokens: 700,
        temperature: 0,
      });
      await chargeTokens(companyId, result.tokensUsed);
      redacted = result.data.summaryEnRedacted;
    } catch (error) {
      log.error('speakup_followup_redaction_failed', { error });
      redacted = `(masked by pattern only) ${payload.summaryEn}`;
    }
    redacted = redactPii(sanitizeText(redacted, 900)).text;

    const row = await withTenant(companyId, ({ tx }) => repo(companyId, tx).caseById(caseId));
    if (!row?.slackChannelId || !row.slackMessageTs) return { relayed: false as const };

    await slackTransport().postThreadReply(
      { channelId: row.slackChannelId, messageTs: row.slackMessageTs },
      { text: `Reply from the reporter (redacted):\n${redacted}` },
    );

    await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).addEvent({
        caseId,
        type: 'speakup_followup',
        actorKind: 'worker',
        actorRef: null,
        payload: { redacted },
      }),
    );

    return { relayed: true as const };
  },
});
