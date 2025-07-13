// backend/kascoinjoin.js - KasJoin Mixer

const express = require('express');
const path = require('path');
const kaspa = require(path.join(__dirname, '../kaspa/kaspa.js'));
const dotenv = require('dotenv');

// Load .env file from the root directory (one level up from backend)
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const db = require('./db');
const cron = require('node-cron');
const { requireRole, getUserByApiKey } = require('./admin-middleware');

const router = express.Router();

const KASPA_NETWORK = process.env.KASPA_NETWORK || process.env.NETWORK || 'mainnet';
const KASJOIN_POOL_WALLET = process.env.KASJOIN_POOL_WALLET_1; 
const KASJOIN_POOL_PRIVATE_KEY = process.env.KASJOIN_POOL_PRIVATE_KEY_1; 
const MIN_ENTRY_AMOUNT = 100_000_000n; // 1 KAS in sompi
const FIXED_ENTRY_AMOUNT = 100_000_000n; // 1 KAS in sompi
const ENTRY_TOLERANCE = 10_000n; // 0.0001 KAS in sompi
const KASJOIN_FEE_PERCENTAGE = 0.01; // 1% kasjoin fee

// New optimization constants
const MAX_OUTPUTS_PER_TX = 20; // Maximum outputs per transaction to keep fees reasonable
const OPTIMAL_UTXO_COUNT = 5; // Target number of UTXOs to use per transaction
const MIN_FEE_RATE = 1; // Minimum fee rate multiplier

// Debug environment variables
console.log('[KasJoin] Environment check:');
console.log(`[KasJoin] KASJOIN_POOL_WALLET_1: ${KASJOIN_POOL_WALLET ? 'SET' : 'NOT_SET'}`);
console.log(`[KasJoin] KASJOIN_POOL_PRIVATE_KEY_1: ${KASJOIN_POOL_PRIVATE_KEY ? 'SET' : 'NOT_SET'}`);
console.log(`[KasJoin] KASPA_NETWORK: ${KASPA_NETWORK}`);
console.log(`[KasJoin] NETWORK env: ${process.env.NETWORK || 'NOT_SET'}`);
console.log(`[KasJoin] KASPA_NODE_URL: ${process.env.KASPA_NODE_URL || 'ws://127.0.0.1:17110'}`);

// Validate required environment variables
if (!KASJOIN_POOL_WALLET) {
  console.error('[KasJoin] KASJOIN_POOL_WALLET_1 environment variable is not set!');
}
if (!KASJOIN_POOL_PRIVATE_KEY) {
  console.error('[KasJoin] KASJOIN_POOL_PRIVATE_KEY_1 environment variable is not set!');
}
if (KASJOIN_POOL_PRIVATE_KEY && KASJOIN_POOL_PRIVATE_KEY.length !== 64) {
  console.error('[KasJoin] KASJOIN_POOL_PRIVATE_KEY_1 should be 64 characters (32 bytes hex)');
}

const KASJOIN_SESSIONS_KEY = 'kasjoin_sessions_1kas';
const KASJOIN_BATCHES_KEY = 'kasjoin_batches_1kas';
const KASJOIN_PAUSED_KEY = 'kasjoin_paused_1kas';
const KASJOIN_BATCH_NUMBER_KEY = 'kasjoin_batch_number_1kas';

let rpc = null;
async function getRpcClient() {
  if (!rpc) {
    rpc = new kaspa.RpcClient({
      url: process.env.KASPA_NODE_URL || 'ws://127.0.0.1:17110',
      network: KASPA_NETWORK,
      encoding: kaspa.Encoding.Borsh,
    });
    await rpc.connect();
  }
  return rpc;
}

// Helper: generate a new deposit address for a kasjoin entry
async function generateKasjoinAddress() {
  const keypair = kaspa.Keypair.random();
  const address = keypair.toAddress(KASPA_NETWORK).toString();
  const privateKey = keypair.privateKey;
  return { address, privateKey };
}

// Helper: Optimize UTXO selection for lower transaction mass
function optimizeUtxoSelection(utxos, requiredAmount) {
  // Sort UTXOs by amount (largest first) to minimize the number of inputs
  const sortedUtxos = [...utxos].sort((a, b) => {
    const amountA = BigInt(a.amount);
    const amountB = BigInt(b.amount);
    if (amountA > amountB) return -1;
    if (amountA < amountB) return 1;
    return 0;
  });
  
  let selectedUtxos = [];
  let selectedAmount = 0n;
  
  // First, try to find a single large UTXO that covers the requirement
  for (const utxo of sortedUtxos) {
    const amount = BigInt(utxo.amount);
    if (amount >= requiredAmount) {
      return [utxo];
    }
  }
  
  // If no single UTXO covers it, select the minimum number of UTXOs needed
  for (const utxo of sortedUtxos) {
    selectedUtxos.push(utxo);
    selectedAmount += BigInt(utxo.amount);
    if (selectedAmount >= requiredAmount) {
      break;
    }
  }
  
  return selectedUtxos;
}

// Helper: Split sessions into smaller batches for lower fees
function splitSessionsIntoBatches(sessions, maxOutputsPerBatch = MAX_OUTPUTS_PER_TX) {
  const batches = [];
  for (let i = 0; i < sessions.length; i += maxOutputsPerBatch) {
    batches.push(sessions.slice(i, i + maxOutputsPerBatch));
  }
  return batches;
}

// Helper: Calculate optimal fee based on transaction mass and network conditions
async function calculateOptimalFee(utxos, outputs, rpc) {
  try {
    console.log(`[KasJoin] Creating transaction preview with ${utxos.length} UTXOs and ${outputs.length} outputs`);
    console.log(`[KasJoin] UTXOs:`, utxos.map(u => {
      let txId, index;
      
      if (u.outpoint && u.outpoint.transactionId && u.outpoint.index !== undefined) {
        txId = u.outpoint.transactionId;
        index = u.outpoint.index;
      } else if (u.entry && u.entry.outpoint && u.entry.outpoint.transactionId && u.entry.outpoint.index !== undefined) {
        txId = u.entry.outpoint.transactionId;
        index = u.entry.outpoint.index;
      } else {
        txId = u.transactionId || u.txId;
        index = u.index || u.outputIndex;
      }
      
      return { id: `${txId}:${index}`, amount: u.amount };
    }));
    console.log(`[KasJoin] Outputs:`, outputs.map(o => ({ address: o.address, amount: o.amount.toString() })));
    
    const txPreview = kaspa.createTransaction(utxos, outputs, 0n);
    let feerate = MIN_FEE_RATE;
    
    try {
      const feeEstimateResp = await rpc.getFeeEstimate({});
      feerate = Math.max(feeEstimateResp.estimate.priorityBucket.feerate, MIN_FEE_RATE);
    } catch (err) {
      console.error('[KasJoin] Error getting fee estimate:', err);
    }
    
    // feerate is already in sompi/gram units, so we use it directly
    // Convert feerate to BigInt before multiplication to avoid mixing types
    const fee = BigInt(Math.ceil(Number(feerate) * Number(txPreview.mass)));
    const minimumFee = 35000n;
    
    console.log(`[KasJoin] Transaction mass: ${txPreview.mass}, Fee rate: ${feerate}, Calculated fee: ${fee} sompi`);
    
    return fee > minimumFee ? fee : minimumFee;
  } catch (err) {
    console.error('[KasJoin] Error calculating optimal fee:', err);
    return 35000n; // Fallback to minimum fee
  }
}

// Create a new kasjoin session (entry)
async function createKasjoinSession(destinationAddress) {
  const { address, privateKey } = await generateKasjoinAddress();
  const sessionId = 'kasjoin_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const session = {
    sessionId,
    depositAddress: address,
    depositPrivateKey: privateKey,
    destinationAddress,
    status: 'waiting_deposit',
    createdAt: Date.now(),
  };
  await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
  return session;
}

// Helper to get all keys with a prefix using db.getRange
async function getAllWithPrefix(prefix) {
  const results = [];
  for (const { key, value } of db.getRange()) {
    if (key.startsWith(prefix)) {
      results.push({ sessionId: key.replace(prefix, ''), session: value });
    }
  }
  return results;
}

// Get all current kasjoin sessions
async function getAllKasjoinSessions() {
  return await getAllWithPrefix(`${KASJOIN_SESSIONS_KEY}:`);
}

// Get all kasjoin batches
async function getAllKasjoinBatches() {
  return await getAllWithPrefix(`${KASJOIN_BATCHES_KEY}:`);
}

// Add new function to check and trigger kasjoin batch
async function checkAndTriggerKasjoinBatch() {
  try {
    // Check if kasjoin is paused
    const paused = await getKasjoinPaused();
    if (paused) {
      console.log('[KasJoin] KasJoin is paused, skipping batch processing');
      return;
    }
    
    // Check if we have enough entries for a batch (minimum 20 for privacy)
    const sessions = (await getAllKasjoinSessions()).filter(({ session }) => session.status === 'entered');
    console.log(`[KasJoin] Checking batch trigger: ${sessions.length} entered sessions, need 20+`);
    
    if (sessions.length >= 20) {
      console.log('[KasJoin] Auto-triggering batch with', sessions.length, 'entries');
      await processKasjoinBatch(sessions);
    } else {
      console.log(`[KasJoin] Not enough entries for batch processing: ${sessions.length}/20`);
    }
  } catch (err) {
    console.error('[KasJoin] Error in auto-trigger check:', err);
  }
}

async function monitorKasjoinDeposits(intervalMs = 10000) {
  setInterval(async () => {
    const rpc = await getRpcClient();
    const sessions = await getAllKasjoinSessions();
    console.log(`[KasJoin] Total sessions: ${sessions.length}, Entered sessions: ${sessions.filter(({ session }) => session.status === 'entered').length}`);
    let currentDaaScore = 0;
    try {
      const dagInfo = await rpc.getBlockDagInfo({});
      currentDaaScore = dagInfo.virtualDaaScore || 0;
    } catch (e) {
      console.error('[KasJoin] Error fetching DAA score:', e);
      return;
    }
    const MIN_CONFIRMATIONS = 20;
    for (const { sessionId, session } of sessions) {
      if (session.status !== 'waiting_deposit') continue; // Skip already processed or errored sessions
      try {
        const result = await rpc.getUtxosByAddresses({ addresses: [session.depositAddress] });
        if (result && result.entries && result.entries.length > 0) {
          const confirmedUtxos = result.entries.filter(utxo => utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS));
          if (confirmedUtxos.length > 0) {
            const total = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
            console.log(`[KasJoin] Detected deposit total (sompi) for session ${sessionId}:`, total.toString());
            if (total >= FIXED_ENTRY_AMOUNT - ENTRY_TOLERANCE && total <= FIXED_ENTRY_AMOUNT + ENTRY_TOLERANCE) {
              // Forward to pool wallet with optimized fee calculation
              let fee = 35000n; // Default minimum fee
              try {
                const txPreview = kaspa.createTransaction(confirmedUtxos, [{ address: KASJOIN_POOL_WALLET, amount: total }], 0n);
                fee = await calculateOptimalFee(confirmedUtxos, [{ address: KASJOIN_POOL_WALLET, amount: total }], rpc);
              } catch (err) {
                console.error('[KasJoin] Error calculating fee for deposit forward:', err);
              }
              
              const tx = kaspa.createTransaction(
                confirmedUtxos,
                [{ address: KASJOIN_POOL_WALLET, amount: total - fee }],
                fee
              );
              const signedTx = kaspa.signTransaction(tx, [session.depositPrivateKey], true);
              try {
                const resultSend = await rpc.submitTransaction({ transaction: signedTx });
                session.status = 'entered';
                session.amount = total.toString();
                session.txId = resultSend.transactionId;
                session.updatedAt = Date.now();
                console.log(`[KasJoin] Storing session.amount for session ${sessionId}:`, session.amount);
                await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
                console.log(`[KasJoin] Deposit detected and forwarded for session ${sessionId}:`, total.toString());
                if (!session.history) session.history = [];
                session.history.push({
                  type: 'deposit',
                  amount: total.toString(),
                  txId: confirmedUtxos[0].transactionId || null,
                  timestamp: Date.now(),
                });
                session.history.push({
                  type: 'forward',
                  amount: (total - fee).toString(),
                  txId: resultSend.transactionId,
                  timestamp: Date.now(),
                });
              } catch (err) {
                if (err.message && err.message.includes('already in the mempool')) {
                  console.log(`[KasJoin] Transaction already in mempool for session ${sessionId}, skipping forward.`);
                  // Mark session as entered even if the transaction is already in the mempool
                  session.status = 'entered';
                  session.amount = total.toString();
                  session.updatedAt = Date.now();
                  await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
                  console.log(`[KasJoin] Session ${sessionId} marked as entered despite transaction already in mempool.`);
                } else {
                  throw err;
                }
              }
            } else {
              // Not the correct amount
              session.status = 'error';
              session.error = `[E_KASJOIN_AMOUNT] Deposit must be 10 KAS (network fees allowed up to 0.0001 KAS). Received: ${total.toString()} sompi.`;
              session.updatedAt = Date.now();
              await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
              console.error(`[E_KASJOIN_AMOUNT] Session ${sessionId} error: ${session.error}`);
            }
          }
        }
      } catch (err) {
        session.status = 'error';
        session.error = '[E_KASJOIN_DEPOSIT] ' + (err.message || String(err));
        session.updatedAt = Date.now();
        await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
        console.error(`[E_KASJOIN_DEPOSIT] Session ${sessionId} error: ${session.error}`);
      }
    }
    
    // NEW: Check if kasjoin should process batch
    await checkAndTriggerKasjoinBatch();
  }, intervalMs);
}

// Start monitoring on module load
monitorKasjoinDeposits();

// Get current batch number
async function getCurrentBatchNumber() {
  const number = await db.get(KASJOIN_BATCH_NUMBER_KEY);
  return number || 1;
}

// Increment and get next batch number
async function getNextBatchNumber() {
  const currentNumber = await getCurrentBatchNumber();
  const nextNumber = currentNumber + 1;
  await db.put(KASJOIN_BATCH_NUMBER_KEY, nextNumber);
  return nextNumber;
}

// Process kasjoin batch: return funds to users minus kasjoin fee
async function processKasjoinBatch(sessions) {
  console.log('[KasJoin] Starting optimized batch processing...');
  
  if (sessions.length < 20) {
    console.log('[KasJoin] Not enough entries (need at least 20)');
    return;
  }
  
  try {
  
  // Get the batch number for this processing
  const batchNumber = await getNextBatchNumber();
  
  // Calculate total amount from current batch sessions
  const totalBatchAmount = sessions.reduce((sum, { session }) => sum + BigInt(session.amount || 0), 0n);
  console.log('[KasJoin] Total batch amount from sessions:', totalBatchAmount.toString());

  // Calculate kasjoin fee (1%) from batch amount
  const kasjoinFee = (totalBatchAmount * BigInt(Math.floor(KASJOIN_FEE_PERCENTAGE * 100))) / 100n;
  console.log(`[KasJoin] KasJoin fee: ${kasjoinFee} sompi`);

  // Calculate remaining pool after kasjoin fee
  const remainingPool = totalBatchAmount - kasjoinFee;
  console.log(`[KasJoin] Remaining pool for users: ${remainingPool} sompi`);

  // Calculate payout per user (equal distribution minus kasjoin fee)
  const payoutPerUser = remainingPool / BigInt(sessions.length);
  console.log('[KasJoin] Payout per user:', payoutPerUser.toString());

  // Get UTXOs for the pool wallet
  const rpc = await getRpcClient();
  const utxoRes = await rpc.getUtxosByAddresses({ addresses: [KASJOIN_POOL_WALLET] });
  const allUtxos = utxoRes.entries || [];
  console.log(`[KasJoin] Found ${allUtxos.length} UTXOs for pool wallet`);

  if (allUtxos.length === 0) {
    console.error('[KasJoin] No UTXOs found for pool wallet');
    throw new Error('No UTXOs found for pool wallet');
  }

  // Calculate total available amount from UTXOs
  const totalAvailable = allUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
  console.log('[KasJoin] Total available from UTXOs:', totalAvailable.toString());
  
  // Verify we have enough funds
  if (totalAvailable < totalBatchAmount) {
    console.error('[KasJoin] Insufficient funds in pool wallet');
    throw new Error('Insufficient funds in pool wallet');
  }

  // Split sessions into smaller batches to reduce transaction fees
  const sessionBatches = splitSessionsIntoBatches(sessions, MAX_OUTPUTS_PER_TX);
  console.log(`[KasJoin] Split ${sessions.length} sessions into ${sessionBatches.length} batches`);

  // Calculate fee per batch (distribute kasjoin fee across batches)
  const feePerBatch = kasjoinFee / BigInt(sessionBatches.length);
  console.log(`[KasJoin] Fee per batch: ${feePerBatch} sompi`);

  // Process each batch separately
  const batchResults = [];
  let totalFeesPaid = 0n;
  let usedUtxoIds = new Set(); // Track used UTXOs across batches

  for (let batchIndex = 0; batchIndex < sessionBatches.length; batchIndex++) {
    const batchSessions = sessionBatches[batchIndex];
    console.log(`[KasJoin] Processing batch ${batchIndex + 1}/${sessionBatches.length} with ${batchSessions.length} sessions`);

    // Calculate total amount needed for this batch
    const batchAmount = BigInt(batchSessions.length) * payoutPerUser + feePerBatch;
    
    // Get fresh UTXOs and filter out already used ones
    const utxoRes = await rpc.getUtxosByAddresses({ addresses: [KASJOIN_POOL_WALLET] });
    const allUtxos = utxoRes.entries || [];
    
    // Debug UTXO structure
    if (allUtxos.length > 0) {
      console.log(`[KasJoin] Sample UTXO structure:`, Object.keys(allUtxos[0]));
      console.log(`[KasJoin] Sample UTXO outpoint:`, allUtxos[0].outpoint);
      console.log(`[KasJoin] Sample UTXO entry:`, allUtxos[0].entry);
    }
    
    const availableUtxos = allUtxos.filter(utxo => {
      // Handle the nested UTXO structure from Kaspa RPC
      let txId, index;
      
      if (utxo.outpoint && utxo.outpoint.transactionId && utxo.outpoint.index !== undefined) {
        // Direct outpoint structure
        txId = utxo.outpoint.transactionId;
        index = utxo.outpoint.index;
      } else if (utxo.entry && utxo.entry.outpoint && utxo.entry.outpoint.transactionId && utxo.entry.outpoint.index !== undefined) {
        // Nested entry.outpoint structure
        txId = utxo.entry.outpoint.transactionId;
        index = utxo.entry.outpoint.index;
      } else {
        // Fallback to direct fields
        txId = utxo.transactionId || utxo.txId;
        index = utxo.index || utxo.outputIndex;
      }
      
      if (!txId || index === undefined) {
        console.log(`[KasJoin] Warning: UTXO missing transactionId or index:`, utxo);
        return false; // Skip UTXOs without proper identification
      }
      
      const utxoId = `${txId}:${index}`;
      return !usedUtxoIds.has(utxoId);
    });
    
    if (availableUtxos.length === 0) {
      console.error(`[KasJoin] No UTXOs available for batch ${batchIndex + 1}`);
      throw new Error(`No UTXOs available for batch ${batchIndex + 1}`);
    }
    
    console.log(`[KasJoin] Available UTXOs for batch ${batchIndex + 1}: ${availableUtxos.length}`);
    console.log(`[KasJoin] Required amount for batch ${batchIndex + 1}: ${batchAmount} sompi`);
    
    // Optimize UTXO selection for this batch
    const selectedUtxos = optimizeUtxoSelection(availableUtxos, batchAmount);
    const selectedAmount = selectedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
    
    console.log(`[KasJoin] Batch ${batchIndex + 1}: Selected ${selectedUtxos.length} UTXOs, total: ${selectedAmount} sompi`);
    
    if (selectedAmount < batchAmount) {
      console.error(`[KasJoin] ERROR: Selected amount (${selectedAmount}) is less than required amount (${batchAmount})`);
      throw new Error(`Insufficient UTXOs: selected ${selectedAmount} sompi, need ${batchAmount} sompi`);
    }

    // Mark selected UTXOs as used
    selectedUtxos.forEach(utxo => {
      let txId, index;
      
      if (utxo.outpoint && utxo.outpoint.transactionId && utxo.outpoint.index !== undefined) {
        txId = utxo.outpoint.transactionId;
        index = utxo.outpoint.index;
      } else if (utxo.entry && utxo.entry.outpoint && utxo.entry.outpoint.transactionId && utxo.entry.outpoint.index !== undefined) {
        txId = utxo.entry.outpoint.transactionId;
        index = utxo.entry.outpoint.index;
      } else {
        txId = utxo.transactionId || utxo.txId;
        index = utxo.index || utxo.outputIndex;
      }
      
      if (txId && index !== undefined) {
        usedUtxoIds.add(`${txId}:${index}`);
      }
    });

    // Create outputs for this batch
    const batchOutputs = batchSessions.map(({ session }) => ({
      address: session.destinationAddress,
      amount: payoutPerUser
    }));

    // Add kasjoin fee output for this batch
    batchOutputs.push({ address: KASJOIN_POOL_WALLET, amount: feePerBatch });

    // Calculate optimal fee for this batch
    const batchFee = await calculateOptimalFee(selectedUtxos, batchOutputs, rpc);
    console.log(`[KasJoin] Batch ${batchIndex + 1} fee: ${batchFee} sompi`);

    // Subtract fee from kasjoin fee output
    const kasjoinFeeOutputIndex = batchOutputs.length - 1;
    batchOutputs[kasjoinFeeOutputIndex].amount -= batchFee;

    // Ensure no negative outputs
    for (const output of batchOutputs) {
      if (output.amount < 0n) {
        throw new Error(`Calculated output amount is negative: ${output.amount}`);
      }
    }

    // Create and sign the transaction
    try {
      const tx = kaspa.createTransaction(selectedUtxos, batchOutputs, batchFee);
      const signedTx = kaspa.signTransaction(tx, [new kaspa.PrivateKey(KASJOIN_POOL_PRIVATE_KEY)], true);
      
      const resultSend = await rpc.submitTransaction({ transaction: signedTx });
      console.log(`[KasJoin] Batch ${batchIndex + 1} transaction submitted. TxID: ${resultSend.transactionId}`);

      // Update session statuses for this batch
      for (const { sessionId, session } of batchSessions) {
        session.status = 'completed';
        session.payoutAmount = payoutPerUser.toString();
        session.payoutTxId = resultSend.transactionId;
        session.batchNumber = batchNumber;
        session.batchIndex = batchIndex;
        session.updatedAt = Date.now();
        await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
      }

      batchResults.push({
        batchIndex,
        txId: resultSend.transactionId,
        fee: batchFee.toString(),
        sessions: batchSessions.length,
        amount: batchAmount.toString()
      });

      totalFeesPaid += batchFee;

      // Add a small delay between batches to ensure proper processing
      if (batchIndex < sessionBatches.length - 1) {
        console.log(`[KasJoin] Waiting 2 seconds before processing next batch...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch (err) {
      console.error(`[KasJoin] Error processing batch ${batchIndex + 1}:`, err);
      throw err;
    }
  }

  // Store batch info in DB
  const batchId = 'batch_' + new Date().toISOString().slice(0, 10) + '_' + batchNumber;
  await db.put(`${KASJOIN_BATCHES_KEY}:${batchId}`, {
    date: new Date().toISOString(),
    batchNumber,
    totalSessions: sessions.length,
    totalBatches: sessionBatches.length,
    sessions: sessions.map(s => ({ 
      sessionId: s.sessionId, 
      destinationAddress: s.session.destinationAddress, 
      amount: payoutPerUser.toString() 
    })),
    pool: remainingPool.toString(),
    kasjoinFee: kasjoinFee.toString(),
    totalFeesPaid: totalFeesPaid.toString(),
    batchResults: batchResults,
    optimization: {
      maxOutputsPerTx: MAX_OUTPUTS_PER_TX,
      optimalUtxoCount: OPTIMAL_UTXO_COUNT,
      minFeeRate: MIN_FEE_RATE
    }
  });

  console.log(`[KasJoin] Optimized batch completed successfully. Total fees paid: ${totalFeesPaid} sompi`);
  console.log(`[KasJoin] Average fee per transaction: ${totalFeesPaid / BigInt(sessionBatches.length)} sompi`);
  } catch (err) {
    console.error('[KasJoin] Error in batch processing:', err);
    throw err; // Re-throw to let caller handle it
  }
}

// Schedule automatic batch processing (every hour)
cron.schedule('0 * * * *', async () => {
  try {
    console.log('[KasJoin] Scheduled batch processing starting...');
    const sessions = (await getAllKasjoinSessions()).filter(({ session }) => session.status === 'entered');
    if (sessions.length >= 20) {
      await processKasjoinBatch(sessions);
    } else {
      console.log('[KasJoin] Not enough entries for scheduled batch processing');
    }
    console.log('[KasJoin] Scheduled batch processing completed');
  } catch (err) {
    console.error('[KasJoin] Error in scheduled batch processing:', err);
  }
});

// Utility: Recursively convert all BigInts in an object to strings for safe JSON serialization
function toSafeJSON(obj) {
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(toSafeJSON);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = toSafeJSON(v);
    }
    return out;
  }
  return obj;
}

// POST /api/kasjoin/session - create a new kasjoin session
router.post('/session', async (req, res) => {
  const { destinationAddress } = req.body;
  if (!destinationAddress || typeof destinationAddress !== 'string' || !destinationAddress.startsWith('kaspa:')) {
    return res.status(400).json({ error: 'Invalid destination address' });
  }
  const session = await createKasjoinSession(destinationAddress);
  res.json(toSafeJSON(session));
});

// Public: get session status
router.get('/session/:id', async (req, res) => {
  try {
    const session = await getKasjoinSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    // Only return safe session data
    const { depositPrivateKey, ...safeSession } = session;
    res.json(safeSession);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to get session.' });
  }
});

// GET /api/kasjoin/session/:id - get full session details including history
router.get('/session/:id', requireRole('moderator'), async (req, res) => {
  const sessionId = req.params.id;
  const session = await db.get(`${KASJOIN_SESSIONS_KEY}:${sessionId}`);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role === 'moderator') {
    const { depositPrivateKey, ...safeSession } = session;
    return res.json(toSafeJSON(safeSession));
  }
  res.json(toSafeJSON(session));
});

// GET /api/kasjoin/pool - get current pool stats
router.get('/pool', async (req, res) => {
  const sessions = (await getAllKasjoinSessions()).filter(({ session }) => session.status === 'entered');
  const poolSompi = sessions.reduce((sum, { session }) => sum + Number(session.amount || 0), 0);
  const pool = Number(poolSompi) / 1e8;
  res.json(toSafeJSON({ pool, entries: sessions.length }));
});

// GET /api/kasjoin/batches - get all kasjoin batches
router.get('/batches', async (req, res) => {
  try {
    const batches = await getAllKasjoinBatches();
    res.json(batches);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/kasjoin/sessions - get all kasjoin sessions (admin)
router.get('/sessions', requireRole('moderator'), async (req, res) => {
  try {
    const sessions = await getAllKasjoinSessions();
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: get session details (includes private key)
router.get('/admin/session/:id', requireRole('moderator'), async (req, res) => {
  const sessionId = req.params.id;
  const session = await db.get(`${KASJOIN_SESSIONS_KEY}:${sessionId}`);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(toSafeJSON(session));
});

// Sweep stuck funds from errored or incomplete sessions
async function sweepStuckFunds() {
  const sessions = await getAllKasjoinSessions();
  const stuckSessions = sessions.filter(({ session }) =>
    (session.status === 'error' || session.status === 'waiting_deposit')
  );
  const rpc = await getRpcClient();
  let results = [];
  let currentDaaScore = 0;
  try {
    const dagInfo = await rpc.getBlockDagInfo({});
    currentDaaScore = dagInfo.virtualDaaScore || 0;
  } catch (e) {
    results.push({ error: 'Failed to fetch DAA score: ' + (e.message || String(e)) });
    return results;
  }
  const MIN_CONFIRMATIONS = 20;
  for (const { sessionId, session } of stuckSessions) {
    try {
      const utxoRes = await rpc.getUtxosByAddresses({ addresses: [session.depositAddress] });
      const utxos = utxoRes.entries || [];
      const confirmedUtxos = utxos.filter(utxo => utxo.blockDaaScore && (currentDaaScore - utxo.blockDaaScore >= MIN_CONFIRMATIONS));
      const total = confirmedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
      if (confirmedUtxos.length === 0 || total === 0n) continue;
      // Estimate fee with optimization
      let fee = 35000n; // Default minimum fee
      try {
        fee = await calculateOptimalFee(confirmedUtxos, [{ address: KASJOIN_POOL_WALLET, amount: total }], rpc);
      } catch (err) {
        console.error('[KasJoin] Error calculating fee for stuck fund sweep:', err);
      }
      
      const tx = kaspa.createTransaction(
        confirmedUtxos,
        [{ address: KASJOIN_POOL_WALLET, amount: total - fee }],
        fee
      );
      const signedTx = kaspa.signTransaction(tx, [session.depositPrivateKey], true);
      const resultSend = await rpc.submitTransaction({ transaction: signedTx });
      results.push({ sessionId, amount: total.toString(), txId: resultSend.transactionId });
      session.status = 'swept';
      session.sweptAmount = total.toString();
      session.sweptTxId = resultSend.transactionId;
      session.updatedAt = Date.now();
      await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
    } catch (err) {
      results.push({ sessionId, error: err.message || String(err) });
    }
  }
  return results;
}

// Get a single kasjoin session by sessionId
async function getKasjoinSession(sessionId) {
  return await db.get(`${KASJOIN_SESSIONS_KEY}:${sessionId}`);
}

// Set kasjoin paused state
async function setKasjoinPaused(paused) {
  await db.put(KASJOIN_PAUSED_KEY, !!paused);
}

// Get kasjoin paused state
async function getKasjoinPaused() {
  return (await db.get(KASJOIN_PAUSED_KEY)) === true;
}

// Public: get kasjoin paused state
router.get('/paused', async (req, res) => {
  try {
    const paused = await getKasjoinPaused();
    res.json({ paused });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to get paused state.' });
  }
});

// Function to refresh kasjoin sessions with errors
async function refreshKasjoinSessionsWithErrors() {
  const sessions = await getAllKasjoinSessions();
  const refreshedSessions = [];
  for (const { sessionId, session } of sessions) {
    if (session.status === 'error' || session.status === 'deposit_received') {
      if (session.deposit_received || session.status === 'deposit_received') {
        session.status = 'entered';
      } else {
        session.status = 'waiting_deposit';
      }
      session.error = null;
      session.updatedAt = Date.now();
      await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
      refreshedSessions.push(sessionId);
    }
  }
  return refreshedSessions;
}

// Admin: refresh kasjoin sessions with errors
router.post('/admin/refresh-error-sessions', async (req, res) => {
  try {
    const refreshedSessions = await refreshKasjoinSessionsWithErrors();
    res.json({ success: true, refreshedSessions });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to refresh kasjoin sessions.' });
  }
});

// GET /api/kasjoin/entries - get all entered destination addresses for the current batch
router.get('/entries', async (req, res) => {
  try {
    const sessions = await getAllKasjoinSessions();
    // Only include sessions with status 'entered'
    const entries = sessions
      .filter(({ session }) => session.status === 'entered')
      .map(({ session }) => ({
        destinationAddress: session.destinationAddress,
        sessionId: session.sessionId,
        enteredAt: session.updatedAt || session.createdAt || null
      }));
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to fetch kasjoin entries.' });
  }
});

// Admin: delete all kasjoin sessions with status 'waiting_deposit'
router.post('/admin/delete-waiting-deposit-sessions', async (req, res) => {
  try {
    const sessions = await getAllKasjoinSessions();
    let deleted = 0;
    for (const { sessionId, session } of sessions) {
      if (session.status === 'waiting_deposit') {
        await db.remove(`${KASJOIN_SESSIONS_KEY}:${sessionId}`);
        deleted++;
      }
    }
    res.json({ success: true, deleted });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to delete waiting_deposit sessions.' });
  }
});

// POST /api/kasjoin/admin/mark-as-entered/:sessionId - mark a kasjoin session as entered (admin only)
router.post('/admin/mark-as-entered/:sessionId', requireRole('moderator'), async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = await db.get(`${KASJOIN_SESSIONS_KEY}:${sessionId}`);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status === 'entered') {
    // Filter private key for moderators
    if (req.user.role === 'moderator') {
      const { depositPrivateKey, ...safeSession } = session;
      return res.json({ success: true, message: 'Session already marked as entered.', session: safeSession });
    }
    return res.json({ success: true, message: 'Session already marked as entered.', session });
  }
  session.status = 'entered';
  if (!session.amount || session.amount === '' || session.amount === undefined) {
    session.amount = FIXED_ENTRY_AMOUNT.toString();
  }
  session.updatedAt = Date.now();
  await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
  // Filter private key for moderators
  if (req.user.role === 'moderator') {
    const { depositPrivateKey, ...safeSession } = session;
    return res.json({ success: true, message: 'Session marked as entered.', session: safeSession });
  }
  res.json({ success: true, message: 'Session marked as entered.', session });
});

// POST /api/kasjoin/admin/fix-missing-amounts - patch entered sessions missing amount
router.post('/admin/fix-missing-amounts', requireRole('moderator'), async (req, res) => {
  const sessions = await getAllKasjoinSessions();
  let fixed = 0;
  let patched = [];
  for (const { sessionId, session } of sessions) {
    if (session.status === 'entered' && (!session.amount || session.amount === '' || session.amount === undefined)) {
      session.amount = FIXED_ENTRY_AMOUNT.toString();
      session.updatedAt = Date.now();
      await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
      fixed++;
    }
    if (req.user && req.user.role === 'moderator') {
      const { depositPrivateKey, ...safeSession } = session;
      patched.push({ sessionId, session: safeSession });
    } else {
      patched.push({ sessionId, session });
    }
  }
  res.json({ success: true, fixed, message: `${fixed} sessions patched with missing amount.`, patched });
});

// Add a whoami endpoint for role detection
router.get('/whoami', requireRole('moderator'), async (req, res) => {
  try {
    const user = await getUserByApiKey(req.headers['x-admin-key']);
    res.json({ role: user.role });
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

// Add function to verify pool wallet configuration
async function verifyPoolWallet() {
  try {
    if (!KASJOIN_POOL_PRIVATE_KEY) {
      throw new Error('KASJOIN_POOL_PRIVATE_KEY not set in environment variables');
    }
    if (!KASJOIN_POOL_WALLET) {
      throw new Error('KASJOIN_POOL_WALLET not set in environment variables');
    }

    const rpc = await getRpcClient();
    
    // Verify private key can be loaded
    try {
      const privateKey = new kaspa.PrivateKey(KASJOIN_POOL_PRIVATE_KEY);
      const keypair = kaspa.Keypair.fromPrivateKey(privateKey);
      
      // Test if we can use the private key by creating a test transaction
      const testTx = kaspa.createTransaction([], [], 0n);
      kaspa.signTransaction(testTx, [keypair.privateKey], true);
      
      const derivedAddress = keypair.toAddress(KASPA_NETWORK).toString();
      
      if (derivedAddress !== KASJOIN_POOL_WALLET) {
        throw new Error('Pool wallet address does not match derived address from private key');
      }
    } catch (err) {
      throw new Error('Invalid KASJOIN_POOL_PRIVATE_KEY format: ' + err.message);
    }

    // Get UTXOs and calculate balance
    const utxoRes = await rpc.getUtxosByAddresses({ addresses: [KASJOIN_POOL_WALLET] });
    const utxos = utxoRes.entries || [];
    const balance = utxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
    
    // Get current kasjoin sessions and calculate potential payouts
    const sessions = await getAllKasjoinSessions();
    const enteredSessions = sessions.filter(({ session }) => session.status === 'entered');
    const totalPool = enteredSessions.reduce((sum, { session }) => sum + Number(session.amount || 0), 0);
    const kasjoinFee = Math.floor(totalPool * KASJOIN_FEE_PERCENTAGE);
    const remainingPool = totalPool - kasjoinFee;
    
    // Calculate potential payout per user
    const potentialPayoutPerUser = enteredSessions.length > 0 ? Math.floor(remainingPool / enteredSessions.length) : 0;

    const response = {
      isValid: true,
      balance: balance.toString(),
      balanceKAS: Number(balance) / 1e8,
      utxoCount: utxos.length,
      address: KASJOIN_POOL_WALLET,
      currentPool: {
        total: totalPool,
        totalKAS: totalPool / 1e8,
        entries: enteredSessions.length,
        potentialPayoutPerUser: potentialPayoutPerUser / 1e8,
        kasjoinFee: kasjoinFee / 1e8
      }
    };

    return response;
  } catch (err) {
    return {
      isValid: false,
      error: err.message,
      address: KASJOIN_POOL_WALLET
    };
  }
}

// Add endpoint to check pool wallet status
router.get('/pool-status', async (req, res) => {
  try {
    const status = await verifyPoolWallet();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new endpoint to get current batch number
router.get('/current-number', async (req, res) => {
  try {
    const number = await getCurrentBatchNumber();
    res.json({ batchNumber: number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Initialize batch number to 1
async function initializeBatchNumber() {
  const currentNumber = await db.get(KASJOIN_BATCH_NUMBER_KEY);
  if (!currentNumber) {
    await db.put(KASJOIN_BATCH_NUMBER_KEY, 1);
    console.log('[KasJoin] Initialized batch number to 1');
  }
}

// Call initialization on module load
initializeBatchNumber();

// Add admin endpoint to set batch number
router.post('/set-number', requireRole('admin'), async (req, res) => {
  try {
    const { number } = req.body;
    if (!number || typeof number !== 'number' || number < 1) {
      return res.status(400).json({ error: 'Invalid batch number' });
    }
    await db.put(KASJOIN_BATCH_NUMBER_KEY, number);
    res.json({ success: true, batchNumber: number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: pause kasjoin
router.post('/admin/pause', requireRole('moderator'), async (req, res) => {
  try {
    await setKasjoinPaused(true);
    res.json({ success: true, message: 'Kasjoin paused' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: unpause kasjoin
router.post('/admin/unpause', requireRole('moderator'), async (req, res) => {
  try {
    await setKasjoinPaused(false);
    res.json({ success: true, message: 'Kasjoin unpaused' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: process kasjoin batch manually
router.post('/process-batch', requireRole('moderator'), async (req, res) => {
  try {
    const sessions = (await getAllKasjoinSessions()).filter(({ session }) => session.status === 'entered');
    if (sessions.length === 0) {
      return res.status(400).json({ error: 'No entered sessions to process' });
    }
    await processKasjoinBatch(sessions);
    res.json({ success: true, message: `Processed batch with ${sessions.length} sessions` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: process kasjoin batch manually (bypass minimum requirement for testing)
router.post('/process-batch-test', requireRole('moderator'), async (req, res) => {
  try {
    const sessions = (await getAllKasjoinSessions()).filter(({ session }) => session.status === 'entered');
    if (sessions.length === 0) {
      return res.status(400).json({ error: 'No entered sessions to process' });
    }
    
    console.log(`[KasJoin] Test batch processing with ${sessions.length} sessions (bypassing minimum requirement)`);
    
    // Create a test version of batch processing that bypasses the minimum requirement
    const testSessions = sessions.slice(0, Math.min(5, sessions.length)); // Process up to 5 sessions for testing
    
    // Call the actual batch processing logic but with a temporary override
    const originalProcessFunction = processKasjoinBatch;
    
    // Create a test wrapper
    const testProcessBatch = async (testSessions) => {
      console.log('[KasJoin] Starting test batch processing...');
      
      if (testSessions.length < 1) {
        console.log('[KasJoin] Not enough entries for test batch processing');
        return;
      }
      
      try {
        // Get the batch number for this processing
        const batchNumber = await getNextBatchNumber();
        
        // Calculate total amount from current batch sessions
        const totalBatchAmount = testSessions.reduce((sum, { session }) => sum + BigInt(session.amount || 0), 0n);
        console.log('[KasJoin] Test batch amount from sessions:', totalBatchAmount.toString());

        // Calculate kasjoin fee (1%) from batch amount
        const kasjoinFee = (totalBatchAmount * BigInt(Math.floor(KASJOIN_FEE_PERCENTAGE * 100))) / 100n;
        console.log(`[KasJoin] Test KasJoin fee: ${kasjoinFee} sompi`);

        // Calculate remaining pool after kasjoin fee
        const remainingPool = totalBatchAmount - kasjoinFee;
        console.log(`[KasJoin] Test remaining pool for users: ${remainingPool} sompi`);

        // Calculate payout per user (equal distribution minus kasjoin fee)
        const payoutPerUser = remainingPool / BigInt(testSessions.length);
        console.log('[KasJoin] Test payout per user:', payoutPerUser.toString());

        // Get UTXOs for the pool wallet
        const rpc = await getRpcClient();
        const utxoRes = await rpc.getUtxosByAddresses({ addresses: [KASJOIN_POOL_WALLET] });
        const allUtxos = utxoRes.entries || [];
        console.log(`[KasJoin] Test: Found ${allUtxos.length} UTXOs for pool wallet`);

        if (allUtxos.length === 0) {
          throw new Error('No UTXOs found for pool wallet');
        }

        // Calculate total available amount from UTXOs
        const totalAvailable = allUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
        console.log('[KasJoin] Test: Total available from UTXOs:', totalAvailable.toString());
        
        // Verify we have enough funds
        if (totalAvailable < totalBatchAmount) {
          throw new Error('Insufficient funds in pool wallet');
        }

        // For testing, process all sessions in a single batch
        const batchSessions = testSessions;
        console.log(`[KasJoin] Test: Processing ${batchSessions.length} sessions in single batch`);

        // Calculate total amount needed for this batch
        const batchAmount = BigInt(batchSessions.length) * payoutPerUser + kasjoinFee;
        
        // Optimize UTXO selection for this batch
        const selectedUtxos = optimizeUtxoSelection(allUtxos, batchAmount);
        const selectedAmount = selectedUtxos.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n);
        
        console.log(`[KasJoin] Test: Selected ${selectedUtxos.length} UTXOs, total: ${selectedAmount} sompi`);

        // Create outputs for this batch
        const batchOutputs = batchSessions.map(({ session }) => ({
          address: session.destinationAddress,
          amount: payoutPerUser
        }));

        // Add kasjoin fee output for this batch
        batchOutputs.push({ address: KASJOIN_POOL_WALLET, amount: kasjoinFee });

        // Calculate optimal fee for this batch
        const batchFee = await calculateOptimalFee(selectedUtxos, batchOutputs, rpc);
        console.log(`[KasJoin] Test batch fee: ${batchFee} sompi`);

        // Subtract fee from kasjoin fee output
        const kasjoinFeeOutputIndex = batchOutputs.length - 1;
        batchOutputs[kasjoinFeeOutputIndex].amount -= batchFee;

        // Ensure no negative outputs
        for (const output of batchOutputs) {
          if (output.amount < 0n) {
            throw new Error(`Calculated output amount is negative: ${output.amount}`);
          }
        }

        // Create and sign the transaction
        const tx = kaspa.createTransaction(selectedUtxos, batchOutputs, batchFee);
        const signedTx = kaspa.signTransaction(tx, [new kaspa.PrivateKey(KASJOIN_POOL_PRIVATE_KEY)], true);
        
        const resultSend = await rpc.submitTransaction({ transaction: signedTx });
        console.log(`[KasJoin] Test batch transaction submitted. TxID: ${resultSend.transactionId}`);

        // Update session statuses for this batch
        for (const { sessionId, session } of batchSessions) {
          session.status = 'completed';
          session.payoutAmount = payoutPerUser.toString();
          session.payoutTxId = resultSend.transactionId;
          session.batchNumber = batchNumber;
          session.batchIndex = 0;
          session.updatedAt = Date.now();
          await db.put(`${KASJOIN_SESSIONS_KEY}:${sessionId}`, session);
        }

        console.log(`[KasJoin] Test batch completed successfully. Fee paid: ${batchFee} sompi`);
        
      } catch (err) {
        console.error('[KasJoin] Error in test batch processing:', err);
        throw err;
      }
    };
    
    await testProcessBatch(testSessions);
    
    res.json({ 
      success: true, 
      message: `Test batch processed with ${testSessions.length} sessions`,
      sessionsProcessed: testSessions.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/kasjoin/debug-status - get detailed debug information
router.get('/debug-status', async (req, res) => {
  try {
    const sessions = await getAllKasjoinSessions();
    const paused = await getKasjoinPaused();
    const currentBatchNumber = await getCurrentBatchNumber();
    
    const statusCounts = {};
    const enteredSessions = [];
    
    for (const { sessionId, session } of sessions) {
      const status = session.status || 'unknown';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      
      if (status === 'entered') {
        enteredSessions.push({
          sessionId,
          destinationAddress: session.destinationAddress,
          amount: session.amount,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        });
      }
    }
    
    const debugInfo = {
      totalSessions: sessions.length,
      statusCounts,
      enteredSessions: enteredSessions.slice(0, 10), // Show first 10
      paused,
      currentBatchNumber,
      readyForBatch: enteredSessions.length >= 20,
      environment: {
        KASJOIN_POOL_WALLET: KASJOIN_POOL_WALLET ? 'SET' : 'NOT_SET',
        KASJOIN_POOL_PRIVATE_KEY: KASJOIN_POOL_PRIVATE_KEY ? 'SET' : 'NOT_SET',
        KASPA_NETWORK: KASPA_NETWORK,
        KASPA_NODE_URL: process.env.KASPA_NODE_URL || 'ws://127.0.0.1:17110'
      }
    };
    
    res.json(debugInfo);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to get debug status.' });
  }
});

// GET /api/kasjoin/optimization-stats - get optimization statistics
router.get('/optimization-stats', async (req, res) => {
  try {
    const batches = await getAllKasjoinBatches();
    
    // Calculate optimization statistics
    const stats = {
      totalBatches: batches.length,
      totalTransactions: 0,
      totalFeesPaid: 0n,
      averageFeePerTx: 0n,
      optimizationSettings: {
        maxOutputsPerTx: MAX_OUTPUTS_PER_TX,
        optimalUtxoCount: OPTIMAL_UTXO_COUNT,
        minFeeRate: MIN_FEE_RATE
      },
      recentBatches: []
    };

    // Process recent batches (last 10)
    const recentBatches = batches.slice(-10);
    for (const { session: batch } of recentBatches) {
      if (batch.batchResults) {
        stats.totalTransactions += batch.batchResults.length;
        for (const result of batch.batchResults) {
          stats.totalFeesPaid += BigInt(result.fee || 0);
        }
      } else {
        // Legacy batch format
        stats.totalTransactions += 1;
      }
      
      stats.recentBatches.push({
        batchNumber: batch.batchNumber,
        date: batch.date,
        totalSessions: batch.totalSessions || batch.sessions?.length || 0,
        totalBatches: batch.totalBatches || 1,
        totalFeesPaid: batch.totalFeesPaid || '0',
        optimization: batch.optimization || null
      });
    }

    if (stats.totalTransactions > 0) {
      stats.averageFeePerTx = stats.totalFeesPaid / BigInt(stats.totalTransactions);
    }

    res.json(toSafeJSON(stats));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to get optimization stats.' });
  }
});

// Export both the router and the necessary functions
module.exports = {
  router,
  monitorKasjoinDeposits,
  processKasjoinBatch,
  sweepStuckFunds,
  getKasjoinSession,
  setKasjoinPaused,
  getKasjoinPaused,
  verifyPoolWallet,
  checkAndTriggerKasjoinBatch
}; 
