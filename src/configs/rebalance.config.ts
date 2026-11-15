/**
 * Cross-chain USDC rebalancing through Xebra (CCTP). Off unless REBALANCE_ENABLED=true, and a dry
 * run (estimates and logs only, moves nothing) unless REBALANCE_DRY_RUN=false.
 */

const env = process.env;

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return v.toLowerCase() === 'true';
}

function rpcMap(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (v ?? '').split(',')) {
    const [chain, url] = pair.split('=').map((s) => s.trim());
    if (chain && url) out[chain] = url;
  }
  return out;
}

export const rebalanceConfig = {
  enabled: bool(env.REBALANCE_ENABLED, false),
  dryRun: bool(env.REBALANCE_DRY_RUN, true),
  /** Xebra chain names of AMM_TOKEN1_ID and AMM_TOKEN2_ID, e.g. "base" and "arbitrum". */
  chains: [env.REBALANCE_TOKEN1_CHAIN ?? '', env.REBALANCE_TOKEN2_CHAIN ?? ''] as [string, string],
  minShare: Number(env.REBALANCE_MIN_SHARE ?? 0.25),
  targetShare: Number(env.REBALANCE_TARGET_SHARE ?? 0.5),
  /** Decimal USDC. */
  minAmount: env.REBALANCE_MIN_AMOUNT ?? '100',
  /** Decimal USDC: skip when withdrawal + CCTP fees together exceed this. */
  maxFee: env.REBALANCE_MAX_FEE ?? '5',
  speed: (env.REBALANCE_SPEED === 'fast' ? 'fast' : 'standard') as 'fast' | 'standard',
  intervalMs: Number(env.REBALANCE_INTERVAL_SEC ?? 300) * 1000,
  /** Partner key from partners.near-intents.org; the withdrawal step needs it. */
  oneClickApiKey: env.ONECLICK_API_KEY || undefined,
  /** Signs the CCTP burn on the full side's chain; the same address receives refunds on the other. */
  evmPrivateKey: env.REBALANCE_EVM_PRIVATE_KEY || undefined,
  /** "base=https://...,arbitrum=https://..."; chains not listed use the public RPC Xebra lists. */
  rpcUrls: rpcMap(env.REBALANCE_RPC_URLS),
  xebraApiUrl: env.XEBRA_API_URL || undefined,
};
