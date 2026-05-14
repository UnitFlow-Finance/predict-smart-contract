/**
 * verifyContracts.ts
 *
 * Verifies all four proxy contracts and their implementation contracts on ArcScan.
 * Reads deployed addresses from environment variables set after running PredictDeploy.
 *
 * Usage:
 *   npx hardhat run scripts/verifyContracts.ts --network arcTestnet
 *
 * Required env:
 *   FEE_DISTRIBUTOR_PROXY    — FeeDistributor proxy address
 *   FEE_DISTRIBUTOR_IMPL     — FeeDistributor implementation address
 *   ORACLE_PROXY             — PredictOracle proxy address
 *   ORACLE_IMPL              — PredictOracle implementation address
 *   FACTORY_PROXY            — PredictMarketFactory proxy address
 *   FACTORY_IMPL             — PredictMarketFactory implementation address
 *   OWNER_ADDRESS            — ProxyAdmin owner (Gnosis Safe)
 *   UNIT_ROUTER_ADDRESS      — UnitFlow router
 *   TREASURY_ADDRESS         — Treasury multisig
 *   LP_REWARD_POOL_ADDRESS   — LP reward pool
 *   USDC_ADDRESS             — USDC on Arc
 *   EURC_ADDRESS             — EURC on Arc
 *   ADMIN_RESOLVER_ADDRESS   — Initial resolver
 */

import hre from "hardhat";
import "dotenv/config";

interface ContractVerification {
  name: string;
  address: string;
  constructorArgs: unknown[];
}

async function verify(name: string, address: string, constructorArgs: unknown[]) {
  console.log(`\nVerifying ${name} at ${address}...`);
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log(`  ✅ ${name} verified`);
  } catch (err: any) {
    if (err.message?.includes("Already Verified") || err.message?.includes("already verified")) {
      console.log(`  ℹ️  ${name} already verified`);
    } else {
      console.error(`  ❌ ${name} verification failed:`, err.message);
    }
  }
}

async function main() {
  const {
    FEE_DISTRIBUTOR_PROXY,
    FEE_DISTRIBUTOR_IMPL,
    ORACLE_PROXY,
    ORACLE_IMPL,
    FACTORY_PROXY,
    FACTORY_IMPL,
    OWNER_ADDRESS,
    UNIT_ROUTER_ADDRESS,
    TREASURY_ADDRESS,
    LP_REWARD_POOL_ADDRESS,
    USDC_ADDRESS,
    EURC_ADDRESS,
  } = process.env;

  const required = [
    "FEE_DISTRIBUTOR_PROXY", "FEE_DISTRIBUTOR_IMPL",
    "ORACLE_PROXY", "ORACLE_IMPL",
    "FACTORY_PROXY", "FACTORY_IMPL",
    "OWNER_ADDRESS", "UNIT_ROUTER_ADDRESS",
    "TREASURY_ADDRESS", "LP_REWARD_POOL_ADDRESS",
    "USDC_ADDRESS", "EURC_ADDRESS",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }

  // ─── Encode initializer calldata for proxy constructor args ─────────────────

  const FeeDistributorFactory = await hre.ethers.getContractFactory("FeeDistributor");
  const fdInitData = FeeDistributorFactory.interface.encodeFunctionData("initialize", [
    UNIT_ROUTER_ADDRESS,
    TREASURY_ADDRESS,
    LP_REWARD_POOL_ADDRESS,
    OWNER_ADDRESS,
  ]);

  const OracleFactory = await hre.ethers.getContractFactory("PredictOracle");
  const oracleInitData = OracleFactory.interface.encodeFunctionData("initialize", [
    OWNER_ADDRESS,
  ]);

  const FactoryFactory = await hre.ethers.getContractFactory("PredictMarketFactory");
  const factoryInitData = FactoryFactory.interface.encodeFunctionData("initialize", [
    FEE_DISTRIBUTOR_PROXY,
    ORACLE_PROXY,
    USDC_ADDRESS,
    EURC_ADDRESS,
    OWNER_ADDRESS,
  ]);

  // ─── Verify implementations (no constructor args — they disable initializers) ─

  await verify("FeeDistributor (impl)", FEE_DISTRIBUTOR_IMPL!, []);
  await verify("PredictOracle (impl)", ORACLE_IMPL!, []);
  await verify("PredictMarketFactory (impl)", FACTORY_IMPL!, []);

  // ─── Verify proxies (constructor: impl, admin, initData) ────────────────────

  await verify("FeeDistributor (proxy)", FEE_DISTRIBUTOR_PROXY!, [
    FEE_DISTRIBUTOR_IMPL,
    OWNER_ADDRESS,
    fdInitData,
  ]);

  await verify("PredictOracle (proxy)", ORACLE_PROXY!, [
    ORACLE_IMPL,
    OWNER_ADDRESS,
    oracleInitData,
  ]);

  await verify("PredictMarketFactory (proxy)", FACTORY_PROXY!, [
    FACTORY_IMPL,
    OWNER_ADDRESS,
    factoryInitData,
  ]);

  console.log("\n✅ All contracts submitted for verification on ArcScan.");
  console.log(`   Browser: https://testnet.arcscan.app`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
