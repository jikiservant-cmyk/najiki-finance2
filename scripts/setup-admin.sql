-- Na'jiki Finance Admin Setup
-- Run this in your Supabase SQL Editor

-- =============================================
-- ADMIN PROFILES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS public.admin_profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'super_admin' CHECK (role IN ('super_admin')),
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
  -- Only create profile if the email is pre-approved or manually created
  -- For now, we'll create a profile for every new user with super_admin role
  INSERT INTO public.admin_profiles (id, role)
  VALUES (NEW.id, 'super_admin');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
