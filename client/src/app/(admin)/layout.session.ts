/**
 * What the admin shell should do with the `/tenants/me` probe result on
 * every panel load (see `layout.tsx`).
 *
 * `res === null` means the request never completed — offline, DNS failure,
 * connection refused. That says NOTHING about whether the token is valid.
 * Only an explicit 401/403 proves the token itself is bad; everything else
 * (network failure, 5xx) must NOT destroy a working session — the courier
 * on a signal-less rural road needs the panel (and its offline cache) to
 * keep working, not get logged out because the API is briefly unreachable.
 */
export function sessionVerdict(
  res: { ok: boolean; status: number } | null,
): 'ok' | 'reject' | 'unreachable' {
  if (res === null) return 'unreachable';
  if (res.ok) return 'ok';
  if (res.status === 401 || res.status === 403) return 'reject';
  return 'unreachable';
}
