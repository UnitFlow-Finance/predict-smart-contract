import { ethers } from "hardhat";
async function main() {
  const [deployer] = await ethers.getSigners();
  const usdc = await ethers.getContractAt("MockERC20", "0x3600000000000000000000000000000000000000");
  const eurc = await ethers.getContractAt("MockERC20", "0x89b50855aa3be2f677cd6303cec089b5f319d72a");
  const usdcBal = await usdc.balanceOf(deployer.address);
  const eurcBal = await eurc.balanceOf(deployer.address);
  console.log("Deployer:", deployer.address);
  console.log("USDC:", ethers.formatUnits(usdcBal, 6));
  console.log("EURC:", ethers.formatUnits(eurcBal, 6));
  // Try mint
  try {
    const mintTx = await usdc.mint(deployer.address, ethers.parseUnits("500000", 6));
    await mintTx.wait();
    console.log("Minted 500k USDC");
  } catch(e: any) { console.log("USDC mint failed:", e.message?.slice(0,80)); }
  try {
    const mintTx = await eurc.mint(deployer.address, ethers.parseUnits("200000", 6));
    await mintTx.wait();
    console.log("Minted 200k EURC");
  } catch(e: any) { console.log("EURC mint failed:", e.message?.slice(0,80)); }
  console.log("USDC after:", ethers.formatUnits(await usdc.balanceOf(deployer.address), 6));
  console.log("EURC after:", ethers.formatUnits(await eurc.balanceOf(deployer.address), 6));
}
main().catch(console.error);
