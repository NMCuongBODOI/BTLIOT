"""
START ALL SERVICES - Khởi động đồng thời:
1. Flask webcam stream (port 5000) - Dành cho test webcam laptop
2. Flask AI processor (port 5001) - Nhận ảnh từ ESP32-CAM qua Node.js
3. Node.js server (port 3000) - WebSocket + API
"""
import subprocess
import sys
import os
import time

def run_command(cmd, cwd=None, name="Process"):
    """Chạy command trong subprocess"""
    try:
        print(f"🚀 Starting {name}...")
        process = subprocess.Popen(
            cmd,
            shell=True,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        
        # Print output in real-time
        for line in iter(process.stdout.readline, ''):
            if line:
                print(f"[{name}] {line.rstrip()}")
        
        process.stdout.close()
        return_code = process.wait()
        if return_code:
            print(f"❌ {name} exited with code {return_code}")
        
    except Exception as e:
        print(f"❌ Error starting {name}: {e}")

if __name__ == "__main__":
    print("\n" + "="*60)
    print("🎯 ESP32-CAM + AI Detection System")
    print("="*60 + "\n")
    
    # Tự động lấy đường dẫn tuyệt đối (không phụ thuộc path máy khác)
    base_dir = os.path.dirname(os.path.abspath(__file__))  # Thư mục AI/
    project_root = os.path.dirname(base_dir)                # Thư mục iottesy/
    
    print("📂 Project root:", project_root)
    print("📂 AI folder:", base_dir)
    print("\n⏳ Starting services...\n")
    
    # Tìm Python trong venv (tự động tìm Scripts hoặc bin)
    venv_python = os.path.join(base_dir, "venv_ai", "Scripts", "python.exe")
    if not os.path.exists(venv_python):
        venv_python = os.path.join(base_dir, "venv_ai", "bin", "python")  # Linux/Mac
    
    if not os.path.exists(venv_python):
        print(f"❌ Virtual environment not found: {venv_python}")
        print("Please run: python -m venv venv_ai")
        sys.exit(1)
    
    try:
        # Start AI Processor (port 5001)
        print("🤖 Starting AI Processor (port 5001)...")
        ai_cmd = f'"{venv_python}" ai_processor.py'
        ai_process = subprocess.Popen(ai_cmd, shell=True, cwd=base_dir)
        time.sleep(2)
        
        # Start Webcam Stream (port 5000) - Optional, for testing
        print("\n📹 Starting Webcam Stream (port 5000)...")
        webcam_cmd = f'"{venv_python}" webcam_stream.py'
        webcam_process = subprocess.Popen(webcam_cmd, shell=True, cwd=base_dir)
        time.sleep(2)
        
        # Start Node.js Server (port 3000)
        print("\n🌐 Starting Node.js Server (port 3000)...")
        node_cmd = "node server.js"
        node_process = subprocess.Popen(node_cmd, shell=True, cwd=project_root)
        time.sleep(2)
        
        print("\n" + "="*60)
        print("✅ ALL SERVICES STARTED!")
        print("="*60)
        print("\n📌 URLs:")
        print("   Dashboard:    http://localhost:3000/dashboard.html")
        print("   Webcam Test:  http://localhost:5000/stream")
        print("   AI Health:    http://localhost:5001/health")
        print("\n📡 WebSocket:    ws://localhost:3000")
        print("\n⌨️  Press Ctrl+C to stop all services\n")
        
        # Wait for keyboard interrupt
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n\n⚠️  Stopping all services...")
            ai_process.terminate()
            webcam_process.terminate()
            node_process.terminate()
            print("✅ All services stopped.\n")
            
    except Exception as e:
        print(f"\n❌ Error: {e}\n")
        sys.exit(1)
