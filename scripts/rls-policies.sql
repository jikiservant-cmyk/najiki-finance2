-- NaJiki Finance RLS Policies
-- Run this in your Supabase SQL Editor
-- These policies ensure server-only writes and secure access

-- =============================================
-- ENABLE RLS ON ALL TABLES
-- =============================================
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_notifications ENABLE ROW LEVEL SECURITY;

-- =============================================
-- RLS POLICIES: Service Role Only Writes (for NaJiki backend)
-- =============================================

-- Applications
CREATE POLICY "Service role full access on applications" ON public.applications
  FOR ALL USING (auth.role() = 'service_role');

-- Providers
CREATE POLICY "Service role full access on providers" ON public.providers
  FOR ALL USING (auth.role() = 'service_role');

-- Tenants
CREATE POLICY "Service role full access on tenants" ON public.tenants
  FOR ALL USING (auth.role() = 'service_role');

-- Payment Types
CREATE POLICY "Service role full access on payment_types" ON public.payment_types
  FOR ALL USING (auth.role() = 'service_role');

-- Payment Intents
CREATE POLICY "Service role full access on payment_intents" ON public.payment_intents
  FOR ALL USING (auth.role() = 'service_role');

-- Payment Transactions
CREATE POLICY "Service role full access on payment_transactions" ON public.payment_transactions
  FOR ALL USING (auth.role() = 'service_role');

-- Webhook Logs
CREATE POLICY "Service role full access on webhook_logs" ON public.webhook_logs
  FOR ALL USING (auth.role() = 'service_role');

-- Internal Notifications
CREATE POLICY "Service role full access on internal_notifications" ON public.internal_notifications
  FOR ALL USING (auth.role() = 'service_role');
