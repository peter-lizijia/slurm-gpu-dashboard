import { createClient } from "@supabase/supabase-js";
import { isDemo } from "../config";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const source = import.meta.env.VITE_DATA_SOURCE ?? "demo";

if (!["demo", "supabase"].includes(source)) {
  throw new Error("VITE_DATA_SOURCE must be demo or supabase.");
}
if (!isDemo && (!url || !key)) {
  throw new Error("Supabase mode requires VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.");
}

// Demo mode never creates a client or contacts a database.
export const supabase = !isDemo && url && key
  ? createClient(url, key, {
      auth: { autoRefreshToken: true, detectSessionInUrl: true, persistSession: true },
    })
  : null;

export function requireSupabase() {
  if (!supabase) throw new Error("Database writes are unavailable in demo mode.");
  return supabase;
}
