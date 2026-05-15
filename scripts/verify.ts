/**
 * verify.ts — Verifies all deployed contracts on ArcScan
 *
 * Usage:
 *   npx hardhat run scripts/verify.ts --network arcTestnet
 */

import hre, { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function verify(name: string, address: string, constructorArgs: unknown[]) {
  console.log(`\nVerifying ${name} at ${address}...`);
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log(`  ✅ ${name} verified`);
  } catch (err: any) {
    const msg = err.message ?? String(err);
    if (msg.toLowerCase().includes("already verified") || msg.toLowerCase().includes("already been verified")) {
      console.log(`  ℹ️  ${name} already verified`);
    } else {
      console.error(`  ❌ ${name} failed: ${msg}`);
    }
  }
}

async function main() {
  const depPath = path.join(__dirname, "../deployments.json");
  if (!fs.existsSync(depPath)) throw new Error("deployments.json not found — run deploy.ts first");

  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const c = dep.contracts;

  const OWNER = dep.deployer; // proxy admin = deployer for testnet

  // ── Encode initializer calldata for each proxy ────────────────────────────

  const FDFactory = await ethers.getContractFactory("FeeDistributor");
  const fdInit = FDFactory.interface.encodeFunctionData("initialize", [
    c.MockUnitFlowRouter,
    OWNER, // treasury
    OWNER, // lpRewardPool
    OWNER, // owner
  ]);

  const OracleFactory = await ethers.getContractFactory("PredictOracle");
  const oracleInit = OracleFactory.interface.encodeFunctionData("initialize", [OWNER]);

  const FactoryFactory = await ethers.getContractFactory("PredictMarketFactory");
  const factoryInit = FactoryFactory.interface.encodeFunctionData("initialize", [
    c.FeeDistributor.proxy,
    c.PredictOracle.proxy,
    dep.tokens.USDC,
    dep.tokens.EURC,
    OWNER,
  ]);

  // ── Verify implementations (no constructor args — _disableInitializers) ───

  await verify("MockUnitFlowRouter", c.MockUnitFlowRouter, []);
  await verify("FeeDistributor (impl)", c.FeeDistributor.impl, []);
  await verify("PredictOracle (impl)", c.PredictOracle.impl, []);
  await verify("PredictMarketFactory (impl)", c.PredictMarketFactory.impl, []);

  // ── Verify proxies (constructor: impl, admin, initData) ───────────────────

  await verify("FeeDistributor (proxy)", c.FeeDistributor.proxy, [
    c.FeeDistributor.impl,
    OWNER,
    fdInit,
  ]);

  await verify("PredictOracle (proxy)", c.PredictOracle.proxy, [
    c.PredictOracle.impl,
    OWNER,
    oracleInit,
  ]);

  await verify("PredictMarketFactory (proxy)", c.PredictMarketFactory.proxy, [
    c.PredictMarketFactory.impl,
    OWNER,
    factoryInit,
  ]);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  VERIFICATION COMPLETE");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  ArcScan: https://testnet.arcscan.app`);
  console.log(`  Factory: https://testnet.arcscan.app/address/${c.PredictMarketFactory.proxy}`);
  console.log(`  Oracle:  https://testnet.arcscan.app/address/${c.PredictOracle.proxy}`);
  console.log(`  FeeDistributor: https://testnet.arcscan.app/address/${c.FeeDistributor.proxy}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
