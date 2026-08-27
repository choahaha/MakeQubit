import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** null이면 로깅이 조용히 비활성화된다 (수업은 계속 진행되어야 하므로). */
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

export const loggingEnabled = Boolean(supabase);
