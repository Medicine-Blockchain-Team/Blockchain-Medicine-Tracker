const express = require("express");
const router = express.Router();

const Drug = require("../models/Drug");
const AuditLog = require("../models/AuditLog");
const { ensureLoggedIn, requireRole } = require("../middleware/auth");

// IMPORTANT: import web3 + contract here so .send(...) and .eth.getAccounts() work
const { web3Http, contractHttp, serverAccount } = require("../config/web3");

// Helper: consistent username / display name
function getUserName(user) {
  return user.username || user.name;
}

// Utility middleware for multiple roles
function requireAnyRole(...roles) {
  return (req, res, next) => {
    if (req.session?.user && roles.includes(req.session.user.role)) {
      next();
    } else {
      res.status(403).json({ error: "Forbidden" });
    }
  };
}

/**
 * =========================
 *  ADD DRUG (MANUFACTURER)
 * =========================
 */
router.post(
  "/add",
  ensureLoggedIn,
  requireRole("manufacturer"),
  async (req, res) => {
    const { id, name } = req.body;
    const user = req.session.user;
    const manufacturer = getUserName(user);

    try {
      // prefer user's walletAddress, else first unlocked account, else serverAccount fallback
      const sender =
        user.walletAddress ||
        (await web3Http.eth.getAccounts())[0] ||
        serverAccount;
      console.log("DEBUG Add drug sender:", sender);
      if (!sender) throw new Error("Sender wallet address not found.");

      const tx = await contractHttp.methods
        .addDrug(id, name)
        .send({ from: sender, gas: 3000000 });

      await Drug.updateOne(
        { id },
        {
          $set: {
            id,
            name,
            manufacturer,
            currentHolder: manufacturer,
            currentHolderRole: "manufacturer",
            status: "Manufactured",
            isVerified: true,
            isFlagged: false,
          },
          $push: {
            history: {
              status: "Manufactured",
              updatedBy: "manufacturer",
              owner: manufacturer,
              timestamp: Date.now(),
            },
          },
        },
        { upsert: true }
      );

      await new AuditLog({
        userName: manufacturer,
        action: "Add Drug",
        details: `Drug ID: ${id}, Name: ${name}`,
        txHash: tx.transactionHash,
        status: "Success",
      }).save();

      res.json({ message: "Drug added successfully!", txHash: tx.transactionHash });
    } catch (err) {
      console.error("🚨 Add drug error:", err);
      try {
        await new AuditLog({
          userName: getUserName(user),
          action: "Add Drug",
          details: `Failed to add Drug ID: ${id}, Name: ${name} - ${err.message}`,
          status: "Failed",
        }).save();
      } catch (_) {}
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ===============================
 *  GENERIC STATUS UPDATE (API)
 * ===============================
 */
router.put(
  "/update-status/:id",
  ensureLoggedIn,
  requireAnyRole("distributor", "supplier", "hospital", "regulator"),
  async (req, res) => {
    const { status } = req.body;
    const user = req.session.user;
    const updatedBy = user.role;
    const holderName = getUserName(user);
    const drugId = req.params.id;

    try {
      const drug = await Drug.findOne({ id: drugId });
      if (!drug) {
        await new AuditLog({
          userName: holderName,
          action: "Update Drug Status",
          details: `Attempted to update status for non-existent Drug ID: ${drugId}`,
          status: "Failed",
        }).save();
        return res.status(404).json({ error: "Drug not found" });
      }

      const sender =
        user.walletAddress ||
        (await web3Http.eth.getAccounts())[0] ||
        serverAccount;
      console.log("DEBUG Update-status sender:", sender);
      if (!sender) throw new Error("Sender wallet address not found.");

      const eventDetail = `${status} by ${holderName} (${updatedBy})`;
      const tx = await contractHttp.methods
        .updateHistory(drugId, eventDetail)
        .send({ from: sender, gas: 3000000 });

      drug.status = status;
      drug.currentHolder = holderName;
      drug.currentHolderRole = updatedBy;
      drug.history.push({
        status,
        updatedBy,
        owner: holderName,
        timestamp: Date.now(),
      });
      await drug.save();

      await new AuditLog({
        userName: holderName,
        action: "Update Drug Status",
        details: `Drug ID: ${drugId}, New Status: ${status}`,
        txHash: tx.transactionHash,
        status: "Success",
      }).save();

      res.json({ message: "Status updated successfully!", txHash: tx.transactionHash });
    } catch (err) {
      console.error("🚨 Update status error:", err);
      try {
        await new AuditLog({
          userName: getUserName(user),
          action: "Update Drug Status",
          details: `Failed to update status for Drug ID: ${drugId}, Status: ${status} - ${err.message}`,
          status: "Failed",
        }).save();
      } catch (_) {}
      res.status(500).json({ error: err.message });
    }
  }
);
/**
 * ==================================
 *  MANUFACTURER -> DISTRIBUTOR
 *  POST /api/drugs/transfer-to-distributor
 * ==================================
 */
router.post(
  "/transfer-to-distributor",
  ensureLoggedIn,
  requireAnyRole("manufacturer"),
  async (req, res) => {
    const { drugId, distributorName } = req.body;
    const user = req.session.user;
    const actorName = getUserName(user);
    const actorRole = user.role;

    try {
      if (!drugId || !distributorName) {
        return res.status(400).json({ error: "drugId and distributorName are required" });
      }

      const drug = await Drug.findOne({ id: drugId });
      if (!drug) return res.status(404).json({ error: "Drug not found" });

      // Optional: ensure manufacturer is current holder before transfer
      if (actorRole === "manufacturer") {
        // Uncomment to enforce that manufacturer must be current holder:
        // if (drug.currentHolderRole !== "manufacturer" || drug.currentHolder !== actorName) {
        //   return res.status(403).json({ error: "You are not the current holder of this drug" });
        // }
      }

      const sender =
        user.walletAddress ||
        (await web3Http.eth.getAccounts())[0] ||
        serverAccount;
      console.log("DEBUG Transfer-to-distributor sender:", sender);
      if (!sender) throw new Error("Sender wallet address not found.");

      const eventDetail = `Transferred to Distributor: ${distributorName}`;
      const tx = await contractHttp.methods
        .updateHistory(drugId, eventDetail)
        .send({ from: sender, gas: 3000000 });

      // update DB to reflect distributor ownership
      drug.currentHolder = distributorName;
      drug.currentHolderRole = "distributor";
      drug.currentOwner = distributorName;
      drug.currentOwnerRole = "distributor";
      drug.status = "Transferred to Distributor";
      drug.history.push({
        status: "Transferred to Distributor",
        updatedBy: actorRole,
        owner: distributorName,
        timestamp: Date.now(),
      });
      await drug.save();

      await new AuditLog({
        userName: actorName,
        action: "Transfer Drug to Distributor",
        details: `Drug ID: ${drugId} → Distributor: ${distributorName} (by ${actorRole})`,
        txHash: tx.transactionHash,
        status: "Success",
      }).save();

      return res.json({ message: "Drug transferred to distributor", txHash: tx.transactionHash, drug });
    } catch (err) {
      console.error("🚨 Manufacturer → Distributor transfer error:", err);
      try {
        await new AuditLog({
          userName: getUserName(user),
          action: "Transfer Drug to Distributor",
          details: `Failed transfer of Drug ID: ${req.body.drugId} - ${err.message}`,
          status: "Failed",
        }).save();
      } catch (_) {}
      return res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

/**
 * ==================================
 *  DISTRIBUTOR -> SUPPLIER
 * ==================================
 */
router.post(
  "/transfer-to-supplier",
  ensureLoggedIn,
  requireAnyRole("manufacturer", "distributor"),
  async (req, res) => {
    const { drugId, supplierName } = req.body;
    const user = req.session.user;
    const actorName = getUserName(user);
    const actorRole = user.role;

    try {
      const drug = await Drug.findOne({ id: drugId });
      if (!drug) return res.status(404).json({ error: "Drug not found" });

      // If distributor performing this, ensure they are holder
      // If distributor performing this, ensure they are holder (tolerant check)
if (actorRole === "distributor") {
  // Build candidate identity strings: prefer username, but include display name if different
  const possibleNames = [actorName];
  if (req.session.user?.username && req.session.user?.name && req.session.user.username !== req.session.user.name) {
    possibleNames.push(req.session.user.name);
  }

  // Check several possible places the ownership may have been recorded
  const holderMatches =
    (drug.currentHolderRole === "distributor" && possibleNames.includes(String(drug.currentHolder))) ||
    (drug.currentOwnerRole === "distributor" && possibleNames.includes(String(drug.currentOwner))) ||
    (Array.isArray(drug.history) && drug.history.some(h => possibleNames.includes(String(h.owner))));

  if (!holderMatches) {
    // log server-side detail for debugging
    console.warn("Ownership mismatch on transfer-to-supplier:",
      { drugId: drug.id, attemptedBy: actorName, possibleNames, currentHolder: drug.currentHolder, currentOwner: drug.currentOwner, currentHolderRole: drug.currentHolderRole, currentOwnerRole: drug.currentOwnerRole, historySample: Array.isArray(drug.history) ? drug.history.slice(-3) : [] }
    );

    // Return helpful 403 JSON so frontend can display reason / inspect
    return res.status(403).json({
      error: "You are not the current holder of this drug",
      detail: {
        attemptedBy: actorName,
        possibleNames,
        stored: {
          currentHolder: drug.currentHolder,
          currentHolderRole: drug.currentHolderRole,
          currentOwner: drug.currentOwner,
          currentOwnerRole: drug.currentOwnerRole,
          historySample: Array.isArray(drug.history) ? drug.history.slice(-3) : []
        }
      }
    });
  }
}


      const sender =
        user.walletAddress ||
        (await web3Http.eth.getAccounts())[0] ||
        serverAccount;
      console.log("DEBUG Transfer-to-supplier sender:", sender);
      if (!sender) throw new Error("Sender wallet address not found.");

      const eventDetail = `Transferred to Supplier: ${supplierName}`;
      const tx = await contractHttp.methods
        .updateHistory(drugId, eventDetail)
        .send({ from: sender, gas: 3000000 });

      drug.currentHolder = supplierName;
      drug.currentHolderRole = "supplier";
      drug.currentOwner = supplierName;
      drug.currentOwnerRole = "supplier";
      drug.status = "Transferred to Supplier";
      drug.history.push({
        status: "Transferred to Supplier",
        updatedBy: actorRole,
        owner: supplierName,
        timestamp: Date.now(),
      });
      await drug.save();

      await new AuditLog({
        userName: actorName,
        action: "Transfer Drug to Supplier",
        details: `Drug ID: ${drugId} → Supplier: ${supplierName} (by ${actorRole})`,
        txHash: tx.transactionHash,
        status: "Success",
      }).save();

      res.json({ message: "Drug transferred to supplier", txHash: tx.transactionHash, drug });
    } catch (err) {
      console.error("🚨 Distributor → Supplier transfer error:", err);
      try {
        await new AuditLog({
          userName: getUserName(user),
          action: "Transfer Drug to Supplier",
          details: `Failed transfer of Drug ID: ${req.body.drugId} - ${err.message}`,
          status: "Failed",
        }).save();
      } catch (_) {}
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ==================================
 *  SUPPLIER -> HOSPITAL
 * ==================================
 */
router.post(
  "/transfer-to-hospital",
  ensureLoggedIn,
  requireRole("supplier"),
  async (req, res) => {
    const { drugId, hospitalName } = req.body;
    const user = req.session.user;
    const supplierName = getUserName(user);

    try {
      const drug = await Drug.findOne({ id: drugId });
      if (!drug) return res.status(404).json({ error: "Drug not found" });

      // Optional safety: ensure this supplier currently holds the drug
      if (drug.currentHolderRole && (drug.currentHolderRole !== "supplier" || drug.currentHolder !== supplierName)) {
        return res.status(403).json({ error: "You are not the current holder of this drug" });
      }

      const sender =
        user.walletAddress ||
        (await web3Http.eth.getAccounts())[0] ||
        serverAccount;
      console.log("DEBUG Transfer-to-hospital sender:", sender);
      if (!sender) throw new Error("Sender wallet address not found.");

      const eventDetail = `Transferred to Hospital: ${hospitalName}`;
      const tx = await contractHttp.methods
        .updateHistory(drugId, eventDetail)
        .send({ from: sender, gas: 3000000 });

      drug.currentHolder = hospitalName;
      drug.currentHolderRole = "hospital";
      drug.currentOwner = hospitalName;
      drug.currentOwnerRole = "hospital";
      drug.status = "Transferred to Hospital";
      drug.history.push({
        status: "Transferred to Hospital",
        updatedBy: "supplier",
        owner: hospitalName,
        timestamp: Date.now(),
      });
      await drug.save();

      await new AuditLog({
        userName: supplierName,
        action: "Transfer Drug to Hospital",
        details: `Drug ID: ${drugId} → Hospital: ${hospitalName}`,
        txHash: tx.transactionHash,
        status: "Success",
      }).save();

      res.json({ message: "Drug transferred to hospital", txHash: tx.transactionHash, drug });
    } catch (err) {
      console.error("🚨 Supplier → Hospital transfer error:", err);
      try {
        await new AuditLog({
          userName: getUserName(user),
          action: "Transfer Drug to Hospital",
          details: `Failed transfer of Drug ID: ${req.body.drugId} - ${err.message}`,
          status: "Failed",
        }).save();
      } catch (_) {}
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * ==================================
 *  HOSPITAL -> PATIENT (Dispense)
 * ==================================
 */
router.post(
  "/transfer-to-patient",
  ensureLoggedIn,
  requireRole("hospital"),
  async (req, res) => {
    const { drugId, patientName } = req.body;
    const user = req.session.user;
    const hospitalName = getUserName(user);

    try {
      const drug = await Drug.findOne({ id: drugId });
      if (!drug) return res.status(404).json({ error: "Drug not found" });

      // Safety: hospital must be current holder
      if (drug.currentHolderRole && (drug.currentHolderRole !== "hospital" || drug.currentHolder !== hospitalName)) {
        return res.status(403).json({ error: "You are not the current holder of this drug" });
      }

      const sender =
        user.walletAddress ||
        (await web3Http.eth.getAccounts())[0] ||
        serverAccount;
      console.log("DEBUG Transfer-to-patient sender:", sender);
      if (!sender) throw new Error("Sender wallet address not found.");

      const eventDetail = `Dispensed to Patient: ${patientName}`;
      const tx = await contractHttp.methods
        .updateHistory(drugId, eventDetail)
        .send({ from: sender, gas: 3000000 });

      drug.currentHolder = patientName;
      drug.currentHolderRole = "patient";
      drug.currentOwner = patientName;
      drug.currentOwnerRole = "patient";
      drug.status = "Dispensed to Patient";
      drug.history.push({
        status: "Dispensed",
        updatedBy: "hospital",
        owner: patientName,
        timestamp: Date.now(),
      });
      await drug.save();

      await new AuditLog({
        userName: hospitalName,
        action: "Dispense Drug to Patient",
        details: `Drug ID: ${drugId} → Patient: ${patientName}`,
        txHash: tx.transactionHash,
        status: "Success",
      }).save();

      res.json({ message: "Drug dispensed to patient", txHash: tx.transactionHash, drug });
    } catch (err) {
      console.error("🚨 Hospital → Patient transfer error:", err);
      try {
        await new AuditLog({
          userName: getUserName(user),
          action: "Dispense Drug to Patient",
          details: `Failed dispense of Drug ID: ${req.body.drugId} - ${err.message}`,
          status: "Failed",
        }).save();
      } catch (_) {}
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * =========================
 *  GET DRUG BY ID
 * =========================
 */
router.get("/:id", ensureLoggedIn, async (req, res) => {
  try {
    const drug = await Drug.findOne({ id: req.params.id });
    if (!drug) return res.status(404).json({ error: "Not found" });
    res.json(drug);
  } catch (err) {
    console.error("Get drug error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
