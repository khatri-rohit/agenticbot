//@ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@org/agent-models',
    'streamdown',
    '@streamdown/code',
    '@streamdown/mermaid',
  ],
  typescript: {
    tsconfigPath: 'tsconfig.app.json',
  },
};

module.exports = nextConfig;
