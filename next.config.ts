import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-hosted deployment: a standalone server bundle, no platform-specific output.
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
