import { queue } from '@trigger.dev/sdk';

/**
 * Queues, not just concurrency limits.
 *
 * `intakeQueue` is used with `concurrencyKey = workerId`, so one worker's
 * messages are processed strictly in order while different workers run in
 * parallel. Without that, a "yes" can overtake the read-back it answers.
 *
 * `outboundQueue` throttles broadcast fan-out so a 200-worker send does not hit
 * Twilio all at once.
 */
export const intakeQueue = queue({
  name: 'intake',
  concurrencyLimit: 20,
});

export const outboundQueue = queue({
  name: 'outbound',
  concurrencyLimit: 5,
});

export const caseQueue = queue({
  name: 'case',
  concurrencyLimit: 20,
});
