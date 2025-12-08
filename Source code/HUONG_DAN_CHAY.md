# 🚀 HƯỚNG DẪN CHẠY HỆ THỐNG ESP32-CAM + AI

## ✅ Đã sửa xong:
1. **server.js** - Thêm xử lý robot_camera + forward AI
2. **ai_processor.py** - Flask nhận ảnh từ Node.js (MỚI)
3. **start_all.py** - Script khởi động tất cả (MỚI)

---

## 📦 YÊU CẦU HỆ THỐNG

### Phần mềm cần cài:
- ✅ Node.js (v14+)
- ✅ Python 3.11
- ✅ MongoDB
- ✅ Arduino IDE (để flash ESP32)

### Thư viện Python (đã có trong venv_ai):
```bash
mediapipe
opencv-python
flask
requests
numpy
```

---

## 🎯 BƯỚC 1: KHỞI ĐỘNG SERVER

### CÁCH 1 - Chạy thủ công (2 Terminal):

**Terminal 1 (AI Service):**
```powershell
cd AI
.\venv_ai\Scripts\Activate.ps1
python ai_processor.py
```

**Terminal 2 (Node.js Server):**
```powershell
node server.js
```

### CÁCH 2 - Chạy tự động (KHUYẾN NGHỊ):

```powershell
cd AI
.\venv_ai\Scripts\Activate.ps1
python start_all.py
```

Sẽ tự động khởi động:
- ✅ AI Processor (port 5001)
- ✅ Webcam Stream (port 5000, optional)
- ✅ Node.js Server (port 3000)

---

## 🌐 BƯỚC 2: MỞ DASHBOARD

1. Mở trình duyệt: `http://localhost:3000/login.html`
2. Đăng nhập:
   - Username: `admin`
   - Password: `admin123`
3. Vào Dashboard: `http://localhost:3000/dashboard.html`

---

## 📡 BƯỚC 3: KẾT NỐI ESP32-CAM

### A. Chuẩn bị ESP32-CAM:

1. Mở Arduino IDE
2. Mở file: `ESP32/1.ino`
3. Sửa WiFi (dòng 6-7):
```cpp
const char* ssid = "TenWiFi";      // ← WiFi của bạn
const char* password = "MatKhau";  // ← Password
```

4. Sửa IP server (dòng 8):
```cpp
const char* server_ip = "192.168.1.100";  // ← IP máy chạy Node.js
```

**Lấy IP máy laptop:**
```powershell
ipconfig
# Tìm dòng: IPv4 Address. . . . . . . . . . . : 192.168.x.x
```

5. Flash lên ESP32-CAM:
   - Board: **AI Thinker ESP32-CAM**
   - Port: COM? (của ESP32)
   - Nhấn **Upload**

6. Mở Serial Monitor (115200 baud):
   - Xem ESP32 kết nối WiFi
   - Thấy: `[WS] Da ket noi!` ✅

---

## ✅ KIỂM TRA HỆ THỐNG

### Server logs (Terminal Node.js):
```
📡 Upgrade request from 192.168.137.x
🔌 WebSocket connection from 192.168.137.x
✅ Registered robot_camera (ESP32-CAM)
✅ AI processed: YELLOW
```

### Dashboard:
- ✅ Thấy video từ ESP32-CAM
- ✅ Status: Connected

### AI Processor logs (Terminal Python):
```
>>> [GỬI SERVER] RED: Phat hien nguoi NGA!
```

### Dashboard nhận alert:
- ✅ Popup hiện lên: NGUY HIỂM!
- ✅ Lịch sử cảnh báo có bản ghi mới

---

## 🧪 TEST VỚI WEBCAM LAPTOP (TẠM THỜI)

Nếu chưa có ESP32, test AI trước với webcam:

**Terminal 1:**
```powershell
cd AI
.\venv_ai\Scripts\Activate.ps1
python webcam_stream.py
```

**Terminal 2:**
```powershell
python main.py
```

**Terminal 3:**
```powershell
cd ..
node server.js
```

Mở: `http://localhost:3000/dashboard.html`

---

## 📊 KIẾN TRÚC HỆ THỐNG

```
ESP32-CAM (1.ino)
    ↓ WebSocket binary frames
Node.js server.js (port 3000)
    ├→ Forward → Dashboard users (hiển thị video)
    └→ Forward → Flask ai_processor.py (port 5001)
                   ↓ MediaPipe AI detection
                   ↓ POST alert
                Node.js /api/alert
                   ↓ WebSocket
                Dashboard (popup alert)
```

---

## ❓ TROUBLESHOOTING

### 1. Không kết nối được ESP32:
- Kiểm tra IP server đúng chưa (`ipconfig`)
- Kiểm tra WiFi có đúng không
- Mở Serial Monitor xem ESP32 kết nối WiFi chưa

### 2. Không thấy video:
- Kiểm tra ESP32 đã kết nối chưa (xem log server)
- F12 → Console xem có lỗi WebSocket không

### 3. AI không phát hiện:
- Kiểm tra ai_processor.py có chạy không (port 5001)
- Xem log: `✅ AI processed: ...`

### 4. MongoDB lỗi:
```powershell
# Khởi động MongoDB (nếu chưa chạy)
net start MongoDB
```

---

## 🎯 LƯU Ý

- ✅ Code **TỰ ĐỘNG TÌM ĐƯỜNG DẪN** - không cần sửa path
- ✅ Chạy được trên máy khác (chỉ cần sửa IP trong ESP32)
- ✅ Logic AI **KHÔNG ĐỔI** - chỉ đổi cách nhận ảnh
- ✅ Kết nối ESP32 **GIỐNG HỆT iottesy_old**

---

## ⌨️ DỪNG HỆ THỐNG

Nhấn **Ctrl+C** trong terminal để dừng services.

---

**🎉 HOÀN THÀNH! Hệ thống đã sẵn sàng!**
