import type { Queue } from 'bullmq';

/**
 * Idempotently register a repeatable (cron-style) job. BullMQ keys the schedule
 * by `jobId`, so calling this on every worker boot is safe — the schedule exists
 * exactly once and each fire is consumed by exactly one worker. Replaces in-process
 * @Cron, which would fire on every copy.
 */
export async function registerRepeatable(
  queue: Queue,
  name: string,
  pattern: string,
): Promise<void> {
  await queue.add(
    name,
    {},
    {
      jobId: name,
      repeat: { pattern, tz: 'Europe/Sofia' },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
