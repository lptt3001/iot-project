#include <Arduino.h>
#include <DHT.h>
#include "esp_camera.h"
#include "mbedtls/base64.h"
#include "esp_system.h"

// Pinout supplied for the ESP32-CAM; SD card must not use these sensor pins.
constexpr int DHT_PIN=13, LIGHT_PIN=14, RAIN_PIN=15, SOIL_PIN=2;
constexpr int TRAP_LED=33, FLASH_LED=4, CAMERA_PWDN=32;
constexpr int DARK_LEVEL=1, WET_LEVEL=0;
#ifndef PTIT_DHT_TYPE
#define PTIT_DHT_TYPE DHT11
#endif
DHT dht(DHT_PIN,PTIT_DHT_TYPE);
uint32_t lastSensor=0,lastAutomatic=0;
bool capturing=false;
String command;

void trapTask(void*) {
  for (;;) {
    bool on=digitalRead(LIGHT_PIN)==DARK_LEVEL && digitalRead(RAIN_PIN)!=WET_LEVEL;
    digitalWrite(TRAP_LED,on?LOW:HIGH);
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

bool allowed(bool testMode) {
  // Manual test may ignore light; rain still blocks capture. Auto needs dark + dry.
  return digitalRead(RAIN_PIN)!=WET_LEVEL && (testMode || digitalRead(LIGHT_PIN)==DARK_LEVEL);
}

bool startCamera() {
  camera_config_t c={};
  c.ledc_channel=LEDC_CHANNEL_0; c.ledc_timer=LEDC_TIMER_0;
  c.pin_d0=5; c.pin_d1=18; c.pin_d2=19; c.pin_d3=21;
  c.pin_d4=36; c.pin_d5=39; c.pin_d6=34; c.pin_d7=35;
  c.pin_xclk=0; c.pin_pclk=22; c.pin_vsync=25; c.pin_href=23;
  c.pin_sscb_sda=26; c.pin_sscb_scl=27;
  c.pin_pwdn=CAMERA_PWDN; c.pin_reset=-1;
  c.xclk_freq_hz=20000000; c.pixel_format=PIXFORMAT_JPEG;
  c.frame_size=psramFound()?FRAMESIZE_VGA:FRAMESIZE_QVGA;
  c.jpeg_quality=14; c.fb_count=1;
  return esp_camera_init(&c)==ESP_OK;
}

void capture(const String& id,bool testMode) {
  if (!allowed(testMode)) {
    Serial.printf("@IMGERROR %s %s\n",id.c_str(),digitalRead(RAIN_PIN)==WET_LEVEL?"RAIN_DETECTED":"NOT_DARK");
    return;
  }
  capturing=true;
  if (!startCamera()) {
    Serial.printf("@IMGERROR %s CAMERA_INIT_FAILED\n",id.c_str());
    esp_camera_deinit();
    digitalWrite(CAMERA_PWDN,HIGH);
    capturing=false;
    return;
  }
  delay(300);
  for(int n=0;n<3;n++) {
    camera_fb_t* warm=esp_camera_fb_get();
    if(warm) esp_camera_fb_return(warm);
    delay(80);
  }
  camera_fb_t* frame=esp_camera_fb_get();
  if(!frame || frame->format!=PIXFORMAT_JPEG || !allowed(testMode)) {
    if(frame) esp_camera_fb_return(frame);
    Serial.printf("@IMGERROR %s FRAME_OR_CONDITION_ERROR\n",id.c_str());
  } else {
    Serial.printf("@IMGBEGIN %s %u\n",id.c_str(),unsigned(frame->len));
    unsigned char encoded[520];
    for(size_t offset=0;offset<frame->len;offset+=384) {
      size_t count=min(size_t(384),frame->len-offset), length=0;
      mbedtls_base64_encode(encoded,sizeof(encoded),&length,frame->buf+offset,count);
      Serial.print("@IMGDATA ");
      Serial.write(encoded,length); Serial.write('\n');
      delay(1);
    }
    Serial.printf("@IMGEND %s\n",id.c_str());
    esp_camera_fb_return(frame);
  }
  Serial.flush();
  esp_camera_deinit();
  pinMode(CAMERA_PWDN,OUTPUT); digitalWrite(CAMERA_PWDN,HIGH);
  capturing=false;
}

String captureId() {
  char id[37];
  uint32_t a=esp_random(), b=esp_random(), c=esp_random(), d=esp_random();
  snprintf(id,sizeof(id),"%08lx-%04lx-%04lx-%04lx-%04lx%08lx",
    (unsigned long)a,(unsigned long)(b>>16),(unsigned long)((b&0x0fff)|0x4000),
    (unsigned long)((c>>16&0x3fff)|0x8000),(unsigned long)(c&0xffff),(unsigned long)d);
  return String(id);
}

void setup() {
  Serial.begin(115200); Serial.setTimeout(100);
  pinMode(TRAP_LED,OUTPUT); digitalWrite(TRAP_LED,HIGH);
  pinMode(FLASH_LED,OUTPUT); digitalWrite(FLASH_LED,LOW);
  pinMode(CAMERA_PWDN,OUTPUT); digitalWrite(CAMERA_PWDN,HIGH);
  pinMode(LIGHT_PIN,INPUT); pinMode(RAIN_PIN,INPUT); pinMode(SOIL_PIN,INPUT);
  analogReadResolution(12); analogSetPinAttenuation(SOIL_PIN,ADC_11db);
  dht.begin();
  xTaskCreate(trapTask,"trap",2048,nullptr,1,nullptr);
  delay(2000);
  Serial.println("@CAMREADY serial-camera-v1");
  // Automatic photographs every 30 minutes, only while dark and dry.
  lastAutomatic=millis();
}

void loop() {
  while(Serial.available()) {
    char c=Serial.read();
    if(c=='\n') {
      command.trim();
      if(command=="CAMERA_HELLO") Serial.println("@CAMREADY serial-camera-v1");
      if(command.startsWith("PHOTO:") && command.length()==44) {
        String id=command.substring(6,42);
        capture(id,command.charAt(43)=='1');
      }
      command="";
    } else if(command.length()<100) command+=c;
  }
  if(millis()-lastSensor>=5000) {
    lastSensor=millis();
    float t=dht.readTemperature(), h=dht.readHumidity();
    uint32_t sum=0; for(int i=0;i<16;i++) {sum+=analogRead(SOIL_PIN); delay(2);}
    Serial.printf("T=%.1f C | RH=%.1f %% | light=%d | rain=%d | soil=%u\n",
      t,h,digitalRead(LIGHT_PIN),digitalRead(RAIN_PIN),unsigned(sum/16));
  }
  if(millis()-lastAutomatic>=30UL*60UL*1000UL) {
    lastAutomatic=millis();
    if(allowed(false)) capture(captureId(),false);
  }
  delay(2);
}
