//@ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@org/shop-shared-ui', '@org/agent-models'],
  typescript: {
    tsconfigPath: 'tsconfig.app.json',
  },
};

module.exports = nextConfig;
