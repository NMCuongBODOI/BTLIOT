const express = require('express');
const router = express.Router();
const Alert = require('../models/Alert');
const ActivityLog = require('../models/ActivityLog');
const { authenticateToken } = require('../middleware/auth');
const { roleCheck } = require('../middleware/roleCheck');

// GET /api/alerts - Get alerts (all authenticated users can view)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { type, acknowledged, limit = 50, page = 1 } = req.query;
    
    // Build query
    const query = {};
    if (type) query.type = type;
    if (acknowledged !== undefined) query.acknowledged = acknowledged === 'true';
    
    const skip = (page - 1) * limit;
    
    const alerts = await Alert.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .populate('acknowledgedBy', 'username');
    
    const total = await Alert.countDocuments(query);
    
    res.json({ 
      success: true, 
      alerts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch alerts.' });
  }
});

// PUT /api/alerts/:id/acknowledge - Acknowledge alert
router.put('/:id/acknowledge', authenticateToken, async (req, res) => {
  try {
    const alert = await Alert.findById(req.params.id);
    
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found.' });
    }
    
    alert.acknowledged = true;
    alert.acknowledgedBy = req.user.userId;
    await alert.save();
    
    // Log activity
    await ActivityLog.create({
      userId: req.user.userId,
      username: req.user.username,
      action: 'acknowledge_alert',
      details: { alertId: alert._id, alertType: alert.type },
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    res.json({ success: true, message: 'Alert acknowledged.', alert });
  } catch (error) {
    console.error('Acknowledge alert error:', error);
    res.status(500).json({ success: false, message: 'Failed to acknowledge alert.' });
  }
});

// DELETE /api/alerts/:id - Delete alert (admin only)
router.delete('/:id', authenticateToken, roleCheck('admin'), async (req, res) => {
  try {
    const alert = await Alert.findById(req.params.id);
    
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found.' });
    }
    
    await Alert.findByIdAndDelete(req.params.id);
    
    // Log activity
    await ActivityLog.create({
      userId: req.user.userId,
      username: req.user.username,
      action: 'delete_alert',
      details: { alertId: req.params.id, alertType: alert.type },
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    res.json({ success: true, message: 'Alert deleted.' });
  } catch (error) {
    console.error('Delete alert error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete alert.' });
  }
});

// DELETE /api/alerts - Delete all alerts (admin only)
router.delete('/', authenticateToken, roleCheck('admin'), async (req, res) => {
  try {
    const result = await Alert.deleteMany({});
    
    // Log activity
    await ActivityLog.create({
      userId: req.user.userId,
      username: req.user.username,
      action: 'delete_all_alerts',
      details: { count: result.deletedCount },
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    res.json({ success: true, message: `Deleted ${result.deletedCount} alerts.` });
  } catch (error) {
    console.error('Delete all alerts error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete alerts.' });
  }
});

module.exports = router;
