-- Migration v1.39: Recurring Rent Auto-Pay & Advanced Analytics

-- 1. Property Views Analytics Table
CREATE TABLE IF NOT EXISTS property_views (
  view_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  viewer_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  viewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexing for fast analytics aggregation
CREATE INDEX IF NOT EXISTS idx_property_views_property ON property_views(property_id);
CREATE INDEX IF NOT EXISTS idx_property_views_date ON property_views(viewed_at);

-- 2. Rent Subscriptions & Auto-Pay Table
CREATE TABLE IF NOT EXISTS rent_subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id UUID NOT NULL REFERENCES tenancies(tenancy_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  paystack_subscription_code VARCHAR(100),
  paystack_email_token VARCHAR(100),
  interval VARCHAR(20) DEFAULT 'annually', -- monthly, quarterly, annually
  amount NUMERIC(12,2) NOT NULL,
  status VARCHAR(50) DEFAULT 'active', -- active, paused, cancelled
  next_payment_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rent_subscriptions_user ON rent_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_rent_subscriptions_tenancy ON rent_subscriptions(tenancy_id);

-- 3. Provider Availability Calendar Events Table
CREATE TABLE IF NOT EXISTS provider_calendar_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES service_providers(provider_id) ON DELETE CASCADE,
  event_type VARCHAR(50) DEFAULT 'blackout', -- blackout, booked, available
  title VARCHAR(255),
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_calendar_provider ON provider_calendar_events(provider_id);
