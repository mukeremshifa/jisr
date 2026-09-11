import type { NextConfig } from 'next';

/**
 * The dashboard is same-origin only: no CORS, no framing, no third-party script
 * hosts. The Content-Security-Policy is set per request in middleware.ts, where
 * a nonce is available; everything static lives here.
 */
const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript sources.
  transpilePackages: ['@jisr/core', '@jisr/db', '@jisr/integrations'],
  serverExternalPackages: ['postgres', 'sharp', '@google-cloud/storage'],
  experimental: {
    // Server Actions keep Next's built-in origin check; this narrows it further.
    serverActions: { allowedOrigins: [new URL(process.env.APP_BASE_URL ?? 'http://localhost:3000').host] },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default config;
