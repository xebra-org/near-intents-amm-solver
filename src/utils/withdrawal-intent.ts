/**
 * The withdrawal intent comes from 1Click's /v0/generate-intent. The solver signs it with the key
 * that controls its whole NEAR Intents balance, so it checks first that the intent does exactly
 * one thing: transfer at most the requested amount of the one asset to the quote's deposit address.
 */

export interface Nep413Payload {
  message: string;
  nonce: string;
  recipient: string;
  callbackUrl?: string | null;
}

export interface ExpectedWithdrawal {
  signerId: string;
  intentsContract: string;
  depositAddress: string;
  /** e.g. "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" */
  asset: string;
  /** Integer units. */
  units: bigint;
}

export function checkWithdrawalIntent(intent: { standard?: unknown; payload?: unknown }, e: ExpectedWithdrawal) {
  const fail = (why: string): never => {
    throw new Error(`Refusing to sign 1Click withdrawal intent: ${why}. Intent: ${JSON.stringify(intent)}`);
  };

  if (intent.standard !== 'nep413') fail(`standard is ${String(intent.standard)}, expected nep413`);
  const p = intent.payload as Partial<Nep413Payload> | undefined;
  if (!p || typeof p.message !== 'string' || typeof p.nonce !== 'string' || typeof p.recipient !== 'string') {
    return fail('payload is not a NEP-413 payload');
  }
  if (p.callbackUrl) fail('payload has a callbackUrl');
  if (p.recipient !== e.intentsContract) fail(`recipient is ${p.recipient}, expected ${e.intentsContract}`);
  if (Buffer.from(p.nonce, 'base64').length !== 32) fail('nonce is not 32 bytes');

  let m: { signer_id?: unknown; deadline?: unknown; intents?: unknown };
  try {
    m = JSON.parse(p.message);
  } catch {
    return fail('message is not JSON');
  }
  if (m.signer_id !== e.signerId) fail(`signer_id is ${String(m.signer_id)}, expected ${e.signerId}`);
  const deadline = typeof m.deadline === 'string' ? Date.parse(m.deadline) : NaN;
  if (!Number.isFinite(deadline)) fail('deadline missing');
  if (deadline - Date.now() > 2 * 60 * 60 * 1000) fail('deadline is more than 2 hours away');
  if (!Array.isArray(m.intents) || m.intents.length === 0) return fail('no intents');

  let total = 0n;
  for (const it of m.intents as Array<Record<string, unknown>>) {
    if (it.intent !== 'transfer') fail(`contains a "${String(it.intent)}" intent`);
    if (it.receiver_id !== e.depositAddress) fail(`transfers to ${String(it.receiver_id)}, not the deposit address`);
    const tokens = it.tokens as Record<string, unknown> | undefined;
    if (!tokens || typeof tokens !== 'object') return fail('transfer has no tokens');
    for (const [asset, amount] of Object.entries(tokens)) {
      if (asset !== e.asset) fail(`transfers ${asset}, expected only ${e.asset}`);
      if (typeof amount !== 'string' || !/^\d+$/.test(amount)) fail(`amount ${String(amount)} is not integer units`);
      total += BigInt(amount as string);
    }
  }
  if (total > e.units) fail(`transfers ${total} units, more than the ${e.units} requested`);
  return { message: p.message, nonce: p.nonce, recipient: p.recipient };
}
