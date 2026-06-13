import {
  Address,
  ProxyNetworkProvider,
  Transaction,
  TransactionComputer,
  UserSigner,
} from '@multiversx/sdk-core';
import BigNumber from 'bignumber.js';
import { createClient } from '@supabase/supabase-js';
import {
  buildInsufficientRewardResponse,
  checkTransactionStatus,
  DEFAULT_REWARD_TOKEN_ID,
  fetchAccountEsdtBalanceWei,
  insufficientRewardBalance,
  isLikelyInsufficientRewardFailure,
  redactPemFromString,
  sanitizeObjectForLog,
  USAGE_FEE_TOPUP_USER_MESSAGE,
} from './makexStandard.mjs';

export const FIXED_USD_FEE = 0.05;
export const REWARD_TOKEN = DEFAULT_REWARD_TOKEN_ID;
export const TREASURY_WALLET = 'erd1t2r97zcjg8uvf0e9nk4psj2kvg27mph9kq5xls6xtnyg2aemp8hszcmn8f';
const WHITELIST_TABLE = 'makex_usage_fee_whitelist';
const WHITELIST_STATUS = {
  VALID: 'valid',
  EXPIRED: 'expired',
};

const provider = new ProxyNetworkProvider('https://gateway.multiversx.com', {
  clientName: 'makex-x',
});

const pendingUsageFeeTransactions = new Map();
let lastApiCall = 0;
const API_RATE_LIMIT_MS = 500;

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

function log(level, message, data = {}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...sanitizeObjectForLog(data),
    }),
  );
}

async function rateLimitedApiCall(url, options = {}) {
  const now = Date.now();
  const waitMs = API_RATE_LIMIT_MS - (now - lastApiCall);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastApiCall = Date.now();
  return fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'MakeX-X/1.0',
      ...(options.headers || {}),
    },
  });
}

const mvxFetch = (url, options = {}) => rateLimitedApiCall(url, options);

function getPemContent(req) {
  const pemContent = req.body?.walletPem;
  if (!pemContent || typeof pemContent !== 'string') {
    throw new Error('Missing or invalid PEM content');
  }
  if (!pemContent.includes('-----BEGIN')) {
    throw new Error('Invalid PEM format');
  }
  return pemContent;
}

async function getTokenDecimals(tokenTicker) {
  const response = await rateLimitedApiCall(`https://api.multiversx.com/tokens/${tokenTicker}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch token info: ${response.statusText}`);
  }
  const tokenInfo = await response.json();
  return tokenInfo.decimals || 0;
}

function convertAmountToBlockchainValue(amount, decimals) {
  const factor = new BigNumber(10).pow(decimals);
  return new BigNumber(amount).multipliedBy(factor).toFixed(0);
}

function deriveWhitelistStatus(whitelistEnd) {
  const whitelistEndDate = new Date(whitelistEnd);
  if (Number.isNaN(whitelistEndDate.getTime())) return WHITELIST_STATUS.EXPIRED;
  return whitelistEndDate.getTime() > Date.now() ? WHITELIST_STATUS.VALID : WHITELIST_STATUS.EXPIRED;
}

async function getWhitelistEligibility(walletAddress) {
  if (!supabase) {
    return { skipUsageFee: false, reason: 'no_whitelist_db' };
  }

  const { data: entry, error } = await supabase
    .from(WHITELIST_TABLE)
    .select('id, wallet_address, whitelist_end, status')
    .eq('wallet_address', walletAddress)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load whitelist entry: ${error.message}`);
  }
  if (!entry) {
    return { skipUsageFee: false, reason: 'not_whitelisted' };
  }

  const computedStatus = deriveWhitelistStatus(entry.whitelist_end);
  if (entry.status !== computedStatus) {
    const { data: updatedEntry, error: updateError } = await supabase
      .from(WHITELIST_TABLE)
      .update({ status: computedStatus })
      .eq('id', entry.id)
      .select('id, wallet_address, whitelist_end, status')
      .single();

    if (updateError) {
      throw new Error(`Failed to update whitelist status: ${updateError.message}`);
    }

    return {
      skipUsageFee: updatedEntry.status === WHITELIST_STATUS.VALID,
      reason: updatedEntry.status === WHITELIST_STATUS.VALID ? 'valid' : 'expired',
      entry: updatedEntry,
    };
  }

  return {
    skipUsageFee: entry.status === WHITELIST_STATUS.VALID,
    reason: entry.status === WHITELIST_STATUS.VALID ? 'valid' : 'expired',
    entry,
  };
}

async function getRewardPrice() {
  const tokenResponse = await rateLimitedApiCall(
    `https://api.multiversx.com/tokens?search=${REWARD_TOKEN}`,
  );
  if (!tokenResponse.ok) {
    throw new Error(`Failed to fetch token info: ${tokenResponse.statusText}`);
  }

  const tokenData = await tokenResponse.json();
  if (!tokenData?.length || !tokenData[0].price) {
    throw new Error('Token price not available');
  }

  const tokenPrice = new BigNumber(tokenData[0].price);
  if (tokenPrice.isZero() || !tokenPrice.isFinite()) {
    throw new Error('Invalid token price from API');
  }

  return tokenPrice.toNumber();
}

async function calculateDynamicUsageFee() {
  const rewardPrice = await getRewardPrice();
  if (rewardPrice <= 0) throw new Error('Invalid REWARD token price');

  const rewardAmount = new BigNumber(FIXED_USD_FEE).dividedBy(rewardPrice);
  const decimals = await getTokenDecimals(REWARD_TOKEN);
  if (!rewardAmount.isFinite() || rewardAmount.isZero()) {
    throw new Error('Invalid usage fee calculation');
  }

  return convertAmountToBlockchainValue(rewardAmount, decimals);
}

function buildEsdtTransferData(tokenIdentifier, amountWei) {
  const tokenIdentifierHex =
    tokenIdentifier === REWARD_TOKEN
      ? '5245574152442d636636656163'
      : Buffer.from(tokenIdentifier, 'utf8').toString('hex');

  let amountHex = BigInt(amountWei).toString(16);
  if (amountHex.length % 2 !== 0) amountHex = `0${amountHex}`;

  return `ESDTTransfer@${tokenIdentifierHex}@${amountHex}`;
}

async function sendUsageFee(pemContent, walletAddress) {
  const pendingTx = pendingUsageFeeTransactions.get(walletAddress);
  if (pendingTx) {
    const status = await checkTransactionStatus(pendingTx.txHash, 15, 2000, mvxFetch);
    if (status.status === 'success') {
      pendingUsageFeeTransactions.delete(walletAddress);
      return pendingTx.txHash;
    }
    if (status.status !== 'pending' && status.status !== 'timeout' && status.status !== 'unknown') {
      pendingUsageFeeTransactions.delete(walletAddress);
    } else {
      return pendingTx.txHash;
    }
  }

  const signer = UserSigner.fromPem(pemContent);
  const senderAddress = signer.getAddress();
  const receiverAddress = new Address(TREASURY_WALLET);
  const accountOnNetwork = await provider.getAccount(senderAddress);
  const dynamicFeeAmount = await calculateDynamicUsageFee();

  const rewardBal = await fetchAccountEsdtBalanceWei(senderAddress.toString(), REWARD_TOKEN, mvxFetch);
  if (insufficientRewardBalance(rewardBal, dynamicFeeAmount)) {
    const err = new Error(USAGE_FEE_TOPUP_USER_MESSAGE);
    err.code = 'INSUFFICIENT_REWARD_BALANCE';
    err.insufficientReward = true;
    err.walletAddress = senderAddress.toString();
    err.balanceWei = rewardBal;
    err.requiredWei = dynamicFeeAmount;
    throw err;
  }

  const tx = new Transaction({
    sender: senderAddress,
    receiver: receiverAddress,
    value: BigInt(0),
    data: buildEsdtTransferData(REWARD_TOKEN, dynamicFeeAmount),
    gasLimit: BigInt(500000),
    chainID: '1',
  });

  tx.nonce = accountOnNetwork.nonce;
  tx.signature = await signer.sign(new TransactionComputer().computeBytesForSigning(tx));

  let txHash;
  try {
    txHash = await provider.sendTransaction(tx);
  } catch (err) {
    throw new Error(`Failed to send transaction: ${err.message}`);
  }
  if (!txHash) throw new Error('Transaction hash is undefined after sending transaction.');

  const txHashStr = txHash.toString();
  pendingUsageFeeTransactions.set(walletAddress, {
    txHash: txHashStr,
    timestamp: Date.now(),
  });

  const status = await checkTransactionStatus(txHashStr, 15, 2000, mvxFetch);
  if (status.status === 'success') {
    pendingUsageFeeTransactions.delete(walletAddress);
  } else if (status.status === 'fail') {
    pendingUsageFeeTransactions.delete(walletAddress);
    const chainDetail = status.details || '';
    const err = new Error(
      isLikelyInsufficientRewardFailure(chainDetail) ? USAGE_FEE_TOPUP_USER_MESSAGE : chainDetail || USAGE_FEE_TOPUP_USER_MESSAGE,
    );
    err.code = isLikelyInsufficientRewardFailure(chainDetail)
      ? 'INSUFFICIENT_REWARD_BALANCE'
      : 'USAGE_FEE_TX_FAILED';
    err.insufficientReward = isLikelyInsufficientRewardFailure(chainDetail);
    err.walletAddress = senderAddress.toString();
    err.txHashUsageFee = txHashStr;
    err.chainDetail = chainDetail;
    throw err;
  }

  return txHashStr;
}

export function usageFeeFields(req) {
  return req.usageFeeHash ? { usageFeeHash: req.usageFeeHash } : {};
}

export async function handleUsageFee(req, res, next) {
  let walletAddress;
  try {
    const pemContent = getPemContent(req);
    walletAddress = UserSigner.fromPem(pemContent).getAddress().toString();
    const whitelistEligibility = await getWhitelistEligibility(walletAddress);

    if (whitelistEligibility.skipUsageFee) {
      log('info', 'Skipping usage fee for whitelisted wallet', {
        walletAddress,
        status: whitelistEligibility.reason,
      });
      return next();
    }

    const txHash = await sendUsageFee(pemContent, walletAddress);
    req.usageFeeHash = txHash;
    log('info', 'Usage fee collected', {
      walletAddress,
      usageFeeHash: txHash,
      usdFee: FIXED_USD_FEE,
    });
    return next();
  } catch (error) {
    log('error', 'Error processing usage fee', { error: redactPemFromString(error.message) });

    const insufficientReward =
      error.insufficientReward === true ||
      error.code === 'INSUFFICIENT_REWARD_BALANCE' ||
      isLikelyInsufficientRewardFailure(error.message) ||
      isLikelyInsufficientRewardFailure(error.chainDetail);

    if (insufficientReward) {
      return res.status(422).json(
        buildInsufficientRewardResponse({
          walletAddress: error.walletAddress || walletAddress,
          balanceWei: error.balanceWei,
          requiredWei: error.requiredWei,
          tokenIdentifier: REWARD_TOKEN,
          txHash: error.txHashUsageFee || null,
          chainDetail: error.chainDetail || null,
        }),
      );
    }

    return res.status(error.code === 'USAGE_FEE_TX_FAILED' ? 502 : 400).json({
      status: 'error',
      code: error.code || 'USAGE_FEE_FAILED',
      message: redactPemFromString(error.message) || 'Usage fee could not be processed',
      data: {
        ...(error.chainDetail ? { chainDetail: error.chainDetail } : {}),
        ...(error.txHashUsageFee ? { txHash: error.txHashUsageFee } : {}),
        timestamp: new Date().toISOString(),
      },
    });
  }
}
