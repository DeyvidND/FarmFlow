/**
 * Run the suite in the timezone PRODUCTION runs in.
 *
 * No TZ is set in server/Dockerfile or any compose/deploy file, so the prod
 * container is UTC — and so is CI (ubuntu-latest). Developer machines here are
 * Europe/Sofia. Any code reading a local getter (`Date#getDate()`, `getMonth()`,
 * `getHours()`) instead of the Europe/Sofia helpers in common/time/bg-time.ts is
 * therefore CORRECT on a dev machine and WRONG in prod, and no test run locally
 * can tell the difference.
 *
 * That gap shipped a real bug: handover-pdf's `dateBg` used local getters, so a
 * протокол signed at 01:30 Sofia printed the previous day's date on the legal
 * document — invisible to every local test run.
 *
 * Node reads TZ once at startup, so setting it inside a test is a no-op; it has to
 * be here, before jest forks its workers (they inherit this env).
 */
module.exports = async () => {
  process.env.TZ = 'UTC';
};
