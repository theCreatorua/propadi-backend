-- Migration v1.44: Phase 3 Multi-Split Paystack Payout Ledger & Transaction Schema
-- Date: August 2026

ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS owner_share_amount NUMERIC(12, 2),
ADD COLUMN IF NOT EXISTS agency_share_amount NUMERIC(12, 2),
ADD COLUMN IF NOT EXISTS propadi_fee_amount NUMERIC(12, 2),
ADD COLUMN IF NOT EXISTS caution_deposit_amount NUMERIC(12, 2),
ADD COLUMN IF NOT EXISTS owner_subaccount_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS agency_subaccount_code VARCHAR(100),
ADD COLUMN IF NOT EXISTS paystack_split_code VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_transactions_owner_subaccount ON public.transactions(owner_subaccount_code);
CREATE INDEX IF NOT EXISTS idx_transactions_agency_subaccount ON public.transactions(agency_subaccount_code);
