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
  reactStrictMode: false,
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
