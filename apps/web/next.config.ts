import type { NextConfig } from 'next';

const internalApiUrl = process.env.INTERNAL_API_URL ?? 'http://127.0.0.1:4000';
const isDev = process.env.NODE_ENV !== 'production';
const isStrictProduction =
  process.env.NODE_ENV === 'production' && process.env.INFRA_PROFILE === 'production';

// D-06 : Content-Security-Policy explicite (préserve l'intégration preview en environnement sandbox)
const webContentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...(isStrictProduction ? ["frame-ancestors 'none'", 'upgrade-insecure-requests'] : []),
].join('; ');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@nexus-rh/shared-types'],
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: webContentSecurityPolicy },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), geolocation=(self), microphone=()',
          },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
          ...(isStrictProduction
            ? [
                { key: 'X-Frame-Options', value: 'DENY' },
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=63072000; includeSubDomains; preload',
                },
              ]
            : []),
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${internalApiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
