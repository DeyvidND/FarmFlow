import type { Queue } from 'bullmq';

/**
 * Idempotently register a repeatable (cron-style) job. Calling this on every
 * worker boot is safe — the schedule ends up existing exactly once and each
 * fire is consumed by exactly one worker. Replaces in-process @Cron, which
 * would fire on every copy.
 *
 * A BullMQ schedule is keyed by its options (pattern/tz/…), NOT by name, so
 * simply re-adding after a pattern change (e.g. 08:00 → hourly) leaves the OLD
 * schedule live and the job double-fires. We therefore drop every existing
 * scheduler for this `name` first, then add the current one — so a changed
 * pattern fully replaces its predecessor.
 */
export async function registerRepeatable(
  queue: Queue,
  name: string,
  pattern: string,
): Promise<void> {
  try {
    const schedulers = await queue.getJobSchedulers(0, -1);
    for (const s of schedulers) {
      if (s?.name === name && s?.key) await queue.removeJobScheduler(s.key);
    }
  } catch {
    /* no scheduler store yet (first boot) — nothing to clear */
  }
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
