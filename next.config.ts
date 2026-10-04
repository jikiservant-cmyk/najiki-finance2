import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: false,
  },
  // Don't advertise the framework/version in responses.
  poweredByHeader: false,
  // Enabled. Disabling StrictMode opts out of React's double-invoke checks,
  // which exist to surface exactly the kind of stale-closure and
  // double-effect bugs this dashboard's polling hooks are prone to. It affects
  // development only — production builds are unchanged.
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            // Explicitly disable powerful browser features this app never uses.
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), usb=(), magnetometer=(), gyroscope=(), interest-cohort=()",
          },
          {
            key: "X-Permitted-Cross-Domain-Policies",
            value: "none",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              // Tailwind and framer-motion set inline styles at runtime.
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co ws: wss:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self' https://*.google.com https://*.run.app https://aistudio.google.com http://localhost:* https://localhost:*",
              "worker-src 'self' blob:",
            ].join('; '),
          },
        ],
      },
      {
        // Auth responses and API payloads must never be cached by a proxy.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
