// models/UserStats.js
const mongoose = require('mongoose');

const userStatsSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  totalUsageMinutes: { type: Number, default: 0 },
  lastSeen: { type: Date, default: null }
});

module.exports = mongoose.model('UserStats', userStatsSchema);
