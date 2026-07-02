/**
 * Orders-screen constants shared by the server page and the client list.
 *
 * IMPORTANT: keep these in a plain (non-`'use client'`) module. A Server Component
 * (`app/(admin)/orders/page.tsx`) reads ORDERS_PAGE_SIZE to build its SSR fetch. If
 * the constant lived in the `'use client'` orders-client module, importing it into
 * the server page yields `undefined` in a production build (client modules expose
 * only client references server-side, not their plain values) — the SSR URL then
 * becomes `?limit=undefined`, the API 400s, and the page renders "no orders". Dev
 * masks this because it evaluates the client module on the server.
 */
export const ORDERS_PAGE_SIZE = 12;
