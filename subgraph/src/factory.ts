import { BigInt, BigDecimal, Bytes } from "@graphprotocol/graph-ts";
import { MarketCreated } from "../../generated/PredictMarketFactory/PredictMarketFactory";
import { PredictMarket as PredictMarketTemplate } from "../../generated/templates";
import { Market, ProtocolStats } from "../../generated/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

const GLOBAL_ID = "global";
const ZERO_BI = BigInt.fromI32(0);
const FIFTY_BD = BigDecimal.fromString("50.00");

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

// ─── Event Handlers ───────────────────────────────────────────────────────────

/**
 * Handles MarketCreated(bytes32 marketId, address marketAddress, address creator,
 *                       string question, address currency, uint256 resolutionDate)
 *
 * Creates the Market entity and starts tracking the new market contract via
 * the PredictMarket data source template.
 */
export function handleMarketCreated(event: MarketCreated): void {
  const marketId = event.params.marketId;
  const marketAddress = event.params.marketAddress;

  // ── Create Market entity ──────────────────────────────────────────────────
  const market = new Market(marketId);
  market.address = marketAddress;
  market.question = event.params.question;
  market.description = "";       // populated via LiquiditySeeded / getMarketInfo call
  market.category = "";
  market.tags = [];
  market.currency = event.params.currency;
  market.creator = event.params.creator;
  market.resolutionDate = event.params.resolutionDate;
  market.createdAt = event.block.timestamp;
  market.resolver = Bytes.empty();
  market.oracleSource = "";

  // AMM state — seeded to 50/50 until LiquiditySeeded fires
  market.yesPool = ZERO_BI;
  market.noPool = ZERO_BI;
  market.totalStaked = ZERO_BI;
  market.yesOdds = FIFTY_BD;
  market.noOdds = FIFTY_BD;

  market.resolved = false;
  market.outcome = null;
  market.participantCount = ZERO_BI;

  market.save();

  // ── Start tracking the market contract ───────────────────────────────────
  PredictMarketTemplate.create(marketAddress);

  // ── Update ProtocolStats ─────────────────────────────────────────────────
  const stats = loadOrCreateProtocolStats();
  stats.totalMarkets = stats.totalMarkets.plus(BigInt.fromI32(1));
  stats.save();
}
