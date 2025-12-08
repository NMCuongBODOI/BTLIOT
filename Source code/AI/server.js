const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname)); // Serve file từ thư mục gốc

// Lưu trữ trạng thái mới nhất
let latestAlert = {
    status: 'NORMAL',
    message: 'Chờ dữ liệu...',
    timestamp: Date.now(),
    image_base64: null
};

// API nhận alert từ Python
app.post('/api/alert', (req, res) => {
    try {
        const { status, message, timestamp, image_base64 } = req.body;
        
        latestAlert = {
            status,
            message,
            timestamp,
            image_base64
        };

        console.log(`[${new Date().toLocaleTimeString()}] Nhận: ${status} - ${message}`);
        
        // Lưu ảnh nếu là RED (tùy chọn)
        if (status === 'RED' && image_base64) {
            const filename = `alert_${Date.now()}.jpg`;
            fs.writeFileSync(
                path.join(__dirname, 'alerts', filename),
                Buffer.from(image_base64, 'base64')
            );
            console.log(`  → Đã lưu ảnh: ${filename}`);
        }

        res.json({ success: true, received: timestamp });
    } catch (error) {
        console.error('Lỗi nhận alert:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API để frontend lấy trạng thái mới nhất
app.get('/api/status', (req, res) => {
    res.json(latestAlert);
});

// Giả lập video stream từ ESP32 (dùng webcam máy tính)
app.get('/video/stream', (req, res) => {
    console.log('📹 Request video stream từ client');
    
    // TODO: Khi dùng ESP32, uncomment dòng dưới và thay YOUR_ESP32_IP
    // const ESP32_STREAM_URL = 'http://YOUR_ESP32_IP/stream';
    // Sau đó proxy request đến ESP32:
    // return createProxyMiddleware({ 
    //     target: ESP32_STREAM_URL, 
    //     changeOrigin: true 
    // })(req, res);
    
    // Hiện tại: Stream từ webcam laptop qua Python
    const WEBCAM_STREAM_URL = 'http://localhost:5000/stream';
    
    console.log(`  → Đang kết nối đến: ${WEBCAM_STREAM_URL}`);
    
    const http = require('http');
    const request = http.get(WEBCAM_STREAM_URL, (proxyRes) => {
        console.log(`  ✅ Đã kết nối webcam stream (status: ${proxyRes.statusCode})`);
        
        // Set headers từ Python stream
        res.writeHead(proxyRes.statusCode, {
            'Content-Type': proxyRes.headers['content-type'],
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Connection': 'close'
        });
        
        // Pipe response
        proxyRes.pipe(res);
        
        // Xử lý khi client ngắt kết nối
        req.on('close', () => {
            console.log('  ⚠️  Client đã ngắt kết nối stream');
            request.destroy();
        });
    });
    
    request.on('error', (err) => {
        console.error('  ❌ Lỗi kết nối webcam stream:', err.message);
        console.error('  💡 Đảm bảo đã chạy: python webcam_stream.py');
        if (!res.headersSent) {
            res.status(500).send('Không thể kết nối webcam stream. Chạy webcam_stream.py trước!');
        }
    });
    
    request.setTimeout(30000, () => {
        console.error('  ⏱️  Timeout kết nối webcam stream');
        request.destroy();
    });
});

// Thêm route cho trang chủ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Tạo thư mục lưu alerts nếu chưa có
if (!fs.existsSync('./alerts')) {
    fs.mkdirSync('./alerts');
}

app.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
    console.log(`📡 API nhận alert: http://localhost:${PORT}/api/alert`);
    console.log(`📹 Video stream: http://localhost:${PORT}/video/stream`);
    console.log(`🏠 Trang chủ: http://localhost:${PORT}/`);
    console.log(`${'='.repeat(50)}\n`);
    console.log('⚠️  LƯU Ý: Phải chạy webcam_stream.py trước!');
    console.log('   Lệnh: python webcam_stream.py\n');
});