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

app = Flask(__name__)

# --- CẤU HÌNH ---
SERVER_URL = "http://localhost:3000/api/alert"
WALL_LINE_Y = 0.3
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
        self.WAVE_THRESHOLD = 6
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

    def check_pose_logic(self, landmarks):
        """Kiểm tra logic Ngã và Trèo"""
        h_list = [lm.y for lm in landmarks]
        w_list = [lm.x for lm in landmarks]
        
        height = max(h_list) - min(h_list)
        width = max(w_list) - min(w_list)
        
        if width > height * 1.2:
            return "FALL"
            
        l_hip = landmarks[self.mp_holistic.PoseLandmark.LEFT_HIP].y
        r_hip = landmarks[self.mp_holistic.PoseLandmark.RIGHT_HIP].y
        if l_hip < WALL_LINE_Y or r_hip < WALL_LINE_Y:
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
            pose_status = self.check_pose_logic(landmarks)
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
