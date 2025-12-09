

"""
Phiên bản sử dụng Webcam máy tính
Xử lý trực tiếp video stream từ camera
"""
import cv2
import numpy as np
import mediapipe as mp
import time
import requests
import threading
from collections import Counter
import base64
import math


# --- CẤU HÌNH ---
SERVER_URL = "http://localhost:3000/api/alert"
SAFE_DURATION = 30
CAMERA_ID = 0

class AIProcessor:
    def __init__(self):
        self.mp_holistic = mp.solutions.holistic
        self.mp_drawing = mp.solutions.drawing_utils
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
        """
        Kiểm tra logic Ngã và Trèo 
        Sử dụng góc nghiêng cơ thể thay vì tỷ lệ khung hình.
        """
        # Lấy tọa độ các điểm mốc quan trọng (Thân trên)
        l_shoulder = landmarks[self.mp_holistic.PoseLandmark.LEFT_SHOULDER]
        r_shoulder = landmarks[self.mp_holistic.PoseLandmark.RIGHT_SHOULDER]
        l_hip = landmarks[self.mp_holistic.PoseLandmark.LEFT_HIP]
        r_hip = landmarks[self.mp_holistic.PoseLandmark.RIGHT_HIP]
        
        # 1. LOGIC PHÁT HIỆN NGÃ (FALL) - Dựa trên góc nghiêng
        # Tính điểm giữa vai và điểm giữa hông
        mid_shoulder_x = (l_shoulder.x + r_shoulder.x) / 2
        mid_shoulder_y = (l_shoulder.y + r_shoulder.y) / 2
        
        mid_hip_x = (l_hip.x + r_hip.x) / 2
        mid_hip_y = (l_hip.y + r_hip.y) / 2
        
        # Tính vector trục cơ thể (từ vai xuống hông)
        dx = mid_hip_x - mid_shoulder_x
        dy = mid_hip_y - mid_shoulder_y # Y tăng dần từ trên xuống dưới
        
        # Nếu cam quá mờ, MediaPipe có thể bắt sai khiến dy ~ 0 hoặc âm (đầu dưới chân)
        # Chỉ xét khi độ tin cậy của các điểm này > 0.5 (visible)
        confidence_check = (l_shoulder.visibility > 0.5 and r_shoulder.visibility > 0.5 and 
                            l_hip.visibility > 0.5 and r_hip.visibility > 0.5)
        
        if confidence_check:
            # Tính góc nghiêng so với trục thẳng đứng (độ)
            # atan2 trả về radian, đổi sang độ. 
            # 90 độ là đứng thẳng, 0 hoặc 180 là nằm ngang.
            angle_rad = math.atan2(dy, dx) 
            angle_deg = abs(math.degrees(angle_rad))
            
            # Chuẩn hóa góc: 90 là đứng, về gần 0 hoặc 180 là nằm
            # Nếu góc lệch khỏi phương thẳng đứng quá nhiều -> NGÃ
            # Bình thường đứng: góc khoảng 80-100 độ (so với trục hoành) hoặc -80 đến -100
            # Nằm: góc < 45 hoặc > 135
            
            is_horizontal = angle_deg < 45 or angle_deg > 135
            
            # Bổ sung: Kiểm tra độ bẹt của thân người (Torso)
            # Khi nằm, khoảng cách dọc (dy) sẽ rất nhỏ so với khoảng cách ngang vai
            shoulder_width = abs(l_shoulder.x - r_shoulder.x)
            torso_compressed = abs(dy) < shoulder_width * 0.8
            
            if is_horizontal or torso_compressed:
                return "FALL"
        else:
            # Fallback cho trường hợp cam quá mờ không thấy hông:
            # Dùng bounding box nhưng chỉ so sánh chiều rộng vai và chiều cao đầu-ngực
            # (Logic cũ nhưng gắt hơn)
            h_list = [lm.y for lm in landmarks]
            w_list = [lm.x for lm in landmarks]
            height = max(h_list) - min(h_list)
            width = max(w_list) - min(w_list)
            if width > height * 1.5: # Tăng ngưỡng lên 1.5 để tránh báo ảo
                return "FALL"

        # 2. LOGIC PHÁT HIỆN LEO TƯỜNG (CLIMB) - Giữ nguyên logic cũ
        has_wall, wall_y = self.detect_wall_region(frame)
        
        if has_wall and wall_y:
            upper_body_y = min(l_shoulder.y, r_shoulder.y, l_hip.y, r_hip.y)
            # Nếu thân trên cao hơn tường
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
            self.prev_direction = current_dir
            self.prev_wrist_x = current_x

        if self.wave_counter >= self.WAVE_THRESHOLD:
            self.wave_counter = 0
            return True

        return False

    def check_face_status(self, face_landmarks, frame):
            """
            Kiểm tra trạng thái khuôn mặt:
            1. Bỏ qua góc nghiêng (Nghiêng cũng được, miễn là có mặt).
            2. Chỉ tập trung bắt KHẨU TRANG (Độ mịn vùng miệng).
            Return: "OK" | "MASK"
            """
            # Nếu MediaPipe đã trả về face_landmarks thì tức là KHÔNG quay lưng.
            # (Vì quay lưng MediaPipe sẽ không bắt được điểm nào -> rơi vào case NO_FACE ở ngoài)
            
            h, w = frame.shape[:2]
            lm = face_landmarks.landmark

            # --- KIỂM TRA KHẨU TRANG (Heuristic) ---
            # So sánh độ "nhiễu" (variance) vùng miệng
            # Vùng miệng thật có môi, răng -> Độ nhiễu cao
            # Khẩu trang vải/y tế -> Phẳng, độ nhiễu thấp
            
            try:
                # Lấy vùng miệng (Landmark 13: Môi trên, 14: Môi dưới)
                mouth_x = int(lm[13].x * w)
                mouth_y = int(lm[13].y * h)
                
                # Crop vùng miệng (20x20 pixel)
                crop_size = 20
                y1 = max(0, mouth_y - crop_size)
                y2 = min(h, mouth_y + crop_size)
                x1 = max(0, mouth_x - crop_size)
                x2 = min(w, mouth_x + crop_size)
                
                mouth_roi = frame[y1:y2, x1:x2]
                
                if mouth_roi.size > 0:
                    # Chuyển ảnh xám -> Tính độ bén (Laplacian)
                    gray_roi = cv2.cvtColor(mouth_roi, cv2.COLOR_BGR2GRAY)
                    laplacian_var = cv2.Laplacian(gray_roi, cv2.CV_64F).var()
                    
                    # NGƯỠNG (Threshold):
                    # < 50: Quá mịn -> Khả năng cao là khẩu trang hoặc che mặt kín
                    # > 50: Có chi tiết (môi, răng) -> Mặt thật
                    if laplacian_var < 50: 
                        return "MASK"
                        
            except Exception:
                pass 
                
            return "OK"

    def process_frame(self, frame):
        """Xử lý 1 frame (Đã update logic check mặt)"""
        image = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.holistic.process(image)
        image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        
        status = "YELLOW"
        message = "Dang quet khu vuc..."
        status_color = (0, 255, 255)

        h, w = image.shape[:2]
        
        # Phát hiện tường (không log)
        has_wall, wall_y = self.detect_wall_region(frame)
        
        # VẼ TƯỜNG
        if has_wall and wall_y:
            wall_pixel_y = int(wall_y * h)
            cv2.line(image, (0, wall_pixel_y), (w, wall_pixel_y), (0, 255, 0), 3)
            cv2.putText(image, f"WALL", (10, wall_pixel_y - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

        if results.pose_landmarks:
            # Vẽ skeleton
            self.mp_drawing.draw_landmarks(
                image, results.pose_landmarks, self.mp_holistic.POSE_CONNECTIONS)
            
            landmarks = results.pose_landmarks.landmark
            pose_status = self.check_pose_logic(landmarks, frame)
            
            face_status = "UNKNOWN"
            if results.face_landmarks:
                # Có landmark -> Mặt đang nhìn (dù nghiêng hay thẳng)
                face_status = self.check_face_status(results.face_landmarks, frame)
            else:
                # Không có landmark -> Quay lưng hoặc Không có mặt
                face_status = "NO_FACE"

            # --- TỔNG HỢP CẢNH BÁO ---
            if pose_status == "FALL":
                status = "RED"
                message = "NGUY HIEM: Phat hien nguoi NGA!"
                status_color = (0, 0, 255)
            elif pose_status == "CLIMB":
                status = "RED"
                message = "NGUY HIEM: Phat hien LEO TUONG!"
                status_color = (0, 0, 255)
            
            # Logic check mặt:
            elif face_status != "OK":
                status = "RED"
                status_color = (0, 0, 255)
                
                if face_status == "NO_FACE":
                    # Đây là trường hợp: Quay đầu về cam (mất landmark) hoặc che kín mít
                    message = "CANH BAO: Khong thay mat / Quay lung"
                elif face_status == "MASK":
                    # Đây là trường hợp: Có mặt nhưng vùng mồm quá phẳng
                    message = "CANH BAO: Phat hien KHAU TRANG!"
            
            else:
                # Mặt OK (có chi tiết miệng) + Dáng OK -> Check Safe Mode
                if time.time() < self.safe_mode_until:
                    status = "GREEN"
                    remaining_time = int(self.safe_mode_until - time.time())
                    message = f"XAC NHAN: An toan ({remaining_time}s)"
                    status_color = (0, 255, 0)
                else:
                    if self.is_waving(landmarks):
                        self.safe_mode_until = time.time() + SAFE_DURATION
                        message = "DA KICH HOAT CHE DO AN TOAN!"
                        status_color = (0, 255, 0)
                        print(message)
                    else:
                        status = "YELLOW"
                        message = "Phat hien nguoi - Chua xac minh"
                        status_color = (0, 255, 255)
        else:
            status = "NORMAL"
            message = "Khong co nguoi"
            status_color = (128, 128, 128)

        # Gửi cảnh báo
        if status != self.current_status:
            if time.time() - self.last_sent_time > self.send_cooldown:
                t = threading.Thread(target=self.send_alert_thread, args=(status, message, image))
                t.start()
                self.last_sent_time = time.time()
            self.current_status = status

        # Vẽ status
        cv2.rectangle(image, (10, 10), (630, 80), (0, 0, 0), -1)
        cv2.putText(image, f"Status: {status}", (20, 40), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, status_color, 2)
        cv2.putText(image, message, (20, 65), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        return image

def main():
    print("\n🤖 AI Surveillance System - Webcam Version")
    print("📹 Khởi động camera...")
    
    cap = cv2.VideoCapture(CAMERA_ID)
    
    if not cap.isOpened():
        print("❌ Không thể mở camera!")
        return
    
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    
    processor = AIProcessor()
    print("✅ Hệ thống sẵn sàng!")
    print("📋 Hướng dẫn:")
    print("   - Vẫy tay để kích hoạt chế độ an toàn")
    print("   - Nhấn 'q' để thoát")
    print("-" * 50)
    
    fps_time = time.time()
    fps_counter = 0
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("❌ Không đọc được frame!")
                break
            
            processed_frame = processor.process_frame(frame)
            
            # Tính FPS
            fps_counter += 1
            if time.time() - fps_time > 1.0:
                fps = fps_counter / (time.time() - fps_time)
                fps_counter = 0
                fps_time = time.time()
                cv2.putText(processed_frame, f"FPS: {fps:.1f}", (540, 30),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            
            cv2.imshow('AI Surveillance - Webcam', processed_frame)
            
            if cv2.waitKey(1) & 0xFF == ord('q'):
                print("\n👋 Đang thoát...")
                break
                
    except KeyboardInterrupt:
        print("\n⚠️ Đã dừng bởi người dùng")
    finally:
        cap.release()
        cv2.destroyAllWindows()
        print("✅ Đã đóng camera và cửa sổ")

if __name__ == '__main__':
    main()
