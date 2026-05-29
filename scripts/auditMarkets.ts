import { ethers } from "hardhat";
import "dotenv/config";

const OLD_FACTORY = "0x7Ec112983011db79f907285daBc759643A9D8304";
const OLD_ORACLE  = "0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15";

const FACTORY_ABI = ["function getAllMarkets() external view returns (address[])"];
const MARKET_ABI  = [
  "function resolved() external view returns (bool)",
  "function totalStaked() external view returns (uint256)",
  "function getMarketInfo() external view returns (tuple(bytes32 marketId, string question, string description, string category, string[] tags, address currency, uint256 resolutionDate, address resolver, string oracleSource, address creator, uint256 createdAt))",
];
const ORACLE_ABI = [
  "function resolutions(address) external view returns (bool proposedOutcome, uint256 proposedAt, address proposedBy, uint8 status, address disputedBy)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const now = Math.floor(Date.now() / 1000);
  const factory = new ethers.Contract(OLD_FACTORY, FACTORY_ABI, deployer);
  const oracle  = new ethers.Contract(OLD_ORACLE,  ORACLE_ABI,  deployer);
  const addrs: string[] = await factory.getAllMarkets();

  console.log(`Total markets: ${addrs.length}\nReading state…`);

  const [resolvedArr, infoArr, stakedArr, resArr] = await Promise.all([
    Promise.all(addrs.map(a => new ethers.Contract(a, MARKET_ABI, deployer).resolved().catch(() => false))),
    Promise.all(addrs.map(a => new ethers.Contract(a, MARKET_ABI, deployer).getMarketInfo().catch(() => null))),
    Promise.all(addrs.map(a => new ethers.Contract(a, MARKET_ABI, deployer).totalStaked().catch(() => 0n))),
    Promise.all(addrs.map(a => oracle.resolutions(a).catch(() => ({ status: 0 })))),
  ]);

  let resolvedCount = 0, pastDate = 0, futureDate = 0, withStake = 0;
  let totalStakeLocked = 0n;

  for (let i = 0; i < addrs.length; i++) {
    const info   = infoArr[i];
    const staked = stakedArr[i] as bigint;
    const resDate = info ? Number(info.resolutionDate) : 0;
    const isPast  = now >= resDate;

    if (resolvedArr[i]) { resolvedCount++; continue; }
    if (isPast) pastDate++; else futureDate++;
    if (staked > 0n) { withStake++; totalStakeLocked += staked; }
  }

  console.log(`\nResolved:              ${resolvedCount}`);
  console.log(`Unresolved past date:  ${pastDate}  ← can resolve now`);
  console.log(`Unresolved future date:${futureDate} ← blocked by resolutionDate`);
  console.log(`With stake (unresolved):${withStake}`);
  console.log(`Total stake locked:    ${ethers.formatUnits(totalStakeLocked, 6)} USDC/EURC`);

  // Show future-date markets with stake
  console.log("\nFuture-date markets with stake:");
  for (let i = 0; i < addrs.length; i++) {
    if (resolvedArr[i]) continue;
    const info   = infoArr[i];
    const staked = stakedArr[i] as bigint;
    const resDate = info ? Number(info.resolutionDate) : 0;
    if (now < resDate && staked > 0n) {
      console.log(`  ${addrs[i].slice(0,10)}… staked:${ethers.formatUnits(staked,6)} date:${new Date(resDate*1000).toISOString().slice(0,10)} "${info?.question?.slice(0,50)}"`);
    }
  }
}
main().catch(console.error);
