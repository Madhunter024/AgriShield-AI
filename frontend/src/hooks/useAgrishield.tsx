import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

// Interfaces matching backend payload models
export interface SensorReading {
  id: number;
  temperature: number;
  humidity: number;
  moisture: number;
  light: number;
  waterLevel: number;
  healthScore: number;
  pumpStatus: 'ON' | 'OFF';
  fanStatus: 'ON' | 'OFF';
  timestamp: string;
}

export interface SystemAlert {
  id: number;
  type: string;
  message: string;
  status: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
  timestamp: string;
}

export interface DeviceStates {
  pump: 'ON' | 'OFF';
  fan: 'ON' | 'OFF';
  light: 'ON' | 'OFF';
  mode: 'Auto' | 'Manual';
}

export interface AnalyticsData {
  avgTemp: number;
  maxTemp: number;
  minTemp: number;
  avgHumid: number;
  maxHumid: number;
  minHumid: number;
  avgMoist: number;
  maxMoist: number;
  minMoist: number;
  avgLight: number;
  maxLight: number;
  minLight: number;
  avgWater: number;
  maxWater: number;
  minWater: number;
  avgHealth: number;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: 'Admin' | 'Farmer';
}

interface AgrishieldContextType {
  latestReading: SensorReading | null;
  history: SensorReading[];
  activeAlerts: SystemAlert[];
  analytics: AnalyticsData | null;
  deviceStates: DeviceStates | null;
  isConnected: boolean;
  user: UserProfile | null;
  token: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  register: (name: string, email: string, password: string, role: string) => Promise<boolean>;
  logout: () => void;
  resolveAlert: (id: number) => Promise<void>;
  clearAllAlerts: () => Promise<void>;
  refreshAnalytics: () => Promise<void>;
  updateDevices: (updates: Partial<DeviceStates>) => Promise<void>;
}

const AgrishieldContext = createContext<AgrishieldContextType | undefined>(undefined);

const DEFAULT_READING: SensorReading = {
  id: 1,
  temperature: 26.5,
  humidity: 55,
  moisture: 48,
  light: 72,
  waterLevel: 85,
  healthScore: 92,
  pumpStatus: 'OFF',
  fanStatus: 'OFF',
  timestamp: new Date().toISOString()
};

const DEFAULT_DEVICES: DeviceStates = {
  pump: 'OFF',
  fan: 'OFF',
  light: 'OFF',
  mode: 'Auto'
};

const DEFAULT_ANALYTICS: AnalyticsData = {
  avgTemp: 24.6,
  maxTemp: 29.2,
  minTemp: 20.1,
  avgHumid: 67,
  maxHumid: 82,
  minHumid: 51,
  avgMoist: 48,
  maxMoist: 65,
  minMoist: 32,
  avgLight: 72,
  maxLight: 95,
  minLight: 10,
  avgWater: 78,
  maxWater: 98,
  minWater: 40,
  avgHealth: 92
};

export function AgrishieldProvider({ children }: { children: ReactNode }) {
  const [latestReading, setLatestReading] = useState<SensorReading | null>(DEFAULT_READING);
  const [history, setHistory] = useState<SensorReading[]>([]);
  const [activeAlerts, setActiveAlerts] = useState<SystemAlert[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(DEFAULT_ANALYTICS);
  const [deviceStates, setDeviceStates] = useState<DeviceStates | null>(DEFAULT_DEVICES);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  
  const [user, setUser] = useState<UserProfile | null>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('agrishield_user');
      return stored ? JSON.parse(stored) : null;
    }
    return null;
  });
  
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('agrishield_token');
    }
    return null;
  });

  // Dynamic network resolution
  const envApiUrl = import.meta.env.VITE_API_URL;
  const envWsUrl = import.meta.env.VITE_WS_URL;

  const isBrowser = typeof window !== 'undefined';
  const isHttps = isBrowser && window.location.protocol === 'https:';
  const host = isBrowser ? window.location.hostname : 'localhost';
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';

  const API_URL = envApiUrl || (isLocalHost ? `http://${host}:5000` : '');
  const WS_URL = envWsUrl || (isLocalHost ? `ws://${host}:5000` : '');

  const getHeaders = () => {
    const savedToken = token || (typeof window !== 'undefined' ? localStorage.getItem('agrishield_token') : null);
    return {
      'Content-Type': 'application/json',
      ...(savedToken ? { 'Authorization': `Bearer ${savedToken}` } : {})
    };
  };

  const verifyToken = async (savedToken: string) => {
    try {
      const res = await fetch(`${API_URL}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${savedToken}` }
      });
      if (res.ok) {
        const userData = await res.json();
        setUser(userData);
        localStorage.setItem('agrishield_user', JSON.stringify(userData));
      } else {
        logout();
      }
    } catch (err) {
      console.warn('Auth server unreachable during verification.');
    }
  };

  const login = async (email: string, password: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      
      localStorage.setItem('agrishield_token', data.token);
      localStorage.setItem('agrishield_user', JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
      return true;
    } catch (err: any) {
      throw new Error(err.message || 'Network error');
    }
  };

  const register = async (name: string, email: string, password: string, role: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, role })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      
      localStorage.setItem('agrishield_token', data.token);
      localStorage.setItem('agrishield_user', JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
      return true;
    } catch (err: any) {
      throw new Error(err.message || 'Network error');
    }
  };

  const logout = () => {
    localStorage.removeItem('agrishield_token');
    localStorage.removeItem('agrishield_user');
    setToken(null);
    setUser(null);
  };

  // Fetch all initial data states
  const fetchInitialData = async () => {
    // A. Priority 1: Supabase Cloud Database Integration
    if (isSupabaseConfigured() && supabase) {
      try {
        // 1. Latest Reading
        const { data: latestData } = await supabase
          .from('sensor_readings')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestData) {
          setLatestReading({
            id: latestData.id,
            temperature: Number(latestData.temperature),
            humidity: Number(latestData.humidity),
            moisture: Number(latestData.moisture),
            light: Number(latestData.light),
            waterLevel: Number(latestData.water_level),
            healthScore: Number(latestData.health_score || 100),
            pumpStatus: latestData.pump_status || 'OFF',
            fanStatus: latestData.fan_status || 'OFF',
            timestamp: latestData.created_at
          });
        }

        // 2. History logs
        const { data: historyData } = await supabase
          .from('sensor_readings')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(24);

        if (historyData && historyData.length > 0) {
          const mappedHistory: SensorReading[] = historyData.map(item => ({
            id: item.id,
            temperature: Number(item.temperature),
            humidity: Number(item.humidity),
            moisture: Number(item.moisture),
            light: Number(item.light),
            waterLevel: Number(item.water_level),
            healthScore: Number(item.health_score || 100),
            pumpStatus: item.pump_status || 'OFF',
            fanStatus: item.fan_status || 'OFF',
            timestamp: item.created_at
          }));
          setHistory(mappedHistory);
        }

        // 3. Active Alerts
        const { data: alertsData } = await supabase
          .from('alerts')
          .select('*')
          .eq('status', 'ACTIVE')
          .order('created_at', { ascending: false });

        if (alertsData) {
          const mappedAlerts: SystemAlert[] = alertsData.map(item => ({
            id: item.id,
            type: item.type,
            message: item.message,
            status: item.status,
            timestamp: item.created_at
          }));
          setActiveAlerts(mappedAlerts);
        }

        // 4. Device States
        const { data: deviceData } = await supabase
          .from('devices')
          .select('*')
          .limit(1)
          .maybeSingle();

        if (deviceData) {
          setDeviceStates({
            pump: deviceData.pump || 'OFF',
            fan: deviceData.fan || 'OFF',
            light: deviceData.light || 'OFF',
            mode: deviceData.mode || 'Auto'
          });
        }

        setIsConnected(true);
        return;
      } catch (err) {
        console.warn('Supabase fetch failed, trying HTTP backend fallback...', err);
      }
    }

    // B. Priority 2: HTTP Backend Fallback (Local Node.js Server)
    if (!API_URL) return;
    try {
      const resLatest = await fetch(`${API_URL}/api/sensor/latest`, { headers: getHeaders() });
      if (resLatest.ok) {
        const data = await resLatest.json();
        setLatestReading(data);
      }

      const resHistory = await fetch(`${API_URL}/api/sensor/history?limit=24`, { headers: getHeaders() });
      if (resHistory.ok) {
        const data = await resHistory.json();
        setHistory(data);
      }

      const resAlerts = await fetch(`${API_URL}/api/alerts?status=ACTIVE`, { headers: getHeaders() });
      if (resAlerts.ok) {
        const data = await resAlerts.json();
        setActiveAlerts(data);
      }

      const resDevices = await fetch(`${API_URL}/api/devices`, { headers: getHeaders() });
      if (resDevices.ok) {
        const data = await resDevices.json();
        setDeviceStates(data);
      }

      await refreshAnalytics();
    } catch (err) {
      console.warn('Backend is unreachable via HTTP. Standing by for connection...', err);
    }
  };

  const refreshAnalytics = async () => {
    if (!API_URL) return;
    try {
      const resAnalytics = await fetch(`${API_URL}/api/sensor/analytics`, { headers: getHeaders() });
      if (resAnalytics.ok) {
        const data = await resAnalytics.json();
        setAnalytics(data);
      }
    } catch (err) {
      console.error('Failed to fetch analytics:', err);
    }
  };

  const resolveAlert = async (id: number) => {
    if (isSupabaseConfigured() && supabase) {
      try {
        await supabase.from('alerts').update({ status: 'RESOLVED' }).eq('id', id);
        setActiveAlerts(prev => prev.filter(alert => alert.id !== id));
        return;
      } catch (err) {
        console.error('Supabase resolve alert failed:', err);
      }
    }

    if (!API_URL) return;
    try {
      const res = await fetch(`${API_URL}/api/alerts/${id}`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ status: 'RESOLVED' })
      });
      if (res.ok) {
        setActiveAlerts(prev => prev.filter(alert => alert.id !== id));
      }
    } catch (err) {
      console.error('Failed to resolve alert:', err);
    }
  };

  const clearAllAlerts = async () => {
    if (isSupabaseConfigured() && supabase) {
      try {
        await supabase.from('alerts').update({ status: 'RESOLVED' }).eq('status', 'ACTIVE');
        setActiveAlerts([]);
        return;
      } catch (err) {
        console.error('Supabase clear alerts failed:', err);
      }
    }

    if (!API_URL) return;
    try {
      const res = await fetch(`${API_URL}/api/alerts/clear`, { 
        method: 'POST',
        headers: getHeaders()
      });
      if (res.ok) {
        setActiveAlerts([]);
      }
    } catch (err) {
      console.error('Failed to clear alerts:', err);
    }
  };

  const updateDevices = async (updates: Partial<DeviceStates>) => {
    // Update local state immediately for UI responsiveness
    setDeviceStates(prev => prev ? { ...prev, ...updates } : { pump: 'OFF', fan: 'OFF', light: 'OFF', mode: 'Auto', ...updates });

    if (isSupabaseConfigured() && supabase) {
      try {
        const { data: firstDevice } = await supabase.from('devices').select('id').limit(1).maybeSingle();
        if (firstDevice) {
          await supabase.from('devices').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', firstDevice.id);
        } else {
          await supabase.from('devices').insert({ pump: 'OFF', fan: 'OFF', light: 'OFF', mode: 'Auto', ...updates });
        }
        return;
      } catch (err) {
        console.error('Supabase device update error:', err);
      }
    }

    if (!API_URL) return;
    try {
      const res = await fetch(`${API_URL}/api/devices`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        const data = await res.json();
        setDeviceStates(data);
      }
    } catch (err) {
      console.error('Failed to update device states:', err);
    }
  };

  useEffect(() => {
    const savedToken = localStorage.getItem('agrishield_token');
    if (savedToken) {
      verifyToken(savedToken);
    }

    // Fetch initial records on component mount
    fetchInitialData();

    // 1. SUPABASE REALTIME SUBSCRIPTIONS
    if (isSupabaseConfigured() && supabase) {
      console.log('[SUPABASE] Initializing Realtime channels...');
      const channel = supabase.channel('agrishield-db-changes')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_readings' }, (payload) => {
          const raw = payload.new as any;
          if (raw) {
            const reading: SensorReading = {
              id: raw.id,
              temperature: Number(raw.temperature),
              humidity: Number(raw.humidity),
              moisture: Number(raw.moisture),
              light: Number(raw.light),
              waterLevel: Number(raw.water_level),
              healthScore: Number(raw.health_score || 100),
              pumpStatus: raw.pump_status || 'OFF',
              fanStatus: raw.fan_status || 'OFF',
              timestamp: raw.created_at
            };
            setLatestReading(reading);
            setHistory(prev => [reading, ...prev].slice(0, 50));
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, (payload) => {
          const raw = payload.new as any;
          if (raw) {
            setDeviceStates({
              pump: raw.pump || 'OFF',
              fan: raw.fan || 'OFF',
              light: raw.light || 'OFF',
              mode: raw.mode || 'Auto'
            });
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, () => {
          supabase.from('alerts').select('*').eq('status', 'ACTIVE').order('created_at', { ascending: false })
            .then(({ data }) => {
              if (data) {
                setActiveAlerts(data.map(item => ({
                  id: item.id,
                  type: item.type,
                  message: item.message,
                  status: item.status,
                  timestamp: item.created_at
                })));
              }
            });
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            console.log('[SUPABASE] Realtime channels active.');
            setIsConnected(true);
          }
        });

      return () => {
        supabase.removeChannel(channel);
      };
    }

    // 2. WEBSOCKET FALLBACK (FOR LOCAL NODE.JS SERVER)
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connectWebSocket = () => {
      if (!WS_URL) return;
      try {
        console.log(`[WS] Connecting to ${WS_URL}...`);
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
          console.log('[WS] Connected to AgriShield Backend.');
          setIsConnected(true);
          fetchInitialData();
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            switch (message.type) {
              case 'INIT': {
                const { latestReading: initLatest, activeAlerts: initAlerts, deviceStates: initDevices } = message.data;
                if (initLatest) setLatestReading(initLatest);
                if (initAlerts) setActiveAlerts(initAlerts);
                if (initDevices) setDeviceStates(initDevices);
                break;
              }
              case 'TELEMETRY': {
                const reading = message.data as SensorReading;
                setLatestReading(reading);
                setHistory(prev => [reading, ...prev].slice(0, 50));
                refreshAnalytics();
                break;
              }
              case 'DEVICE_STATES_UPDATED': {
                setDeviceStates(message.data as DeviceStates);
                break;
              }
              default:
                break;
            }
          } catch (err) {
            console.error('[WS] Error processing message:', err);
          }
        };

        ws.onclose = () => {
          setIsConnected(false);
          if (isLocalHost) {
            reconnectTimeout = setTimeout(connectWebSocket, 3000);
          }
        };

        ws.onerror = (err) => {
          console.warn('[WS] WebSocket error:', err);
          if (ws) ws.close();
        };
      } catch (err) {
        console.warn('[WS] WebSocket initialization skipped:', err);
      }
    };

    connectWebSocket();

    return () => {
      if (ws) ws.close();
      clearTimeout(reconnectTimeout);
    };
  }, []);

  return (
    <AgrishieldContext.Provider value={{
      latestReading,
      history,
      activeAlerts,
      analytics,
      deviceStates,
      isConnected,
      user,
      token,
      login,
      register,
      logout,
      resolveAlert,
      clearAllAlerts,
      refreshAnalytics,
      updateDevices
    }}>
      {children}
    </AgrishieldContext.Provider>
  );
}

export function useAgrishield() {
  const context = useContext(AgrishieldContext);
  if (context === undefined) {
    throw new Error('useAgrishield must be used within an AgrishieldProvider');
  }
  return context;
}
