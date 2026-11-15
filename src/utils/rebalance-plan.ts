/**
 * Decides whether the pool's two USDC balances are lopsided enough to move money between them,
 * and how much. Pure: balances in, plan out. Amounts are integer units of 6-decimal USDC.
 */

export interface RebalancePolicy {
  /** Rebalance when the smaller side holds less than this share of the pair, e.g. 0.25. */
  minShare: number;
  /** Top the smaller side up to this share of the pair, e.g. 0.5. */
  targetShare: number;
  /** Don't move less than this many units (fees make small moves pointless). */
  minAmount: bigint;
}

export interface RebalancePlan {
  /** Index into the pair of the side that is too full. */
  from: 0 | 1;
  /** Index of the side that needs topping up. */
  to: 0 | 1;
  /** Units to move out of `from`. */
  amount: bigint;
}

const SCALE = 1_000_000n;

function share(x: number): bigint {
  if (!Number.isFinite(x) || x <= 0 || x >= 1) throw new Error(`Share must be between 0 and 1, got ${x}`);
  return BigInt(Math.round(x * Number(SCALE)));
}

export function validatePolicy(p: RebalancePolicy): void {
  const min = share(p.minShare);
  const target = share(p.targetShare);
  if (target <= min) throw new Error('targetShare must be above minShare');
  if (target > SCALE / 2n) throw new Error('targetShare above 0.5 would just flip the imbalance');
  if (p.minAmount < 0n) throw new Error('minAmount must not be negative');
}

export function planRebalance(balances: readonly [bigint, bigint], p: RebalancePolicy): RebalancePlan | null {
  validatePolicy(p);
  const [a, b] = balances;
  if (a < 0n || b < 0n) throw new Error('Negative balance');
  const total = a + b;
  if (total === 0n) return null;

  const to: 0 | 1 = a <= b ? 0 : 1;
  const from: 0 | 1 = to === 0 ? 1 : 0;
  const low = balances[to];

  if (low * SCALE >= share(p.minShare) * total) return null;

  const amount = (share(p.targetShare) * total) / SCALE - low;
  if (amount <= 0n || amount < p.minAmount) return null;
  return { from, to, amount };
}
