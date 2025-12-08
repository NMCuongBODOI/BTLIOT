"""
Flask API nhận ảnh từ Node.js và xử lý bằng AI
Chạy trên port 5001 (khác với webcam_stream.py port 5000)
"""
from flask import Flask, request, jsonify
import cv2
import numpy as np
import base64
import mediapipe as mp
import time
import requests
import threading
from collections import Counter

app = Flask(__name__)

# --- CẤU HÌNH ---
SERVER_URL = "http://localhost:3000/api/alert"
WAVE_TRIGGER_FRAMES = 30
SAFE_DURATION = 30

class AIProcessor:
    def __init__(self):
        self.mp_holistic = mp.solutions.holistic
        self.holistic = self.mp_holistic.Holistic(
            min_detection_confidence=0.5, 
            min_tracking_confidence=0.5
        )
        self.current_status = "UNKNOWN"
        self.last_sent_time = 0
        self.send_cooldown = 2.0
        self.safe_mode_until = 0
        self.wave_counter = 0
        self.prev_wrist_x = 0
        self.prev_direction = 0
        self.WAVE_THRESHOLD = 3
        self.MIN_MOVE_DIST = 0.02

    def send_alert_thread(self, status, message, frame):
        """Gửi cảnh báo sang server Node.js"""
        try:
            _, buffer = cv2.imencode('.jpg', frame)
            jpg_as_text = base64.b64encode(buffer).decode('utf-8')
            
            payload = {
                "status": status,
                "message": message,
                "timestamp": time.time(),
                "image_base64": jpg_as_text
            }
            response = requests.post(SERVER_URL, json=payload, timeout=2)
            print(f">>> [GỬI SERVER] {status}: {message}")
        except Exception as e:
            print(f"[LỖI] Không gửi được: {e}")

    def detect_wall_region(self, frame):
        """
        Phát hiện tường bằng Cạnh (Edge) thay vì Màu
        Tìm các đường thẳng nằm ngang dài nhất ở nửa dưới màn hình.
        (Logic từ temp2.py)
        """
        try:
            h, w = frame.shape[:2]
            
            # 1. Chỉ xử lý nửa dưới màn hình (để tránh trần nhà, đèn...)
            roi_y_start = int(h * 0.3) 
            roi = frame[roi_y_start:h, 0:w]
            
            # 2. Xử lý ảnh: Grayscale -> Blur -> Canny
            gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            blurred = cv2.GaussianBlur(gray, (5, 5), 0)
            
            # Canny threshold: 50, 150 là ngưỡng phổ biến cho môi trường tự nhiên
            edges = cv2.Canny(blurred, 30, 100)
            
            # 3. Tìm đường thẳng (Hough Transform)
            # minLineLength: Đường phải dài ít nhất 30% chiều rộng ảnh mới tính là tường
            lines = cv2.HoughLinesP(edges, 1, np.pi/180, threshold=50, 
                                    minLineLength=w//3, maxLineGap=20)
            
            if lines is None:
                return False, None
                
            wall_candidates = []
            
            for line in lines:
                x1, y1, x2, y2 = line[0]
                
                # Tính độ nghiêng (chỉ lấy đường nằm ngang hoặc hơi nghiêng)
                if x2 - x1 == 0: continue # Bỏ qua đường dọc 90 độ
                slope = abs((y2 - y1) / (x2 - x1))
                
                if slope < 0.1: # Chỉ lấy đường gần như nằm ngang (slope < 10%)
                    avg_y = (y1 + y2) / 2
                    length = np.sqrt((x2-x1)**2 + (y2-y1)**2)
                    wall_candidates.append((avg_y, length))
            
            if not wall_candidates:
                return False, None
                
            # 4. Logic chọn tường:
            # Chọn đường dài nhất (hoặc bạn có thể chọn đường cao nhất/thấp nhất tùy nhu cầu)
            best_wall = max(wall_candidates, key=lambda x: x[1])
            best_y_in_roi = best_wall[0]
            
            # Chuyển đổi tọa độ từ ROI về khung hình gốc
            real_wall_y = roi_y_start + best_y_in_roi
            
            # Normalize (0.0 -> 1.0)
            return True, real_wall_y / h

        except Exception as e:
            print(f"Lỗi detect wall: {e}")
            return False, None

    def check_pose_logic(self, landmarks, frame):
        """Kiểm tra logic Ngã và Trèo (Logic từ temp2.py)"""
        h_list = [lm.y for lm in landmarks]
        w_list = [lm.x for lm in landmarks]
        
        height = max(h_list) - min(h_list)
        width = max(w_list) - min(w_list)
        
        # Phát hiện ngã
        if width > height * 1.2:
            return "FALL"
        
        # Phát hiện leo tường
        has_wall, wall_y = self.detect_wall_region(frame)
        
        if has_wall and wall_y:
            l_hip = landmarks[self.mp_holistic.PoseLandmark.LEFT_HIP].y
            r_hip = landmarks[self.mp_holistic.PoseLandmark.RIGHT_HIP].y
            l_shoulder = landmarks[self.mp_holistic.PoseLandmark.LEFT_SHOULDER].y
            r_shoulder = landmarks[self.mp_holistic.PoseLandmark.RIGHT_SHOULDER].y
            
            upper_body_y = min(l_shoulder, r_shoulder, l_hip, r_hip)
            
            # Nếu thân trên cao hơn tường = đang leo
            if upper_body_y < wall_y:
                return "CLIMB"
        
        return "NORMAL"

    def is_waving(self, landmarks):
        """Kiểm tra vẫy tay"""
        l_wrist = landmarks[self.mp_holistic.PoseLandmark.LEFT_WRIST]
        r_wrist = landmarks[self.mp_holistic.PoseLandmark.RIGHT_WRIST]
        l_shoulder = landmarks[self.mp_holistic.PoseLandmark.LEFT_SHOULDER]
        r_shoulder = landmarks[self.mp_holistic.PoseLandmark.RIGHT_SHOULDER]
        
        is_raised = l_wrist.y < l_shoulder.y or r_wrist.y < r_shoulder.y
        
        if not is_raised:
            self.wave_counter = 0
            self.prev_wrist_x = 0
            self.prev_direction = 0
            return False

        current_x = r_wrist.x if r_wrist.y < r_shoulder.y else l_wrist.x

        if self.prev_wrist_x == 0:
            self.prev_wrist_x = current_x
            return False

        dx = current_x - self.prev_wrist_x
        
        if abs(dx) > self.MIN_MOVE_DIST:
            current_dir = 1 if dx > 0 else -1
            if self.prev_direction != 0 and current_dir != self.prev_direction:
                self.wave_counter += 1
                print(f"👋 Detect Wave: {self.wave_counter}/{self.WAVE_THRESHOLD}")
            self.prev_direction = current_dir
            self.prev_wrist_x = current_x

        if self.wave_counter >= self.WAVE_THRESHOLD:
            self.wave_counter = 0
            return True

        return False

    def process_frame(self, frame):
        """Xử lý 1 frame từ ESP32-CAM"""
        image = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.holistic.process(image)
        image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        
        status = "YELLOW"
        message = "Dang quet khu vuc..."

        if results.pose_landmarks:
            landmarks = results.pose_landmarks.landmark
            pose_status = self.check_pose_logic(landmarks, frame)  # Truyền thêm frame
            has_face = results.face_landmarks is not None
            
            if pose_status == "FALL":
                status = "RED"
                message = "NGUY HIEM: Phat hien nguoi NGA!"
            elif pose_status == "CLIMB":
                status = "RED"
                message = "NGUY HIEM: Phat hien LEO TUONG!"
            elif not has_face:
                status = "RED"
                message = "CANH BAO: Nguoi giau mat / Quay lung"
            else:
                if time.time() < self.safe_mode_until:
                    status = "GREEN"
                    remaining_time = int(self.safe_mode_until - time.time())
                    message = f"XAC NHAN: An toan ({remaining_time}s)"
                else:
                    if self.is_waving(landmarks):
                        self.safe_mode_until = time.time() + SAFE_DURATION
                        message = "DA KICH HOAT CHE DO AN TOAN!"
                        print(message)
                    else:
                        status = "YELLOW"
                        message = "Phat hien nguoi - Chua xac minh"
        else:
            status = "NORMAL"
            message = "Khong co nguoi"

        # Gửi cảnh báo nếu trạng thái thay đổi
        if status != self.current_status:
            if time.time() - self.last_sent_time > self.send_cooldown:
                t = threading.Thread(target=self.send_alert_thread, args=(status, message, image))
                t.start()
                self.last_sent_time = time.time()
            self.current_status = status

        return {"status": status, "message": message}

# Khởi tạo AI processor
processor = AIProcessor()

@app.route('/process_frame', methods=['POST'])
def process_frame():
    """Nhận ảnh base64 từ Node.js và xử lý"""
    try:
        data = request.json
        image_base64 = data.get('image')
        
        # Decode base64 → numpy array
        img_bytes = base64.b64decode(image_base64)
        nparr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return jsonify({"error": "Invalid image"}), 400
        
        # Xử lý AI
        result = processor.process_frame(frame)
        
        return jsonify(result), 200
        
    except Exception as e:
        print(f"[ERROR] {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "AI Processor"}), 200

if __name__ == '__main__':
    print("\n🤖 AI Processor Service")
    print("📡 Listening on http://localhost:5001")
    print("📥 Waiting for frames from Node.js...")
    app.run(host='0.0.0.0', port=5001, debug=False)