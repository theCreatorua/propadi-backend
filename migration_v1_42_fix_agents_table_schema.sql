-- Migration v1.42: Ensure agents table schema and columns exist
CREATE TABLE IF NOT EXISTS public.agents (
  agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE UNIQUE,
  agency_name VARCHAR(255) NOT NULL,
  cac_registration_number VARCHAR(100),
  license_number VARCHAR(100),
  operating_state VARCHAR(100) DEFAULT 'Lagos',
  commission_rate NUMERIC(5,2) DEFAULT 5.00,
  verification_status VARCHAR(50) DEFAULT 'pending',
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Defensive column additions in case agents table pre-existed with different columns
ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(user_id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS agency_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS cac_registration_number VARCHAR(100),
ADD COLUMN IF NOT EXISTS license_number VARCHAR(100),
ADD COLUMN IF NOT EXISTS operating_state VARCHAR(100) DEFAULT 'Lagos',
ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 5.00,
ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Ensure unique index on user_id for ON CONFLICT resolution
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_id ON public.agents(user_id);
