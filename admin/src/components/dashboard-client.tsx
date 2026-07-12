import Link from 'next/link';
import {
  Users,
  CheckCircle2,
  FlaskConical,
  AlertTriangle,
  Phone,
  MessageCircle,
  ChevronRight,
  Activity,
  LineChart,
  ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  PlatformTenant,
  PlatformInsights,
  ProblemsResponse,
  FarmSignals,
  ProblemSeverity,
} from '@/lib/api-client';

/** BG phone → viber deep-link number (digits only, international). */
function viberNumber(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits.slice(1);
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `359${digits.slice(1)}`;
  return digits;
}

function severityDot(sev: number): string {
  return sev >= 80 ? 'bg-ff-red' : sev >= 60 ? 'bg-ff-amber-600' : 'bg-ff-amber';
}

function Stat({
  Icon,
  label,
  value,
  sub,
  tone = 'neutral',
  anchor = false,
  delay = 0,
}: {
  Icon: typeof Users;
  label: string;
  value: number | string;
  sub?: string;
  tone?: 'neutral' | 'good' | 'demo' | 'alert';
  /** The one filled dark-green tile — the focal anchor that ties the KPI row to
   *  the navigation spine. Exactly one per row (accents work because they're rare). */
  anchor?: boolean;
  delay?: number;
}) {
  const style = { animationDelay: `${delay}ms` };
  if (anchor) {
    return (
      <div
        style={style}
        className="animate-ff-fade-up rounded-2xl bg-ff-green-900 p-5 shadow-ff-md [animation-fill-mode:backwards]"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-ff-amber text-ff-green-950">
            <Icon size={18} strokeWidth={2.1} />
          </span>
          <span className="text-[13px] font-bold text-ff-green-100">{label}</span>
        </div>
        <div className="ff-fig mt-3.5 text-[40px] font-extrabold leading-none text-white">{value}</div>
        {sub && <div className="mt-1.5 text-[12.5px] text-ff-sidebar-muted">{sub}</div>}
      </div>
    );
  }
  const chip =
    tone === 'good'
      ? 'bg-ff-green-50 text-ff-green-700'
      : tone === 'demo'
        ? 'bg-ff-demo-soft text-ff-demo'
        : tone === 'alert'
          ? 'bg-ff-red-soft text-ff-red'
          : 'bg-ff-surface-2 text-ff-ink-2';
  return (
    <div
      style={style}
      className="animate-ff-fade-up rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm [animation-fill-mode:backwards]"
    >
      <div className="flex items-center gap-2.5">
        <span className={cn('grid h-9 w-9 place-items-center rounded-[10px]', chip)}>
          <Icon size={18} />
        </span>
        <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
      </div>
      <div className={cn('ff-fig mt-3.5 text-[34px] font-extrabold leading-none', tone === 'alert' ? 'text-ff-red' : 'text-ff-ink')}>
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[12.5px] text-ff-muted">{sub}</div>}
    </div>
  );
}

function AttentionRow({ f }: { f: FarmSignals }) {
  const vb = f.phone ? viberNumber(f.phone) : null;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-ff-border bg-ff-surface p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', severityDot(f.maxSeverity))} />
        <div className="min-w-0">
          <Link
            href={`/tenants/${f.tenantId}`}
            className="inline-flex items-center gap-1 text-[15px] font-extrabold text-ff-ink no-underline hover:text-ff-green-700 hover:underline"
          >
            {f.name}
            <ChevronRight size={14} className="text-ff-muted-2" />
          </Link>
          <ul className="mt-2 flex flex-col gap-1.5">
            {f.signals.slice(0, 3).map((s) => (
              <li key={s.key} className="text-[13px] leading-tight text-ff-ink-2">
                <span className="font-semibold">{s.label}</span>
                <span className="text-ff-muted"> → {s.action}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {f.phone && (
        <div className="flex shrink-0 items-center gap-2 pl-5 sm:pl-0">
          {vb && (
            <a
              href={`viber://chat?number=%2B${vb}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-700 px-3 py-2 text-[12.5px] font-bold text-ff-green-on hover:bg-ff-green-800"
            >
              <MessageCircle size={15} /> Viber
            </a>
          )}
          <a
            href={`tel:${f.phone}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[12.5px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
          >
            <Phone size={15} /> Обади се
          </a>
        </div>
      )}
    </li>
  );
}

const PROBLEM_TONE: Record<ProblemSeverity, string> = {
  high: 'bg-ff-red',
  med: 'bg-ff-amber-600',
  low: 'bg-ff-muted-2',
};

function QuickLink({ href, Icon, label }: { href: string; Icon: typeof Users; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm transition-colors hover:bg-ff-surface-2 hover:text-ff-ink"
    >
      <Icon size={17} /> {label}
    </Link>
  );
}

export function DashboardClient({
  tenants,
  insights,
  problems,
}: {
  tenants: PlatformTenant[];
  insights: PlatformInsights | null;
  problems: ProblemsResponse | null;
}) {
  // Count real vs demo straight from the live tenants list (same source as the
  // Ферми screen) — never lump demos into the „real farms" figure, and don't
  // depend on the separately-cached insights.totalFarms which can drift.
  const total = tenants.filter((t) => !t.isDemo).length;
  const active = tenants.filter((t) => t.subscriptionStatus === 'active' && !t.isDemo).length;
  const pastDue = tenants.filter((t) => t.subscriptionStatus === 'past_due' && !t.isDemo).length;
  const demo = tenants.filter((t) => t.isDemo).length;

  const problemItems = problems?.items ?? [];
  const highCount = problemItems.filter((p) => p.severity === 'high').length;
  const attention = [...(insights?.signals ?? [])].sort((a, b) => b.maxSeverity - a.maxSeverity).slice(0, 5);

  return (
    <div className="animate-ff-fade-up flex flex-col gap-7">
      {/* KPI row — one filled anchor tile, the rest light. Staggered entrance. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat Icon={Users} label="Ферми" value={total} sub="реални акаунти" anchor delay={0} />
        <Stat
          Icon={CheckCircle2}
          label="Активни"
          value={active}
          tone="good"
          sub={pastDue > 0 ? `${pastDue} просрочени` : 'с достъп'}
          delay={70}
        />
        <Stat Icon={FlaskConical} label="Демо" value={demo} tone="demo" sub="временни акаунти" delay={140} />
        <Stat
          Icon={AlertTriangle}
          label="Проблеми"
          value={problemItems.length}
          tone={highCount > 0 ? 'alert' : 'neutral'}
          sub={highCount > 0 ? `${highCount} спешни` : 'всичко под контрол'}
          delay={210}
        />
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap gap-2.5">
        <QuickLink href="/tenants" Icon={Users} label="Всички ферми" />
        <QuickLink href="/problems" Icon={AlertTriangle} label="Проблеми" />
        <QuickLink href="/health" Icon={Activity} label="Здраве" />
        <QuickLink href="/insights" Icon={LineChart} label="Анализ" />
      </div>

      <div className="grid grid-cols-1 gap-7 lg:grid-cols-[1.4fr_1fr]">
        {/* Farms needing attention */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-[18px] font-extrabold tracking-[-0.01em]">Искат внимание</h2>
            <Link href="/insights" className="inline-flex items-center gap-1 text-[13px] font-bold text-ff-green-700 hover:underline">
              Пълен анализ <ArrowRight size={14} />
            </Link>
          </div>
          {attention.length > 0 ? (
            <ul className="flex flex-col gap-2.5">
              {attention.map((f) => (
                <AttentionRow key={f.tenantId} f={f} />
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-ff-border bg-ff-surface p-8 text-center">
              <CheckCircle2 size={26} className="mx-auto text-ff-green-600" />
              <p className="mt-2 text-[14px] font-semibold text-ff-ink-2">Няма ферми, които искат внимание.</p>
              <p className="mt-0.5 text-[13px] text-ff-muted">Всички магазини се движат нормално.</p>
            </div>
          )}
        </section>

        {/* Latest problems feed */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-[18px] font-extrabold tracking-[-0.01em]">Последни проблеми</h2>
            <Link href="/problems" className="inline-flex items-center gap-1 text-[13px] font-bold text-ff-green-700 hover:underline">
              Всички <ArrowRight size={14} />
            </Link>
          </div>
          {problemItems.length > 0 ? (
            <ul className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
              {problemItems.slice(0, 6).map((p, i) => (
                <li key={`${p.kind}-${p.tenantId ?? i}`} className="flex items-start gap-3 border-b border-ff-border-2 px-4 py-3 last:border-0">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', PROBLEM_TONE[p.severity])} />
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-bold text-ff-ink">{p.title}</div>
                    <div className="text-[12.5px] leading-snug text-ff-muted">{p.detail}</div>
                    {p.tenantName && <div className="mt-0.5 text-[12px] font-semibold text-ff-green-700">{p.tenantName}</div>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-ff-border bg-ff-surface p-8 text-center">
              <CheckCircle2 size={26} className="mx-auto text-ff-green-600" />
              <p className="mt-2 text-[14px] font-semibold text-ff-ink-2">Чисто е.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
