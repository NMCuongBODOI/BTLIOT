const express = require('express');
const router = express.Router();
const ActivityLog = require('../models/ActivityLog');
const { authenticateToken } = require('../middleware/auth');
const { roleCheck } = require('../middleware/roleCheck');

// GET /api/logs - Get activity logs (admin only)
router.get('/', authenticateToken, roleCheck('admin'), async (req, res) => {
  try {
    const { page = 1, limit = 50, action, username } = req.query;
    
    // Build query
    const query = {};
    if (action) query.action = action;
    if (username) query.username = username;
    
    const skip = (page - 1) * limit;
    
    const logs = await ActivityLog.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .populate('userId', 'username email role');
    
    const total = await ActivityLog.countDocuments(query);
    
    res.json({ 
      success: true, 
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch logs.' });
  }
});

// POST /api/logs - Create activity log (for frontend actions)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { action, details } = req.body;
    
    if (!action) {
      return res.status(400).json({ success: false, message: 'Action is required.' });
    }
    
    await ActivityLog.create({
      userId: req.user.userId,
      username: req.user.username,
      action,
      details,
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    res.json({ success: true, message: 'Activity logged.' });
  } catch (error) {
    console.error('Create log error:', error);
    res.status(500).json({ success: false, message: 'Failed to log activity.' });
  }
});

module.exports = router;
