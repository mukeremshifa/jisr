import { Auth0Client } from '@auth0/nextjs-auth0/server';

/**
 * Auth0 Universal Login. Jisr builds no password handling of its own — sign-ups
 * are disabled on the connection, and brute-force protection, breached-password
 * detection and bot detection are configured in the tenant (docs/security.md).
 *
 * The session cookie is HttpOnly, Secure and SameSite=Lax, encrypted with
 * AUTH0_SECRET, with a short absolute lifetime.
 */
export const auth0 = new Auth0Client({
  session: {
    // Eight hours absolute, and the cookie does not outlive the browser session.
    absoluteDuration: 8 * 60 * 60,
    rolling: false,
    // HttpOnly is not configurable here: the SDK always sets it.
    cookie: { sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' },
  },
});
