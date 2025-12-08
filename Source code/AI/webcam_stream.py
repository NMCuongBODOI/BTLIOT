import cv2
from flask import Flask, Response
import sys

app = Flask(__name__)

# Khởi tạo webcam (thử cả DirectShow backend)
print('🔍 Đang tìm webcam...')
camera = cv2.VideoCapture(0, cv2.CAP_DSHOW)  # DirectShow cho Windows

# Kiểm tra webcam có mở được không
if not camera.isOpened():
    print('❌ KHÔNG THỂ MỞ WEBCAM!')
    print('Kiểm tra:')
    print('1. Webcam có bị app khác sử dụng không?')
    print('2. Driver webcam đã cài đúng chưa?')
    sys.exit(1)

camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

# Test đọc 1 frame để chắc chắn webcam hoạt động
success, test_frame = camera.read()
if not success:
    print('❌ KHÔNG THỂ ĐỌC FRAME TỪ WEBCAM!')
    camera.release()
    sys.exit(1)

print('✅ Webcam đã sẵn sàng!')
print(f'📐 Resolution: {int(camera.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT))}')

def generate_frames():
    """Generator để stream frames qua HTTP"""
    while True:
        success, frame = camera.read()
        if not success:
            print('⚠️ Lỗi đọc frame từ webcam')
            break
        
        # Encode frame thành JPEG
        ret, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ret:
            print('⚠️ Lỗi encode frame')
            continue
            
        frame_bytes = buffer.tobytes()
        
        # Yield frame theo format multipart
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')

@app.route('/stream')
def video_feed():
    print('📹 Client đã kết nối stream')
    return Response(generate_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/test')
def test():
    return '✅ Webcam server đang hoạt động'

if __name__ == '__main__':
    print('🎥 Webcam stream đang chạy tại http://localhost:5000/stream')
    print('🔗 Test endpoint: http://localhost:5000/test')
    print('📺 Xem stream tại: http://localhost:3000/')
    print('\n⌨️  Nhấn Ctrl+C để dừng server\n')
    
    try:
        app.run(host='0.0.0.0', port=5000, threaded=True, debug=False)
    except KeyboardInterrupt:
        print('\n⏹️  Đang tắt webcam...')
        camera.release()
        print('✅ Đã tắt webcam')
