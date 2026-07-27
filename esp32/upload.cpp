#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <DHT.h>

// ==========================================
// 1. SYSTEM CONFIGURATION & PIN INITIALIZATION
// ==========================================
// Network Setup
const char* const WIFI_SSID = "STPI";
const char* const WIFI_PASSWORD = "Admin@123";
const char* const BACKEND_API_URL = "http://192.168.1.138:5000/api/sensor/live";

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

// Automation Edge Thresholds
const float TEMP_CRITICAL_HIGH = 35.0; // °C
const int SOIL_CRITICAL_DRY = 30;       // % Moisture
const int WATER_TANK_EMPTY_LIMIT = 15;  // % Level
const int LIGHT_THRESHOLD_LIMIT = 50;   // % Light threshold for LED

// Telemetry Schedulers
unsigned long lastLocalUpdate = 0;
unsigned long lastCloudUpload = 0;
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

void streamTelemetryToBackend(float t, float h, int s, int l, int w, int score, String pStatus, String fStatus, String ltStatus) {
    if (WiFi.status() != WL_CONNECTED) {
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        return;
    }

    HTTPClient http;
    http.begin(BACKEND_API_URL);
    http.addHeader("Content-Type", "application/json");

    JsonDocument doc;
    doc["temperature"] = t;
    doc["humidity"] = h;
    doc["moisture"] = s;
    doc["light"] = l;
    doc["waterLevel"] = w;
    doc["healthScore"] = score;
    doc["pumpStatus"] = pStatus;
    doc["fanStatus"] = fStatus;
    doc["lightStatus"] = ltStatus;

    String jsonPayload;
    serializeJson(doc, jsonPayload);

    int httpResponseCode = http.POST(jsonPayload);

    if (httpResponseCode == 201 || httpResponseCode == 200) {
        String response = http.getString();
        
        JsonDocument responseDoc;
        DeserializationError error = deserializeJson(responseDoc, response);
        
        if (!error && responseDoc.containsKey("deviceStates")) {
            JsonObject controls = responseDoc["deviceStates"];
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
            
            Serial.printf("[IOT] Linked. Mode:%s | Pump:%s | Fan:%s | Light:%s\n", 
                          currentMode.c_str(), manualPumpStatus.c_str(), manualFanStatus.c_str(), manualLightStatus.c_str());
        }
    } else {
        Serial.printf("[NET] API Post Failure: %s\n", http.errorToString(httpResponseCode).c_str());
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
// 4. MAIN APPLICATION SETUP & ENTRY POINT
// ==========================================
void setup() {
    Serial.begin(115200);
    Serial.println("\n====== Booting AgriShield AI Core ======");

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

    // Initial Safe Defaults
    digitalWrite(PUMP_RELAY_PIN, HIGH);  // Active-Low OFF
    digitalWrite(FAN_RELAY_PIN, HIGH);   // Active-Low OFF
    digitalWrite(LIGHT_RELAY_PIN, LOW);  // Active-High OFF (or HIGH if active low)

    connectToWiFi();
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
        digitalWrite(LIGHT_RELAY_PIN, statusLight == "ON" ? HIGH : LOW); // High turns LED ON
    } else {
        // Automated Ventilation Control
        if (cachedTemp > TEMP_CRITICAL_HIGH) {
            digitalWrite(FAN_RELAY_PIN, LOW); // Relay Active
            statusFan = "ON";
        } else {
            digitalWrite(FAN_RELAY_PIN, HIGH); // Relay Deactivated
        }

        // Automated Irrigation Control
        if (currentSoil < SOIL_CRITICAL_DRY && currentWaterLevel > WATER_TANK_EMPTY_LIMIT) {
            digitalWrite(PUMP_RELAY_PIN, LOW); // Relay Active
            statusPump = "ON";
        } else {
            digitalWrite(PUMP_RELAY_PIN, HIGH); // Relay Deactivated
        }

        // [AUTOMATED GROW LIGHT CONTROL]: Turns ON if light drops below 50%
        if (currentLight > LIGHT_THRESHOLD_LIMIT) {
            digitalWrite(LIGHT_RELAY_PIN, HIGH); // Relay/Pin Active
            statusLight = "OFF";
        } else {
            digitalWrite(LIGHT_RELAY_PIN, LOW);  // Relay/Pin Deactivated
            statusLight = "ON";
        }
    }

    int currentHealthScore = calculateEdgeHealthScore(cachedTemp, cachedHumid, currentSoil, currentWaterLevel);

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