-- Migration v1.43: Multi-Purpose Bank Accounts Table
-- Date: August 2026

CREATE TABLE IF NOT EXISTS public.user_bank_accounts (
  account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  account_purpose VARCHAR(50) NOT NULL, -- 'landlord', 'agency', 'service_provider', 'general'
  bank_name VARCHAR(100) NOT NULL,
  bank_code VARCHAR(20) NOT NULL,
  account_number VARCHAR(20) NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  paystack_subaccount_code VARCHAR(100) NOT NULL,
  is_verified BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, account_purpose)
);

CREATE INDEX IF NOT EXISTS idx_user_bank_accounts_user ON public.user_bank_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_bank_accounts_purpose ON public.user_bank_accounts(user_id, account_purpose);
