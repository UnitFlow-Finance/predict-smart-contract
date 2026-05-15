/**
 * verifyAll.ts
 *
 * Verifies every deployed contract on ArcScan:
 *   - MockUnitFlowRouter
 *   - FeeDistributor impl + proxy
 *   - PredictOracle impl + proxy
 *   - PredictMarketFactory impl + proxy
 *   - All PredictMarket instances (fetched from factory.getAllMarkets())
 *
 * Reads addresses from deployments.json. No env vars required beyond
 * DEPLOYER_PRIVATE_KEY (already in .env).
 */

import hre from "hardhat";
import fs from "fs";
import path from "path";
import "dotenv/config";

const deployments = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../deployments.json"), "utf8")
);

const {
  MockUnitFlowRouter: MOCK_ROUTER,
  FeeDistributor: { proxy: FD_PROXY, impl: FD_IMPL },
  PredictOracle: { proxy: ORACLE_PROXY, impl: ORACLE_IMPL },
  PredictMarketFactory: { proxy: FACTORY_PROXY, impl: FACTORY_IMPL },
} = deployments.contracts;

const OWNER   = deployments.deployer;
const USDC    = deployments.tokens.USDC;
const EURC    = deployments.tokens.EURC;

// From deploy script — same values used at deploy time
const UNIT_ROUTER     = MOCK_ROUTER;
const TREASURY        = OWNER;
const LP_REWARD_POOL  = OWNER;
const ADMIN_RESOLVER  = OWNER;

async function verify(name: string, address: string, constructorArgs: unknown[]) {
  console.log(`\nVerifying ${name}`);
  console.log(`  Address: ${address}`);
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log(`  ✅ Verified`);
  } catch (err: any) {
    const msg: string = err.message ?? String(err);
    if (msg.includes("Already Verified") || msg.includes("already verified") || msg.includes("already been verified")) {
      console.log(`  ℹ️  Already verified`);
    } else {
      console.error(`  ❌ Failed: ${msg.slice(0, 200)}`);
    }
  }
}

async function main() {
  console.log("=== UnitFlow Predict — ArcScan Verification ===");
  console.log(`Network : ${hre.network.name}`);
  console.log(`Deployer: ${OWNER}\n`);

  // ── 1. MockUnitFlowRouter (no constructor args) ──────────────────────────
  await verify("MockUnitFlowRouter", MOCK_ROUTER, []);

  // ── 2. FeeDistributor implementation ────────────────────────────────────
  await verify("FeeDistributor (impl)", FD_IMPL, []);

  // ── 3. FeeDistributor proxy ──────────────────────────────────────────────
  const FeeDistributorFactory = await hre.ethers.getContractFactory("FeeDistributor");
  // unitToken = address(0) at deploy time (pre-UNIT launch)
  const UNIT_TOKEN = hre.ethers.ZeroAddress;
  const fdInitData = FeeDistributorFactory.interface.encodeFunctionData("initialize", [
    UNIT_ROUTER,
    TREASURY,
    LP_REWARD_POOL,
    UNIT_TOKEN,
    OWNER,
  ]);
  await verify("FeeDistributor (proxy)", FD_PROXY, [FD_IMPL, OWNER, fdInitData]);

  // ── 4. PredictOracle implementation ─────────────────────────────────────
  await verify("PredictOracle (impl)", ORACLE_IMPL, []);

  // ── 5. PredictOracle proxy ───────────────────────────────────────────────
  const OracleFactory = await hre.ethers.getContractFactory("PredictOracle");
  const oracleInitData = OracleFactory.interface.encodeFunctionData("initialize", [OWNER]);
  await verify("PredictOracle (proxy)", ORACLE_PROXY, [ORACLE_IMPL, OWNER, oracleInitData]);

  // ── 6. PredictMarketFactory implementation ───────────────────────────────
  await verify("PredictMarketFactory (impl)", FACTORY_IMPL, []);

  // ── 7. PredictMarketFactory proxy ────────────────────────────────────────
  const FactoryFactory = await hre.ethers.getContractFactory("PredictMarketFactory");
  const factoryInitData = FactoryFactory.interface.encodeFunctionData("initialize", [
    FD_PROXY,
    ORACLE_PROXY,
    USDC,
    EURC,
    OWNER,
  ]);
  await verify("PredictMarketFactory (proxy)", FACTORY_PROXY, [FACTORY_IMPL, OWNER, factoryInitData]);

  // ── 8. PredictMarket instances ───────────────────────────────────────────
  console.log("\n--- PredictMarket instances ---");

  const factory = await hre.ethers.getContractAt("PredictMarketFactory", FACTORY_PROXY);
  const marketAddresses: string[] = await factory.getAllMarkets();

  if (marketAddresses.length === 0) {
    console.log("  No markets deployed yet.");
  } else {
    console.log(`  Found ${marketAddresses.length} markets`);

    // Read constructor args for each market from getMarketInfo() + fee rates
    const PROTOCOL_FEE_RATE = 100n; // 1% — matches deploy
    const CLAIM_FEE_RATE    = 50n;  // 0.5% — matches deploy

    for (let i = 0; i < marketAddresses.length; i++) {
      const addr = marketAddresses[i];
      const market = await hre.ethers.getContractAt("PredictMarket", addr);

      let info: any;
      try {
        info = await market.getMarketInfo();
      } catch (e: any) {
        console.log(`  [${i + 1}] ${addr} — could not read info: ${e.message?.slice(0, 80)}`);
        continue;
      }

      const constructorArgs = [
        info.marketId,
        FACTORY_PROXY,
        FD_PROXY,
        info.question,
        info.description,
        info.category,
        info.tags,
        info.currency,
        info.resolutionDate,
        info.resolver,
        info.oracleSource,
        info.creator,
        PROTOCOL_FEE_RATE,
        CLAIM_FEE_RATE,
      ];

      await verify(
        `PredictMarket [${i + 1}/${marketAddresses.length}] "${info.question.slice(0, 50)}…"`,
        addr,
        constructorArgs
      );
    }
  }

  console.log("\n=== Verification complete ===");
  console.log("View on ArcScan: https://testnet.arcscan.app");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
