import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Exclude Python backend app/ from Turbopack input
  turbopack: {
    inputfs: "./src",
  },
};

export default nextConfig;
