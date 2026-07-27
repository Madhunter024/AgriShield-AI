#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <DHT.h>
#include <LiquidCrystal_I2C.h>

// ==========================================
// 1. SYSTEM CONFIGURATION & PIN INITIALIZATION
// ==========================================
// Network Setup
const char* const WIFI_SSID = "STPI";
const char* const WIFI_PASSWORD = "Admin@123";

// Supabase Cloud Configuration
const char* const SUPABASE_URL = "https://osatxisktphbdropdshv.supabase.co";
const char* const SUPABASE_KEY = "sb_publishable_E1sXWWI-6Pm294GziqoLSA_W579eH-z";
const char* const TELEMETRY_API_URL = "https://osatxisktphbdropdshv.supabase.co/rest/v1/sensor_readings";
const char* const DEVICES_API_URL = "https://osatxisktphbdropdshv.supabase.co/rest/v1/devices?select=*&limit=1";

// Hardware Pins Layout
#define DHTPIN 4
#define SOIL_PIN 34
#define LDR_PIN 35

// AJ-SR04M Waterproof Ultrasonic Sensor Pins
#define ECHO_PIN 32 
#define TRIG_PIN 13 

// Actuators Pins
#define PUMP_RELAY_PIN 26
#define FAN_RELAY_PIN 27
#define LIGHT_RELAY_PIN 14 // Grow Light LED Pin

// Hardware Configurations
#define DHTTYPE DHT22

// 16x2 I2C LCD Display (Default I2C Address 0x27 or 0x3F, SDA=21, SCL=22)
LiquidCrystal_I2C lcd(0x27, 16, 2);

// Automation Edge Thresholds
const float TEMP_CRITICAL_HIGH = 35.0; // °C
const int SOIL_CRITICAL_DRY = 30;       // % Moisture
const int WATER_TANK_EMPTY_LIMIT = 15;  // % Level
const int LIGHT_THRESHOLD_LIMIT = 50;   // % Light threshold for LED

// Telemetry Schedulers
unsigned long lastLocalUpdate = 0;
unsigned long lastCloudUpload = 0;
unsigned long lastLcdUpdate = 0;
int lcdPageIndex = 0;
const unsigned long POLLING_INTERVAL = 2000;    // 2 Seconds for local logs
const unsigned long TRANSMIT_INTERVAL = 2000;   // 2 Seconds for live telemetry upload

// Object Instances
DHT dht(DHTPIN, DHTTYPE);

// Dynamic Actuator State Cache (IoT Synchronization)
String currentMode = "Auto";
String manualPumpStatus = "OFF";
String manualFanStatus = "OFF";
String manualLightStatus = "OFF";

// Non-blocking cached variables
float cachedTemp = 28.0;
float cachedHumid = 60.0;
int currentWaterLevel = 50; 

// ==========================================
// 2. AJ-SR04M WATER LEVEL ENGINE
// ==========================================
int readUltrasonicWaterLevel() {
    const int fullTankCm  = 20;  // Min 20cm due to AJ-SR04M blind spot
    const int emptyTankCm = 80;  // Adjust to your tank depth

    const int totalSamples = 5;
    long validDurationSum = 0;
    int validReadingsCount = 0;

    for (int i = 0; i < totalSamples; i++) {
        digitalWrite(TRIG_PIN, LOW);
        delayMicroseconds(5);
        digitalWrite(TRIG_PIN, HIGH);
        delayMicroseconds(20); 
        digitalWrite(TRIG_PIN, LOW);

        long duration = pulseIn(ECHO_PIN, HIGH, 35000); 

        if (duration > 0 && duration < 35000) {
            validDurationSum += duration;
            validReadingsCount++;
        }
        delay(10); 
    }

    if (validReadingsCount == 0) {
        return -1; 
    }

    long avgDuration = validDurationSum / validReadingsCount;
    int distance = avgDuration * 0.0343 / 2;

    if (distance <= fullTankCm && distance > 0) return 100;
    if (distance >= emptyTankCm) return 0;

    int levelPercent = map(distance, emptyTankCm, fullTankCm, 0, 100);
    return constrain(levelPercent, 0, 100);
}

// ==========================================
// 3. NETWORK & DRIVER SUBSYSTEMS
// ==========================================
void connectToWiFi() {
    Serial.printf("\n[NET] Attempting link to Access Point: %s\n", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    
    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 20) {
        delay(500);
        Serial.print(".");
        retries++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[NET] Connection Established. Assigned IP: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.println("\n[NET] Wifi Timeout. Running in Offline Local Automation Mode.");
    }
}

void fetchDeviceControlState() {
    if (WiFi.status() != WL_CONNECTED) return;

    HTTPClient http;
    http.begin(DEVICES_API_URL);
    http.addHeader("apikey", SUPABASE_KEY);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);

    int httpCode = http.GET();
    if (httpCode == 200) {
        String response = http.getString();
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, response);
        if (!error && doc.is<JsonArray>() && doc.size() > 0) {
            JsonObject controls = doc[0];
            if (controls.containsKey("mode") && !controls["mode"].isNull()) {
                currentMode = controls["mode"].as<String>();
            }
            if (controls.containsKey("pump") && !controls["pump"].isNull()) {
                manualPumpStatus = controls["pump"].as<String>();
            }
            if (controls.containsKey("fan") && !controls["fan"].isNull()) {
                manualFanStatus = controls["fan"].as<String>();
            }
            if (controls.containsKey("light") && !controls["light"].isNull()) {
                manualLightStatus = controls["light"].as<String>();
            }
            Serial.printf("[IOT] Cloud Control Sync -> Mode:%s | Pump:%s | Fan:%s | Light:%s\n", 
                          currentMode.c_str(), manualPumpStatus.c_str(), manualFanStatus.c_str(), manualLightStatus.c_str());
        }
    }
    http.end();
}

void streamTelemetryToBackend(float t, float h, int s, int l, int w, int score, String pStatus, String fStatus, String ltStatus) {
    if (WiFi.status() != WL_CONNECTED) {
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        return;
    }

    // Synchronize latest cloud control settings from Supabase
    fetchDeviceControlState();

    HTTPClient http;
    http.begin(TELEMETRY_API_URL);
    http.addHeader("apikey", SUPABASE_KEY);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Prefer", "return=minimal");

    JsonDocument doc;
    doc["temperature"] = t;
    doc["humidity"] = h;
    doc["moisture"] = s;
    doc["light"] = l;
    doc["water_level"] = w;
    doc["health_score"] = score;
    doc["pump_status"] = pStatus;
    doc["fan_status"] = fStatus;

    String jsonPayload;
    serializeJson(doc, jsonPayload);

    int httpResponseCode = http.POST(jsonPayload);

    if (httpResponseCode == 201 || httpResponseCode == 200) {
        Serial.printf("[NET] Supabase Cloud Telemetry Upload Success! HTTP Code: %d\n", httpResponseCode);
    } else {
        Serial.printf("[NET] Supabase Post Failure: HTTP Code %d - %s\n", httpResponseCode, http.errorToString(httpResponseCode).c_str());
    }
    http.end();
}

int calculateEdgeHealthScore(float t, float h, int s, int w) {
    int score = 100;
    if (t > TEMP_CRITICAL_HIGH || t < 15.0) score -= 20;
    if (h > 80.0) score -= 15;
    if (s < SOIL_CRITICAL_DRY) score -= 25;
    if (w < WATER_TANK_EMPTY_LIMIT) score -= 20;
    return constrain(score, 0, 100);
}

// ==========================================
// 4. 16x2 I2C LCD DISPLAY SUBSYSTEM
// ==========================================
void updateLCDDisplay(float temp, float humid, int soil, int light, int water, String mode, String pump, String fan, String lightState) {
    unsigned long currentClock = millis();
    if (currentClock - lastLcdUpdate < 2500) return; // Refresh LCD every 2.5 seconds
    lastLcdUpdate = currentClock;

    lcd.clear();
    if (lcdPageIndex == 0) {
        // Page 0: Telemetry Sensors (Temp, Humidity, Soil Moisture, Water Level, Light)
        char line0[17];
        char line1[17];
        snprintf(line0, sizeof(line0), "T:%.1fC H:%.0f%%", temp, humid);
        snprintf(line1, sizeof(line1), "S:%d%% W:%d%% L:%d%%", soil, water, light);
        
        lcd.setCursor(0, 0);
        lcd.print(line0);
        lcd.setCursor(0, 1);
        lcd.print(line1);
        lcdPageIndex = 1;
    } else {
        // Page 1: Actuator Relays & Mode Sync
        char line0[17];
        char line1[17];
        snprintf(line0, sizeof(line0), "Mode: %s", mode.c_str());
        snprintf(line1, sizeof(line1), "P:%s F:%s L:%s", pump.c_str(), fan.c_str(), lightState.c_str());
        
        lcd.setCursor(0, 0);
        lcd.print(line0);
        lcd.setCursor(0, 1);
        lcd.print(line1);
        lcdPageIndex = 0;
    }
}

// ==========================================
// 5. MAIN APPLICATION SETUP & ENTRY POINT
// ==========================================
void setup() {
    Serial.begin(115200);
    Serial.println("\n====== Booting AgriShield AI Core ======");

    // 16x2 I2C LCD Initialization
    lcd.init();
    lcd.backlight();
    lcd.setCursor(0, 0);
    lcd.print("AgriShield AI");
    lcd.setCursor(0, 1);
    lcd.print("Core Booting...");

    // Sensor Drivers
    dht.begin();
    pinMode(SOIL_PIN, INPUT);
    pinMode(LDR_PIN, INPUT);
    
    // AJ-SR04M Ultrasonic Sensor Setup
    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);
    digitalWrite(TRIG_PIN, LOW);
    
    // Actuator Pins Setup
    pinMode(PUMP_RELAY_PIN, OUTPUT);
    pinMode(FAN_RELAY_PIN, OUTPUT);
    pinMode(LIGHT_RELAY_PIN, OUTPUT);

    // Initial Safe Defaults (Active-Low Relays: HIGH = OFF, LOW = ON)
    digitalWrite(PUMP_RELAY_PIN, HIGH);  // Active-Low OFF
    digitalWrite(FAN_RELAY_PIN, HIGH);   // Active-Low OFF
    digitalWrite(LIGHT_RELAY_PIN, HIGH); // Active-Low OFF

    connectToWiFi();
    fetchDeviceControlState();
    Serial.println("[SYSTEM] Startup Sequence Confirmed. Active Execution Initiated.");
}

// ==========================================
// 5. CENTRAL RUNTIME AUTOMATION LOOP
// ==========================================
void loop() {
    unsigned long currentClock = millis();

    // 5.1 Non-blocking Sensor Evaluations
    float rawTemp  = dht.readTemperature();
    float rawHumid = dht.readHumidity();
    
    if (!isnan(rawTemp))  cachedTemp = rawTemp;
    if (!isnan(rawHumid)) cachedHumid = rawHumid;

    // Capacitive Moisture Map
    int rawSoil = analogRead(SOIL_PIN);
    int currentSoil = map(rawSoil, 4095, 1200, 0, 100);
    currentSoil = constrain(currentSoil, 0, 100);

    // [INVERTED LDR MAP]: Darkness/No light = 0%, Full Sunlight = 100%
    int rawLDR = analogRead(LDR_PIN);
    int currentLight = map(rawLDR, 4095, 0, 0, 100);
    currentLight = constrain(currentLight, 0, 100);

    // AJ-SR04M Water Level Reading
    int freshWaterReading = readUltrasonicWaterLevel();
    if (freshWaterReading != -1) {
        currentWaterLevel = freshWaterReading; 
    }

    // 5.2 Edge Rules Control Matrix
    String statusFan   = "OFF";
    String statusPump  = "OFF";
    String statusLight = "OFF";

    if (currentMode == "Manual") {
        // Obey user cloud overrides
        statusPump  = manualPumpStatus;
        statusFan   = manualFanStatus;
        statusLight = manualLightStatus;
        
        digitalWrite(PUMP_RELAY_PIN, statusPump == "ON" ? LOW : HIGH);
        digitalWrite(FAN_RELAY_PIN, statusFan == "ON" ? LOW : HIGH);
        digitalWrite(LIGHT_RELAY_PIN, statusLight == "ON" ? LOW : HIGH); // Active-Low Relay: LOW = ON, HIGH = OFF
    } else {
        // Automated Ventilation Control
        if (cachedTemp > TEMP_CRITICAL_HIGH) {
            digitalWrite(FAN_RELAY_PIN, LOW); // Relay Active (ON)
            statusFan = "ON";
        } else {
            digitalWrite(FAN_RELAY_PIN, HIGH); // Relay Deactivated (OFF)
        }

        // Automated Irrigation Control
        if (currentSoil < SOIL_CRITICAL_DRY && currentWaterLevel > WATER_TANK_EMPTY_LIMIT) {
            digitalWrite(PUMP_RELAY_PIN, LOW); // Relay Active (ON)
            statusPump = "ON";
        } else {
            digitalWrite(PUMP_RELAY_PIN, HIGH); // Relay Deactivated (OFF)
        }

        // [AUTOMATED GROW LIGHT CONTROL]: Turns ON if natural light drops below threshold (<50%)
        if (currentLight < LIGHT_THRESHOLD_LIMIT) {
            digitalWrite(LIGHT_RELAY_PIN, LOW); // Relay Active (ON)
            statusLight = "ON";
        } else {
            digitalWrite(LIGHT_RELAY_PIN, HIGH); // Relay Deactivated (OFF)
            statusLight = "OFF";
        }
    }

    int currentHealthScore = calculateEdgeHealthScore(cachedTemp, cachedHumid, currentSoil, currentWaterLevel);

    // Task 0: Update 16x2 I2C LCD Display Screen
    updateLCDDisplay(cachedTemp, cachedHumid, currentSoil, currentLight, currentWaterLevel, currentMode, statusPump, statusFan, statusLight);

    // 5.3 Asynchronous Execution Timers
    // Task 1: Terminal logging output
    if (currentClock - lastLocalUpdate >= POLLING_INTERVAL) {
        Serial.printf("[LOG] Mode:%s | T:%.1fC | H:%.1f%% | S:%d%% | L:%d%% | W:%d%% | LightLED:%s | Score:%d\n", 
                      currentMode.c_str(), cachedTemp, cachedHumid, currentSoil, currentLight, currentWaterLevel, statusLight.c_str(), currentHealthScore);
        lastLocalUpdate = currentClock;
    }

    // Task 2: Dispatch Data Payload Packets directly to React/Node.js backend API
    if (currentClock - lastCloudUpload >= TRANSMIT_INTERVAL) {
        streamTelemetryToBackend(cachedTemp, cachedHumid, currentSoil, currentLight, currentWaterLevel, currentHealthScore, statusPump, statusFan, statusLight);
        lastCloudUpload = currentClock;
    }
}