import { createUsageFeeMiddleware, usageFeeFields } from './usageFeeEngine.mjs';

export const FIXED_USD_FEE = 0.05;

export const handleUsageFee = createUsageFeeMiddleware({
  appId: process.env.MAKEX_APP_ID || 'makex-twitter-x',
  clientName: 'makex-x',
});

export { usageFeeFields };
