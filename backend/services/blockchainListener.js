// backend/services/blockchainListener.js
require("dotenv").config();

const { web3Ws, contractWs } = require("../config/web3");
const Drug = require("../models/Drug");
const AuditLog = require("../models/AuditLog");

// Compute topics using WS web3 instance
const DRUG_ADDED_TOPIC = web3Ws.utils.sha3(
  "DrugAdded(uint256,string,address)"
);

// ⚠️ Adjust the signature if your event is different in the Solidity contract
const HISTORY_UPDATED_TOPIC = web3Ws.utils.sha3(
  "HistoryUpdated(uint256,string)"
);

/**
 * Start listening to on-chain events using Alchemy WebSocket
 */
function startListening() {
  console.log(
    "✅ Blockchain event listeners starting (Sepolia via Alchemy)..."
  );
  console.log("   Contract:", contractWs.options.address);
  console.log("   DrugAdded Topic:", DRUG_ADDED_TOPIC);
  console.log("   HistoryUpdated Topic:", HISTORY_UPDATED_TOPIC);

  /**
   * =============== DrugAdded logs ===============
   */
  web3Ws.eth
    .subscribe("logs", {
      address: contractWs.options.address,
      topics: [DRUG_ADDED_TOPIC],
    })
    .on("connected", (subId) => {
      console.log("🔔 DrugAdded subscription ID:", subId);
    })
    .on("data", async (log) => {
      try {
        const decoded = web3Ws.eth.abi.decodeLog(
          [
            { type: "uint256", name: "id", indexed: false },
            { type: "string", name: "name", indexed: false },
            { type: "address", name: "manufacturer", indexed: false },
          ],
          log.data,
          log.topics.slice(1)
        );

        const { id, name, manufacturer } = decoded;

        console.log(
          `📜 DrugAdded Event Detected\n   Drug ID: ${id}, Name: ${name}, Manufacturer: ${manufacturer}`
        );

        await Drug.updateOne(
          { id: String(id) },
          {
            $setOnInsert: {
              id: String(id),
              name,
              manufacturer,
              isVerified: true,
              isFlagged: false,
            },
          },
          { upsert: true }
        );

        await new AuditLog({
          userName: manufacturer,
          action: "DrugAdded Event",
          details: `DrugAdded on-chain: ID=${id}, name=${name}`,
          txHash: log.transactionHash,
          status: "Event",
        }).save();
      } catch (err) {
        console.error("🚨 Error processing DrugAdded log:", err);
      }
    })
    .on("error", (err) => {
      console.error("🚨 Error in DrugAdded subscription:", err);
    });

  /**
   * =============== HistoryUpdated logs ===============
   */
  web3Ws.eth
    .subscribe("logs", {
      address: contractWs.options.address,
      topics: [HISTORY_UPDATED_TOPIC],
    })
    .on("connected", (subId) => {
      console.log("🔔 HistoryUpdated subscription ID:", subId);
    })
    .on("data", async (log) => {
      try {
        const decoded = web3Ws.eth.abi.decodeLog(
          [
            { type: "uint256", name: "id", indexed: false },
            { type: "string", name: "detail", indexed: false },
          ],
          log.data,
          log.topics.slice(1)
        );

        const { id, detail } = decoded;

        console.log(
          `📜 HistoryUpdated Event Detected\n   Drug ID: ${id}, Detail: ${detail}`
        );

        await new AuditLog({
          userName: "blockchain",
          action: "HistoryUpdated Event",
          details: `Drug ID: ${id}, Detail: ${detail}`,
          txHash: log.transactionHash,
          status: "Event",
        }).save();
      } catch (err) {
        console.error("🚨 Error processing HistoryUpdated log:", err);
      }
    })
    .on("error", (err) => {
      console.error("🚨 Error in HistoryUpdated subscription:", err);
    });
}

module.exports = { startListening };
