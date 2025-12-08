#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// --- CẤU HÌNH ---
const char* ssid = "Galaxy";
const char* password = "123456780";
const char* server_ip = "192.168.137.1"; 
const int server_port = 3000;

// --- GPIO MOTOR (12 Chân) ---
#define FL_PWM 13
#define FL_IN1 12
#define FL_IN2 14
#define RL_PWM 25
#define RL_IN3 27
#define RL_IN4 26
#define FR_PWM 33
#define FR_IN1 32
#define FR_IN2 15
#define RR_PWM 5
#define RR_IN3 4
#define RR_IN4 2

// CẢM BIẾN & SERVO
#define TRIG 19
#define ECHO 21
#define SERVO_PIN 18

WebSocketsClient webSocket;
Servo myServo;
bool autoMode = false;
unsigned long lastTime = 0;

// --- HÀM ĐIỀU KHIỂN BÁNH XE ---
void setWheel(int pwm, int inA, int inB, int speed, int dir) {
  analogWrite(pwm, speed);
  if (dir == 1) { digitalWrite(inA, HIGH); digitalWrite(inB, LOW); }
  else if (dir == -1) { digitalWrite(inA, LOW); digitalWrite(inB, HIGH); }
  else { digitalWrite(inA, LOW); digitalWrite(inB, LOW); }
}

void moveCar(int speed, int dirL, int dirR) {
  setWheel(FL_PWM, FL_IN1, FL_IN2, speed, dirL);
  setWheel(RL_PWM, RL_IN3, RL_IN4, speed, dirL);
  setWheel(FR_PWM, FR_IN1, FR_IN2, speed, dirR);
  setWheel(RR_PWM, RR_IN3, RR_IN4, speed, dirR);
}

long getDistance() {
  digitalWrite(TRIG, LOW); delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long d = pulseIn(ECHO, HIGH, 25000);
  if (d == 0) return 999; // Coi như xa vô cực nếu không đo được
  return d * 0.034 / 2;
}

// --- LOGIC TỰ HÀNH (CÓ IN SERIAL) ---
void runSmartAuto() {
  long dFront = getDistance();
  
  // LOG: In khoảng cách hiện tại
  Serial.print("[AUTO] Khoang cach phia truoc: ");
  Serial.print(dFront);
  Serial.println(" cm");

  // Gửi lên Server (để hiện trên web)
  webSocket.sendTXT("{\"type\":\"sensor\",\"distance\":" + String(dFront) + "}");

  if (dFront < 30) {
    Serial.println(">>> Phat hien vat can! DUNG XE.");
    moveCar(0, 0, 0); 
    delay(500);       
    
    Serial.println(">>> Dang lui xe...");
    moveCar(150, -1, -1); 
    delay(400);   
    moveCar(0, 0, 0);

    // 1. Quay Servo sang TRÁI
    Serial.println(">>> Quay Servo sang TRAI");
    myServo.write(180); 
    delay(1000); // Chờ servo quay
    long dLeft = getDistance();
    Serial.print("--> Khoang cach Ben Trai: "); Serial.println(dLeft);
    
    // 2. Quay Servo sang PHẢI
    Serial.println(">>> Quay Servo sang PHAI");
    myServo.write(0); 
    delay(1000); // Chờ servo quay từ 180 về 0
    long dRight = getDistance();
    Serial.print("--> Khoang cach Ben Phai: "); Serial.println(dRight);
    
    // 3. Về giữa
    myServo.write(90); 
    delay(600);

    // 4. So sánh và Ra quyết định
    if (dLeft > dRight) {
      Serial.println(">>> QUYET DINH: Re TRAI (Do ben trai thoang hon)");
      moveCar(200, -1, 1); // Quay trái tại chỗ
      delay(400);
    } else {
      Serial.println(">>> QUYET DINH: Re PHAI (Do ben phai thoang hon)");
      moveCar(200, 1, -1); // Quay phải tại chỗ
      delay(400);
    }
    
    moveCar(0, 0, 0); // Dừng một nhịp trước khi đi tiếp
    delay(200);
    Serial.println(">>> Tiep tuc di chuyen...");
    
  } else {
    
    moveCar(150, 1, 1); // Tiến
  }
}

// --- XỬ LÝ SỰ KIỆN ---
void onEvent(WStype_t type, uint8_t * payload, size_t length) {
  if (type == WStype_CONNECTED) {
    Serial.println("[WS] Da ket noi voi Server Node.js!");
    webSocket.sendTXT("{\"type\":\"register\",\"role\":\"robot_control\"}");
  } 
  else if (type == WStype_DISCONNECTED) {
    Serial.println("[WS] Mat ket noi Server!");
  }
  else if (type == WStype_TEXT) {
    // In lệnh nhận được ra để kiểm tra
    Serial.printf("[WS] Nhan lenh: %s\n", payload);

    StaticJsonDocument<200> doc;
    DeserializationError error = deserializeJson(doc, payload);
    if (error) {
      Serial.print(F("deserializeJson() failed: "));
      Serial.println(error.c_str());
      return;
    }
    
    if (strcmp(doc["type"], "control") == 0) {
      const char* cmd = doc["cmd"];
      const char* val = doc["val"];

      if (strcmp(cmd, "mode") == 0) {
        if (strcmp(val, "auto_on") == 0) {
          autoMode = true;
          Serial.println("=== BAT CHE DO AUTO ===");
        } else {
          autoMode = false;
          moveCar(0, 0, 0);
          myServo.write(90);
          Serial.println("=== TAT CHE DO AUTO ===");
        }
      }

      if (!autoMode && strcmp(cmd, "move") == 0) {
        Serial.print("Dieu khien thu cong: "); Serial.println(val);

        if (strcmp(val, "forward") == 0) {
             moveCar(200, 1, 1);
        }
        else if (strcmp(val, "backward") == 0) {
             moveCar(200, -1, -1);
        }
        else if (strcmp(val, "left") == 0) {
             moveCar(200, -1, 1);
        }

        else if (strcmp(val, "right") == 0) {
             moveCar(200, 1, -1);
        }

        else if (strcmp(val, "stop") == 0) {
             moveCar(0, 0, 0);
        }
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n\n--- KHOI DONG ROBOT ---");
  
  // Set Output 12 chân Motor
  int pins[] = {FL_PWM, FL_IN1, FL_IN2, RL_PWM, RL_IN3, RL_IN4, 
                FR_PWM, FR_IN1, FR_IN2, RR_PWM, RR_IN3, RR_IN4, TRIG};
  for(int p : pins) pinMode(p, OUTPUT);
  pinMode(ECHO, INPUT);

  myServo.attach(SERVO_PIN);
  myServo.write(90);

  Serial.print("Dang ket noi WiFi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);
  
  while(WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
  
  Serial.print("Dang ket noi Server: ");
  Serial.println(server_ip);
  webSocket.begin(server_ip, server_port, "/");
  webSocket.onEvent(onEvent);
  webSocket.setReconnectInterval(1000);
}

void loop() {
  webSocket.loop();
  if (autoMode) {
    runSmartAuto();
  }
}