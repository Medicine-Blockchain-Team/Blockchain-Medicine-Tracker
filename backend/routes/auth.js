// backend/routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const User = require("../models/User");

// =====================
// REGISTER
// =====================
router.post("/register", async (req, res) => {
  const { username, email, password, role, walletAddress } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = new User({
      username,
      email,
      passwordHash,
      role,
      walletAddress: walletAddress || null, // ✅ store if MetaMask provided
    });

    await newUser.save();
    return res.redirect("/login");
  } catch (err) {
    console.error("Registration error:", err);
    return res.status(500).json({ message: "Server error during registration" });
  }
});

// =====================
// LOGIN
// =====================
router.post("/login", async (req, res) => {
  const { email, password, walletAddress } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // ✅ DO NOT generate wallets in backend
    // ✅ Accept walletAddress from frontend (MetaMask)
    if (walletAddress) {
      user.walletAddress = walletAddress;
      await user.save();
    }

    req.session.user = {
      id: user._id,
      username: user.username,
      name: user.username,
      email: user.email,
      role: user.role,
      walletAddress: user.walletAddress || null,
    };

    return res.json({
      message: "Login successful",
      user: req.session.user,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// =====================
// LOGOUT
// =====================
router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ message: "Logged out" });
  });
});

module.exports = router;
