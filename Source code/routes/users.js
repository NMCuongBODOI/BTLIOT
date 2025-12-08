const express = require('express');
const router = express.Router();
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { authenticateToken } = require('../middleware/auth');
const { roleCheck } = require('../middleware/roleCheck');

// All routes require authentication and admin role
router.use(authenticateToken);
router.use(roleCheck('admin'));

// GET /api/users - Get all users
router.get('/', async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ success: true, users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch users.' });
  }
});

// POST /api/users - Create new user (admin only)
router.post('/', async (req, res) => {
  try {
    const { username, password, email, role } = req.body;
    
    // Validation
    if (!username || !password || !email || !role) {
      return res.status(400).json({ 
        success: false, 
        message: 'Username, password, email, and role are required.' 
      });
    }
    
    // Check if username exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Username already exists.' });
    }
    
    // Check if email exists
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      return res.status(409).json({ success: false, message: 'Email already exists.' });
    }
    
    // Create user
    const newUser = await User.create({
      username,
      password, // Plain text
      email,
      role
    });
    
    // Log activity
    await ActivityLog.create({
      userId: req.user.userId,
      username: req.user.username,
      action: 'create_user',
      details: { newUsername: username, role },
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    res.status(201).json({ 
      success: true, 
      message: 'User created successfully.',
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
        isActive: newUser.isActive
      }
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ success: false, message: 'Failed to create user.' });
  }
});

// PUT /api/users/:id - Update user
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password, email, role, isActive } = req.body;
    
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    
    // Update fields
    if (username) user.username = username;
    if (password) user.password = password; // Plain text
    if (email) user.email = email;
    if (role) user.role = role;
    if (typeof isActive !== 'undefined') user.isActive = isActive;
    
    await user.save();
    
    // Log activity
    await ActivityLog.create({
      userId: req.user.userId,
      username: req.user.username,
      action: 'update_user',
      details: { updatedUsername: user.username, changes: req.body },
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    res.json({ 
      success: true, 
      message: 'User updated successfully.',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ success: false, message: 'Failed to update user.' });
  }
});

// DELETE /api/users/:id - Delete user
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Prevent deleting self
    if (id === req.user.userId) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account.' });
    }
    
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    
    const deletedUsername = user.username;
    await User.findByIdAndDelete(id);
    
    // Log activity
    await ActivityLog.create({
      userId: req.user.userId,
      username: req.user.username,
      action: 'delete_user',
      details: { deletedUsername },
      ipAddress: req.ip || req.connection.remoteAddress
    });
    
    res.json({ success: true, message: 'User deleted successfully.' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete user.' });
  }
});

module.exports = router;
