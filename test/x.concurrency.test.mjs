import assert from 'node:assert/strict';
import test from 'node:test';
import { createTxCoordinator } from '../tx/coordinator.mjs';
import { createMemoryStore } from '../tx/memoryStore.mjs';
import { createUsageFeeMiddleware, resetUsageFeeStateForTests } from '../usageFeeEngine.mjs';

const WALLET = 'erd1t2r97zcjg8uvf0e9nk4psj2kvg27mph9kq5xls6xtnyg2aemp8hszcmn8f';

function app() {
  resetUsageFeeStateForTests();
  const actions = [];
  const chain = {
    sent: [],
    async getAccountNonce() { return 4; },
    async send(tx) { chain.sent.push(tx); return 'fee-hash'; },
    async getStatus() { return { status: 'success' }; },
  };
  const store = createMemoryStore();
  const coordinator = createTxCoordinator({
    store,
    chain,
    appId: 'makex-twitter-x',
    instanceId: 'x-concurrency-test',
    log: () => {},
    sleepFn: async () => {},
    identify() { return { txHash: 'fee-hash', plain: { nonce: 4 } }; },
    rebuild(plain) { return plain; },
    config: {
      network: '1', leaseTtlMs: 30000, queueTimeoutMs: 3000, pollIntervalMs: 1,
      pollMaxMs: 20, pollMaxIntervalMs: 5, backoff: 1, maxRebroadcasts: 1,
    },
  });
  const handleUsageFee = createUsageFeeMiddleware({
    appId: 'makex-twitter-x',
    supabase: null,
    coordinator,
    mvxFetch: async (url) => {
      const value = String(url);
      if (value.includes('/accounts/')) return { ok: true, json: async () => ({ balance: '100000000' }) };
      if (value.includes('/tokens?')) return { ok: true, json: async () => [{ price: 1 }] };
      if (value.includes('/tokens/')) return { ok: true, json: async () => ({ decimals: 6 }) };
      return { ok: false, status: 404, statusText: 'missing', json: async () => ({}) };
    },
    treasuryWallet: WALLET,
    getPemContent: () => 'test-pem',
    deriveAddress: () => WALLET,
    signFeeTransaction: async (tx) => { tx.signature = Buffer.alloc(64, 4); },
    log: () => {},
    network: '1',
  });
  return { actions, chain, store, handleUsageFee };
}

function call(handleUsageFee, body, action) {
  const req = { method: 'POST', path: '/post', body, headers: {} };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  let nextCalled = false;
  const done = handleUsageFee(req, res, async () => {
    nextCalled = true;
    await action(req, res);
  });
  return done.then(() => ({ req, res, nextCalled }));
}

test('two concurrent X posts with one idempotency key perform one external action', async () => {
  const { actions, chain, store, handleUsageFee } = app();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const body = { idempotencyKey: 'post-once', text: 'hello from makex' };
  const first = call(handleUsageFee, body, async (_req, res) => {
    actions.push('post');
    await gate;
    await res.json({ status: 'success', code: 'POSTED', data: { tweetId: '1' } });
  });
  while (actions.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await call(handleUsageFee, body, async (_req, res) => {
    actions.push('post-again');
    await res.json({ status: 'success', code: 'POSTED', data: { tweetId: '2' } });
  });
  assert.deepEqual(actions, ['post']);
  assert.equal(second.nextCalled, false);
  assert.equal(second.res.statusCode, 503);
  assert.equal(second.res.body.code, 'OPERATION_IN_PROGRESS');
  assert.match(second.res.body.message, /Exactly-once delivery cannot be guaranteed/);
  assert.equal(chain.sent.length, 1);
  release();
  const finished = await first;
  assert.equal(finished.res.body.data.tweetId, '1');
  assert.equal((await store.getOperation(finished.req.makexOperation.id)).state, 'OPERATION_CONFIRMED');

  const repeat = await call(handleUsageFee, { idempotencyKey: 'post-again-on-purpose', text: 'hello from makex' }, async (_req, res) => {
    actions.push('intentional-repeat');
    await res.json({ status: 'success', code: 'POSTED', data: { tweetId: '3' } });
  });
  assert.equal(repeat.res.body.data.tweetId, '3');
  assert.equal(actions.filter((item) => item === 'intentional-repeat').length, 1);
  assert.equal(chain.sent.length, 2);
});

test('a direct-message handler is not entered twice for the same key', async () => {
  const { actions, handleUsageFee } = app();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const body = { idempotencyKey: 'dm-once', text: 'ping', participantId: '99' };
  const first = call(handleUsageFee, body, async (_req, res) => {
    actions.push('dm');
    await gate;
    await res.json({ status: 'success', code: 'DM_SENT', data: { dmEventId: 'd1' } });
  });
  while (!actions.includes('dm')) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await call(handleUsageFee, body, async () => {
    actions.push('dm-again');
  });
  assert.deepEqual(actions, ['dm']);
  assert.equal(second.res.body.code, 'OPERATION_IN_PROGRESS');
  release();
  await first;
});
