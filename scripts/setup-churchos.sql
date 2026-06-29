-- Run this in your Supabase SQL Editor to set up the churchOs app!

-- 1. First, make sure the providers are there (they probably are already)
INSERT INTO providers (code, name, credentials_ref, is_active)
VALUES 
  ('livepay', 'LivePay', 'LIVEPAY_', true),
  ('mtn', 'MTN MoMo', 'MTN_', true),
  ('airtel', 'Airtel Money', 'AIRTEL_', true),
  ('pesapal', 'Pesapal', 'PESAPAL_', true)
ON CONFLICT (code) DO NOTHING;

-- 2. Add the churchOs application
-- Replace 'https://your-church-app-domain.com' with your actual church app's domain!
INSERT INTO applications (code, name, base_url, webhook_path, internal_secret_ref, is_active)
VALUES 
  ('churchOs', 'Church OS', 'https://your-church-app-domain.com', '/api/payment-completed', 'CHURCHOS_INTERNAL_SECRET', true)
ON CONFLICT (code) DO NOTHING;

-- 3. Add payment types for churchOs
WITH church_os AS (SELECT id FROM applications WHERE code = 'churchOs')
INSERT INTO payment_types (application_id, code, description)
SELECT 
  church_os.id, 
  unnest(ARRAY['deposit', 'donation', 'tithe', 'offering']),
  unnest(ARRAY['Member deposit', 'Donation', 'Tithe payment', 'General offering'])
FROM church_os
ON CONFLICT (application_id, code) DO NOTHING;

-- 4. Add a default tenant for churchOs (replace with your actual church info)
WITH 
  church_os AS (SELECT id FROM applications WHERE code = 'churchOs'),
  livepay AS (SELECT id FROM providers WHERE code = 'livepay')
INSERT INTO tenants (application_id, code, name, default_provider_id, is_active)
SELECT church_os.id, 'main-church', 'Main Church', livepay.id, true
FROM church_os, livepay
ON CONFLICT (application_id, code) DO NOTHING;

-- Verify the setup
SELECT 'Application:' as section, * FROM applications WHERE code = 'churchOs'
UNION ALL
SELECT 'Payment Types:', code, description, '' FROM payment_types WHERE application_id = (SELECT id FROM applications WHERE code = 'churchOs')
UNION ALL
SELECT 'Tenants:', code, name, '' FROM tenants WHERE application_id = (SELECT id FROM applications WHERE code = 'churchOs');
