-- Na'jiki Finance Admin Setup
-- Run this in your Supabase SQL Editor

-- =============================================
-- ADMIN PROFILES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.admin_profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('super_admin', 'admin', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- RLS FOR ADMIN PROFILES
-- =============================================
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile" ON public.admin_profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Service role can manage admin profiles" ON public.admin_profiles
  FOR ALL USING (auth.role() = 'service_role');

-- =============================================
-- TRIGGER TO CREATE PROFILE ON USER SIGNUP
-- =============================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- Default to 'viewer' with no elevated administrative privileges.
  -- Elevation to 'super_admin' requires manual promotion by an existing super admin.
  INSERT INTO public.admin_profiles (id, role)
  VALUES (NEW.id, 'viewer');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
