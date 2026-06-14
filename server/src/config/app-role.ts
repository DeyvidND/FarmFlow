export type AppRole = 'all' | 'web' | 'worker';

/** Parse APP_ROLE; anything unrecognised (incl. undefined/empty) → 'all' so the
 *  default single-box deploy keeps doing everything, unchanged. */
export function parseAppRole(value?: string): AppRole {
  return value === 'web' || value === 'worker' ? value : 'all';
}

/** Does this copy run BullMQ workers + register repeatable (cron) jobs?
 *  'all' and 'worker' do; 'web' is HTTP + enqueue only. */
export function runsWorkers(value?: string): boolean {
  return parseAppRole(value) !== 'web';
}

/** Computed once at boot from the process env. Feature modules use this to
 *  conditionally register their processor provider (so a `web` copy never starts
 *  a worker). Reading process.env directly is fine — APP_ROLE is fixed per process. */
export const RUN_WORKERS = runsWorkers(process.env.APP_ROLE);
