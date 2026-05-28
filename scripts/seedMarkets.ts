/**
 * seedMarkets.ts — Deploy live prediction markets across all 7 categories.
 *
 * Categories: Crypto, Macro, Governance, Energy, FX, Politics, Sports
 *
 * Pool math (constant-product AMM):
 *   yesPrice = noPool / (yesPool + noPool)
 *   To target P(YES) = p%:  noPool = p * total / 100,  yesPool = total - noPool
 *
 * Usage:
 *   npx hardhat run scripts/seedMarkets.ts --network arcTestnet
 */

import { ethers } from "hardhat";
import "dotenv/config";

const USDC    = process.env.USDC_ADDRESS!;
const EURC    = process.env.EURC_ADDRESS!;
const FACTORY = process.env.FACTORY_ADDRESS!;
const ORACLE  = process.env.ORACLE_ADDRESS!;

const u = (n: number) => ethers.parseUnits(String(n), 6);
const TOTAL = u(100); // 100 USDC/EURC initial liquidity per market

interface MarketDef {
  question: string;
  description: string;
  category: string;
  tags: string[];
  currency: string;
  resolutionTimestamp: number;
  yesPct: number;
}

const now  = Math.floor(Date.now() / 1000);
const D7   = now + 7   * 86400;
const D14  = now + 14  * 86400;
const D30  = now + 30  * 86400;
const D45  = now + 45  * 86400;
const D60  = now + 60  * 86400;
const D90  = now + 90  * 86400;
const D120 = now + 120 * 86400;
const D180 = now + 180 * 86400;
const D365 = now + 365 * 86400;

const MARKETS: MarketDef[] = [
  // ── Crypto ─────────────────────────────────────────────────────────────────
  {
    question: "Will ETH reach $5,000 before August 2026?",
    description: "Ethereum spot price exceeds $5,000 USD at any point before August 1 2026.",
    category: "Crypto", tags: ["eth", "ethereum", "price"],
    currency: USDC, resolutionTimestamp: D60, yesPct: 38,
  },
  {
    question: "Will Bitcoin dominance exceed 60% by July 2026?",
    description: "Bitcoin market cap dominance exceeds 60% at any point before July 27 2026.",
    category: "Crypto", tags: ["bitcoin", "btc", "dominance"],
    currency: USDC, resolutionTimestamp: D60, yesPct: 54,
  },
  {
    question: "Will Arc mainnet launch before September 2026?",
    description: "Arc blockchain mainnet goes live and is publicly accessible before September 1 2026.",
    category: "Crypto", tags: ["arc", "mainnet", "l1", "circle"],
    currency: USDC, resolutionTimestamp: D90, yesPct: 70,
  },
  {
    question: "Will Circle complete its IPO by Q1 2027?",
    description: "Circle Internet Financial completes its IPO and begins trading before April 1 2027.",
    category: "Crypto", tags: ["circle", "ipo", "usdc"],
    currency: USDC, resolutionTimestamp: D365, yesPct: 82,
  },

  // ── Macro ──────────────────────────────────────────────────────────────────
  {
    question: "Will the Fed cut rates at the next FOMC meeting?",
    description: "Federal Reserve cuts the federal funds rate target at its next scheduled FOMC meeting.",
    category: "Macro", tags: ["fed", "rates", "fomc"],
    currency: USDC, resolutionTimestamp: D30, yesPct: 60,
  },
  {
    question: "Will US unemployment exceed 4.5% in 2026?",
    description: "US Bureau of Labor Statistics reports unemployment above 4.5% for any month in 2026.",
    category: "Macro", tags: ["unemployment", "us", "labor"],
    currency: USDC, resolutionTimestamp: D120, yesPct: 30,
  },
  {
    question: "Will gold hit $4,000/oz by September 2026?",
    description: "Spot gold price exceeds $4,000 per troy ounce before September 25 2026.",
    category: "Macro", tags: ["gold", "commodities"],
    currency: USDC, resolutionTimestamp: D120, yesPct: 44,
  },

  // ── Governance ─────────────────────────────────────────────────────────────
  {
    question: "Will the US pass stablecoin legislation by end of 2026?",
    description: "US Congress passes and President signs stablecoin-specific legislation before January 1 2027.",
    category: "Governance", tags: ["stablecoin", "us", "legislation"],
    currency: USDC, resolutionTimestamp: D180, yesPct: 75,
  },
  {
    question: "Will the EU pass the AI Governance Act by Q4 2026?",
    description: "European Union formally adopts AI Governance Act legislation before January 1 2027.",
    category: "Governance", tags: ["eu", "ai", "regulation"],
    currency: EURC, resolutionTimestamp: D180, yesPct: 68,
  },
  {
    question: "Will a G7 country adopt a retail CBDC by 2027?",
    description: "A G7 member nation officially launches a retail CBDC before January 1 2028.",
    category: "Governance", tags: ["cbdc", "g7", "central-bank"],
    currency: EURC, resolutionTimestamp: D365, yesPct: 52,
  },

  // ── Energy ─────────────────────────────────────────────────────────────────
  {
    question: "Will OPEC+ announce a production cut in Q3 2026?",
    description: "OPEC+ officially announces an oil production cut during Q3 2026 (July–September).",
    category: "Energy", tags: ["opec", "oil", "energy"],
    currency: USDC, resolutionTimestamp: D90, yesPct: 46,
  },
  {
    question: "Will Brent crude oil exceed $100/barrel by August 2026?",
    description: "Brent crude spot price exceeds $100 per barrel at any point before August 26 2026.",
    category: "Energy", tags: ["brent", "oil", "crude"],
    currency: USDC, resolutionTimestamp: D90, yesPct: 28,
  },
  {
    question: "Will EU natural gas prices fall below €30/MWh by October 2026?",
    description: "TTF natural gas front-month price falls below €30/MWh at any point before October 2026.",
    category: "Energy", tags: ["gas", "eu", "ttf"],
    currency: EURC, resolutionTimestamp: D120, yesPct: 55,
  },

  // ── FX ─────────────────────────────────────────────────────────────────────
  {
    question: "Will EUR/USD exceed 1.15 by August 2026?",
    description: "EUR/USD exchange rate exceeds 1.15 at any point before August 26 2026.",
    category: "FX", tags: ["eurusd", "fx", "euro", "dollar"],
    currency: EURC, resolutionTimestamp: D90, yesPct: 40,
  },
  {
    question: "Will USD/JPY fall below 140 by July 2026?",
    description: "USD/JPY exchange rate falls below 140 at any point before July 27 2026.",
    category: "FX", tags: ["usdjpy", "fx", "yen", "dollar"],
    currency: USDC, resolutionTimestamp: D60, yesPct: 35,
  },
  {
    question: "Will GBP/USD exceed 1.35 by September 2026?",
    description: "GBP/USD exchange rate exceeds 1.35 at any point before September 25 2026.",
    category: "FX", tags: ["gbpusd", "fx", "pound", "dollar"],
    currency: USDC, resolutionTimestamp: D120, yesPct: 62,
  },

  // ── Politics ───────────────────────────────────────────────────────────────
  {
    question: "Will the UK hold a general election before end of 2026?",
    description: "United Kingdom holds a general election before January 1 2027.",
    category: "Politics", tags: ["uk", "election", "politics"],
    currency: USDC, resolutionTimestamp: D180, yesPct: 22,
  },
  {
    question: "Will France's government survive a no-confidence vote in 2026?",
    description: "French government survives any no-confidence vote brought in 2026.",
    category: "Politics", tags: ["france", "politics", "government"],
    currency: EURC, resolutionTimestamp: D180, yesPct: 58,
  },
  {
    question: "Will the US midterms flip the Senate in 2026?",
    description: "Republicans or Democrats flip Senate majority control in the 2026 US midterm elections.",
    category: "Politics", tags: ["us", "midterms", "senate"],
    currency: USDC, resolutionTimestamp: D180, yesPct: 48,
  },

  // ── Sports ─────────────────────────────────────────────────────────────────
  {
    question: "Will Real Madrid win the 2025/26 UEFA Champions League?",
    description: "Real Madrid CF wins the 2025/26 UEFA Champions League final.",
    category: "Sports", tags: ["football", "ucl", "real-madrid"],
    currency: EURC, resolutionTimestamp: D14, yesPct: 32,
  },
  {
    question: "Will a new 100m world record be set at the 2026 World Athletics Championships?",
    description: "A new 100m world record is officially ratified at the 2026 World Athletics Championships.",
    category: "Sports", tags: ["athletics", "100m", "world-record"],
    currency: USDC, resolutionTimestamp: D45, yesPct: 18,
  },
  {
    question: "Will the Golden State Warriors make the 2026 NBA Playoffs?",
    description: "Golden State Warriors qualify for the 2025/26 NBA Playoffs.",
    category: "Sports", tags: ["nba", "warriors", "basketball"],
    currency: USDC, resolutionTimestamp: D7, yesPct: 55,
  },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  console.log(`\nDeployer: ${deployer.address}`);
  console.log(`Network:  chainId ${network.chainId}`);
  console.log(`Markets:  ${MARKETS.length} across 7 categories\n`);

  if (!FACTORY || !USDC || !EURC || !ORACLE) {
    throw new Error("Missing env: FACTORY_ADDRESS, USDC_ADDRESS, EURC_ADDRESS, ORACLE_ADDRESS");
  }

  const factory = await ethers.getContractAt("PredictMarketFactory", FACTORY);
  const usdc    = await ethers.getContractAt("MockERC20", USDC);
  const eurc    = await ethers.getContractAt("MockERC20", EURC);

  const creationFee = await factory.marketCreationFee();
  console.log(`Creation fee: ${ethers.formatUnits(creationFee, 6)} per market`);

  // Pre-approve both tokens for the full batch
  const usdcCount = MARKETS.filter((m) => m.currency === USDC).length;
  const eurcCount = MARKETS.filter((m) => m.currency === EURC).length;
  const usdcNeed  = (creationFee + TOTAL) * BigInt(usdcCount);
  const eurcNeed  = (creationFee + TOTAL) * BigInt(eurcCount);

  console.log(`Approving USDC (${ethers.formatUnits(usdcNeed, 6)})...`);
  await (await usdc.approve(FACTORY, usdcNeed * 2n)).wait();
  console.log(`Approving EURC (${ethers.formatUnits(eurcNeed, 6)})...`);
  await (await eurc.approve(FACTORY, eurcNeed * 2n)).wait();
  console.log();

  const results: { category: string; address: string }[] = [];

  for (let i = 0; i < MARKETS.length; i++) {
    const m   = MARKETS[i];
    const sym = m.currency === USDC ? "USDC" : "EURC";

    console.log(`[${String(i + 1).padStart(2)}/${MARKETS.length}] [${m.category}] "${m.question}"`);
    console.log(`       ${sym} | P(YES)=${m.yesPct}% | closes ${new Date(m.resolutionTimestamp * 1000).toISOString().slice(0, 10)}`);

    try {
      const tx = await factory.createMarket({
        question:         m.question,
        description:      m.description,
        category:         m.category,
        tags:             m.tags,
        currency:         m.currency,
        resolutionDate:   m.resolutionTimestamp,
        resolver:         ORACLE,
        oracleSource:     "UnitFlow Oracle v1",
        initialLiquidity: TOTAL,
      });

      const receipt = await tx.wait();
      const iface   = factory.interface;
      const log     = receipt!.logs.find(
        (l) => l.topics[0] === iface.getEvent("MarketCreated")!.topicHash
      );

      if (log) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        const addr   = parsed!.args.marketAddress as string;
        console.log(`       ✅ ${addr}\n`);
        results.push({ category: m.category, address: addr });
      }
    } catch (err: any) {
      console.error(`       ❌ ${err.message?.slice(0, 100)}\n`);
    }
  }

  // Summary by category
  const cats = [...new Set(MARKETS.map((m) => m.category))];
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  SEEDING COMPLETE — ${results.length}/${MARKETS.length} markets deployed`);
  console.log("═══════════════════════════════════════════════════════");
  for (const cat of cats) {
    const total    = MARKETS.filter((m) => m.category === cat).length;
    const deployed = results.filter((r) => r.category === cat).length;
    console.log(`  ${cat.padEnd(12)} ${deployed}/${total}`);
  }
  const totalOnChain = await factory.getMarketCount();
  console.log(`\n  Total on-chain markets: ${totalOnChain}`);
  console.log(`  Factory: ${FACTORY}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
