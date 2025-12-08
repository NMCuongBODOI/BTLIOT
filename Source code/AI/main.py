import cv2
import mediapipe as mp
import time
import requests
import base64
import threading
import numpy as np

# --- CẤU HÌNH ---
SERVER_URL = "http://localhost:3000/api/alert"  # Server của bạn (iottesy)
VIDEO_STREAM_URL = "http://localhost:5000/stream"  # Webcam stream từ webcam_stream.py
WALL_LINE_Y = 0.3         # Ngưỡng leo tường (0.0 - 1.0)
WAVE_TRIGGER_FRAMES = 30  # Cần vẫy tay/giơ tay liên tục khoảng 30 khung hình (1 giây) để kích hoạt
SAFE_DURATION = 30        # Thời gian duy trì trạng thái Xanh (giây)

class SecuritySystem:
    def __init__(self):
            # ... ( các phần khởi tạo mediapipe ) ...
            self.mp_holistic = mp.solutions.holistic
            self.holistic = self.mp_holistic.Holistic(
                min_detection_confidence=0.5, 
                min_tracking_confidence=0.5
            )
            self.mp_drawing = mp.solutions.drawing_utils
            
            # Biến trạng thái hệ thống
            self.current_status = "UNKNOWN"
            self.last_sent_time = 0
            self.send_cooldown = 2.0
            self.safe_mode_until = 0

            # --- CÁC BIẾN MỚI CHO LOGIC VẪY TAY ---
            self.wave_counter = 0       # Đếm số lần lắc tay
            self.prev_wrist_x = 0       # Vị trí tay cũ
            self.prev_direction = 0     # 0: Chưa rõ, 1: Sang phải, -1: Sang trái
            self.WAVE_THRESHOLD = 6     # Cần lắc qua lại 6 lần (3 trái, 3 phải)
            self.MIN_MOVE_DIST = 0.02   # Khoảng cách di chuyển tối thiểu (tránh nhiễu)

    def send_alert_thread(self, status, message, frame):
        """Gửi cảnh báo sang luồng khác để không lag"""
        try:
            _, buffer = cv2.imencode('.jpg', frame)
            jpg_as_text = base64.b64encode(buffer).decode('utf-8')
            
            payload = {
                "status": status,
                "message": message,
                "timestamp": time.time(),
                "image_base64": jpg_as_text # Gửi ảnh để server lưu bằng chứng
            }
            response = requests.post(SERVER_URL, json=payload, timeout=2)  # BẬT GỬI THẬT
            print(f">>> [GỬI SERVER] {status}: {message}")
            print(f"    Server response: {response.status_code} - {response.text}")
        except Exception as e:
            print(f"[LỖI] Không gửi được: {e}")

    def check_pose_logic(self, landmarks):
        """Kiểm tra logic Ngã và Trèo"""
        h_list = [lm.y for lm in landmarks]
        w_list = [lm.x for lm in landmarks]
        
        height = max(h_list) - min(h_list)
        width = max(w_list) - min(w_list)
        
        # 1. Logic Ngã (Chiều rộng > 1.2 chiều cao)
        if width > height * 1.2:
            return "FALL"
            
        # 2. Logic Trèo (Hông cao hơn vạch)
        l_hip = landmarks[self.mp_holistic.PoseLandmark.LEFT_HIP].y
        r_hip = landmarks[self.mp_holistic.PoseLandmark.RIGHT_HIP].y
        if l_hip < WALL_LINE_Y or r_hip < WALL_LINE_Y:
            return "CLIMB"
            
        return "NORMAL"

    def is_waving(self, landmarks):
            """
            Kiểm tra vẫy tay theo logic ĐẢO CHIỀU (Lắc qua lắc lại)
            Trả về True nếu đã vẫy đủ số lần quy định.
            """
            l_wrist = landmarks[self.mp_holistic.PoseLandmark.LEFT_WRIST]
            r_wrist = landmarks[self.mp_holistic.PoseLandmark.RIGHT_WRIST]
            l_shoulder = landmarks[self.mp_holistic.PoseLandmark.LEFT_SHOULDER]
            r_shoulder = landmarks[self.mp_holistic.PoseLandmark.RIGHT_SHOULDER]
            
            # 1. Kiểm tra điều kiện cần: Tay phải cao hơn vai
            is_raised = l_wrist.y < l_shoulder.y or r_wrist.y < r_shoulder.y
            
            if not is_raised:
                # Nếu hạ tay xuống -> Reset toàn bộ bộ đếm
                self.wave_counter = 0
                self.prev_wrist_x = 0
                self.prev_direction = 0
                return False

            # 2. Chọn tay đang giơ để tính toán (ưu tiên tay phải nếu cả 2 cùng giơ)
            current_x = r_wrist.x if r_wrist.y < r_shoulder.y else l_wrist.x

            # Nếu là frame đầu tiên phát hiện giơ tay
            if self.prev_wrist_x == 0:
                self.prev_wrist_x = current_x
                return False

            # 3. Tính toán sự di chuyển
            dx = current_x - self.prev_wrist_x
            
            # Chỉ tính nếu tay di chuyển một khoảng đáng kể (tránh run tay)
            if abs(dx) > self.MIN_MOVE_DIST:
                current_dir = 1 if dx > 0 else -1 # 1 là Phải, -1 là Trái

                # LOGIC CHÍNH: Nếu đổi chiều so với lần trước (đang trái sang phải hoặc ngược lại)
                if self.prev_direction != 0 and current_dir != self.prev_direction:
                    self.wave_counter += 1
                    print(f"👋 Detect Wave: {self.wave_counter}/{self.WAVE_THRESHOLD}")

                self.prev_direction = current_dir
                self.prev_wrist_x = current_x

            # 4. Kiểm tra xem đã vẫy đủ chưa
            if self.wave_counter >= self.WAVE_THRESHOLD:
                self.wave_counter = 0 # Reset để dùng cho lần sau
                return True # Đã xác nhận vẫy tay thành công!

            return False

    def process_frame(self, frame):
        image = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.holistic.process(image)
        image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        
        status = "YELLOW" # Mặc định là cảnh báo vàng (theo dõi)
        message = "Dang quet khu vuc..."
        color = (0, 255, 255) # Vàng

        if results.pose_landmarks:
            landmarks = results.pose_landmarks.landmark
            
            # 1. KIỂM TRA MỐI NGUY HIỂM (Ưu tiên cao nhất)
            pose_status = self.check_pose_logic(landmarks)
            has_face = results.face_landmarks is not None
            
            # Nếu phát hiện NGÃ hoặc TRÈO -> BÁO ĐỎ NGAY LẬP TỨC
            # (Kể cả đang trong thời gian an toàn, nếu ngã thì vẫn phải báo)
            if pose_status == "FALL":
                status = "RED"
                message = "NGUY HIEM: Phat hien nguoi NGA!"
                color = (0, 0, 255)
            elif pose_status == "CLIMB":
                status = "RED"
                message = "NGUY HIEM: Phat hien LEO TUONG!"
                color = (0, 0, 255)
            elif not has_face:
                status = "RED"
                message = "CANH BAO: Nguoi giau mat / Quay lung"
                color = (0, 0, 255)
            
            else:
                # Nếu không có nguy hiểm, kiểm tra logic XANH (AN TOÀN)
                
                # Kiểm tra còn trong thời gian an toàn không?
                if time.time() < self.safe_mode_until:
                    status = "GREEN"
                    remaining_time = int(self.safe_mode_until - time.time())
                    message = f"XAC NHAN: An toan ({remaining_time}s)"
                    color = (0, 255, 0)
                else:
                    # Nếu chưa an toàn, kiểm tra xem có đang vẫy tay để kích hoạt không
                    if self.is_waving(landmarks):
                        # Nếu hàm trả về True nghĩa là ĐÃ vẫy đủ 6 lần
                        self.safe_mode_until = time.time() + SAFE_DURATION
                        message = "DA KICH HOAT CHE DO AN TOAN!"
                        print(message)
                        # Nếu vẫy đủ số lượng frame -> Kích hoạt 30s
                    if self.wave_counter > 0:
                         cv2.putText(image, f"Vay tay: {self.wave_counter}/{self.WAVE_THRESHOLD}", 
                                   (10, 150), cv2.QT_FONT_NORMAL, 0.7, (0, 255, 255), 2)
                    else:
                        # Nếu bỏ tay xuống thì reset bộ đếm (hoặc trừ dần nếu muốn mượt hơn)
                        self.wave_counter = 0
                        status = "YELLOW"
                        message = "Phat hien nguoi - Chua xac minh"

            # Vẽ xương khớp
            self.mp_drawing.draw_landmarks(image, results.pose_landmarks, self.mp_holistic.POSE_CONNECTIONS)

        else:
            status = "NORMAL" # Không có người
            message = "Khong co nguoi"
            color = (200, 200, 200)

        # Gửi cảnh báo nếu trạng thái thay đổi
        if status != self.current_status:
            # Chỉ gửi nếu trạng thái quan trọng (Đỏ/Xanh) hoặc hết thời gian chờ
            if time.time() - self.last_sent_time > self.send_cooldown:
                t = threading.Thread(target=self.send_alert_thread, args=(status, message, image))
                t.start()
                self.last_sent_time = time.time()
            self.current_status = status

        # Hiển thị UI
        cv2.rectangle(image, (0,0), (640, 80), (0,0,0), -1) # Nền đen cho chữ dễ đọc
        cv2.putText(image, f"STATUS: {status}", (10, 30), cv2.QT_FONT_NORMAL, 1, color, 2)
        cv2.putText(image, message, (10, 60), cv2.QT_FONT_NORMAL, 0.6, (255, 255, 255), 1)
        
        # Vẽ vạch tường
        h, w, _ = image.shape
        cv2.line(image, (0, int(h * WALL_LINE_Y)), (w, int(h * WALL_LINE_Y)), (0, 0, 255), 2)

        return image

# --- CHẠY LẤY STREAM TỪ SERVER (giả lập ESP32) ---
print(f"🔗 Đang kết nối đến stream: {VIDEO_STREAM_URL}")
print("⏳ Đợi vài giây để kết nối...")

cap = cv2.VideoCapture(VIDEO_STREAM_URL)
system = SecuritySystem()

if not cap.isOpened():
    print("❌ KHÔNG THỂ KẾT NỐI STREAM!")
    print("Kiểm tra:")
    print("1. webcam_stream.py đã chạy chưa?")
    print("2. URL đúng chưa:", VIDEO_STREAM_URL)
    exit()

print("✅ Đã kết nối stream thành công!")
print("📺 Cửa sổ AI Monitor sẽ hiện ra")
print("⌨️  Nhấn ESC để thoát\n")

while cap.isOpened():
    ret, frame = cap.read()
    if not ret: 
        print("⚠️  Mất kết nối stream, thử lại...")
        time.sleep(2)
        cap = cv2.VideoCapture(VIDEO_STREAM_URL)
        continue
    
    # Flip ảnh cho giống gương
    frame = cv2.flip(frame, 1)
    
    output = system.process_frame(frame)
    cv2.imshow('AI Monitor', output)
    
    if cv2.waitKey(1) & 0xFF == 27: break  # ESC để thoát

cap.release()
cv2.destroyAllWindows()
print("\n✅ Đã đóng AI Monitor")