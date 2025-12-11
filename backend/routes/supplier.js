const express = require("express");
const router = express.Router();
const Drug = require("../models/Drug");
const { ensureLoggedIn, requireRole } = require("../middleware/auth");

// Get drugs currently held by supplier
router.get("/drugs", ensureLoggedIn, requireRole("supplier"), async (req, res) => {
  try {
    const supplierName = req.session.user.username || req.session.user.name;

    const drugs = await Drug.find({
      currentOwnerRole: "supplier",
      currentOwner: supplierName,
    }).sort({ updatedAt: -1 });

    res.json({ success: true, drugs });
  } catch (err) {
    console.error("Supplier drugs error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
