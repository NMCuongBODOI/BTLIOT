// FILE: server.js
require('dotenv').config();

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// Log upgrade headers for debugging ESP32 connection
server.on('upgrade', (req, socket, head) => {
    console.log('📡 Upgrade request from', req.socket.remoteAddress);
    console.log('   Headers:', req.headers);
});

// WebSocket server
const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false
});

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/iottesy_auth';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Middleware
app.use(express.json({ limit: '50mb' })); // Tăng limit cho ảnh base64 từ AI
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const logsRoutes = require('./routes/logs');
const alertsRoutes = require('./routes/alerts');

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/alerts', alertsRoutes);

// ===== VIDEO STREAM TỪ ESP32-CAM (QUA WEBSOCKET) =====
// Video được gửi trực tiếp từ ESP32-CAM qua WebSocket binary frames

// ===== ROUTE NHẬN ALERT TỪ AI PYTHON =====
app.post('/api/alert', async (req, res) => {
    try {
        const { status, message, timestamp, image_base64 } = req.body;
        
        console.log(`🤖 [AI ALERT] ${status}: ${message}`);
        
        // Bỏ qua các status không quan trọng
        if (status === 'YELLOW' || status === 'NORMAL') {
            console.log('  ℹ️  Status không quan trọng - Bỏ qua');
            return res.json({ success: true, skipped: true, reason: `${status} status` });
        }
        
        if (status === 'GREEN') {
            console.log('  ℹ️  Status GREEN (an toàn) - Không lưu alert');
            return res.json({ success: true, skipped: true, reason: 'Safe status' });
        }
        
        // Map status từ AI sang alert type
        let alertType = 'climbing'; // default
        let displayMessage = message; // Message hiển thị trên dashboard
        
        if (status === 'FALL') {
            alertType = 'fall';
            displayMessage = 'Phát hiện người bị ngã';
        } else if (status === 'CLIMB') {
            alertType = 'climbing';
            displayMessage = 'Phát hiện leo tường';
        } else if (status === 'RED') {
            // RED có thể là: ngã, leo tường, giấu mặt, quay lưng
            const msg = message.toLowerCase();
            if (msg.includes('nga') || msg.includes('fall')) {
                alertType = 'fall';
                displayMessage = 'Phát hiện người bị ngã';
            } else if (msg.includes('leo') || msg.includes('treo') || msg.includes('climb')) {
                alertType = 'climbing';
                displayMessage = 'Phát hiện leo tường';
            } else if (msg.includes('giau') || msg.includes('quay') || msg.includes('hide') || msg.includes('turn')) {
                alertType = 'suspicious'; // Hành vi khả nghi (giấu mặt/quay lưng)
                displayMessage = 'Cảnh báo: Người giấu mặt / Quay lưng';
            } else {
                // Các RED khác
                alertType = 'suspicious';
                displayMessage = message;
            }
        }
        
        // Lưu vào MongoDB
        const Alert = require('./models/Alert');
        
        // Chuyển timestamp từ Unix epoch (giây) sang milliseconds
        const alertTimestamp = timestamp ? new Date(timestamp * 1000) : new Date();
        
        const alert = new Alert({
            type: alertType,
            confidence: 95, // AI của Đạt chưa trả confidence, mặc định 95%
            imageUrl: image_base64 ? `data:image/jpeg;base64,${image_base64}` : '',
            timestamp: alertTimestamp,
            keypoints: [], // MediaPipe có thể thêm sau
            center: { x: 0.5, y: 0.5 }
        });
        
        await alert.save();
        console.log(`  ✅ Đã lưu alert vào database: ${alert._id} at ${alertTimestamp.toLocaleString('vi-VN')}`);
        
        // Gửi realtime qua WebSocket cho tất cả dashboard (bao gồm _id để tracking)
        const alertMessage = JSON.stringify({
            type: 'alert',
            _id: alert._id,
            alertType: alert.type,
            message: displayMessage, // Dùng displayMessage đã format
            confidence: alert.confidence,
            imageUrl: alert.imageUrl,
            timestamp: alert.timestamp.toISOString(),
            keypoints: alert.keypoints,
            center: alert.center
        });
        
        sendToUsers(alertMessage, false);
        
        console.log(`  ✅ Đã gửi alert đến ${userWSs.length} dashboard(s)`);
        
        res.json({ success: true, alertId: alert._id });
    } catch (error) {
        console.error('❌ Lỗi xử lý alert:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== WEB SOCKET STATE =====
let robotControlWS = null; // ws used to send control commands to robot
let robotCameraWS = null;  // separate ws for camera stream
let userWSs = [];          // array of clients viewing video / receiving updates

// Forward ảnh từ ESP32-CAM sang Python AI để xử lý
async function forwardImageToAI(imageBuffer) {
    try {
        const base64Image = imageBuffer.toString('base64');
        const response = await fetch('http://localhost:5001/process_frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64Image })
        });
        
        if (response.ok) {
            const result = await response.json();
            console.log('  🤖 AI processed:', result.status);
        }
    } catch (err) {
        // Không log lỗi liên tục để tránh spam console
        // console.error('AI forward error:', err);
    }
}

// Function to send data to all users
function sendToUsers(data, isBinary = false) {
    userWSs.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(data, { binary: isBinary });
            } catch (e) {
                console.error('Error sending to user:', e);
            }
        }
    });
}

// ===== WEB SOCKET CONNECTION HANDLING =====
wss.on('connection', (ws, req) => {
    // Per-connection assembly state for image chunks
    ws._role = null;           // 'robot_control'|'robot_camera'|'user'
    ws._imgBuffer = null;      // Buffer assembling image chunks
    ws._expectedLen = 0;       // optional expected total length from img_start
    ws._receivedLen = 0;       // bytes received so far
    
    console.log('🔌 WebSocket connection from', req.socket.remoteAddress);
    
    ws.on('message', (message, isBinary) => {
        // 1. BINARY FRAMES - Hình ảnh từ ESP32-CAM
        if (isBinary) {
            console.log(`📸 Binary frame received (${message.length} bytes)`);
            
            if (ws._imgBuffer !== null) {
                // Đang trong quá trình assemble image chunks
                const chunk = Buffer.from(message);
                ws._imgBuffer = Buffer.concat([ws._imgBuffer, chunk]);
                ws._receivedLen += chunk.length;
                
                // Nếu biết expected length và đã nhận đủ, forward ngay
                if (ws._expectedLen && ws._receivedLen >= ws._expectedLen) {
                    console.log(`📤 Forwarding assembled image (${ws._imgBuffer.length} bytes) to ${userWSs.length} users`);
                    
                    // Forward cho dashboard users
                    sendToUsers(ws._imgBuffer, true);
                    
                    // Forward sang AI để xử lý (không chờ kết quả)
                    forwardImageToAI(ws._imgBuffer);
                    
                    // Reset buffer
                    ws._imgBuffer = null;
                    ws._expectedLen = 0;
                    ws._receivedLen = 0;
                }
            } else {
                // Single complete frame (backward compatible)
                console.log(`📤 Forwarding single frame (${message.length} bytes) to ${userWSs.length} users`);
                
                // Forward cho dashboard users
                sendToUsers(message, true);
                
                // Forward sang AI để xử lý
                forwardImageToAI(Buffer.from(message));
            }
            return;
        }

        // 2. TEXT FRAMES - JSON commands
        try {
            const msgStr = message.toString();
            const data = JSON.parse(msgStr);
            console.log('📩 JSON message received:', data.type, 'from', req.socket.remoteAddress);

            // ĐĂNG KÝ VAI TRÒ
            if (data.type === 'register') {
                if (data.role === 'robot_control') {
                    robotControlWS = ws;
                    ws._role = 'robot_control';
                    console.log('  ✅ Registered robot_control');
                }
                else if (data.role === 'robot_camera') {
                    robotCameraWS = ws;
                    ws._role = 'robot_camera';
                    console.log('  ✅ Registered robot_camera (ESP32-CAM)');
                }
                else if (data.role === 'user') {
                    if (!userWSs.includes(ws)) {
                        userWSs.push(ws);
                        ws._role = 'user';
                    }
                    console.log('  ✅ Registered user (total:', userWSs.length, ')');
                }
                else {
                    console.log('  ⚠️  Unknown register role:', data.role);
                }
                return;
            }

            // IMAGE START: prepare to assemble binary chunks
            if (data.type === 'img_start') {
                ws._expectedLen = data.len || 0;
                ws._imgBuffer = Buffer.allocUnsafe(0);
                ws._receivedLen = 0;
                console.log(`🖼️  img_start from ${req.socket.remoteAddress}, expectedLen=${ws._expectedLen}`);
                return;
            }

            // IMAGE END: forward assembled image if present
            if (data.type === 'img_end') {
                if (ws._imgBuffer && ws._receivedLen > 0) {
                    console.log(`📤 img_end: Forwarding assembled image (${ws._imgBuffer.length} bytes)`);
                    sendToUsers(ws._imgBuffer, true);
                    forwardImageToAI(ws._imgBuffer);
                    
                    // Reset buffer
                    ws._imgBuffer = null;
                    ws._expectedLen = 0;
                    ws._receivedLen = 0;
                } else {
                    console.log('⚠️  img_end received but no buffer present');
                }
                return;
            }

            // LỆNH TỪ USER -> GỬI XUỐNG ROBOT
            if (data.type === 'control') {
                if (robotControlWS && robotControlWS.readyState === WebSocket.OPEN) {
                    console.log('  📡 Forwarding control command to robot');
                    robotControlWS.send(msgStr);
                } else {
                    console.log('  ⚠️  No robotControlWS connected; control not sent');
                }
                return;
            }

            // DỮ LIỆU CẢM BIẾN/CẢNH BÁO TỪ ROBOT -> GỬI LÊN USER
            if (data.type === 'sensor' || data.type === 'alert') {
                console.log('  📤 Forwarding', data.type, 'to', userWSs.length, 'users');
                sendToUsers(msgStr, false);
                return;
            }

            // Fallback
            console.log('  ❓ Unhandled text message type:', data.type);
        } catch (e) {
            console.error('❌ Failed to parse message as JSON:', e);
        }
    });

    ws.on('close', () => {
        // Remove from users list if present
        userWSs = userWSs.filter(client => client !== ws);
        
        if (ws === robotControlWS) {
            robotControlWS = null;
            console.log('  ⚠️  robot_control disconnected');
        }
        if (ws === robotCameraWS) {
            robotCameraWS = null;
            console.log('  ⚠️  robot_camera disconnected');
        }
        
        // Clean up buffer state
        if (ws._imgBuffer) {
            ws._imgBuffer = null;
        }
        
        console.log('🔌 Connection closed. Active users:', userWSs.length);
    });

    ws.on('error', (err) => {
        console.error('❌ WS client error:', err);
    });
});

wss.on('error', (err) => {
    console.error('❌ WSS server error:', err);
});

// ===== SEED DEFAULT USERS =====
async function seedDefaultUsers() {
    try {
        const User = require('./models/User');
        
        const defaultUsers = [
            { username: 'admin', password: 'admin123', email: 'admin@esp32cam.local', role: 'admin' },
            { username: 'operator', password: 'operator123', email: 'operator@esp32cam.local', role: 'operator' }
        ];
        
        for (const userData of defaultUsers) {
            const exists = await User.findOne({ username: userData.username });
            if (!exists) {
                await User.create(userData);
                console.log(`✅ Created default user: ${userData.username}`);
            } else {
                console.log(`ℹ️  User ${userData.username} already exists`);
            }
        }
    } catch (err) {
        console.error('❌ seedDefaultUsers error:', err);
    }
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('📡 WebSocket server ready');
    console.log('🎥 Ready to receive ESP32-CAM video stream');
    console.log('🤖 Ready to process AI alerts');
    
    await seedDefaultUsers();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        mongoose.connection.close(false, () => {
            console.log('MongoDB connection closed');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        mongoose.connection.close(false, () => {
            console.log('MongoDB connection closed');
            process.exit(0);
        });
    });
});