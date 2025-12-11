// backend/config/web3.js
require("dotenv").config();
const Web3 = require("web3");
const path = require("path");

// ================= ENV =================
const {
  SEPOLIA_RPC_URL,
  SEPOLIA_WS_URL,
  SEPOLIA_PRIVATE_KEY,
  CONTRACT_ADDRESS,
} = process.env;

// ================= SAFETY CHECKS =================
if (!SEPOLIA_RPC_URL) throw new Error("Missing SEPOLIA_RPC_URL in .env");
if (!SEPOLIA_WS_URL) throw new Error("Missing SEPOLIA_WS_URL in .env");
if (!SEPOLIA_PRIVATE_KEY) throw new Error("Missing SEPOLIA_PRIVATE_KEY in .env");
if (!CONTRACT_ADDRESS) throw new Error("Missing CONTRACT_ADDRESS in .env");

// ================= PROVIDERS =================
const web3Http = new Web3(
  new Web3.providers.HttpProvider(SEPOLIA_RPC_URL)
);

const web3Ws = new Web3(
  new Web3.providers.WebsocketProvider(SEPOLIA_WS_URL)
);

// ================= LOAD CONTRACT ABI =================
const contractJson = require(
  path.join(
    __dirname,
    "../../artifacts/contracts/DrugSupplyChain.sol/DrugSupplyChain.json"
  )
);

const CONTRACT_ABI = contractJson.abi;

// ================= CONTRACT INSTANCES =================
const contractHttp = new web3Http.eth.Contract(
  CONTRACT_ABI,
  CONTRACT_ADDRESS
);

const contractWs = new web3Ws.eth.Contract(
  CONTRACT_ABI,
  CONTRACT_ADDRESS
);

// ================= SERVER SIGNER =================
let serverAccount;

try {
  const account = web3Http.eth.accounts.wallet.add(SEPOLIA_PRIVATE_KEY);
  serverAccount = account.address;
  web3Http.eth.defaultAccount = serverAccount;

  console.log("✅ Server wallet loaded:", serverAccount);
} catch (err) {
  console.error("❌ Failed to load server wallet:", err.message);
}

// ================= CONNECTION LOGS =================
web3Ws.eth.net
  .isListening()
  .then(() => console.log("✅ Alchemy WS connected"))
  .catch((err) => console.error("❌ WS connection failed:", err.message));

module.exports = {
  web3Http,      // use in routes (send tx)
  web3Ws,        // use in listener (events)
  contractHttp,  // routes
  contractWs,    // blockchainListener
  serverAccount, // backend signer address
};
