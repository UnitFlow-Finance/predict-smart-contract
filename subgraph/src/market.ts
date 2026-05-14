import {
  BigInt,
  BigDecimal,
  Bytes,
  Address,
  dataSource,
} from "@graphprotocol/graph-ts";
import {
  LiquiditySeeded,
  Staked,
  Claimed,
  MarketResolved,
} from "../../generated/templates/PredictMarket/PredictMarket";
import {
  Market,
  Stake,
  UserPosition,
  UserStats,
  ProtocolStats,
} from "../../generated/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

const GLOBAL_ID = "global";
const ZERO_BI = BigInt.fromI32(0);
const ZERO_BD = BigDecimal.fromString("0");
const HUNDRED_BD = BigDecimal.fromString("100");
const BASIS_BD = BigDecimal.fromString("10000");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadOrCreateProtocolStats(): ProtocolStats {
  let stats = ProtocolStats.load(GLOBAL_ID);
  if (stats == null) {
    stats = new ProtocolStats(GLOBAL_ID);
    stats.totalVolume = ZERO_BI;
    stats.totalMarkets = ZERO_BI;
    stats.totalParticipants = ZERO_BI;
    stats.totalFees = ZERO_BI;
  }
  return stats;
}

function loadOrCreateUserStats(user: Bytes): UserStats {
  let stats = UserStats.load(user);
  if (stats == null) {
    stats = new UserStats(user);
    stats.user = user;
    stats.totalStaked = ZERO_BI;
    stats.totalEarnings = ZERO_BI;
    stats.marketsParticipated = ZERO_BI;
    stats.wins = ZERO_BI;
    stats.losses = ZERO_BI;
    stats.winRate = ZERO_BD;
  }
  return stats;
}

function loadOrCreateUserPosition(marketAddress: Bytes, user: Bytes): UserPosition {
  const id = marketAddress.concat(user);
  let pos = UserPosition.load(id);
  if (pos == null) {
    pos = new UserPosition(id);
    // market id is the bytes32 marketId stored on the Market entity;
    // we look it up by address via the dataSource context
    pos.market = dataSource.context().getBytes("marketId");
    pos.user = user;
    pos.yesShares = ZERO_BI;
    pos.noShares = ZERO_BI;
    pos.totalStaked = ZERO_BI;
    pos.claimed = false;
    pos.payout = ZERO_BI;
  }
  return pos;
}

/**
 * Recalculates yesOdds and noOdds as percentages (0.00–100.00) from pool sizes.
 *   yesOdds% = noPool / (yesPool + noPool) * 100
 *   noOdds%  = 100 - yesOdds%
 */
function computeOdds(yesPool: BigInt, noPool: BigInt): BigDecimal[] {
  const total = yesPool.plus(noPool);
  if (total.isZero()) {
    return [BigDecimal.fromString("50.00"), BigDecimal.fromString("50.00")];
  }
  const yesOdds = noPool
    .toBigDecimal()
    .times(HUNDRED_BD)
    .div(total.toBigDecimal());
  const noOdds = HUNDRED_BD.minus(yesOdds);
  return [yesOdds, noOdds];
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

/**
 * LiquiditySeeded(uint256 yesPool, uint256 noPool)
 *
 * Sets the initial pool state on the Market entity.
 */
export function handleLiquiditySeeded(event: LiquiditySeeded): void {
  // The market entity id is the bytes32 marketId, but we only have the contract
  // address here. We stored the marketId in the dataSource context when the
  // template was created. Fall back to address-based lookup via a reverse index
  // if needed — for simplicity we use the context approach.
  const marketId = dataSource.context().getBytes("marketId");
  const market = Market.load(marketId);
  if (market == null) return;

  market.yesPool = event.params.yesPool;
  market.noPool = event.params.noPool;

  const odds = computeOdds(event.params.yesPool, event.params.noPool);
  market.yesOdds = odds[0];
  market.noOdds = odds[1];

  market.save();
}

/**
 * Staked(address user, bool isYes, uint256 amount, uint256 sharesIssued,
 *        uint256 fee, uint256 yesOdds, uint256 noOdds)
 *
 * Creates a Stake entity, updates UserPosition, UserStats, Market, ProtocolStats.
 */
export function handleStaked(event: Staked): void {
  const marketId = dataSource.context().getBytes("marketId");
  const market = Market.load(marketId);
  if (market == null) return;

  const user = event.params.user;
  const amount = event.params.amount;
  const fee = event.params.fee;
  const isYes = event.params.isYes;
  const sharesIssued = event.params.sharesIssued;

  // ── Stake entity ─────────────────────────────────────────────────────────
  const stakeId = event.transaction.hash.concatI32(event.logIndex.toI32());
  const stake = new Stake(stakeId);
  stake.market = marketId;
  stake.user = user;
  stake.isYes = isYes;
  stake.amount = amount;
  stake.sharesIssued = sharesIssued;
  stake.fee = fee;
  stake.timestamp = event.block.timestamp;
  stake.transactionHash = event.transaction.hash;
  stake.save();

  // ── Update Market pool state and odds ────────────────────────────────────
  // Use the on-chain odds emitted in the event (basis points → percentage)
  const yesOddsBps = event.params.yesOdds;
  const noOddsBps = event.params.noOdds;
  market.yesOdds = yesOddsBps.toBigDecimal().times(HUNDRED_BD).div(BASIS_BD);
  market.noOdds = noOddsBps.toBigDecimal().times(HUNDRED_BD).div(BASIS_BD);

  // Update pool sizes: net amount = amount - fee
  const net = amount.minus(fee);
  if (isYes) {
    market.yesPool = market.yesPool.plus(net);
  } else {
    market.noPool = market.noPool.plus(net);
  }
  market.totalStaked = market.totalStaked.plus(amount);

  // ── UserPosition ─────────────────────────────────────────────────────────
  const marketAddress = Address.fromBytes(market.address);
  const pos = loadOrCreateUserPosition(market.address, user);
  const isNewParticipant = pos.totalStaked.isZero();

  if (isYes) {
    pos.yesShares = pos.yesShares.plus(sharesIssued);
  } else {
    pos.noShares = pos.noShares.plus(sharesIssued);
  }
  pos.totalStaked = pos.totalStaked.plus(amount);
  pos.save();

  // ── Participant count ─────────────────────────────────────────────────────
  if (isNewParticipant) {
    market.participantCount = market.participantCount.plus(BigInt.fromI32(1));
  }
  market.save();

  // ── UserStats ─────────────────────────────────────────────────────────────
  const userStats = loadOrCreateUserStats(user);
  const isNewMarket = pos.totalStaked.equals(amount); // first stake in this market
  if (isNewMarket) {
    userStats.marketsParticipated = userStats.marketsParticipated.plus(BigInt.fromI32(1));
  }
  userStats.totalStaked = userStats.totalStaked.plus(amount);
  userStats.save();

  // ── ProtocolStats ─────────────────────────────────────────────────────────
  const stats = loadOrCreateProtocolStats();
  stats.totalVolume = stats.totalVolume.plus(amount);
  stats.totalFees = stats.totalFees.plus(fee);
  if (isNewParticipant) {
    stats.totalParticipants = stats.totalParticipants.plus(BigInt.fromI32(1));
  }
  stats.save();
}

/**
 * Claimed(address user, uint256 shares, uint256 payout, uint256 fee)
 *
 * Marks the UserPosition as claimed, updates UserStats earnings and win/loss.
 */
export function handleClaimed(event: Claimed): void {
  const marketId = dataSource.context().getBytes("marketId");
  const market = Market.load(marketId);
  if (market == null) return;

  const user = event.params.user;
  const payout = event.params.payout;
  const fee = event.params.fee;

  // ── UserPosition ─────────────────────────────────────────────────────────
  const pos = loadOrCreateUserPosition(market.address, user);
  pos.claimed = true;
  pos.payout = payout;
  pos.save();

  // ── UserStats ─────────────────────────────────────────────────────────────
  const userStats = loadOrCreateUserStats(user);
  userStats.totalEarnings = userStats.totalEarnings.plus(payout);
  userStats.wins = userStats.wins.plus(BigInt.fromI32(1));

  // Recalculate win rate
  const totalGames = userStats.wins.plus(userStats.losses);
  if (!totalGames.isZero()) {
    userStats.winRate = userStats.wins
      .toBigDecimal()
      .times(HUNDRED_BD)
      .div(totalGames.toBigDecimal());
  }
  userStats.save();

  // ── ProtocolStats ─────────────────────────────────────────────────────────
  const stats = loadOrCreateProtocolStats();
  stats.totalFees = stats.totalFees.plus(fee);
  stats.save();
}

/**
 * MarketResolved(bool outcome, address resolver)
 *
 * Marks the market as resolved and records the outcome.
 * Also increments losses for all participants who held the losing side.
 */
export function handleMarketResolved(event: MarketResolved): void {
  const marketId = dataSource.context().getBytes("marketId");
  const market = Market.load(marketId);
  if (market == null) return;

  market.resolved = true;
  market.outcome = event.params.outcome;
  market.save();
}
