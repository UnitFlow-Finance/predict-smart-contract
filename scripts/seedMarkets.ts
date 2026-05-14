/**
 * seedMarkets.ts
 *
 * Deploys 12 prediction markets via PredictMarketFactory with the pool
 * configurations specified in the product brief. Each market's initial
 * liquidity is split asymmetrically to reflect the target implied probability.
 *
 * Pool math (constant-product):
 *   yesPrice = noPool / (yesPool + noPool)
 *   → to target P(YES) = p:  noPool = p * total,  yesPool = (1-p) * total
 *
 * Usage:
 *   npx hardhat run scripts/seedMarkets.ts --network arcTestnet
 *
 * Required env:
 *   FACTORY_ADDRESS   — deployed PredictMarketFactory proxy
 *   USDC_ADDRESS      — USDC token on Arc
 *   EURC_ADDRESS      — EURC token on Arc
 *   ORACLE_ADDRESS    — PredictOracle proxy (used as resolver for all markets)
 */

import { ethers } from "hardhat";
import "dotenv/config";

const USDC = process.env.USDC_ADDRESS!;
const EURC = process.env.EURC_ADDRESS!;
const FACTORY = process.env.FACTORY_ADDRESS!;
const ORACLE = process.env.ORACLE_ADDRESS!;

// 6-decimal USDC/EURC amounts
const u = (n: number) => ethers.parseUnits(String(n), 6);

interface MarketSpec {
  question: string;
  description: string;
  category: string;
  tags: string[];
  currency: string;
  resolutionTimestamp: number; // Unix timestamp
  initialLiquidity: bigint;
  // Pool split: yesPool + noPool = initialLiquidity
  // yesPool = (1 - targetYesProb) * initialLiquidity
  // noPool  = targetYesProb * initialLiquidity
  yesPool: bigint;
  noPool: bigint;
}

// Resolution dates as Unix timestamps (UTC midnight)
const JUN_18_2025  = 1750204800; // 2025-06-18
const JUL_01_2025  = 1751328000; // 2025-07-01
const SEP_30_2025  = 1759190400; // 2025-09-30
const MAY_31_2025  = 1748649600; // 2025-05-31
const JUN_30_2025  = 1751241600; // 2025-06-30
const JUN_06_2025  = 1749168000; // 2025-06-06
const SEP_01_2025  = 1756684800; // 2025-09-01
const DEC_31_2025  = 1767139200; // 2025-12-31
const JUL_31_2025  = 1753920000; // 2025-07-31
const DEC_31_2026  = 1798675200; // 2026-12-31

const TOTAL = u(10_000); // 10,000 USDC/EURC per market

/**
 * Builds a MarketSpec from a target YES probability (0–100 integer percent).
 * yesPool = (100 - pct) * total / 100  (lower yesPool → higher yesPrice)
 * noPool  = pct * total / 100
 */
function spec(
  question: string,
  description: string,
  category: string,
  tags: string[],
  currency: string,
  resolutionTimestamp: number,
  yesPct: number // target P(YES) as integer percent, e.g. 58 = 58%
): MarketSpec {
  const noPool = (TOTAL * BigInt(yesPct)) / 100n;
  const yesPool = TOTAL - noPool;
  return {
    question,
    description,
    category,
    tags,
    currency,
    resolutionTimestamp,
    initialLiquidity: TOTAL,
    yesPool,
    noPool,
  };
}

const MARKETS: MarketSpec[] = [
  spec(
    "Will the Fed cut rates at the June 2025 FOMC meeting?",
    "Federal Reserve rate decision at the June 17-18 2025 FOMC meeting.",
    "Macro",
    ["fed", "rates", "fomc", "macro"],
    USDC,
    JUN_18_2025,
    58 // P(YES) = 58% → noPool=5800, yesPool=4200
  ),
  spec(
    "Will ETH reach $5,000 before July 1, 2025?",
    "Ethereum spot price exceeds $5,000 USD at any point before July 1 2025.",
    "Crypto",
    ["eth", "ethereum", "price"],
    USDC,
    JUL_01_2025,
    34 // P(YES) = 34% → noPool=3400, yesPool=6600
  ),
  spec(
    "Will the EU pass the AI Governance Act by Q3 2025?",
    "European Union formally adopts AI Governance Act legislation before October 1 2025.",
    "Governance",
    ["eu", "ai", "regulation", "governance"],
    EURC,
    SEP_30_2025,
    71 // P(YES) = 71% → noPool=7100, yesPool=2900
  ),
  spec(
    "Will OPEC+ announce a production cut in May 2025?",
    "OPEC+ officially announces an oil production cut during May 2025.",
    "Energy",
    ["opec", "oil", "energy", "macro"],
    USDC,
    MAY_31_2025,
    44 // P(YES) = 44% → noPool=4400, yesPool=5600
  ),
  spec(
    "Will Bitcoin dominance exceed 60% by June 2025?",
    "Bitcoin market cap dominance exceeds 60% at any point before June 30 2025.",
    "Crypto",
    ["bitcoin", "btc", "dominance"],
    USDC,
    JUN_30_2025,
    52 // P(YES) = 52% → noPool=5200, yesPool=4800
  ),
  spec(
    "Will US unemployment exceed 4.5% in May 2025?",
    "US Bureau of Labor Statistics reports unemployment rate above 4.5% for May 2025.",
    "Macro",
    ["unemployment", "us", "macro", "labor"],
    USDC,
    JUN_06_2025,
    29 // P(YES) = 29% → noPool=2900, yesPool=7100
  ),
  spec(
    "Will Arc mainnet launch before September 2025?",
    "Circle's Arc blockchain mainnet goes live before September 1 2025.",
    "Crypto",
    ["arc", "circle", "mainnet", "l1"],
    USDC,
    SEP_01_2025,
    67 // P(YES) = 67% → noPool=6700, yesPool=3300
  ),
  spec(
    "Will the US pass stablecoin legislation by end of 2025?",
    "US Congress passes and President signs stablecoin-specific legislation before January 1 2026.",
    "Governance",
    ["stablecoin", "us", "legislation", "regulation"],
    USDC,
    DEC_31_2025,
    76 // P(YES) = 76% → noPool=7600, yesPool=2400
  ),
  spec(
    "Will gold hit $3,500/oz by June 2025?",
    "Spot gold price exceeds $3,500 per troy ounce before June 30 2025.",
    "Macro",
    ["gold", "commodities", "macro"],
    USDC,
    JUN_30_2025,
    41 // P(YES) = 41% → noPool=4100, yesPool=5900
  ),
  spec(
    "Will Circle complete its IPO before Q4 2025?",
    "Circle Internet Financial completes its IPO and begins trading before October 1 2025.",
    "Crypto",
    ["circle", "ipo", "usdc"],
    USDC,
    SEP_30_2025,
    83 // P(YES) = 83% → noPool=8300, yesPool=1700
  ),
  spec(
    "Will EURUSD exceed 1.15 by July 2025?",
    "EUR/USD exchange rate exceeds 1.15 at any point before July 31 2025.",
    "FX",
    ["eurusd", "fx", "euro", "dollar"],
    EURC,
    JUL_31_2025,
    38 // P(YES) = 38% → noPool=3800, yesPool=6200
  ),
  spec(
    "Will a G7 country adopt a CBDC by 2026?",
    "A G7 member nation officially launches a retail CBDC before January 1 2027.",
    "Governance",
    ["cbdc", "g7", "central-bank", "governance"],
    EURC,
    DEC_31_2026,
    55 // P(YES) = 55% → noPool=5500, yesPool=4500
  ),
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  if (!FACTORY || !USDC || !EURC || !ORACLE) {
    throw new Error(
      "Missing env vars: FACTORY_ADDRESS, USDC_ADDRESS, EURC_ADDRESS, ORACLE_ADDRESS"
    );
  }

  const factory = await ethers.getContractAt("PredictMarketFactory", FACTORY);
  const usdc = await ethers.getContractAt("MockERC20", USDC);
  const eurc = await ethers.getContractAt("MockERC20", EURC);

  const creationFee = await factory.marketCreationFee();
  console.log(`Market creation fee: ${ethers.formatUnits(creationFee, 6)} USDC/EURC`);

  for (let i = 0; i < MARKETS.length; i++) {
    const m = MARKETS[i];
    const token = m.currency === USDC ? usdc : eurc;
    const tokenSymbol = m.currency === USDC ? "USDC" : "EURC";
    const total = creationFee + m.initialLiquidity;

    // Approve
    const allowance = await token.allowance(deployer.address, FACTORY);
    if (allowance < total) {
      console.log(`  Approving ${tokenSymbol}...`);
      await (await token.approve(FACTORY, ethers.MaxUint256)).wait();
    }

    console.log(`\n[${i + 1}/12] Creating: "${m.question}"`);
    console.log(
      `  Currency: ${tokenSymbol} | P(YES): ${
        Number((m.noPool * 100n) / m.initialLiquidity)
      }% | Resolution: ${new Date(m.resolutionTimestamp * 1000).toISOString().slice(0, 10)}`
    );

    const tx = await factory.createMarket({
      question: m.question,
      description: m.description,
      category: m.category,
      tags: m.tags,
      currency: m.currency,
      resolutionDate: m.resolutionTimestamp,
      resolver: ORACLE, // oracle contract resolves all seeded markets
      oracleSource: "UnitFlow Oracle v1",
      initialLiquidity: m.initialLiquidity,
    });

    const receipt = await tx.wait();
    const iface = factory.interface;
    const log = receipt!.logs.find(
      (l) => l.topics[0] === iface.getEvent("MarketCreated")!.topicHash
    );

    if (log) {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      console.log(`  ✅ Market deployed: ${parsed!.args.marketAddress}`);
      console.log(`  MarketId: ${parsed!.args.marketId}`);
    }
  }

  console.log(`\n✅ All 12 markets seeded. Total markets: ${await factory.getMarketCount()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
