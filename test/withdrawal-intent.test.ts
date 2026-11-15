import { checkWithdrawalIntent, ExpectedWithdrawal } from '../src/utils/withdrawal-intent';

const asset = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const e: ExpectedWithdrawal = {
  signerId: 'solver.near',
  intentsContract: 'intents.near',
  depositAddress: 'a1b2c3deposit',
  asset,
  units: 5_000_000n,
};
const nonce = Buffer.alloc(32, 7).toString('base64');

function intent(message: object, extra: object = {}) {
  return {
    standard: 'nep413',
    payload: { message: JSON.stringify(message), nonce, recipient: 'intents.near', ...extra },
  };
}

const deadline = () => new Date(Date.now() + 10 * 60_000).toISOString();
const good = () => ({
  signer_id: 'solver.near',
  deadline: deadline(),
  intents: [{ intent: 'transfer', receiver_id: 'a1b2c3deposit', tokens: { [asset]: '5000000' } }],
});

test('accepts a transfer of the requested asset to the deposit address', () => {
  expect(checkWithdrawalIntent(intent(good()), e)).toMatchObject({ nonce, recipient: 'intents.near' });
});

test.each([
  ['another signer', { ...good(), signer_id: 'someone.near' }],
  ['another receiver', { ...good(), intents: [{ ...good().intents[0], receiver_id: 'thief.near' }] }],
  ['more than requested', { ...good(), intents: [{ ...good().intents[0], tokens: { [asset]: '5000001' } }] }],
  ['another asset', { ...good(), intents: [{ ...good().intents[0], tokens: { 'nep141:wrap.near': '1' } }] }],
  ['a second transfer', { ...good(), intents: [good().intents[0], good().intents[0]] }],
  ['a non-transfer intent', { ...good(), intents: [{ intent: 'add_public_key', public_key: 'ed25519:x' }] }],
  ['a far deadline', { ...good(), deadline: new Date(Date.now() + 3 * 3600_000).toISOString() }],
  ['no intents', { ...good(), intents: [] }],
])('refuses %s', (_why, message) => {
  expect(() => checkWithdrawalIntent(intent(message), e)).toThrow(/Refusing to sign/);
});

test('refuses another standard, recipient or a callbackUrl', () => {
  expect(() => checkWithdrawalIntent({ ...intent(good()), standard: 'erc191' }, e)).toThrow(/Refusing/);
  expect(() => checkWithdrawalIntent(intent(good(), { recipient: 'evil.near' }), e)).toThrow(/Refusing/);
  expect(() => checkWithdrawalIntent(intent(good(), { callbackUrl: 'https://x' }), e)).toThrow(/Refusing/);
});
