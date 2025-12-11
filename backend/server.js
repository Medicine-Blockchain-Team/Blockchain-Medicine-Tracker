// backend/server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const session = require("express-session");
const MongoStore = require("connect-mongo");

const Drug = require("./models/Drug");
const User = require("./models/User");
const AuditLog = require("./models/AuditLog");

const { ensureLoggedIn, requireRole } = require("./middleware/auth");
const { startListening } = require("./services/blockchainListener");

// IMPORTANT: web3 + contract (used by admin verify endpoint and routes)
const { web3Http, contractHttp, serverAccount } = require("./config/web3");

const app = express();

// ========== Middleware ==========
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);

// ========== View Engine ==========
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../frontend/views"));

// ========== Session Setup ==========
app.use(
  session({
    secret: process.env.SESSION_SECRET || "default-secret",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      ttl: 24 * 60 * 60,
    }),
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: false, // true only for HTTPS
    },
  })
);
// LOGOUT — place after session setup, before mounting other routes
app.get("/logout", (req, res) => {
  // if there is no session, just redirect to login
  if (!req.session) return res.redirect("/login");

  req.session.destroy((err) => {
    if (err) {
      console.error("Logout error:", err);
      // try to clear cookie anyway and redirect
      res.clearCookie("connect.sid");
      return res.status(500).send("Logout failed — please try again.");
    }
    // clear cookie and redirect
    res.clearCookie("connect.sid", { path: "/" });
    return res.redirect("/login");
  });
});

// optional POST logout for forms / CSRF-safe flows
app.post("/logout", (req, res) => {
  if (!req.session) return res.redirect("/login");
  req.session.destroy((err) => {
    res.clearCookie("connect.sid", { path: "/" });
    return res.redirect("/login");
  });
});


// small flash helper: expose session flash to views then clear it
app.use((req, res, next) => {
  res.locals.flash = req.session?.flash || null;
  delete req.session?.flash;
  next();
});

// ========== Auth / Public Routes ==========
app.get("/", (req, res) => {
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  res.render("login");
});

app.get("/register", (req, res) => {
  res.render("register");
});

// ---------- JSON API: Admin verify (returns structured JSON) ----------
app.post(
  "/api/admin/verify",
  ensureLoggedIn,
  requireRole("admin"),
  express.json(),
  async (req, res) => {
    try {
      const batchId = (req.body.batchId || req.body.id || "").toString().trim();
      if (!batchId) {
        return res.status(400).json({ ok: false, error: "batchId is required" });
      }

      // defensive check: contractHttp present and has methods
      if (!contractHttp || !contractHttp.methods) {
        let fnNames = [];
        try {
          fnNames = Object.keys(contractHttp?.methods || {}).slice(0, 120);
        } catch (e) {}
        return res.status(500).json({
          ok: false,
          error: "contract not initialized on server",
          debug: { availableMethodsSample: fnNames.slice(0, 12) },
        });
      }

      // Known read-method candidates (adapt to your contract)
      const tryNames = [
        "getDrug",
        "getBatch",
        "drugs",
        "drugDetails",
        "getDrugById",
        "isVerified",
      ];

      let matched = null;
      let onChain = null;

      // try common candidate names first
      for (const name of tryNames) {
        if (typeof contractHttp.methods[name] === "function") {
          matched = name;
          onChain = await contractHttp.methods[name](batchId).call();
          break;
        }
      }

      // fallback heuristic: find a likely getter and call it
      if (!matched) {
        const allMethods = Object.keys(contractHttp.methods || {});
        const candidate = allMethods.find(
          (m) =>
            typeof contractHttp.methods[m] === "function" &&
            /drugs?|get|fetch|find|batch|detail/i.test(m)
        );
        if (candidate) {
          matched = candidate;
          onChain = await contractHttp.methods[matched](batchId).call();
        }
      }

      if (!matched) {
        const available = Object.keys(contractHttp.methods || {}).slice(0, 120);
        return res.status(500).json({
          ok: false,
          error: "No known read-method found on contract. See availableMethods for choices.",
          availableMethods: available,
        });
      }

      return res.json({
        ok: true,
        method: matched,
        batchId,
        data: onChain,
      });
    } catch (err) {
      console.error("🚨 /api/admin/verify error:", err);
      return res.status(500).json({ ok: false, error: err.message || "Server error" });
    }
  }
);

// ========== Dashboards ==========
app.get("/dashboard", ensureLoggedIn, async (req, res) => {
  const user = req.session.user;
  if (!user?.role) return res.redirect("/login");

  try {
    // ---------- ADMIN ----------
    if (user.role === "admin") {
      const [users, drugs] = await Promise.all([User.find(), Drug.find()]);
      return res.render("admin-dashboard", {
        user,
        users,
        drugs,
        active: "dashboard",
      });
    }

    // ---------- MANUFACTURER ----------
    if (user.role === "manufacturer") {
      const manufacturerName = user.username || user.name;

      const drugs = await Drug.find({ manufacturer: manufacturerName }).catch(() => []);

      // fetch distributors (for assignment UI)
      const distributors = await User.find({ role: "distributor" }).catch(() => []);

      return res.render("manufacturer-dashboard", {
        user,
        drugs,
        distributors,
        active: "dashboard",
      });
    }

    // ---------- DISTRIBUTOR ----------
    if (user.role === "distributor") {
      const distributorName = user.username || user.name;

      // Build list of possible name variants to match stored drug fields
      const possibleNames = [distributorName];
      if (user.username && user.name && user.username !== user.name) {
        possibleNames.push(user.name);
      }

      console.log("Distributor dashboard query names:", possibleNames);

      const drugs =
        (await Drug.find({
          $or: [
            { currentHolderRole: "distributor", currentHolder: { $in: possibleNames } },
            { currentOwnerRole: "distributor", currentOwner: { $in: possibleNames } },
            { "history.owner": { $in: possibleNames } },
          ],
        }).catch(() => [])) || [];

      console.log("Distributor dashboard — found drugs:", Array.isArray(drugs) ? drugs.length : 0);

      const suppliers = await User.find({ role: "supplier" }).catch(() => []);

      return res.render("distributor-dashboard", {
        user,
        drugs,
        suppliers,
        active: "dashboard",
      });
    }

    // ---------- SUPPLIER ----------
    if (user.role === "supplier") {
      const supplierName = user.username || user.name;

      const drugs =
        (await Drug.find({
          $or: [
            { currentHolderRole: "supplier", currentHolder: supplierName },
            { currentOwnerRole: "supplier", currentOwner: supplierName },
            { currentHolderRole: "supplier", currentOwner: supplierName },
            { currentOwnerRole: "supplier", currentHolder: supplierName },
            { "history.owner": supplierName },
          ],
        }).catch(() => [])) || [];

      const hospitals = await User.find({ role: "hospital" }).catch(() => []);

      return res.render("supplier-dashboard", {
        user,
        drugs,
        hospitals,
        active: "dashboard",
      });
    }

    // ---------- HOSPITAL ----------
    if (user.role === "hospital") {
      const hospitalName = user.username || user.name;

      const drugs =
        (await Drug.find({
          $or: [
            { currentHolderRole: "hospital", currentHolder: hospitalName },
            { currentOwnerRole: "hospital", currentOwner: hospitalName },
            { "history.owner": hospitalName },
          ],
        }).catch(() => [])) || [];

      const patients = await User.find({ role: "patient" }).catch(() => []);

      return res.render("hospital-dashboard", {
        user,
        drugs,
        patients,
        message: null,
        active: "dashboard",
      });
    }

    // ---------- PATIENT ----------
    if (user.role === "patient") {
      return res.render("patient-dashboard", {
        user,
        active: "dashboard",
      });
    }

    // ---------- Fallback ----------
    return res.render("handler-dashboard", { user, active: "dashboard" });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Internal server error.");
  }
});

// allow any logged-in user to verify a drug (hospital, patient, admin, etc.)
app.get("/verify-drug", ensureLoggedIn, (req, res) => {
  const user = req.session.user;
  res.render("verify-drug", { user, message: null, active: "verify" });
});

app.post("/verify-drug", ensureLoggedIn, async (req, res) => {
  const user = req.session.user;
  try {
    let { drugId } = req.body;
    if (!drugId || drugId.trim() === "") {
      return res.render("verify-drug", { user, message: "⚠️ Please enter a Drug ID.", active: "verify" });
    }
    drugId = drugId.trim();
    const drug = await Drug.findOne({ id: drugId });
    if (!drug) {
      return res.render("verify-drug", { user, drug: null, message: "❌ Drug not found!", active: "verify" });
    }
    return res.render("verify-result", { user, drug, message: "✅ Drug found.", active: "verify" });
  } catch (err) {
    console.error("Verify drug error:", err);
    res.render("verify-drug", { user, drug: null, message: "⚠️ Server error.", active: "verify" });
  }
});

// ========== Admin Views (integrated) ==========

// Admin — Audit logs (HTML)


app.get(
  "/admin/audit",
  ensureLoggedIn,
  requireRole("admin"),
  async (req, res) => {
    try {
      const auditLogs = (await AuditLog.find().sort({ timestamp: -1 }).limit(500).lean()) || [];

      // explorer base by environment
      const chain = process.env.CHAIN || process.env.NODE_NETWORK || "sepolia";
      let etherscanBase = "https://etherscan.io";
      if (/sepolia/i.test(chain)) etherscanBase = "https://sepolia.etherscan.io";
      else if (/goerli/i.test(chain)) etherscanBase = "https://goerli.etherscan.io";

      return res.render("admin-audit", {
        user: req.session.user,
        auditLogs,
        etherscanBase,
        result: null,
      });
    } catch (err) {
      console.error("Failed to load audit logs:", err);
      return res.status(500).render("admin-audit", {
        user: req.session.user,
        auditLogs: [],
        etherscanBase: "https://etherscan.io",
        result: "Failed to load audit logs.",
      });
    }
  }
);

// Admin — Audit logs JSON
app.get(
  "/admin/audit.json",
  ensureLoggedIn,
  requireRole("admin"),
  async (req, res) => {
    try {
      const auditLogs = await AuditLog.find().sort({ timestamp: -1 }).limit(500).lean();
      res.json({ ok: true, count: auditLogs.length, data: auditLogs });
    } catch (err) {
      console.error("Failed to load audit logs (json):", err);
      res.status(500).json({ ok: false, error: err.message || "Server error" });
    }
  }
);

// Admin — Flagged list (GET)
app.get(
  "/admin/flagged",
  ensureLoggedIn,
  requireRole("admin"),
  async (req, res) => {
    try {
      const flaggedDrugs = await Drug.find({ isFlagged: true }).sort({ updatedAt: -1 }).lean();
      return res.render("admin-flagged", {
        user: req.session.user,
        flaggedDrugs,
      });
    } catch (err) {
      console.error("Failed to load flagged drugs:", err);
      return res.status(500).render("admin-flagged", {
        user: req.session.user,
        flaggedDrugs: [],
        error: "Failed to load flagged batches. See server logs.",
      });
    }
  }
);

// Admin — Unflag (POST)
app.post(
  "/admin/unflag-drug",
  ensureLoggedIn,
  requireRole("admin"),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const drugId = req.body.drug_id || req.body.drugId || req.body.id;
      if (!drugId) {
        req.session.flash = { error: "Missing drug id" };
        return res.redirect("/admin/flagged");
      }

      // detect if this is a MongoDB _id
      const query = /^[0-9a-fA-F]{24}$/.test(drugId) ? { _id: drugId } : { id: drugId };

      const drug = await Drug.findOne(query);
      if (!drug) {
        req.session.flash = { error: "Drug not found" };
        return res.redirect("/admin/flagged");
      }

      drug.isFlagged = false;
      drug.isVerified = true;
      await drug.save();

      await new AuditLog({
        userName: req.session.user ? (req.session.user.username || req.session.user.name) : "admin",
        action: "Unflag Drug",
        details: `Unflagged drug ${drug.id || drug._id}`,
        status: "Success",
      }).save();

      req.session.flash = { success: `Unflagged ${drug.id || drug._id}` };
      return res.redirect("/admin/flagged");
    } catch (err) {
      console.error("Failed to unflag drug:", err);
      try {
        await new AuditLog({
          userName: req.session.user ? (req.session.user.username || req.session.user.name) : "admin",
          action: "Unflag Drug",
          details: `Failed to unflag drug: ${err.message}`,
          status: "Failed",
        }).save();
      } catch (_) {}
      req.session.flash = { error: "Server error while unflagging" };
      return res.redirect("/admin/flagged");
    }
  }
);
app.get(
  "/admin/users",
  ensureLoggedIn,
  requireRole("admin"),
  async (req, res) => {
    try {
      const users = await User.find().lean();
      return res.render("admin-users", {
        user: req.session.user,
        users,
        active: "admin-users",
      });
    } catch (err) {
      console.error("Failed to load admin users:", err);
      return res.status(500).render("admin-users", {
        user: req.session.user,
        users: [],
        active: "admin-users",
        error: "Failed to load users.",
      });
    }
  }
);

/**
 * Admin — Drugs list (HTML)
 */
app.get(
  "/admin/drugs",
  ensureLoggedIn,
  requireRole("admin"),
  async (req, res) => {
    try {
      const drugs = await Drug.find().lean();
      return res.render("admin-drugs", {
        user: req.session.user,
        drugs,
        active: "admin-drugs",
      });
    } catch (err) {
      console.error("Failed to load admin drugs:", err);
      return res.status(500).render("admin-drugs", {
        user: req.session.user,
        drugs: [],
        active: "admin-drugs",
        error: "Failed to load drugs.",
      });
    }
  }
);
app.get(
  "/admin/verify",
  ensureLoggedIn,
  requireRole("admin"),
  async (req, res) => {
    return res.render("admin-verify", { user: req.session.user, result: null });
  }
);
// Admin — Reports (GET)
app.get(
  "/admin/reports",
  ensureLoggedIn,
  requireRole("admin"),
  async (req, res) => {
    try {
      // basic stats
      const totalDrugs = await Drug.countDocuments();
      const totalTransfers = await AuditLog.countDocuments({ action: /Transfer/i });
      const flaggedBatches = await Drug.countDocuments({ isFlagged: true });

      // recent transfer logs (limit 20)
      const recentTransfers = await AuditLog.find({ action: /Transfer/i })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean();

      const stats = {
        totalDrugs,
        totalTransfers,
        flaggedBatches,
      };

      return res.render("admin-reports", {
        user: req.session.user,
        stats,
        recentTransfers,
        error: null,         // ensure template has error defined
        active: "admin-reports",
      });
    } catch (err) {
      console.error("Failed to load reports:", err);
      // pass an explicit error string so the template can show it
      return res.status(500).render("admin-reports", {
        user: req.session.user,
        stats: { totalDrugs: 0, totalTransfers: 0, flaggedBatches: 0 },
        recentTransfers: [],
        error: "Failed to generate reports. See server logs.",
        active: "admin-reports",
      });
    }
  }
);


// ========== Static Assets ==========
app.use(express.static(path.join(__dirname, "public")));

// ========== API Routes ==========
function safeUseRoute(pathBase, routeModule) {
  if (typeof routeModule === "function") {
    app.use(pathBase, routeModule);
  } else {
    console.error(`❌ Route at '${pathBase}' is not a function. Check your export.`);
  }
}

try {
  const authRoutes = require("./routes/auth");
  safeUseRoute("/api/auth", authRoutes);
} catch (err) {
  console.error("❌ Failed to load authRoutes:", err);
}

try {
  const drugRoutes = require("./routes/drugs");
  safeUseRoute("/api/drugs", drugRoutes);
} catch (err) {
  console.error("❌ Failed to load drugRoutes:", err);
}

try {
  const manufacturerRoutes = require("./routes/manufacturer");
  safeUseRoute("/manufacturer", manufacturerRoutes);
} catch (err) {
  console.error("❌ Failed to load manufacturerRoutes:", err);
}

try {
  const supplierRoutes = require("./routes/supplier");
  safeUseRoute("/supplier", supplierRoutes);
} catch (err) {
  console.warn("⚠️ supplierRoutes not loaded (optional):", err.message);
}

// ========== Health Check ==========
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

// ========== DB Connect & Start ==========
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
      startListening();
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
  });
