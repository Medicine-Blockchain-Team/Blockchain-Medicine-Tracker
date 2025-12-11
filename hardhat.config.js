require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "./.env" });

module.exports = {
  solidity: "0.8.28",
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL,
      accounts: process.env.SEPOLIA_PRIVATE_KEY ? [process.env.SEPOLIA_PRIVATE_KEY] : [],
    },
  },
};
