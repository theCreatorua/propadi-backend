-- Migration v1.41: Phase 2 Post-Audit Agent Delegation, Verification & Digital Agreement Schema

ALTER TABLE public.agent_assignments
ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES public.users(user_id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS commission_override NUMERIC(5, 2),
ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5, 2) DEFAULT 5.00,
ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS owner_signed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS agent_signed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS decline_reason TEXT,
ADD COLUMN IF NOT EXISTS contract_terms JSONB;

-- Drop status check constraint if it restricts Phase 2 statuses
ALTER TABLE public.agent_assignments DROP CONSTRAINT IF EXISTS agent_assignments_status_check;

ALTER TABLE public.agent_assignments
ADD CONSTRAINT agent_assignments_status_check CHECK (
  status IN (
    'pending_acceptance',
    'accepted_pending_signature',
    'active',
    'declined',
    'terminated'
  )
);
