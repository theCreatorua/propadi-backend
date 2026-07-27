-- Migration v1.38: Agent & Agency Portal (B2B Multi-Property Management)

-- 1. Agents / Agencies Table
CREATE TABLE IF NOT EXISTS agents (
  agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE UNIQUE,
  agency_name VARCHAR(255) NOT NULL,
  cac_registration_number VARCHAR(100),
  license_number VARCHAR(100),
  operating_state VARCHAR(100) DEFAULT 'Lagos',
  commission_rate NUMERIC(5,2) DEFAULT 5.00,
  verification_status VARCHAR(50) DEFAULT 'pending', -- pending, approved, rejected
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Agent Property Assignments Table
CREATE TABLE IF NOT EXISTS agent_assignments (
  assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  commission_override NUMERIC(5,2),
  status VARCHAR(50) DEFAULT 'pending_acceptance', -- active, pending_acceptance, revoked
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id, property_id)
);

-- Indexing for fast agent portfolio lookup
CREATE INDEX IF NOT EXISTS idx_agent_assignments_agent ON agent_assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_assignments_owner ON agent_assignments(owner_id);
CREATE INDEX IF NOT EXISTS idx_agent_assignments_property ON agent_assignments(property_id);
