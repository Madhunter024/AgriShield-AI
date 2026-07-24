import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

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
    try {
      // 1. Latest Reading
      const resLatest = await fetch(`${API_URL}/api/sensor/latest`, { headers: getHeaders() });
      if (resLatest.ok) {
        const data = await resLatest.json();
        setLatestReading(data);
      }

      // 2. History logs
      const resHistory = await fetch(`${API_URL}/api/sensor/history?limit=24`, { headers: getHeaders() });
      if (resHistory.ok) {
        const data = await resHistory.json();
        setHistory(data);
      }

      // 3. Active Alerts
      const resAlerts = await fetch(`${API_URL}/api/alerts?status=ACTIVE`, { headers: getHeaders() });
      if (resAlerts.ok) {
        const data = await resAlerts.json();
        setActiveAlerts(data);
      }

      // 4. Device States
      const resDevices = await fetch(`${API_URL}/api/devices`, { headers: getHeaders() });
      if (resDevices.ok) {
        const data = await resDevices.json();
        setDeviceStates(data);
      }

      // 5. Analytics
      await refreshAnalytics();
    } catch (err) {
      console.warn('Backend is unreachable via HTTP. Standing by for connection...', err);
    }
  };

  const refreshAnalytics = async () => {
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
          // Refresh data on re-establishing link
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
                setHistory(prev => {
                  const updated = [reading, ...prev];
                  // Cap cache size
                  if (updated.length > 50) updated.pop();
                  return updated;
                });
                // Keep analytics in sync
                refreshAnalytics();
                break;
              }
              case 'ALERTS_UPDATE': {
                const changes = message.data;
                changes.forEach((change: any) => {
                  if (change.action === 'RAISED') {
                    setActiveAlerts(prev => {
                      // Prevent duplicates
                      if (prev.some(a => a.id === change.alert.id)) return prev;
                      return [change.alert, ...prev];
                    });
                  } else if (change.action === 'RESOLVED') {
                    setActiveAlerts(prev => prev.filter(a => a.id !== change.id));
                  }
                });
                break;
              }
              case 'ALERTS_CHANGED': {
                const { id, status } = message.data;
                if (status === 'RESOLVED' || status === 'ACKNOWLEDGED') {
                  setActiveAlerts(prev => prev.filter(a => a.id !== id));
                }
                break;
              }
              case 'ALERTS_CLEARED': {
                setActiveAlerts([]);
                break;
              }
              case 'DEVICE_STATES_UPDATED': {
                const updatedDevices = message.data as DeviceStates;
                setDeviceStates(updatedDevices);
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
          console.log('[WS] Connection closed. Attempting reconnect...');
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
