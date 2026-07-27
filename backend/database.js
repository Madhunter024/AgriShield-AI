const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');
const User = require('./models/User');
const SensorData = require('./models/SensorData');
const Device = require('./models/Device');
const Alert = require('./models/Alert');
const AutomationRule = require('./models/AutomationRule');
const Report = require('./models/Report');

// Connection string (can be customized via environment variable)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agrishield';

// Supabase Cloud database client
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://osatxisktphbdropdshv.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_E1sXWWI-6Pm294GziqoLSA_W579eH-z';
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

if (supabase) {
  console.log('[DATABASE] Supabase Cloud integration enabled for backend telemetry.');
}

mongoose.set('bufferCommands', false);

mongoose.connect(MONGODB_URI)
  .then(() => console.log(`[DATABASE] Successfully connected to MongoDB at ${MONGODB_URI}`))
  .catch(err => {
    console.error('[DATABASE] MongoDB connection error:', err.message);
    console.warn('[DATABASE] Please ensure your MongoDB container or Atlas instance is running.');
  });

// --- TELEMETRY HELPERS ---

const saveReading = async (reading) => {
  if (supabase) {
    try {
      await supabase.from('sensor_readings').insert({
        temperature: reading.temperature,
        humidity: reading.humidity,
        moisture: reading.moisture,
        light: reading.light,
        water_level: reading.waterLevel,
        health_score: reading.healthScore,
        pump_status: reading.pumpStatus,
        fan_status: reading.fanStatus
      });
    } catch (sErr) {
      console.warn('[DATABASE] Supabase telemetry sync error:', sErr.message);
    }
  }

  const data = new SensorData({
    temperature: reading.temperature,
    humidity: reading.humidity,
    moisture: reading.moisture,
    light: reading.light,
    waterLevel: reading.waterLevel,
    healthScore: reading.healthScore,
    pumpStatus: reading.pumpStatus,
    fanStatus: reading.fanStatus
  });

  try {
    await data.save();
  } catch (err) {
    console.warn('[DATABASE] MongoDB save skipped:', err.message);
  }

  // Keep Device collection in sync with the latest state, but ONLY in Auto mode
  // so we don't overwrite user's manual commands with lagging telemetry data
  const currentDevice = await Device.findOne().sort({ _id: 1 }).lean();
  const isManual = currentDevice && currentDevice.mode === 'Manual';

  if (!isManual && currentDevice) {
    await Device.findByIdAndUpdate(
      currentDevice._id,
      { 
        $set: {
          pump: reading.pumpStatus, 
          fan: reading.fanStatus,
          // If we have light in telemetry we can update device light too
          light: reading.light > 30 ? 'ON' : 'OFF' 
        }
      },
      { new: true }
    );
  } else if (!currentDevice) {
     await Device.create({
          pump: reading.pumpStatus, 
          fan: reading.fanStatus,
          light: reading.light > 30 ? 'ON' : 'OFF' ,
          mode: 'Auto'
     });
  }

  return {
    id: data._id.toString(),
    temperature: data.temperature,
    humidity: data.humidity,
    moisture: data.moisture,
    light: data.light,
    waterLevel: data.waterLevel,
    healthScore: data.healthScore,
    pumpStatus: data.pumpStatus,
    fanStatus: data.fanStatus,
    timestamp: data.createdAt.toISOString()
  };
};

const getRecentReadings = async (limit = 100) => {
  const readings = await SensorData.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return readings.map(r => ({
    id: r._id.toString(),
    temperature: r.temperature,
    humidity: r.humidity,
    moisture: r.moisture,
    light: r.light,
    waterLevel: r.waterLevel,
    healthScore: r.healthScore,
    pumpStatus: r.pumpStatus,
    fanStatus: r.fanStatus,
    timestamp: r.createdAt.toISOString()
  }));
};

const getLatestReading = async () => {
  const r = await SensorData.findOne()
    .sort({ createdAt: -1 })
    .lean();

  if (!r) return null;

  return {
    id: r._id.toString(),
    temperature: r.temperature,
    humidity: r.humidity,
    moisture: r.moisture,
    light: r.light,
    waterLevel: r.waterLevel,
    healthScore: r.healthScore,
    pumpStatus: r.pumpStatus,
    fanStatus: r.fanStatus,
    timestamp: r.createdAt.toISOString()
  };
};

// --- ALERTS HELPERS ---

const saveAlert = async (type, message) => {
  const alert = new Alert({ type, message, status: 'ACTIVE' });
  await alert.save();
  return {
    id: alert._id.toString(),
    type: alert.type,
    message: alert.message,
    status: alert.status,
    timestamp: alert.createdAt.toISOString()
  };
};

const getAlerts = async (status = 'ACTIVE') => {
  const alerts = await Alert.find({ status })
    .sort({ createdAt: -1 })
    .lean();

  return alerts.map(a => ({
    id: a._id.toString(),
    type: a.type,
    message: a.message,
    status: a.status,
    timestamp: a.createdAt.toISOString()
  }));
};

const updateAlertStatus = async (id, status) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error('Invalid alert ID format');
  }
  const alert = await Alert.findByIdAndUpdate(
    id, 
    { status }, 
    { new: true }
  ).lean();

  if (!alert) {
    throw new Error(`Alert with ID ${id} not found.`);
  }

  return { id, status };
};

// --- ANALYTICS & REPORTS HELPERS ---

const getAnalytics = async () => {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const readings = await SensorData.find({ createdAt: { $gte: oneDayAgo } }).lean();

  if (readings.length === 0) {
    return {
      avgTemp: 0, maxTemp: 0, minTemp: 0,
      avgHumid: 0, maxHumid: 0, minHumid: 0,
      avgMoist: 0, maxMoist: 0, minMoist: 0,
      avgLight: 0, maxLight: 0, minLight: 0,
      avgWater: 0, maxWater: 0, minWater: 0,
      avgHealth: 0
    };
  }

  const sums = { temp: 0, humid: 0, moist: 0, light: 0, water: 0, health: 0 };
  const max = { temp: -Infinity, humid: -Infinity, moist: -Infinity, light: -Infinity, water: -Infinity };
  const min = { temp: Infinity, humid: Infinity, moist: Infinity, light: Infinity, water: Infinity };

  readings.forEach(r => {
    sums.temp += r.temperature;
    sums.humid += r.humidity;
    sums.moist += r.moisture;
    sums.light += r.light;
    sums.water += r.waterLevel;
    sums.health += r.healthScore;

    if (r.temperature > max.temp) max.temp = r.temperature;
    if (r.temperature < min.temp) min.temp = r.temperature;

    if (r.humidity > max.humid) max.humid = r.humidity;
    if (r.humidity < min.humid) min.humid = r.humidity;

    if (r.moisture > max.moist) max.moist = r.moisture;
    if (r.moisture < min.moist) min.moist = r.moisture;

    if (r.light > max.light) max.light = r.light;
    if (r.light < min.light) min.light = r.light;

    if (r.waterLevel > max.water) max.water = r.waterLevel;
    if (r.waterLevel < min.water) min.water = r.waterLevel;
  });

  const count = readings.length;

  return {
    avgTemp: sums.temp / count,
    maxTemp: max.temp,
    minTemp: min.temp,
    avgHumid: sums.humid / count,
    maxHumid: max.humid,
    minHumid: min.humid,
    avgMoist: sums.moist / count,
    maxMoist: max.moist,
    minMoist: min.moist,
    avgLight: sums.light / count,
    maxLight: max.light,
    minLight: min.light,
    avgWater: sums.water / count,
    maxWater: max.water,
    minWater: min.water,
    avgHealth: sums.health / count
  };
};

// Generate and save aggregated daily report
const generateDailyReport = async (dateString) => {
  // Find all sensor readings for a specific YYYY-MM-DD
  const startOfDay = new Date(dateString);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateString);
  endOfDay.setHours(23, 59, 59, 999);

  const readings = await SensorData.find({
    createdAt: { $gte: startOfDay, $lte: endOfDay }
  }).lean();

  if (readings.length === 0) return null;

  let tempSum = 0, humidSum = 0, moistSum = 0, lightSum = 0, waterSum = 0;
  let pumpOnIntervals = 0; // count of readings where pump was ON

  readings.forEach(r => {
    tempSum += r.temperature;
    humidSum += r.humidity;
    moistSum += r.moisture;
    lightSum += r.light;
    waterSum += r.waterLevel;
    if (r.pumpStatus === 'ON') pumpOnIntervals++;
  });

  const count = readings.length;
  // Estimate pump runtime: each reading covers about 15 seconds (transmit interval)
  const pumpRuntimeMinutes = (pumpOnIntervals * 15) / 60;
  // Estimate water usage: e.g. pump outputs 10 Liters per minute
  const waterUsageLiters = pumpRuntimeMinutes * 10;

  const report = await Report.findOneAndUpdate(
    { date: dateString },
    {
      avgTemp: tempSum / count,
      avgHumid: humidSum / count,
      avgMoist: moistSum / count,
      avgLight: lightSum / count,
      avgWater: waterSum / count,
      pumpRuntime: pumpRuntimeMinutes,
      waterUsage: waterUsageLiters
    },
    { upsert: true, new: true }
  ).lean();

  return report;
};

// --- DEVICE STATE HELPERS ---

const getDeviceStates = async () => {
  let devices = await Device.findOne().sort({ _id: 1 }).lean();
  if (!devices) {
    // Seed default document
    devices = new Device();
    await devices.save();
    devices = devices.toObject();
  }
  
  // Clear any duplicates
  if (devices && devices._id) {
    await Device.deleteMany({ _id: { $ne: devices._id } });
  }
  return {
    id: devices._id.toString(),
    pump: devices.pump,
    fan: devices.fan,
    light: devices.light,
    mode: devices.mode
  };
};

const updateDeviceStates = async (updates) => {
  if (supabase) {
    try {
      const { data: firstDevice } = await supabase.from('devices').select('id').limit(1).maybeSingle();
      if (firstDevice) {
        await supabase.from('devices').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', firstDevice.id);
      } else {
        await supabase.from('devices').insert({ pump: 'OFF', fan: 'OFF', light: 'OFF', mode: 'Auto', ...updates });
      }
    } catch (sErr) {
      console.warn('[DATABASE] Supabase device sync error:', sErr.message);
    }
  }

  let device = await Device.findOne().sort({ _id: 1 }).lean();
  
  let devices;
  if (!device) {
    devices = new Device(updates);
    await devices.save();
    devices = devices.toObject();
  } else {
    devices = await Device.findByIdAndUpdate(
      device._id,
      { $set: updates },
      { new: true }
    ).lean();
  }
  return {
    id: devices._id.toString(),
    pump: devices.pump,
    fan: devices.fan,
    light: devices.light,
    mode: devices.mode
  };
};

// --- AUTOMATION RULES HELPERS ---

const getRules = async () => {
  const rules = await AutomationRule.find().lean();
  return rules.map(r => ({
    id: r._id.toString(),
    ruleName: r.ruleName,
    conditionParameter: r.conditionParameter,
    operator: r.operator,
    value: r.value,
    actionTarget: r.actionTarget,
    actionValue: r.actionValue,
    isEnabled: r.isEnabled
  }));
};

const saveRule = async (ruleData) => {
  const rule = new AutomationRule(ruleData);
  await rule.save();
  return {
    id: rule._id.toString(),
    ...ruleData,
    isEnabled: rule.isEnabled
  };
};

const updateRule = async (id, updates) => {
  const rule = await AutomationRule.findByIdAndUpdate(
    id,
    { $set: updates },
    { new: true }
  ).lean();
  if (!rule) throw new Error('Rule not found');
  return {
    id: rule._id.toString(),
    ruleName: rule.ruleName,
    conditionParameter: rule.conditionParameter,
    operator: rule.operator,
    value: rule.value,
    actionTarget: rule.actionTarget,
    actionValue: rule.actionValue,
    isEnabled: rule.isEnabled
  };
};

module.exports = {
  mongoose,
  saveReading,
  getRecentReadings,
  getLatestReading,
  saveAlert,
  getAlerts,
  updateAlertStatus,
  getAnalytics,
  generateDailyReport,
  getDeviceStates,
  updateDeviceStates,
  getRules,
  saveRule,
  updateRule
};
