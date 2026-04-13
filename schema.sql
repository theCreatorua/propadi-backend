-- This file creates the entire database structure for Propadi.

-- We use "CREATE EXTENSION" to add special features.
-- 'uuid-ossp' gives us a function to create unique, highly secure IDs.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ### 1. Users Table ###
-- Stores core info for both Renters and Owners
CREATE TABLE users (
    user_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(50) UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(50) NOT NULL, -- 'Renter' or 'Owner'
    profile_picture_url TEXT,
    date_joined TIMESTAMPTZ DEFAULT NOW(),
    
    -- KYC & Profile Fields
    kyc_status VARCHAR(50) DEFAULT 'Not Submitted',
    kyc_document_url TEXT,
    date_of_birth DATE,
    marital_status VARCHAR(50),
    occupation VARCHAR(255),
    residential_address TEXT,
    nationality VARCHAR(100),
    state_of_origin VARCHAR(100),
    lga VARCHAR(100),
    
    -- Next of Kin Fields
    nok_full_name VARCHAR(255),
    nok_relationship VARCHAR(100),
    nok_phone VARCHAR(50),
    nok_address TEXT,
    
    -- v2.0 Trust System & Growth Engine Fields
    renter_score INT DEFAULT 0,
    is_gold_verified BOOLEAN DEFAULT false,
    employment_info_url TEXT,
    referral_code VARCHAR(20) UNIQUE -- Added for Trusted Padi Program
);

-- ### 2. Properties Table ###
-- Stores all property listings
CREATE TABLE properties (
    property_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'Available', -- 'Available', 'Rented', 'Deactivated'
    category VARCHAR(100) NOT NULL,
    furnishing_status VARCHAR(100),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    rent_price NUMERIC(12, 2) NOT NULL, -- (e.g., 1,000,000.00)
    rent_period VARCHAR(50) DEFAULT 'Yearly',
    total_beds INT DEFAULT 0,
    total_baths INT DEFAULT 0,
    
    -- Address Fields
    address_street TEXT NOT NULL,
    address_city VARCHAR(100) NOT NULL,
    address_lga VARCHAR(100),
    address_state VARCHAR(100) NOT NULL,
    map_coordinates VARCHAR(100), -- (e.g., "6.45407, 7.55406")
    
    main_image_url TEXT,
    gallery_urls TEXT[], -- Stores a list of image URLs
    date_listed TIMESTAMPTZ DEFAULT NOW()
);

-- ### 3. Property Amenities Table ###
-- Stores the visually verified amenities for each property
CREATE TABLE property_amenities (
    amenity_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
    amenity_name VARCHAR(255) NOT NULL,
    verification_url TEXT NOT NULL, -- Link to the photo/video proof
    media_type VARCHAR(50) DEFAULT 'Photo'
);

-- ### 4. Applications Table ###
-- Logs every rental application
CREATE TABLE applications (
    application_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id UUID NOT NULL REFERENCES properties(property_id),
    renter_id UUID NOT NULL REFERENCES users(user_id),
    owner_id UUID NOT NULL REFERENCES users(user_id),
    status VARCHAR(50) DEFAULT 'Submitted',
    cover_letter TEXT,
    date_applied TIMESTAMPTZ DEFAULT NOW(),
    date_status_updated TIMESTAMPTZ
);

-- ### 5. Viewings Table ###
-- Manages the Secure Viewing Protocol
CREATE TABLE viewings (
    viewing_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(application_id),
    renter_id UUID NOT NULL REFERENCES users(user_id),
    owner_id UUID NOT NULL REFERENCES users(user_id),
    property_id UUID NOT NULL REFERENCES properties(property_id),
    
    status VARCHAR(50) DEFAULT 'Request_Pending',
    scheduled_start_time TIMESTAMPTZ,
    scheduled_end_time TIMESTAMPTZ,
    
    -- Security Fields
    owner_checkin_time TIMESTAMPTZ,
    owner_checkin_location TEXT,
    renter_safe_checkout_time TIMESTAMPTZ,
    date_created TIMESTAMPTZ DEFAULT NOW()
);

-- ### 6. Tenancies Table ###
-- For the "My Tenancy" Dashboard (v2.0)
CREATE TABLE tenancies (
    tenancy_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID UNIQUE NOT NULL REFERENCES applications(application_id),
    property_id UUID NOT NULL REFERENCES properties(property_id),
    renter_id UUID NOT NULL REFERENCES users(user_id),
    owner_id UUID NOT NULL REFERENCES users(user_id),
    
    lease_start_date DATE NOT NULL,
    lease_end_date DATE NOT NULL,
    rent_amount NUMERIC(12, 2) NOT NULL,
    rent_period VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'Active' -- 'Active', 'Expired'
);

-- ### 7. Maintenance Requests Table ###
-- For the "My Tenancy" Dashboard (v2.0)
CREATE TABLE maintenance_requests (
    request_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenancy_id UUID NOT NULL REFERENCES tenancies(tenancy_id),
    renter_id UUID NOT NULL REFERENCES users(user_id),
    
    category VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    media_url TEXT NOT NULL, -- Photo/video proof
    status VARCHAR(50) DEFAULT 'Submitted',
    date_submitted TIMESTAMPTZ DEFAULT NOW(),
    date_resolved TIMESTAMPTZ
);

-- ### 8. Referrals Table ###
-- Tracks the "Trusted Padi" growth engine
CREATE TABLE referrals (
    referral_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    referrer_id UUID NOT NULL REFERENCES users(user_id), -- The person who invited
    referee_id UUID NOT NULL REFERENCES users(user_id),  -- The new person
    status VARCHAR(50) DEFAULT 'Pending', -- 'Pending', 'Verified_And_Rewarded'
    reward_type VARCHAR(50), -- 'Voucher', 'Listing_Boost'
    date_referred TIMESTAMPTZ DEFAULT NOW(),
    date_rewarded TIMESTAMPTZ
);