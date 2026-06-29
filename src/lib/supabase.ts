import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Check if Supabase is properly configured
const isConfigured = supabaseUrl && 
  supabaseAnonKey && 
  !supabaseUrl.includes('your-project') && 
  !supabaseAnonKey.includes('your-anon-key')

// Public client (uses anon key, respects RLS)
export const supabase = isConfigured 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

// Admin client (uses service role key, bypasses RLS) — server-side only
export const supabaseAdmin = isConfigured && supabaseServiceKey && !supabaseServiceKey.includes('your-service-role')
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null

export const isSupabaseConfigured = () => !!isConfigured

// Helper to check connection
export async function checkSupabaseConnection() {
  if (!supabaseAdmin) return { connected: false, error: 'Supabase not configured' }
  try {
    const { error } = await supabaseAdmin.from('applications').select('id').limit(1)
    if (error) return { connected: false, error: error.message }
    return { connected: true, error: null }
  } catch (e) {
    return { connected: false, error: String(e) }
  }
}
