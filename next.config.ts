import type { NextConfig } from "next";

const nextConfig: NextConfig & { allowedDevOrigins?: string[] } = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  allowedDevOrigins: [
    "ais-dev-euerua7hv3ffzjninpghye-159837012533.europe-west3.run.app",
    "ais-pre-euerua7hv3ffzjninpghye-159837012533.europe-west3.run.app"
  ]
};

export default nextConfig;
