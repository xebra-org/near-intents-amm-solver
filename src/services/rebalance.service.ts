import bs58 from 'bs58';
import type { RebalanceRequest, Rebalancer } from '@xebra/sdk/intents';
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { rebalanceConfig as cfg } from '../configs/rebalance.config';
import { intentsContract } from '../configs/intents.config';
import { teeEnabled } from '../configs/tee.config';
import { tokens } from '../configs/tokens.config';
import { SignStandardEnum } from '../interfaces/intents.interface';
import { serializeIntent } from '../utils/hashing';
import { makeNonReentrant } from '../utils/make-nonreentrant';
import { planRebalance, validatePolicy, type RebalancePolicy } from '../utils/rebalance-plan';
import { checkWithdrawalIntent } from '../utils/withdrawal-intent';
import { IntentsService } from './intents.service';
import { LoggerService } from './logger.service';
import { NearService } from './near.service';
import { QuoterService } from './quoter.service';

const USDC_DECIMALS = 6;

// @xebra/sdk is ESM-only; this solver is CommonJS, so it is loaded with import() in init().
type Sdk = typeof import('@xebra/sdk');
type IntentsSdk = typeof import('@xebra/sdk/intents');

/**
 * Keeps the pool's two USDC balances (one chain each) from running dry. When one side falls below
 * REBALANCE_MIN_SHARE of the pair, it moves USDC from the full side over CCTP, through Xebra:
 *
 *   1. withdraw the full side's USDC from NEAR Intents to the solver's own EVM wallet (1Click)
 *   2. burn it with CCTP from that wallet into a 1Click deposit address on the other chain
 *   3. 1Click credits the solver's Intents account with the other chain's USDC
 *
 * The solver's own money and keys throughout; Xebra builds the burn and never holds anything.
 */
export class RebalanceService {
  private logger = new LoggerService('rebalance');
  private sdk!: Sdk;
  private intents!: IntentsSdk;
  private rebalancer!: Rebalancer;
  private wallet?: PrivateKeyAccount;
  private policy!: RebalancePolicy;
  /** Set when a run fails after money left NEAR Intents. Needs a person; never retried. */
  private halted = false;

  public constructor(
    private readonly nearService: NearService,
    private readonly intentsService: IntentsService,
    private readonly quoterService: QuoterService,
  ) {}

  public async init(): Promise<void> {
    if (teeEnabled) throw new Error('Rebalancing is not supported in TEE mode (the pool contract holds the balance)');
    if (!cfg.chains[0] || !cfg.chains[1]) {
      throw new Error('Set REBALANCE_TOKEN1_CHAIN and REBALANCE_TOKEN2_CHAIN to the chains of the two USDC tokens');
    }
    [this.sdk, this.intents] = await Promise.all([import('@xebra/sdk'), import('@xebra/sdk/intents')]);
    const { toUnits } = this.intents;
    this.policy = {
      minShare: cfg.minShare,
      targetShare: cfg.targetShare,
      minAmount: BigInt(toUnits(cfg.minAmount, USDC_DECIMALS)),
    };
    validatePolicy(this.policy);

    if (cfg.evmPrivateKey) this.wallet = privateKeyToAccount(cfg.evmPrivateKey as Hex);
    if (!cfg.dryRun && (!this.wallet || !cfg.oneClickApiKey)) {
      throw new Error('REBALANCE_DRY_RUN=false needs REBALANCE_EVM_PRIVATE_KEY and ONECLICK_API_KEY');
    }

    this.rebalancer = this.intents.createRebalancer({
      xebra: this.sdk.createXebraClient(cfg.xebraApiUrl ? { baseUrl: cfg.xebraApiUrl } : {}),
      oneClick: { apiKey: cfg.oneClickApiKey },
    });
    this.logger.info(
      `Rebalancing ${cfg.chains.join(' <-> ')} USDC, ${cfg.dryRun ? 'DRY RUN' : 'LIVE'}, ` +
        `trigger below ${cfg.minShare * 100}%, target ${cfg.targetShare * 100}%, max fee ${cfg.maxFee} USDC`,
    );
  }

  public start(): void {
    setInterval(() => this.tick(), cfg.intervalMs);
    this.tick();
  }

  private tick = makeNonReentrant(async () => {
    if (this.halted) return;
    try {
      await this.rebalanceOnce();
    } catch (error) {
      this.logger.error('Rebalance failed', error as Error);
    }
  });

  /** One check, and one move if the balances call for it. Exposed for scripts and tests. */
  public async rebalanceOnce(): Promise<void> {
    const balances = (await this.intentsService.getBalancesOnContract(tokens)).map(BigInt) as [bigint, bigint];
    const plan = planRebalance(balances, this.policy);
    const fmt = (u: bigint) => this.intents.fromUnits(u.toString(), USDC_DECIMALS);
    if (!plan) {
      this.logger.debug(`Balanced: ${cfg.chains[0]} ${fmt(balances[0])}, ${cfg.chains[1]} ${fmt(balances[1])}`);
      return;
    }

    const evm = this.wallet?.address ?? '0x0000000000000000000000000000000000000001';
    const req: RebalanceRequest = {
      intentsAccount: this.nearService.getIntentsAccountId(),
      from: cfg.chains[plan.from],
      to: cfg.chains[plan.to],
      amount: fmt(plan.amount),
      fromWallet: evm,
      toWallet: evm,
      speed: cfg.speed,
    };

    const est = await this.rebalancer.estimate(req);
    if (est.fromAsset !== tokens[plan.from] || est.toAsset !== tokens[plan.to]) {
      throw new Error(
        `Configured tokens ${tokens.join(', ')} are not Circle USDC on ${cfg.chains.join(', ')} ` +
          `(1Click lists ${est.fromAsset} and ${est.toAsset})`,
      );
    }
    const direct = est.direct.arrives === null ? `no quote (${est.direct.reason})` : `${est.direct.arrives}`;
    this.logger.info(
      `${req.from} ${fmt(balances[plan.from])} -> ${req.to} ${fmt(balances[plan.to])}: move ${req.amount}, ` +
        `arrives ${est.arrives} (fees ${est.fees.total}: withdraw ${est.fees.withdraw}, cctp ${est.fees.cctp}, ` +
        `~${Math.round(est.seconds / 60)} min). Same move as one Intents swap: ${direct}.`,
    );
    if (est.better === 'direct') {
      this.logger.info('A direct swap inside NEAR Intents leaves more; not rebalancing over CCTP.');
      return;
    }
    if (Number(est.fees.total) > Number(cfg.maxFee)) {
      this.logger.warn(`Fees ${est.fees.total} exceed REBALANCE_MAX_FEE ${cfg.maxFee}; not rebalancing.`);
      return;
    }
    if (cfg.dryRun) {
      this.logger.info('Dry run: would rebalance now.');
      return;
    }
    await this.execute({ ...req, maxTotalFee: cfg.maxFee }, est.fromAsset, plan.amount);
  }

  private async execute(req: RebalanceRequest, fromAsset: string, units: bigint): Promise<void> {
    const log = this.logger.toScopeLogger(`${req.from}->${req.to}`);

    // 1. Withdraw to the solver's EVM wallet. Nothing has left Intents until submit.
    const w = await this.rebalancer.startWithdrawal(req, 'nep413');
    const payload = checkWithdrawalIntent(w.intent, {
      signerId: req.intentsAccount,
      intentsContract,
      depositAddress: w.depositAddress,
      asset: fromAsset,
      units,
    });
    const hash = serializeIntent(payload.message, payload.recipient, payload.nonce, SignStandardEnum.nep413);
    const sig = await this.nearService.signMessage(hash);
    const { intentHash } = await this.rebalancer.submitWithdrawal(w, {
      signature: `ed25519:${bs58.encode(sig.signature)}`,
      public_key: `ed25519:${bs58.encode(sig.publicKey.data)}`,
    });
    log.info(`Withdrawal submitted: intent ${intentHash}, ${w.receives} USDC to ${req.fromWallet} on ${req.from}`);

    // From here on the money is outside NEAR Intents; a failure needs a person, not a retry.
    try {
      const ws = await this.rebalancer.waitFor(w.depositAddress);
      if (ws !== 'SUCCESS') throw new Error(`Withdrawal ended ${ws}`);

      // 2. Burn from the wallet into a 1Click deposit address on the other chain.
      const d = await this.rebalancer.prepareDeposit(req, { amount: w.receives });
      for (const step of d.build.steps) {
        if (step.tx.kind !== 'evm') throw new Error(`Unexpected ${step.tx.kind} step`);
        const tx = await this.send(step.tx);
        log.info(`${step.id} on ${step.chain}: ${tx}`);
      }
      log.info(`Burned ${w.receives} USDC into ${d.depositAddress} on ${req.to}; waiting for Circle and 1Click`);

      // 3. 1Click credits the Intents account once Circle mints.
      const ds = await this.rebalancer.waitFor(d.depositAddress);
      if (ds !== 'SUCCESS') throw new Error(`Deposit ended ${ds} (a refund goes to ${req.toWallet} on ${req.to})`);
      log.info(`Rebalanced: ${d.xebra.recipientGets} USDC credited on ${req.to}`);
      await this.quoterService.updateCurrentState();
    } catch (error) {
      this.halted = true;
      log.error(
        'Rebalance stopped midway; halting further rebalances until restart. Check the wallet.',
        error as Error,
      );
    }
  }

  private async send(tx: { chainId: number; to: string; data: string }): Promise<Hex> {
    const meta = this.sdk.evmChainForChainId(tx.chainId);
    if (!meta) throw new Error(`Unknown EVM chain ${tx.chainId}`);
    const chain = defineChain({
      id: meta.chainId,
      name: meta.name,
      nativeCurrency: meta.nativeCurrency,
      rpcUrls: { default: { http: [cfg.rpcUrls[meta.id] ?? meta.rpcUrl] } },
    });
    const transport = http();
    const wallet = createWalletClient({ account: this.wallet!, chain, transport });
    const reader = createPublicClient({ chain, transport });
    const hash = await wallet.sendTransaction({ to: tx.to as Hex, data: tx.data as Hex, value: 0n });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
    return hash;
  }
}
