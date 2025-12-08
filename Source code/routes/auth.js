const express = require('express');
const router = express.Router();
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { generateToken } = require('../middleware/auth');

// POST /api/auth/login - Login user
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required.' });
    }
    
    // Find user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }
    
    // Check if user is active
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is disabled.' });
    }
    
    // Check password (plain text comparison)
    if (user.password !== password) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }
    
    // Update last login
    user.lastLogin = new Date();
    await user.save();
    
    // Log activity
    await ActivityLog.create({
      userId: user._id,
      username: user.username,
      action: 'login',
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    // Generate token
    const token = generateToken(user);
    
    // Set cookie
    res.cookie('token', token, { 
      httpOnly: true, 
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    
    res.json({ 
      success: true, 
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

// POST /api/auth/logout - Logout user
router.post('/logout', async (req, res) => {
  try {
    // Log activity if user info available
    if (req.user) {
      await ActivityLog.create({
        userId: req.user.userId,
        username: req.user.username,
        action: 'logout',
        ipAddress: req.ip || req.connection.remoteAddress
      });
    }
    
    // Clear cookie
    res.clearCookie('token');
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ success: false, message: 'Server error during logout.' });
  }
});

// GET /api/auth/me - Get current user info
router.get('/me', async (req, res) => {
  try {
    // Check for token in cookies or Authorization header
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/auth');
    
    const token = req.cookies.token || 
                  (req.headers.authorization && req.headers.authorization.split(' ')[1]);
    
    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'User not found or inactive.' });
    }
    
    res.json({ success: true, user });
  } catch (error) {
    console.error('Auth check error:', error);
    res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
});

module.exports = router;
