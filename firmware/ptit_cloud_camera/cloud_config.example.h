#pragma once

// Copy to cloud_config.h and fill in the site values before building for deployment.
// Use the HTTPS origin only, without a path or trailing slash.
constexpr char CLOUD_BASE_URL[] = "";
constexpr char CLOUD_DEVICE_ID[] = "station-001";
constexpr char CLOUD_DEVICE_TOKEN[] = "";
constexpr char CLOUD_WIFI_SSID[] = "";
constexpr char CLOUD_WIFI_PASSWORD[] = "";

// Replace with the PEM root CA that validates the deployed HTTPS certificate.
// Use a raw string with no newline before -----BEGIN CERTIFICATE-----.
constexpr char CLOUD_ROOT_CA[] = "";
