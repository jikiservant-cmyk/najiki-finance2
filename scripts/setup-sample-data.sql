-- NaJiki Finance Sample Data Setup
-- Run this in your Supabase SQL Editor to add all sample data

-- =============================================
-- 1. Create Providers
-- =============================================
INSERT INTO public.providers (id, code, name, "credentialsRef", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'livepay', 'LivePay', 'LIVEPAY_', true, NOW(), NOW()),
  (gen_random_uuid(), 'mtn', 'MTN MoMo', 'MTN_', true, NOW(), NOW()),
  (gen_random_uuid(), 'airtel', 'Airtel Money', 'AIRTEL_', true, NOW(), NOW()),
  (gen_random_uuid(), 'pesapal', 'Pesapal', 'PESAPAL_', true, NOW(), NOW());

-- =============================================
-- 2. Create Applications
-- =============================================
INSERT INTO public.applications (id, code, name, "baseUrl", "webhookPath", "internalSecretRef", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'sacco', 'SACCO Platform', 'https://sacco.yourdomain.com', '/api/internal/payment-completed', 'SACCO_INTERNAL_SECRET', true, NOW(), NOW()),
  (gen_random_uuid(), 'church', 'Church App', 'https://church.yourdomain.com', '/api/internal/payment-completed', 'CHURCH_INTERNAL_SECRET', true, NOW(), NOW()),
  (gen_random_uuid(), 'school', 'School Platform', 'https://school.yourdomain.com', '/api/internal/payment-completed', 'SCHOOL_INTERNAL_SECRET', true, NOW(), NOW());

-- =============================================
-- 3. Create Tenants
-- =============================================
-- First get the application IDs
WITH apps AS (
  SELECT id, code FROM public.applications
),
providers AS (
  SELECT id, code FROM public.providers
)
INSERT INTO public.tenants (id, "applicationId", code, "appType", name, "defaultProviderId", "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'sacco'), 'abc-sacco', 'sacco', 'ABC SACCO', (SELECT id FROM providers WHERE code = 'livepay'), true, NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'sacco'), 'xyz-sacco', 'sacco', 'XYZ SACCO', (SELECT id FROM providers WHERE code = 'mtn'), true, NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'church'), 'grace-church', 'church', 'Grace Community Church', (SELECT id FROM providers WHERE code = 'livepay'), true, NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'school'), 'hope-academy', 'school', 'Hope Academy', (SELECT id FROM providers WHERE code = 'pesapal'), true, NOW(), NOW());

-- =============================================
-- 4. Create Payment Types
-- =============================================
WITH apps AS (
  SELECT id, code FROM public.applications
)
INSERT INTO public."paymentTypes" (id, "applicationId", code, description, "createdAt")
VALUES
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'sacco'), 'deposit', 'Member savings deposit', NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'sacco'), 'loan_repayment', 'Loan repayment', NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'sacco'), 'account_activation', 'Account activation fee', NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'church'), 'tithe', 'Tithe payment', NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'church'), 'offering', 'General offering', NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'school'), 'tuition', 'Tuition fee', NOW()),
  (gen_random_uuid(), (SELECT id FROM apps WHERE code = 'school'), 'subscription', 'Platform subscription', NOW());
