//@ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace libraries ship TypeScript source; the viewer reads local
  // agent data only (no network) through @agent/agent-eval.
  transpilePackages: ['@agent/agent-eval', '@agent/agent-models'],
};

module.exports = nextConfig;
