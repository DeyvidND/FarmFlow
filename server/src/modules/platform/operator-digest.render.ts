/** Pure renderer for the operator's daily digest email. No DB, no email — just
 *  input → { html, text, isEmpty }. Kept dependency-free so it is unit-testable. */

export interface OperatorDigestInput {
  pulse: {
    orders24h: number;
    revenue24hStotinki: number;
    newSignups: { name: string; createdAt: Date | null }[];
  };
  /** Farms needing attention (the "call list"), pre-sorted by urgency. */
  signals: { name: string; phone: string | null; signals: { label: string; action: string }[] }[];
  stuckDrafts: { farmerName: string; tenantName: string; count: number; oldestAt: Date | null }[];
  emailTotals: { recipientTotal: number; revenueStotinki: number; marginStotinki: number };
}

export interface OperatorDigestRender {
  html: string;
  text: string;
  isEmpty: boolean;
}

function eur(stotinki: number): string {
  return (stotinki / 100).toFixed(2).replace('.', ',') + ' €';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Whole days since `d` (0 if null/future), for "преди N дни". */
function daysAgo(d: Date | null, nowMs: number): number {
  if (!d) return 0;
  return Math.max(0, Math.floor((nowMs - new Date(d).getTime()) / 86_400_000));
}

export function assembleDigest(input: OperatorDigestInput, date: string, nowMs = Date.now()): OperatorDigestRender {
  const { pulse, signals, stuckDrafts, emailTotals } = input;

  const isEmpty =
    signals.length === 0 &&
    stuckDrafts.length === 0 &&
    pulse.newSignups.length === 0 &&
    pulse.orders24h === 0;

  // ── HTML sections ──
  const pulseHtml =
    pulse.orders24h > 0
      ? `<p style="font-size:14px;color:#555">Поръчки (24ч): <strong>${pulse.orders24h}</strong> &nbsp;|&nbsp; Приход: <strong>${eur(pulse.revenue24hStotinki)}</strong></p>`
      : '';

  const attentionHtml =
    signals.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Ферми за внимание (${signals.length})</h2>` +
        signals
          .map((f) => {
            const items = f.signals
              .map((s) => `<li>${escapeHtml(s.label)} — <span style="color:#555">${escapeHtml(s.action)}</span></li>`)
              .join('');
            return `
        <div style="margin:0 0 12px;padding:10px 12px;border:1px solid #eee;border-radius:8px">
          <div style="font-weight:bold">${escapeHtml(f.name)} <span style="font-weight:normal;color:#2d6a4f">${escapeHtml(f.phone ?? '—')}</span></div>
          <ul style="margin:6px 0 0;padding-left:18px;font-size:14px">${items}</ul>
        </div>`;
          })
          .join('')
      : '';

  const signupsHtml =
    pulse.newSignups.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Нови регистрации (24ч) (${pulse.newSignups.length})</h2>` +
        `<ul style="font-size:14px">${pulse.newSignups.map((s) => `<li>${escapeHtml(s.name)}</li>`).join('')}</ul>`
      : '';

  const draftsHtml =
    stuckDrafts.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Заседнали доставки (${stuckDrafts.length})</h2>` +
        `<ul style="font-size:14px">${stuckDrafts
          .map((d) => `<li>${escapeHtml(d.farmerName)} · ${escapeHtml(d.tenantName)} — <strong>${d.count}</strong> чернови (най-стара преди ${daysAgo(d.oldestAt, nowMs)} дни)</li>`)
          .join('')}</ul>`
      : '';

  const emailHtml =
    emailTotals.recipientTotal > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Имейл приход (този месец)</h2>` +
        `<p style="font-size:14px;color:#555">Получатели: <strong>${emailTotals.recipientTotal}</strong> &nbsp;|&nbsp; Приход: <strong>${eur(emailTotals.revenueStotinki)}</strong> &nbsp;|&nbsp; Марж: <strong>${eur(emailTotals.marginStotinki)}</strong></p>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Дневен отчет за ${date}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">Дневен отчет за ${date}</h1>
  ${pulseHtml}
  ${attentionHtml}
  ${signupsHtml}
  ${draftsHtml}
  ${emailHtml}
  <p style="font-size:12px;color:#999;margin-top:32px">ФермериБГ — автоматичен отчет за оператора</p>
</body>
</html>`;

  // ── Text sections ──
  const lines: string[] = [`Дневен отчет за ${date}`, ''];
  if (pulse.orders24h > 0) {
    lines.push(`Поръчки (24ч): ${pulse.orders24h} | Приход: ${eur(pulse.revenue24hStotinki)}`, '');
  }
  if (signals.length > 0) {
    lines.push(`Ферми за внимание (${signals.length}):`);
    for (const f of signals) {
      lines.push(`  • ${f.name} — ${f.phone ?? '—'}`);
      for (const s of f.signals) lines.push(`      - ${s.label} — ${s.action}`);
    }
    lines.push('');
  }
  if (pulse.newSignups.length > 0) {
    lines.push(`Нови регистрации (24ч) (${pulse.newSignups.length}):`);
    for (const s of pulse.newSignups) lines.push(`  • ${s.name}`);
    lines.push('');
  }
  if (stuckDrafts.length > 0) {
    lines.push(`Заседнали доставки (${stuckDrafts.length}):`);
    for (const d of stuckDrafts) lines.push(`  • ${d.farmerName} · ${d.tenantName} — ${d.count} чернови (преди ${daysAgo(d.oldestAt, nowMs)} дни)`);
    lines.push('');
  }
  if (emailTotals.recipientTotal > 0) {
    lines.push(`Имейл приход (този месец): получатели ${emailTotals.recipientTotal} | приход ${eur(emailTotals.revenueStotinki)} | марж ${eur(emailTotals.marginStotinki)}`, '');
  }

  return { html, text: lines.join('\n'), isEmpty };
}
