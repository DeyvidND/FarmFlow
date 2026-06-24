import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/session';

function clear() {
  cookies().delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL('/login', process.env.PUBLIC_URL ?? 'http://localhost:3003'));
}
export async function GET() { return clear(); }
export async function POST() { return clear(); }
