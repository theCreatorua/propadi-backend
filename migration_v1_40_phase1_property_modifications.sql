-- Migration v1.40: Phase 1 Property Schema Modifications & Listing Enhancements

ALTER TABLE public.properties
ADD COLUMN IF NOT EXISTS finishing_state VARCHAR(50) DEFAULT 'Completely Finished',
ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS total_units INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS agent_involvement VARCHAR(50) DEFAULT 'Self-Managed',
ADD COLUMN IF NOT EXISTS proof_of_ownership_docs TEXT[];

-- Comments for documentation
COMMENT ON COLUMN public.properties.finishing_state IS 'Architectural finish status: Completely Finished, Partially Finished, or Carcass / Uncompleted';
COMMENT ON COLUMN public.properties.brand_name IS 'Optional custom estate or building brand identity';
COMMENT ON COLUMN public.properties.total_units IS 'Total individual apartment, shop, or office unit capacity';
COMMENT ON COLUMN public.properties.agent_involvement IS 'Owner listing intent: Self-Managed or Propadi-Agent';
COMMENT ON COLUMN public.properties.proof_of_ownership_docs IS 'Array of uploaded title deed document URLs';
