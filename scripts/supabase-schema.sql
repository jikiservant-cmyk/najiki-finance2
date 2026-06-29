-- NKOLA Studio - Supabase Database Schema
-- Run this in your Supabase SQL Editor

-- ==========================================
-- APPLICATIONS TABLE
-- Each app that connects to the Payment Service
-- ==========================================
CREATE TABLE IF NOT EXISTS applications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  webhook_url TEXT,
  api_key TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- PAYMENTS TABLE
-- Central payment record — the Payment Service owns this
-- ==========================================
CREATE TABLE IF NOT EXISTS payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  application_id UUID NOT NULL REFERENCES applications(id),
  tenant_id TEXT,
  customer_id TEXT,
  payment_type TEXT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency TEXT DEFAULT 'UGX',
  status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  provider TEXT,
  provider_reference TEXT,
  provider_response JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- PAYMENT TRANSACTIONS TABLE
-- Audit trail for each payment lifecycle event
-- ==========================================
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- WEBHOOK LOGS TABLE
-- Every webhook received from providers like LivePay
-- ==========================================
CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_id UUID REFERENCES payments(id),
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  signature TEXT,
  verified BOOLEAN DEFAULT false,
  processed BOOLEAN DEFAULT false,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- PORTFOLIO PROJECTS TABLE
-- Design portfolio project data
-- ==========================================
CREATE TABLE IF NOT EXISTS portfolio_projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  year TEXT NOT NULL,
  description TEXT NOT NULL,
  editorial TEXT NOT NULL,
  color_primary TEXT,
  color_secondary TEXT,
  color_tertiary TEXT,
  image_url TEXT,
  sort_order INT DEFAULT 0,
  published BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- INDEXES for performance
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_payments_application_id ON payments(application_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_payment_id ON payment_transactions(payment_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_payment_id ON webhook_logs(payment_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_processed ON webhook_logs(processed);
CREATE INDEX IF NOT EXISTS idx_portfolio_projects_sort_order ON portfolio_projects(sort_order);

-- ==========================================
-- UPDATED_AT TRIGGER
-- Auto-update updated_at on row change
-- ==========================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER portfolio_projects_updated_at
  BEFORE UPDATE ON portfolio_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ==========================================
-- ROW LEVEL SECURITY (RLS)
-- ==========================================
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_projects ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role full access on applications" ON applications
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access on payments" ON payments
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access on payment_transactions" ON payment_transactions
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access on webhook_logs" ON webhook_logs
  FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role full access on portfolio_projects" ON portfolio_projects
  FOR ALL USING (auth.role() = 'service_role');

-- Public can read published portfolio projects
CREATE POLICY "Public read published projects" ON portfolio_projects
  FOR SELECT USING (published = true);

-- ==========================================
-- SEED DATA
-- ==========================================

-- Applications
INSERT INTO applications (id, name, display_name, webhook_url, api_key, active) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'sacco', 'SACCO System', 'https://sacco.example.com/api/internal/payment-completed', 'sacco-secret-key-001', true),
  ('a0000000-0000-0000-0000-000000000002', 'church', 'Church App', 'https://church.example.com/api/internal/payment-completed', 'church-secret-key-002', true),
  ('a0000000-0000-0000-0000-000000000003', 'school', 'School Platform', 'https://school.example.com/api/internal/payment-completed', 'school-secret-key-003', true);

-- Portfolio Projects
INSERT INTO portfolio_projects (id, title, slug, category, year, description, editorial, color_primary, color_secondary, color_tertiary, sort_order) VALUES
  ('p0000000-0000-0000-0000-000000000001', 'SACCO Brand System', 'sacco-brand-system', 'Logo System', '2024',
   'A comprehensive brand identity for a Savings and Credit Cooperative Organization, drawing from East African textile patterns and the geometry of communal finance.',
   'The SACCO brand system was conceived as a visual language of trust and community. The logomark interweaves the letter S with the Adinkra symbol for cooperation, creating a mark that speaks simultaneously to modern finance and ancestral wisdom. The typographic system uses a custom-weighted grotesque paired with a geometric sans, establishing hierarchy across digital and print touchpoints. From member cards to mobile interfaces, every surface tells the same story: your money is safe with us.',
   '#1B4332', '#52B788', '#D8F3DC', 0),
  ('p0000000-0000-0000-0000-000000000002', 'Church Connect Identity', 'church-connect-identity', 'Logo System', '2024',
   'A contemporary visual identity for a digital church platform, balancing reverence with accessibility.',
   'Church Connect required an identity that could exist comfortably on a Sunday bulletin and a push notification. The solution: a logomark derived from the intersection of a cross and a speech bubble — worship meets conversation. The primary typeface carries liturgical weight, while the secondary humanist sans handles digital wayfinding. The color system moves from deep ecclesiastical violet to warm amber, mapping the arc from contemplation to community.',
   '#4A1D96', '#F59E0B', '#FDF6E3', 1),
  ('p0000000-0000-0000-0000-000000000003', 'PayFlow Packaging', 'payflow-packaging', 'Packaging', '2023',
   'Retail packaging design for a fintech hardware product, transforming the unboxing into a statement of financial empowerment.',
   'PayFlow asked: what if opening a payment terminal felt like opening a passport? The packaging system treats each device as a ticket to financial independence. The exterior uses a matte black stock with a single foil-stamped logomark — understated, confident. Inside, a concertina fold reveals operating instructions as a visual journey, with each panel representing a feature.',
   '#0F172A', '#F97316', '#F1F5F9', 2),
  ('p0000000-0000-0000-0000-000000000004', 'Kampala Type Festival', 'kampala-type-festival', 'Posters', '2024',
   'A series of typographic posters for East Africa''s first international type design conference.',
   'The Kampala Type Festival posters operate on a simple premise: let the letters speak for themselves. Each poster isolates a single letterform from a custom display typeface inspired by Luganda orthography and the angularity of bark cloth patterns. The color palette — bright orange against deep charcoal — references marketplace signage of Owino and the painted matatu routes that crisscross the city.',
   '#1C1917', '#EA580C', '#FFF7ED', 3),
  ('p0000000-0000-0000-0000-000000000005', 'Nkola Type Specimen', 'nkola-type-specimen', 'Type Design', '2023',
   'A custom variable typeface designed for financial interfaces, with optical sizes for display and text.',
   'Nkola was born from a specific problem: financial dashboards in East Africa were using typefaces designed for European newspaper layouts. The Regular and Medium weights are built on a generous x-height with open counters, optimized for data tables. The Bold and Black weights push the contrast further, creating dramatic headlines that still carry the geometric DNA of the text sizes.',
   '#18181B', '#A1A1AA', '#FAFAFA', 4),
  ('p0000000-0000-0000-0000-000000000006', 'Harvest Season Posters', 'harvest-season-posters', 'Posters', '2023',
   'A limited-edition poster series celebrating agricultural cooperatives in rural Uganda.',
   'Harvest Season is a suite of six screen-printed posters, each mapping a cooperative crop cycle through abstracted landforms and typographic season markers. Two-color risograph on recycled sugar paper produces slight mis-registration that makes every print unique. Colors derive from actual harvest tones: groundnut brown, millet gold, coffee cherry red.',
   '#365314', '#CA8A04', '#FEF9C3', 5);

-- Generate sample payments for the last 14 days
-- (Run the seed-payments function below or insert manually)
-- For demo purposes, here are a few sample payments:

INSERT INTO payments (id, reference, application_id, tenant_id, customer_id, payment_type, amount, currency, status, provider, provider_reference, completed_at, created_at) VALUES
  ('pay-0001', 'SACCO-DEPOSIT-00001', 'a0000000-0000-0000-0000-000000000001', 'tenant-1', 'cust-12', 'DEPOSIT', 150000, 'UGX', 'SUCCESS', 'LIVEPAY', 'prov-abc123', now() - interval '1 day', now() - interval '1 day'),
  ('pay-0002', 'SACCO-LOAN_REPAYMENT-00002', 'a0000000-0000-0000-0000-000000000001', 'tenant-2', 'cust-34', 'LOAN_REPAYMENT', 350000, 'UGX', 'SUCCESS', 'MTN', 'prov-def456', now() - interval '2 days', now() - interval '2 days'),
  ('pay-0003', 'CHURCH-TITHE-00003', 'a0000000-0000-0000-0000-000000000002', 'tenant-3', 'cust-56', 'TITHE', 100000, 'UGX', 'SUCCESS', 'AIRTEL', 'prov-ghi789', now() - interval '1 day', now() - interval '1 day'),
  ('pay-0004', 'CHURCH-OFFERING-00004', 'a0000000-0000-0000-0000-000000000002', 'tenant-4', 'cust-78', 'OFFERING', 50000, 'UGX', 'SUCCESS', 'PESAPAL', 'prov-jkl012', now() - interval '3 days', now() - interval '3 days'),
  ('pay-0005', 'SCHOOL-TUITION-00005', 'a0000000-0000-0000-0000-000000000003', 'tenant-5', 'cust-90', 'TUITION', 450000, 'UGX', 'SUCCESS', 'LIVEPAY', 'prov-mno345', now() - interval '1 day', now() - interval '1 day'),
  ('pay-0006', 'SACCO-DEPOSIT-00006', 'a0000000-0000-0000-0000-000000000001', 'tenant-6', 'cust-11', 'DEPOSIT', 80000, 'UGX', 'PENDING', 'MTN', 'prov-pqr678', null, now()),
  ('pay-0007', 'CHURCH-TITHE-00007', 'a0000000-0000-0000-0000-000000000002', 'tenant-7', 'cust-22', 'TITHE', 200000, 'UGX', 'FAILED', 'AIRTEL', 'prov-stu901', null, now() - interval '4 days'),
  ('pay-0008', 'SCHOOL-SUBSCRIPTION-00008', 'a0000000-0000-0000-0000-000000000003', 'tenant-8', 'cust-33', 'SUBSCRIPTION', 75000, 'UGX', 'SUCCESS', 'PESAPAL', 'prov-vwx234', now() - interval '5 days', now() - interval '5 days');
