# delivery-web — Implementation Plan (sub-project 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A new Next.js app `delivery-web` (modeled on `admin/`) that reuses the farmer-panel design system, authenticates standalone delivery accounts via an httpOnly cookie + `/bff` proxy to the econt API, and ships the bulk-import + live-editor screen — replacing the bare Alpine `/app`.

**Architecture:** Copy admin's scaffold + design tokens; swap the API base to the econt service (`API_URL=http://econt:3100`), the cookie to `ff_delivery_session`, and the auth endpoints to econt `/auth/{login,signup,me}`. One screen (`/import`) ported from the existing Alpine `server/public/econt-app/app.js`. New container + deploy wiring; operator repoints the `dostavki` tunnel to it.

**Tech Stack:** Next 14.2.35 (app-router, standalone output), React 18, Tailwind 3.4 (`ff-` tokens), lucide-react, sonner. No Sentry in v1 (deferred — keeps next.config simple; API-side errors still captured).

**Spec:** `docs/superpowers/specs/2026-06-25-delivery-web-design.md`

**Reference app:** `admin/` is the template. "Copy verbatim" below means `cp` the named admin file unchanged; edits are shown explicitly.

**Branch:** `feat/delivery-web` (already created off `main`; NOT auto-deployed until merged).

**Commands:**
- Install: `pnpm install`
- Build one app: `pnpm --filter @fermeribg/delivery-web build`
- Lint: `pnpm --filter @fermeribg/delivery-web lint`

---

## File structure (`delivery-web/`)

| File | Source |
|---|---|
| `package.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `tsconfig.json`, `.eslintrc.json`, `next-env.d.ts`, `.gitignore` | scaffold (new/adapted) |
| `src/app/globals.css`, `src/app/icon.svg` | copy verbatim from `admin/` |
| `src/app/layout.tsx` | copy + retitle |
| `src/lib/utils.ts` | copy verbatim |
| `src/lib/session.ts`, `src/lib/api-client.ts` | new |
| `src/middleware.ts` | adapted |
| `src/app/bff/[...path]/route.ts` | copy verbatim |
| `src/app/api/session/{login,signup,logout}/route.ts` | new/adapted |
| `src/app/(auth)/login/page.tsx` | new (login + signup) |
| `src/app/(panel)/layout.tsx`, `src/components/panel-chrome.tsx` | adapted/new |
| `src/app/(panel)/import/page.tsx`, `src/components/import-client.tsx` | new (port) |
| repo: `pnpm-workspace.yaml`, `delivery-web/Dockerfile`, `.github/workflows/deploy.yml`, `infra/hetzner/docker-compose.yml`, `infra/hetzner/README.md` | wiring |

---

## Task DW-1: Scaffold a buildable skeleton

**Files:** create the `delivery-web/` scaffold + register the workspace.

- [ ] **Step 1: Register the workspace** — add `delivery-web` to `pnpm-workspace.yaml`:
```yaml
packages:
  - "server"
  - "client"
  - "admin"
  - "delivery-web"
  - "storefront"
  - "packages/*"
```

- [ ] **Step 2: `delivery-web/package.json`**
```json
{
  "name": "@fermeribg/delivery-web",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3003",
    "build": "next build",
    "start": "next start -p 3003",
    "lint": "next lint"
  },
  "dependencies": {
    "clsx": "^2.1.1",
    "lucide-react": "^0.453.0",
    "next": "14.2.35",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "sonner": "^2.0.7",
    "tailwind-merge": "^2.5.4",
    "tailwindcss-animate": "^1.0.7"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.0",
    "autoprefixer": "^10.4.20",
    "eslint": "^8.57.1",
    "eslint-config-next": "14.2.35",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "typescript": "~5.6.0"
  }
}
```

- [ ] **Step 3: `delivery-web/next.config.mjs`** (admin's, minus the Sentry wrap)
```js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_OUTPUT_STANDALONE === '1' ? 'standalone' : undefined,
  outputFileTracingRoot: join(__dirname, '..'),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 4: Copy the boilerplate from admin verbatim**
```bash
mkdir -p delivery-web/src/app delivery-web/src/lib delivery-web/src/components
cp admin/postcss.config.mjs delivery-web/postcss.config.mjs
cp admin/tailwind.config.ts delivery-web/tailwind.config.ts
cp admin/tsconfig.json delivery-web/tsconfig.json
cp admin/.eslintrc.json delivery-web/.eslintrc.json 2>/dev/null || true
cp admin/next-env.d.ts delivery-web/next-env.d.ts 2>/dev/null || true
cp admin/src/app/globals.css delivery-web/src/app/globals.css
cp admin/src/app/icon.svg delivery-web/src/app/icon.svg 2>/dev/null || true
cp admin/src/lib/utils.ts delivery-web/src/lib/utils.ts
```
If `admin/.eslintrc.json` doesn't exist, create `delivery-web/.eslintrc.json`:
```json
{ "extends": "next/core-web-vitals" }
```
If `admin/next-env.d.ts` wasn't copied, create `delivery-web/next-env.d.ts`:
```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

- [ ] **Step 5: `delivery-web/src/app/layout.tsx`** (admin's, retitled)
```tsx
import type { Metadata } from 'next';
import { Commissioner, Bitter } from 'next/font/google';
import './globals.css';

const commissioner = Commissioner({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-commissioner',
  display: 'swap',
});
const bitter = Bitter({
  subsets: ['latin', 'cyrillic'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-bitter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ФермериБГ · Доставка',
  description: 'ФермериБГ — масов внос и управление на пратки.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg" className={`${commissioner.variable} ${bitter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: temporary root page so `next build` succeeds** — `delivery-web/src/app/page.tsx`:
```tsx
import { redirect } from 'next/navigation';
export default function Home() {
  redirect('/import');
}
```

- [ ] **Step 7: Install + build**
```
pnpm install
pnpm --filter @fermeribg/delivery-web build
```
Expected: install resolves the new workspace; build succeeds (it will compile the redirect page; `/import` 404 at runtime is fine for now).

- [ ] **Step 8: Commit**
```bash
git add pnpm-workspace.yaml delivery-web/ pnpm-lock.yaml
git commit -m "feat(delivery-web): scaffold Next app (admin-modeled, ff- design system)"
```

---

## Task DW-2: Auth plumbing — session, BFF, middleware, route handlers

**Files:** `src/lib/session.ts`, `src/app/bff/[...path]/route.ts`, `src/middleware.ts`, `src/app/api/session/{login,signup,logout}/route.ts`.

- [ ] **Step 1: `src/lib/session.ts`**
```ts
/** Standalone delivery-account session: the econt JWT in an httpOnly cookie,
 *  bridged to the API's Authorization: Bearer by the route handlers. Own cookie
 *  name so it never collides with the farmer or super-admin sessions. */
export const SESSION_COOKIE = 'ff_delivery_session';

/** Matches the API JWT expiresIn: '7d'. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

/** The standalone delivery (econt) API. */
export const API_BASE = process.env.API_URL ?? 'http://localhost:3100';

/** Dig the human message out of the API's (possibly nested) error body. */
export function extractApiMessage(body: unknown): string | undefined {
  const outer = (body as { message?: unknown })?.message;
  const inner =
    outer && typeof outer === 'object' && !Array.isArray(outer)
      ? (outer as { message?: unknown }).message
      : outer;
  if (Array.isArray(inner)) return typeof inner[0] === 'string' ? inner[0] : undefined;
  if (typeof inner === 'string') return inner;
  return undefined;
}
```

- [ ] **Step 2: copy the BFF proxy verbatim** (it's generic — uses `API_BASE`/`SESSION_COOKIE`):
```bash
mkdir -p "delivery-web/src/app/bff/[...path]"
cp "admin/src/app/bff/[...path]/route.ts" "delivery-web/src/app/bff/[...path]/route.ts"
```

- [ ] **Step 3: `src/middleware.ts`** (admin's, with delivery routes). Copy `admin/src/middleware.ts` then replace the `isProtected` list, the authed→home redirect target, and the matcher:
```ts
  const isProtected = ['/import'].some((p) => pathname === p || pathname.startsWith(p + '/'));
```
```ts
  if (authed && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/import';
    return NextResponse.redirect(url);
  }
```
```ts
export const config = {
  matcher: ['/import/:path*', '/import', '/login'],
};
```
(Keep the `decodeJwtPayload`/`tokenStatus` helpers and the invalid-cookie wipe verbatim.)

- [ ] **Step 4: `src/app/api/session/login/route.ts`** (econt login path + `{accessToken}`):
```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE, extractApiMessage } from '@/lib/session';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const fwd = req.headers.get('cf-connecting-ip') ?? undefined;

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
    body: JSON.stringify({ email: body?.email, password: body?.password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.accessToken) {
    return NextResponse.json({ message: extractApiMessage(data) ?? 'Грешен имейл или парола' }, { status: res.status || 401 });
  }
  cookies().set(SESSION_COOKIE, data.accessToken, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production', maxAge: SESSION_MAX_AGE,
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: `src/app/api/session/signup/route.ts`** (standalone self-registration → econt `/auth/signup` returns `{accessToken}`):
```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE, extractApiMessage } from '@/lib/session';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const fwd = req.headers.get('cf-connecting-ip') ?? undefined;

  const res = await fetch(`${API_BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
    body: JSON.stringify({
      email: body?.email,
      password: body?.password,
      farmName: body?.farmName,
      phone: body?.phone || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.accessToken) {
    return NextResponse.json({ message: extractApiMessage(data) ?? 'Регистрацията се провали' }, { status: res.status || 400 });
  }
  cookies().set(SESSION_COOKIE, data.accessToken, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production', maxAge: SESSION_MAX_AGE,
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6: `src/app/api/session/logout/route.ts`**
```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/session';

function clear() {
  cookies().delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/login', process.env.PUBLIC_URL ?? 'http://localhost:3003'));
}
export async function GET() { return clear(); }
export async function POST() { return clear(); }
```
(The redirect base is only used locally; in prod the relative `/login` is what matters — Next resolves it against the request. If `PUBLIC_URL` isn't set, the localhost fallback is harmless because the browser follows the path.)

- [ ] **Step 7: Build**
```
pnpm --filter @fermeribg/delivery-web build
```
Expected: success (routes compile).

- [ ] **Step 8: Commit**
```bash
git add delivery-web/src
git commit -m "feat(delivery-web): cookie session + BFF proxy + login/signup/logout routes"
```

---

## Task DW-3: Login/signup page + panel gate + shell

**Files:** `src/app/(auth)/login/page.tsx`, `src/app/(panel)/layout.tsx`, `src/components/panel-chrome.tsx`. Remove the temporary `src/app/page.tsx` (the `/` redirect now lives behind the gate; keep it — it redirects to `/import`, which the middleware will bounce to `/login` if unauthed). Keep `page.tsx`.

- [ ] **Step 1: `src/components/panel-chrome.tsx`** (topbar shell, sonner toaster)
```tsx
'use client';

import { Toaster } from 'sonner';
import { Leaf, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function PanelChrome({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  async function logout() {
    await fetch('/api/session/logout', { method: 'POST' }).catch(() => {});
    router.push('/login');
    router.refresh();
  }
  return (
    <div className="min-h-screen bg-ff-bg">
      <header className="sticky top-0 z-10 flex h-[var(--topbar-h,64px)] items-center justify-between border-b border-ff-border bg-[rgba(251,248,241,0.85)] px-8 backdrop-blur-md max-sm:px-4">
        <div className="flex items-center gap-[11px]">
          <div className="grid h-[38px] w-[38px] place-items-center rounded-[11px] bg-ff-green-700 text-[#EAF1E4]">
            <Leaf size={22} strokeWidth={1.9} />
          </div>
          <div className="leading-[1.1]">
            <div className="font-display text-[17px] font-extrabold tracking-[-0.01em]">ФермериБГ · Доставка</div>
            <div className="mt-0.5 text-[11.5px] font-semibold text-ff-muted">Масов внос на пратки</div>
          </div>
        </div>
        <button
          onClick={logout}
          className="inline-flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2"
        >
          <LogOut size={17} /> <span className="max-sm:hidden">Изход</span>
        </button>
      </header>
      <main className="mx-auto max-w-[1100px] px-8 py-8 max-sm:px-4">{children}</main>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            fontFamily: 'var(--font-commissioner)', borderRadius: '12px',
            border: '1px solid var(--ff-border)', background: 'var(--ff-surface)',
            color: 'var(--ff-ink)', fontWeight: 600,
          },
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: `src/app/(panel)/layout.tsx`** (server gate against econt `/auth/me`)
```tsx
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PanelChrome } from '@/components/panel-chrome';

export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');

  const me = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  if (!me) redirect('/api/session/logout');

  return <PanelChrome>{children}</PanelChrome>;
}
```

- [ ] **Step 3: `src/app/(auth)/login/page.tsx`** (login + signup toggle)
```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Leaf } from 'lucide-react';

type Mode = 'login' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [farmName, setFarmName] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/session/login' : '/api/session/signup';
      const payload =
        mode === 'login'
          ? { email: email.trim(), password }
          : { email: email.trim(), password, farmName: farmName.trim(), phone: phone.trim() };
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.message || 'Грешка');
      }
      router.push('/import');
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Грешка');
    } finally {
      setBusy(false);
    }
  }

  const input =
    'h-11 w-full rounded-xl border border-ff-border bg-ff-bg px-3.5 text-[15px] outline-none focus:border-ff-green-500';

  return (
    <div className="grid min-h-screen place-items-center bg-ff-bg px-4">
      <div className="w-[420px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-7 shadow-ff-lg">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-[12px] bg-ff-green-700 text-[#EAF1E4]">
            <Leaf size={24} strokeWidth={1.9} />
          </div>
          <div>
            <div className="font-display text-[19px] font-extrabold">ФермериБГ · Доставка</div>
            <div className="text-[12.5px] text-ff-muted">{mode === 'login' ? 'Вход в системата' : 'Нова регистрация'}</div>
          </div>
        </div>

        <div className="mb-4 flex gap-1 rounded-xl bg-ff-surface-2 p-1">
          <button type="button" onClick={() => setMode('login')} className={tabCls(mode === 'login')}>Вход</button>
          <button type="button" onClick={() => setMode('signup')} className={tabCls(mode === 'signup')}>Регистрация</button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === 'signup' && (
            <input className={input} placeholder="Име на фирмата / фермата" value={farmName} onChange={(e) => setFarmName(e.target.value)} required minLength={2} />
          )}
          <input className={input} type="email" placeholder="Имейл" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          <input className={input} type="password" placeholder="Парола" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'signup' ? 12 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {mode === 'signup' && (
            <input className={input} type="tel" placeholder="Телефон (по избор)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          )}
          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}
          <button type="submit" disabled={busy} className="mt-1 h-11 rounded-xl bg-ff-green-700 text-[15px] font-bold text-white hover:brightness-95 disabled:opacity-60">
            {busy ? 'Моля изчакайте…' : mode === 'login' ? 'Вход' : 'Създай акаунт'}
          </button>
          {mode === 'signup' && <p className="text-[12px] text-ff-muted">Паролата трябва да е поне 12 знака.</p>}
        </form>
      </div>
    </div>
  );
}

function tabCls(active: boolean) {
  return `flex-1 rounded-lg px-3 py-2 text-[13.5px] font-bold transition-colors ${active ? 'bg-ff-surface text-ff-ink shadow-ff-sm' : 'text-ff-muted hover:text-ff-ink-2'}`;
}
```

- [ ] **Step 4: Build**
```
pnpm --filter @fermeribg/delivery-web build
```
Expected: success. (At runtime `/login` renders; `/import` still 404 — next task.)

- [ ] **Step 5: Commit**
```bash
git add delivery-web/src
git commit -m "feat(delivery-web): login/signup page + panel shell + server auth gate"
```

---

## Task DW-4: Bulk-import screen (React port)

**Files:** `src/lib/api-client.ts`, `src/components/import-client.tsx`, `src/app/(panel)/import/page.tsx`. Port of `server/public/econt-app/app.js` + `index.html`, in `ff-` styling (mobile cards like `admin/src/components/tenants-client.tsx`).

- [ ] **Step 1: `src/lib/api-client.ts`**
```ts
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}
function firstMsg(body: unknown, fallback: string): string {
  const outer = (body as { message?: unknown })?.message;
  const inner = outer && typeof outer === 'object' && !Array.isArray(outer) ? (outer as { message?: unknown }).message : outer;
  if (Array.isArray(inner)) return typeof inner[0] === 'string' ? inner[0] : fallback;
  if (typeof inner === 'string') return inner;
  return fallback;
}
async function bff(path: string, init?: RequestInit, fallback = 'Възникна грешка'): Promise<Response> {
  const res = await fetch(`/bff/${path}`, init);
  if (!res.ok) {
    const b = await res.clone().json().catch(() => ({}));
    throw new ApiError(res.status, firstMsg(b, fallback));
  }
  return res;
}

export interface ImportRow {
  id: string;
  rowIndex: number;
  receiverName: string | null;
  receiverPhone: string | null;
  deliveryMode: 'office' | 'address' | null;
  city: string | null;
  office: string | null;
  address: string | null;
  weightGrams: number | null;
  codAmountStotinki: number | null;
  carrier: 'econt' | 'speedy';
  validationStatus: 'ok' | 'warn' | 'error';
  validation?: { issues?: Array<{ message: string }> } | null;
  shipmentId?: string | null;
}
export interface ImportBatch {
  batch: { id: string; aiReport?: { aiAvailable?: boolean } | null };
  rows: ImportRow[];
}

export const uploadBatch = async (file: File, settings: Record<string, string>): Promise<ImportBatch> => {
  const fd = new FormData();
  fd.append('file', file);
  Object.entries(settings).forEach(([k, v]) => { if (v != null && v !== '') fd.append(k, v); });
  const res = await bff('import/batches', { method: 'POST', body: fd }, 'Качването се провали');
  return res.json();
};
export const getBatch = async (id: string): Promise<ImportBatch> =>
  (await bff(`import/batches/${id}`)).json();
export const patchRow = async (batchId: string, rowId: string, patch: Partial<ImportRow>): Promise<ImportRow> =>
  (await bff(`import/batches/${batchId}/rows/${rowId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })).json();
export const deleteRow = async (batchId: string, rowId: string): Promise<void> => {
  await bff(`import/batches/${batchId}/rows/${rowId}`, { method: 'DELETE' });
};
export const commitBatch = async (batchId: string): Promise<{ results: Array<{ status: string; shipmentId?: string }>; failed?: number }> =>
  (await bff(`import/batches/${batchId}/commit`, { method: 'POST' }, 'Създаването се провали')).json();
export const downloadLabels = async (carrier: 'econt' | 'speedy', ids: string[]): Promise<void> => {
  const path = carrier === 'speedy' ? 'speedy/labels.pdf' : 'shipping/labels.pdf';
  const res = await bff(`${path}?ids=${ids.join(',')}`);
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), '_blank');
};
export const templateUrl = '/bff/import/template.xlsx';
```

- [ ] **Step 2: `src/components/import-client.tsx`** (the editor)
```tsx
'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  ApiError, uploadBatch, patchRow, deleteRow, commitBatch, downloadLabels, templateUrl,
  type ImportRow,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function ImportClient() {
  const [settings, setSettings] = useState({ carrier: 'econt', currency: 'EUR', weightGrams: '1000', speedyServiceId: '' });
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [ai, setAi] = useState('');
  const [busy, setBusy] = useState(false);

  const count = (s: string) => rows.filter((r) => r.validationStatus === s).length;

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const data = await uploadBatch(file, settings);
      setBatchId(data.batch.id);
      setRows(data.rows);
      setAi(data.batch.aiReport?.aiAvailable ? '' : 'AI проверка недостъпна — само базова проверка.');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  async function save(r: ImportRow) {
    if (!batchId) return;
    try {
      const updated = await patchRow(batchId, r.id, {
        receiverName: r.receiverName, receiverPhone: r.receiverPhone, deliveryMode: r.deliveryMode,
        city: r.city, office: r.office, address: r.address, weightGrams: r.weightGrams,
        codAmountStotinki: r.codAmountStotinki, carrier: r.carrier,
      });
      setRows((p) => p.map((x) => (x.id === r.id ? updated : x)));
    } catch (e) { toast.error(errMsg(e)); }
  }

  async function del(r: ImportRow) {
    if (!batchId) return;
    try { await deleteRow(batchId, r.id); setRows((p) => p.filter((x) => x.id !== r.id)); }
    catch (e) { toast.error(errMsg(e)); }
  }

  async function commit() {
    if (!batchId) return;
    setBusy(true);
    try {
      const res = await commitBatch(batchId);
      const created = res.results.filter((x) => x.status === 'created').length;
      toast.success(`Създадени ${created} пратки`);
      if (res.failed) toast.error(`${res.failed} реда не успяха — виж „Проблеми".`);
      const { getBatch } = await import('@/lib/api-client');
      setRows((await getBatch(batchId)).rows);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  const labelIds = (carrier: 'econt' | 'speedy') => rows.filter((r) => r.shipmentId && r.carrier === carrier).map((r) => r.shipmentId!) as string[];

  function patch(r: ImportRow, k: keyof ImportRow, v: unknown) {
    setRows((p) => p.map((x) => (x.id === r.id ? { ...x, [k]: v } : x)));
  }

  const inp = 'w-full rounded-lg border border-ff-border bg-ff-surface px-2 py-1.5 text-[13.5px] outline-none focus:border-ff-green-500';
  const rowBg = (s: string) => (s === 'ok' ? 'bg-ff-green-50' : s === 'warn' ? 'bg-ff-amber-softer' : 'bg-[#FBE9E7]');

  return (
    <div className="animate-ff-fade-up">
      <h1 className="font-display text-[24px] font-extrabold tracking-[-0.015em]">Масов внос на пратки</h1>

      {/* settings bar */}
      <div className="mt-4 flex flex-wrap items-center gap-2.5 rounded-xl border border-ff-border bg-ff-surface p-3 shadow-ff-sm">
        <select className={inp + ' w-auto'} value={settings.carrier} onChange={(e) => setSettings({ ...settings, carrier: e.target.value })}>
          <option value="econt">Econt</option><option value="speedy">Speedy</option>
        </select>
        <select className={inp + ' w-auto'} value={settings.currency} onChange={(e) => setSettings({ ...settings, currency: e.target.value })}>
          <option value="EUR">EUR</option><option value="BGN">BGN</option>
        </select>
        <input className={inp + ' w-[140px]'} type="number" placeholder="Тегло (г)" value={settings.weightGrams} onChange={(e) => setSettings({ ...settings, weightGrams: e.target.value })} />
        <input className={inp + ' w-[150px]'} type="number" placeholder="Speedy serviceId" value={settings.speedyServiceId} onChange={(e) => setSettings({ ...settings, speedyServiceId: e.target.value })} />
        <input className="text-[13px]" type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button onClick={upload} disabled={!file || busy} className="rounded-xl bg-ff-green-700 px-4 py-2 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60">Качи и провери</button>
        <a href={templateUrl} className="text-[13.5px] font-bold text-ff-green-700 hover:underline">Свали шаблон</a>
      </div>
      {ai && <p className="mt-2 text-[12.5px] text-ff-muted">{ai}</p>}

      {rows.length > 0 && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-ff-green-50 px-2.5 py-1 text-[12.5px] font-bold text-ff-green-700">Зелени: {count('ok')}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-ff-amber-softer px-2.5 py-1 text-[12.5px] font-bold text-ff-amber-600">Жълти: {count('warn')}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-[#FBE9E7] px-2.5 py-1 text-[12.5px] font-bold text-ff-red">Червени: {count('error')}</span>
            <button onClick={commit} disabled={busy} className="ml-auto rounded-xl bg-ff-green-700 px-4 py-2 text-[13.5px] font-bold text-white hover:brightness-95 disabled:opacity-60">{busy ? 'Създавам…' : 'Създай пратки'}</button>
            {labelIds('econt').length > 0 && <button onClick={() => downloadLabels('econt', labelIds('econt'))} className="rounded-xl border border-ff-border bg-ff-surface px-3 py-2 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">⬇ Етикети (Econt)</button>}
            {labelIds('speedy').length > 0 && <button onClick={() => downloadLabels('speedy', labelIds('speedy'))} className="rounded-xl border border-ff-border bg-ff-surface px-3 py-2 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2">⬇ Етикети (Speedy)</button>}
          </div>

          {/* desktop table */}
          <div className="mt-3 overflow-x-auto rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm max-[900px]:hidden">
            <table className="w-full border-collapse text-[13px]">
              <thead><tr className="border-b border-ff-border bg-ff-surface-2 text-left">
                {['#', 'Получател', 'Телефон', 'Реж.', 'Град', 'Офис/Адрес', 'Тегло(г)', 'НП(ст.)', 'Куриер', 'Проблеми', ''].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.03em] text-ff-muted">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-ff-border-2 last:border-0 ${rowBg(r.validationStatus)}`}>
                    <td className="px-3 py-2">{r.rowIndex}</td>
                    <td className="px-3 py-2"><input className={inp} value={r.receiverName ?? ''} onChange={(e) => patch(r, 'receiverName', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><input className={inp} value={r.receiverPhone ?? ''} onChange={(e) => patch(r, 'receiverPhone', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><select className={inp} value={r.deliveryMode ?? 'office'} onChange={(e) => { patch(r, 'deliveryMode', e.target.value); }} onBlur={() => save(r)}><option value="office">офис</option><option value="address">адрес</option></select></td>
                    <td className="px-3 py-2"><input className={inp} value={r.city ?? ''} onChange={(e) => patch(r, 'city', e.target.value)} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2">
                      {r.deliveryMode === 'office'
                        ? <input className={inp} placeholder="Офис" value={r.office ?? ''} onChange={(e) => patch(r, 'office', e.target.value)} onBlur={() => save(r)} />
                        : <input className={inp} placeholder="Адрес" value={r.address ?? ''} onChange={(e) => patch(r, 'address', e.target.value)} onBlur={() => save(r)} />}
                    </td>
                    <td className="px-3 py-2"><input className={inp} type="number" value={r.weightGrams ?? ''} onChange={(e) => patch(r, 'weightGrams', e.target.value === '' ? null : Number(e.target.value))} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><input className={inp} type="number" value={r.codAmountStotinki ?? ''} onChange={(e) => patch(r, 'codAmountStotinki', e.target.value === '' ? null : Number(e.target.value))} onBlur={() => save(r)} /></td>
                    <td className="px-3 py-2"><select className={inp} value={r.carrier} onChange={(e) => { patch(r, 'carrier', e.target.value); }} onBlur={() => save(r)}><option value="econt">Econt</option><option value="speedy">Speedy</option></select></td>
                    <td className="px-3 py-2 text-[12px] text-ff-muted">{(r.validation?.issues ?? []).map((i) => i.message).join('; ')}</td>
                    <td className="px-3 py-2"><button onClick={() => del(r)} className="rounded-lg border border-[#e0a0a0] px-2 py-1 text-[12px] font-bold text-ff-red hover:bg-[#FBE9E7]">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* mobile cards */}
          <div className="mt-3 hidden flex-col gap-3 max-[900px]:flex">
            {rows.map((r) => (
              <div key={r.id} className={`rounded-xl border-2 p-3 ${rowBg(r.validationStatus)} ${r.validationStatus === 'ok' ? 'border-[#a5d6a7]' : r.validationStatus === 'warn' ? 'border-[#ffe082]' : 'border-[#ef9a9a]'}`}>
                {([
                  ['Получател', 'receiverName', 'text'], ['Телефон', 'receiverPhone', 'tel'], ['Град', 'city', 'text'],
                  [r.deliveryMode === 'office' ? 'Офис' : 'Адрес', r.deliveryMode === 'office' ? 'office' : 'address', 'text'],
                  ['Тегло (г)', 'weightGrams', 'number'], ['НП (ст.)', 'codAmountStotinki', 'number'],
                ] as const).map(([label, key, type]) => (
                  <label key={key} className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                    <span className="text-[12px] font-bold text-ff-muted">{label}</span>
                    <input className={inp} type={type} value={(r[key as keyof ImportRow] as string | number | null) ?? ''}
                      onChange={(e) => patch(r, key as keyof ImportRow, type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
                      onBlur={() => save(r)} />
                  </label>
                ))}
                <label className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                  <span className="text-[12px] font-bold text-ff-muted">Режим</span>
                  <select className={inp} value={r.deliveryMode ?? 'office'} onChange={(e) => patch(r, 'deliveryMode', e.target.value)} onBlur={() => save(r)}><option value="office">офис</option><option value="address">адрес</option></select>
                </label>
                <label className="mb-2 grid grid-cols-[96px_1fr] items-center gap-2">
                  <span className="text-[12px] font-bold text-ff-muted">Куриер</span>
                  <select className={inp} value={r.carrier} onChange={(e) => patch(r, 'carrier', e.target.value)} onBlur={() => save(r)}><option value="econt">Econt</option><option value="speedy">Speedy</option></select>
                </label>
                {(r.validation?.issues ?? []).length > 0 && <p className="text-[12px] text-ff-red">{(r.validation?.issues ?? []).map((i) => i.message).join('; ')}</p>}
                <button onClick={() => del(r)} className="mt-1 w-full rounded-lg border border-[#e0a0a0] py-2 text-[12.5px] font-bold text-ff-red hover:bg-[#FBE9E7]">✕ Изтрий</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: `src/app/(panel)/import/page.tsx`**
```tsx
import { ImportClient } from '@/components/import-client';
export const dynamic = 'force-dynamic';
export default function ImportPage() {
  return <ImportClient />;
}
```

- [ ] **Step 4: Build + lint**
```
pnpm --filter @fermeribg/delivery-web build
pnpm --filter @fermeribg/delivery-web lint
```
Expected: both succeed.

- [ ] **Step 5: Commit**
```bash
git add delivery-web/src
git commit -m "feat(delivery-web): bulk-import + live-editor screen (React port, ff- styled)"
```

---

## Task DW-5: Deploy wiring

**Files:** `delivery-web/Dockerfile`, `.github/workflows/deploy.yml`, `infra/hetzner/docker-compose.yml`, `infra/hetzner/README.md`.

- [ ] **Step 1: `delivery-web/Dockerfile`** (admin's, names/port → delivery-web/3003, no Sentry build-arg)
```dockerfile
# syntax=docker/dockerfile:1
# Production image for the delivery panel (@fermeribg/delivery-web), Next.js standalone.
# Build from the repo ROOT: `docker build -f delivery-web/Dockerfile -t fermeribg-delivery-web .`
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
ENV PNPM_HOME=/pnpm PATH="/pnpm:$PATH" NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
ENV NEXT_OUTPUT_STANDALONE=1
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter "@fermeribg/delivery-web..." run build

FROM base AS runner
ENV NODE_ENV=production PORT=3003 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/delivery-web/.next/standalone ./
COPY --from=build /app/delivery-web/.next/static ./delivery-web/.next/static
COPY --from=build /app/delivery-web/public ./delivery-web/public
EXPOSE 3003
USER node
CMD ["node", "delivery-web/server.js"]
```
Note: create an empty `delivery-web/public/.gitkeep` so the `COPY … public` layer never fails.

- [ ] **Step 2: `deploy.yml` — add to the build matrix** (after the `admin` entry):
```yaml
          - app: delivery-web
            image: ghcr.io/deyvidnd/farmflow-delivery-web
            dockerfile: delivery-web/Dockerfile
            build_args: ''
```
And add `delivery-web` to the box pull line in the deploy job:
```bash
            docker compose pull api web admin econt delivery-web
```

- [ ] **Step 3: `infra/hetzner/docker-compose.yml` — add the service** (after `admin`):
```yaml
  delivery-web:
    image: ghcr.io/deyvidnd/farmflow-delivery-web:${IMAGE_TAG:-latest}
    pull_policy: always
    restart: unless-stopped
    depends_on: [econt]
    environment:
      NODE_ENV: production
      API_URL: http://econt:3100
```
And add it to the cloudflared `depends_on`:
```yaml
    depends_on: [api, web, admin, econt, delivery-web]
```

- [ ] **Step 4: `infra/hetzner/README.md` — repoint note.** Replace the delivery tunnel hostname line so it targets the panel, not the API:
```
   `dostavki.fermeribg.com` → `http://delivery-web:3003` (the Next panel; it proxies
   to `econt:3100` internally via /bff). The `econt` service is now API-only.
```

- [ ] **Step 5: Validate compose**
```bash
cd infra/hetzner && touch .env && POSTGRES_PASSWORD=x REDIS_PASSWORD=y CF_TUNNEL_TOKEN=z docker compose config -q && echo OK; rm -f .env; cd ../..
```
Expected: `OK`.

- [ ] **Step 6: Commit**
```bash
git add delivery-web/Dockerfile delivery-web/public/.gitkeep .github/workflows/deploy.yml infra/hetzner/docker-compose.yml infra/hetzner/README.md
git commit -m "feat(deploy): delivery-web image + compose service; tunnel → delivery-web"
```

---

## Task DW-6: Verify

- [ ] **Step 1: Full build + lint**
```
pnpm --filter @fermeribg/delivery-web build
pnpm --filter @fermeribg/delivery-web lint
```
Expected: green.

- [ ] **Step 2: Boot smoke (local).** With the econt API on `:3100` (build server dist, `DATABASE_URL=…fermeribg… node server/dist/main.econt.js`), run the panel:
```
API_URL=http://localhost:3100 pnpm --filter @fermeribg/delivery-web dev
```
Then check `http://localhost:3003`:
- `/login` renders (panel styling), signup creates an account + redirects to `/import`.
- `/import` upload of `C:/Users/Lenovo/ff-audit/import-sample.csv` → coloured editable rows; edit+blur saves; commit → 403 toast pre-activation (expected).
- no-cookie `GET /import` → redirects to `/login`.
Stop both after.

- [ ] **Step 3: Commit any fixups**
```bash
git add -A && git commit -m "chore(delivery-web): verification green" || echo "nothing to commit"
```

---

## Self-review checklist

- **Spec coverage:** scaffold/design-system (DW-1) · cookie+BFF auth, login+signup (DW-2/3) · shell (DW-3) · import screen port (DW-4) · new container + compose + tunnel repoint (DW-5). httpOnly cookie (no localStorage) ✓. Sentry deferred (noted). Later screens out of scope ✓.
- **Type consistency:** `SESSION_COOKIE`/`API_BASE` shared (session.ts); `ImportRow`/`ImportBatch` shared between api-client + import-client; BFF path `import/*` matches econt routes; econt auth endpoints `/auth/{login,signup,me}` + `{accessToken}` response match `standalone-auth.*`.
- **Money:** COD shown/edited as raw stotinki (matches the API + the old Alpine UI); no conversion in the panel.
- **Ports:** dev/prod 3003 consistent (package.json, Dockerfile, compose tunnel target).
