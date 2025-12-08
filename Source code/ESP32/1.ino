#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h> 

const char* ssid = "Galaxy";
const char* password = "123456780";
const char* server_ip = "192.168.137.1"; 
const int server_port = 3000;

#define FLASH_GPIO_NUM 4

#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

WebSocketsClient webSocket;

// --- HÀM XỬ LÝ SỰ KIỆN TỪ WEB ---
void onEvent(WStype_t type, uint8_t * payload, size_t length) {
  if(type == WStype_CONNECTED) {
    Serial.println("[WS] Da ket noi!");
    webSocket.sendTXT("{\"type\":\"register\",\"role\":\"robot_camera\"}");
  }
  else if(type == WStype_TEXT) {
    // Nhận lệnh JSON từ Web
    StaticJsonDocument<200> doc;
    DeserializationError error = deserializeJson(doc, payload);

    if (!error) {
      // Kiểm tra xem có phải lệnh cho Camera không
      // Web gửi: {type: 'cam_cmd', cmd: 'flash', val: 1/0}
      const char* cmd = doc["cmd"];
      int val = doc["val"];

      if (strcmp(cmd, "flash") == 0) {
        if (val == 1) {
          digitalWrite(FLASH_GPIO_NUM, HIGH); // Bật đèn
          Serial.println("Flash ON");
        } else {
          digitalWrite(FLASH_GPIO_NUM, LOW);  // Tắt đèn
          Serial.println("Flash OFF");
        }
      }
    }
  }
}

void setup() {
  Serial.begin(115200);

  // Cấu hình chân đèn Flash
  pinMode(FLASH_GPIO_NUM, OUTPUT);
  digitalWrite(FLASH_GPIO_NUM, LOW); 

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QVGA; 
  config.jpeg_quality = 15;
  config.fb_count = 1;

  esp_camera_init(&config);

  WiFi.begin(ssid, password);
  while(WiFi.status() != WL_CONNECTED) delay(500);
  Serial.println("WiFi Connected!");

  webSocket.begin(server_ip, server_port, "/");
  webSocket.onEvent(onEvent);
  webSocket.setReconnectInterval(1000);
}

void loop() {
  webSocket.loop();
  camera_fb_t * fb = esp_camera_fb_get();
  if(fb) {
    webSocket.sendBIN(fb->buf, fb->len);
    esp_camera_fb_return(fb);
  }
}