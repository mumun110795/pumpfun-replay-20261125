// Pump.fun Replay Sprint — a momentum rider.
//
// Design, grounded in what the dev window shows: coins that have just risen
// a little and are still rising, with most of the recent volume on the buy
// side from many distinct buyers, keep drifting up for a short while — but
// they give it all back within the hour, so positions must be short-lived.
// This bot therefore enters only on confirmed, sustained buying pressure
// over a longer lookback than a sniper would use (+5% over ~3 minutes and
// +10% over ~8 minutes, still rising in the last minute, >= 65% of recent
// volume on the buy side, from >= 6 distinct buyers), adds to a winner only
// while that strength persists, banks half at +35%, and cuts everything else
// fast: a 12% trailing exit, a 15% hard stop, and a stale exit that frees
// the slot when a coin sits without moving. Capital recycles through five
// slots all day, so the bot keeps trading fresh coins through the whole
// 24-hour window instead of parking in five early coins.
//
// All decisions come from the hello/batch stream only: no clock, no random
// numbers, no environment input, so two runs produce identical action logs.
// Prices are read off the bonding curve's virtual reserves
// (virtual quote / virtual token), which is the price the curve itself quotes.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tunables

// Entry sizing, in lamports. Buys are also capped by the harness at 1% of a
// mint's real SOL reserve, so a coin must have grown a real reserve before a
// full-size entry is possible; small caps mean small (or skipped) entries.
const ENTRY_LAMPORTS = (LAMPORTS_PER_SOL * 15n) / 100n; // 0.15 SOL first buy
const ADD_LAMPORTS = (LAMPORTS_PER_SOL * 15n) / 100n; // 0.15 SOL per add-on
const MIN_ENTRY_CAP_LAMPORTS = (LAMPORTS_PER_SOL * 8n) / 100n; // need >= 0.08 SOL of headroom
const MIN_ADD_CAP_LAMPORTS = (LAMPORTS_PER_SOL * 8n) / 100n;
const CASH_BUFFER_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n; // keep 0.3 SOL spare
const MAX_ADDS = 0; // no add-ons: feeding winners that then reversed cost more than it gained.

// Entry confirmation (price ratios over slot lookbacks; a slot is ~0.4 s).
// The lookbacks are long enough to demand a real wave of buying, but short
// enough to catch the wave while it is still running: a coin that has already
// run 60%+ in the window is usually topping, not starting.
const MIN_AGE_SLOTS = 200; // coin must have existed a while before we trust it
const SPAN_SLOTS = 1000; // price history must span at least this long
const LOOK_MID_SLOTS = 400; // ~2.7 min
const LOOK_LONG_SLOTS = 1200; // ~8 min
const LOOK_SHORT_SLOTS = 100; // ~40 s
const MIN_RET_MID = 0.05; // +5% over the mid lookback
const MIN_RET_LONG = 0.1; // +10% over the long lookback
const MAX_RET_LONG = 0.6; // do not chase a coin already up >60% over the lookback
const MIN_RET_SHORT = 0.01; // price must still be rising in the last minute
const MIN_BUY_SHARE = 0.65; // >= 65% of recent volume on the buy side
const MIN_BUY_TRADES = 12; // ... across at least 12 buy trades in the window
const MIN_BUYERS = 6; // ... from at least 6 distinct buyers (a crowd, not one wallet)
const MIN_BUY_VOL_LAMPORTS = (LAMPORTS_PER_SOL * 5n) / 10n; // ... worth >= 0.5 SOL
const MIN_TOTAL_TRADES = 25;
const WINDOW_SLOTS = 450; // recent-volume window, ~3 min
const SAMPLE_EVERY_SLOTS = 15;
const MAX_SAMPLES = 200;
const MAX_ENTRIES_PER_BATCH = 2;
const REENTRY_COOLDOWN_SLOTS = 3000;

// Add-on confirmation: only feed a winner that is still pushing.
const ADD1_MULT = 1.2;
const ADD2_MULT = 1.45;
const MIN_ADD_RET_MID = 0.03;
const MIN_ADD_BUY_SHARE = 0.6;

// Exits. The trailing exit is deliberately tight: on this curve a winner that
// gives back more than ~12% from its peak rarely comes back, and a loser
// allowed to fall far costs several winners to repair.
const TRAIL_DROP = 0.88; // sell all once price falls 12% below its peak since entry
const HARD_STOP_MULT = 0.85; // sell all once price falls 15% below average entry cost
const LOSER_CUT_MULT = 0.93; // early loser cut, only while the short trend is also down
const LOSER_CUT_RET_SHORT = -0.03;
const HALF_TAKE_MULT = 1.5; // bank half the tokens at +50%
const REVERSAL_RET_MID = -0.08; // clear reversal over the mid lookback
const REVERSAL_BUY_SHARE = 0.5;
const STALE_SLOTS = 6000; // ~40 min held ...
const STALE_MULT = 1.08; // ... without reaching +8%: give the slot to a fresher coin

const BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 2500;

// ------------------------------------------------------------------ per-coin state

interface PriceSample {
  slot: number;
  price: number;
}

interface Track {
  mint: string;
  createdSlot: number;
  samples: PriceSample[];
  lastSampleSlot: number;
  lastPrice: number;
  winStart: number;
  buyVol: number;
  sellVol: number;
  buyN: number;
  sellN: number;
  buyers: Set<string>;
  seenTrades: number;
  complete: boolean;
  // Position bookkeeping, reset when the position closes.
  entrySlot: number;
  peak: number;
  adds: number;
  halfTaken: boolean;
  lastExitSlot: number;
}

const tracks = new Map<string, Track>();

function trackFor(mint: string, slot: number): Track {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = {
      mint,
      createdSlot: slot,
      samples: [],
      lastSampleSlot: -1000000,
      lastPrice: 0,
      winStart: slot,
      buyVol: 0,
      sellVol: 0,
      buyN: 0,
      sellN: 0,
      buyers: new Set<string>(),
      seenTrades: 0,
      complete: false,
      entrySlot: -1,
      peak: 0,
      adds: 0,
      halfTaken: false,
      lastExitSlot: -1000000,
    };
    tracks.set(mint, t);
  }
  return t;
}

function priceOfCurve(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualQuote <= 0n || virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

// Latest sampled price at or before targetSlot, or null when history is thin.
function priceAt(t: Track, targetSlot: number): number | null {
  const s = t.samples;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].slot <= targetSlot) return s[i].price;
  }
  return null;
}

function buyShare(t: Track): number {
  const total = t.buyVol + t.sellVol;
  if (total <= 0) return 0;
  return t.buyVol / total;
}

function resetPosition(t: Track, slot: number): void {
  t.entrySlot = -1;
  t.peak = 0;
  t.adds = 0;
  t.halfTaken = false;
  t.lastExitSlot = slot;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const selling = new Set<string>();

    // Tokens already spoken for by sell orders still in flight, per mint, so
    // a later sell in the same window never asks for tokens that are already
    // on their way out (which the harness would reject).
    const pendingSellTokens = new Map<string, bigint>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') {
        const cur = pendingSellTokens.get(p.order.mint) ?? 0n;
        pendingSellTokens.set(p.order.mint, cur + BigInt(p.order.token_amount));
      }
    }

    // 1. Fold this batch's events into the per-coin tracks.
    const traded = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = trackFor(e.mint, e.slot);
        t.createdSlot = e.slot;
        continue;
      }
      if (e.event === 'CompleteEvent') {
        const t = trackFor(e.mint, e.slot);
        t.complete = true;
        continue;
      }
      // TradeEvent.
      const t = trackFor(e.mint, e.slot);
      traded.add(e.mint);
      const price = priceOfCurve(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (price > 0) {
        t.lastPrice = price;
        if (slot - t.lastSampleSlot >= SAMPLE_EVERY_SLOTS) {
          t.samples.push({ slot, price });
          if (t.samples.length > MAX_SAMPLES) t.samples.shift();
          t.lastSampleSlot = slot;
        }
      }
      if (slot - t.winStart >= WINDOW_SLOTS) {
        t.winStart = slot;
        t.buyVol = 0;
        t.sellVol = 0;
        t.buyN = 0;
        t.sellN = 0;
        t.buyers.clear();
      }
      const sol = Number(BigInt(e.sol_amount));
      if (e.is_buy) {
        t.buyVol += sol;
        t.buyN += 1;
        t.buyers.add(e.user);
      } else {
        t.sellVol += sol;
        t.sellN += 1;
      }
      t.seenTrades += 1;
    }

    // Positions that vanished since last batch (sold, completed, flattened)
    // close out their bookkeeping so a later re-entry starts clean.
    for (const t of tracks.values()) {
      if (t.entrySlot >= 0 && !state.positions.has(t.mint)) resetPosition(t, slot);
    }

    // 2. Exits first: protect capital, bank half of early winners, drop stale coins.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      const t = tracks.get(mint);
      let price = 0;
      if (curve !== undefined) price = priceOfCurve(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0 && t !== undefined) price = t.lastPrice;
      if (price <= 0 || curve?.complete) continue;
      const held = BigInt(pos.token_amount);
      const spoken = pendingSellTokens.get(mint) ?? 0n;
      const tokens = held - spoken;
      if (tokens <= 0n) continue;
      const avgCost = Number(BigInt(pos.cost_lamports)) / Number(held);
      if (avgCost <= 0) continue;
      if (t !== undefined) {
        if (t.entrySlot < 0) {
          t.entrySlot = slot;
          t.peak = price;
        } else if (price > t.peak) {
          t.peak = price;
        }
      }
      const peak = t !== undefined && t.peak > 0 ? t.peak : price;
      const mid = t !== undefined ? priceAt(t, slot - LOOK_MID_SLOTS) : null;
      const short = t !== undefined ? priceAt(t, slot - LOOK_SHORT_SLOTS) : null;
      const retMid = mid !== null && mid > 0 ? price / mid - 1 : 0;
      const retShort = short !== null && short > 0 ? price / short - 1 : 0;
      const heldSlots = t !== undefined && t.entrySlot >= 0 ? slot - t.entrySlot : 0;

      let sellAll = false;
      if (price < peak * TRAIL_DROP) sellAll = true;
      if (price < avgCost * HARD_STOP_MULT) sellAll = true;
      if (price < avgCost * LOSER_CUT_MULT && retShort < LOSER_CUT_RET_SHORT) sellAll = true;
      if (t !== undefined && retMid < REVERSAL_RET_MID && buyShare(t) < REVERSAL_BUY_SHARE) sellAll = true;
      if (heldSlots > STALE_SLOTS && price < avgCost * STALE_MULT) sellAll = true;

      if (sellAll) {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS } as SellInput);
        selling.add(mint);
        continue;
      }
      // Bank half of a winner and let the rest ride the trailing exit.
      if (t !== undefined && !t.halfTaken && price >= avgCost * HALF_TAKE_MULT) {
        const half = tokens / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: SELL_SLIPPAGE_BPS } as SellInput);
          t.halfTaken = true;
        }
      }
    }

    // 3. Add to winners that are still pushing.
    let free = state.freeCashLamports();
    for (const [mint, pos] of state.positions) {
      if (selling.has(mint)) continue;
      const t = tracks.get(mint);
      if (t === undefined || t.adds >= MAX_ADDS || t.entrySlot < 0) continue;
      const curve = state.curves.get(mint);
      let price = 0;
      if (curve !== undefined) price = priceOfCurve(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) price = t.lastPrice;
      if (price <= 0) continue;
      const tokens = BigInt(pos.token_amount);
      if (tokens <= 0n) continue;
      const avgCost = Number(BigInt(pos.cost_lamports)) / Number(tokens);
      if (avgCost <= 0) continue;
      const need = t.adds === 0 ? avgCost * ADD1_MULT : avgCost * ADD2_MULT;
      if (price < need) continue;
      const mid = priceAt(t, slot - LOOK_MID_SLOTS);
      const retMid = mid !== null && mid > 0 ? price / mid - 1 : 0;
      if (retMid < MIN_ADD_RET_MID || buyShare(t) < MIN_ADD_BUY_SHARE) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < ADD_LAMPORTS ? cap : ADD_LAMPORTS;
      if (amount < MIN_ADD_CAP_LAMPORTS || free < amount + txFee) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS } as BuyInput);
      free -= amount + txFee;
      t.adds += 1;
    }

    // 4. Fresh entries: confirmed, sustained buying pressure only.
    let slotsFree = caps.max_open_positions - state.committedPositionCount();
    if (slotsFree > 0 && traded.size > 0) {
      const candidates: Array<{ mint: string; score: number }> = [];
      for (const mint of traded) {
        const t = tracks.get(mint);
        if (t === undefined || t.complete) continue;
        if (state.positions.has(mint) || selling.has(mint)) continue;
        if (slot - t.createdSlot < MIN_AGE_SLOTS) continue;
        if (t.samples.length < 2) continue;
        if (t.samples[t.samples.length - 1].slot - t.samples[0].slot < SPAN_SLOTS) continue;
        if (slot - t.lastExitSlot < REENTRY_COOLDOWN_SLOTS) continue;
        if (t.seenTrades < MIN_TOTAL_TRADES) continue;
        const price = t.lastPrice;
        if (price <= 0) continue;
        const mid = priceAt(t, slot - LOOK_MID_SLOTS);
        const long = priceAt(t, slot - LOOK_LONG_SLOTS);
        const short = priceAt(t, slot - LOOK_SHORT_SLOTS);
        if (mid === null || long === null || short === null) continue;
        const retMid = price / mid - 1;
        const retLong = price / long - 1;
        const retShort = price / short - 1;
        if (retMid < MIN_RET_MID || retLong < MIN_RET_LONG) continue;
        if (retLong > MAX_RET_LONG) continue;
        if (retShort < MIN_RET_SHORT) continue;
        if (buyShare(t) < MIN_BUY_SHARE) continue;
        if (t.buyN < MIN_BUY_TRADES) continue;
        if (t.buyers.size < MIN_BUYERS) continue;
        if (t.buyVol < Number(MIN_BUY_VOL_LAMPORTS)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const realSol = Number(curve.real_quote_reserves);
        if (realSol < 8 * 1e9 || realSol > 85 * 1e9) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_ENTRY_CAP_LAMPORTS) continue;
        // Score by combined strength so the strongest wave wins the free slot.
        candidates.push({ mint, score: retLong + retMid });
      }
      candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
      });
      let entered = 0;
      for (const c of candidates) {
        if (entered >= MAX_ENTRIES_PER_BATCH || slotsFree <= 0) break;
        if (orders.length >= caps.max_orders_per_batch) break;
        const cap = state.maxBuyLamports(c.mint);
        const amount = cap < ENTRY_LAMPORTS ? cap : ENTRY_LAMPORTS;
        if (amount < MIN_ENTRY_CAP_LAMPORTS) continue;
        if (free < amount + txFee + CASH_BUFFER_LAMPORTS) break;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS } as BuyInput);
        free -= amount + txFee;
        slotsFree -= 1;
        entered += 1;
      }
    }

    return orders;
  },
});
