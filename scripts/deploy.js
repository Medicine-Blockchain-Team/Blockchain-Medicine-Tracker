// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  const DrugSupplyChain = await hre.ethers.getContractFactory("DrugSupplyChain");
  const contract = await DrugSupplyChain.deploy();

  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("✅ DrugSupplyChain deployed to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
