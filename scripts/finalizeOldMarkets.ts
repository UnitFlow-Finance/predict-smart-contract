/**
 * finalizeOldMarkets.ts — Phase 2 of old-market closure.
 *
 * Run this 24+ hours after closeOldMarkets.ts to push all proposed
 * resolutions through finalizeResolution(), making markets fully resolved
 * so users can call emergencyWithdraw() or claimReward().
 *
 * Usage:
 *   npx hardhat run scripts/finalizeOldMarkets.ts --network arcTestnet
 */

import { ethers } from "hardhat";
import "dotenv/config";

const OLD_FACTORY = process.env.OLD_FACTORY_ADDRESS ?? "0x7Ec112983011db79f907285daBc759643A9D8304";
const OLD_ORACLE  = process.env.OLD_ORACLE_ADDRESS  ?? "0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15";

const FACTORY_ABI = ["function getAllMarkets() external view returns (address[])"];
const ORACLE_ABI  = [
  "function finalizeResolution(address market) external",
  "function resolutions(address market) external view returns (bool proposedOutcome, uint256 proposedAt, address proposedBy, uint8 status, address disputedBy)",
  "function DISPUTE_WINDOW() external view returns (uint256)",
];
const MARKET_ABI  = ["function resolved() external view returns (bool)"];

const ResolutionStatus = { None: 0, Proposed: 1, Disputed: 2, Finalized: 3 };

async function main() {
  const [deployer] = await ethers.getSigners();
  const now = Math.floor(Date.now() / 1000);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  finalizeOldMarkets.ts — Finalize old market resolutions");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Deployer: ${deployer.address}\n`);

  const factory = new ethers.Contract(OLD_FACTORY, FACTORY_ABI, deployer);
  const oracle  = new ethers.Contract(OLD_ORACLE,  ORACLE_ABI,  deployer);

  const disputeWindow   = Number(await oracle.DISPUTE_WINDOW());
  const marketAddresses: string[] = await factory.getAllMarkets();

  console.log(`  Markets: ${marketAddresses.length} | Dispute window: ${disputeWindow / 3600}h\n`);

  let finalized = 0;
  let skipped   = 0;
  let pending   = 0;
  let failed    = 0;

  for (const addr of marketAddresses) {
    const market = new ethers.Contract(addr, MARKET_ABI, deployer);
    const alreadyResolved = await market.resolved();
    if (alreadyResolved) { skipped++; continue; }

    const res    = await oracle.resolutions(addr);
    const status = Number(res.status);

    if (status !== ResolutionStatus.Proposed) { skipped++; continue; }

    const deadline  = Number(res.proposedAt) + disputeWindow;
    const remaining = deadline - now;

    if (remaining > 0) {
      console.log(`  [WAIT] ${addr.slice(0, 10)}… — ${Math.ceil(remaining / 3600)}h remaining`);
      pending++;
      continue;
    }

    try {
      const tx = await oracle.finalizeResolution(addr);
      await tx.wait();
      console.log(`  ✓ Finalized: ${addr}`);
      finalized++;
    } catch (e: any) {
      console.error(`  ✗ Failed:    ${addr} — ${e.message?.slice(0, 80)}`);
      failed++;
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  Finalized: ${finalized} | Skipped: ${skipped} | Pending: ${pending} | Failed: ${failed}`);
  if (pending > 0) {
    console.log(`  Re-run in ${disputeWindow / 3600}h to finalize remaining markets.`);
  } else if (finalized > 0 || skipped > 0) {
    console.log("  All markets resolved. Users can now withdraw funds.");
  }
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
