/**
 * deploy.ts — Full deployment script for Arc Testnet
 *
 * Deploys in order:
 *   1. MockUnitFlowRouter (testnet only — replace with real router on mainnet)
 *   2. FeeDistributor (TransparentUpgradeableProxy)
 *   3. PredictOracle  (TransparentUpgradeableProxy)
 *   4. PredictMarketFactory (TransparentUpgradeableProxy)
 *   5. Post-deploy wiring: grantCallerRole, authorizeMarket(factory)
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network arcTestnet
 */

import { ethers } from "hardhat";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const USDC    = process.env.USDC_ADDRESS!;
const EURC    = process.env.EURC_ADDRESS!;
const OWNER   = process.env.OWNER_ADDRESS!;
const TREASURY = process.env.TREASURY_ADDRESS!;
const LP_POOL  = process.env.LP_REWARD_POOL_ADDRESS!;
const RESOLVER = process.env.ADMIN_RESOLVER_ADDRESS!;

async function deployProxy(
  contractName: string,
  initArgs: unknown[],
  deployer: any
): Promise<{ proxy: string; impl: string }> {
  console.log(`\nDeploying ${contractName}...`);

  const Impl = await ethers.getContractFactory(contractName, deployer);
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`  Implementation: ${implAddr}`);

  const Proxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy",
    deployer
  );
  const initData = Impl.interface.encodeFunctionData("initialize", initArgs);
  const proxy = await Proxy.deploy(implAddr, OWNER, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`  Proxy:          ${proxyAddr}`);

  return { proxy: proxyAddr, impl: implAddr };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network:  ${(await ethers.provider.getNetwork()).name} (chainId: ${(await ethers.provider.getNetwork()).chainId})`);

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(bal)} ETH`);

  if (!USDC || !EURC || !OWNER || !TREASURY || !LP_POOL || !RESOLVER) {
    throw new Error("Missing required env vars. Check .env file.");
  }

  // ── 1. MockUnitFlowRouter (testnet only) ─────────────────────────────────
  console.log("\nDeploying MockUnitFlowRouter (testnet stub)...");
  const RouterFactory = await ethers.getContractFactory("MockUnitFlowRouter", deployer);
  const router = await RouterFactory.deploy();
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log(`  MockUnitFlowRouter: ${routerAddr}`);

  // ── 2. FeeDistributor ────────────────────────────────────────────────────
  // initialize(router, treasury, lpRewardPool, unitToken, owner)
  // unitToken = address(0) → manual buyback mode until UNIT is live on Arc
  const fd = await deployProxy("FeeDistributor", [routerAddr, TREASURY, LP_POOL, ethers.ZeroAddress, OWNER], deployer);

  // ── 3. PredictOracle ─────────────────────────────────────────────────────
  const oracle = await deployProxy("PredictOracle", [OWNER], deployer);

  // ── 4. PredictMarketFactory ──────────────────────────────────────────────
  const factory = await deployProxy(
    "PredictMarketFactory",
    [fd.proxy, oracle.proxy, USDC, EURC, OWNER],
    deployer
  );

  // ── 5. Post-deploy wiring ────────────────────────────────────────────────
  console.log("\nWiring contracts...");

  const FeeDistributorFactory = await ethers.getContractFactory("FeeDistributor", deployer);
  const fdContract = FeeDistributorFactory.attach(fd.proxy);

  // Allow factory to call authorizeMarket on FeeDistributor
  let tx = await fdContract.grantCallerRole(factory.proxy);
  await tx.wait();
  console.log(`  grantCallerRole(factory) ✓`);

  // Allow factory to call receiveFee (for creation fees)
  tx = await fdContract.authorizeMarket(factory.proxy);
  await tx.wait();
  console.log(`  authorizeMarket(factory) ✓`);

  // Add admin resolver to oracle
  const OracleFactory = await ethers.getContractFactory("PredictOracle", deployer);
  const oracleContract = OracleFactory.attach(oracle.proxy);
  tx = await oracleContract.addResolver(RESOLVER);
  await tx.wait();
  console.log(`  addResolver(${RESOLVER}) ✓`);

  // ── 6. Save deployment addresses ─────────────────────────────────────────
  const deployment = {
    network: "arcTestnet",
    chainId: 5042002,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    tokens: { USDC, EURC },
    contracts: {
      MockUnitFlowRouter: routerAddr,
      FeeDistributor: { proxy: fd.proxy, impl: fd.impl },
      PredictOracle:  { proxy: oracle.proxy, impl: oracle.impl },
      PredictMarketFactory: { proxy: factory.proxy, impl: factory.impl },
    },
  };

  const outPath = path.join(__dirname, "../deployments.json");
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to deployments.json`);

  // ── 7. Print summary ─────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  DEPLOYMENT COMPLETE — Arc Testnet");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  MockUnitFlowRouter:       ${routerAddr}`);
  console.log(`  FeeDistributor (proxy):   ${fd.proxy}`);
  console.log(`  FeeDistributor (impl):    ${fd.impl}`);
  console.log(`  PredictOracle (proxy):    ${oracle.proxy}`);
  console.log(`  PredictOracle (impl):     ${oracle.impl}`);
  console.log(`  PredictMarketFactory (proxy): ${factory.proxy}`);
  console.log(`  PredictMarketFactory (impl):  ${factory.impl}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`\n  ArcScan: https://testnet.arcscan.app/address/${factory.proxy}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
