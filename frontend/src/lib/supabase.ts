import { createClient } from '@supabase/supabase-js';

// Environment variables configured in Vercel or local .env with project defaults
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://osatxisktphbdropdshv.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_E1sXWWI-6Pm294GziqoLSA_W579eH-z';

// Singleton Supabase client instance
export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    })
  : null;

export const isSupabaseConfigured = (): boolean => {
  return Boolean(supabaseUrl && supabaseAnonKey && supabase);
};
