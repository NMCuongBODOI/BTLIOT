const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['climbing', 'fall', 'running', 'intrusion', 'suspicious'],
    required: true
  },
  confidence: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  imageUrl: {
    type: String,
    required: true
  },
  keypoints: [{
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    score: { type: Number, required: true }
  }],
  center: {
    x: { type: Number },
    y: { type: Number }
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  acknowledged: {
    type: Boolean,
    default: false
  },
  acknowledgedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
});

// Index for faster queries
alertSchema.index({ timestamp: -1 });
alertSchema.index({ type: 1 });
alertSchema.index({ acknowledged: 1 });

module.exports = mongoose.model('Alert', alertSchema);
