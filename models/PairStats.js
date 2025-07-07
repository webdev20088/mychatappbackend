// backend/models/PairStats.js
const mongoose = require('mongoose');

const pairStatsSchema = new mongoose.Schema({
  pair: { type: String, required: true, unique: true },
  totalCount: { type: Number, default: 0 },
  currentCount: { type: Number, default: 0 },
  estimatedKB: { type: Number, default: 0 }
});

module.exports = mongoose.model('PairStats', pairStatsSchema);
