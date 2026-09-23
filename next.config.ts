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
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          },
          {
            // NOTE: kept as SAMEORIGIN (not DENY) because this dashboard is
            // designed to be embedded by partner apps and by the sandbox
            // preview iframe. Tighten to DENY only if you drop embedding.
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
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
            // Content-Security-Policy was missing entirely. Eight other headers
            // were set, but CSP is the one that actually constrains injected
            // script — and with X-Frame-Options deliberately left at SAMEORIGIN
            // (partner embedding), frame-ancestors is the clickjacking control.
            //
            // `script-src` needs 'unsafe-inline': Next.js ships inline bootstrap
            // and hydration scripts, and removing it requires per-request nonces
            // threaded through the middleware. That is worth doing later; it is
            // not worth shipping no CSP until then. Everything an injected
            // script would want is still blocked — external hosts, eval, plugins,
            // base-tag hijacking, and form posts to another origin.
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              // Tailwind and framer-motion set inline styles at runtime.
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              // The dashboard talks to its own routes only. Supabase is reached
              // server-side, so no external connect-src is needed.
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
              "worker-src 'self' blob:",
              'upgrade-insecure-requests',
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
