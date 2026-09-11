import { z } from 'zod';
import {
  callLLM,
  transcribeAudio,
  understandSchema,
  understandSystem,
  understandUser,
  UNDERSTAND_PROMPT_VERSION,
} from '@jisr/ai';
import {
  AUDIO_TOO_LONG_REPLY,
  BUDGET_TRIPPED_REPLY,
  IntakeMessagePayload,
  TRANSCRIPT_UNCLEAR_REPLY,
  UNKNOWN_STICKER_REPLY,
  UNSUPPORTED_MEDIA_REPLY,
  config,
  emergencyReply,
  features,
  firstContactNotice,
  injectionHeuristic,
  isEmergency,
  isPendingAssetValid,
  isUnreliableTranscript,
  isValidCoordinate,
  languageOf,
  log,
  matchSite,
  parseStickerCode,
  pendingAssetExpiry,
  sanitizeText,
  scrubForModel,
  type CaseSeverity,
  type IntakeUnderstanding,
} from '@jisr/core';
import { audit, repo, withTenant } from '@jisr/db';
import {
  MediaRejected,
  downloadTwilioMedia,
  estimateAudioSeconds,
  listMessageMedia,
  prepareMedia,
  uploadMedia,
} from '@jisr/integrations';
import { chargeAudioSeconds, chargeTokens, isBudgetTripped } from '../lib/budget';
import { trigger, validatedTask } from '../lib/task-kit';
import { sendToWorker } from '../lib/outbound';
import { intakeQueue } from '../queues';

/**
 * C1 — intake.
 *
 * One task per inbound message, running on a queue keyed by worker id so a
 * worker's messages are handled in the order they were sent. Everything the
 * gateway deliberately did not do happens here: media, speech, the model call,
 * and the branch into the right flow.
 */
export const intakeMessage = validatedTask({
  id: 'intake.message',
  schema: IntakeMessagePayload,
  queue: intakeQueue,
  maxDuration: 300,
  retry: { maxAttempts: 3 },
  run: async (payload) => {
    const { companyId, workerId, messageId, providerSid } = payload;

    const loaded = await withTenant(companyId, async ({ tx }) => {
      const r = repo(companyId, tx);
      const [message, worker, session, company] = await Promise.all([
        r.messageById(messageId),
        r.workerById(workerId),
        r.session(workerId),
        r.company(),
      ]);
      return { message, worker, session, companyName: company?.name ?? config.COMPANY_NAME };
    });

    if (!loaded.message || !loaded.worker) {
      log.warn('intake_message_missing', { messageId });
      return { handled: false as const };
    }
    const { message, worker, session, companyName } = loaded;
    const language = worker.language;

    // ------------------------------------------------------- C7 first contact
    if (!worker.consentedAt) {
      await sendToWorker({
        companyId,
        workerId,
        textOriginal: firstContactNotice(companyName),
        textEn: firstContactNotice(companyName),
        language,
      });
      await withTenant(companyId, ({ tx }) => repo(companyId, tx).markConsented(workerId));
    }

    // ---------------------------------------------------------- media ingest
    const ingested = await ingestMedia({ companyId, workerId, messageId, providerSid });
    if (ingested.rejected) {
      await sendToWorker({ companyId, workerId, textOriginal: ingested.rejected, language });
      return { handled: true as const, reason: 'media_rejected' };
    }

    // ------------------------------------------------- F1 sticker + location
    if (features.tapToReport) {
      const stickerHandled = await handleSticker({ companyId, workerId, text: message.textOriginal, language });
      if (stickerHandled) return { handled: true as const, reason: 'sticker' };

      if (message.lat != null && message.lng != null) {
        await handleLocationPin({ companyId, workerId, lat: message.lat, lng: message.lng, language });
      }
    }

    // -------------------------------------------------------------- speech in
    let transcript = sanitizeText(message.textOriginal, 4000);
    if (ingested.audio) {
      const seconds = ingested.audio.durationSeconds ?? estimateAudioSeconds(ingested.audio.bytes, ingested.audio.contentType);
      if (seconds > config.CAP_AUDIO_SECONDS_PER_MESSAGE) {
        await sendToWorker({ companyId, workerId, textOriginal: AUDIO_TOO_LONG_REPLY, language });
        return { handled: true as const, reason: 'audio_too_long' };
      }
      if (!(await chargeAudioSeconds(workerId, seconds))) {
        await audit({
          event: 'rate_limited',
          severity: 'warn',
          companyId,
          actor: `worker:${workerId}`,
          details: { limit: 'audio_seconds_per_day' },
        });
        await sendToWorker({ companyId, workerId, textOriginal: BUDGET_TRIPPED_REPLY, language });
        return { handled: true as const, reason: 'audio_budget' };
      }

      const result = await transcribeAudio({
        bytes: ingested.audio.buffer,
        contentType: ingested.audio.contentType,
        filename: `voice.${ingested.audio.extension}`,
        languageHint: languageOf(language).transcriptionHint,
      });
      transcript = result.text;

      await withTenant(companyId, ({ tx }) =>
        repo(companyId, tx).updateMessage(messageId, {
          textOriginal: transcript,
          language: result.detectedLanguage ?? language,
        }),
      );
    }

    if (!transcript && !ingested.imageMediaId) {
      await sendToWorker({ companyId, workerId, textOriginal: TRANSCRIPT_UNCLEAR_REPLY, language });
      return { handled: true as const, reason: 'empty' };
    }

    if (transcript && isUnreliableTranscript(transcript)) {
      await sendToWorker({ companyId, workerId, textOriginal: TRANSCRIPT_UNCLEAR_REPLY, language });
      return { handled: true as const, reason: 'unclear' };
    }

    // ------------------------------------------------- C6 emergency fast path
    // Runs before the model call: a life-safety message never waits on an LLM.
    if (isEmergency(transcript, false)) {
      await handleEmergency({ companyId, workerId, messageId, transcript, language });
      return { handled: true as const, reason: 'emergency' };
    }

    // ------------------------------------------------- circuit breaker (C11)
    if (await isBudgetTripped(companyId)) {
      await sendToWorker({ companyId, workerId, textOriginal: BUDGET_TRIPPED_REPLY, language });
      await trigger('ops.alert', { companyId, reason: 'token_budget_tripped' }).catch(() => undefined);
      return { handled: true as const, reason: 'budget' };
    }

    // ------------------------------------------------------- C1.7 understand
    const pendingAsset =
      session?.pendingAssetId && isPendingAssetValid(session.pendingAssetExpiresAt)
        ? await withTenant(companyId, ({ tx }) => repo(companyId, tx).assetById(session.pendingAssetId!))
        : null;

    const openCase = session?.lastCaseId
      ? await withTenant(companyId, ({ tx }) => repo(companyId, tx).caseById(session.lastCaseId!))
      : null;

    const pendingAck = await withTenant(companyId, ({ tx }) =>
      repo(companyId, tx).pendingAckForWorker(workerId),
    );

    let understanding: IntakeUnderstanding;
    try {
      const result = await callLLM({
        task: UNDERSTAND_PROMPT_VERSION,
        system: understandSystem(),
        // Data minimisation: phone numbers and Emirates IDs never reach a model.
        user: understandUser({
          transcript: scrubForModel(transcript || '(the worker sent a photo with no words)'),
          workerLanguage: language,
          pendingQuestion: session?.pendingQuestion ?? null,
          pendingAssetLabel: pendingAsset?.label ?? null,
          awaitingConfirmation: openCase?.status === 'awaiting_confirmation',
          hasRecentBroadcast: Boolean(pendingAck),
        }),
        schema: understandSchema,
        schemaName: 'intake_understanding',
        maxTokens: 700,
        temperature: 0,
      });
      understanding = result.data;
      await chargeTokens(companyId, result.tokensUsed);
    } catch (error) {
      // Both providers failed. The case still reaches a human — with the raw
      // transcript and a "needs review" badge — rather than being dropped.
      log.error('understand_failed_routing_to_human', { messageId, error });
      await routeUnderstood({
        companyId,
        workerId,
        messageId,
        transcript,
        language,
        needsReview: true,
      });
      return { handled: true as const, reason: 'model_unavailable' };
    }

    // The model's emergency flag is the second half of C6.
    if (understanding.isEmergency) {
      await handleEmergency({ companyId, workerId, messageId, transcript, language });
      return { handled: true as const, reason: 'emergency' };
    }

    const heuristic = injectionHeuristic(transcript);
    const injectionSuspected = understanding.injectionSuspected || heuristic.suspected;
    if (injectionSuspected) {
      await audit({
        event: 'injection_suspected',
        severity: 'warn',
        companyId,
        actor: `worker:${workerId}`,
        details: { modelFlag: understanding.injectionSuspected, patterns: heuristic.matched.length },
      });
    }

    // ------------------------------------------------------------- C1.8 branch
    await trigger('intake.route', {
      companyId,
      workerId,
      messageId,
      transcript,
      understanding,
      injectionSuspected,
      pendingAssetId: pendingAsset?.id ?? null,
      openCaseId: openCase?.id ?? null,
      pendingBroadcastId: pendingAck?.broadcastId ?? null,
    });

    return { handled: true as const, intent: understanding.intent };
  },
});

// ---------------------------------------------------------------------------

interface IngestedMedia {
  rejected: string | null;
  imageMediaId: string | null;
  audio: {
    buffer: Buffer;
    bytes: number;
    contentType: string;
    extension: string;
    durationSeconds: number | null;
  } | null;
}

/**
 * Media is read back from the Twilio API by MessageSid rather than from the
 * webhook body, checked against the allowlist by declared type *and* magic bytes,
 * re-encoded (which strips EXIF), and stored under a random key in a private bucket.
 */
async function ingestMedia(input: {
  companyId: string;
  workerId: string;
  messageId: string;
  providerSid: string;
}): Promise<IngestedMedia> {
  const result: IngestedMedia = { rejected: null, imageMediaId: null, audio: null };

  let refs: Awaited<ReturnType<typeof listMessageMedia>>;
  try {
    refs = await listMessageMedia(input.providerSid);
  } catch (error) {
    log.warn('media_list_failed', { providerSid: input.providerSid, error });
    return result;
  }
  if (refs.length === 0) return result;

  for (const ref of refs.slice(0, 2)) {
    const maxBytes = ref.contentType.startsWith('image/') ? config.CAP_IMAGE_BYTES : config.CAP_AUDIO_BYTES;
    try {
      const downloaded = await downloadTwilioMedia(ref.url, maxBytes);
      const prepared = await prepareMedia({
        bytes: downloaded.bytes,
        declaredContentType: downloaded.declaredContentType,
      });
      const uploaded = await uploadMedia({
        bytes: prepared.bytes,
        contentType: prepared.contentType,
        extension: prepared.extension,
      });

      const durationSeconds =
        prepared.kind === 'audio_in'
          ? estimateAudioSeconds(prepared.bytes.byteLength, prepared.contentType)
          : null;

      const row = await withTenant(input.companyId, ({ tx }) =>
        repo(input.companyId, tx).insertMedia({
          gcsKey: uploaded.gcsKey,
          contentType: prepared.contentType,
          bytes: prepared.bytes.byteLength,
          sha256: prepared.sha256,
          kind: prepared.kind,
          durationSeconds,
        }),
      );

      await withTenant(input.companyId, ({ tx }) =>
        repo(input.companyId, tx).updateMessage(input.messageId, { mediaId: row.id }),
      );

      if (prepared.kind === 'image') {
        result.imageMediaId = row.id;
      } else {
        result.audio = {
          buffer: prepared.bytes,
          bytes: prepared.bytes.byteLength,
          contentType: prepared.contentType,
          extension: prepared.extension,
          durationSeconds,
        };
      }
    } catch (error) {
      if (error instanceof MediaRejected) {
        await audit({
          event: 'media_rejected',
          severity: 'warn',
          companyId: input.companyId,
          actor: `worker:${input.workerId}`,
          details: { reason: error.reason },
        });
        result.rejected = UNSUPPORTED_MEDIA_REPLY;
      } else {
        log.error('media_ingest_failed', { error });
      }
    }
  }

  return result;
}

/** F1 — a scanned sticker sets 15 minutes of context, then asks what is wrong. */
async function handleSticker(input: {
  companyId: string;
  workerId: string;
  text: string | null;
  language: string;
}): Promise<boolean> {
  const code = parseStickerCode(input.text);
  if (!code) return false;

  const asset = await withTenant(input.companyId, ({ tx }) => repo(input.companyId, tx).assetByCode(code));

  if (!asset || !asset.active) {
    // An unknown code may mean a tampered or copied sticker, so it is audited.
    await audit({
      event: 'unknown_sticker_code',
      severity: 'warn',
      companyId: input.companyId,
      actor: `worker:${input.workerId}`,
      details: { code, known: Boolean(asset), active: asset?.active ?? false },
    });
    await sendToWorker({
      companyId: input.companyId,
      workerId: input.workerId,
      textOriginal: UNKNOWN_STICKER_REPLY,
      language: input.language,
    });
    return true;
  }

  if (asset.kind === 'speakup') {
    if (!features.speakup) return false;
    await trigger('speakup.start', {
      companyId: input.companyId,
      workerId: input.workerId,
      entry: 'sticker' as const,
    });
    return true;
  }

  await withTenant(input.companyId, ({ tx }) =>
    repo(input.companyId, tx).upsertSession(input.workerId, {
      pendingAssetId: asset.id,
      pendingAssetExpiresAt: pendingAssetExpiry(),
    }),
  );

  await sendToWorker({
    companyId: input.companyId,
    workerId: input.workerId,
    textOriginal: `${asset.label} - got it. Tell me what is wrong.`,
    textEn: `${asset.label} - got it. Tell me what is wrong.`,
    language: input.language,
  });
  return true;
}

/** F1 — a live location pin resolves to the nearest site whose radius contains it. */
async function handleLocationPin(input: {
  companyId: string;
  workerId: string;
  lat: number;
  lng: number;
  language: string;
}): Promise<void> {
  if (!isValidCoordinate(input.lat, input.lng)) return;

  const sites = await withTenant(input.companyId, ({ tx }) => repo(input.companyId, tx).sites());
  const match = matchSite(input.lat, input.lng, sites);

  if (!match) {
    const names = sites.map((s) => s.name).join(', ');
    await sendToWorker({
      companyId: input.companyId,
      workerId: input.workerId,
      textOriginal: `Which site are you at? ${names}`,
      textEn: `Which site are you at? ${names}`,
      language: input.language,
    });
    return;
  }

  log.info('location_matched_site', { siteCode: match.site.code, distanceM: Math.round(match.distanceM) });
}

/** C6 — reply first, create the case second, ask for a location pin third. */
async function handleEmergency(input: {
  companyId: string;
  workerId: string;
  messageId: string;
  transcript: string;
  language: string;
}): Promise<void> {
  await sendToWorker({
    companyId: input.companyId,
    workerId: input.workerId,
    textOriginal: emergencyReply(input.language),
    textEn: 'Emergency numbers sent; safety officer notified; asked for location.',
    language: input.language,
  });

  await audit({
    event: 'emergency_detected',
    severity: 'critical',
    companyId: input.companyId,
    actor: `worker:${input.workerId}`,
  });

  await trigger('case.createCritical', {
    companyId: input.companyId,
    workerId: input.workerId,
    messageId: input.messageId,
    transcript: input.transcript,
    language: input.language,
  });
}

/** Fallback when no model would answer: a human reads the raw transcript. */
async function routeUnderstood(input: {
  companyId: string;
  workerId: string;
  messageId: string;
  transcript: string;
  language: string;
  needsReview: boolean;
}): Promise<void> {
  await trigger('case.open', {
    companyId: input.companyId,
    workerId: input.workerId,
    messageId: input.messageId,
    transcript: input.transcript,
    language: input.language,
    category: 'other' as const,
    severity: 'medium' as CaseSeverity,
    summaryEn: input.transcript.slice(0, 300),
    needsReview: input.needsReview,
    injectionSuspected: false,
    confirmed: false,
    assetId: null,
  });
}

export const opsAlert = validatedTask({
  id: 'ops.alert',
  schema: z.object({ companyId: z.string().uuid(), reason: z.string().max(80) }).strict(),
  run: async ({ companyId, reason }) => {
    // Ops alerting is a log plus an audit row; wiring a pager is out of scope.
    await audit({ event: 'ops_alert', severity: 'critical', companyId, details: { reason } });
    return { alerted: true };
  },
});
