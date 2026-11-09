#include <Arduino.h>
#include <DHT.h>
#include <WiFi.h>
#include <time.h>
#include "cloud_transport.h"
#include "driver/rtc_io.h"
#include "esp_camera.h"
#include "esp_system.h"

// Wiring from the updated ESP32-CAM sketch. Do not use the SD card on these pins.
constexpr int DHT_PIN = 13, LIGHT_PIN = 15, RAIN_PIN = 14, SOIL_PIN = 2;
constexpr int TRAP_LED_PIN = 33, FLASH_PIN = 4, CAMERA_PWDN = 32;
// External LED: IO12 -> series resistor -> LED -> GND. Keep IO12 low at reset.
// GPIO12 is a boot strap pin; do not connect a circuit that pulls it high at startup.
constexpr int REMOTE_LED_PIN = 12;
constexpr bool REMOTE_LED_ACTIVE_HIGH = true;
constexpr int DARK_LEVEL = 1, WET_LEVEL = 0;
constexpr bool USE_FLASH = false;
constexpr uint32_t SENSOR_INTERVAL_MS = 10000, SOIL_INTERVAL_MS = 60000;
constexpr uint32_t WIFI_RETRY_MS = 15000, LIGHT_DEBOUNCE_MS = 300;
constexpr uint32_t PHOTO_DELAY_MS = 3000, PHOTO_MAX_AGE_MS = 300000;
constexpr uint32_t CAMERA_POLL_MS = 5000, CAMERA_POLL_RETRY_MS = 15000;
constexpr uint32_t MANUAL_PHOTO_MAX_AGE_MS = 60000;
constexpr uint8_t MAX_SEND_ATTEMPTS = 5;
constexpr time_t MIN_VALID_TIME = 1704067200;

DHT dht(DHT_PIN, DHT11);
bool cloudEnabled = false;
bool wifiWasConnected = false;
int soilRaw = -1;
uint32_t lastSensorRead = 0, lastSoilRead = 0, lastWiFiAttempt = 0;

portMUX_TYPE trapLock = portMUX_INITIALIZER_UNLOCKED;
bool capturePending = false, captureInProgress = false;
uint32_t captureDueAt = 0;

String latestTelemetry, pendingTelemetry;
String startupId;
bool startupDone = false;
uint8_t startupAttempts = 0;
uint32_t startupDueAt = 0;
uint8_t telemetryAttempts = 0;
uint32_t telemetryDueAt = 0;

struct PendingPhoto {
  String id;
  uint8_t* jpeg = nullptr;
  bool manual = false;
  size_t size = 0;
  uint8_t attempts = 0;
  uint32_t createdAt = 0;
  uint32_t dueAt = 0;
};

struct ManualCapture {
  String id;
  bool pending = false;
  uint32_t seenAt = 0;
  const char* failure = nullptr;
  uint8_t failureAttempts = 0;
  uint32_t failureDueAt = 0;
};

PendingPhoto photo;
ManualCapture manual;
uint32_t cameraPollDueAt = 0;
uint32_t ledPollDueAt = 0, ledConfirmDueAt = 0, ledRevision = 0;
bool ledApplied = false, ledOn = false;

void pollRemoteLed() {
  if (static_cast<int32_t>(millis() - ledPollDueAt) < 0) return;
  uint32_t revision;
  bool on;
  const int status = cloud::getLed(revision, on);
  ledPollDueAt = millis() + (status == 200 ? 5000 : 15000);
  if (status != 200) return;
  const bool changed = !ledApplied || revision != ledRevision || on != ledOn;
  digitalWrite(REMOTE_LED_PIN, on == REMOTE_LED_ACTIVE_HIGH ? HIGH : LOW);
  ledApplied = true;
  ledRevision = revision;
  ledOn = on;
  if (changed || static_cast<int32_t>(millis() - ledConfirmDueAt) >= 0) {
    const int ack = cloud::confirmLed(revision, on);
    ledConfirmDueAt = millis() + (ack == 200 ? 20000 : 5000);
    if (ack == 409) ledPollDueAt = millis();
    Serial.printf("LED IO12 %s, confirm HTTP %d\n", on ? "ON" : "OFF", ack);
  }
}

String newId() {
  char id[37];
  uint32_t a = esp_random(), b = esp_random(), c = esp_random(), d = esp_random();
  snprintf(id, sizeof(id), "%08lx-%04lx-%04lx-%04lx-%04lx%08lx",
    static_cast<unsigned long>(a), static_cast<unsigned long>(b >> 16),
    static_cast<unsigned long>((b & 0x0fff) | 0x4000),
    static_cast<unsigned long>((c >> 16 & 0x3fff) | 0x8000),
    static_cast<unsigned long>(c & 0xffff), static_cast<unsigned long>(d));
  return String(id);
}

bool isDark() {
  return digitalRead(LIGHT_PIN) == DARK_LEVEL;
}

bool isWet() {
  return digitalRead(RAIN_PIN) == WET_LEVEL;
}

void trapTask(void*) {
  bool candidateDark = isDark(), stableDark = candidateDark;
  uint32_t candidateSince = millis();
  bool armed = false;
  for (;;) {
    uint32_t now = millis();
    bool rawDark = isDark(), wet = isWet();
    if (rawDark != candidateDark) {
      candidateDark = rawDark;
      candidateSince = now;
    }
    bool stable = now - candidateSince >= LIGHT_DEBOUNCE_MS;
    bool becameDark = stable && !stableDark && candidateDark;
    if (stable) {
      stableDark = candidateDark;
    }

    portENTER_CRITICAL(&trapLock);
    if (captureInProgress) {
      armed = false;
    } else if (stable && !stableDark) {
      // Startup in darkness is deliberately unarmed until light is observed.
      armed = true;
      capturePending = false;
    } else if (becameDark) {
      capturePending = armed && !wet;
      captureDueAt = now + PHOTO_DELAY_MS;
      armed = false;
    }
    if (wet) {
      capturePending = false;
    }
    portEXIT_CRITICAL(&trapLock);

    digitalWrite(TRAP_LED_PIN, stableDark && !wet ? LOW : HIGH);
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

void readSoil() {
  // GPIO2 uses ADC2, so the Wi-Fi driver must be stopped before sampling.
  lastSoilRead = millis();
  if (!WiFi.mode(WIFI_OFF)) {
    soilRaw = -1;
    Serial.println("Soil reading skipped because Wi-Fi could not stop.");
    return;
  }
  wifiWasConnected = false;
  delay(30);
  analogRead(SOIL_PIN);
  uint32_t sum = 0;
  for (int i = 0; i < 16; ++i) {
    sum += analogRead(SOIL_PIN);
    delay(2);
  }
  soilRaw = sum / 16;
}

void startWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(CLOUD_WIFI_SSID, CLOUD_WIFI_PASSWORD);
  lastWiFiAttempt = millis();
}

bool maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) {
      configTime(0, 0, "time.google.com", "pool.ntp.org");
      Serial.println("Wi-Fi connected, syncing UTC.");
    }
    wifiWasConnected = true;
    return true;
  }
  wifiWasConnected = false;
  if (millis() - lastWiFiAttempt >= WIFI_RETRY_MS) {
    startWiFi();
  }
  return false;
}

void sampleSensors(time_t observedAt) {
  float temperature = dht.readTemperature(), humidity = dht.readHumidity();
  int light = digitalRead(LIGHT_PIN), rain = digitalRead(RAIN_PIN);
  Serial.printf("T=%.1f C | RH=%.1f %% | light=%d | rain=%d | soil=%d\n",
    temperature, humidity, light, rain, soilRaw);
  if (cloudEnabled && observedAt >= MIN_VALID_TIME) {
    int rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -128;
    String sample;
    if (cloud::makeTelemetry(sample, newId(), observedAt, temperature, humidity, light, rain, soilRaw, rssi)) {
      latestTelemetry = std::move(sample);
    }
  }
}

uint32_t retryDelay(uint8_t attempts) {
  return 1000UL << attempts;
}

void sendStartupNotification() {
  if (startupDone || static_cast<int32_t>(millis() - startupDueAt) < 0) return;
  // Keep this UUID for the entire boot, including Wi-Fi reconnects and retries.
  const int status = cloud::sendStartup(startupId);
  Serial.printf("Startup HTTPS: %d\n", status);
  startupDone = status == 200 || status == 201 || !cloud::retryable(status);
  if (startupAttempts < 6) ++startupAttempts;
  startupDueAt = millis() + retryDelay(startupAttempts);
}

void sendPendingTelemetry() {
  uint32_t now = millis();
  if (pendingTelemetry.isEmpty()) {
    if (latestTelemetry.isEmpty()) {
      return;
    }
    pendingTelemetry = std::move(latestTelemetry);
    telemetryAttempts = 0;
    telemetryDueAt = now;
  }
  if (static_cast<int32_t>(now - telemetryDueAt) < 0) {
    return;
  }
  int status = cloud::sendTelemetry(pendingTelemetry);
  Serial.printf("Telemetry HTTPS: %d\n", status);
  ++telemetryAttempts;
  if (status == 200 || !cloud::retryable(status) || telemetryAttempts >= MAX_SEND_ATTEMPTS) {
    pendingTelemetry = "";
  } else {
    telemetryDueAt = millis() + retryDelay(telemetryAttempts);
  }
}

bool startCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = 5;
  config.pin_d1 = 18;
  config.pin_d2 = 19;
  config.pin_d3 = 21;
  config.pin_d4 = 36;
  config.pin_d5 = 39;
  config.pin_d6 = 34;
  config.pin_d7 = 35;
  config.pin_xclk = 0;
  config.pin_pclk = 22;
  config.pin_vsync = 25;
  config.pin_href = 23;
  config.pin_sccb_sda = 26;
  config.pin_sccb_scl = 27;
  config.pin_pwdn = CAMERA_PWDN;
  config.pin_reset = -1;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  bool psram = psramFound();
  config.frame_size = psram ? FRAMESIZE_VGA : FRAMESIZE_QVGA;
  config.jpeg_quality = 12;
  config.fb_location = psram ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  esp_err_t error = esp_camera_init(&config);
  if (error != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", static_cast<unsigned int>(error));
  }
  return error == ESP_OK;
}

bool canCapture(bool requested) {
  return !isWet() && (requested || USE_FLASH || isDark());
}

const char* queuePhoto(const String* requestId = nullptr) {
  const bool requested = requestId != nullptr;
  if (isWet()) {
    return "rain";
  }
  if ((!requested && !isDark()) || !startCamera()) {
    pinMode(CAMERA_PWDN, OUTPUT);
    digitalWrite(CAMERA_PWDN, HIGH);
    return "camera";
  }
  if (canCapture(requested) && USE_FLASH) {
    digitalWrite(FLASH_PIN, HIGH);
  }
  delay(300);
  for (int i = 0; i < 4 && canCapture(requested); ++i) {
    camera_fb_t* warmup = esp_camera_fb_get();
    if (warmup) {
      esp_camera_fb_return(warmup);
    }
    delay(100);
  }
  camera_fb_t* frame = canCapture(requested) ? esp_camera_fb_get() : nullptr;
  bool valid = frame && frame->format == PIXFORMAT_JPEG && frame->len >= 6
    && frame->len <= cloud::MaxImageBytes && frame->buf[0] == 0xff && frame->buf[1] == 0xd8
    && frame->buf[2] == 0xff && frame->buf[frame->len - 2] == 0xff && frame->buf[frame->len - 1] == 0xd9;
  if (valid && canCapture(requested)) {
    photo.jpeg = static_cast<uint8_t*>(psramFound() ? ps_malloc(frame->len) : malloc(frame->len));
    if (photo.jpeg) {
      memcpy(photo.jpeg, frame->buf, frame->len);
      photo.id = requested ? *requestId : newId();
      photo.manual = requested;
      photo.size = frame->len;
      photo.attempts = 0;
      photo.createdAt = photo.dueAt = millis();
      Serial.printf("JPEG queued: %u bytes\n", static_cast<unsigned int>(photo.size));
    } else {
      Serial.println("JPEG buffer allocation failed.");
    }
  } else {
    Serial.println("JPEG unavailable or capture conditions changed.");
  }
  digitalWrite(FLASH_PIN, LOW);
  if (frame) {
    esp_camera_fb_return(frame);
  }
  esp_camera_deinit();
  pinMode(CAMERA_PWDN, OUTPUT);
  digitalWrite(CAMERA_PWDN, HIGH);
  return photo.jpeg ? nullptr : isWet() ? "rain" : "camera";
}

void scheduleManualFailure(const char* reason) {
  manual.failure = reason;
  manual.failureAttempts = 0;
  manual.failureDueAt = millis();
}

void sendManualFailure() {
  if (!manual.failure || static_cast<int32_t>(millis() - manual.failureDueAt) < 0) {
    return;
  }
  int status = cloud::failCapture(manual.id, manual.failure);
  Serial.printf("Capture failure HTTPS: %d (%s)\n", status, manual.failure);
  ++manual.failureAttempts;
  if (!cloud::retryable(status) || manual.failureAttempts >= MAX_SEND_ATTEMPTS) {
    manual.failure = nullptr;
  } else {
    manual.failureDueAt = millis() + retryDelay(manual.failureAttempts);
  }
}

void pollManualCapture() {
  if (photo.manual || static_cast<int32_t>(millis() - cameraPollDueAt) < 0) {
    return;
  }
  String id;
  const int status = cloud::nextCapture(id);
  const uint32_t now = millis();
  cameraPollDueAt = now + (status == 200 || status == 204 ? CAMERA_POLL_MS : CAMERA_POLL_RETRY_MS);
  if (status == 204) {
    manual.pending = false;
    return;
  }
  if (status != 200) {
    Serial.printf("Capture poll HTTPS: %d\n", status);
    return;
  }
  if (id != manual.id) {
    manual = ManualCapture{};
    manual.id = std::move(id);
    manual.pending = true;
    Serial.println("Manual capture requested.");
  }
  if (manual.pending) {
    manual.seenAt = now;
  }
}

void processCapture() {
  if (photo.jpeg) {
    return;
  }
  uint32_t now = millis();
  if (manual.pending && now - manual.seenAt < 2 * CAMERA_POLL_MS) {
    manual.pending = false;
    if (const char* reason = queuePhoto(&manual.id)) {
      scheduleManualFailure(reason);
    }
    return;
  }
  portENTER_CRITICAL(&trapLock);
  bool due = capturePending && static_cast<int32_t>(now - captureDueAt) >= 0;
  if (due) {
    capturePending = false;
    captureInProgress = true;
  }
  portEXIT_CRITICAL(&trapLock);
  if (due) {
    queuePhoto();
    portENTER_CRITICAL(&trapLock);
    captureInProgress = false;
    portEXIT_CRITICAL(&trapLock);
  }
}

void clearPhoto() {
  free(photo.jpeg);
  photo = PendingPhoto{};
}

void sendPendingPhoto(bool connected) {
  if (!photo.jpeg) {
    return;
  }
  uint32_t now = millis();
  const uint32_t maxAge = photo.manual ? MANUAL_PHOTO_MAX_AGE_MS : PHOTO_MAX_AGE_MS;
  if (now - photo.createdAt >= maxAge) {
    Serial.println("JPEG expired before delivery.");
    if (photo.manual) {
      scheduleManualFailure("upload");
    }
    clearPhoto();
  } else if (connected && static_cast<int32_t>(now - photo.dueAt) >= 0) {
    int status = cloud::sendImage(photo.id, photo.jpeg, photo.size);
    Serial.printf("JPEG HTTPS: %d\n", status);
    ++photo.attempts;
    if (status == 201 || !cloud::retryable(status) || photo.attempts >= MAX_SEND_ATTEMPTS) {
      if (photo.manual && status != 201) {
        scheduleManualFailure("upload");
      }
      clearPhoto();
    } else {
      photo.dueAt = millis() + retryDelay(photo.attempts);
    }
  }
}

void setup() {
  Serial.begin(115200);
  rtc_gpio_hold_dis(GPIO_NUM_12);
  rtc_gpio_deinit(GPIO_NUM_12);
  digitalWrite(REMOTE_LED_PIN, REMOTE_LED_ACTIVE_HIGH ? LOW : HIGH);
  pinMode(REMOTE_LED_PIN, OUTPUT);
  WiFi.persistent(false);
  rtc_gpio_hold_dis(GPIO_NUM_32);
  rtc_gpio_deinit(GPIO_NUM_32);
  rtc_gpio_hold_dis(GPIO_NUM_4);
  rtc_gpio_deinit(GPIO_NUM_4);
  rtc_gpio_hold_dis(GPIO_NUM_33);
  rtc_gpio_deinit(GPIO_NUM_33);
  pinMode(TRAP_LED_PIN, OUTPUT);
  digitalWrite(TRAP_LED_PIN, HIGH);
  pinMode(FLASH_PIN, OUTPUT);
  digitalWrite(FLASH_PIN, LOW);
  pinMode(CAMERA_PWDN, OUTPUT);
  digitalWrite(CAMERA_PWDN, HIGH);
  pinMode(LIGHT_PIN, INPUT);
  pinMode(RAIN_PIN, INPUT);
  pinMode(SOIL_PIN, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);
  dht.begin();
  delay(2000);
  if (xTaskCreate(trapTask, "trap_control", 3072, nullptr, 1, nullptr) != pdPASS) {
    Serial.println("Unable to start trap task.");
    for (;;) {
      delay(1000);
    }
  }
  readSoil();
  cloudEnabled = cloud::configured();
  if (cloudEnabled) {
    startupId = newId();
    startWiFi();
    cameraPollDueAt = millis();
  } else {
    Serial.println("Cloud configuration missing. Sensors are available on Serial.");
  }
  lastSensorRead = millis() - SENSOR_INTERVAL_MS;
}

void loop() {
  portENTER_CRITICAL(&trapLock);
  bool photoDue = capturePending;
  portEXIT_CRITICAL(&trapLock);
  if ((!cloudEnabled || !photoDue) && millis() - lastSoilRead >= SOIL_INTERVAL_MS) {
    readSoil();
    if (cloudEnabled) {
      startWiFi();
    }
  }
  bool wifi = cloudEnabled && maintainWiFi();
  time_t now = time(nullptr);
  bool ready = wifi && now >= MIN_VALID_TIME;
  if (millis() - lastSensorRead >= SENSOR_INTERVAL_MS) {
    lastSensorRead = millis();
    sampleSensors(now);
  }
  if (ready) {
    sendStartupNotification();
    pollRemoteLed();
    sendManualFailure();
    pollManualCapture();
    processCapture();
    sendPendingTelemetry();
  }
  sendPendingPhoto(ready);
  delay(10);
}
