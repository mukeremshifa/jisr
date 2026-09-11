import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { auth0 } from './lib/auth0';

/**
 * Two jobs, in order:
 *
 *  1. Auth0 handles /auth/* and attaches the session. Everything else requires
 *     one, so an unauthenticated request is redirected to login rather than
 *     reaching a page that would then have to remember to check.
 *  2. A per-request nonce Content-Security-Policy. No 'unsafe-inline', and no
 *     third-party script origins: the dashboard loads nothing it did not ship.
 */

const PUBLIC_PATHS = ['/auth', '/_next', '/favicon.ico', '/healthz'];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  const authResponse = await auth0.middleware(request);
  if (pathname.startsWith('/auth')) return withCsp(request, authResponse);

  if (!PUBLIC_PATHS.some((prefix) => pathname.startsWith(prefix))) {
    const session = await auth0.getSession(request);
    if (!session) {
      const loginUrl = new URL('/auth/login', request.nextUrl.origin);
      loginUrl.searchParams.set('returnTo', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // CSRF, second layer: a state-changing request must come from our own origin.
    // Server Actions also carry Next's own origin check.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.get('origin');
      if (origin && origin !== request.nextUrl.origin) {
        return new NextResponse(null, { status: 403 });
      }
    }
  }

  return withCsp(request, authResponse);
}

function withCsp(request: NextRequest, response: NextResponse): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https://storage.googleapis.com`,
    `media-src 'self' https://storage.googleapis.com`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');

  const headers = new Headers(response.headers);
  headers.set('content-security-policy', csp);
  headers.set('x-nonce', nonce);

  // Pass the nonce through to the render, so Next can stamp its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const next = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of headers) next.headers.set(key, value);
  for (const cookie of response.cookies.getAll()) next.cookies.set(cookie);
  return next;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
