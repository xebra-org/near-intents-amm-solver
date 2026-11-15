import { planRebalance, RebalancePolicy } from '../src/utils/rebalance-plan';

const USDC = 1_000_000n;
const policy: RebalancePolicy = { minShare: 0.25, targetShare: 0.5, minAmount: 100n * USDC };

test('balanced pool: no plan', () => {
  expect(planRebalance([500n * USDC, 500n * USDC], policy)).toBeNull();
});

test('just above the trigger: no plan', () => {
  expect(planRebalance([250n * USDC, 750n * USDC], policy)).toBeNull();
});

test('below the trigger: moves the full side down to the target share', () => {
  expect(planRebalance([200n * USDC, 800n * USDC], policy)).toEqual({ from: 1, to: 0, amount: 300n * USDC });
  expect(planRebalance([900n * USDC, 100n * USDC], policy)).toEqual({ from: 0, to: 1, amount: 400n * USDC });
});

test('one side empty', () => {
  expect(planRebalance([0n, 10_000n * USDC], policy)).toEqual({ from: 1, to: 0, amount: 5_000n * USDC });
});

test('empty pool: no plan', () => {
  expect(planRebalance([0n, 0n], policy)).toBeNull();
});

test('move smaller than minAmount: no plan', () => {
  // 10 + 90: the 10 side is 10%, but topping up to 50 is only 40 USDC.
  expect(planRebalance([10n * USDC, 90n * USDC], policy)).toBeNull();
});

test('never moves more than the full side holds', () => {
  for (const [a, b] of [
    [1n, 999_999_999n],
    [0n, 1n],
    [123_456n, 98_765_432_100n],
  ] as const) {
    const plan = planRebalance([a, b], { ...policy, minAmount: 0n });
    if (plan) expect(plan.amount).toBeLessThanOrEqual([a, b][plan.from]);
  }
});

test('rejects policies that would flip or never trigger', () => {
  expect(() => planRebalance([1n, 1n], { ...policy, targetShare: 0.6 })).toThrow();
  expect(() => planRebalance([1n, 1n], { ...policy, targetShare: 0.2 })).toThrow();
  expect(() => planRebalance([1n, 1n], { ...policy, minShare: 0 })).toThrow();
});
