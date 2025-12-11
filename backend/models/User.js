const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email:    { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { 
    type: String, 
    enum: [
      'admin',              // CDSCO Admin
      'manufacturer', 
      'supplier',
      'distributor',  
      'hospital', 
      'patient'
    ],
    required: true 
  },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
