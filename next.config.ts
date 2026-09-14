import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets you load the dev server from a phone/other device on the same
  // LAN (e.g. http://10.43.36.x:3000) for testing the contest flow with a
  // real second player. Add more IPs here if you test from other devices;
  // this only affects `next dev`, not production builds.
  allowedDevOrigins: ["10.43.36.125", "192.168.1.126"],
};

export default nextConfig;
