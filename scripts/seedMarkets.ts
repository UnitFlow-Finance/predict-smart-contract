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

// Resolution dates — all in the future relative to 2026-05-15
const D30  = 1781440028; // 2026-06-14
const D60  = 1784032028; // 2026-07-14
const D90  = 1786624028; // 2026-08-13
const D120 = 1789216028; // 2026-09-12
const D180 = 1794400028; // 2026-11-11
const D365 = 1810384028; // 2027-05-15
const D545 = 1825936028; // 2027-11-11

const TOTAL = u(50); // 50 USDC/EURC per market (deployer has limited testnet balance)

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
    "Will the Fed cut rates at the next FOMC meeting?",
    "Federal Reserve cuts the federal funds rate target at its next scheduled FOMC meeting.",
    "Macro",
    ["fed", "rates", "fomc", "macro"],
    USDC,
    D30,
    58
  ),
  spec(
    "Will ETH reach $5,000 before August 2026?",
    "Ethereum spot price exceeds $5,000 USD at any point before August 1 2026.",
    "Crypto",
    ["eth", "ethereum", "price"],
    USDC,
    D60,
    34
  ),
  spec(
    "Will the EU pass the AI Governance Act by Q4 2026?",
    "European Union formally adopts AI Governance Act legislation before January 1 2027.",
    "Governance",
    ["eu", "ai", "regulation", "governance"],
    EURC,
    D180,
    71
  ),
  spec(
    "Will OPEC+ announce a production cut in Q3 2026?",
    "OPEC+ officially announces an oil production cut during Q3 2026 (July–September).",
    "Energy",
    ["opec", "oil", "energy", "macro"],
    USDC,
    D90,
    44
  ),
  spec(
    "Will Bitcoin dominance exceed 60% by July 2026?",
    "Bitcoin market cap dominance exceeds 60% at any point before July 14 2026.",
    "Crypto",
    ["bitcoin", "btc", "dominance"],
    USDC,
    D60,
    52
  ),
  spec(
    "Will US unemployment exceed 4.5% in 2026?",
    "US Bureau of Labor Statistics reports unemployment rate above 4.5% for any month in 2026.",
    "Macro",
    ["unemployment", "us", "macro", "labor"],
    USDC,
    D120,
    29
  ),
  spec(
    "Will Arc mainnet launch before September 2026?",
    "Circle's Arc blockchain mainnet goes live before September 1 2026.",
    "Crypto",
    ["arc", "circle", "mainnet", "l1"],
    USDC,
    D90,
    67
  ),
  spec(
    "Will the US pass stablecoin legislation by end of 2026?",
    "US Congress passes and President signs stablecoin-specific legislation before January 1 2027.",
    "Governance",
    ["stablecoin", "us", "legislation", "regulation"],
    USDC,
    D180,
    76
  ),
  spec(
    "Will gold hit $4,000/oz by September 2026?",
    "Spot gold price exceeds $4,000 per troy ounce before September 12 2026.",
    "Macro",
    ["gold", "commodities", "macro"],
    USDC,
    D120,
    41
  ),
  spec(
    "Will Circle complete its IPO by Q1 2027?",
    "Circle Internet Financial completes its IPO and begins trading before April 1 2027.",
    "Crypto",
    ["circle", "ipo", "usdc"],
    USDC,
    D365,
    83
  ),
  spec(
    "Will EURUSD exceed 1.15 by August 2026?",
    "EUR/USD exchange rate exceeds 1.15 at any point before August 13 2026.",
    "FX",
    ["eurusd", "fx", "euro", "dollar"],
    EURC,
    D90,
    38
  ),
  spec(
    "Will a G7 country adopt a CBDC by 2027?",
    "A G7 member nation officially launches a retail CBDC before January 1 2028.",
    "Governance",
    ["cbdc", "g7", "central-bank", "governance"],
    EURC,
    D545,
    55
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
