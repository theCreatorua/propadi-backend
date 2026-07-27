-- Migration v1.37: Paystack Subaccounts & Split Payment Integration
-- Author: Propadi Engineering Team
-- Date: July 2026

-- 1. Add bank verification and subaccount fields to users table (Landlords & Renters)
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
ADD COLUMN IF NOT EXISTS account_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS paystack_subaccount_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS is_bank_verified BOOLEAN DEFAULT FALSE;

-- 2. Add bank verification and subaccount fields to service_providers table
ALTER TABLE service_providers 
ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
ADD COLUMN IF NOT EXISTS account_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS paystack_subaccount_code VARCHAR(100);

-- 3. Update transactions table to record split details and commissions
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS subaccount_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS platform_commission NUMERIC(12,2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS paystack_fee NUMERIC(12,2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS split_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS reference VARCHAR(100);

-- 4. Create Indexes for subaccount lookups
CREATE INDEX IF NOT EXISTS idx_users_subaccount ON users(paystack_subaccount_code);
CREATE INDEX IF NOT EXISTS idx_providers_subaccount ON service_providers(paystack_subaccount_code);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
