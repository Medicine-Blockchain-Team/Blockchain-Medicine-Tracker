// backend/routes/admin.js
const express = require("express");
const router = express.Router();

const { ensureLoggedIn, requireRole } = require("../middleware/auth");
const { web3Http, contractHttp } = require("../config/web3"); // IMPORTANT: use contractHttp exported from config/web3
const AuditLog = require("../models/AuditLog"); // if you use audit logging elsewhere

// GET admin home (if you have one)
router.get("/", ensureLoggedIn, requireRole("admin"), (req, res) => {
  res.redirect("/admin/users");
});

// Render verify page (GET)
router.get("/verify", ensureLoggedIn, requireRole("admin"), async (req, res) => {
  // render the page with no result initially
  res.render("admin-verify", { user: req.session.user, result: null });
});

// Handle verify POST (server-rendered response)
router.post("/verify", ensureLoggedIn, requireRole("admin"), async (req, res) => {
  const batchId = (req.body.batchId || "").toString().trim();
  console.log("Admin verifying Drug ID:", batchId);

  if (!batchId) {
    return res.render("admin-verify", { user: req.session.user, result: "Please supply a Batch ID." });
  }

  // Defensive check: ensure contract object exists and has methods
  if (!contractHttp || !contractHttp.methods) {
    let abiMethods = [];
    try {
      if (contractHttp && contractHttp.options && contractHttp.options.jsonInterface) {
        abiMethods = contractHttp.options.jsonInterface.filter(m => m.type === 'function').map(m => m.name);
      } else if (contractHttp && contractHttp._jsonInterface) {
        abiMethods = contractHttp._jsonInterface.map(m => m.name);
      } else if (contractHttp && contractHttp.methods) {
        abiMethods = Object.keys(contractHttp.methods);
      }
    } catch (e) {
      // ignore
    }

    console.error("❌ Admin Verification Error: contractHttp not initialized or missing .methods");
    console.error("Contract object:", contractHttp);
    console.error("ABI function names (sample):", abiMethods.slice(0, 40));

    return res.render("admin-verify", {
      user: req.session.user,
      result: "Server error: blockchain contract not initialized. Check server logs for details."
    });
  }

  try {
    // Known read method candidates - adjust to your contract's getter names if needed
    const tryNames = ["getDrug", "getBatch", "drugs", "drugDetails", "getDrugById", "isVerified"];

    let matched = null;
    let onChain = null;

    for (const name of tryNames) {
      if (typeof contractHttp.methods[name] === "function") {
        matched = name;
        try {
          onChain = await contractHttp.methods[name](batchId).call();
        } catch (callErr) {
          console.warn(`Method ${name} exists but call failed:`, callErr.message || callErr);
          // continue trying other methods
          onChain = null;
        }
        if (onChain !== null && typeof onChain !== "undefined") break;
      }
    }

    // Fallback: try to pick a candidate from available methods heuristically
    if (!matched) {
      const allMethods = Object.keys(contractHttp.methods || {});
      const candidate = allMethods.find(m => typeof contractHttp.methods[m] === "function" && /drugs?|get|fetch|find|batch/i.test(m));
      if (candidate) {
        matched = candidate;
        onChain = await contractHttp.methods[matched](batchId).call();
      }
    }

    if (!matched || typeof onChain === "undefined" || onChain === null) {
      const available = Object.keys(contractHttp.methods || {}).slice(0, 120);
      console.warn("Admin Verification: no matching read method found or call returned empty. Methods sample:", available.slice(0,20));
      return res.render("admin-verify", {
        user: req.session.user,
        result: `No read-method found or returned empty. Check server logs. Sample methods: ${available.slice(0,10).join(", ")}`
      });
    }

    // Format onChain data for display:
    // Many solidity getters return array-like objects (numeric keys + named fields).
    // Normalize: try to convert to a friendly object where possible.
    let pretty;
    try {
      // If returned is an object-like with numeric keys and some named keys, convert to a friendly shape.
      if (Array.isArray(onChain)) {
        pretty = JSON.stringify(onChain, null, 2);
      } else if (typeof onChain === "object") {
        // Try to map numeric-indexed params into nicer object if possible (e.g. [0:'id',1:'name',2:'manufacturer',3:historyArray])
        // Otherwise just JSON.stringify
        // Heuristic: if object has numeric keys starting from "0", create array-style
        const numericKeys = Object.keys(onChain).filter(k => /^\d+$/.test(k)).sort((a,b) => +a - +b);
        if (numericKeys.length > 0) {
          // build arr
          const arr = numericKeys.map(k => onChain[k]);
          // also pick non-numeric keys
          const named = {};
          for (const k of Object.keys(onChain)) {
            if (!/^\d+$/.test(k)) named[k] = onChain[k];
          }
          pretty = JSON.stringify({ array: arr, named }, null, 2);
        } else {
          pretty = JSON.stringify(onChain, null, 2);
        }
      } else {
        pretty = String(onChain);
      }
    } catch (fmtErr) {
      pretty = String(onChain);
    }

    return res.render("admin-verify", {
      user: req.session.user,
      result: `On-chain (${matched}): ${pretty}`
    });
  } catch (err) {
    console.error("🚨 Admin Verification Error:", err);
    return res.render("admin-verify", {
      user: req.session.user,
      result: `Verification failed: ${err.message || String(err)}`
    });
  }
});

module.exports = router;
