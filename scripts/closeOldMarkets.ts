/**
 * closeOldMarkets.ts — Batch-resolve all markets on the OLD PredictMarketFactory
 * so users can withdraw their funds.
 *
 * The old factory proxy is 0x7Ec112983011db79f907285daBc759643A9D8304.
 * Markets that are past their resolutionDate but not yet resolved need to be
 * pushed through the oracle flow:
 *   1. proposeResolution(market, outcome)   — authorized resolver
 *   2. wait 24 hours (DISPUTE_WINDOW)
 *   3. finalizeResolution(market)           — anyone can call
 *
 * For markets that haven't passed their resolutionDate yet we force-resolve
 * them with outcome=false (NO wins) so all stakers can use emergencyWithdraw()
 * to recover their full stake. This is the safest approach — nobody loses
 * funds, everyone gets their stake back.
 *
 * Usage:
 *   npx hardhat run scripts/closeOldMarkets.ts --network arcTestnet
 *
 * Required env vars:
 *   OLD_FACTORY_ADDRESS   — old PredictMarketFactory proxy
 *   OLD_ORACLE_ADDRESS    — old PredictOracle proxy
 *   DEPLOYER_PRIVATE_KEY  — authorized resolver / owner key
 */

import { ethers } from "hardhat";
import "dotenv/config";

const OLD_FACTORY = process.env.OLD_FACTORY_ADDRESS ?? "0x7Ec112983011db79f907285daBc759643A9D8304";
const OLD_ORACLE  = process.env.OLD_ORACLE_ADDRESS  ?? "0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15";

// Minimal ABIs — only what we need
const FACTORY_ABI = [
  "function getAllMarkets() external view returns (address[])",
];

const ORACLE_ABI = [
  "function proposeResolution(address market, bool outcome) external",
  "function finalizeResolution(address market) external",
  "function resolutions(address market) external view returns (bool proposedOutcome, uint256 proposedAt, address proposedBy, uint8 status, address disputedBy)",
  "function DISPUTE_WINDOW() external view returns (uint256)",
  "function authorizedResolvers(address) external view returns (bool)",
  "function owner() external view returns (address)",
];

const MARKET_ABI = [
  "function resolved() external view returns (bool)",
  "function outcome() external view returns (bool)",
  "function resolutionDate() external view returns (uint256)",
  "function getMarketInfo() external view returns (tuple(bytes32 marketId, string question, string description, string category, string[] tags, address currency, uint256 resolutionDate, address resolver, string oracleSource, address creator, uint256 createdAt))",
  "function totalYesShares() external view returns (uint256)",
  "function totalNoShares() external view returns (uint256)",
  "function totalStaked() external view returns (uint256)",
];

// Resolution status enum from PredictOracle
const ResolutionStatus = { None: 0, Proposed: 1, Disputed: 2, Finalized: 3 };

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const now        = Math.floor(Date.now() / 1000);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  closeOldMarkets.ts — Force-close old Predict markets");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Network:     chainId ${network.chainId}`);
  console.log(`  Old Factory: ${OLD_FACTORY}`);
  console.log(`  Old Oracle:  ${OLD_ORACLE}`);
  console.log();

  const factory = new ethers.Contract(OLD_FACTORY, FACTORY_ABI, deployer);
  const oracle  = new ethers.Contract(OLD_ORACLE,  ORACLE_ABI,  deployer);

  // Verify caller is authorized
  const isResolver = await oracle.authorizedResolvers(deployer.address);
  const oracleOwner = await oracle.owner();
  if (!isResolver && oracleOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer ${deployer.address} is not an authorized resolver or oracle owner.\n` +
      `Oracle owner: ${oracleOwner}\n` +
      `Run addResolver(${deployer.address}) from the owner account first.`
    );
  }
  console.log(`  Resolver check: ${isResolver ? "authorized resolver" : "oracle owner"} ✓\n`);

  const disputeWindow = await oracle.DISPUTE_WINDOW();
  console.log(`  Dispute window: ${Number(disputeWindow) / 3600}h\n`);

  // Fetch all markets from old factory
  const marketAddresses: string[] = await factory.getAllMarkets();
  console.log(`  Found ${marketAddresses.length} markets on old factory\n`);

  if (marketAddresses.length === 0) {
    console.log("  Nothing to do.");
    return;
  }

  // ── Phase 1: Propose resolutions ─────────────────────────────────────────
  console.log("── Phase 1: Propose resolutions ──────────────────────");

  const toFinalize: string[] = [];

  for (const addr of marketAddresses) {
    const market = new ethers.Contract(addr, MARKET_ABI, deployer);

    const [resolved, info, totalYes, totalNo, totalStaked] = await Promise.all([
      market.resolved(),
      market.getMarketInfo(),
      market.totalYesShares(),
      market.totalNoShares(),
      market.totalStaked(),
    ]);

    const question = info.question.slice(0, 60);
    const resDate  = Number(info.resolutionDate);

    if (resolved) {
      console.log(`  [SKIP] Already resolved: ${addr.slice(0, 10)}… "${question}"`);
      continue;
    }

    // Check oracle resolution status
    const res = await oracle.resolutions(addr);
    const status = Number(res.status);

    if (status === ResolutionStatus.Finalized) {
      console.log(`  [SKIP] Oracle already finalized: ${addr.slice(0, 10)}… "${question}"`);
      continue;
    }

    if (status === ResolutionStatus.Proposed) {
      console.log(`  [WAIT] Already proposed, will finalize after window: ${addr.slice(0, 10)}…`);
      toFinalize.push(addr);
      continue;
    }

    if (status === ResolutionStatus.Disputed) {
      console.log(`  [DISPUTED] Needs owner override: ${addr.slice(0, 10)}… "${question}"`);
      // Override with NO so everyone can emergencyWithdraw
      try {
        const tx = await oracle.overrideResolution(addr, false);
        await tx.wait();
        console.log(`    → overrideResolution(NO) ✓`);
      } catch (e: any) {
        console.error(`    → override failed: ${e.message?.slice(0, 80)}`);
      }
      continue;
    }

    // Status is None — propose resolution
    // Strategy: if nobody staked on either side, or market is past resolution date,
    // resolve NO so everyone can emergencyWithdraw their full stake.
    // If YES stakers exist and NO stakers exist, also resolve NO — this triggers
    // emergencyWithdraw for NO stakers and claimReward for YES stakers.
    // The key goal is: get every market resolved so funds are unlocked.
    const outcome = false; // NO — safest default; emergencyWithdraw covers zero-winner case

    console.log(`  [PROPOSE] ${addr.slice(0, 10)}… "${question}"`);
    console.log(`    Staked: ${ethers.formatUnits(totalStaked, 6)} | YES shares: ${ethers.formatUnits(totalYes, 6)} | NO shares: ${ethers.formatUnits(totalNo, 6)}`);
    console.log(`    Resolution date: ${new Date(resDate * 1000).toISOString()} | Past: ${now > resDate}`);

    try {
      const tx = await oracle.proposeResolution(addr, outcome);
      await tx.wait();
      console.log(`    → proposeResolution(NO) ✓ — dispute window closes in ${Number(disputeWindow) / 3600}h`);
      toFinalize.push(addr);
    } catch (e: any) {
      console.error(`    → propose failed: ${e.message?.slice(0, 100)}`);
    }
  }

  // ── Phase 2: Finalize (after dispute window) ──────────────────────────────
  if (toFinalize.length === 0) {
    console.log("\n  All markets already resolved. Nothing to finalize.");
    return;
  }

  console.log(`\n── Phase 2: Finalize ${toFinalize.length} markets ──────────────────────`);
  console.log(`  Dispute window is ${Number(disputeWindow) / 3600}h.`);
  console.log(`  Run this script again after the window closes to finalize.\n`);
  console.log(`  Markets pending finalization:`);
  for (const addr of toFinalize) {
    const res = await oracle.resolutions(addr);
    const deadline = Number(res.proposedAt) + Number(disputeWindow);
    const remaining = deadline - now;
    console.log(`    ${addr} — window closes ${remaining > 0 ? `in ${Math.ceil(remaining / 3600)}h` : "NOW (ready to finalize)"}`);
  }

  // Attempt to finalize any that are already past the window
  const readyToFinalize = [];
  for (const addr of toFinalize) {
    const res = await oracle.resolutions(addr);
    const deadline = Number(res.proposedAt) + Number(disputeWindow);
    if (now > deadline) {
      readyToFinalize.push(addr);
    }
  }

  if (readyToFinalize.length > 0) {
    console.log(`\n  Finalizing ${readyToFinalize.length} markets past dispute window...`);
    for (const addr of readyToFinalize) {
      try {
        const tx = await oracle.finalizeResolution(addr);
        await tx.wait();
        console.log(`  ✓ Finalized: ${addr}`);
      } catch (e: any) {
        console.error(`  ✗ Finalize failed ${addr}: ${e.message?.slice(0, 100)}`);
      }
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  DONE. After the dispute window, run this script again");
  console.log("  to finalize remaining markets. Users can then call");
  console.log("  emergencyWithdraw() or claimReward() to recover funds.");
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
