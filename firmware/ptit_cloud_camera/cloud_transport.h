#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <StreamString.h>
#include <WiFiClientSecure.h>
#include <cmath>
#include <cstring>
#include <time.h>

#if __has_include("cloud_config.h")
#include "cloud_config.h"
#else
#include "cloud_config.example.h"
#endif

namespace cloud {
constexpr size_t MaxImageBytes = 512 * 1024;
constexpr time_t EarliestSyncedTime = 1704067200;  // 2024-01-01 UTC

inline bool configured() {
  const char* station = CLOUD_DEVICE_ID;
  const char* token = CLOUD_DEVICE_TOKEN;
  const char* url = CLOUD_BASE_URL;
  if (!CLOUD_WIFI_SSID[0] || strncmp(url, "https://", 8) != 0 || !url[8] ||
      strpbrk(url + 8, "/?#@ \t\r\n") ||
      strncmp(CLOUD_ROOT_CA, "-----BEGIN CERTIFICATE-----", 27) != 0) {
    return false;
  }
  constexpr char lowerAlnum[] = "abcdefghijklmnopqrstuvwxyz0123456789";
  constexpr char stationChars[] = "abcdefghijklmnopqrstuvwxyz0123456789-";
  constexpr char tokenChars[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  return station[0] && strchr(lowerAlnum, station[0]) && strlen(station) <= 63 &&
         station[strspn(station, stationChars)] == '\0' &&
         token[0] && token[strspn(token, tokenChars)] == '\0';
}

inline bool validUuid(const String& id) {
  if (id.length() != 36) {
    return false;
  }
  for (size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-') {
        return false;
      }
    } else if (!isHexadecimalDigit(id[i])) {
      return false;
    }
  }
  return true;
}

inline void appendMeasurement(String& measurements, const char* name, const char* value) {
  if (measurements.length()) {
    measurements += ',';
  }
  measurements += '"';
  measurements += name;
  measurements += F("\":");
  measurements += value;
}

inline bool makeTelemetry(String& json, const String& id, time_t observedAt,
                          float temperature, float humidity, int light, int rain, int soil, int rssi) {
  char timestamp[21];
  struct tm utc;
  if (!validUuid(id) || observedAt < EarliestSyncedTime || !gmtime_r(&observedAt, &utc) ||
      strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utc) != 20) {
    return false;
  }
  String measurements;
  if (!measurements.reserve(128) || !json.reserve(384)) {
    return false;
  }
  char value[16];
  if (std::isfinite(temperature) && temperature >= -40 && temperature <= 125) {
    snprintf(value, sizeof(value), "%.1f", temperature);
    appendMeasurement(measurements, "temperature_c", value);
  }
  if (std::isfinite(humidity) && humidity >= 0 && humidity <= 100) {
    snprintf(value, sizeof(value), "%.1f", humidity);
    appendMeasurement(measurements, "air_humidity_pct", value);
  }
  if (light == 0 || light == 1) {
    appendMeasurement(measurements, "light_do", light ? "1" : "0");
  }
  if (rain == 0 || rain == 1) {
    appendMeasurement(measurements, "rain_do", rain ? "1" : "0");
  }
  if (soil >= 0 && soil <= 4095) {
    snprintf(value, sizeof(value), "%d", soil);
    appendMeasurement(measurements, "soil_raw", value);
  }
  if (!measurements.length()) {
    return false;
  }

  json = F("{\"schema_version\":1,\"farm_id\":\"farm-demo\",\"device_id\":\"");
  json += CLOUD_DEVICE_ID;
  json += F("\",\"message_id\":\"");
  json += id;
  json += F("\",\"observed_at\":\"");
  json += timestamp;
  json += F("\",\"measurements\":{");
  json += measurements;
  json += '}';
  if (rssi >= -127 && rssi <= 0) {
    snprintf(value, sizeof(value), "%d", rssi);
    json += F(",\"rssi_dbm\":");
    json += value;
  }
  json += '}';
  return true;
}

class CameraResponse : public StreamString {
 public:
  static constexpr size_t MaxBytes = 128;

  size_t write(uint8_t value) override {
    return write(&value, 1);
  }

  size_t write(const uint8_t* data, size_t size) override {
    return size <= MaxBytes - length() ? StreamString::write(data, size) : 0;
  }
};

inline int send(const char* method, const String& endpoint, const char* contentType,
                const uint8_t* body, size_t size, CameraResponse* reply = nullptr) {
  if (!configured()) {
    return 400;
  }
  String url(CLOUD_BASE_URL);
  url += F("/device/v1/");
  url += CLOUD_DEVICE_ID;
  url += endpoint;

  WiFiClientSecure tls;
  tls.setCACert(CLOUD_ROOT_CA);
  tls.setHandshakeTimeout(5);
  HTTPClient http;
  http.setReuse(false);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.setConnectTimeout(4000);
  http.setTimeout(7000);
  if (!http.begin(tls, url)) {
    return -1;
  }
  http.addHeader("Authorization", String(F("Bearer ")) + CLOUD_DEVICE_TOKEN);
  if (contentType) {
    http.addHeader("Content-Type", contentType);
  }
  // HTTPClient in ESP32 core 2.0.17 takes a mutable pointer but only writes its bytes to the socket.
  int status = http.sendRequest(method, const_cast<uint8_t*>(body), size);
  if (reply && status == 200 &&
      (http.getSize() > static_cast<int>(CameraResponse::MaxBytes) || http.writeToStream(reply) <= 0)) {
    status = HTTPC_ERROR_STREAM_WRITE;
  }
  http.end();
  return status;
}

inline int sendTelemetry(const String& json) {
  return send("POST", "/telemetry", "application/json", reinterpret_cast<const uint8_t*>(json.c_str()),
              json.length());
}

inline int sendStartup(const String& id) {
  if (!validUuid(id)) return 400;
  String json;
  if (!json.reserve(64)) return -1;
  json = F("{\"boot_id\":\"");
  json += id;
  json += F("\"}");
  return send("POST", "/startup", "application/json",
              reinterpret_cast<const uint8_t*>(json.c_str()), json.length());
}

inline int sendImage(const String& id, const uint8_t* data, size_t size) {
  if (!data || size < 4 || !validUuid(id)) {
    return 400;
  }
  if (size > MaxImageBytes) {
    return 413;
  }
  return send("PUT", String(F("/images/")) + id, "image/jpeg", data, size);
}

inline int nextCapture(String& id) {
  CameraResponse reply;
  const int status = send("GET", "/camera/next", nullptr, nullptr, 0, &reply);
  if (status != 200) {
    return status;
  }
  // The Worker replies with compact JSON and the UUID in its first field.
  constexpr char prefix[] = "{\"id\":\"";
  constexpr size_t idStart = sizeof(prefix) - 1;
  constexpr size_t idEnd = idStart + 36;
  if (!reply.startsWith(prefix) || reply.length() < idEnd + 2 || reply[idEnd] != '"' ||
      (reply[idEnd + 1] != '}' && reply[idEnd + 1] != ',') || !reply.endsWith("}")) {
    return HTTPC_ERROR_ENCODING;
  }
  id = reply.substring(idStart, idEnd);
  return validUuid(id) ? 200 : HTTPC_ERROR_ENCODING;
}

inline int getLed(uint32_t& revision, bool& on) {
  CameraResponse reply;
  const int status = send("GET", "/led", nullptr, nullptr, 0, &reply);
  if (status != 200) return status;
  unsigned long parsedRevision = 0;
  unsigned int parsedOn = 0;
  int consumed = 0;
  if (sscanf(reply.c_str(), "{\"revision\":%lu,\"on\":%u}%n", &parsedRevision, &parsedOn, &consumed) != 2 ||
      consumed != static_cast<int>(reply.length()) || parsedRevision > 2147483647UL || parsedOn > 1) {
    return HTTPC_ERROR_ENCODING;
  }
  revision = static_cast<uint32_t>(parsedRevision);
  on = parsedOn == 1;
  return 200;
}

inline int confirmLed(uint32_t revision, bool on) {
  char json[64];
  snprintf(json, sizeof(json), "{\"revision\":%lu,\"on\":%u}",
           static_cast<unsigned long>(revision), on ? 1U : 0U);
  return send("POST", "/led", "application/json", reinterpret_cast<const uint8_t*>(json), strlen(json));
}

inline int failCapture(const String& id, const char* error) {
  if (!validUuid(id)) {
    return 400;
  }
  const String json = String(F("{\"error\":\"")) + error + F("\"}");
  return send("POST", String(F("/camera/")) + id + F("/fail"), "application/json",
              reinterpret_cast<const uint8_t*>(json.c_str()), json.length());
}

inline bool retryable(int status) {
  return status <= 0 || status == 408 || status == 429 || (status >= 500 && status <= 599);
}
}  // namespace cloud
