-- SUPER SIMPLE CHURCHOS SETUP
-- Copy-paste this directly into your Supabase SQL Editor!

-- Step 1: Insert churchOs application
-- NOTE: Replace 'https://your-church-app-domain.com' with your actual church app's domain!
INSERT INTO applications (code, name, base_url, webhook_path, is_active)
VALUES ('churchOs', 'Church OS', 'https://your-church-app-domain.com', '/api/payment-completed', true)
ON CONFLICT (code) DO NOTHING;

-- Step 2: Insert payment types for churchOs
WITH church_os AS (SELECT id FROM applications WHERE code = 'churchOs')
INSERT INTO payment_types (application_id, code, description)
SELECT church_os.id, 'deposit', 'Member Deposit' FROM church_os
UNION ALL
SELECT church_os.id, 'donation', 'Donation' FROM church_os
UNION ALL
SELECT church_os.id, 'tithe', 'Tithe' FROM church_os
UNION ALL
SELECT church_os.id, 'offering', 'Offering' FROM church_os
ON CONFLICT (application_id, code) DO NOTHING;

-- Step 3: Insert main church tenant
WITH 
  church_os AS (SELECT id FROM applications WHERE code = 'churchOs'),
  livepay AS (SELECT id FROM providers WHERE code = 'livepay')
INSERT INTO tenants (application_id, code, name, default_provider_id, is_active)
SELECT church_os.id, 'main-church', 'Main Church', livepay.id, true
FROM church_os, livepay
ON CONFLICT (application_id, code) DO NOTHING;

-- Verify what we just created!
SELECT 'Applications:' as section, code, name, is_active FROM applications WHERE code = 'churchOs'
UNION ALL
SELECT 'Payment Types:', code, description, '' FROM payment_types WHERE application_id = (SELECT id FROM applications WHERE code = 'churchOs')
UNION ALL
SELECT 'Tenants:', code, name, '' FROM tenants WHERE application_id = (SELECT id FROM applications WHERE code = 'churchOs');
