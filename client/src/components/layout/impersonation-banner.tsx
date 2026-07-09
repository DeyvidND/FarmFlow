/**
 * Persistent, impossible-to-miss strip shown above the panel chrome whenever the
 * current session is a super-admin "full-panel impersonation" (session carries
 * `actingAdminId`). Sits above the sidebar/topbar rather than inside them so it
 * can never be scrolled away or mistaken for a normal in-app notice.
 *
 * Shows the farm name when the shell already has it in scope (it does — the
 * `(admin)/layout.tsx` server component fetches `/tenants/me` regardless) so no
 * extra API call is needed here; falls back to a generic warning otherwise.
 */
export function ImpersonationBanner({ tenantName }: { tenantName?: string }) {
  return (
    <div
      role="alert"
      className="flex w-full shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-ff-red px-4 py-2 text-white"
    >
      <span className="text-[13.5px] font-bold leading-tight">
        {tenantName
          ? `⚠ Разглеждаш като ${tenantName} · платформен админ`
          : '⚠ Режим „платформен админ“ — разглеждаш чужд магазин'}
      </span>
      <a
        href="/api/session/exit-impersonation"
        className="shrink-0 rounded-lg bg-white/20 px-3 py-1.5 text-[13px] font-bold transition-colors hover:bg-white/30"
      >
        Изход
      </a>
    </div>
  );
}
