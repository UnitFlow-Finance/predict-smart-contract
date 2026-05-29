/**
 * resolveAllNow.ts
 *
 * Bypasses the 24h dispute window by:
 *   1. Deploying a new PredictOracle implementation with DISPUTE_WINDOW = 0
 *   2. Upgrading the old oracle proxy to the new impl (proxy admin = deployer)
 *   3. Calling finalizeResolution() on all pending markets immediately
 *   4. Verifying every market on the old factory is resolved
 *
 * Usage:
 *   npx hardhat run scripts/resolveAllNow.ts --network arcTestnet
 */

import { ethers, upgrades } from "hardhat";
import "dotenv/config";

const OLD_FACTORY = process.env.OLD_FACTORY_ADDRESS ?? "0x7Ec112983011db79f907285daBc759643A9D8304";
const OLD_ORACLE  = process.env.OLD_ORACLE_ADDRESS  ?? "0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15";

const FACTORY_ABI = ["function getAllMarkets() external view returns (address[])"];

const ORACLE_ABI = [
  "function finalizeResolution(address market) external",
  "function proposeResolution(address market, bool outcome) external",
  "function overrideResolution(address market, bool outcome) external",
  "function resolutions(address market) external view returns (bool proposedOutcome, uint256 proposedAt, address proposedBy, uint8 status, address disputedBy)",
  "function DISPUTE_WINDOW() external view returns (uint256)",
  "function authorizedResolvers(address) external view returns (bool)",
  "function owner() external view returns (address)",
];

const MARKET_ABI = [
  "function resolved() external view returns (bool)",
  "function totalStaked() external view returns (uint256)",
];

// TransparentUpgradeableProxy admin interface
const PROXY_ADMIN_ABI = [
  "function upgradeAndCall(address proxy, address impl, bytes calldata data) external payable",
  "function upgrade(address proxy, address newImplementation) external",
  "function getProxyAdmin(address proxy) external view returns (address)",
  "function getProxyImplementation(address proxy) external view returns (address)",
];

// Minimal transparent proxy — admin slot
const TRANSPARENT_PROXY_ABI = [
  "function upgradeTo(address newImplementation) external",
  "function upgradeToAndCall(address newImplementation, bytes calldata data) external payable",
];

const S = { None: 0, Proposed: 1, Disputed: 2, Finalized: 3 };

async function main() {
  const [deployer] = await ethers.getSigners();
  const now = Math.floor(Date.now() / 1000);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  resolveAllNow — instant resolution of all old markets");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Old Factory: ${OLD_FACTORY}`);
  console.log(`  Old Oracle:  ${OLD_ORACLE}\n`);

  const factory = new ethers.Contract(OLD_FACTORY, FACTORY_ABI, deployer);
  const oracle  = new ethers.Contract(OLD_ORACLE,  ORACLE_ABI,  deployer);

  // ── Step 1: Deploy new oracle impl with DISPUTE_WINDOW = 0 ───────────────
  console.log("── Step 1: Deploy PredictOracleInstant implementation ─");
  const OracleInstant = await ethers.getContractFactory("PredictOracleInstant", deployer);
  const newImpl = await OracleInstant.deploy();
  await newImpl.waitForDeployment();
  const newImplAddr = await newImpl.getAddress();
  console.log(`  New impl deployed: ${newImplAddr}`);

  // ── Step 2: Upgrade old oracle proxy ─────────────────────────────────────
  console.log("\n── Step 2: Upgrade old oracle proxy ──────────────────");

  // The TransparentUpgradeableProxy stores the admin in a special slot.
  // When deployed with `new TransparentUpgradeableProxy(impl, admin, data)`,
  // the admin is stored and only the admin can call upgrade functions.
  // We use the hardhat-upgrades plugin to handle this cleanly.
  try {
    const upgraded = await upgrades.upgradeProxy(OLD_ORACLE, OracleInstant, {
      kind: "transparent",
      unsafeSkipStorageLayoutCheck: true, // same storage layout, just DISPUTE_WINDOW changes
    });
    await upgraded.waitForDeployment();
    console.log(`  ✓ Proxy upgraded to new impl`);
  } catch (upgradeErr: any) {
    // Fallback: call upgradeTo directly if the deployer is the proxy admin
    console.log(`  upgrades.upgradeProxy failed (${upgradeErr.message?.slice(0, 60)})`);
    console.log("  Trying direct upgradeTo on proxy…");

    const proxyAsAdmin = new ethers.Contract(OLD_ORACLE, TRANSPARENT_PROXY_ABI, deployer);
    try {
      const tx = await proxyAsAdmin.upgradeTo(newImplAddr);
      await tx.wait();
      console.log(`  ✓ upgradeTo succeeded — tx: ${tx.hash}`);
    } catch (directErr: any) {
      console.error(`  ✗ Direct upgrade also failed: ${directErr.message?.slice(0, 120)}`);
      console.log("\n  Trying via ProxyAdmin contract…");

      // Try to find and use the ProxyAdmin
      // OZ TransparentUpgradeableProxy auto-deploys a ProxyAdmin owned by the admin address
      const proxyAdminAddr = await getProxyAdminAddress(OLD_ORACLE, deployer);
      if (proxyAdminAddr) {
        console.log(`  ProxyAdmin found at: ${proxyAdminAddr}`);
        const proxyAdmin = new ethers.Contract(proxyAdminAddr, PROXY_ADMIN_ABI, deployer);
        const tx = await proxyAdmin.upgrade(OLD_ORACLE, newImplAddr);
        await tx.wait();
        console.log(`  ✓ Upgraded via ProxyAdmin — tx: ${tx.hash}`);
      } else {
        throw new Error("Cannot upgrade proxy — no admin access found");
      }
    }
  }

  // Verify new DISPUTE_WINDOW
  const newOracle = new ethers.Contract(OLD_ORACLE, ORACLE_ABI, deployer);
  const dw = await newOracle.DISPUTE_WINDOW().catch(() => "N/A");
  console.log(`  DISPUTE_WINDOW after upgrade: ${dw}s`);

  // ── Step 3: Fetch all markets and their state ─────────────────────────────
  console.log("\n── Step 3: Read all market states (parallel) ─────────");
  const marketAddresses: string[] = await factory.getAllMarkets();
  console.log(`  Total markets: ${marketAddresses.length}`);

  const [resolvedArr, resolutionsArr] = await Promise.all([
    Promise.all(marketAddresses.map((a) =>
      new ethers.Contract(a, MARKET_ABI, deployer).resolved().catch(() => false)
    )),
    Promise.all(marketAddresses.map((a) =>
      newOracle.resolutions(a).catch(() => ({ status: 0, proposedAt: 0 }))
    )),
  ]);

  const toPropose:  string[] = [];
  const toOverride: string[] = [];
  const toFinalize: string[] = [];
  let alreadyDone = 0;

  for (let i = 0; i < marketAddresses.length; i++) {
    const addr   = marketAddresses[i];
    const status = Number(resolutionsArr[i].status);
    if (resolvedArr[i] || status === S.Finalized) { alreadyDone++; }
    else if (status === S.Disputed)  { toOverride.push(addr); }
    else if (status === S.Proposed)  { toFinalize.push(addr); } // window is now 0 — ready immediately
    else                             { toPropose.push(addr); }
  }

  console.log(`  Already done:   ${alreadyDone}`);
  console.log(`  Need proposal:  ${toPropose.length}`);
  console.log(`  Need override:  ${toOverride.length}`);
  console.log(`  Ready finalize: ${toFinalize.length}`);

  // ── Step 4: Propose any remaining unproposed markets ─────────────────────
  if (toPropose.length > 0) {
    console.log(`\n── Step 4a: Proposing ${toPropose.length} markets ────────────────`);
    for (const addr of toPropose) {
      try {
        const tx = await newOracle.proposeResolution(addr, false);
        await tx.wait();
        console.log(`  ✓ proposed: ${addr.slice(0, 10)}…`);
        toFinalize.push(addr); // immediately finalizable since window = 0
      } catch (e: any) {
        console.error(`  ✗ propose failed ${addr.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
      }
    }
  }

  // ── Step 5: Override disputed markets ────────────────────────────────────
  if (toOverride.length > 0) {
    console.log(`\n── Step 4b: Overriding ${toOverride.length} disputed markets ──────────`);
    for (const addr of toOverride) {
      try {
        const tx = await newOracle.overrideResolution(addr, false);
        await tx.wait();
        console.log(`  ✓ overridden: ${addr.slice(0, 10)}…`);
      } catch (e: any) {
        console.error(`  ✗ override failed ${addr.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
      }
    }
  }

  // ── Step 6: Finalize all proposed markets (window = 0, all ready now) ────
  if (toFinalize.length > 0) {
    console.log(`\n── Step 5: Finalizing ${toFinalize.length} markets ──────────────────`);
    let finalized = 0;
    let failed    = 0;
    for (const addr of toFinalize) {
      try {
        const tx = await newOracle.finalizeResolution(addr);
        await tx.wait();
        finalized++;
        process.stdout.write(`\r  Finalized: ${finalized}/${toFinalize.length}`);
      } catch (e: any) {
        failed++;
        console.error(`\n  ✗ finalize failed ${addr.slice(0, 10)}: ${e.message?.slice(0, 80)}`);
      }
    }
    console.log(`\n  Done — finalized: ${finalized}, failed: ${failed}`);
  }

  // ── Step 7: Verify all resolved ──────────────────────────────────────────
  console.log("\n── Step 6: Verifying all markets resolved ─────────────");
  const resolvedCheck = await Promise.all(
    marketAddresses.map((a) =>
      new ethers.Contract(a, MARKET_ABI, deployer).resolved().catch(() => false)
    )
  );
  const totalResolved = resolvedCheck.filter(Boolean).length;
  const totalUnresolved = resolvedCheck.length - totalResolved;

  console.log(`  Resolved:   ${totalResolved}/${marketAddresses.length}`);
  if (totalUnresolved > 0) {
    console.log(`  ⚠ Unresolved: ${totalUnresolved}`);
    marketAddresses.forEach((a, i) => {
      if (!resolvedCheck[i]) console.log(`    - ${a}`);
    });
  }

  console.log("\n═══════════════════════════════════════════════════════");
  if (totalUnresolved === 0) {
    console.log("  ✓ ALL MARKETS RESOLVED");
    console.log("  Users can now call emergencyWithdraw() or claimReward()");
    console.log("  on any old market to recover their funds.");
  } else {
    console.log(`  ⚠ ${totalUnresolved} markets still unresolved — check errors above`);
  }
  console.log("═══════════════════════════════════════════════════════");
}

// Read the EIP-1967 admin slot to find the ProxyAdmin address
async function getProxyAdminAddress(proxyAddr: string, provider: any): Promise<string | null> {
  try {
    // EIP-1967 admin slot: keccak256("eip1967.proxy.admin") - 1
    const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
    const raw = await provider.provider.getStorage(proxyAddr, adminSlot);
    const addr = "0x" + raw.slice(-40);
    if (addr === "0x" + "0".repeat(40)) return null;
    return ethers.getAddress(addr);
  } catch {
    return null;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
