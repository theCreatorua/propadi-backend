// Set server timezone to West Africa Time (Lagos)
process.env.TZ = 'Africa/Lagos';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const resend = new Resend(process.env.RESEND_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Migration: Ensure stage1_verified_at, stage2_verified_at, and Paystack subaccount columns exist
(async () => {
  try {
    await pool.query(`
      ALTER TABLE maintenance_visits 
      ADD COLUMN IF NOT EXISTS stage1_verified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS stage2_verified_at TIMESTAMPTZ;

      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
      ADD COLUMN IF NOT EXISTS account_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS paystack_subaccount_code VARCHAR(100),
      ADD COLUMN IF NOT EXISTS is_bank_verified BOOLEAN DEFAULT FALSE;

      ALTER TABLE service_providers 
      ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
      ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
      ADD COLUMN IF NOT EXISTS account_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS paystack_subaccount_code VARCHAR(100);

      ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS subaccount_code VARCHAR(100),
      ADD COLUMN IF NOT EXISTS platform_commission NUMERIC(12,2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS paystack_fee NUMERIC(12,2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS split_code VARCHAR(100),
      ADD COLUMN IF NOT EXISTS reference VARCHAR(100);

      ALTER TABLE properties
      ADD COLUMN IF NOT EXISTS finishing_state VARCHAR(50) DEFAULT 'Completely Finished',
      ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS total_units INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS agent_involvement VARCHAR(50) DEFAULT 'Self-Managed',
      ADD COLUMN IF NOT EXISTS proof_of_ownership_docs TEXT[],
      ADD COLUMN IF NOT EXISTS service_charge NUMERIC(12, 2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS caution_fee NUMERIC(12, 2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS legal_fee_percent NUMERIC(5, 2) DEFAULT 5.00,
      ADD COLUMN IF NOT EXISTS agency_fee_percent NUMERIC(5, 2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS early_bird_discount_percent NUMERIC(5, 2) DEFAULT 0.00,
      ADD COLUMN IF NOT EXISTS is_caution_waived BOOLEAN DEFAULT FALSE;

      UPDATE properties
      SET early_bird_discount_percent = 0.00
      WHERE early_bird_discount_percent IS NULL;

      CREATE TABLE IF NOT EXISTS saved_properties (
        saved_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        property_id UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, property_id)
      );

      CREATE TABLE IF NOT EXISTS agents (
        agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE UNIQUE,
        agency_name VARCHAR(255) NOT NULL,
        cac_registration_number VARCHAR(100),
        license_number VARCHAR(100),
        operating_state VARCHAR(100) DEFAULT 'Lagos',
        commission_rate NUMERIC(5,2) DEFAULT 5.00,
        verification_status VARCHAR(50) DEFAULT 'pending',
        rejection_reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS agency_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS cac_registration_number VARCHAR(100),
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(100),
      ADD COLUMN IF NOT EXISTS operating_state VARCHAR(100) DEFAULT 'Lagos',
      ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 5.00,
      ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

      ALTER TABLE agents ALTER COLUMN agent_id SET DEFAULT gen_random_uuid();
      ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_agent_id_fkey;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);



      CREATE TABLE IF NOT EXISTS agent_assignments (
        assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
        property_id UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
        owner_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        commission_override NUMERIC(5,2),
        status VARCHAR(50) DEFAULT 'pending_acceptance',
        assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(agent_id, property_id)
      );

      ALTER TABLE agent_assignments
      ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS commission_override NUMERIC(5,2),
      ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 5.00,
      ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS owner_signed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS agent_signed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS decline_reason TEXT,
      ADD COLUMN IF NOT EXISTS contract_terms JSONB;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_assignments_agent_property ON agent_assignments (agent_id, property_id);

      ALTER TABLE agent_assignments DROP CONSTRAINT IF EXISTS agent_assignments_status_check;

      ALTER TABLE agent_assignments
      ADD CONSTRAINT agent_assignments_status_check CHECK (
        status IN (
          'pending_acceptance',
          'accepted_pending_signature',
          'active',
          'declined',
          'terminated',
          'revoked',
          'pending'
        )
      );

      CREATE TABLE IF NOT EXISTS property_views (
        view_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id UUID NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
        viewer_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        viewed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS rent_subscriptions (
        subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenancy_id UUID NOT NULL REFERENCES tenancies(tenancy_id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        paystack_subscription_code VARCHAR(100),
        paystack_email_token VARCHAR(100),
        interval VARCHAR(20) DEFAULT 'annually',
        amount NUMERIC(12,2) NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        next_payment_date TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS provider_calendar_events (
        event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id UUID NOT NULL REFERENCES service_providers(provider_id) ON DELETE CASCADE,
        event_type VARCHAR(50) DEFAULT 'blackout',
        title VARCHAR(255),
        start_time TIMESTAMP WITH TIME ZONE NOT NULL,
        end_time TIMESTAMP WITH TIME ZONE NOT NULL,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Paystack subaccount, agents, analytics, subscriptions & calendar schema migration verified.');
  } catch (err) {
    console.error('Error in startup schema migration:', err);
  }
})();

// Helper: Count active jobs for a provider (accepted + in_progress + negotiating)
async function countActiveJobs(providerId) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM service_requests 
     WHERE provider_id = $1 AND status IN ('negotiating', 'accepted', 'in_progress')`,
    [providerId],
  );
  return parseInt(result.rows[0].count, 10);
}

// Helper: Count jobs accepted today
async function countJobsToday(providerId) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM service_requests 
     WHERE provider_id = $1 AND DATE(accepted_at) = CURRENT_DATE`,
    [providerId],
  );
  return parseInt(result.rows[0].count, 10);
}

// Helper: Count jobs accepted this week (Monday–Sunday)
async function countJobsThisWeek(providerId) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM service_requests 
     WHERE provider_id = $1 
     AND DATE_PART('week', accepted_at) = DATE_PART('week', CURRENT_DATE)
     AND DATE_PART('year', accepted_at) = DATE_PART('year', CURRENT_DATE)`,
    [providerId],
  );
  return parseInt(result.rows[0].count, 10);
}

// Helper: Check scheduling conflict
async function hasScheduleConflict(providerId, proposedStart, proposedEnd) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM maintenance_visits mv
     JOIN service_requests sr ON mv.service_request_id = sr.service_id
     WHERE sr.provider_id = $1 
     AND mv.status != 'completed'
     AND (
       (mv.scheduled_start <= $2 AND mv.scheduled_end > $2) OR
       (mv.scheduled_start < $3 AND mv.scheduled_end >= $3) OR
       (mv.scheduled_start >= $2 AND mv.scheduled_end <= $3)
     )`,
    [providerId, proposedStart, proposedEnd],
  );
  return parseInt(result.rows[0].count, 0) > 0;
}

// Helper: Send SMS Notification (Twilio integration with fallback logging)
async function sendSMSNotification(toPhoneNumber, messageText) {
  if (!toPhoneNumber) return;
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromPhone = process.env.TWILIO_PHONE_NUMBER;

    if (accountSid && authToken && fromPhone) {
      const twilio = require('twilio')(accountSid, authToken);
      await twilio.messages.create({
        body: messageText,
        from: fromPhone,
        to: toPhoneNumber,
      });
      console.log(`📱 SMS sent successfully to ${toPhoneNumber}`);
    } else {
      console.log(`📱 [SMS FALLBACK LOG] To: ${toPhoneNumber} | Message: ${messageText}`);
    }
  } catch (err) {
    console.error(`❌ Failed to send SMS to ${toPhoneNumber}:`, err.message);
  }
}

// ==========================================
// SAFETY PULSE INTERNAL HELPER
// ==========================================

/**
 * Internal helper to trigger a safety alert for a maintenance visit.
 * Used by both the manual trigger endpoint and the safety-pulse cron.
 *
 * @param {string} visitId - UUID of the maintenance visit
 * @param {boolean} manual - true if triggered by renter, false if auto-escalated by cron
 * @returns {Promise<{success: boolean, message: string, error?: string}>}
 */
async function triggerAlertInternal(visitId, manual = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch visit details including renter & landlord Next of Kin contacts
    const visitResult = await client.query(
      `SELECT mv.*, mr.renter_id, sr.owner_id, sr.title,
              u_renter.name as renter_name, u_renter.phone_number as renter_phone,
              u_renter.nok_full_name, u_renter.nok_phone, u_renter.nok_relationship,
              u_owner.name as owner_name, u_owner.phone_number as owner_phone
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       LEFT JOIN users u_renter ON mr.renter_id = u_renter.user_id
       LEFT JOIN users u_owner ON sr.owner_id = u_owner.user_id
       WHERE mv.visit_id = $1
       FOR UPDATE`,
      [visitId]
    );
    if (visitResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Visit not found' };
    }
    const visit = visitResult.rows[0];

    // 2. If manual trigger by renter, check abuse limits
    if (manual && visit.renter_id) {
      const userResult = await client.query(
        `SELECT safety_alert_count, last_safety_alert_date FROM users WHERE user_id = $1`,
        [visit.renter_id]
      );
      const user = userResult.rows[0];
      if (user) {
        const now = new Date();
        const lastDate = user.last_safety_alert_date ? new Date(user.last_safety_alert_date) : null;
        let daysSinceLast = null;
        if (lastDate) {
          daysSinceLast = (now.getTime() - lastDate.getTime()) / (1000 * 3600 * 24);
        }

        // Abuse rule: if user has already triggered 2 alerts in the last 30 days, block further manual alerts
        if (user.safety_alert_count >= 2 && (daysSinceLast === null || daysSinceLast < 30)) {
          await client.query('ROLLBACK');
          return {
            success: false,
            error: 'You have exceeded the limit of emergency alerts. Please contact support if you are in real danger.'
          };
        }
      }
    }

    // 3. Update visit status to 'alert'
    await client.query(
      `UPDATE maintenance_visits
       SET safety_pulse_status = 'alert'
       WHERE visit_id = $1`,
      [visitId]
    );

    // 4. Increment renter's safety_alert_count (if manual) and record last date
    if (manual && visit.renter_id) {
      await client.query(
        `UPDATE users
         SET safety_alert_count = safety_alert_count + 1,
             last_safety_alert_date = NOW()
         WHERE user_id = $1`,
        [visit.renter_id]
      );
    }

    // 5. Notify owner via Push & SMS Fallback
    if (visit.owner_id) {
      await sendPushToUser(
        visit.owner_id,
        '🚨 Safety Alert',
        `An emergency alert has been triggered for "${visit.title}". Please check on the renter immediately.`,
        { screen: 'VisitManagement', visit_id: visitId }
      );

      if (visit.owner_phone) {
        await sendSMSNotification(
          visit.owner_phone,
          `PROPADI EMERGENCY: Renter ${visit.renter_name || 'Tenant'} triggered an emergency safety alert for job "${visit.title}". Please check on them immediately.`
        );
      }
    }

    // 6. Send SMS Fallback to Renter
    if (visit.renter_phone) {
      await sendSMSNotification(
        visit.renter_phone,
        `PROPADI SAFETY ALERT: Your emergency alert for "${visit.title}" has been dispatched to Property Management and Security.`
      );
    }

    // 7. Send SMS Fallback to Next of Kin / Emergency Contact
    if (visit.nok_phone) {
      await sendSMSNotification(
        visit.nok_phone,
        `PROPADI EMERGENCY ALERT: Your contact ${visit.renter_name || 'Renter'} triggered an emergency safety alert during a maintenance visit for "${visit.title}". Please attempt to reach them.`
      );
    }

    // 8. Notify all admins
    const adminUsers = await client.query(
      'SELECT user_id FROM users WHERE is_admin = TRUE'
    );
    for (const admin of adminUsers.rows) {
      await sendPushToUser(
        admin.user_id,
        '🚨 Safety Alert - Renter',
        `Renter has triggered an alert for job "${visit.title}". Action required.`,
        { screen: 'AdminDashboard', visit_id: visitId }
      );
    }

    await client.query('COMMIT');
    return { success: true, message: 'Alert triggered. Help is on the way.' };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('triggerAlertInternal error:', err);
    return { success: false, error: err.message };
  } finally {
    client.release();
  }
}

// ==========================================
// ADMIN MIDDLEWARE (must be defined before any admin routes)
// ==========================================
const requireAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    const { rows } = await pool.query(
      'SELECT is_admin FROM users WHERE user_id = $1',
      [user.id],
    );
    if (rows.length === 0 || !rows[0].is_admin) {
      return res
        .status(403)
        .json({ success: false, error: 'Admin access required' });
    }
    req.adminUser = user;
    next();
  } catch (err) {
    console.error('Admin middleware error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Admin verification failed' });
  }
};

// ==========================================
// AUTHENTICATION & USER ROUTES
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  const { user_id, email, name, role, referral_code } = req.body;

  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [
      email,
    ]);
    if (userCheck.rows.length > 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Email is already registered' });
    }

    // Insert user (referral_code may be null initially; we'll generate if needed)
    const newUser = await pool.query(
      `INSERT INTO users (user_id, email, name, role) 
       VALUES ($1, $2, $3, $4) 
       RETURNING user_id, email, name, role, referral_code`,
      [user_id, email, name, role || 'renter'],
    );

    // Create wallet for the new user
    await pool.query(
      `INSERT INTO wallets (user_id, balance, total_earned, pending_clearance) 
       VALUES ($1, 0, 0, 0)`,
      [user_id],
    );

    // --- Ensure a unique referral code exists for this user ---
    let finalCode = newUser.rows[0].referral_code;
    if (!finalCode) {
      // Generate a base code using first 4 letters of name + random suffix
      const baseName = name.replace(/\s/g, '').substring(0, 4).toUpperCase();
      let newCode = `${baseName}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      let exists = true;
      while (exists) {
        const check = await pool.query(
          'SELECT 1 FROM users WHERE referral_code = $1',
          [newCode],
        );
        if (check.rows.length === 0) exists = false;
        else
          newCode = `${baseName}${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      }
      finalCode = newCode;
      await pool.query(
        'UPDATE users SET referral_code = $1 WHERE user_id = $2',
        [finalCode, user_id],
      );
    }

    // --- Handle referral linking (if a valid referral_code was provided at signup) ---
    if (referral_code) {
      // Find referrer by that code
      const referrerResult = await pool.query(
        'SELECT user_id FROM users WHERE referral_code = $1 AND user_id != $2',
        [referral_code, user_id],
      );
      if (referrerResult.rows.length > 0) {
        const referrerId = referrerResult.rows[0].user_id;
        // Insert referral record (status Pending)
        await pool.query(
          `INSERT INTO referrals (referrer_id, referee_id, status, reward_type) 
           VALUES ($1, $2, 'Pending', 'wallet_credit')`,
          [referrerId, user_id],
        );
      }
    }

    res.json({
      success: true,
      message: 'Welcome to Propadi!',
      user: { ...newUser.rows[0], referral_code: finalCode },
    });
  } catch (err) {
    console.error('Sign Up Error:', err);
    res.status(500).json({ success: false, error: 'Failed to create profile' });
  }
});

app.post('/api/user/deposit', async (req, res) => {
  const { userId, amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res
      .status(400)
      .json({ success: false, error: 'Please enter a valid amount' });
  }

  try {
    const updateResult = await pool.query(
      'UPDATE wallets SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 RETURNING balance',
      [amount, userId],
    );
    if (updateResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'User wallet not found' });
    }
    await pool.query(
      `INSERT INTO transactions (user_id, type, title, amount, status) VALUES ($1, 'credit', 'Vault Deposit', $2, 'Completed')`,
      [userId, amount],
    );
    res.json({
      success: true,
      message: 'Vault funded successfully!',
      newBalance: updateResult.rows[0].balance,
    });
  } catch (err) {
    console.error('Deposit Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process deposit' });
  }
});

app.post('/api/user/withdraw', async (req, res) => {
  const { userId, amount, email, bankName, accountNumber } = req.body;
  if (!amount || isNaN(amount) || amount <= 0) {
    return res
      .status(400)
      .json({ success: false, error: 'Please enter a valid amount' });
  }
  if (!bankName || !accountNumber) {
    return res
      .status(400)
      .json({ success: false, error: 'Bank details are required' });
  }
  try {
    const userResult = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [userId],
    );
    if (userResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'User wallet not found' });
    }
    const currentBalance = parseFloat(userResult.rows[0].balance);
    if (currentBalance < amount) {
      return res
        .status(400)
        .json({ success: false, error: 'Insufficient funds in vault' });
    }
    await pool.query(
      `INSERT INTO withdrawals (user_id, email, amount, bank_name, account_number, status, type) 
       VALUES ($1, $2, $3, $4, $5, 'Pending', 'Withdrawal')`,
      [userId, email, amount, bankName, accountNumber],
    );
    res.json({ success: true, message: 'Withdrawal requested successfully!' });
  } catch (err) {
    console.error('Withdraw Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process withdrawal request' });
  }
});

app.get('/api/user/dashboard/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const balanceResult = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [id],
    );
    const withdrawalsResult = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [id],
    );
    res.json({
      balance:
        balanceResult.rows.length > 0 ? balanceResult.rows[0].balance : 0,
      withdrawals: withdrawalsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching user data' });
  }
});

app.get('/api/user/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT u.email, COALESCE(w.balance, 0) as balance FROM users u LEFT JOIN wallets w ON u.user_id = w.user_id WHERE u.user_id = $1`,
      [userId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Profile Fetch Error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

// ==========================================
// PROPADI TRUST & KYC ENGINE
// ==========================================

app.get('/api/users/:id/trust', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT kyc_tier, phone_verified, nin_verified, address_verified, renter_score FROM users WHERE user_id = $1`,
      [id],
    );
    if (result.rows.length > 0)
      res.json({ success: true, trust_data: result.rows[0] });
    else res.status(404).json({ success: false, error: 'User not found' });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch trust data' });
  }
});

app.post('/api/users/:id/verify-nin', async (req, res) => {
  try {
    const { id } = req.params;
    const { nin } = req.body;
    if (!nin || nin.length < 11)
      return res
        .status(400)
        .json({ success: false, error: 'Invalid NIN provided.' });
    await pool.query(
      `UPDATE users SET nin_verified = TRUE, kyc_tier = 2, renter_score = renter_score + 15 WHERE user_id = $1`,
      [id],
    );
    res.json({
      success: true,
      message: 'Identity verified successfully! You are now Tier 2.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ==========================================
// PROPERTIES ROUTES
// ==========================================

app.get('/api/properties', async (req, res) => {
  try {
    const query = `
      SELECT p.*,
             (SELECT COUNT(*) FROM properties_amenities WHERE property_id = p.property_id) as verified_amenities_count
      FROM properties p
      WHERE p.status IN ('Available', 'Pending Admin Oversight', 'Pending Verification')
      ORDER BY p.date_listed DESC
    `;
    const result = await pool.query(query);
    const properties = result.rows.map((row) => ({
      ...row,
      has_verified_amenities: row.verified_amenities_count > 0,
    }));
    res.json({ success: true, properties });
  } catch (err) {
    console.error('Error fetching feed:', err);
    res.status(500).json({ success: false, error: 'Failed to load the feed' });
  }
});

app.get('/api/properties/search', async (req, res) => {
  try {
    const { state, lga, city, minPrice, maxPrice, bedrooms, furnishing_status, amenities, query } =
      req.query;
    let sql = `
      SELECT p.*, array_agg(DISTINCT pa.amenity_name) as amenities_list
      FROM properties p
      LEFT JOIN properties_amenities pa ON p.property_id = pa.property_id
      WHERE p.status IN ('Available', 'Pending Admin Oversight', 'Pending Verification')
    `;
    const values = [];
    let paramIndex = 1;

    if (state) {
      sql += ` AND p.address_state ILIKE $${paramIndex}`;
      values.push(`%${state}%`);
      paramIndex++;
    }
    if (lga) {
      sql += ` AND p.address_lga ILIKE $${paramIndex}`;
      values.push(`%${lga}%`);
      paramIndex++;
    }
    if (city) {
      sql += ` AND p.address_city ILIKE $${paramIndex}`;
      values.push(`%${city}%`);
      paramIndex++;
    }
    if (minPrice) {
      sql += ` AND p.rent_price >= $${paramIndex}`;
      values.push(parseInt(minPrice, 10));
      paramIndex++;
    }
    if (maxPrice) {
      sql += ` AND p.rent_price <= $${paramIndex}`;
      values.push(parseInt(maxPrice, 10));
      paramIndex++;
    }
    if (bedrooms && bedrooms !== 'any') {
      const bedNum = parseInt(bedrooms, 10);
      if (!isNaN(bedNum)) {
        sql += ` AND p.total_beds >= $${paramIndex}`;
        values.push(bedNum);
        paramIndex++;
      }
    }
    if (furnishing_status && furnishing_status !== 'Any') {
      sql += ` AND p.furnishing_status ILIKE $${paramIndex}`;
      values.push(`%${furnishing_status}%`);
      paramIndex++;
    }
    if (query) {
      sql += ` AND (p.title ILIKE $${paramIndex} OR p.address_city ILIKE $${paramIndex} OR p.address_street ILIKE $${paramIndex} OR p.address_state ILIKE $${paramIndex})`;
      values.push(`%${query}%`);
      paramIndex++;
    }
    sql += ` GROUP BY p.property_id ORDER BY p.is_featured DESC, p.date_listed DESC`;
    const result = await pool.query(sql, values);
    res.json({ success: true, properties: result.rows });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
});

app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const propQuery = `SELECT * FROM properties WHERE property_id = $1;`;
    const propResult = await pool.query(propQuery, [id]);
    if (propResult.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Property not found' });
    const property = propResult.rows[0];
    const amenitiesQuery = `SELECT * FROM properties_amenities WHERE property_id = $1;`;
    const amenitiesResult = await pool.query(amenitiesQuery, [id]);
    property.visually_verified_amenities = amenitiesResult.rows;
    res.json({ success: true, property });
  } catch (err) {
    console.error('Error fetching single property:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to load property details' });
  }
});

app.post('/api/properties', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      owner_id,
      status,
      category,
      finishing_state,
      brand_name,
      total_units,
      sector_tag,
      agent_involvement,
      furnishing_status,
      title,
      description,
      rent_price,
      rent_period,
      service_charge,
      caution_fee,
      legal_fee_percent,
      agency_fee_percent,
      early_bird_discount_percent,
      is_caution_waived,
      total_beds,
      total_baths,
      total_kitchens,
      total_stores,
      address_street,
      address_city,
      address_lga,
      address_state,
      landmark_name,
      landmark_type,
      main_image_url,
      gallery_urls,
      visually_verified_amenities,
      size_sqm,
      parking_spaces,
      year_built,
      floor_number,
      meter_type,
      meter_debt_amount,
      meter_receipt_url,
      proof_of_ownership_type,
      proof_of_ownership_url,
      proof_of_ownership_docs,
      video_url,
      has_video,
    } = req.body;

    const propQuery = `
      INSERT INTO properties (
        owner_id, status, category, finishing_state, brand_name, total_units,
        sector_tag, agent_involvement, furnishing_status, title, description,
        rent_price, rent_period, service_charge, caution_fee, legal_fee_percent,
        agency_fee_percent, early_bird_discount_percent, is_caution_waived,
        total_beds, total_baths, total_kitchens, total_stores, address_street,
        address_city, address_lga, address_state, map_coordinates, main_image_url,
        gallery_urls, landmark_name, landmark_type, size_sqm, parking_spaces,
        year_built, floor_number, meter_type, meter_debt_amount, meter_receipt_url,
        proof_of_ownership_type, proof_of_ownership_url, proof_of_ownership_docs,
        video_url, has_video
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, NULL, $28, $29,
        $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43
      )
      RETURNING *;
    `;
    const propValues = [
      owner_id,
      status || 'Pending Verification',
      category,
      finishing_state || 'Completely Finished',
      brand_name || null,
      total_units || 1,
      sector_tag || 'Residential',
      agent_involvement || 'Self-Managed',
      furnishing_status || null,
      title,
      description,
      rent_price,
      rent_period || 'Yearly',
      service_charge || 0.00,
      caution_fee || 0.00,
      legal_fee_percent || 5.00,
      agency_fee_percent || 0.00,
      early_bird_discount_percent || 0.00,
      is_caution_waived || false,
      total_beds || 0,
      total_baths || 0,
      total_kitchens || 0,
      total_stores || 0,
      address_street,
      address_city,
      address_lga,
      address_state,
      main_image_url,
      gallery_urls || [],
      landmark_name || null,
      landmark_type || null,
      size_sqm || null,
      parking_spaces || null,
      year_built || null,
      floor_number || null,
      meter_type || 'Existing',
      meter_debt_amount || 0.00,
      meter_receipt_url || null,
      proof_of_ownership_type || null,
      proof_of_ownership_url || null,
      proof_of_ownership_docs || [],
      video_url || null,
      has_video || false,
    ];
    const propResult = await client.query(propQuery, propValues);
    const savedProperty = propResult.rows[0];

    if (visually_verified_amenities && visually_verified_amenities.length > 0) {
      for (const amenity of visually_verified_amenities) {
        const amenityName = typeof amenity === 'string' ? amenity : amenity.amenity_name;
        const verificationUrl = typeof amenity === 'string' ? null : amenity.verification_url;
        const mediaType = typeof amenity === 'string' ? null : amenity.media_type;
        await client.query(
          `INSERT INTO properties_amenities (property_id, amenity_name, verification_url, media_type) VALUES ($1, $2, $3, $4)`,
          [
            savedProperty.property_id,
            amenityName,
            verificationUrl,
            mediaType,
          ],
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, property: savedProperty });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to publish verified listing' });
  } finally {
    client.release();
  }
});

// ==========================================
// MESSAGING ROUTES
// ==========================================

app.post('/api/messages', async (req, res) => {
  try {
    const { property_id, sender_id, receiver_id, content } = req.body;
    const result = await pool.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1, $2, $3, $4) RETURNING *`,
      [property_id, sender_id, receiver_id, content],
    );
    const senderNameQuery = await pool.query(
      'SELECT name FROM users WHERE user_id = $1',
      [sender_id],
    );
    const senderName = senderNameQuery.rows[0]?.name || 'Someone';
    const messagePreview =
      content.length > 50 ? content.substring(0, 50) + '...' : content;
    await sendPushToUser(
      receiver_id,
      `💬 New message from ${senderName}`,
      messagePreview,
      { screen: 'Chat', property_id, other_user_id: sender_id },
    );
    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

app.get('/api/messages/:property_id/:user1_id/:user2_id', async (req, res) => {
  try {
    const { property_id, user1_id, user2_id } = req.params;
    const result = await pool.query(
      `SELECT * FROM messages WHERE property_id = $1 AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2)) ORDER BY created_at ASC`,
      [property_id, user1_id, user2_id],
    );
    res.json({ success: true, messages: result.rows });
  } catch (err) {
    console.error('Error fetching messages:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch chat history' });
  }
});

app.get('/api/inbox/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `
      SELECT DISTINCT ON (m.property_id, CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END)
        m.id, m.property_id, m.content as last_message, m.created_at, m.sender_id, m.receiver_id,
        p.title as property_title, p.main_image_url
      FROM messages m
      JOIN properties p ON m.property_id = p.property_id
      WHERE m.sender_id = $1 OR m.receiver_id = $1
      ORDER BY m.property_id, CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END, m.created_at DESC;
    `;
    const result = await pool.query(query, [userId]);
    const sorted = result.rows.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );
    res.json({ success: true, conversations: sorted });
  } catch (err) {
    console.error('Error fetching inbox:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch inbox' });
  }
});

// ==========================================
// VIEWING TRACKER & TRUST AUDIT ROUTES
// ==========================================

app.post('/api/viewings', async (req, res) => {
  try {
    const { property_id, renter_id, landlord_id, viewing_date } = req.body;
    const startTime = new Date(viewing_date);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
    const result = await pool.query(
      `INSERT INTO viewings (property_id, renter_id, owner_id, scheduled_start_time, scheduled_end_time, status) VALUES ($1,$2,$3,$4,$5,'Pending') RETURNING *`,
      [
        property_id,
        renter_id,
        landlord_id,
        startTime.toISOString(),
        endTime.toISOString(),
      ],
    );
    const messageContent = `🗓️ I have requested a viewing for ${startTime.toLocaleString()}. Please accept or decline.||${result.rows[0].viewing_id}`;
    await pool.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1,$2,$3,$4)`,
      [property_id, renter_id, landlord_id, messageContent],
    );
    const ownerNameQuery = await pool.query(
      'SELECT name FROM users WHERE user_id = $1',
      [landlord_id],
    );
    const ownerName = ownerNameQuery.rows[0]?.name || 'Owner';
    await sendPushToUser(
      landlord_id,
      '📅 New Viewing Request',
      `${ownerName}, a renter has requested a viewing. Please check your chat.`,
      { screen: 'Chat', property_id, other_user_id: renter_id },
    );
    res.json({ success: true, viewing: result.rows[0] });
  } catch (err) {
    console.error('Error creating viewing:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to request viewing' });
  }
});

app.put('/api/viewings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const viewData = await pool.query(
      'SELECT property_id, owner_id, renter_id FROM viewings WHERE viewing_id = $1',
      [id],
    );
    const v = viewData.rows[0];
    let query, values;
    if (status === 'Accepted') {
      const securePin = crypto.randomInt(100000, 999999).toString();
      const expiry = new Date();
      expiry.setMinutes(expiry.getMinutes() + 5);
      query = `UPDATE viewings SET status=$1, secure_handshake_pin=$2, pin_expiry=$3 WHERE viewing_id=$4 RETURNING *`;
      values = [status, securePin, expiry.toISOString(), id];
      if (v) {
        await pool.query(
          `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1,$2,$3,$4)`,
          [
            v.property_id,
            v.owner_id,
            v.renter_id,
            `⏳ **Viewing In Progress:** Both parties have agreed. Awaiting physical Secure Handshake.`,
          ],
        );
      }
    } else {
      query = `UPDATE viewings SET status=$1 WHERE viewing_id=$2 RETURNING *`;
      values = [status, id];
    }
    const result = await pool.query(query, values);
    res.json({ success: true, viewing: result.rows[0] });
  } catch (err) {
    console.error('Error updating viewing:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to update viewing status' });
  }
});

app.post('/api/viewings/:id/validate', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { pin, owner_lat, owner_lng } = req.body;
    if (!pin)
      return res
        .status(400)
        .json({ success: false, error: 'Handshake PIN is required.' });
    await client.query('BEGIN');
    const viewingResult = await client.query(
      `SELECT secure_handshake_pin, pin_expiry, status, property_id, owner_id, renter_id FROM viewings WHERE viewing_id = $1 FOR UPDATE`,
      [id],
    );
    if (viewingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: 'Viewing session not found.' });
    }
    const viewing = viewingResult.rows[0];
    if (viewing.status !== 'Accepted') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'This viewing is not currently active or accepted.',
      });
    }
    const now = new Date();
    const expiry = new Date(viewing.pin_expiry);
    if (now > expiry) {
      await client.query('ROLLBACK');
      await client.query(
        `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1,$2,$3,$4)`,
        [
          viewing.property_id,
          viewing.owner_id,
          viewing.renter_id,
          `❌ **Viewing Failed:** The Secure Handshake PIN expired before verification.`,
        ],
      );
      await client.query('COMMIT');
      return res.status(400).json({
        success: false,
        error:
          'This handshake PIN has expired. The renter must refresh their app.',
      });
    }
    if (viewing.secure_handshake_pin !== pin.toString()) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Invalid handshake PIN. Verification failed.',
      });
    }
    const updateResult = await client.query(
      `UPDATE viewings SET status='Completed', owner_checkin_location=$2, updated_at=CURRENT_TIMESTAMP WHERE viewing_id=$1 RETURNING *`,
      [id, `${owner_lat},${owner_lng}`],
    );
    await client.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1,$2,$3,$4)`,
      [
        viewing.property_id,
        viewing.owner_id,
        viewing.renter_id,
        `✅ **Secure Handshake Completed.** Renter is currently conducting the physical audit.`,
      ],
    );
    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Secure Handshake verified!',
      viewing: updateResult.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Handshake Validation Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Internal validation error.' });
  } finally {
    client.release();
  }
});

app.post('/api/viewings/:id/audit', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { audit_data, renter_notes, final_decision } = req.body;
    await client.query('BEGIN');
    const viewResult = await client.query(
      'SELECT property_id, renter_id, owner_id FROM viewings WHERE viewing_id = $1 FOR UPDATE',
      [id],
    );
    if (viewResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: 'Viewing not found' });
    }
    const v = viewResult.rows[0];
    let missingCount = 0;
    const totalCount = audit_data.length;
    for (const item of audit_data) {
      await client.query(
        `INSERT INTO inspection_audits (viewing_id, amenity_id, is_physically_present, renter_notes) VALUES ($1,$2,$3,$4)`,
        [id, item.amenity_id, item.is_present, renter_notes],
      );
      if (item.is_present === false) missingCount++;
    }
    if (missingCount > 0) {
      const penalty = missingCount * 5;
      await client.query(
        'UPDATE users SET renter_score = renter_score - $1 WHERE user_id = $2',
        [penalty, v.owner_id],
      );
    } else if (totalCount > 0 && missingCount === 0) {
      await client.query(
        'UPDATE users SET renter_score = renter_score + 2 WHERE user_id = $1',
        [v.owner_id],
      );
    }
    let conclusionText =
      missingCount > 0
        ? `⚠️ *Propadi Trust Engine has deducted trust points from the Owner due to missing advertised amenities.*`
        : `✅ *Property perfectly matches the online listing. Owner trust score increased.*`;
    if (totalCount === 0)
      conclusionText = `*No specific amenities were verified.*`;
    const reportContent = `📋 **Immutable Inspection Report**\nAmenities Verified: ${totalCount - missingCount}/${totalCount}\nDiscrepancies Found: ${missingCount}\nRenter's Decision: **${final_decision}**\n\n${conclusionText}`;
    await client.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1,$2,$3,$4)`,
      [v.property_id, v.renter_id, v.owner_id, reportContent],
    );
    await client.query(
      `UPDATE viewings SET status='Audited', updated_at=CURRENT_TIMESTAMP WHERE viewing_id=$1`,
      [id],
    );
    await client.query('COMMIT');
    res.json({ success: true, message: 'Audit logged successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Audit Processing Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process inspection audit' });
  } finally {
    client.release();
  }
});

// GET /api/viewings/renter/:renterId – get booked property tours for renter
app.get('/api/viewings/renter/:renterId', async (req, res) => {
  try {
    const { renterId } = req.params;
    const { rows } = await pool.query(
      `SELECT v.viewing_id, v.property_id, v.renter_id, v.owner_id, 
              v.scheduled_start_time, v.scheduled_end_time, v.status, 
              v.secure_handshake_pin, v.updated_at,
              p.title as property_title, p.address_street, p.address_city, p.address_state,
              u.name as owner_name, u.email as owner_email
       FROM viewings v
       JOIN properties p ON v.property_id = p.property_id
       LEFT JOIN users u ON v.owner_id = u.user_id
       WHERE v.renter_id = $1
       ORDER BY v.scheduled_start_time DESC`,
      [renterId],
    );
    res.json({ success: true, viewings: rows });
  } catch (err) {
    console.error('Error fetching renter viewings:', err);
    res.status(500).json({ success: false, error: 'Failed to load booked tours' });
  }
});

// ==========================================
// FORMAL APPLICATION ROUTES
// ==========================================

app.post('/api/applications', async (req, res) => {
  try {
    const {
      property_id,
      renter_id,
      owner_id,
      proposed_rent,
      cover_letter,
      move_in_date,
      is_sight_unseen,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO applications (property_id, renter_id, owner_id, proposed_rent, cover_letter, move_in_date, is_sight_unseen) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        property_id,
        renter_id,
        owner_id,
        proposed_rent,
        cover_letter,
        move_in_date || 'Immediately',
        is_sight_unseen || false,
      ],
    );

    // Send push notification to Owner
    try {
      const propRes = await pool.query('SELECT title FROM properties WHERE property_id = $1', [property_id]);
      const propTitle = propRes.rows[0]?.title || 'your listing';
      await sendPushToUser(
        owner_id,
        '📩 New Rental Application',
        `A renter has submitted an application for "${propTitle}".`,
        { screen: 'Applications', property_id }
      );
    } catch (pushErr) {
      console.error('Application submission push error:', pushErr);
    }

    res.json({ success: true, application: result.rows[0] });
  } catch (err) {
    console.error('Error submitting application:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to submit application' });
  }
});

app.get('/api/applications/owner/:owner_id', async (req, res) => {
  try {
    const { owner_id } = req.params;
    const result = await pool.query(
      `SELECT a.*, u.name as renter_name, u.email, u.profile_picture_url, u.renter_score, p.title as property_title
       FROM applications a
       JOIN users u ON a.renter_id = u.user_id
       JOIN properties p ON a.property_id = p.property_id
       WHERE a.owner_id = $1
       ORDER BY a.date_applied DESC`,
      [owner_id],
    );
    res.json({ success: true, applications: result.rows });
  } catch (err) {
    console.error('Error fetching applications:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to load applications' });
  }
});

app.put('/api/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const appResult = await pool.query(
      `UPDATE applications SET status=$1, date_status_updated=CURRENT_TIMESTAMP WHERE application_id=$2 RETURNING *`,
      [status, id],
    );
    const application = appResult.rows[0];
    if (status === 'Approved' && application) {
      const start = new Date();
      const moveIn = (application.move_in_date || '').toLowerCase();
      if (moveIn.includes('next week')) start.setDate(start.getDate() + 7);
      else if (moveIn.includes('next month'))
        start.setMonth(start.getMonth() + 1);
      else if (!moveIn.includes('immediately') && moveIn !== '')
        start.setDate(start.getDate() + 14);
      const end = new Date(start);
      end.setFullYear(end.getFullYear() + 1);
      await pool.query(
        `INSERT INTO tenancies (application_id, property_id, renter_id, owner_id, rent_amount, rent_period, lease_start_date, lease_end_date, status, is_sight_unseen)
         VALUES ($1, $2, $3, $4, $5, 'Per Annum', $6, $7, 'Draft', $8)`,
        [
          application.application_id,
          application.property_id,
          application.renter_id,
          application.owner_id,
          application.proposed_rent,
          start.toISOString().split('T')[0],
          end.toISOString().split('T')[0],
          application.is_sight_unseen,
        ],
      );
    }

    // Send push notification to Renter
    if (application) {
      try {
        const propRes = await pool.query('SELECT title FROM properties WHERE property_id = $1', [application.property_id]);
        const propTitle = propRes.rows[0]?.title || 'the property';
        await sendPushToUser(
          application.renter_id,
          '📋 Application Status Update',
          `Your application for "${propTitle}" is now ${status}.`,
          { screen: 'MyApplications', application_id: id }
        );
      } catch (pushErr) {
        console.error('Application status update push error:', pushErr);
      }
    }

    res.json({ success: true, application });
  } catch (err) {
    console.error('Error updating application:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process application' });
  }
});

app.get('/api/applications/renter/:renter_id', async (req, res) => {
  try {
    const { renter_id } = req.params;
    const result = await pool.query(
      `SELECT a.application_id, a.property_id, a.proposed_rent, a.status, a.date_applied,
              p.title as property_title, t.tenancy_id
       FROM applications a
       JOIN properties p ON a.property_id = p.property_id
       LEFT JOIN tenancies t ON a.application_id = t.application_id
       WHERE a.renter_id = $1
       ORDER BY a.date_applied DESC`,
      [renter_id],
    );
    res.json({ success: true, applications: result.rows });
  } catch (err) {
    console.error('Error fetching renter applications:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to load your applications' });
  }
});

app.get('/api/applications/check/:property_id/:renter_id', async (req, res) => {
  try {
    const { property_id, renter_id } = req.params;
    const result = await pool.query(
      `SELECT status FROM applications WHERE property_id=$1 AND renter_id=$2 AND status IN ('Pending','Approved') LIMIT 1`,
      [property_id, renter_id],
    );
    if (result.rows.length > 0)
      res.json({
        success: true,
        hasApplied: true,
        status: result.rows[0].status,
      });
    else res.json({ success: true, hasApplied: false });
  } catch (err) {
    console.error('Error checking application status:', err);
    res.status(500).json({ success: false, error: 'Failed to check status' });
  }
});

// ==========================================
// SMART CONTRACT & PAYSTACK ESCROW ENGINE
// ==========================================

app.get('/api/tenancies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT t.*, p.title as property_title, p.address_street, p.address_city, p.address_state,
              o.name as owner_name, o.email as owner_email,
              r.name as renter_name, r.email as renter_email, r.occupation, r.nok_full_name
       FROM tenancies t
       JOIN properties p ON t.property_id = p.property_id
       JOIN users o ON t.owner_id = o.user_id
       JOIN users r ON t.renter_id = r.user_id
       WHERE t.tenancy_id = $1`,
      [id],
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Agreement not found' });
    res.json({ success: true, tenancy: result.rows[0] });
  } catch (err) {
    console.error('Error fetching tenancy:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch agreement' });
  }
});

app.get('/api/tenancies/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT payment_status, status FROM tenancies WHERE tenancy_id = $1`,
      [id],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: 'Not found' });
    res.json({
      success: true,
      payment_status: result.rows[0].payment_status,
      tenancy_status: result.rows[0].status,
    });
  } catch (err) {
    console.error('Status poll error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.put('/api/tenancies/:id/sign', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE tenancies SET renter_signature_date=CURRENT_TIMESTAMP, owner_signature_date=COALESCE(owner_signature_date, CURRENT_TIMESTAMP), status='Signed' WHERE tenancy_id=$1 RETURNING *`,
      [id],
    );
    res.json({ success: true, tenancy: result.rows[0] });
  } catch (err) {
    console.error('Error signing tenancy:', err);
    res.status(500).json({ success: false, error: 'Failed to sign agreement' });
  }
});

app.post('/api/tenancies/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;
    const tenancyResult = await pool.query(
      `SELECT t.rent_amount, u.email FROM tenancies t JOIN users u ON t.renter_id = u.user_id WHERE t.tenancy_id=$1`,
      [id],
    );
    if (tenancyResult.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Tenancy not found' });
    const tenancy = tenancyResult.rows[0];
    const rentAmount = parseFloat(tenancy.rent_amount);
    let gatewayFee = rentAmount * 0.015 + 100;
    if (gatewayFee > 2000) gatewayFee = 2000;
    const totalAmountKobo = Math.round((rentAmount + gatewayFee) * 100);
    const paystackResponse = await fetch(
      'https://api.paystack.co/transaction/initialize',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: tenancy.email,
          amount: totalAmountKobo,
          metadata: { tenancy_id: id },
          callback_url: 'propadi://paystack-return',
        }),
      },
    );
    const paystackData = await paystackResponse.json();
    if (paystackData.status) {
      await pool.query(
        `UPDATE tenancies SET payment_reference = $1 WHERE tenancy_id = $2`,
        [paystackData.data.reference, id],
      );
      res.json({
        success: true,
        authorization_url: paystackData.data.authorization_url,
      });
    } else {
      res.status(400).json({ success: false, error: paystackData.message });
    }
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: 'Payment initialization failed' });
  }
});

app.post('/api/tenancies/:id/verify', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const refResult = await client.query(
      `SELECT t.*, p.title as property_title FROM tenancies t JOIN properties p ON t.property_id = p.property_id WHERE t.tenancy_id = $1`,
      [id],
    );
    const tenancy = refResult.rows[0];
    if (!tenancy || !tenancy.payment_reference) {
      return res
        .status(400)
        .json({ success: false, error: 'No active payment found.' });
    }

    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${tenancy.payment_reference}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      },
    );
    const verifyData = await verifyResponse.json();

    if (verifyData.data.status === 'success') {
      await client.query('BEGIN');

      // Update tenancy payment status
      await client.query(
        `UPDATE tenancies SET payment_status = 'Paid' WHERE tenancy_id = $1`,
        [id],
      );

      const rentAmount = parseFloat(tenancy.rent_amount);
      let gatewayFee = rentAmount * 0.015 + 100;
      if (gatewayFee > 2000) gatewayFee = 2000;

      // Record transactions
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'payment', 'Annual Rent Payment', $2, $3, 'Completed')`,
        [tenancy.renter_id, tenancy.property_title, -rentAmount],
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'fee', 'Propadi Secure Gateway Fee', 'Platform Service', $2, 'Completed')`,
        [tenancy.renter_id, -gatewayFee],
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'credit', 'Rent Payment Received', $2, $3, 'Completed')`,
        [tenancy.owner_id, tenancy.property_title, rentAmount],
      );
      await client.query(
        `UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1, updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $2`,
        [rentAmount, tenancy.owner_id],
      );

      // ✅ Mark pending referral as completed (if any)
      await client.query(
        `UPDATE referrals 
         SET status = 'Completed' 
         WHERE referee_id = $1 AND status = 'Pending'`,
        [tenancy.renter_id],
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Payment verified, Ledgers updated, Contract Activated!',
      });
    } else {
      res.json({
        success: false,
        status: verifyData.data.status,
        message: 'Payment pending or failed.',
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ESCROW ERROR (Internal):', err);
    res.status(500).json({
      success: false,
      status: 'Transaction Error',
      message:
        'An error occurred while securing your ledger. Please contact Propadi Support.',
    });
  } finally {
    client.release();
  }
});

app.post('/api/webhook/paystack', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).send('Invalid signature');
  }

  const event = req.body;
  if (event.event === 'charge.success') {
    const tenancyId = event.data.metadata?.tenancy_id;
    if (!tenancyId) return res.status(200).send('No tenancy ID, ignored.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const checkResult = await client.query(
        `SELECT payment_status, rent_amount, renter_id, owner_id FROM tenancies WHERE tenancy_id = $1 FOR UPDATE`,
        [tenancyId],
      );
      const tenancy = checkResult.rows[0];
      if (!tenancy || tenancy.payment_status === 'Paid') {
        await client.query('ROLLBACK');
        return res.status(200).send('Ledger already updated');
      }

      await client.query(
        `UPDATE tenancies SET payment_status = 'Paid', payment_reference = $1 WHERE tenancy_id = $2`,
        [event.data.reference, tenancyId],
      );

      const rentAmount = parseFloat(tenancy.rent_amount);
      let gatewayFee = rentAmount * 0.015 + 100;
      if (gatewayFee > 2000) gatewayFee = 2000;

      const propQuery = await client.query(
        `SELECT title FROM properties WHERE property_id = (SELECT property_id FROM tenancies WHERE tenancy_id = $1)`,
        [tenancyId],
      );
      const propertyTitle = propQuery.rows[0]?.title || 'Propadi Property';

      // Record transactions
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'payment', 'Annual Rent Payment', $2, $3, 'Completed')`,
        [tenancy.renter_id, propertyTitle, -rentAmount],
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'fee', 'Propadi Secure Gateway Fee', 'Platform Service', $2, 'Completed')`,
        [tenancy.renter_id, -gatewayFee],
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'credit', 'Rent Payment Received', $2, $3, 'Completed')`,
        [tenancy.owner_id, propertyTitle, rentAmount],
      );
      await client.query(
        `UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1, updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $2`,
        [rentAmount, tenancy.owner_id],
      );

      // ✅ Mark pending referral as completed (if any)
      await client.query(
        `UPDATE referrals 
         SET status = 'Completed' 
         WHERE referee_id = $1 AND status = 'Pending'`,
        [tenancy.renter_id],
      );

      await client.query('COMMIT');

      console.log(
        `[WEBHOOK SUCCESS] Tenancy ${tenancyId} automatically funded and verified.`,
      );

      // Send push notification to owner
      await sendPushToUser(
        tenancy.owner_id,
        '💰 Rent Payment Received',
        `₦${parseFloat(Number(rentAmount)).toLocaleString()} has been added to your wallet for ${propertyTitle}`,
        { screen: 'LandlordWallet' },
      );
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[WEBHOOK CRASH]', error);
    } finally {
      client.release();
    }
  }
  res.status(200).send('Webhook received successfully');
});

// POST /api/webhook/paystack-service – handles service escrow payments
app.post('/api/webhook/paystack-service', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).send('Invalid signature');
  }

  const event = req.body;
  if (event.event === 'charge.success') {
    const metadata = event.data.metadata;
    if (!metadata || metadata.type !== 'service_escrow') {
      return res.status(200).send('Not a service escrow event, ignored.');
    }
    const serviceId = metadata.service_id;
    if (!serviceId) return res.status(200).send('No service ID, ignored.');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if already funded
      const checkResult = await client.query(
        `SELECT price_status FROM service_requests WHERE service_id = $1 FOR UPDATE`,
        [serviceId],
      );
      if (
        checkResult.rows.length === 0 ||
        checkResult.rows[0].price_status === 'funded'
      ) {
        await client.query('ROLLBACK');
        return res.status(200).send('Already funded');
      }

      // Update service request status
      await client.query(
        `UPDATE service_requests SET price_status = 'funded' WHERE service_id = $1`,
        [serviceId],
      );

      // Create escrow record
      const serviceResult = await client.query(
        `SELECT final_price, estimated_cost FROM service_requests WHERE service_id = $1`,
        [serviceId],
      );
      const amount =
        parseFloat(serviceResult.rows[0].final_price) ||
        parseFloat(serviceResult.rows[0].estimated_cost);
      await client.query(
        `INSERT INTO service_escrow (service_request_id, amount, status) VALUES ($1, $2, 'held')`,
        [serviceId, amount],
      );

      // Notify provider that job is funded
      const providerResult = await client.query(
        `SELECT provider_id FROM service_requests WHERE service_id = $1`,
        [serviceId],
      );
      if (
        providerResult.rows.length > 0 &&
        providerResult.rows[0].provider_id
      ) {
        await sendPushToUser(
          providerResult.rows[0].provider_id,
          '💰 Job Funded',
          `The owner has funded the escrow for your job. You can now start work.`,
          { screen: 'ProviderDashboard', service_id: serviceId },
        );
      }

      await client.query('COMMIT');
      console.log(`[SERVICE ESCROW] Service ${serviceId} funded successfully.`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Service escrow webhook error:', err);
    } finally {
      client.release();
    }
  }
  res.status(200).send('Webhook received');
});

// ==========================================
// ROLE-BASED WALLET & LEDGER ROUTES
// ==========================================

app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const walletResult = await pool.query(
      'SELECT balance, total_earned, pending_clearance FROM wallets WHERE user_id = $1',
      [userId],
    );
    let wallet = walletResult.rows[0] || {
      balance: 0,
      total_earned: 0,
      pending_clearance: 0,
    };
    const txnResult = await pool.query(
      `SELECT id, type, title, property_ref as property, amount, created_at as date, status FROM transactions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    res.json({ success: true, ...wallet, transactions: txnResult.rows || [] });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch landlord wallet' });
  }
});

app.get('/api/tenant-wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const paidResult = await pool.query(
      `SELECT SUM(ABS(amount)) as total_paid FROM transactions WHERE user_id = $1 AND type IN ('payment','fee') AND status = 'Completed'`,
      [userId],
    );
    const totalPaid = paidResult.rows[0].total_paid || 0;
    const rentalsResult = await pool.query(
      `SELECT COUNT(*) as active_count FROM tenancies WHERE renter_id = $1 AND payment_status = 'Paid'`,
      [userId],
    );
    const activeRentals = rentalsResult.rows[0].active_count || 0;
    const txnsResult = await pool.query(
      `SELECT id, type, title, property_ref as property, amount, created_at as date, status, id as reference FROM transactions WHERE user_id = $1 AND type IN ('payment','fee') ORDER BY created_at DESC`,
      [userId],
    );
    res.json({
      success: true,
      total_paid: parseFloat(totalPaid),
      active_rentals: parseInt(activeRentals),
      transactions: txnsResult.rows,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch tenant ledger' });
  }
});

// ==========================================
// RENEWAL SYSTEM
// ==========================================

app.post('/api/tenancies/:id/renew', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { new_rent_amount } = req.body;
    await client.query('BEGIN');
    const origResult = await client.query(
      `SELECT renter_id, owner_id, property_id, rent_amount, lease_end_date, payment_status FROM tenancies WHERE tenancy_id = $1 FOR UPDATE`,
      [id],
    );
    if (origResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: 'Tenancy not found' });
    }
    const orig = origResult.rows[0];
    if (orig.payment_status !== 'Paid') {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ success: false, error: 'Only paid tenancies can be renewed' });
    }
    const newRent = new_rent_amount
      ? parseFloat(new_rent_amount)
      : parseFloat(orig.rent_amount);
    const newStart = new Date(orig.lease_end_date);
    newStart.setDate(newStart.getDate() + 1);
    const newEnd = new Date(newStart);
    newEnd.setFullYear(newEnd.getFullYear() + 1);
    const insertResult = await client.query(
      `INSERT INTO tenancies (property_id, renter_id, owner_id, rent_amount, rent_period, lease_start_date, lease_end_date, status, payment_status, renewal_of_tenancy_id, renewal_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Draft','Pending',$8,'Pending') RETURNING *`,
      [
        orig.property_id,
        orig.renter_id,
        orig.owner_id,
        newRent,
        'Per Annum',
        newStart,
        newEnd,
        id,
      ],
    );
    const newTenancy = insertResult.rows[0];
    await client.query('COMMIT');
    const propertyTitleQuery = await pool.query(
      'SELECT title FROM properties WHERE property_id = $1',
      [orig.property_id],
    );
    const propTitle = propertyTitleQuery.rows[0]?.title || 'your property';
    await sendPushToUser(
      orig.renter_id,
      '📄 Lease Renewal Offer',
      `You have a renewal offer for ${propTitle}. Accept to sign and pay.`,
      { screen: 'Tenancy', tenancy_id: newTenancy.tenancy_id },
    );
    res.json({
      success: true,
      message: 'Renewal offer created.',
      tenancy: newTenancy,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Renewal creation error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Could not create renewal offer' });
  } finally {
    client.release();
  }
});

app.get('/api/tenancies/renewals/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT t.*, p.title as property_title, p.address_street, p.address_city, o.name as owner_name
       FROM tenancies t
       JOIN properties p ON t.property_id = p.property_id
       JOIN users o ON t.owner_id = o.user_id
       WHERE t.renter_id = $1 AND t.renewal_of_tenancy_id IS NOT NULL AND t.renewal_status = 'Pending'
       ORDER BY t.date_created DESC`,
      [userId],
    );
    res.json({ success: true, renewals: result.rows });
  } catch (err) {
    console.error('Renewal fetch error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch renewals' });
  }
});

app.post('/api/tenancies/:id/accept-renewal', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE tenancies SET renewal_status = 'Accepted' WHERE tenancy_id = $1 RETURNING *`,
      [id],
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Renewal not found' });
    res.json({ success: true, tenancy: result.rows[0] });
  } catch (err) {
    console.error('Accept renewal error:', err);
    res.status(500).json({ success: false, error: 'Failed to accept renewal' });
  }
});

app.get('/api/tenancies/landlord/:ownerId', async (req, res) => {
  try {
    const { ownerId } = req.params;
    const result = await pool.query(
      `SELECT t.tenancy_id, t.rent_amount, t.lease_start_date, t.lease_end_date, t.payment_status,
              p.title as property_title, p.address_street, p.address_city, u.name as renter_name
       FROM tenancies t
       JOIN properties p ON t.property_id = p.property_id
       JOIN users u ON t.renter_id = u.user_id
       WHERE t.owner_id = $1 AND LOWER(t.payment_status) = 'paid'
       ORDER BY t.lease_end_date ASC`,
      [ownerId],
    );
    res.json({ success: true, tenancies: result.rows });
  } catch (err) {
    console.error('Landlord tenancies fetch error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch tenancies' });
  }
});

// ==========================================
// PAYOUT ENGINE (Paystack Transfers)
// ==========================================

async function getOrCreateRecipient(userId, bankCode, accountNumber, email) {
  const response = await fetch('https://api.paystack.co/transferrecipient', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'nuban',
      name: `Propadi User ${userId.substring(0, 8)}`,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
      email: email,
    }),
  });
  const data = await response.json();
  if (data.status) return data.data.recipient_code;
  else throw new Error(data.message || 'Failed to create transfer recipient');
}

app.post('/api/wallet/withdraw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, amount, bankName, bankCode, accountNumber } = req.body;
    const withdrawAmount = parseFloat(amount);
    if (!withdrawAmount || withdrawAmount <= 0)
      return res
        .status(400)
        .json({ success: false, error: 'Invalid withdrawal amount' });
    const userResult = await client.query(
      'SELECT email FROM users WHERE user_id = $1',
      [userId],
    );
    if (userResult.rows.length === 0)
      return res.status(404).json({ success: false, error: 'User not found' });
    const userEmail = userResult.rows[0].email;
    await client.query('BEGIN');
    const walletResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    if (
      walletResult.rows.length === 0 ||
      parseFloat(walletResult.rows[0].balance) < withdrawAmount
    ) {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ success: false, error: 'Insufficient funds' });
    }
    await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
      [withdrawAmount, userId],
    );
    const withdrawalResult = await client.query(
      `INSERT INTO withdrawals (user_id, email, amount, bank_name, account_number, status, type, transfer_status)
       VALUES ($1,$2,$3,$4,$5,'Processing','Withdrawal','Processing') RETURNING *`,
      [userId, userEmail, withdrawAmount, bankName, accountNumber],
    );
    const withdrawal = withdrawalResult.rows[0];
    await client.query(
      `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) VALUES ($1,'withdrawal','Bank Withdrawal',$2,$3,'Pending')`,
      [userId, `To ${bankName} (${accountNumber.slice(-4)})`, -withdrawAmount],
    );
    await client.query('COMMIT');
    try {
      const recipientCode = await getOrCreateRecipient(
        userId,
        bankCode,
        accountNumber,
        userEmail,
      );
      const transferResponse = await fetch('https://api.paystack.co/transfer', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'balance',
          amount: withdrawAmount * 100,
          recipient: recipientCode,
          reason: `Propadi withdrawal for ${userEmail}`,
          currency: 'NGN',
          reference: `propadi_wd_${withdrawal.id}_${Date.now()}`,
        }),
      });
      const transferData = await transferResponse.json();
      if (transferData.status) {
        await pool.query(
          `UPDATE withdrawals SET transfer_code = $1, transfer_status = 'Processing', status = 'Processing' WHERE id = $2`,
          [transferData.data.transfer_code, withdrawal.id],
        );
        await pool.query(
          `UPDATE transactions SET status = 'Processing' WHERE id = (SELECT id FROM transactions WHERE user_id = $1 AND type = 'withdrawal' AND amount = $2 ORDER BY created_at DESC LIMIT 1)`,
          [userId, -withdrawAmount],
        );
        res.json({
          success: true,
          message:
            'Withdrawal initiated successfully. Funds will be sent shortly.',
          transfer_code: transferData.data.transfer_code,
        });
      } else {
        console.error('Paystack transfer error:', transferData);
        await pool.query(
          `UPDATE withdrawals SET transfer_status = 'Failed', failure_reason = $1, status = 'Failed' WHERE id = $2`,
          [transferData.message || 'Unknown error', withdrawal.id],
        );
        await pool.query(
          `UPDATE transactions SET status = 'Failed' WHERE id = (SELECT id FROM transactions WHERE user_id = $1 AND type = 'withdrawal' AND amount = $2 ORDER BY created_at DESC LIMIT 1)`,
          [userId, -withdrawAmount],
        );
        await pool.query(
          `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`,
          [withdrawAmount, userId],
        );
        res.status(400).json({
          success: false,
          error:
            transferData.message ||
            'Transfer failed. Your wallet has been refunded.',
        });
      }
    } catch (paystackError) {
      console.error('Paystack API error:', paystackError);
      await pool.query(
        `UPDATE withdrawals SET transfer_status = 'Failed', failure_reason = $1, status = 'Failed' WHERE id = $2`,
        [paystackError.message, withdrawal.id],
      );
      await pool.query(
        `UPDATE transactions SET status = 'Failed' WHERE id = (SELECT id FROM transactions WHERE user_id = $1 AND type = 'withdrawal' AND amount = $2 ORDER BY created_at DESC LIMIT 1)`,
        [userId, -withdrawAmount],
      );
      await pool.query(
        `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`,
        [withdrawAmount, userId],
      );
      res.status(500).json({
        success: false,
        error: 'Payment gateway error. Wallet refunded.',
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Withdrawal error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process withdrawal' });
  } finally {
    client.release();
  }
});

app.post('/api/webhook/paystack-transfer', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (hash !== req.headers['x-paystack-signature'])
    return res.status(400).send('Invalid signature');
  const event = req.body;
  if (event.event === 'transfer.success') {
    const transferCode = event.data.transfer_code;
    await pool.query(
      `UPDATE withdrawals SET transfer_status = 'Success', status = 'Completed' WHERE transfer_code = $1`,
      [transferCode],
    );
    await pool.query(
      `UPDATE transactions SET status = 'Completed' WHERE user_id = (SELECT user_id FROM withdrawals WHERE transfer_code = $1) AND type = 'withdrawal' ORDER BY created_at DESC LIMIT 1`,
      [transferCode],
    );
  } else if (event.event === 'transfer.failed') {
    const transferCode = event.data.transfer_code;
    await pool.query(
      `UPDATE withdrawals SET transfer_status = 'Failed', failure_reason = $1, status = 'Failed' WHERE transfer_code = $2`,
      [event.data.reason, transferCode],
    );
  }
  res.sendStatus(200);
});

// ==========================================
// PUSH NOTIFICATIONS
// ==========================================

async function sendPushToUser(userId, title, body, data = {}) {
  try {
    const { rows } = await pool.query(
      'SELECT token FROM user_push_tokens WHERE user_id = $1',
      [userId],
    );
    if (rows.length === 0) return;
    const messages = rows.map((row) => ({
      to: row.token,
      sound: 'default',
      title,
      body,
      data,
    }));
    const expoResponse = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    const result = await expoResponse.json();
    if (result.errors) console.error('Expo push errors:', result.errors);
    for (const msg of messages) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, body, data) VALUES ($1,$2,$3,$4)`,
        [userId, title, body, JSON.stringify(data)],
      );
    }
  } catch (err) {
    console.error('sendPushToUser error:', err);
  }
}

app.post('/api/notifications/register-token', async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token)
    return res
      .status(400)
      .json({ success: false, error: 'Missing userId or token' });
  try {
    await pool.query(
      `INSERT INTO user_push_tokens (user_id, token, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (token) DO UPDATE SET updated_at = NOW()`,
      [userId, token],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Register token error:', err);
    res.status(500).json({ success: false, error: 'Failed to register token' });
  }
});

// ==========================================
// MAINTENANCE REQUESTS ROUTES (User)
// ==========================================

app.get('/api/maintenance/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT m.request_id as id, m.category, m.title, m.description, m.status, m.date_submitted as created_at, m.media_url, p.title as property_title 
       FROM maintenance_requests m JOIN properties p ON m.property_id = p.property_id WHERE m.renter_id = $1 OR m.owner_id = $1 ORDER BY m.date_submitted DESC`,
      [userId],
    );
    res.json({ success: true, tickets: result.rows });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch maintenance requests' });
  }
});

app.post('/api/maintenance', async (req, res) => {
  try {
    const { renter_id, category, title, description, media_url } = req.body;
    const tenancyResult = await pool.query(
      `SELECT tenancy_id, property_id, owner_id FROM tenancies WHERE renter_id = $1 AND status = 'Signed' LIMIT 1`,
      [renter_id],
    );
    if (tenancyResult.rows.length === 0)
      return res
        .status(400)
        .json({ success: false, error: 'No active tenancy found.' });
    const { tenancy_id, property_id, owner_id } = tenancyResult.rows[0];
    const result = await pool.query(
      `INSERT INTO maintenance_requests (tenancy_id, property_id, renter_id, owner_id, category, title, description, media_url, status, date_submitted) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pending',CURRENT_TIMESTAMP) RETURNING *`,
      [
        tenancy_id,
        property_id,
        renter_id,
        owner_id,
        category,
        title,
        description,
        media_url || null,
      ],
    );
    const propResult = await pool.query(
      'SELECT title FROM properties WHERE property_id = $1',
      [property_id],
    );
    const propertyTitle = propResult.rows[0].title;
    // After creating the ticket, notify the owner
    try {
      await sendPushToUser(
        owner_id,
        '🔧 New Maintenance Issue Reported',
        `A tenant reported "${title}" for ${propertyTitle}`,
        { screen: 'Maintenance', ticket_id: result.rows[0].request_id },
      );
    } catch (pushErr) {
      console.error('Push notification error:', pushErr);
    }
    res.json({
      success: true,
      ticket: {
        ...result.rows[0],
        id: result.rows[0].request_id,
        created_at: result.rows[0].date_submitted,
        property_title: propertyTitle,
      },
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to submit maintenance request' });
  }
});

app.put('/api/maintenance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const query =
      status === 'Resolved'
        ? `UPDATE maintenance_requests SET status = $1, date_resolved = CURRENT_TIMESTAMP WHERE request_id = $2 RETURNING *`
        : `UPDATE maintenance_requests SET status = $1 WHERE request_id = $2 RETURNING *`;
    const result = await pool.query(query, [status, id]);
    res.json({ success: true, ticket: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

// ==========================================
// ADMIN DASHBOARD ENDPOINTS (with all features)
// ==========================================

// GET /api/admin/stats – platform statistics
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    const propertiesCount = await pool.query('SELECT COUNT(*) FROM properties');
    const activeTenancies = await pool.query(
      "SELECT COUNT(*) FROM tenancies WHERE payment_status = 'Paid'",
    );
    const totalRentCollected = await pool.query(
      "SELECT SUM(rent_amount) FROM tenancies WHERE payment_status = 'Paid'",
    );
    const totalFees = await pool.query(
      "SELECT SUM(ABS(amount)) FROM transactions WHERE type = 'fee' AND status = 'Completed'",
    );
    res.json({
      success: true,
      stats: {
        totalUsers: parseInt(usersCount.rows[0].count),
        totalProperties: parseInt(propertiesCount.rows[0].count),
        activeTenancies: parseInt(activeTenancies.rows[0].count),
        totalRentCollected: parseFloat(totalRentCollected.rows[0].sum || 0),
        totalPlatformFees: parseFloat(totalFees.rows[0].sum || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/feedback – list all feedback (admin only)
app.get('/api/admin/feedback', requireAdmin, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT f.id, f.user_id, u.name as user_name, u.email as user_email,
             f.subject, f.message, f.created_at, f.reviewed
      FROM feedback f
      LEFT JOIN users u ON f.user_id = u.user_id
      WHERE 1=1
    `;
    const values = [];
    let paramIndex = 1;
    if (status === 'reviewed') {
      query += ` AND f.reviewed = TRUE`;
    } else if (status === 'unreviewed') {
      query += ` AND (f.reviewed IS NULL OR f.reviewed = FALSE)`;
    }
    query += ` ORDER BY f.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    values.push(parseInt(limit), parseInt(offset));
    const result = await pool.query(query, values);
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM feedback',
    );
    res.json({
      success: true,
      feedback: result.rows,
      total: parseInt(countResult.rows[0].total),
    });
  } catch (err) {
    console.error('Admin feedback error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/feedback/:id/review – mark feedback as reviewed (admin only)
app.put('/api/admin/feedback/:id/review', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE feedback SET reviewed = TRUE, reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2`,
      [req.adminUser.id, id],
    );
    res.json({ success: true, message: 'Feedback marked as reviewed' });
  } catch (err) {
    console.error('Mark reviewed error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/referrals – list all referrals (admin only)
app.get('/api/admin/referrals', requireAdmin, async (req, res) => {
  try {
    const { status, limit = 100, offset = 0 } = req.query;
    let query = `
      SELECT 
        r.referral_id,
        r.status,
        r.reward_type,
        r.date_referred,
        r.date_rewarded,
        referrer.user_id as referrer_id,
        referrer.name as referrer_name,
        referrer.email as referrer_email,
        referee.user_id as referee_id,
        referee.name as referee_name,
        referee.email as referee_email
      FROM referrals r
      JOIN users referrer ON r.referrer_id = referrer.user_id
      JOIN users referee ON r.referee_id = referee.user_id
      WHERE 1=1
    `;
    const values = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      query += ` AND r.status = $${paramIndex}`;
      values.push(status);
      paramIndex++;
    }

    query += ` ORDER BY r.date_referred DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    values.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, values);

    // Get summary stats
    const statsQuery = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'Rewarded' THEN 1 ELSE 0 END) as rewarded,
        COALESCE(SUM(CASE WHEN status = 'Rewarded' THEN 2000 ELSE 0 END), 0) as total_rewards_paid
      FROM referrals
    `;
    const statsResult = await pool.query(statsQuery);

    res.json({
      success: true,
      referrals: result.rows,
      stats: statsResult.rows[0],
      total: result.rows.length,
    });
  } catch (err) {
    console.error('Admin referrals error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/users – list users with sorting by trust score
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { role, sort_by } = req.query;
    let query = `SELECT user_id, name, email, role, is_admin, renter_score, kyc_status, date_joined FROM users`;
    const params = [];
    const conditions = [];
    if (role) {
      conditions.push(`role = $${params.length + 1}`);
      params.push(role);
    }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    if (sort_by === 'renter_score_asc')
      query += ' ORDER BY renter_score ASC NULLS LAST';
    else if (sort_by === 'renter_score_desc')
      query += ' ORDER BY renter_score DESC NULLS LAST';
    else query += ' ORDER BY date_joined DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/users/:userId – update role/admin flag
app.put('/api/admin/users/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role, is_admin } = req.body;
    let query = 'UPDATE users SET ';
    const updates = [],
      values = [];
    if (role) {
      updates.push(`role = $${updates.length + 1}`);
      values.push(role);
    }
    if (is_admin !== undefined) {
      updates.push(`is_admin = $${updates.length + 1}`);
      values.push(is_admin);
    }
    if (updates.length === 0)
      return res
        .status(400)
        .json({ success: false, error: 'No fields to update' });
    query +=
      updates.join(', ') +
      ' WHERE user_id = $' +
      (values.length + 1) +
      ' RETURNING user_id, name, email, role, is_admin';
    values.push(userId);
    const result = await pool.query(query, values);
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: 'User not found' });
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
      [
        req.adminUser.id,
        'UPDATE_USER_ROLE',
        'user',
        userId,
        JSON.stringify({ role, is_admin }),
      ],
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/withdrawals – list all withdrawal requests
app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM withdrawals WHERE type = 'Withdrawal' ORDER BY created_at DESC",
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching withdrawals:', err);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// PUT /api/admin/withdrawals/:id – approve/reject withdrawal
app.put('/api/admin/withdrawals/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const checkResult = await pool.query(
      'SELECT * FROM withdrawals WHERE id = $1',
      [id],
    );
    if (checkResult.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Withdrawal not found' });
    const withdrawal = checkResult.rows[0];
    const updateResult = await pool.query(
      'UPDATE withdrawals SET status = $1 WHERE id = $2 RETURNING *',
      [status, id],
    );
    if (status === 'Paid') {
      await pool.query(
        'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
        [withdrawal.amount, withdrawal.user_id],
      );
      await resend.emails.send({
        from: 'Propadi <onboarding@resend.dev>',
        to: withdrawal.email || 'test@example.com',
        subject: 'Propadi Withdrawal Successful',
        html: `<h3>Great news!</h3><p>Your withdrawal of ₦${Number(withdrawal.amount).toLocaleString('en-US')} has been processed and sent to your account.</p>`,
      });
    }
    res.json({
      success: true,
      message: 'Status updated, balance adjusted, and email sent!',
      data: updateResult.rows[0],
    });
  } catch (err) {
    console.error('Update Status Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// FAVORITE / SAVED PROPERTIES ENDPOINTS
app.post('/api/properties/:id/favorite', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'User ID is required' });

    const existing = await pool.query(
      'SELECT * FROM saved_properties WHERE user_id = $1 AND property_id = $2',
      [userId, id]
    );

    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM saved_properties WHERE user_id = $1 AND property_id = $2', [userId, id]);
      return res.json({ success: true, isSaved: false, message: 'Removed from saved properties' });
    } else {
      await pool.query('INSERT INTO saved_properties (user_id, property_id) VALUES ($1, $2)', [userId, id]);
      return res.json({ success: true, isSaved: true, message: 'Property saved to favorites!' });
    }
  } catch (err) {
    console.error('Favorite toggle error:', err);
    res.status(500).json({ success: false, error: 'Failed to toggle favorite' });
  }
});

app.get('/api/properties/:id/favorite/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!userId) return res.json({ success: true, isSaved: false });

    const existing = await pool.query(
      'SELECT * FROM saved_properties WHERE user_id = $1 AND property_id = $2',
      [userId, id]
    );
    res.json({ success: true, isSaved: existing.rows.length > 0 });
  } catch (err) {
    console.error('Favorite status check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check favorite status' });
  }
});

app.get('/api/properties/saved/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT p.*, sp.created_at as saved_at 
       FROM saved_properties sp
       JOIN properties p ON sp.property_id = p.property_id
       WHERE sp.user_id = $1
       ORDER BY sp.created_at DESC`,
      [userId]
    );
    res.json({ success: true, properties: result.rows });
  } catch (err) {
    console.error('Fetch saved properties error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch saved properties' });
  }
});

// GET /api/admin/properties – list all properties for admin moderation
app.get('/api/admin/properties', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT p.*, u.name as owner_name, u.email as owner_email,
             (SELECT COUNT(*) FROM applications WHERE property_id = p.property_id) as application_count
      FROM properties p
      JOIN users u ON p.owner_id = u.user_id
    `;
    const params = [];
    if (status && status !== 'all') {
      query += ' WHERE p.status = $1';
      params.push(status);
    }
    query += ' ORDER BY p.date_listed DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, properties: result.rows });
  } catch (err) {
    console.error('Admin properties fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/properties/:id/status – update status and/or is_featured (with logging)
app.put('/api/admin/properties/:id/status', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, is_featured, admin_note } = req.body;
    let updates = [],
      values = [];
    if (status !== undefined) {
      updates.push(`status = $${values.length + 1}`);
      values.push(status);
    }
    if (is_featured !== undefined) {
      updates.push(`is_featured = $${values.length + 1}`);
      values.push(is_featured);
    }
    if (updates.length === 0)
      return res
        .status(400)
        .json({ success: false, error: 'No fields to update' });
    const query = `UPDATE properties SET ${updates.join(', ')} WHERE property_id = $${values.length + 1} RETURNING *`;
    values.push(id);
    const result = await pool.query(query, values);
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Property not found' });
    const property = result.rows[0];
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
      [
        req.adminUser.id,
        'UPDATE_PROPERTY',
        'property',
        id,
        JSON.stringify({ status, is_featured, admin_note }),
      ],
    );
    if (status !== undefined) {
      try {
        let title = '',
          body = '';
        if (status === 'Available') {
          title = 'Property Approved';
          body = `Your property "${property.title}" has been approved and is now live.`;
        } else if (status === 'Rejected') {
          title = 'Property Rejected';
          body = `Your property "${property.title}" was not approved. Please check the listing details.`;
        }
        if (title)
          await sendPushToUser(property.owner_id, title, body, {
            screen: 'MyProperties',
          });
      } catch (pushErr) {
        console.error('Push notification failed', pushErr);
      }
    }
    res.json({ success: true, property });
  } catch (err) {
    console.error('Update property error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/transactions – list all platform transactions
app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const result = await pool.query(
      `SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.user_id ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)],
    );
    const count = await pool.query('SELECT COUNT(*) FROM transactions');
    res.json({
      success: true,
      transactions: result.rows,
      total: parseInt(count.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/users/:userId – delete user
app.delete('/api/admin/users/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId === req.adminUser.id)
      return res.status(400).json({
        success: false,
        error: 'Cannot delete your own admin account',
      });
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id) VALUES ($1,$2,$3,$4)',
      [req.adminUser.id, 'DELETE_USER', 'user', userId],
    );
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// ADMIN MAINTENANCE OVERSIGHT (new)
// ==========================================

// GET /api/admin/maintenance – list all maintenance tickets
app.get('/api/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const {
      status,
      property_id,
      owner_id,
      renter_id,
      limit = 50,
      offset = 0,
    } = req.query;
    let query = `
      SELECT m.request_id as id, m.category, m.title, m.description, m.status, m.date_submitted as created_at,
             m.date_resolved as resolved_at, m.media_url,
             p.title as property_title, p.property_id,
             u_owner.name as owner_name, u_owner.user_id as owner_id,
             u_renter.name as renter_name, u_renter.user_id as renter_id
      FROM maintenance_requests m
      JOIN properties p ON m.property_id = p.property_id
      JOIN users u_owner ON m.owner_id = u_owner.user_id
      JOIN users u_renter ON m.renter_id = u_renter.user_id
      WHERE 1=1
    `;
    const values = [];
    let paramIndex = 1;
    if (status && status !== 'all') {
      query += ` AND m.status = $${paramIndex}`;
      values.push(status);
      paramIndex++;
    }
    if (property_id) {
      query += ` AND m.property_id = $${paramIndex}`;
      values.push(property_id);
      paramIndex++;
    }
    if (owner_id) {
      query += ` AND m.owner_id = $${paramIndex}`;
      values.push(owner_id);
      paramIndex++;
    }
    if (renter_id) {
      query += ` AND m.renter_id = $${paramIndex}`;
      values.push(renter_id);
      paramIndex++;
    }
    query += ` ORDER BY m.date_submitted DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    values.push(parseInt(limit), parseInt(offset));
    const result = await pool.query(query, values);
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM maintenance_requests',
    );
    res.json({
      success: true,
      tickets: result.rows,
      total: parseInt(countResult.rows[0].total),
    });
  } catch (err) {
    console.error('Admin maintenance fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/maintenance/:id – update status and admin note
app.put('/api/admin/maintenance/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, admin_note } = req.body;
    if (!status)
      return res
        .status(400)
        .json({ success: false, error: 'Status is required' });
    await client.query('BEGIN');
    const ticketResult = await client.query(
      `SELECT owner_id, renter_id, property_id, status as old_status FROM maintenance_requests WHERE request_id = $1`,
      [id],
    );
    if (ticketResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: 'Ticket not found' });
    }
    const ticket = ticketResult.rows[0];
    const updateQuery =
      status === 'Resolved'
        ? `UPDATE maintenance_requests SET status = $1, date_resolved = CURRENT_TIMESTAMP WHERE request_id = $2 RETURNING *`
        : `UPDATE maintenance_requests SET status = $1 WHERE request_id = $2 RETURNING *`;
    const updateResult = await client.query(updateQuery, [status, id]);
    await client.query(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
      [
        req.adminUser.id,
        'UPDATE_MAINTENANCE_STATUS',
        'maintenance_request',
        id,
        JSON.stringify({
          old_status: ticket.old_status,
          new_status: status,
          admin_note,
        }),
      ],
    );
    const propertyResult = await client.query(
      'SELECT title FROM properties WHERE property_id = $1',
      [ticket.property_id],
    );
    const propertyTitle = propertyResult.rows[0]?.title || 'your property';
    const title = `Maintenance Request ${status}`;
    const body = `Your request for "${propertyTitle}" is now ${status}.${admin_note ? ` Note: ${admin_note}` : ''}`;
    await sendPushToUser(ticket.owner_id, title, body, {
      screen: 'Maintenance',
      ticket_id: id,
    });
    await sendPushToUser(ticket.renter_id, title, body, {
      screen: 'Maintenance',
      ticket_id: id,
    });
    await client.query('COMMIT');
    res.json({ success: true, ticket: updateResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Admin maintenance update error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// ADMIN BROADCAST (Push Notifications)
// ==========================================

// POST /api/admin/broadcast – send push to all users (or filtered by role)
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    const { title, body, role } = req.body;
    if (!title || !body)
      return res
        .status(400)
        .json({ success: false, error: 'Title and body are required' });
    let userQuery = 'SELECT user_id FROM users';
    const params = [];
    if (role && role !== 'all') {
      userQuery += ' WHERE role = $1';
      params.push(role);
    }
    const { rows: users } = await pool.query(userQuery, params);
    let successCount = 0,
      failCount = 0;
    for (const user of users) {
      try {
        await sendPushToUser(user.user_id, title, body, {
          screen: 'AdminBroadcast',
        });
        successCount++;
      } catch (err) {
        failCount++;
      }
    }
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, target_type, details) VALUES ($1,$2,$3,$4)',
      [
        req.adminUser.id,
        'BROADCAST',
        'system',
        JSON.stringify({ title, body, role, successCount, failCount }),
      ],
    );
    res.json({
      success: true,
      message: `Broadcast sent to ${successCount} users. Failed: ${failCount}`,
      successCount,
      failCount,
    });
  } catch (err) {
    console.error('Broadcast error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// DISPUTE RESOLUTION (Requires 'disputes' table)
// ==========================================

// GET /api/admin/disputes – list all disputes
app.get('/api/admin/disputes', requireAdmin, async (req, res) => {
  try {
    const { status, reference_type, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT d.*, 
             u_raiser.name as raiser_name, u_raiser.email as raiser_email,
             u_target.name as target_name, u_target.email as target_email,
             u_resolver.name as resolver_name
      FROM disputes d
      LEFT JOIN users u_raiser ON d.raised_by = u_raiser.user_id
      LEFT JOIN users u_target ON d.raised_against = u_target.user_id
      LEFT JOIN users u_resolver ON d.resolved_by = u_resolver.user_id
      WHERE 1=1
    `;
    const values = [];
    let paramIndex = 1;
    if (status && status !== 'all') {
      query += ` AND d.status = $${paramIndex}`;
      values.push(status);
      paramIndex++;
    }
    if (reference_type && reference_type !== 'all') {
      query += ` AND d.reference_type = $${paramIndex}`;
      values.push(reference_type);
      paramIndex++;
    }
    query += ` ORDER BY d.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    values.push(parseInt(limit), parseInt(offset));
    const result = await pool.query(query, values);
    res.json({ success: true, disputes: result.rows });
  } catch (err) {
    console.error('Admin disputes fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/disputes/:id – update status and admin notes
app.put('/api/admin/disputes/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status, admin_notes } = req.body;
    if (!status)
      return res
        .status(400)
        .json({ success: false, error: 'Status is required' });
    await client.query('BEGIN');
    const updateFields = [],
      values = [];
    let paramIndex = 1;
    updateFields.push(`status = $${paramIndex}`);
    values.push(status);
    paramIndex++;
    if (admin_notes !== undefined) {
      updateFields.push(`admin_notes = $${paramIndex}`);
      values.push(admin_notes);
      paramIndex++;
    }
    if (status === 'resolved' || status === 'dismissed') {
      updateFields.push(`resolved_at = NOW(), resolved_by = $${paramIndex}`);
      values.push(req.adminUser.id);
      paramIndex++;
    }
    const query = `UPDATE disputes SET ${updateFields.join(', ')} WHERE dispute_id = $${paramIndex} RETURNING *`;
    values.push(id);
    const result = await client.query(query, values);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: 'Dispute not found' });
    }
    await client.query(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
      [
        req.adminUser.id,
        'UPDATE_DISPUTE',
        'dispute',
        id,
        JSON.stringify({ status, admin_notes }),
      ],
    );
    await client.query('COMMIT');
    res.json({ success: true, dispute: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Admin dispute update error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/admin/disputes – create a new dispute (admin initiated)
app.post('/api/admin/disputes', requireAdmin, async (req, res) => {
  try {
    const { reference_type, reference_id, raised_by, raised_against, reason } =
      req.body;
    if (!reference_type || !reference_id || !reason)
      return res
        .status(400)
        .json({ success: false, error: 'Missing required fields' });
    const result = await pool.query(
      `INSERT INTO disputes (reference_type, reference_id, raised_by, raised_against, reason, status) VALUES ($1,$2,$3,$4,$5,'open') RETURNING *`,
      [
        reference_type,
        reference_id,
        raised_by || null,
        raised_against || null,
        reason,
      ],
    );
    res.json({ success: true, dispute: result.rows[0] });
  } catch (err) {
    console.error('Create dispute error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// RATING & REVIEW SYSTEM
// ==========================================

app.post('/api/reviews', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      reviewer_id,
      reviewee_id,
      tenancy_id,
      rating,
      comment,
      is_landlord_review,
    } = req.body;
    if (!reviewer_id || !reviewee_id || !rating || rating < 1 || rating > 5)
      return res
        .status(400)
        .json({ success: false, error: 'Invalid review data' });
    const existing = await client.query(
      'SELECT id FROM reviews WHERE reviewer_id=$1 AND tenancy_id=$2',
      [reviewer_id, tenancy_id],
    );
    if (existing.rows.length > 0)
      return res.status(400).json({
        success: false,
        error: 'You have already reviewed this tenancy',
      });
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO reviews (reviewer_id, reviewee_id, tenancy_id, rating, comment, is_landlord_review) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        reviewer_id,
        reviewee_id,
        tenancy_id,
        rating,
        comment,
        is_landlord_review || false,
      ],
    );
    const avgResult = await client.query(
      'SELECT AVG(rating)::DECIMAL(10,2) as avg FROM reviews WHERE reviewee_id=$1',
      [reviewee_id],
    );
    const avgRating = parseFloat(avgResult.rows[0].avg) || 0;
    await client.query('UPDATE users SET avg_rating = $1 WHERE user_id = $2', [
      avgRating,
      reviewee_id,
    ]);
    if (rating === 5)
      await client.query(
        'UPDATE users SET renter_score = renter_score + 2 WHERE user_id = $1',
        [reviewee_id],
      );
    else if (rating === 1)
      await client.query(
        'UPDATE users SET renter_score = renter_score - 1 WHERE user_id = $1',
        [reviewee_id],
      );
    const reviewerNameQuery = await client.query(
      'SELECT name FROM users WHERE user_id = $1',
      [reviewer_id],
    );
    const reviewerName = reviewerNameQuery.rows[0]?.name || 'Someone';
    await sendPushToUser(
      reviewee_id,
      '⭐ New Review Received',
      `${reviewerName} gave you a ${rating}-star review.`,
      { screen: 'Profile' },
    );
    await client.query('COMMIT');
    res.json({ success: true, review: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Review submission error:', err);
    res.status(500).json({ success: false, error: 'Failed to submit review' });
  } finally {
    client.release();
  }
});

app.get('/api/users/:userId/reviews', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT r.*, u.name as reviewer_name, u.profile_picture_url as avatar_url, p.title as property_title
       FROM reviews r
       JOIN users u ON r.reviewer_id = u.user_id
       LEFT JOIN tenancies t ON r.tenancy_id = t.tenancy_id
       LEFT JOIN properties p ON t.property_id = p.property_id
       WHERE r.reviewee_id = $1
       ORDER BY r.created_at DESC`,
      [userId],
    );
    res.json({ success: true, reviews: result.rows });
  } catch (err) {
    console.error('Fetch reviews error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch reviews' });
  }
});

app.get('/api/tenancies/:tenancyId/review-status', async (req, res) => {
  try {
    const { tenancyId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });
    const tenancyResult = await pool.query(
      `SELECT renter_id, owner_id, lease_end_date, payment_status FROM tenancies WHERE tenancy_id = $1`,
      [tenancyId],
    );
    if (tenancyResult.rows.length === 0)
      return res.json({
        success: true,
        canReview: false,
        reason: 'Tenancy not found',
      });
    const tenancy = tenancyResult.rows[0];
    const isParticipant =
      tenancy.renter_id === user.id || tenancy.owner_id === user.id;
    if (!isParticipant)
      return res.json({
        success: true,
        canReview: false,
        reason: 'You are not a party to this tenancy',
      });
    const now = new Date();
    const leaseEnd = new Date(tenancy.lease_end_date);
    const isCompleted = leaseEnd < now;
    if (!isCompleted && tenancy.payment_status !== 'Paid')
      return res.json({
        success: true,
        canReview: false,
        reason: 'Tenancy not yet completed or paid',
      });
    const existing = await pool.query(
      'SELECT id FROM reviews WHERE reviewer_id=$1 AND tenancy_id=$2',
      [user.id, tenancyId],
    );
    if (existing.rows.length > 0)
      return res.json({
        success: true,
        canReview: false,
        reason: 'You have already reviewed this tenancy',
      });
    res.json({
      success: true,
      canReview: true,
      revieweeId:
        tenancy.renter_id === user.id ? tenancy.owner_id : tenancy.renter_id,
    });
  } catch (err) {
    console.error('Review status error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to check review status' });
  }
});

// ==========================================
// NOTIFICATIONS (User)
// ==========================================

app.get('/api/notifications/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT id, title, body, data, read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    res.json({ success: true, notifications: result.rows });
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch notifications' });
  }
});

app.put('/api/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('UPDATE notifications SET read = TRUE WHERE id = $1', [
      id,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ success: false, error: 'Failed to update' });
  }
});

app.put('/api/notifications/mark-all-read', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });
    await pool.query(
      'UPDATE notifications SET read = TRUE WHERE user_id = $1',
      [user.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ success: false, error: 'Failed to update' });
  }
});

// ==========================================
// RECURRING RENT REMINDERS (Cron)
// ==========================================

app.post('/api/cron/check-rent-reminders', async (req, res) => {
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET)
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysLater = new Date(today);
    sevenDaysLater.setDate(today.getDate() + 7);
    const query = `
      SELECT t.tenancy_id, t.rent_amount, t.lease_end_date, t.last_rent_reminder_sent,
             u.user_id as tenant_id, u.email as tenant_email, u.name as tenant_name,
             p.title as property_title
      FROM tenancies t
      JOIN users u ON t.renter_id = u.user_id
      JOIN properties p ON t.property_id = p.property_id
      WHERE t.payment_status = 'Paid'
        AND t.lease_end_date > $1
        AND t.lease_end_date <= $2
        AND (t.last_rent_reminder_sent IS NULL OR t.last_rent_reminder_sent < $1)
    `;
    const { rows } = await pool.query(query, [today, sevenDaysLater]);
    let remindersSent = 0;
    for (const tenancy of rows) {
      const endDate = new Date(tenancy.lease_end_date);
      const daysUntilDue = Math.ceil(
        (endDate.getTime() - today.getTime()) / (1000 * 3600 * 24),
      );
      let reminderDays = null;
      if (daysUntilDue === 7) reminderDays = 7;
      else if (daysUntilDue === 3) reminderDays = 3;
      else if (daysUntilDue === 1) reminderDays = 1;
      if (!reminderDays) continue;
      const title = `Rent Due in ${reminderDays} Day${reminderDays > 1 ? 's' : ''}`;
      const body = `Your rent of ₦${tenancy.rent_amount.toLocaleString()} for ${tenancy.property_title} is due on ${endDate.toLocaleDateString()}. Please pay via Propadi to avoid late fees.`;
      await sendPushToUser(tenancy.tenant_id, title, body, {
        screen: 'TenantWallet',
      });
      try {
        await resend.emails.send({
          from: 'Propadi <onboarding@resend.dev>',
          to: tenancy.tenant_email,
          subject: title,
          html: `<p>Hello ${tenancy.tenant_name},</p><p>${body}</p><p>You can make payment securely through the Propadi app.</p>`,
        });
      } catch (e) { }
      await pool.query(
        'UPDATE tenancies SET last_rent_reminder_sent = $1 WHERE tenancy_id = $2',
        [today, tenancy.tenancy_id],
      );
      await pool.query(
        'INSERT INTO rent_reminder_logs (tenancy_id, days_before) VALUES ($1,$2)',
        [tenancy.tenancy_id, reminderDays],
      );
      remindersSent++;
    }
    res.json({ success: true, remindersSent });
  } catch (err) {
    console.error('Cron job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// VIEWING REMINDERS (Cron)
// ==========================================

app.post('/api/cron/check-viewing-reminders', async (req, res) => {
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET)
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const now = new Date();
    const query = `
      SELECT v.viewing_id, v.scheduled_start_time, v.reminder_24h_sent, v.reminder_3h_sent, v.reminder_1h_sent,
             v.renter_id, v.owner_id, v.property_id, p.title as property_title
      FROM viewings v JOIN properties p ON v.property_id = p.property_id
      WHERE v.status = 'Accepted' AND v.scheduled_start_time > NOW()
    `;
    const { rows } = await pool.query(query);
    let remindersSent = 0;
    for (const viewing of rows) {
      const startTime = new Date(viewing.scheduled_start_time);
      const diffHours = (startTime.getTime() - now.getTime()) / (1000 * 3600);
      let reminderType = null;
      if (diffHours <= 24 && diffHours > 23 && !viewing.reminder_24h_sent)
        reminderType = '24h';
      else if (diffHours <= 3 && diffHours > 2 && !viewing.reminder_3h_sent)
        reminderType = '3h';
      else if (diffHours <= 1 && diffHours > 0.5 && !viewing.reminder_1h_sent)
        reminderType = '1h';
      if (!reminderType) continue;
      const timeString = startTime.toLocaleString();
      const title = `Viewing Reminder (${reminderType})`;
      const body = `Your property viewing for "${viewing.property_title}" is scheduled at ${timeString}. Please be prepared.`;
      await sendPushToUser(viewing.renter_id, title, body, {
        screen: 'Chat',
        property_id: viewing.property_id,
        other_user_id: viewing.owner_id,
      });
      await sendPushToUser(viewing.owner_id, title, body, {
        screen: 'Chat',
        property_id: viewing.property_id,
        other_user_id: viewing.renter_id,
      });
      let updateColumn = '';
      if (reminderType === '24h') updateColumn = 'reminder_24h_sent = TRUE';
      else if (reminderType === '3h') updateColumn = 'reminder_3h_sent = TRUE';
      else if (reminderType === '1h') updateColumn = 'reminder_1h_sent = TRUE';
      await pool.query(
        `UPDATE viewings SET ${updateColumn} WHERE viewing_id = $1`,
        [viewing.viewing_id],
      );
      remindersSent++;
    }
    res.json({ success: true, remindersSent });
  } catch (err) {
    console.error('Viewing reminder cron error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// check-departure-confirmations (Cron)
// ==========================================

// POST /api/cron/check-departure-confirmations – auto-complete after 24h, or 12h if uncooperative
app.post('/api/cron/check-departure-confirmations', async (req, res) => {
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    // Case 1: Normal auto-confirm after 24h
    const normalConfirm = await pool.query(
      `SELECT mv.visit_id, mv.service_request_id, mr.renter_id, mv.owner_id, mv.provider_id, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.status = 'awaiting_departure'
         AND mv.renter_departure_confirmed = FALSE
         AND mv.renter_uncooperative = FALSE
         AND mv.departure_confirmed_at IS NULL
         AND mv.created_at < $1`,
      [twentyFourHoursAgo]
    );

    for (const visit of normalConfirm.rows) {
      await pool.query(
        `UPDATE maintenance_visits
         SET renter_departure_confirmed = TRUE,
             renter_confirmation_auto = TRUE,
             departure_confirmed_at = NOW(),
             status = 'completed'
         WHERE visit_id = $1`,
        [visit.visit_id]
      );

      // Penalise renter: -3 trust points
      if (visit.renter_id) {
        await pool.query(
          `UPDATE users SET renter_score = renter_score - 3 WHERE user_id = $1`,
          [visit.renter_id]
        );
      }

      await sendPushToUser(
        visit.owner_id,
        '⏰ Auto‑Confirmed Departure',
        `The renter did not confirm departure within 24 hours. The job has been auto‑completed. You may release payment.`,
        { screen: 'VisitManagement', visit_id: visit.visit_id }
      );
      if (visit.provider_id) {
        await sendPushToUser(
          visit.provider_id,
          '⏰ Auto‑Confirmed',
          `Renter did not confirm departure. Job auto‑completed. Payment is now available.`,
          { screen: 'ProviderDashboard', service_id: visit.service_request_id }
        );
      }
    }

    // Case 2: Uncooperative – auto-confirm after 12h from provider departure log
    const uncooperativeConfirm = await pool.query(
      `SELECT mv.visit_id, mv.service_request_id, mr.renter_id, mv.owner_id, mv.provider_id, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.status = 'awaiting_departure'
         AND mv.renter_departure_confirmed = FALSE
         AND mv.renter_uncooperative = TRUE
         AND mv.provider_departure_gps_lat IS NOT NULL
         AND mv.departure_confirmed_at IS NULL
         AND mv.departure_confirmed_at < $1`,  // we need to use the provider departure time; we'll use updated_at or add a provider_departure_time column. For now, we'll use created_at as fallback.
      [twelveHoursAgo]
    );

    // Actually, we need a `provider_departure_logged_at` column. Since we didn't add it, we can use `updated_at` as a proxy.
    // Let's add a more precise query: using the `updated_at` timestamp set when provider-departure is called.
    // We'll update the provider-departure endpoint to set `updated_at = NOW()`.
    // For now, we'll modify the query to use `updated_at`.
    // I'll provide a corrected query:

    const uncooperativeConfirmCorrected = await pool.query(
      `SELECT mv.visit_id, mv.service_request_id, mr.renter_id, mv.owner_id, mv.provider_id, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.status = 'awaiting_departure'
         AND mv.renter_departure_confirmed = FALSE
         AND mv.renter_uncooperative = TRUE
         AND mv.provider_departure_gps_lat IS NOT NULL
         AND mv.departure_confirmed_at IS NULL
         AND mv.updated_at < $1`,
      [twelveHoursAgo]
    );

    for (const visit of uncooperativeConfirmCorrected.rows) {
      await pool.query(
        `UPDATE maintenance_visits
         SET renter_departure_confirmed = TRUE,
             renter_confirmation_auto = TRUE,
             departure_confirmed_at = NOW(),
             status = 'completed'
         WHERE visit_id = $1`,
        [visit.visit_id]
      );

      // Serious penalty: -15 trust points
      if (visit.renter_id) {
        await pool.query(
          `UPDATE users SET renter_score = renter_score - 15 WHERE user_id = $1`,
          [visit.renter_id]
        );
      }

      await sendPushToUser(
        visit.owner_id,
        '⚠️ Auto‑Completed – Uncooperative Renter',
        `The renter did not confirm departure after the provider logged their exit. Job auto‑completed. Please review the provider's evidence.`,
        { screen: 'VisitManagement', visit_id: visit.visit_id }
      );
    }

    const totalProcessed = normalConfirm.rows.length + uncooperativeConfirmCorrected.rows.length;
    res.json({ success: true, processed: totalProcessed });
  } catch (err) {
    console.error('Departure auto‑confirm cron error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ==========================================
// PROPERTY VIEWS & ANALYTICS
// ==========================================

app.post('/api/properties/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    const { viewer_id } = req.body;
    await pool.query(
      'INSERT INTO property_views (property_id, viewer_id) VALUES ($1,$2)',
      [id, viewer_id || null],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Record view error:', err);
    res.status(500).json({ success: false, error: 'Failed to record view' });
  }
});

app.get('/api/owner/analytics', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });
    const ownerId = user.id;
    const propertiesResult = await pool.query(
      'SELECT property_id, title, rent_price, date_listed, status FROM properties WHERE owner_id = $1',
      [ownerId],
    );
    const properties = propertiesResult.rows;
    if (properties.length === 0)
      return res.json({
        success: true,
        analytics: {
          totalViews: 0,
          totalApplications: 0,
          activeTenancies: 0,
          avgDaysToRent: 0,
          properties: [],
        },
      });
    const propertyIds = properties.map((p) => p.property_id);
    const viewsResult = await pool.query(
      'SELECT COUNT(*) as total FROM property_views WHERE property_id = ANY($1::uuid[])',
      [propertyIds],
    );
    const totalViews = parseInt(viewsResult.rows[0].total);
    const appsResult = await pool.query(
      'SELECT COUNT(*) as total FROM applications WHERE property_id = ANY($1::uuid[])',
      [propertyIds],
    );
    const totalApplications = parseInt(appsResult.rows[0].total);
    const activeTenanciesResult = await pool.query(
      `SELECT COUNT(*) as total FROM tenancies WHERE property_id = ANY($1::uuid[]) AND payment_status = 'Paid' AND lease_end_date > NOW()`,
      [propertyIds],
    );
    const activeTenancies = parseInt(activeTenanciesResult.rows[0].total);
    let totalDays = 0,
      countWithTenancy = 0;
    for (const prop of properties) {
      const tenancyResult = await pool.query(
        `SELECT MIN(t.lease_start_date) as first_tenancy FROM tenancies t WHERE t.property_id = $1 AND t.payment_status = 'Paid'`,
        [prop.property_id],
      );
      if (tenancyResult.rows[0].first_tenancy) {
        const listedDate = new Date(prop.date_listed);
        const startDate = new Date(tenancyResult.rows[0].first_tenancy);
        const days = Math.ceil(
          (startDate.getTime() - listedDate.getTime()) / (1000 * 3600 * 24),
        );
        totalDays += days;
        countWithTenancy++;
      }
    }
    const avgDaysToRent =
      countWithTenancy > 0 ? Math.round(totalDays / countWithTenancy) : 0;
    const propertyStats = [];
    for (const prop of properties) {
      const viewsCount = await pool.query(
        'SELECT COUNT(*) as count FROM property_views WHERE property_id = $1',
        [prop.property_id],
      );
      const appsCount = await pool.query(
        'SELECT COUNT(*) as count FROM applications WHERE property_id = $1',
        [prop.property_id],
      );
      const tenancyCount = await pool.query(
        `SELECT COUNT(*) as count FROM tenancies WHERE property_id = $1 AND payment_status = 'Paid'`,
        [prop.property_id],
      );
      propertyStats.push({
        ...prop,
        views: parseInt(viewsCount.rows[0].count),
        applications: parseInt(appsCount.rows[0].count),
        tenancies: parseInt(tenancyCount.rows[0].count),
      });
    }
    res.json({
      success: true,
      analytics: {
        totalViews,
        totalApplications,
        activeTenancies,
        avgDaysToRent,
        properties: propertyStats,
      },
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// USER ONBOARDING & KYC (User endpoints)
// ==========================================

app.post('/api/users/onboarding', async (req, res) => {
  console.log('📥 Onboarding endpoint hit');
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });
    const {
      phone_number,
      residential_address,
      address_city,
      address_state,
      address_lga,
      date_of_birth,
      occupation,
      nok_full_name,
      nok_relationship,
      nok_phone,
      nok_address,
      nationality,
      state_of_origin,
      lga,
      marital_status,
    } = req.body;
    if (phone_number) {
      const existing = await pool.query(
        'SELECT user_id FROM users WHERE phone_number = $1 AND user_id != $2',
        [phone_number, user.id],
      );
      if (existing.rows.length > 0)
        return res.status(400).json({
          success: false,
          error: 'Phone number already registered by another user.',
        });
    }
    const updateFields = [],
      values = [];
    let paramIndex = 1;
    if (phone_number) {
      updateFields.push(`phone_number = $${paramIndex}`);
      values.push(phone_number);
      paramIndex++;
    }
    if (residential_address) {
      updateFields.push(`residential_address = $${paramIndex}`);
      values.push(residential_address);
      paramIndex++;
    }
    if (address_city) {
      updateFields.push(`address_city = $${paramIndex}`);
      values.push(address_city);
      paramIndex++;
    }
    if (address_state) {
      updateFields.push(`address_state = $${paramIndex}`);
      values.push(address_state);
      paramIndex++;
    }
    if (address_lga) {
      updateFields.push(`address_lga = $${paramIndex}`);
      values.push(address_lga);
      paramIndex++;
    }
    if (date_of_birth) {
      updateFields.push(`date_of_birth = $${paramIndex}`);
      values.push(date_of_birth);
      paramIndex++;
    }
    if (occupation) {
      updateFields.push(`occupation = $${paramIndex}`);
      values.push(occupation);
      paramIndex++;
    }
    if (nok_full_name) {
      updateFields.push(`nok_full_name = $${paramIndex}`);
      values.push(nok_full_name);
      paramIndex++;
    }
    if (nok_relationship) {
      updateFields.push(`nok_relationship = $${paramIndex}`);
      values.push(nok_relationship);
      paramIndex++;
    }
    if (nok_phone) {
      updateFields.push(`nok_phone = $${paramIndex}`);
      values.push(nok_phone);
      paramIndex++;
    }
    if (nok_address) {
      updateFields.push(`nok_address = $${paramIndex}`);
      values.push(nok_address);
      paramIndex++;
    }
    if (nationality) {
      updateFields.push(`nationality = $${paramIndex}`);
      values.push(nationality);
      paramIndex++;
    }
    if (state_of_origin) {
      updateFields.push(`state_of_origin = $${paramIndex}`);
      values.push(state_of_origin);
      paramIndex++;
    }
    if (lga) {
      updateFields.push(`lga = $${paramIndex}`);
      values.push(lga);
      paramIndex++;
    }
    if (marital_status) {
      updateFields.push(`marital_status = $${paramIndex}`);
      values.push(marital_status);
      paramIndex++;
    }
    if (updateFields.length === 0)
      return res
        .status(400)
        .json({ success: false, error: 'No fields to update' });
    updateFields.push(`kyc_tier = GREATEST(kyc_tier, 1)`);
    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE user_id = $${paramIndex} RETURNING user_id, name, email, role, kyc_tier`;
    values.push(user.id);
    const result = await pool.query(query, values);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Onboarding error:', err);
    if (err.code === '23505' && err.constraint === 'users_phone_number_key')
      return res.status(400).json({
        success: false,
        error: 'Phone number already in use by another account.',
      });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users/upload-kyc', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const { docType, propadiTenancyId, base64, fileType } = req.body;

    // Fast-track Instant Verification via Propadi Tenancy ID
    if (docType === 'propadi_tenancy' && propadiTenancyId) {
      const cleanTenancyId = propadiTenancyId.trim().toUpperCase();
      const tenancyRes = await pool.query(
        'SELECT tenancy_id, renter_id, owner_id, status FROM tenancies WHERE UPPER(propadi_tenancy_id) = $1',
        [cleanTenancyId]
      );

      if (tenancyRes.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Propadi Tenancy ID not found in database. Please verify code from your digital lease receipt.',
        });
      }

      const tenancy = tenancyRes.rows[0];
      const isOwnerOrRenter =
        tenancy.renter_id === user.id || tenancy.owner_id === user.id;

      if (!isOwnerOrRenter) {
        return res.status(403).json({
          success: false,
          error: 'This Propadi Tenancy ID belongs to another user account.',
        });
      }

      // Mark address as verified and approve Tier 4
      await pool.query(
        'UPDATE users SET address_verified = true, kyc_document_status = $1, kyc_tier = GREATEST(COALESCE(kyc_tier, 1), 4) WHERE user_id = $2',
        ['approved', user.id]
      );

      return res.json({
        success: true,
        verified: true,
        message: 'Propadi Tenancy verified instantly!',
      });
    }

    if (!base64)
      return res
        .status(400)
        .json({ success: false, error: 'No image provided' });

    const fileName = `${user.id}/${Date.now()}_kyc.${fileType || 'jpg'}`;
    const buffer = Buffer.from(base64, 'base64');
    const { error: uploadError } = await supabase.storage
      .from('kyc-documents')
      .upload(fileName, buffer, { contentType: `image/${fileType || 'jpeg'}` });
    if (uploadError) throw uploadError;
    const {
      data: { publicUrl },
    } = supabase.storage.from('kyc-documents').getPublicUrl(fileName);
    await pool.query(
      'UPDATE users SET kyc_document_url = $1, kyc_document_status = $2 WHERE user_id = $3',
      [publicUrl, 'pending', user.id],
    );
    res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('KYC upload error:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

app.post('/api/users/send-otp', async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number)
    return res
      .status(400)
      .json({ success: false, error: 'Phone number required' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  if (!global.otpStore) global.otpStore = {};
  global.otpStore[phone_number] = { otp, expiry: Date.now() + 10 * 60 * 1000 };
  console.log(`[SIMULATED OTP] for ${phone_number}: ${otp}`);
  res.json({ success: true, message: 'OTP sent (simulated)' });
});

app.post('/api/users/verify-otp', async (req, res) => {
  const { phone_number, otp } = req.body;
  if (!global.otpStore || !global.otpStore[phone_number])
    return res
      .status(400)
      .json({ success: false, error: 'No OTP request found' });
  const record = global.otpStore[phone_number];
  if (Date.now() > record.expiry) {
    delete global.otpStore[phone_number];
    return res.status(400).json({ success: false, error: 'OTP expired' });
  }
  if (record.otp !== otp)
    return res.status(400).json({ success: false, error: 'Invalid OTP' });
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user)
    return res.status(401).json({ success: false, error: 'Invalid token' });
  await pool.query(
    'UPDATE users SET phone_verified = TRUE, kyc_tier = GREATEST(kyc_tier, 2) WHERE user_id = $1',
    [user.id],
  );
  delete global.otpStore[phone_number];
  res.json({ success: true, message: 'Phone verified' });
});

app.get('/api/users/verification-status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });
    const result = await pool.query(
      `SELECT kyc_tier, phone_verified, nin_verified, address_verified, kyc_document_status, email, phone_number, name, residential_address, date_of_birth FROM users WHERE user_id = $1`,
      [user.id],
    );
    res.json({ success: true, verification: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// ADMIN KYC ENDPOINTS
// ==========================================

app.get('/api/admin/kyc/pending', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_id, name, email, kyc_document_url, kyc_document_status, date_joined as created_at FROM users WHERE kyc_document_status = 'pending' ORDER BY date_joined ASC`,
    );
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error('KYC pending error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/kyc/:userId/approve', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    await pool.query(
      `UPDATE users SET address_verified = TRUE, kyc_document_status = 'approved', kyc_tier = GREATEST(kyc_tier, 4), kyc_updated_at = NOW() WHERE user_id = $1`,
      [userId],
    );
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
      [
        req.adminUser.id,
        'APPROVE_KYC',
        'user',
        userId,
        JSON.stringify({ kyc: 'approved' }),
      ],
    );
    if (typeof sendPushToUser === 'function')
      await sendPushToUser(
        userId,
        'KYC Approved',
        'Your address verification has been approved. You now have full access to list properties.',
      );
    res.json({ success: true, message: 'KYC approved' });
  } catch (err) {
    console.error('KYC approve error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/kyc/:userId/reject', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    await pool.query(
      `UPDATE users SET kyc_document_status = 'rejected', kyc_document_url = NULL, kyc_updated_at = NOW() WHERE user_id = $1`,
      [userId],
    );
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
      [
        req.adminUser.id,
        'REJECT_KYC',
        'user',
        userId,
        JSON.stringify({ reason }),
      ],
    );
    const notificationBody = reason
      ? `Your document was rejected: ${reason}`
      : 'Your document was rejected. Please resubmit.';
    if (typeof sendPushToUser === 'function')
      await sendPushToUser(userId, 'KYC Update', notificationBody);
    res.json({ success: true, message: 'KYC rejected' });
  } catch (err) {
    console.error('KYC reject error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/users/kyc-status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });
    const result = await pool.query(
      'SELECT kyc_document_url, kyc_document_status FROM users WHERE user_id = $1',
      [user.id],
    );
    res.json({
      success: true,
      data: result.rows[0] || {
        kyc_document_url: null,
        kyc_document_status: null,
      },
    });
  } catch (err) {
    console.error('KYC status error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/kyc/pending-count', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM users WHERE kyc_document_status = 'pending'",
    );
    res.json({ success: true, count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('KYC pending count error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/kyc/batch-approve', requireAdmin, async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!userIds || !userIds.length)
      return res
        .status(400)
        .json({ success: false, error: 'No user IDs provided' });
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
    const query = `UPDATE users SET address_verified = TRUE, kyc_document_status = 'approved', kyc_tier = GREATEST(kyc_tier, 4) WHERE user_id IN (${placeholders}) RETURNING user_id`;
    const result = await pool.query(query, userIds);
    for (const row of result.rows) {
      await pool.query(
        'INSERT INTO admin_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
        [
          req.adminUser.id,
          'BATCH_APPROVE_KYC',
          'user',
          row.user_id,
          JSON.stringify({ batch: true }),
        ],
      );
      if (typeof sendPushToUser === 'function')
        await sendPushToUser(
          row.user_id,
          'KYC Approved',
          'Your address verification has been approved.',
        );
    }
    res.json({ success: true, approvedCount: result.rowCount });
  } catch (err) {
    console.error('Batch approve error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/kyc/stats', requireAdmin, async (req, res) => {
  try {
    const pendingResult = await pool.query(
      "SELECT COUNT(*) FROM users WHERE kyc_document_status = 'pending'",
    );
    const approvedResult = await pool.query(
      'SELECT COUNT(*) FROM users WHERE address_verified = TRUE',
    );
    const rejectedResult = await pool.query(
      "SELECT COUNT(*) FROM users WHERE kyc_document_status = 'rejected'",
    );
    const totalPending = parseInt(pendingResult.rows[0].count);
    const totalApproved = parseInt(approvedResult.rows[0].count);
    const totalRejected = parseInt(rejectedResult.rows[0].count);
    const approvalRate =
      totalApproved + totalPending > 0
        ? ((totalApproved / (totalApproved + totalPending)) * 100).toFixed(1)
        : '0';
    res.json({
      success: true,
      stats: { totalPending, totalApproved, totalRejected, approvalRate },
    });
  } catch (err) {
    console.error('KYC stats error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/kyc/all', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_id, name, email, kyc_document_url, kyc_document_status, date_joined as created_at, kyc_updated_at FROM users WHERE kyc_document_status IS NOT NULL ORDER BY date_joined DESC`,
    );
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error('KYC all error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tenancies/user/:userId – fetch all tenancies where user is renter or owner
app.get('/api/tenancies/user/:userId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.params;
    // Verify the requesting user matches the userId (or is admin? we'll keep it simple)
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user || user.id !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    // Query tenancies where user is either renter or owner
    const query = `
      SELECT 
        t.tenancy_id,
        t.propadi_tenancy_id,
        t.status,
        t.lease_start_date,
        t.lease_end_date,
        t.payment_status,
        t.rent_amount,
        t.renewal_of_tenancy_id,
        p.property_id,
        p.title as property_title,
        p.address_street,
        p.address_city,
        p.address_state,
        u_owner.user_id as owner_id,
        u_owner.name as owner_name,
        u_renter.user_id as renter_id,
        u_renter.name as renter_name,
        (SELECT COUNT(*) FROM reviews WHERE tenancy_id = t.tenancy_id AND reviewer_id = $1) > 0 as already_reviewed
      FROM tenancies t
      JOIN properties p ON t.property_id = p.property_id
      JOIN users u_owner ON t.owner_id = u_owner.user_id
      JOIN users u_renter ON t.renter_id = u_renter.user_id
      WHERE (t.renter_id = $1 OR t.owner_id = $1)
      ORDER BY t.lease_end_date DESC
    `;
    const result = await client.query(query, [userId]);
    const tenancies = result.rows.map((t) => ({
      ...t,
      can_review:
        !t.already_reviewed &&
        t.payment_status === 'Paid' &&
        new Date(t.lease_end_date) < new Date(),
    }));
    res.json({ success: true, tenancies });
  } catch (err) {
    console.error('Fetch user tenancies error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/tenancies/verify-ptn/:code – verify Propadi Tenancy ID code
app.get('/api/tenancies/verify-ptn/:code', async (req, res) => {
  try {
    let { code } = req.params;
    code = code.trim().toUpperCase();
    if (!code.startsWith('PTN-')) {
      code = `PTN-${code}`;
    }
    const authHeader = req.headers.authorization;
    let userId = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser(token);
        if (user) userId = user.id;
      } catch (e) { }
    }

    const result = await pool.query(
      `SELECT t.tenancy_id, t.propadi_tenancy_id, t.renter_id, t.owner_id, t.status, p.address_state, p.address_city, p.title as property_title 
       FROM tenancies t 
       LEFT JOIN properties p ON t.property_id = p.property_id 
       WHERE UPPER(t.propadi_tenancy_id) = UPPER($1)`,
      [code]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        error: `Propadi Tenancy ID ${code} not found in database.`,
      });
    }

    const tenancy = result.rows[0];
    const isBelongsToUser =
      userId && (tenancy.renter_id === userId || tenancy.owner_id === userId);

    if (!isBelongsToUser) {
      return res.json({
        success: false,
        belongsToOther: true,
        error: 'This Propadi Tenancy ID belongs to another user account.',
      });
    }

    return res.json({
      success: true,
      tenancy,
    });
  } catch (err) {
    console.error('Verify PTN error:', err);
    res.status(500).json({ success: false, error: 'Failed to verify Tenancy ID' });
  }
});

// GET /api/v1/external/verify-address/:ptn – Shareable Bank & Government Verification API Endpoint
app.get('/api/v1/external/verify-address/:ptn', async (req, res) => {
  try {
    let { ptn } = req.params;
    ptn = ptn.trim().toUpperCase();
    if (!ptn.startsWith('PTN-')) {
      ptn = `PTN-${ptn}`;
    }

    const query = `
      SELECT 
        t.tenancy_id,
        t.propadi_tenancy_id,
        t.status as tenancy_status,
        t.payment_status,
        t.lease_start_date,
        t.lease_end_date,
        t.renter_signature_date,
        t.owner_signature_date,
        p.title as property_title,
        p.address_street,
        p.address_city,
        p.address_state,
        u_renter.name as tenant_name,
        u_renter.phone_number as tenant_phone,
        u_renter.kyc_tier as tenant_kyc_tier,
        u_owner.name as landlord_name
      FROM tenancies t
      JOIN properties p ON t.property_id = p.property_id
      JOIN users u_renter ON t.renter_id = u_renter.user_id
      JOIN users u_owner ON t.owner_id = u_owner.user_id
      WHERE UPPER(t.propadi_tenancy_id) = UPPER($1)
    `;

    const result = await pool.query(query, [ptn]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Propadi Tenancy ID ${ptn} not found in database.`,
      });
    }

    const row = result.rows[0];

    return res.json({
      success: true,
      service_provider: 'Propadi Digital Trust Engine',
      verification_status: row.payment_status === 'Paid' ? 'VERIFIED_ACTIVE_TENANCY' : 'VERIFIED_LEASE_RECORD',
      ptn_reference: row.propadi_tenancy_id,
      verified_address: {
        street: row.address_street || '',
        city: row.address_city || '',
        state: row.address_state || '',
        country: 'Nigeria',
        full_address: `${row.address_street ? `${row.address_street}, ` : ''}${row.address_city ? `${row.address_city}, ` : ''}${row.address_state || ''}, Nigeria`,
      },
      tenant: {
        name: row.tenant_name,
        kyc_tier: row.tenant_kyc_tier ? `Tier ${row.tenant_kyc_tier}` : 'Tier 2',
      },
      landlord: {
        name: row.landlord_name,
        status: 'Propadi Verified Landlord',
      },
      tenancy_term: {
        start_date: row.lease_start_date,
        end_date: row.lease_end_date,
        status: row.tenancy_status,
      },
      security_certificate: {
        issued_by: 'Propadi Legal Engine',
        digital_seal_hash: `SHA256-${row.tenancy_id.replace(/-/g, '').toUpperCase()}`,
        verified_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('External verify address API error:', err);
    res.status(500).json({ success: false, error: 'External verification service failure.' });
  }
});

// POST /api/feedback – submit user feedback (with email notification to admins)
app.post('/api/feedback', async (req, res) => {
  try {
    const { user_id, email, subject, message } = req.body;
    if (!subject) {
      return res
        .status(400)
        .json({ success: false, error: 'Subject is required' });
    }
    if (!message) {
      return res
        .status(400)
        .json({ success: false, error: 'Message is required' });
    }

    // Insert feedback into database
    const result = await pool.query(
      `INSERT INTO feedback (user_id, email, subject, message) VALUES ($1, $2, $3, $4) RETURNING id`,
      [user_id || null, email || null, subject, message],
    );

    // Send email notification to all admin users
    try {
      const adminEmails = await pool.query(
        'SELECT email FROM users WHERE is_admin = TRUE',
      );
      for (const admin of adminEmails.rows) {
        await resend.emails.send({
          from: 'Propadi <onboarding@resend.dev>',
          to: admin.email,
          subject: `📝 New Feedback: ${subject}`,
          html: `
            <h3>New Feedback Received</h3>
            <p><strong>From:</strong> ${email || 'Anonymous'}</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <p><strong>Message:</strong></p>
            <p>${message.replace(/\n/g, '<br>')}</p>
            <hr>
            <p><small>Propadi Feedback System</small></p>
          `,
        });
      }
    } catch (emailErr) {
      console.error('Failed to send admin email notification:', emailErr);
      // Do not fail the request – just log the error
    }

    res.json({ success: true, message: 'Thank you for your feedback!' });
  } catch (err) {
    console.error('Feedback error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to submit feedback' });
  }
});

// ==========================================
// RFERRAL SYSTEM ENDPOINTS
// ==========================================
// GET /api/referrals/my-code – get authenticated user's referral code (generate if missing)
app.get('/api/referrals/my-code', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    let result = await pool.query(
      'SELECT referral_code FROM users WHERE user_id = $1',
      [user.id],
    );
    let referralCode = result.rows[0]?.referral_code;
    if (!referralCode) {
      // Generate a unique code
      let newCode = user.id.substring(0, 6).toUpperCase();
      let exists = true;
      while (exists) {
        const check = await pool.query(
          'SELECT 1 FROM users WHERE referral_code = $1',
          [newCode],
        );
        if (check.rows.length === 0) exists = false;
        else
          newCode =
            user.id.substring(0, 4) +
            Math.random().toString(36).substring(2, 6).toUpperCase();
      }
      await pool.query(
        'UPDATE users SET referral_code = $1 WHERE user_id = $2',
        [newCode, user.id],
      );
      referralCode = newCode;
    }
    res.json({ success: true, referral_code: referralCode });
  } catch (err) {
    console.error('Get referral code error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/referrals/link – link a referral code to the authenticated user (can only be done once)
app.post('/api/referrals/link', async (req, res) => {
  const client = await pool.connect();
  try {
    const { referral_code } = req.body;
    if (!referral_code)
      return res
        .status(400)
        .json({ success: false, error: 'Referral code required' });

    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    await client.query('BEGIN');

    // Check if user already has a referrer
    const existing = await client.query(
      'SELECT 1 FROM referrals WHERE referee_id = $1',
      [user.id],
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'You have already used a referral code',
      });
    }

    // Find referrer by referral_code
    const referrerResult = await client.query(
      'SELECT user_id FROM users WHERE referral_code = $1',
      [referral_code],
    );
    if (referrerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: 'Invalid referral code' });
    }
    const referrerId = referrerResult.rows[0].user_id;
    if (referrerId === user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'You cannot use your own referral code',
      });
    }

    // Create referral record
    await client.query(
      `INSERT INTO referrals (referrer_id, referee_id, status, reward_type) VALUES ($1, $2, 'Pending', 'wallet_credit')`,
      [referrerId, user.id],
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message:
        'Referral code applied! You will receive a reward when you complete your first tenancy.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Link referral error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/referrals/:userId – get referrals made by the user (with stats)
app.get('/api/referrals/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    // Authorization: only the user themselves or admin can view
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });
    if (user.id !== userId && !user.is_admin) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    // Get referrals sent by this user
    const referralsQuery = `
      SELECT r.referral_id, r.status, r.date_referred, r.date_rewarded,
             u.name as referee_name, u.email as referee_email, u.date_joined as referee_joined
      FROM referrals r
      JOIN users u ON r.referee_id = u.user_id
      WHERE r.referrer_id = $1
      ORDER BY r.date_referred DESC
    `;
    const referralsResult = await pool.query(referralsQuery, [userId]);

    // Compute stats
    const totalReferrals = referralsResult.rows.length;
    const successfulReferrals = referralsResult.rows.filter(
      (r) => r.status === 'Completed',
    ).length;
    const pendingReferrals = referralsResult.rows.filter(
      (r) => r.status === 'Pending',
    ).length;
    // Assume reward amount per successful referral (e.g., ₦2000)
    const rewardPerSuccess = 2000;
    const totalRewards = successfulReferrals * rewardPerSuccess;

    res.json({
      success: true,
      referrals: referralsResult.rows,
      stats: {
        totalReferrals,
        successfulReferrals,
        pendingReferrals,
        totalRewards,
        rewardPerSuccess,
      },
    });
  } catch (err) {
    console.error('Get referrals error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/referrals/claim – add total reward to user's wallet and mark referrals as rewarded
app.post('/api/referrals/claim', async (req, res) => {
  const client = await pool.connect();
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    await client.query('BEGIN');

    // Get total successful but not yet rewarded referrals
    const referralsResult = await client.query(
      `SELECT referral_id FROM referrals WHERE referrer_id = $1 AND status = 'Completed' AND date_rewarded IS NULL`,
      [user.id],
    );
    if (referralsResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(400)
        .json({ success: false, error: 'No pending rewards to claim' });
    }

    const rewardPerSuccess = 2000;
    const totalReward = referralsResult.rows.length * rewardPerSuccess;

    // Add to wallet
    await client.query(
      `UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1 WHERE user_id = $2`,
      [totalReward, user.id],
    );
    // Record transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, title, amount, status) VALUES ($1, 'credit', 'Referral Rewards', $2, 'Completed')`,
      [user.id, totalReward],
    );
    // Mark referrals as rewarded
    const ids = referralsResult.rows.map((r) => r.referral_id);
    await client.query(
      `UPDATE referrals SET status = 'Rewarded', date_rewarded = NOW() WHERE referral_id = ANY($1::uuid[])`,
      [ids],
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `₦${totalReward.toLocaleString()} added to your wallet!`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Claim rewards error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// SERVICE PROVIDER ROUTES (Phase 1)
// ==========================================

// POST /api/provider/register – register as a service provider (with explicit daily_wage)
app.post('/api/provider/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const {
      trade_type,
      license_number,
      license_document_urls,
      years_experience,
      daily_wage,
      service_radius_km,
      daily_capacity,
      weekly_capacity,
      max_active_jobs,
    } = req.body;

    if (!trade_type || !daily_wage) {
      return res.status(400).json({
        success: false,
        error: 'Trade type and daily wage are required',
      });
    }

    await client.query('BEGIN');

    // Check if already a provider
    const existing = await client.query(
      'SELECT provider_id FROM service_providers WHERE provider_id = $1',
      [user.id],
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'You are already registered as a service provider',
      });
    }

    // Store license URLs as JSON array
    const licenseUrlsJson = license_document_urls
      ? JSON.stringify(license_document_urls)
      : null;

    // Insert into service_providers – using daily_wage column
    const result = await client.query(
      `INSERT INTO service_providers 
       (provider_id, trade_type, license_number, license_document_url, years_experience, daily_wage, service_radius_km, 
        daily_capacity, weekly_capacity, max_active_jobs, is_verified, availability_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, 'available')
       RETURNING *`,
      [
        user.id,
        trade_type,
        license_number || null,
        licenseUrlsJson,
        years_experience || '0-1',
        daily_wage,
        service_radius_km || 20,
        daily_capacity || 3,
        weekly_capacity || 15,
        max_active_jobs || 3,
      ],
    );

    // Update users table
    await client.query(
      'UPDATE users SET is_service_provider = TRUE WHERE user_id = $1',
      [user.id],
    );

    await client.query('COMMIT');
    res.json({ success: true, provider: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Provider registration error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to register as provider' });
  } finally {
    client.release();
  }
});

// POST /api/provider/upload-license – receive base64 image, upload to Supabase Storage
app.post('/api/provider/upload-license', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const { base64, fileType } = req.body;
    if (!base64)
      return res
        .status(400)
        .json({ success: false, error: 'No file provided' });

    const fileName = `providers/${user.id}/license_${Date.now()}_${Math.random()}.${fileType || 'jpg'}`;
    const buffer = Buffer.from(base64, 'base64');
    const { error: uploadError } = await supabase.storage
      .from('provider-licenses')
      .upload(fileName, buffer, { contentType: `image/${fileType || 'jpeg'}` });
    if (uploadError) throw uploadError;

    const {
      data: { publicUrl },
    } = supabase.storage.from('provider-licenses').getPublicUrl(fileName);
    res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('License upload error:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// Generic image upload endpoint
app.post('/api/upload', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    const { base64, fileType, bucket } = req.body;
    if (!base64) {
      return res
        .status(400)
        .json({ success: false, error: 'No image provided' });
    }

    // Use 'direct-request-images' as default bucket
    const targetBucket = bucket || 'direct-request-images';
    const fileExtension = fileType || 'jpeg';
    const fileName = `direct/${user.id}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExtension}`;

    const buffer = Buffer.from(base64, 'base64');
    const { error: uploadError } = await supabase.storage
      .from(targetBucket)
      .upload(fileName, buffer, {
        contentType: `image/${fileExtension}`,
      });
    if (uploadError) {
      console.error('Upload error:', uploadError);
      throw uploadError;
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(targetBucket).getPublicUrl(fileName);
    res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// GET /api/provider/dashboard – get provider dashboard data (with visit info)
app.get('/api/provider/dashboard', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const providerResult = await pool.query(
      `SELECT * FROM service_providers WHERE provider_id = $1`,
      [user.id],
    );
    if (providerResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Provider not found' });
    }
    const provider = providerResult.rows[0];

    const activeWorkResult = await pool.query(
      `SELECT 1
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       WHERE sr.provider_id = $1
         AND mv.status IN ('checked_in', 'in_progress')
       LIMIT 1`,
      [user.id],
    );
    const inProgressServiceResult = await pool.query(
      `SELECT 1
       FROM service_requests
       WHERE provider_id = $1 AND status = 'in_progress'
       LIMIT 1`,
      [user.id],
    );
    const hasActiveWork =
      activeWorkResult.rows.length > 0 ||
      inProgressServiceResult.rows.length > 0;
    if (hasActiveWork) {
      provider.availability_status = 'at_work';
    }

    // Current job (accepted) – join to get full details
    let currentJob = null;
    // Current job (accepted or in_progress)
    const currentJobResult = await pool.query(
      `SELECT sr.service_id, 
          COALESCE(sr.title, mr.title) as title, 
          COALESCE(sr.description, mr.description) as description, 
          sr.media_url, 
          mr.media_url as maintenance_media_url,
          sr.estimated_cost, 
          sr.materials_cost,
          sr.counter_price,
          sr.counter_reason,
          mv.stage1_verified, 
          mv.stage1_verified_at,
          mv.stage2_verified, 
          mv.stage2_verified_at,
          mv.check_in_time,
          mv.qr_code, 
          mv.qr_expires_at,
          mv.renter_safety_confirmed,
          mv.provider_safety_confirmed,
          sr.final_price,
          sr.status,
          sr.price_status,
          sr.estimated_hours,
          sr.notes,
          sr.accepted_at,
          sr.maintenance_request_id,
          sr.created_at,
          sr.trade_type,
          sr.provider_id,
          p.title as property_title, 
          p.address_street, 
          p.address_city, 
          p.address_state
   FROM service_requests sr
   LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
   JOIN properties p ON sr.property_id = p.property_id
   LEFT JOIN maintenance_visits mv ON sr.service_id = mv.service_request_id 
   WHERE sr.provider_id = $1 
     AND sr.status IN ('accepted', 'in_progress')
     AND EXISTS (
       SELECT 1 FROM maintenance_visits mv 
       WHERE mv.service_request_id = sr.service_id 
         AND mv.status IN ('checked_in', 'in_progress')
     )
   ORDER BY 
     CASE 
       WHEN sr.status = 'in_progress' THEN 1
       WHEN EXISTS (
         SELECT 1 FROM maintenance_visits mv 
         WHERE mv.service_request_id = sr.service_id AND mv.status = 'checked_in'
       ) THEN 2
     END
   LIMIT 1`,
      [user.id],
    );
    if (currentJobResult.rows.length > 0) {
      currentJob = currentJobResult.rows[0];
      // Fetch associated visit (if any) – include stage columns
      const visitResult = await pool.query(
        `SELECT visit_id, scheduled_start, scheduled_end, status, check_in_time, check_out_time,
            renter_safety_confirmed, provider_safety_confirmed,
            stage1_verified, stage1_verified_at, stage2_verified, stage2_verified_at, qr_code, qr_expires_at
     FROM maintenance_visits
     WHERE service_request_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
        [currentJob.service_id],
      );
      if (visitResult.rows.length > 0) {
        currentJob.visit = visitResult.rows[0];
      }
    }

    // Awaiting schedule: accepted jobs without a visit (only status = 'accepted')
    const awaitingSchedule = await pool.query(
      `SELECT sr.service_id, 
          COALESCE(sr.title, mr.title) as title, 
          COALESCE(sr.description, mr.description) as description, 
          sr.media_url, 
          sr.estimated_cost, 
          sr.materials_cost,
          sr.counter_price,
          sr.counter_reason,
          mv.stage1_verified, 
          mv.stage1_verified_at,
          mv.stage2_verified, 
          mv.stage2_verified_at,
          mv.check_in_time,
          mv.qr_code, 
          mv.qr_expires_at,
          mv.renter_safety_confirmed,
          mv.provider_safety_confirmed,
          sr.final_price,
          sr.trade_type,
          sr.status,
          sr.price_status,
          sr.estimated_hours,
          sr.maintenance_request_id,
          sr.notes,
          sr.created_at,
          p.title as property_title, 
          p.address_city, 
          p.address_state
   FROM service_requests sr
   LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
   JOIN properties p ON sr.property_id = p.property_id
   LEFT JOIN maintenance_visits mv ON sr.service_id = mv.service_request_id
   WHERE sr.provider_id = $1 
     AND sr.status = 'accepted'
     AND mv.visit_id IS NULL
   ORDER BY sr.created_at ASC`,
      [user.id],
    );

    // Pending offers (assigned to this provider, not yet accepted)
    // Pending offers – includes both 'pending' and 'negotiating'
    const pendingOffers = await pool.query(
      `SELECT sr.service_id, sr.trade_type, sr.estimated_hours, sr.counter_price, sr.created_at, sr.estimated_cost,
          sr.materials_cost,
          sr.maintenance_request_id, sr.status, sr.price_status, 
          sr.provider_id,
          COALESCE(sr.title, mr.title) as title, sr.description, mr.media_url,
          sr.notes,
          p.title as property_title, p.address_city, p.address_state
   FROM service_requests sr
   LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
   JOIN properties p ON sr.property_id = p.property_id
   WHERE sr.provider_id = $1 AND sr.status IN ('pending', 'negotiating')
   ORDER BY sr.created_at ASC`,
      [user.id],
    );

    // Available jobs (open to any provider with matching trade)
    const availableJobs = await pool.query(
      `SELECT sr.service_id, sr.trade_type, sr.estimated_hours, sr.created_at, sr.estimated_cost,
          sr.materials_cost,
          sr.maintenance_request_id,
          COALESCE(sr.title, mr.title) as title, sr.description,
          COALESCE(sr.media_url, mr.media_url) as media_url,
          sr.notes,
          sr.status,
          sr.price_status,
          p.title as property_title, p.address_city, p.address_state
   FROM service_requests sr
   LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
   JOIN properties p ON sr.property_id = p.property_id
   WHERE sr.provider_id IS NULL
     AND sr.status = 'pending'
     AND LOWER(sr.trade_type) = LOWER($1)
   ORDER BY sr.created_at ASC
   LIMIT 30`,
      [provider.trade_type],
    );

    // Job history (completed or rejected)
    // Job history (completed or rejected) – LIMITED DETAILS for security
    const jobHistory = await pool.query(
      `SELECT sr.service_id, 
          COALESCE(sr.title, mr.title) as title, 
          sr.description,
          sr.media_url,
          sr.estimated_cost,
          sr.materials_cost,
          sr.final_price,
          sr.status,
          sr.price_status,
          sr.estimated_hours,
          sr.rejection_reason,
          sr.status_remark,
          sr.completed_at,
          sr.created_at,
          sr.accepted_at,
          p.title as property_title,
          p.address_city,
          p.address_state
   FROM service_requests sr
   LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
   JOIN properties p ON sr.property_id = p.property_id
   WHERE sr.provider_id = $1 AND sr.status IN ('completed', 'rejected')
   ORDER BY sr.completed_at DESC
   LIMIT 20`,
      [user.id],
    );

    // Scheduled jobs: accepted jobs with a visit scheduled, regardless of provider status
    const scheduledJobs = await pool.query(
      `SELECT sr.service_id, 
          COALESCE(sr.title, mr.title) as title, 
          COALESCE(sr.description, mr.description) as description, 
          sr.media_url, 
          sr.estimated_cost, 
          sr.materials_cost,
          sr.counter_price,
          sr.counter_reason,
          sr.final_price,
          mv.stage1_verified, 
          mv.stage1_verified_at,
          mv.stage2_verified, 
          mv.stage2_verified_at,
          mv.check_in_time,
          mv.qr_code, 
          mv.qr_expires_at,
          mv.renter_safety_confirmed,
          mv.provider_safety_confirmed,
          sr.trade_type,
          sr.status,
          sr.price_status,
          sr.estimated_hours,
          sr.maintenance_request_id,
          sr.notes,
          p.title as property_title, 
          p.address_city, 
          p.address_state,
          mv.visit_id,
          mv.scheduled_start as visit_scheduled_start,
          mv.status as visit_status
   FROM service_requests sr
   LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
   JOIN properties p ON sr.property_id = p.property_id
   JOIN maintenance_visits mv ON sr.service_id = mv.service_request_id
   WHERE sr.provider_id = $1 
     AND sr.status = 'accepted'
     AND mv.status = 'scheduled'
   ORDER BY mv.scheduled_start ASC`,
      [user.id],
    );

    // Earnings
    const earnings = await pool.query(
      `SELECT COALESCE(SUM(actual_cost), 0) as total_earned
       FROM service_requests
       WHERE provider_id = $1 AND status = 'completed'`,
      [user.id],
    );

    // Get capacity usage
    const todayJobs = await countJobsToday(user.id);
    const weekJobs = await countJobsThisWeek(user.id);
    const activeJobs = await countActiveJobs(user.id);

    res.json({
      success: true,
      provider,
      currentJob,
      awaitingSchedule: awaitingSchedule.rows,
      scheduledJobs: scheduledJobs.rows,
      pendingOffers: pendingOffers.rows,
      availableJobs: availableJobs.rows,
      jobHistory: jobHistory.rows,
      totalEarned: parseFloat(earnings.rows[0].total_earned),
      capacity: {
        activeJobs,
        todayJobs,
        weekJobs,
        dailyCapacity: provider.daily_capacity,
        weeklyCapacity: provider.weekly_capacity,
        maxActiveJobs: provider.max_active_jobs,
      },
      hasActiveWork,
    });
  } catch (err) {
    console.error('Provider dashboard error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/provider/availability – update availability status
// PUT /api/provider/availability – update availability status (with guardrails)
// PUT /api/provider/availability – update availability status (with guardrails)
app.put('/api/provider/availability', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const { availability_status } = req.body;
    const allowed = ['available', 'at_work', 'unavailable', 'offline'];
    if (!allowed.includes(availability_status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    // ✅ Get current provider status
    const providerResult = await pool.query(
      `SELECT availability_status FROM service_providers WHERE provider_id = $1`,
      [user.id],
    );
    if (providerResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Provider not found' });
    }
    const currentStatus = providerResult.rows[0].availability_status;

    // ✅ NEW: If provider is at_work, block ALL manual changes
    if (currentStatus === 'at_work') {
      return res.status(400).json({
        success: false,
        error:
          'You are currently working on a job. Complete it before changing your status.',
      });
    }

    // ✅ Check for active work (guardrail) – only for 'available' transition
    if (availability_status === 'available') {
      const activeWork = await pool.query(
        `SELECT 1
         FROM maintenance_visits mv
         JOIN service_requests sr ON mv.service_request_id = sr.service_id
         WHERE sr.provider_id = $1
           AND mv.status IN ('checked_in', 'in_progress')
         UNION
         SELECT 1
         FROM service_requests
         WHERE provider_id = $1 AND status = 'in_progress'
         LIMIT 1`,
        [user.id],
      );
      if (activeWork.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error:
            'You have an active work session. Complete it before setting yourself as available.',
        });
      }
    }

    // ✅ Check capacity guardrail (existing)
    if (availability_status === 'available') {
      const activeJob = await pool.query(
        `SELECT current_job_id FROM service_providers WHERE provider_id = $1 AND current_job_id IS NOT NULL`,
        [user.id],
      );
      if (activeJob.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error:
            'You have an active job. Please complete it before setting yourself as available.',
        });
      }
    }

    // ✅ Update the status
    await pool.query(
      `UPDATE service_providers SET availability_status = $1, last_status_update = NOW() WHERE provider_id = $2`,
      [availability_status, user.id],
    );

    res.json({ success: true, message: 'Availability updated' });
  } catch (err) {
    console.error('Update availability error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/provider/jobs/pending – list pending jobs (previews)
app.get('/api/provider/jobs/pending', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const providerResult = await pool.query(
      'SELECT trade_type, service_radius_km FROM service_providers WHERE provider_id = $1',
      [user.id],
    );
    if (providerResult.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Provider not found' });
    const { trade_type, service_radius_km } = providerResult.rows[0];

    // For simplicity, we only filter by trade type and status. Location radius will be added later.
    const pendingJobs = await pool.query(
      `SELECT sr.service_id, sr.trade_type, sr.estimated_hours, sr.created_at,
              mr.title, mr.description, mr.media_url,
              p.title as property_title, p.address_city, p.address_state
       FROM service_requests sr
       JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       JOIN properties p ON sr.property_id = p.property_id
       WHERE sr.provider_id IS NULL AND sr.status = 'pending' AND sr.trade_type = $1
       ORDER BY sr.created_at ASC
       LIMIT 30`,
      [trade_type],
    );

    res.json({ success: true, jobs: pendingJobs.rows });
  } catch (err) {
    console.error('Pending jobs error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/provider/jobs/:serviceId/accept – accept a job
app.put('/api/provider/jobs/:serviceId/accept', async (req, res) => {
  const client = await pool.connect();
  try {
    const { serviceId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    await client.query('BEGIN');

    // Check service request exists and is pending
    const serviceResult = await client.query(
      `SELECT sr.*, p.address_street, p.address_city, p.address_state, p.map_coordinates
       FROM service_requests sr
       JOIN properties p ON sr.property_id = p.property_id
       WHERE sr.service_id = $1 AND sr.status = 'pending' AND sr.provider_id IS NULL`,
      [serviceId],
    );
    if (serviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: 'Job not found or already taken' });
    }
    const service = serviceResult.rows[0];

    // Update service request
    await client.query(
      `UPDATE service_requests SET provider_id = $1, status = 'accepted', accepted_at = NOW() WHERE service_id = $2`,
      [user.id, serviceId],
    );

    // Provider availability will be auto‑updated by trigger
    // But we also update current_job_id manually (trigger does this, but we ensure)
    await client.query(
      `UPDATE service_providers SET current_job_id = $1, availability_status = 'at_work', last_status_update = NOW() WHERE provider_id = $2`,
      [serviceId, user.id],
    );

    await client.query('COMMIT');

    // Return full address to frontend
    res.json({
      success: true,
      message: 'Job accepted',
      property_address: {
        street: service.address_street,
        city: service.address_city,
        state: service.address_state,
        coordinates: service.map_coordinates,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Accept job error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/provider/jobs/:serviceId/decline – decline a job
app.put('/api/provider/jobs/:serviceId/decline', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    await pool.query(
      `UPDATE service_requests SET status = 'rejected' WHERE service_id = $1 AND provider_id IS NULL`,
      [serviceId],
    );
    res.json({ success: true, message: 'Job declined' });
  } catch (err) {
    console.error('Decline job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/provider/jobs/:serviceId/complete – mark job completed (provider side)
app.put('/api/provider/jobs/:serviceId/complete', async (req, res) => {
  try {
    const { serviceId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    await pool.query(
      `UPDATE service_requests SET status = 'completed', completed_at = NOW() WHERE service_id = $1 AND provider_id = $2 AND status = 'accepted'`,
      [serviceId, user.id],
    );
    // Trigger will update provider availability to 'available' and clear current_job_id
    res.json({
      success: true,
      message: 'Job marked as completed, awaiting owner confirmation',
    });
  } catch (err) {
    console.error('Complete job error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// ADMIN SERVICE PROVIDER ROUTES
// ==========================================

// GET /api/admin/service-providers – list all providers (admin only)
app.get('/api/admin/service-providers', requireAdmin, async (req, res) => {
  try {
    const { status, trade_type } = req.query; // status: 'pending', 'verified', 'all'
    let query = `
      SELECT sp.*, u.name, u.email, u.phone_number
      FROM service_providers sp
      JOIN users u ON sp.provider_id = u.user_id
      WHERE 1=1
    `;
    const values = [];
    let paramIndex = 1;
    if (status === 'pending') {
      query += ` AND sp.is_verified = FALSE`;
    } else if (status === 'verified') {
      query += ` AND sp.is_verified = TRUE`;
    }
    if (trade_type) {
      query += ` AND sp.trade_type = $${paramIndex}`;
      values.push(trade_type);
      paramIndex++;
    }
    query += ` ORDER BY sp.created_at DESC`;
    const result = await pool.query(query, values);
    res.json({ success: true, providers: result.rows });
  } catch (err) {
    console.error('Admin providers error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/service-providers/:providerId/approve – approve provider (admin only)
app.put(
  '/api/admin/service-providers/:providerId/approve',
  requireAdmin,
  async (req, res) => {
    try {
      const { providerId } = req.params;
      await pool.query(
        `UPDATE service_providers SET is_verified = TRUE, verified_at = NOW() WHERE provider_id = $1`,
        [providerId],
      );
      await sendPushToUser(
        providerId,
        '✅ Provider Approved',
        'Your service provider account has been verified. You can now receive job requests.',
      );
      res.json({ success: true, message: 'Provider approved' });
    } catch (err) {
      console.error('Approve provider error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// PUT /api/admin/service-providers/:providerId/reject – reject provider (admin only)
app.put(
  '/api/admin/service-providers/:providerId/reject',
  requireAdmin,
  async (req, res) => {
    try {
      const { providerId } = req.params;
      const { reason } = req.body;
      await pool.query(`DELETE FROM service_providers WHERE provider_id = $1`, [
        providerId,
      ]);
      await pool.query(
        `UPDATE users SET is_service_provider = FALSE WHERE user_id = $1`,
        [providerId],
      );
      await sendPushToUser(
        providerId,
        '❌ Provider Application Rejected',
        reason ||
        'Your application did not meet our verification criteria. You can reapply after addressing the issues.',
      );
      res.json({ success: true, message: 'Provider rejected and removed' });
    } catch (err) {
      console.error('Reject provider error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// ==========================================
// PHASE 2: SERVICE REQUEST & JOB MATCHING
// ==========================================

// GET /api/providers/available – list verified providers by trade (simple location filter by city/state)
// GET /api/providers/available – list verified providers by trade and location
app.get('/api/providers/available', async (req, res) => {
  try {
    const { trade_type, city, state, limit = 20 } = req.query;
    if (!trade_type) {
      return res
        .status(400)
        .json({ success: false, error: 'Trade type is required' });
    }

    let query = `
      SELECT sp.provider_id, u.name, sp.trade_type, sp.daily_wage, sp.years_experience, sp.avg_rating,
             sp.service_radius_km, u.address_city, u.address_state
      FROM service_providers sp
      JOIN users u ON sp.provider_id = u.user_id
      WHERE sp.is_verified = true
        AND sp.availability_status = 'available'
        AND LOWER(sp.trade_type) = LOWER($1)
    `;
    const values = [trade_type];
    let paramIndex = 2;

    if (city) {
      query += ` AND u.address_city ILIKE $${paramIndex}`;
      values.push(`%${city}%`);
      paramIndex++;
    }
    if (state) {
      query += ` AND u.address_state ILIKE $${paramIndex}`;
      values.push(`%${state}%`);
      paramIndex++;
    }

    query += ` ORDER BY sp.avg_rating DESC, sp.daily_wage ASC LIMIT $${paramIndex}`;
    values.push(parseInt(limit) || 20);

    const result = await pool.query(query, values);
    res.json({ success: true, providers: result.rows });
  } catch (err) {
    console.error('Available providers error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/service-requests – owner creates a service request (linked to a maintenance request)
// POST /api/service-requests – owner creates a service request (linked to maintenance OR direct)
// POST /api/service-requests – owner creates a service request (linked to maintenance OR direct)
app.post('/api/service-requests', async (req, res) => {
  const client = await pool.connect();
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const {
      maintenance_request_id,
      property_id,
      provider_id,
      estimated_hours,
      notes,
      trade_type,
      title,
      description,
      media_url,
      estimated_cost,
      materials_cost,
    } = req.body;

    if (!trade_type) {
      return res
        .status(400)
        .json({ success: false, error: 'Trade type is required' });
    }

    await client.query('BEGIN');

    let propertyId = property_id;
    let maintDescription = description;
    let maintTitle = title;

    // If linked to a maintenance request, get property and details
    if (maintenance_request_id) {
      const maintResult = await client.query(
        `SELECT mr.*, p.property_id, p.owner_id, p.address_street, p.address_city, p.address_state,
                p.title as property_title
         FROM maintenance_requests mr
         JOIN properties p ON mr.property_id = p.property_id
         WHERE mr.request_id = $1`,
        [maintenance_request_id],
      );
      if (maintResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res
          .status(404)
          .json({ success: false, error: 'Maintenance request not found' });
      }
      const maint = maintResult.rows[0];
      if (maint.owner_id !== user.id) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          error: 'You are not the owner of this property',
        });
      }
      propertyId = maint.property_id;
      maintDescription = maint.description;
      maintTitle = maint.title;
    } else {
      // Direct request: property_id must be provided and owner must own it
      if (!property_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Property ID is required for direct requests',
        });
      }
      const propCheck = await client.query(
        `SELECT owner_id FROM properties WHERE property_id = $1`,
        [property_id],
      );
      if (
        propCheck.rows.length === 0 ||
        propCheck.rows[0].owner_id !== user.id
      ) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          error: 'Property not found or you are not the owner',
        });
      }
      if (!maintTitle || !maintDescription) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Title and description are required for direct requests',
        });
      }
    }

    // If provider is selected, verify they are verified and available
    let dailyWage = 0;
    if (provider_id) {
      const providerCheck = await client.query(
        `SELECT provider_id, daily_wage FROM service_providers WHERE provider_id = $1 AND is_verified = true`,
        [provider_id],
      );
      if (providerCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Selected provider is not available or not verified',
        });
      }
      dailyWage = providerCheck.rows[0].daily_wage;
    }

    // Calculate estimated cost if not provided directly
    let finalEstimatedCost = estimated_cost;
    if (!finalEstimatedCost && estimated_hours) {
      finalEstimatedCost = dailyWage * Math.ceil(estimated_hours / 8);
    }

    // Insert service request – using estimated_cost and materials_cost from body
    const insertResult = await client.query(
      `INSERT INTO service_requests 
   (maintenance_request_id, property_id, owner_id, provider_id, trade_type, description, estimated_hours, estimated_cost, materials_cost, notes, status, title, media_url)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12)
   RETURNING *`,
      [
        maintenance_request_id || null,
        propertyId,
        user.id,
        provider_id || null,
        trade_type,
        maintDescription,
        estimated_hours || null,
        estimated_cost || 0,
        materials_cost || 0,
        notes || null, // ✅ NOTES added here
        maintTitle,
        media_url || null,
      ],
    );
    const serviceRequest = insertResult.rows[0];

    await client.query('COMMIT');

    // If no specific provider selected, notify all available providers with matching trade
    if (!provider_id) {
      const nearbyProviders = await client.query(
        `SELECT sp.provider_id, u.name, u.address_city, u.address_state
     FROM service_providers sp
     JOIN users u ON sp.provider_id = u.user_id
     WHERE sp.is_verified = true
       AND sp.availability_status = 'available'
       AND LOWER(sp.trade_type) = LOWER($1)`,
        [trade_type],
      );
      for (const p of nearbyProviders.rows) {
        await sendPushToUser(
          p.provider_id,
          '🔧 New Direct Service Request',
          `A new direct request "${title}" is available in ${p.address_city || 'your area'}.`,
          { screen: 'ProviderDashboard' },
        );
      }
    }
    // After the insert is successful, notify providers
    if (provider_id) {
      // ✅ Specific provider selected – notify only them
      await sendPushToUser(
        provider_id,
        '🔧 New Direct Service Request',
        `A new direct service request "${title || 'Job'}" has been created. Check your dashboard.`,
        {
          screen: 'ProviderDashboard',
          service_id: insertResult.rows[0].service_id,
        },
      );
      console.log(
        `Direct request ${insertResult.rows[0].service_id} sent to provider ${provider_id}`,
      );
    } else {
      // ✅ No provider selected – notify available providers with matching trade and location

      // Get property location for filtering
      const propertyResult = await client.query(
        `SELECT address_city, address_state FROM properties WHERE property_id = $1`,
        [propertyId],
      );
      const property = propertyResult.rows[0] || {};

      let nearbyProviders;
      if (property.address_city || property.address_state) {
        // Filter by trade + city/state
        nearbyProviders = await client.query(
          `SELECT sp.provider_id, u.name, u.address_city, u.address_state 
       FROM service_providers sp
       JOIN users u ON sp.provider_id = u.user_id
       WHERE sp.is_verified = true
         AND sp.availability_status = 'available'
         AND LOWER(sp.trade_type) = LOWER($1)
         AND (u.address_city ILIKE $2 OR u.address_state ILIKE $3)`,
          [
            trade_type,
            `%${property.address_city || ''}%`,
            `%${property.address_state || ''}%`,
          ],
        );
      } else {
        // Fallback: filter by trade only if no property location
        nearbyProviders = await client.query(
          `SELECT sp.provider_id, u.name, u.address_city, u.address_state 
       FROM service_providers sp
       JOIN users u ON sp.provider_id = u.user_id
       WHERE sp.is_verified = true
         AND sp.availability_status = 'available'
         AND LOWER(sp.trade_type) = LOWER($1)`,
          [trade_type],
        );
      }

      console.log(
        `Broadcasting direct request ${insertResult.rows[0].service_id} to ${nearbyProviders.rows.length} nearby providers`,
      );

      for (const provider of nearbyProviders.rows) {
        await sendPushToUser(
          provider.provider_id,
          '🔧 New Direct Service Request',
          `A new direct request "${title}" is available in ${provider.address_city || 'your area'}.`,
          { screen: 'ProviderDashboard' },
        );
      }
    }

    res.json({ success: true, serviceRequest });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create service request error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/service-requests/pending – list pending service requests (for providers, filtered by trade)
// GET /api/service-requests/pending – list unassigned jobs for provider
app.get('/api/service-requests/pending', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // Get provider details
    const providerResult = await pool.query(
      `SELECT trade_type, is_verified, availability_status 
       FROM service_providers WHERE provider_id = $1`,
      [user.id],
    );
    if (providerResult.rows.length === 0) {
      return res
        .status(403)
        .json({ success: false, error: 'Not a service provider' });
    }
    const provider = providerResult.rows[0];
    if (!provider.is_verified) {
      return res.status(403).json({
        success: false,
        error: 'Your account is not yet verified by admin',
      });
    }
    if (provider.availability_status !== 'available') {
      return res.status(403).json({
        success: false,
        error: 'You are not available to accept jobs',
      });
    }
    const tradeType = provider.trade_type;

    // Query pending jobs – case‑insensitive trade match
    const pendingQuery = `
      SELECT sr.*, mr.title, mr.description, mr.media_url,
             p.title as property_title, p.address_city, p.address_state
      FROM service_requests sr
      JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
      JOIN properties p ON sr.property_id = p.property_id
      WHERE LOWER(sr.trade_type) = LOWER($1)
        AND sr.status = 'pending'
        AND sr.provider_id IS NULL
      ORDER BY sr.created_at ASC
      LIMIT 30
    `;
    const result = await pool.query(pendingQuery, [tradeType]);
    res.json({ success: true, pendingJobs: result.rows });
  } catch (err) {
    console.error('Pending service requests error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/service-requests/:id/accept – provider accepts a job
app.put('/api/service-requests/:id/accept', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    console.log('🔵 Accept endpoint called with service_id:', id);

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    console.log('🔵 User ID:', user.id);

    // Before BEGIN, check capacity
    const activeJobs = await countActiveJobs(user.id);
    const todayJobs = await countJobsToday(user.id);
    const weekJobs = await countJobsThisWeek(user.id);

    const capResult = await pool.query(
      `SELECT daily_capacity, weekly_capacity, max_active_jobs 
       FROM service_providers WHERE provider_id = $1`,
      [user.id],
    );
    const cap = capResult.rows[0];
    if (activeJobs >= cap.max_active_jobs) {
      return res.status(400).json({
        success: false,
        error: `You have reached your maximum active jobs limit (${cap.max_active_jobs}). Please complete some jobs before accepting new ones.`,
      });
    }
    if (todayJobs >= cap.daily_capacity) {
      return res.status(400).json({
        success: false,
        error: `You have reached your daily capacity (${cap.daily_capacity} jobs). Please try again tomorrow.`,
      });
    }
    if (weekJobs >= cap.weekly_capacity) {
      return res.status(400).json({
        success: false,
        error: `You have reached your weekly capacity (${cap.weekly_capacity} jobs).`,
      });
    }

    await client.query('BEGIN');

    // Get service request – check status = 'pending' and provider_id = current user
    const serviceResult = await client.query(
      `SELECT estimated_cost, materials_cost, owner_id, property_id, title, status, provider_id
       FROM service_requests 
       WHERE service_id = $1`,
      [id],
    );
    console.log('🔵 Service request found:', serviceResult.rows[0]);

    if (serviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Service request not found',
      });
    }

    const service = serviceResult.rows[0];

    // ✅ Correct condition: pending AND provider_id matches the current user
    if (
      service.status !== 'pending' ||
      (service.provider_id !== null && service.provider_id !== user.id)
    ) {
      console.log(
        `🔴 Invalid state: status=${service.status}, provider_id=${service.provider_id}`,
      );
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'This job is not available for you to accept',
        current_status: service.status,
        current_provider: service.provider_id,
      });
    }

    // ✅ DEFINE finalPrice AND priceStatus HERE
    // When accepting without counter, final price should be labour + materials
    const finalPrice =
      parseFloat(service.estimated_cost) +
      parseFloat(service.materials_cost || 0);
    const priceStatus = 'accepted';

    // ✅ Update: status = 'accepted', price_status = 'accepted', final_price = estimated_cost
    await client.query(
      `UPDATE service_requests 
       SET provider_id = $1, 
           status = 'accepted', 
           accepted_at = NOW(),
           accepted_date = CURRENT_DATE,
           final_price = $2,
           price_status = $3
       WHERE service_id = $4`,
      [user.id, finalPrice, priceStatus, id],
    );

    // Notify provider that they accepted the job
    await sendPushToUser(
      user.id, // provider is the current user
      '✅ Job Accepted',
      `You have accepted the job "${service.title || 'Job'}". The owner will schedule a visit. You will be notified when a visit is scheduled.`,
      { screen: 'ProviderDashboard' },
    );

    const activeWorkCheck = await client.query(
      `SELECT 1
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       WHERE sr.provider_id = $1
         AND mv.status IN ('checked_in', 'in_progress')
       LIMIT 1`,
      [user.id],
    );
    if (activeWorkCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error:
          'You already have an active work session. Complete it before accepting another job.',
      });
    }

    // Update provider current_job_id and availability
    await client.query(
      `UPDATE service_providers 
   SET availability_status = 'available',
       last_status_update = NOW()
   WHERE provider_id = $1`,
      [user.id],
    );

    await client.query('COMMIT');

    // Get property address
    const addressResult = await pool.query(
      `SELECT address_street, address_city, address_state FROM properties WHERE property_id = $1`,
      [service.property_id],
    );
    const address = addressResult.rows[0] || {};

    // Notify owner
    try {
      await sendPushToUser(
        service.owner_id,
        '🔧 Service Provider Accepted',
        `Your service request "${service.title || 'Job'}" has been accepted. The price is locked. You can now schedule a visit.`,
        { screen: 'ServiceRequest', service_id: id },
      );
    } catch (pushErr) {
      console.error('Push error:', pushErr);
    }

    console.log('✅ Job accepted successfully');
    res.json({
      success: true,
      message: 'Job accepted successfully',
      address: {
        street: address.address_street || '',
        city: address.address_city || '',
        state: address.address_state || '',
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('🔴 Accept job error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/service-requests/:id/decline – provider declines a job
app.put('/api/service-requests/:id/decline', async (req, res) => {
  try {
    const { id } = req.params;
    // ✅ Safely extract reason with fallback
    const { reason } = req.body || {};
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'Reason is required to decline this job.',
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // Get service details for notifications
    const serviceResult = await pool.query(
      `SELECT owner_id, title, maintenance_request_id FROM service_requests WHERE service_id = $1`,
      [id],
    );
    if (serviceResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Service request not found' });
    }
    const service = serviceResult.rows[0];

    // Update status to rejected and store reason
    const result = await pool.query(
      `UPDATE service_requests 
       SET status = 'rejected', 
           rejection_reason = $1, 
           status_remark = $2 
       WHERE service_id = $3 AND (provider_id = $4 OR provider_id IS NULL)
       RETURNING *`,
      [reason, `Declined: ${reason}`, id, user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Service request not found or already assigned',
      });
    }

    // Send notifications
    await sendPushToUser(
      service.owner_id,
      '❌ Service Provider Declined',
      `The provider has declined your service request for "${service.title}". ${reason ? 'Reason: ' + reason : ''}`,
      { screen: 'Maintenance', ticket_id: service.maintenance_request_id },
    );
    await sendPushToUser(
      user.id,
      '❌ Job Declined',
      `You have declined the service request for "${service.title}".`,
      { screen: 'ProviderDashboard' },
    );

    res.json({ success: true, message: 'Job declined' });
  } catch (err) {
    console.error('Decline service request error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/service-requests/:id/complete – provider marks job as completed (awaiting owner confirmation)
app.put('/api/service-requests/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // 1️⃣ Update service request
    const result = await pool.query(
      `UPDATE service_requests SET status = 'completed', completed_at = NOW() WHERE service_id = $1 AND provider_id = $2 AND status IN ('accepted', 'in_progress') RETURNING *`,
      [id, user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Service request not found or not in accepted/in-progress state',
      });
    }

    // 2️⃣ Update linked maintenance visit -> set to 'awaiting_departure'
    const visitUpdateResult = await pool.query(
      `UPDATE maintenance_visits 
       SET status = 'awaiting_departure', 
           check_out_time = NOW() 
       WHERE service_request_id = $1 AND status IN ('checked_in', 'in_progress')
       RETURNING visit_id, service_request_id`,
      [id]
    );

    const visitId = visitUpdateResult.rows[0]?.visit_id;
    const serviceId = id;

    // Notify renter (if linked via maintenance request)
    if (visitId && result.rows[0]?.maintenance_request_id) {
      const renterResult = await pool.query(
        `SELECT renter_id FROM maintenance_requests WHERE request_id = $1`,
        [result.rows[0].maintenance_request_id]
      );
      if (renterResult.rows.length > 0) {
        const renterId = renterResult.rows[0].renter_id;
        await sendPushToUser(
          renterId,
          '✅ Work Completed – Confirm Departure',
          `The provider has finished the job. Please confirm they have left your property.`,
          { screen: 'Maintenance', visit_id: visitId }
        );
      }
    }

    // Also notify provider that they are waiting for confirmation
    await sendPushToUser(
      user.id,
      '⏳ Awaiting Departure Confirmation',
      `You have marked the job as complete. Please wait for the renter to confirm you have left. Payment will be released after confirmation.`,
      { screen: 'ProviderDashboard', service_id: serviceId }
    );

    // 4️⃣ Check if there is any other active work
    const activeWorkForCompletion = await pool.query(
      `SELECT 1
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       WHERE sr.provider_id = $1
         AND mv.status IN ('checked_in', 'in_progress')
       LIMIT 1`,
      [user.id],
    );
    const inProgressServiceForCompletion = await pool.query(
      `SELECT 1
       FROM service_requests
       WHERE provider_id = $1 AND status = 'in_progress'
       LIMIT 1`,
      [user.id],
    );
    const hasActiveWorkForCompletion =
      activeWorkForCompletion.rows.length > 0 ||
      inProgressServiceForCompletion.rows.length > 0;

    // ✅ DECLARE newAvailabilityStatus HERE (before using it)
    const newAvailabilityStatus = hasActiveWorkForCompletion ? 'at_work' : 'available';

    // 5️⃣ Update provider availability
    await pool.query(
      `UPDATE service_providers 
       SET availability_status = $1,
           last_status_update = NOW()
       WHERE provider_id = $2`,
      [newAvailabilityStatus, user.id],
    );

    // 6️⃣ Clear current_job_id if becoming available
    if (newAvailabilityStatus === 'available') {
      await pool.query(
        `UPDATE service_providers 
         SET current_job_id = NULL
         WHERE provider_id = $1`,
        [user.id],
      );
    }

    // 7️⃣ Notifications
    const serviceDetails = await pool.query(
      `SELECT sr.owner_id, sr.provider_id, sr.title, mr.renter_id
       FROM service_requests sr
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE sr.service_id = $1`,
      [id]
    );
    if (serviceDetails.rows.length > 0) {
      const { owner_id, provider_id, title, renter_id } = serviceDetails.rows[0];
      console.log('🔵 Sending completion notifications to:', { owner_id, provider_id, renter_id });
      await sendPushToUser(
        owner_id,
        '✅ Job Completed',
        `The provider has completed "${title}". Please confirm and release payment.`,
        { screen: 'ServiceRequest', service_id: id, type: 'job_completed' }
      );
      await sendPushToUser(
        provider_id,
        '✅ Job Completed',
        `You have completed "${title}". Awaiting owner confirmation and payment.`,
        { screen: 'ProviderDashboard', type: 'job_completed' }
      );
      if (renter_id) {
        await sendPushToUser(
          renter_id,
          '✅ Job Completed',
          `The maintenance work for "${title}" has been completed.`,
          { screen: 'Maintenance', type: 'job_completed' }
        );
      }
    }

    res.json({
      success: true,
      message: 'Job marked as completed. Awaiting owner confirmation.',
    });
  } catch (err) {
    console.error('Complete service request error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/service-requests/owner/:userId – list service requests for owner
// GET /api/service-requests/owner/:userId – list service requests for owner
app.get('/api/service-requests/owner/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user || user.id !== userId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    // Get all service requests for the owner
    const result = await pool.query(
      `SELECT sr.*, 
              COALESCE(sr.title, mr.title) as title,
              COALESCE(sr.description, mr.description) as description,
              p.title as property_title, 
              p.address_street,
              p.address_city,
              u_provider.name as provider_name,
              u_renter.name as renter_name,
              mr.title as maintenance_title,
              mr.request_id as maintenance_request_id,
              mv.visit_id,
              mv.status as visit_status,
              mv.scheduled_start
       FROM service_requests sr
       JOIN properties p ON sr.property_id = p.property_id
       LEFT JOIN users u_provider ON sr.provider_id = u_provider.user_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       LEFT JOIN users u_renter ON mr.renter_id = u_renter.user_id
       LEFT JOIN maintenance_visits mv ON sr.service_id = mv.service_request_id
       WHERE sr.owner_id = $1
       ORDER BY sr.created_at DESC`,
      [userId],
    );
    res.json({ success: true, serviceRequests: result.rows });
  } catch (err) {
    console.error('Owner service requests error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/service-requests/:id – single service request (owner, provider, or renter can view limited)
// GET /api/service-requests/:id – single service request (owner, provider, or renter can view limited)
app.get('/api/service-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const query = `
      SELECT 
        sr.service_id,
        sr.property_id,
        sr.status,
        sr.trade_type,
        sr.description,
        sr.estimated_cost,
        sr.estimated_hours,
        sr.materials_cost,
        sr.maintenance_request_id,
        sr.notes,
        sr.actual_cost,
        sr.created_at,
        sr.accepted_at,
        sr.completed_at,
        sr.counter_price,
        sr.counter_reason,
        sr.final_price,
        sr.price_status,
        sr.owner_id,
        sr.provider_id,
        sr.title,
        sr.media_url,
        p.title as property_title,
        p.address_street,
        p.address_city,
        p.address_state,
        u_provider.name as provider_name,
        u_provider.phone_number as provider_phone,
        u_owner.name as owner_name,
        u_owner.phone_number as owner_phone,
        u_renter.name as renter_name,
        mv.visit_id,
        mv.scheduled_start,
        mv.scheduled_end,
        mv.status as visit_status,
        mv.check_in_time,
        mv.check_out_time,
        mv.renter_safety_confirmed,
        mv.provider_safety_confirmed
      FROM service_requests sr
      LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
      JOIN properties p ON sr.property_id = p.property_id
      LEFT JOIN users u_provider ON sr.provider_id = u_provider.user_id
      LEFT JOIN users u_owner ON sr.owner_id = u_owner.user_id
      LEFT JOIN users u_renter ON mr.renter_id = u_renter.user_id
      LEFT JOIN maintenance_visits mv ON sr.service_id = mv.service_request_id
      WHERE sr.service_id = $1
      ORDER BY mv.created_at DESC
      LIMIT 1
    `;
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Service request not found' });
    }
    const service = result.rows[0];

    // Authorization: ensure the user is owner, provider, or renter (if renter exists)
    const isOwner = service.owner_id === user.id;
    const isProvider = service.provider_id === user.id;
    // Renter is only available via maintenance_requests
    const isRenter = service.renter_name !== null; // simplified; we need to check if the user is renter
    // Better: check if user is renter via maintenance_requests
    const renterCheck = await pool.query(
      `SELECT renter_id FROM maintenance_requests mr 
       JOIN service_requests sr ON mr.request_id = sr.maintenance_request_id 
       WHERE sr.service_id = $1 AND mr.renter_id = $2`,
      [id, user.id],
    );
    const isRenterValid = renterCheck.rows.length > 0;

    if (!isOwner && !isProvider && !isRenterValid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    // Build visit object if exists
    const visit = service.visit_id
      ? {
        visit_id: service.visit_id,
        scheduled_start: service.scheduled_start,
        scheduled_end: service.scheduled_end,
        status: service.visit_status,
        check_in_time: service.check_in_time,
        check_out_time: service.check_out_time,
        renter_safety_confirmed: service.renter_safety_confirmed,
        provider_safety_confirmed: service.provider_safety_confirmed,
      }
      : null;

    const responseData = {
      service_id: service.service_id,
      status: service.status,
      trade_type: service.trade_type,
      description: service.description,
      estimated_cost: service.estimated_cost,
      estimated_hours: service.estimated_hours,
      materials_cost: service.materials_cost,
      maintenance_request_id: service.maintenance_request_id,
      notes: service.notes,
      actual_cost: service.actual_cost,
      created_at: service.created_at,
      accepted_at: service.accepted_at,
      completed_at: service.completed_at,
      property_title: service.property_title,
      address_street: service.address_street,
      address_city: service.address_city,
      address_state: service.address_state,
      title: service.title,
      media_url: service.media_url,
      counter_price: service.counter_price,
      counter_reason: service.counter_reason,
      final_price: service.final_price,
      price_status: service.price_status,
      owner_id: service.owner_id,
      provider_id: service.provider_id,
      provider_name: service.provider_name,
      provider_phone: service.provider_phone,
      owner_name: service.owner_name,
      owner_phone: service.owner_phone,
      renter_name: service.renter_name,
      visit: visit, // include visit info
    };

    res.json({ success: true, serviceRequest: responseData });
  } catch (err) {
    console.error('Get service request error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/service-requests/by-maintenance/:maintenanceId
app.get(
  '/api/service-requests/by-maintenance/:maintenanceId',
  async (req, res) => {
    const { maintenanceId } = req.params;
    try {
      const result = await pool.query(
        `SELECT sr.*, u.name as provider_name
       FROM service_requests sr
       LEFT JOIN users u ON sr.provider_id = u.user_id
       WHERE sr.maintenance_request_id = $1
       ORDER BY sr.created_at DESC LIMIT 1`,
        [maintenanceId],
      );
      if (result.rows.length === 0) {
        return res.json({ success: true, serviceRequest: null });
      }
      res.json({ success: true, serviceRequest: result.rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// POST /api/service-requests/:id/counter – provider proposes a new price
// POST /api/service-requests/:id/counter – provider proposes a new price with reason
// POST /api/service-requests/:id/counter – provider proposes a new price with reason
app.post('/api/service-requests/:id/counter', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { counter_price, reason } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    if (!counter_price || parseFloat(counter_price) <= 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Valid counter price is required' });
    }

    // ✅ CAPACITY CHECK – Before allowing the counter
    const activeJobs = await countActiveJobs(user.id);
    const todayJobs = await countJobsToday(user.id);
    const weekJobs = await countJobsThisWeek(user.id);

    const capResult = await pool.query(
      `SELECT daily_capacity, weekly_capacity, max_active_jobs 
       FROM service_providers WHERE provider_id = $1`,
      [user.id],
    );
    const cap = capResult.rows[0];
    if (!cap) {
      return res.status(400).json({
        success: false,
        error: 'Provider profile not found. Please complete your registration.',
      });
    }
    if (activeJobs >= cap.max_active_jobs) {
      return res.status(400).json({
        success: false,
        error: `You have reached your maximum active jobs limit (${cap.max_active_jobs}). Please complete some jobs before proposing a counter.`,
      });
    }
    if (todayJobs >= cap.daily_capacity) {
      return res.status(400).json({
        success: false,
        error: `You have reached your daily capacity (${cap.daily_capacity} jobs). Please try again tomorrow.`,
      });
    }
    if (weekJobs >= cap.weekly_capacity) {
      return res.status(400).json({
        success: false,
        error: `You have reached your weekly capacity (${cap.weekly_capacity} jobs).`,
      });
    }

    await client.query('BEGIN');

    const serviceResult = await client.query(
      `SELECT sr.*, u.name as owner_name
   FROM service_requests sr
   JOIN users u ON sr.owner_id = u.user_id
   WHERE sr.service_id = $1 AND (sr.provider_id = $2 OR sr.provider_id IS NULL) AND sr.status = 'pending'`,
      [id, user.id],
    );
    if (serviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Service request not found or not eligible for counter',
      });
    }
    const service = serviceResult.rows[0];

    // ✅ Assign provider if null
    if (!service.provider_id) {
      await client.query(
        `UPDATE service_requests SET provider_id = $1 WHERE service_id = $2`,
        [user.id, id],
      );
    }

    // ✅ Update with status = 'negotiating' (counts toward capacity)
    await client.query(
      `UPDATE service_requests 
       SET counter_price = $1, 
           counter_reason = $2, 
           price_status = 'provider_countered',
           status = 'negotiating'   -- ✅ Counts toward active jobs
       WHERE service_id = $3`,
      [parseFloat(counter_price), reason || null, id],
    );

    await client.query('COMMIT');

    // Notify owner
    await sendPushToUser(
      service.owner_id,
      '💬 Counter Offer Proposed',
      `The provider has proposed a counter offer of ₦${parseFloat(Number(counter_price)).toLocaleString()} for "${service.title || 'your job'}". ${reason ? 'Reason: ' + reason : ''}`,
      { screen: 'ServiceRequest', service_id: id },
    );

    res.json({ success: true, message: 'Counter offer sent to owner' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Counter offer error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/service-requests/:id/decline-counter – owner declines provider counter offer
// PUT /api/service-requests/:id/decline-counter – owner declines provider counter offer
app.put('/api/service-requests/:id/decline-counter', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    await client.query('BEGIN');

    const serviceResult = await client.query(
      `SELECT sr.*, sp.provider_id
       FROM service_requests sr
       LEFT JOIN service_providers sp ON sr.provider_id = sp.provider_id
       WHERE sr.service_id = $1 AND sr.owner_id = $2 AND sr.price_status = 'provider_countered'`,
      [id, user.id],
    );
    if (serviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Service request not found, not yours, or no counter to decline',
      });
    }
    const service = serviceResult.rows[0];

    // ✅ Reset to pending (releases capacity) and increment attempts
    await client.query(
      `UPDATE service_requests 
       SET price_status = 'owner_proposed', 
           counter_price = NULL, 
           counter_reason = NULL,
           status = 'pending',
           counter_attempts = counter_attempts + 1
       WHERE service_id = $1`,
      [id],
    );

    // Check if attempts reached 3
    const attemptsResult = await client.query(
      `SELECT counter_attempts FROM service_requests WHERE service_id = $1`,
      [id],
    );

    if (attemptsResult.rows[0].counter_attempts >= 3) {
      // ✅ Auto-reject the job
      await client.query(
        `UPDATE service_requests 
         SET status = 'rejected',
             status_remark = 'Counter attempts exceeded (max 3)'
         WHERE service_id = $1`,
        [id],
      );

      await sendPushToUser(
        service.provider_id,
        '❌ Job Auto-Rejected',
        `Your counter attempts for "${service.title}" exceeded the limit (3). The job has been rejected.`,
        { screen: 'ProviderDashboard' },
      );
      await sendPushToUser(
        service.owner_id,
        '❌ Counter Attempts Exceeded',
        `The provider's counter attempts for "${service.title}" exceeded the limit. The job has been rejected. You can request service again.`,
        { screen: 'Maintenance' },
      );
    } else {
      // ✅ Notify provider that counter was declined (but still can retry)
      await sendPushToUser(
        service.provider_id,
        '❌ Counter Declined',
        `The owner has declined your counter offer for "${service.title}". You have ${3 - attemptsResult.rows[0].counter_attempts} attempts remaining.`,
        { screen: 'ProviderDashboard', service_id: id },
      );
      await sendPushToUser(
        service.owner_id,
        '❌ Counter Declined',
        `You have declined the provider's counter offer for "${service.title}". The price has been reset.`,
        { screen: 'ServiceRequest', service_id: id },
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Counter offer declined. Price reset to owner proposed.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Decline counter error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/service-requests/:id/accept-price – owner accepts the final price
// PUT /api/service-requests/:id/accept-price – owner accepts the final price
// PUT /api/service-requests/:id/accept-price – owner accepts the final price
app.put('/api/service-requests/:id/accept-price', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    await client.query('BEGIN');

    // Allow status = 'negotiating' as well
    const serviceResult = await client.query(
      `SELECT sr.*, sp.provider_id
       FROM service_requests sr
       JOIN service_providers sp ON sr.provider_id = sp.provider_id
       WHERE sr.service_id = $1 AND sr.owner_id = $2 AND sr.status IN ('pending', 'negotiating')`,
      [id, user.id],
    );
    if (serviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Service request not found or not yours',
      });
    }
    const service = serviceResult.rows[0];
    const providerId = service.provider_id;

    if (!providerId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'No provider assigned to this service request',
      });
    }

    // ✅ If a counter price exists, use it exactly. Otherwise, use estimated_cost.
    const finalPrice = service.counter_price
      ? parseFloat(service.counter_price)
      : parseFloat(service.estimated_cost);

    // Add validation to prevent impossible values
    if (finalPrice <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Invalid final price',
      });
    }

    // Update service request to 'accepted'
    await client.query(
      `UPDATE service_requests 
       SET final_price = $1, 
           price_status = 'accepted',
           status = 'accepted',
           accepted_date = COALESCE(accepted_date, CURRENT_DATE),
           accepted_at = NOW()
       WHERE service_id = $2`,
      [finalPrice, id],
    );

    // Check active work for the provider
    const activeWorkForProvider = await client.query(
      `SELECT 1
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       WHERE sr.provider_id = $1
         AND mv.status IN ('checked_in', 'in_progress')
       LIMIT 1`,
      [providerId],
    );
    const inProgressServiceForProvider = await client.query(
      `SELECT 1
       FROM service_requests
       WHERE provider_id = $1 AND status = 'in_progress'
       LIMIT 1`,
      [providerId],
    );
    const hasActiveWorkForProvider =
      activeWorkForProvider.rows.length > 0 ||
      inProgressServiceForProvider.rows.length > 0;

    // ✅ FIXED: Split update into two queries to avoid type inference errors
    const newAvailabilityStatus = hasActiveWorkForProvider
      ? 'at_work'
      : 'available';

    // Step 1: Update availability_status and timestamp
    await client.query(
      `UPDATE service_providers 
       SET availability_status = $1,
           last_status_update = NOW()
       WHERE provider_id = $2`,
      [newAvailabilityStatus, providerId],
    );

    // Step 2: Clear current_job_id only if becoming available
    if (newAvailabilityStatus === 'available') {
      await client.query(
        `UPDATE service_providers 
         SET current_job_id = NULL
         WHERE provider_id = $1`,
        [providerId],
      );
    }

    await client.query('COMMIT');

    // Notify provider
    await sendPushToUser(
      providerId,
      '✅ Price Accepted',
      `The owner has accepted your counter offer of ₦${parseFloat(Number(finalPrice)).toLocaleString()} for "${service.title}". You can now proceed.`,
      { screen: 'ProviderDashboard', service_id: id },
    );

    res.json({
      success: true,
      message: 'Price accepted. Please fund the escrow.',
      finalPrice,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Accept price error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/service-requests/:id/fund – owner funds the escrow
app.post('/api/service-requests/:id/fund', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // Get service request and user email
    const serviceResult = await pool.query(
      `SELECT sr.*, u.email
       FROM service_requests sr
       JOIN users u ON sr.owner_id = u.user_id
       WHERE sr.service_id = $1 AND sr.owner_id = $2 AND sr.price_status IN ('accepted', 'funded')`,
      [id, user.id],
    );
    if (serviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Service request not found or not ready for funding',
      });
    }
    const service = serviceResult.rows[0];

    // If already funded, return success
    if (service.price_status === 'funded') {
      return res.json({ success: true, message: 'Already funded' });
    }

    const finalPrice =
      parseFloat(service.final_price) || parseFloat(service.estimated_cost);
    if (!finalPrice || finalPrice <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid price' });
    }

    // Calculate Propadi service fee (e.g., 7%)
    const serviceFee = finalPrice * 0.07;
    const totalAmountKobo = Math.round((finalPrice + serviceFee) * 100);

    // Initialize Paystack transaction
    const paystackResponse = await fetch(
      'https://api.paystack.co/transaction/initialize',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: service.email,
          amount: totalAmountKobo,
          metadata: { service_id: id, type: 'service_escrow' },
          callback_url: 'propadi://paystack-return',
        }),
      },
    );
    const paystackData = await paystackResponse.json();

    if (paystackData.status) {
      // Save reference to service_requests
      await pool.query(
        `UPDATE service_requests SET payment_reference = $1 WHERE service_id = $2`,
        [paystackData.data.reference, id],
      );
      res.json({
        success: true,
        authorization_url: paystackData.data.authorization_url,
      });
    } else {
      res.status(400).json({ success: false, error: paystackData.message });
    }
  } catch (err) {
    console.error('Service escrow funding error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/service-requests/:id/release – owner releases funds to provider
app.put('/api/service-requests/:id/release', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    await client.query('BEGIN');

    // Verify request
    const serviceResult = await client.query(
      `SELECT sr.*, sp.provider_id
       FROM service_requests sr
       JOIN service_providers sp ON sr.provider_id = sp.provider_id
       WHERE sr.service_id = $1 AND sr.owner_id = $2 AND sr.status = 'completed' AND sr.price_status = 'funded'`,
      [id, user.id],
    );
    if (serviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ success: false, error: 'Completed, funded job not found' });
    }
    const service = serviceResult.rows[0];
    const amount =
      parseFloat(service.final_price) || parseFloat(service.estimated_cost);

    // Update service request
    await client.query(
      `UPDATE service_requests SET price_status = 'released' WHERE service_id = $1`,
      [id],
    );

    // Update escrow record
    await client.query(
      `UPDATE service_escrow SET status = 'released_to_provider', released_at = NOW() WHERE service_request_id = $1`,
      [id],
    );

    // Add amount to provider's wallet
    await client.query(
      `UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1 WHERE user_id = $2`,
      [amount, service.provider_id],
    );

    // Record transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, title, property_ref, amount, status)
       VALUES ($1, 'credit', 'Service Payment', $2, $3, 'Completed')`,
      [service.provider_id, `Service Job #${id.substring(0, 8)}`, amount],
    );

    // Also deduct from owner's balance (already done via Paystack)
    // Optionally record fee transaction for Propadi (the 7% fee already taken at payment time)

    await client.query('COMMIT');

    await sendPushToUser(
      service.provider_id,
      '✅ Payment Released',
      `₦${parseFloat(Number(amount)).toLocaleString()} has been added to your wallet for the completed job.`,
      { screen: 'ProviderDashboard', service_id: id },
    );

    res.json({ success: true, message: 'Funds released to provider' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Release escrow error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/service-requests/:id/in-progress – provider marks job as in progress
app.put('/api/service-requests/:id/in-progress', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // ✅ Backend check: verify safety is confirmed
    const safetyCheck = await pool.query(
      `SELECT mv.renter_safety_confirmed
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       WHERE sr.service_id = $1 AND sr.provider_id = $2`,
      [id, user.id],
    );
    if (
      safetyCheck.rows.length === 0 ||
      !safetyCheck.rows[0].renter_safety_confirmed
    ) {
      return res.status(403).json({
        success: false,
        error:
          'Cannot mark as in-progress until the renter has confirmed safety.',
      });
    }

    const result = await pool.query(
      `UPDATE service_requests SET status = 'in_progress' 
       WHERE service_id = $1 AND provider_id = $2 AND status = 'accepted' 
       RETURNING *`,
      [id, user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Job not found or not in accepted state',
      });
    }

    await pool.query(
      `UPDATE service_providers 
       SET availability_status = 'at_work', current_job_id = $2
       WHERE provider_id = $1`,
      [user.id, id],
    );

    // Notify owner
    await sendPushToUser(
      result.rows[0].owner_id,
      '🔧 Work Started',
      `The provider has started working on your service request.`,
      { screen: 'ServiceRequest', service_id: id },
    );

    res.json({ success: true, message: 'Job marked as in progress' });
  } catch (err) {
    console.error('In-progress error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/maintenance-visits/:userId – list visits where user is owner, provider, or renter
// GET /api/maintenance-visits/:userId – list visits where user is owner, provider, or renter
app.get('/api/maintenance-visits/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user || user.id !== userId)
      return res.status(403).json({ success: false, error: 'Forbidden' });

    const query = `
      SELECT 
        mv.visit_id,
        mv.scheduled_start,
        mv.scheduled_end,
        mv.status,
        mv.check_in_time,
        mv.check_out_time,
        mv.renter_safety_confirmed,
        mv.provider_safety_confirmed,
        mv.stage1_verified,
        mv.stage1_verified_at,
        mv.stage2_verified,
        mv.stage2_verified_at,
        mv.involves_renter,
        COALESCE(mv.renter_id, mr.renter_id) as renter_id,
        sr.service_id,
        sr.trade_type,
        sr.maintenance_request_id,
        COALESCE(sr.title, mr.title) as title,
        COALESCE(sr.description, mr.description) as description,
        p.property_id,
        p.title as property_title,
        p.address_street,
        p.address_city,
        p.address_state,
        u_owner.name as owner_name,
        u_provider.name as provider_name,
        COALESCE(u_renter.name, u_visit_renter.name) as renter_name
      FROM maintenance_visits mv
      JOIN service_requests sr ON mv.service_request_id = sr.service_id
      LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
      JOIN properties p ON sr.property_id = p.property_id
      LEFT JOIN users u_owner ON sr.owner_id = u_owner.user_id
      LEFT JOIN users u_provider ON sr.provider_id = u_provider.user_id
      LEFT JOIN users u_renter ON mr.renter_id = u_renter.user_id
      LEFT JOIN users u_visit_renter ON mv.renter_id = u_visit_renter.user_id
      WHERE sr.owner_id = $1 OR sr.provider_id = $1 OR mr.renter_id = $1 OR mv.renter_id = $1
      ORDER BY mv.scheduled_start DESC
    `;
    const result = await pool.query(query, [userId]);
    res.json({ success: true, visits: result.rows });
  } catch (err) {
    console.error('Error fetching visits:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits (or /api/maintenance-visits/schedule) – owner schedules a visit
app.post(['/api/maintenance-visits', '/api/maintenance-visits/schedule'], async (req, res) => {
  const client = await pool.connect();
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    const {
      service_request_id,
      scheduled_start,
      scheduled_end,
      reschedule_visit_id,
      is_occupied,
      involves_renter,
    } = req.body;
    if (!service_request_id || !scheduled_start) {
      return res.status(400).json({
        success: false,
        error: 'Service request ID and start time are required',
      });
    }

    await client.query('BEGIN');

    // Verify ownership and get provider + property + renter info
    const serviceCheck = await client.query(
      `SELECT sr.owner_id, sr.provider_id, sr.property_id, mr.renter_id, sr.title AS service_title
       FROM service_requests sr
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE sr.service_id = $1`,
      [service_request_id],
    );
    if (serviceCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Service request not found',
      });
    }
    const { owner_id, provider_id, property_id, renter_id, service_title } =
      serviceCheck.rows[0];

    if (owner_id !== user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        error: 'You are not the owner of this service request',
      });
    }

    // Determine target renter ID and involves_renter flag
    let targetRenterId = renter_id || null;
    let isInvolvingRenter = Boolean(involves_renter || renter_id);

    if (isInvolvingRenter && !targetRenterId && property_id) {
      // Fetch active tenancy for property to get renter_id
      const tenancyRes = await client.query(
        `SELECT renter_id FROM tenancies 
         WHERE property_id = $1 
           AND (status IN ('Active', 'Signed') OR payment_status = 'Paid')
           AND lease_end_date >= NOW()
         ORDER BY lease_end_date DESC 
         LIMIT 1`,
        [property_id],
      );
      if (tenancyRes.rows.length > 0) {
        targetRenterId = tenancyRes.rows[0].renter_id;
      }
    }

    // ✅ If reschedule_visit_id is provided, handle rescheduling
    if (reschedule_visit_id) {
      // Verify the visit exists and belongs to this service request
      const visitCheck = await client.query(
        `SELECT visit_id, status FROM maintenance_visits WHERE visit_id = $1 AND service_request_id = $2`,
        [reschedule_visit_id, service_request_id],
      );
      if (visitCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Visit not found or does not belong to this service request',
        });
      }

      const visitStatus = visitCheck.rows[0].status;

      // ✅ If the visit is CANCELLED, create a new visit instead of updating
      if (visitStatus === 'cancelled') {
        const newPin = Math.floor(100000 + Math.random() * 900000).toString();
        const newQrCode = `VISIT_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        const insertResult = await client.query(
          `INSERT INTO maintenance_visits 
           (service_request_id, scheduled_start, scheduled_end, qr_code, pin, status, involves_renter, renter_id)
           VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7)
           RETURNING *`,
          [
            service_request_id,
            scheduled_start,
            scheduled_end || null,
            newQrCode,
            newPin,
            isInvolvingRenter,
            targetRenterId,
          ],
        );
        const visit = insertResult.rows[0];

        await client.query('COMMIT');

        // Notify provider and renter of new visit
        const newTimeLabel = new Date(scheduled_start).toLocaleString();
        if (provider_id) {
          await sendPushToUser(
            provider_id,
            '📅 New Visit Scheduled',
            `A new visit has been scheduled for ${service_title || 'your service request'} at ${newTimeLabel}.`,
            { screen: 'ProviderDashboard', visit_id: visit.visit_id },
          );
        }
        if (targetRenterId) {
          await sendPushToUser(
            targetRenterId,
            '📅 Maintenance Visit Scheduled',
            `A maintenance visit has been scheduled at your residence for ${service_title || 'a maintenance service'} at ${newTimeLabel}.`,
            { screen: 'Maintenance', visit_id: visit.visit_id },
          );
        }

        return res.json({ success: true, visit });
      }

      // ✅ If the visit is still 'scheduled', update it normally
      if (visitStatus === 'scheduled') {
        await client.query(
          `UPDATE maintenance_visits 
           SET scheduled_start = $1, scheduled_end = $2, status = 'scheduled', involves_renter = $3, renter_id = $4
           WHERE visit_id = $5`,
          [
            scheduled_start,
            scheduled_end || null,
            isInvolvingRenter,
            targetRenterId,
            reschedule_visit_id,
          ],
        );

        const updated = await client.query(
          `SELECT * FROM maintenance_visits WHERE visit_id = $1`,
          [reschedule_visit_id],
        );
        const visit = updated.rows[0];

        await client.query('COMMIT');

        const newTimeLabel = new Date(scheduled_start).toLocaleString();
        if (provider_id) {
          await sendPushToUser(
            provider_id,
            '📅 Visit Rescheduled',
            `The visit for ${service_title || 'your service request'} has been rescheduled to ${newTimeLabel}.`,
            { screen: 'ProviderDashboard', visit_id: visit.visit_id },
          );
        }
        if (targetRenterId) {
          await sendPushToUser(
            targetRenterId,
            '📅 Visit Rescheduled',
            `Your maintenance visit at your residence has been rescheduled to ${newTimeLabel}.`,
            { screen: 'Maintenance', visit_id: visit.visit_id },
          );
        }

        return res.json({ success: true, visit });
      }

      // ✅ If the visit is in progress or completed, prevent rescheduling
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error:
          'Cannot reschedule a visit that is already in progress or completed.',
      });
    }

    // Otherwise, create a new visit
    if (provider_id) {
      const hasConflict = await hasScheduleConflict(
        provider_id,
        scheduled_start,
        scheduled_end ||
        new Date(new Date(scheduled_start).getTime() + 3600000),
      );
      if (hasConflict) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error:
            'The provider already has a scheduled visit at that time. Please choose a different time.',
        });
      }
    }

    // Generate PIN and QR code
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const qrCode = `VISIT_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const insertResult = await client.query(
      `INSERT INTO maintenance_visits 
       (service_request_id, scheduled_start, scheduled_end, qr_code, pin, status, involves_renter, renter_id)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7)
       RETURNING *`,
      [
        service_request_id,
        scheduled_start,
        scheduled_end || null,
        qrCode,
        pin,
        isInvolvingRenter,
        targetRenterId,
      ],
    );
    const visit = insertResult.rows[0];

    await client.query('COMMIT');

    // Notify provider and renter
    if (provider_id) {
      await sendPushToUser(
        provider_id,
        '📅 Maintenance Visit Scheduled',
        `A maintenance visit has been scheduled for ${new Date(scheduled_start).toLocaleString()}. Please confirm your availability.`,
        { screen: 'Maintenance', visit_id: visit.visit_id },
      );
    }
    if (targetRenterId) {
      await sendPushToUser(
        targetRenterId,
        '📅 Maintenance Visit Scheduled',
        `A maintenance visit has been scheduled at your residence for ${new Date(scheduled_start).toLocaleString()}.`,
        { screen: 'Maintenance', visit_id: visit.visit_id },
      );
    }

    res.json({ success: true, visit });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Schedule visit error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/maintenance-visits/:id/confirm – provider or renter confirms
app.put('/api/maintenance-visits/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // Update visit status to 'scheduled' (already) – we can track who confirmed in future
    // For simplicity, we just mark that it's confirmed by setting status to 'scheduled' (already)
    // but we can add a confirmed_at column if needed.
    // For now, we send a notification to the owner.
    const visitResult = await pool.query(
      `SELECT service_request_id FROM maintenance_visits WHERE visit_id = $1`,
      [id],
    );
    if (visitResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const serviceId = visitResult.rows[0].service_request_id;
    const serviceResult = await pool.query(
      `SELECT owner_id FROM service_requests WHERE service_id = $1`,
      [serviceId],
    );
    if (serviceResult.rows.length > 0) {
      await sendPushToUser(
        serviceResult.rows[0].owner_id,
        '✅ Visit Confirmed',
        `The visit has been confirmed by ${user.email}.`,
        { screen: 'Maintenance', visit_id: id },
      );
    }

    res.json({ success: true, message: 'Confirmation sent' });
  } catch (err) {
    console.error('Confirm visit error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits/:id/checkin – provider checks in with QR/PIN and GPS
// POST /api/maintenance-visits/:id/checkin – provider checks in with PIN and GPS
app.post('/api/maintenance-visits/:id/checkin', async (req, res) => {
  try {
    const { id } = req.params;
    const { pin, gps_lat, gps_lng } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    if (!pin) {
      return res.status(400).json({ success: false, error: 'PIN is required' });
    }

    // ✅ Get visit details including provider, owner, and renter
    // Inside the check‑in endpoint, after fetching the visit
    const visitResult = await pool.query(
      `SELECT mv.*, 
              sr.provider_id, 
              sr.owner_id, 
              mr.renter_id,
              sr.title,
              p.address_city,
              p.address_state
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       JOIN properties p ON sr.property_id = p.property_id
       WHERE mv.visit_id = $1`,
      [id],
    );
    if (visitResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const visit = visitResult.rows[0];

    if (visit.pin_used) {
      return res
        .status(400)
        .json({ success: false, error: 'PIN already used' });
    }

    // ✅ Check if PIN has expired or has no expiry date
    if (!visit.pin_expires_at || new Date() > new Date(visit.pin_expires_at)) {
      return res.status(400).json({
        success: false,
        error: 'PIN has expired or is invalid. Please request a new one.',
      });
    }

    // Verify the user is the assigned provider
    if (visit.provider_id !== user.id) {
      return res.status(403).json({
        success: false,
        error: 'You are not the assigned provider for this visit',
      });
    }

    // Verify PIN
    if (visit.pin !== pin) {
      return res.status(400).json({ success: false, error: 'Invalid PIN' });
    }

    // ✅ Add Grace Window Check
    const scheduledStart = new Date(visit.scheduled_start);
    const now = new Date();

    // Check if it's the same day
    const isSameDay = scheduledStart.toDateString() === now.toDateString();
    if (!isSameDay) {
      return res.status(400).json({
        success: false,
        error: 'You can only check in on the scheduled day.',
      });
    }

    // Check if within 2-hour grace window
    const graceMinutes = 120; // 2 hours
    const diffMinutes =
      (now.getTime() - scheduledStart.getTime()) / (1000 * 60);
    if (diffMinutes > graceMinutes || diffMinutes < -graceMinutes) {
      return res.status(400).json({
        success: false,
        error: `You can only check in within 2 hours of the scheduled time.`,
      });
    }

    // Check if already checked in
    if (visit.check_in_time) {
      return res
        .status(400)
        .json({ success: false, error: 'Already checked in' });
    }

    // Check if provider already has a checked_in or in_progress job
    const activeCheckin = await pool.query(
      `SELECT mv.visit_id 
   FROM maintenance_visits mv
   JOIN service_requests sr ON mv.service_request_id = sr.service_id
   WHERE sr.provider_id = $1 AND mv.status IN ('checked_in', 'in_progress')`,
      [user.id],
    );
    if (activeCheckin.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error:
          'You already have an active check-in. Please complete it before checking in to another job.',
      });
    }

    // 🛑 MODIFIED: Set stage1_verified = TRUE and stage1_verified_at along with other updates
    await pool.query(
      `UPDATE maintenance_visits 
       SET status = 'checked_in', 
           check_in_time = COALESCE(check_in_time, NOW()), 
           stage1_verified_at = COALESCE(stage1_verified_at, NOW()),
           gps_lat = $1, 
           gps_lng = $2,
           pin_used = TRUE,
           stage1_verified = TRUE   -- Stage 1 completed
       WHERE visit_id = $3`,
      [gps_lat || null, gps_lng || null, id],
    );

    // After updating the visit, add this:
    await pool.query(
      `UPDATE service_providers 
       SET availability_status = 'at_work', current_job_id = $2
       WHERE provider_id = $1`,
      [user.id, visit.service_request_id],
    );

    // Notify owner and renter – updated to clarify Stage 1 completion
    if (visit.owner_id) {
      await sendPushToUser(
        visit.owner_id,
        '🔐 Stage 1 Complete',
        `The provider has verified the PIN for "${visit.title}". Stage 2 (renter verification) is pending.`,
        { screen: 'Maintenance', visit_id: id },
      );
    }
    if (visit.renter_id) {
      await sendPushToUser(
        visit.renter_id,
        '🔐 Provider Checked In (Stage 1)',
        `The provider has entered the owner's PIN for "${visit.title}". Please prepare to verify their identity via QR scan (Stage 2).`,
        { screen: 'Maintenance', visit_id: id },
      );
    }

    res.json({ success: true, message: 'Stage 1 complete. Please proceed to Stage 2 (renter QR verification).' });
  } catch (err) {
    console.error('Check‑in error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits/:id/initiate-renter-verification – provider initiates Stage 2 QR
app.post('/api/maintenance-visits/:id/initiate-renter-verification', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // Get visit and verify provider
    const visitResult = await pool.query(
      `SELECT mv.*, sr.provider_id, sr.owner_id, mr.renter_id, sr.title,
              p.title as property_title,
              sp.trade_type,
              u.name as provider_name,
              u.profile_picture_url
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       JOIN properties p ON sr.property_id = p.property_id
       JOIN service_providers sp ON sr.provider_id = sp.provider_id
       JOIN users u ON sp.provider_id = u.user_id
       WHERE mv.visit_id = $1`,
      [id],
    );
    if (visitResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const visit = visitResult.rows[0];

    if (visit.provider_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Not your visit' });
    }

    // Must have Stage 1 complete, not Stage 2, and status = 'checked_in'
    if (!visit.stage1_verified) {
      return res.status(400).json({
        success: false,
        error: 'Stage 1 (Owner PIN) not completed yet.',
      });
    }
    if (visit.stage2_verified) {
      return res.status(400).json({
        success: false,
        error: 'Stage 2 already completed.',
      });
    }
    if (visit.status !== 'checked_in') {
      return res.status(400).json({
        success: false,
        error: 'Visit must be in checked_in state.',
      });
    }

    // Build QR data with security tips
    const securityTips = [
      'Verify the provider matches the photo shown on this screen.',
      'Ensure the provider is wearing appropriate identification.',
      'Do not share your PIN or personal information.',
      'If you feel unsafe, contact Propadi support immediately.',
    ];

    const qrData = JSON.stringify({
      visitId: id,
      providerId: user.id,
      providerName: visit.provider_name,
      providerTrade: visit.trade_type,
      providerPhoto: visit.profile_picture_url,
      propertyTitle: visit.property_title,
      jobTitle: visit.title,
      securityTips,
      nonce: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
      exp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `UPDATE maintenance_visits 
       SET qr_code = $1, qr_expires_at = $2
       WHERE visit_id = $3`,
      [qrData, expiresAt, id],
    );

    // Notify renter that QR is ready
    if (visit.renter_id) {
      await sendPushToUser(
        visit.renter_id,
        '📱 Renter Verification Ready',
        `The provider is ready for your identity verification. Please scan the QR code in the app.`,
        { screen: 'Maintenance', visit_id: id },
      );
    }

    res.json({
      success: true,
      qrData,
      expiresAt: expiresAt.toISOString(),
      providerName: visit.provider_name,
      providerTrade: visit.trade_type,
      providerPhoto: visit.profile_picture_url,
      propertyTitle: visit.property_title,
      jobTitle: visit.title,
    });
  } catch (err) {
    console.error('Initiate renter verification error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits/:id/renter-verify-identity – renter scans QR (Stage 2)
app.post('/api/maintenance-visits/:id/renter-verify-identity', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // Get visit and verify renter
    const visitResult = await pool.query(
      `SELECT mv.*, sr.provider_id, mr.renter_id, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.visit_id = $1`,
      [id],
    );
    if (visitResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const visit = visitResult.rows[0];

    if (visit.renter_id !== user.id) {
      return res.status(403).json({
        success: false,
        error: 'Only the renter can verify identity.',
      });
    }

    // Check state
    if (!visit.stage1_verified) {
      return res.status(400).json({
        success: false,
        error: 'Stage 1 (Owner PIN) not completed yet.',
      });
    }
    if (visit.stage2_verified) {
      return res.status(400).json({
        success: false,
        error: 'Stage 2 already completed.',
      });
    }
    if (!visit.qr_code || new Date() > new Date(visit.qr_expires_at)) {
      return res.status(400).json({
        success: false,
        error: 'QR code expired. Provider must re-initiate.',
      });
    }

    // Mark Stage 2 complete with timestamp
    await pool.query(
      `UPDATE maintenance_visits 
       SET stage2_verified = TRUE,
           stage2_verified_at = NOW()
       WHERE visit_id = $1`,
      [id],
    );

    // Notify provider and owner
    await sendPushToUser(
      visit.provider_id,
      '✅ Stage 2 Complete',
      `The renter has verified your identity for "${visit.title}". Awaiting renter safety confirmation.`,
      { screen: 'ProviderDashboard', service_id: visit.service_id },
    );
    await sendPushToUser(
      visit.owner_id,
      '✅ Stage 2 Complete',
      `The renter has verified the provider's identity for "${visit.title}".`,
      { screen: 'VisitManagement', visit_id: id },
    );

    res.json({ success: true, message: 'Identity verified. Check-in is now fully complete.' });
  } catch (err) {
    console.error('Renter verify identity error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT/POST /api/maintenance-visits/:id/safety & confirm-safety – confirm safety (renter or provider)
app.all(['/api/maintenance-visits/:id/safety', '/api/maintenance-visits/:id/confirm-safety'], async (req, res) => {
  if (req.method !== 'PUT' && req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  try {
    const { id } = req.params;
    const { role } = req.body; // 'renter' or 'provider'
    if (!role || !['renter', 'provider'].includes(role)) {
      return res
        .status(400)
        .json({ success: false, error: 'Role must be renter or provider' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // ✅ Get visit details and service request info for notifications
    const visitResult = await pool.query(
      `SELECT mv.*, 
              sr.provider_id, 
              sr.owner_id, 
              sr.title,
              sr.service_id
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       WHERE mv.visit_id = $1`,
      [id],
    );
    if (visitResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const visit = visitResult.rows[0];

    // 🛑 NEW: Require both Stage 1 and Stage 2 to be complete before allowing safety confirmation
    if (!visit.stage1_verified || !visit.stage2_verified) {
      return res.status(403).json({
        success: false,
        error: 'Cannot confirm safety until both Stage 1 (Owner PIN) and Stage 2 (Renter QR) are complete.',
      });
    }

    const column =
      role === 'renter'
        ? 'renter_safety_confirmed'
        : 'provider_safety_confirmed';
    await pool.query(
      `UPDATE maintenance_visits SET ${column} = TRUE WHERE visit_id = $1`,
      [id],
    );

    // ✅ If renter confirmed safety, notify the provider
    // If renter confirmed safety, notify the provider
    if (role === 'renter' && visit.provider_id) {
      await sendPushToUser(
        visit.provider_id,
        '✅ Safety Confirmed',
        `The renter has confirmed safety for "${visit.title}". You can now mark the job as in progress.`,
        {
          screen: 'ProviderDashboard',
          type: 'safety_confirmed',
          service_id: visit.service_id,
        },
      );
    }

    // ✅ Also notify owner (optional)
    if (visit.owner_id) {
      await sendPushToUser(
        visit.owner_id,
        '✅ Safety Confirmed',
        `Safety has been confirmed for the visit at "${visit.title}".`,
        { screen: 'Maintenance' },
      );
    }

    res.json({ success: true, message: `Safety confirmed by ${role}` });
  } catch (err) {
    console.error('Confirm safety error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits/:id/confirm-departure – renter confirms provider has left
app.post('/api/maintenance-visits/:id/confirm-departure', async (req, res) => {
  try {
    const { id } = req.params;
    const { gps_lat, gps_lng } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token' });

    const visitResult = await pool.query(
      `SELECT mv.*, sr.owner_id, sr.provider_id, sr.service_id, mr.renter_id, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.visit_id = $1`,
      [id]
    );
    if (visitResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const visit = visitResult.rows[0];

    // Verify the user is the renter
    if (visit.renter_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Only the renter can confirm departure.' });
    }

    // Check status
    if (visit.status !== 'awaiting_departure') {
      return res.status(400).json({ success: false, error: 'Departure confirmation is not required at this stage.' });
    }

    if (visit.renter_departure_confirmed) {
      return res.status(400).json({ success: false, error: 'Departure already confirmed.' });
    }

    // Confirm departure
    await pool.query(
      `UPDATE maintenance_visits
       SET renter_departure_confirmed = TRUE,
           departure_confirmed_at = NOW(),
           status = 'completed'
       WHERE visit_id = $1`,
      [id]
    );

    // ✅ Bonus: +2 trust points for timely confirmation
    await pool.query(
      `UPDATE users SET renter_score = renter_score + 2 WHERE user_id = $1`,
      [visit.renter_id]
    );

    // Notify owner and provider
    await sendPushToUser(
      visit.owner_id,
      '✅ Departure Confirmed',
      `The renter has confirmed the provider has left for "${visit.title}". You can now release payment.`,
      { screen: 'VisitManagement', visit_id: id }
    );
    await sendPushToUser(
      visit.provider_id,
      '✅ Departure Confirmed',
      `The renter has confirmed you have left. Payment is now available for release.`,
      { screen: 'ProviderDashboard', service_id: visit.service_id }
    );

    res.json({ success: true, message: 'Departure confirmed. Payment can now be released.' });
  } catch (err) {
    console.error('Confirm departure error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// POST /api/maintenance-visits/:id/provider-departure – provider marks they have left (with GPS)
app.post('/api/maintenance-visits/:id/provider-departure', async (req, res) => {
  try {
    const { id } = req.params;
    const { gps_lat, gps_lng, evidence_url } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token' });

    if (!gps_lat || !gps_lng) {
      return res.status(400).json({ success: false, error: 'GPS location is required to prove you have left.' });
    }
    if (!evidence_url) {
      return res.status(400).json({ success: false, error: 'Evidence photo is required to mark renter as uncooperative.' });
    }

    const visitResult = await pool.query(
      `SELECT mv.*, sr.provider_id, sr.owner_id, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       WHERE mv.visit_id = $1`,
      [id]
    );
    if (visitResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const visit = visitResult.rows[0];

    if (visit.provider_id !== user.id) {
      return res.status(403).json({ success: false, error: 'You are not the assigned provider.' });
    }

    if (visit.status !== 'awaiting_departure') {
      return res.status(400).json({ success: false, error: 'Departure not required at this stage.' });
    }

    // Simple GPS check: ensure provider is at least 100m away (rough check)
    // In real implementation, you'd compare with property coordinates.
    // For now, we just accept any GPS and flag it.
    await pool.query(
      `UPDATE maintenance_visits
       SET provider_departure_gps_lat = $1,
           provider_departure_gps_lng = $2,
           renter_uncooperative = TRUE,
           uncooperative_evidence_url = $3,
           updated_at = NOW()
       WHERE visit_id = $4`,
      [gps_lat, gps_lng, evidence_url, id]
    );

    // Notify owner
    await sendPushToUser(
      visit.owner_id,
      '⚠️ Provider Left – Renter Uncooperative',
      `The provider has left the premises but the renter has not confirmed departure. Evidence attached. The job will auto‑complete in 12 hours if unresolved.`,
      { screen: 'VisitManagement', visit_id: id }
    );

    res.json({
      success: true,
      message: 'Provider departure logged. Renter flagged as uncooperative. Job will auto‑complete in 12 hours.',
    });
  } catch (err) {
    console.error('Provider departure error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/maintenance-visits/:id/status – update visit status (cancel, etc.)
app.put('/api/maintenance-visits/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = [
      'scheduled',
      'checked_in',
      'in_progress',
      'completed',
      'cancelled',
    ];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // Verify ownership and get service request details for notifications
    const result = await pool.query(
      `SELECT sr.owner_id, sr.provider_id, mr.renter_id, sr.title 
       FROM maintenance_visits mv 
       JOIN service_requests sr ON mv.service_request_id = sr.service_id 
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id 
       WHERE mv.visit_id = $1`,
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const { owner_id, provider_id, renter_id, title } = result.rows[0];
    if (owner_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Not your visit' });
    }

    // Only allow cancel if status is 'scheduled'
    if (status === 'cancelled') {
      const currentStatus = await pool.query(
        `SELECT status FROM maintenance_visits WHERE visit_id = $1`,
        [id],
      );
      if (currentStatus.rows[0].status !== 'scheduled') {
        return res.status(400).json({
          success: false,
          error:
            'Cannot cancel a visit that is already in progress or completed.',
        });
      }
    }

    await pool.query(
      `UPDATE maintenance_visits SET status = $1 WHERE visit_id = $2`,
      [status, id],
    );

    // Notify provider and renter
    if (status === 'cancelled') {
      if (provider_id) {
        await sendPushToUser(
          provider_id,
          '❌ Visit Cancelled',
          `The owner has cancelled the scheduled visit for "${title}".`,
          { screen: 'ProviderDashboard' },
        );
      }
      if (renter_id) {
        await sendPushToUser(
          renter_id,
          '❌ Visit Cancelled',
          `The owner has cancelled the scheduled visit for "${title}".`,
          { screen: 'Maintenance' },
        );
      }
    }

    res.json({ success: true, message: `Visit status updated to ${status}` });
  } catch (err) {
    console.error('Update visit status error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/maintenance-visits/single/:visitId – get details of a single visit
app.get('/api/maintenance-visits/single/:visitId', async (req, res) => {
  try {
    const { visitId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // ✅ CORRECTED: Join with maintenance_requests to get renter_id
    const query = `
      SELECT 
        mv.visit_id,
        mv.scheduled_start,
        mv.scheduled_end,
        mv.status,
        mv.pin,
        mv.pin_expires_at,
        mv.check_in_time,
        mv.renter_safety_confirmed,
        mv.provider_safety_confirmed,
        mv.stage1_verified,
        mv.stage1_verified_at,
        mv.stage2_verified,
        mv.stage2_verified_at,
        sr.service_id,
        sr.trade_type,
        sr.title,
        sr.description,
        sr.maintenance_request_id,
        sr.owner_id,
        sr.provider_id,
        mr.renter_id,
        p.property_id,
        sr.estimated_cost,
        sr.final_price,
        sr.media_url,
        sr.price_status,
        sr.materials_cost,
        p.title as property_title,
        p.address_street,
        p.address_city,
        p.address_state,
        u_owner.name as owner_name,
        u_provider.name as provider_name,
        u_renter.name as renter_name
      FROM maintenance_visits mv
      JOIN service_requests sr ON mv.service_request_id = sr.service_id
      LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
      JOIN properties p ON sr.property_id = p.property_id
      LEFT JOIN users u_owner ON sr.owner_id = u_owner.user_id
      LEFT JOIN users u_provider ON sr.provider_id = u_provider.user_id
      LEFT JOIN users u_renter ON mr.renter_id = u_renter.user_id
      WHERE mv.visit_id = $1
    `;
    const result = await pool.query(query, [visitId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    res.json({ success: true, visit: result.rows[0] });
  } catch (err) {
    console.error('Error fetching visit:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits/:id/request-pin – provider requests PIN from owner
// POST /api/maintenance-visits/:id/request-pin – provider requests PIN from owner
app.post('/api/maintenance-visits/:id/request-pin', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // Get owner_id from visit
    const result = await pool.query(
      `SELECT sr.owner_id, sr.title 
       FROM maintenance_visits mv 
       JOIN service_requests sr ON mv.service_request_id = sr.service_id 
       WHERE mv.visit_id = $1`,
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const { owner_id, title } = result.rows[0];

    // Send push notification to owner
    await sendPushToUser(
      owner_id,
      '📱 PIN Requested',
      `The provider has arrived and is requesting the PIN for "${title}". Please generate and share it.`,
      { screen: 'VisitManagement', visit_id: id },
    );

    res.json({ success: true, message: 'PIN request sent to owner' });
  } catch (err) {
    console.error('Request PIN error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits/:id/generate-pin – owner generates a new PIN for the visit
app.post('/api/maintenance-visits/:id/generate-pin', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user)
      return res.status(401).json({ success: false, error: 'Invalid token' });

    // ✅ Ensure query includes sr.provider_id
    const result = await pool.query(
      `SELECT sr.owner_id, sr.provider_id, sr.title 
       FROM maintenance_visits mv 
       JOIN service_requests sr ON mv.service_request_id = sr.service_id 
       WHERE mv.visit_id = $1`,
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }

    // ✅ Destructure safely (provider_id may be null)
    const { owner_id, provider_id, title } = result.rows[0];

    // Verify ownership
    if (owner_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Not your visit' });
    }

    // ✅ Generate 6‑digit PIN with 10‑minute expiry (aligned with Stage 1 security protocol)
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await pool.query(
      `UPDATE maintenance_visits 
       SET pin = $1, 
           pin_expires_at = $2, 
           pin_used = FALSE 
       WHERE visit_id = $3`,
      [pin, expiresAt, id],
    );

    // ✅ Send PIN to provider if provider exists
    if (provider_id) {
      await sendPushToUser(
        provider_id,
        '🔑 PIN Generated',
        `The owner has generated the PIN for "${title}". Your PIN: ${pin}. This expires in 10 minutes. Use this to check in (Stage 1).`,
        { screen: 'ProviderDashboard' },
      );
    }

    // ✅ Notify owner that PIN was generated (and optionally sent)
    await sendPushToUser(
      owner_id,
      '📤 PIN Generated',
      `The PIN has been generated and ${provider_id ? 'sent to the provider' : 'is ready to share'} for "${title}". This PIN expires in 10 minutes.`,
      { screen: 'VisitManagement', visit_id: id },
    );

    res.json({ success: true, pin, pin_expires_at: expiresAt.toISOString() });
  } catch (err) {
    console.error('Generate PIN error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits/:id/safety-pulse – renter confirms they are safe
app.post('/api/maintenance-visits/:id/safety-pulse', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token' });

    const visitResult = await pool.query(
      `SELECT mv.*, mr.renter_id, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.visit_id = $1`,
      [id]
    );
    if (visitResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const visit = visitResult.rows[0];

    if (visit.renter_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Only the renter can confirm safety.' });
    }

    if (visit.status !== 'in_progress') {
      return res.status(400).json({ success: false, error: 'Safety pulse is only required while work is in progress.' });
    }

    // Update pulse
    await pool.query(
      `UPDATE maintenance_visits
       SET last_safety_pulse = NOW(),
           missed_pulse_count = 0,
           safety_pulse_status = 'ok'
       WHERE visit_id = $1`,
      [id]
    );

    // Optional: reward renter with +1 trust point for prompt response (if they responded within 5 minutes of notification)
    // We'll implement that in the cron later.

    res.json({ success: true, message: 'Safety confirmed.' });
  } catch (err) {
    console.error('Safety pulse error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance-visits/:id/trigger-alert – emergency alert
// POST /api/maintenance-visits/:id/trigger-alert – manual emergency alert (renter)
app.post('/api/maintenance-visits/:id/trigger-alert', async (req, res) => {
  try {
    const { id } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token' });

    // Verify user is the renter for this visit
    const checkVisit = await pool.query(
      `SELECT mr.renter_id FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.visit_id = $1`,
      [id]
    );
    if (checkVisit.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    if (checkVisit.rows[0].renter_id !== user.id) {
      return res.status(403).json({ success: false, error: 'Only the renter can trigger an alert.' });
    }

    // Call the internal helper (manual = true)
    const result = await triggerAlertInternal(id, true);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error('Trigger alert endpoint error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// ==========================================
// CRON JOBS  - CHECK FOR MISSED CHECK-INS AND AUTO-CANCEL
// ==========================================
// POST /api/cron/check-missed-checkins – auto-cancel missed visits
app.post('/api/cron/check-missed-checkins', async (req, res) => {
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000);

    const missedVisits = await pool.query(
      `SELECT mv.*, sr.owner_id, sr.provider_id, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       WHERE mv.status = 'scheduled'
         AND mv.scheduled_start <= $1
         AND mv.check_in_time IS NULL`,
      [fourHoursAgo],
    );

    let processed = 0;
    for (const visit of missedVisits.rows) {
      // Auto-cancel the visit
      await pool.query(
        `UPDATE maintenance_visits SET status = 'cancelled' WHERE visit_id = $1`,
        [visit.visit_id],
      );

      // Reset the service request status
      await pool.query(
        `UPDATE service_requests SET status = 'pending', provider_id = NULL WHERE service_id = $1`,
        [visit.service_request_id],
      );

      // Notify owner
      await sendPushToUser(
        visit.owner_id,
        '❌ Provider Missed Visit',
        `The provider did not show up for "${visit.title}". The visit has been auto-cancelled. You can request service again.`,
        { screen: 'Maintenance' },
      );

      // Notify provider
      await sendPushToUser(
        visit.provider_id,
        '❌ You Missed a Visit',
        `You did not check in for "${visit.title}". The visit has been auto-cancelled. Please manage your schedule better.`,
        { screen: 'ProviderDashboard' },
      );

      processed++;
    }

    res.json({ success: true, processed });
  } catch (err) {
    console.error('Missed check-in cron error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// PUT /api/users/:userId/emergency-contact – Update Next of Kin / Emergency Contact
app.put('/api/users/:userId/emergency-contact', async (req, res) => {
  try {
    const { userId } = req.params;
    const { nok_full_name, nok_phone, nok_relationship, nok_address } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user || user.id !== userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized user action' });
    }

    await pool.query(
      `UPDATE users
       SET nok_full_name = $1,
           nok_phone = $2,
           nok_relationship = $3,
           nok_address = $4
       WHERE user_id = $5`,
      [nok_full_name || null, nok_phone || null, nok_relationship || null, nok_address || null, userId]
    );

    res.json({ success: true, message: 'Emergency Contact (Next of Kin) updated successfully.' });
  } catch (err) {
    console.error('Update emergency contact error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/safety-alerts – fetch all active safety alerts and missed pulses
app.get('/api/admin/safety-alerts', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token' });

    // Check admin status
    const adminCheck = await pool.query('SELECT is_admin FROM users WHERE user_id = $1', [user.id]);
    if (!adminCheck.rows[0]?.is_admin) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const query = `
      SELECT 
        mv.visit_id,
        mv.scheduled_start,
        mv.status as visit_status,
        mv.safety_pulse_status,
        mv.last_safety_pulse,
        mv.missed_pulse_count,
        mv.stage1_verified,
        mv.stage2_verified,
        mv.involves_renter,
        sr.service_id,
        sr.title as job_title,
        p.title as property_title,
        p.address_street,
        p.address_city,
        u_renter.user_id as renter_id,
        u_renter.name as renter_name,
        u_renter.phone_number as renter_phone,
        u_renter.renter_score,
        u_renter.nok_full_name,
        u_renter.nok_phone,
        u_renter.nok_relationship,
        u_renter.nok_address,
        u_owner.user_id as owner_id,
        u_owner.name as owner_name,
        u_owner.phone_number as owner_phone,
        u_provider.name as provider_name,
        u_provider.phone_number as provider_phone
      FROM maintenance_visits mv
      JOIN service_requests sr ON mv.service_request_id = sr.service_id
      LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
      JOIN properties p ON sr.property_id = p.property_id
      LEFT JOIN users u_renter ON COALESCE(mv.renter_id, mr.renter_id) = u_renter.user_id
      LEFT JOIN users u_owner ON sr.owner_id = u_owner.user_id
      LEFT JOIN users u_provider ON sr.provider_id = u_provider.user_id
      WHERE mv.safety_pulse_status IN ('alert', 'missed') OR mv.missed_pulse_count >= 2
      ORDER BY 
        CASE WHEN mv.safety_pulse_status = 'alert' THEN 1 ELSE 2 END,
        mv.last_safety_pulse ASC NULLS FIRST
    `;

    const result = await pool.query(query);
    res.json({ success: true, alerts: result.rows });
  } catch (err) {
    console.error('Fetch admin safety alerts error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/safety-alerts/:visitId/intervene – Admin intervention handler
app.post('/api/admin/safety-alerts/:visitId/intervene', async (req, res) => {
  try {
    const { visitId } = req.params;
    const { action, penaltyPoints } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token' });

    const adminCheck = await pool.query('SELECT is_admin FROM users WHERE user_id = $1', [user.id]);
    if (!adminCheck.rows[0]?.is_admin) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const visitRes = await pool.query(
      `SELECT mv.*, mr.renter_id, sr.owner_id, sr.title 
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.visit_id = $1`,
      [visitId]
    );
    if (visitRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const visit = visitRes.rows[0];

    if (action === 'resolve') {
      await pool.query(
        `UPDATE maintenance_visits
         SET safety_pulse_status = 'ok',
             missed_pulse_count = 0,
             last_safety_pulse = NOW()
         WHERE visit_id = $1`,
        [visitId]
      );
      if (visit.renter_id) {
        await sendPushToUser(
          visit.renter_id,
          '✅ Safety Alert Resolved',
          `Propadi Admin has reviewed and resolved the safety alert for "${visit.title}".`,
          { screen: 'Maintenance', visit_id: visitId }
        );
      }
    } else if (action === 'penalize' && visit.renter_id) {
      const pts = parseInt(penaltyPoints, 10) || 5;
      await pool.query(
        `UPDATE users SET renter_score = GREATEST(0, renter_score - $1) WHERE user_id = $2`,
        [pts, visit.renter_id]
      );
    } else if (action === 'dispatch') {
      if (visit.owner_id) {
        await sendPushToUser(
          visit.owner_id,
          '🚨 Security Dispatched',
          `Propadi Security / Emergency response has been dispatched for "${visit.title}".`,
          { screen: 'VisitManagement', visit_id: visitId }
        );
      }
    }

    res.json({ success: true, message: `Intervention '${action}' completed.` });
  } catch (err) {
    console.error('Admin intervention error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// CRON JOBS  - CHECK FOR SAFETY PULSES
// ==========================================
// POST /api/cron/check-safety-pulses – auto‑check on renter safety
// POST /api/cron/check-safety-pulses – auto‑check on renter safety (runs every 15 min)
app.post('/api/cron/check-safety-pulses', async (req, res) => {
  const secretKey = req.headers['x-cron-secret'];
  if (secretKey !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Find visits in 'in_progress' with no recent pulse or stale pulse
    const visits = await pool.query(
      `SELECT mv.visit_id, mv.service_request_id, mr.renter_id, mv.missed_pulse_count,
              mv.last_safety_pulse, sr.title
       FROM maintenance_visits mv
       JOIN service_requests sr ON mv.service_request_id = sr.service_id
       LEFT JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       WHERE mv.status = 'in_progress'
         AND (mv.last_safety_pulse IS NULL OR mv.last_safety_pulse < $1)
         AND mv.safety_pulse_status != 'alert'
         AND mv.renter_departure_confirmed = FALSE  -- not already completed
         AND mv.stage1_verified = TRUE              -- already passed Stage 1 & 2
         AND mv.stage2_verified = TRUE
         AND mv.renter_safety_confirmed = TRUE
      ORDER BY mv.last_safety_pulse ASC NULLS FIRST`,
      [thirtyMinutesAgo]
    );

    let processed = 0;
    for (const visit of visits.rows) {
      // Increment missed count
      const newCount = (visit.missed_pulse_count || 0) + 1;
      await pool.query(
        `UPDATE maintenance_visits
         SET missed_pulse_count = $1,
             safety_pulse_status = CASE WHEN $1 >= 3 THEN 'missed' ELSE 'ok' END
         WHERE visit_id = $2`,
        [newCount, visit.visit_id]
      );

      // Send push notification to renter
      if (visit.renter_id) {
        await sendPushToUser(
          visit.renter_id,
          '🔒 Safety Check‑in',
          `We haven't heard from you in a while. Tap 'I'm Safe' or 'Need Help'.`,
          { screen: 'Maintenance', visit_id: visit.visit_id, type: 'safety_pulse' }
        );
        // If missed count reaches 3, auto‑escalate
        if (newCount >= 3) {
          // Call the internal helper to trigger alert
          const alertResult = await triggerAlertInternal(visit.visit_id, false);
          if (alertResult.success) {
            // Also penalise renter's trust score for ignoring pulses
            await pool.query(
              `UPDATE users SET renter_score = renter_score - 3 WHERE user_id = $1`,
              [visit.renter_id]
            );
            // Notify owner again (the helper already did, but we can add a specific note)
            await sendPushToUser(
              visit.owner_id,
              '⚠️ Renter Unresponsive',
              `The renter has missed ${newCount} safety check‑ins. An alert has been escalated. Please follow up.`,
              { screen: 'VisitManagement', visit_id: visit.visit_id }
            );
          }
        }
      }
      processed++;
    }

    res.json({ success: true, processed });
  } catch (err) {
    console.error('Safety pulse cron error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// ==========================================
// PAYSTACK SUBACCOUNTS & SPLIT PAYMENTS API
// ==========================================

// 1. Fetch Nigerian Banks List
app.get('/api/paystack/banks', async (req, res) => {
  try {
    const paystackRes = await fetch('https://api.paystack.co/bank?country=nigeria', {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });
    const data = await paystackRes.json();
    if (data.status) {
      const banks = data.data.map((b) => ({
        name: b.name,
        code: b.code,
      }));
      return res.json({ success: true, banks });
    }
    return res.status(400).json({ success: false, error: 'Could not fetch banks from Paystack' });
  } catch (err) {
    console.error('Fetch banks error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Resolve NUBAN Bank Account
app.post('/api/paystack/resolve-bank', async (req, res) => {
  try {
    const { account_number, bank_code } = req.body;
    if (!account_number || !bank_code) {
      return res.status(400).json({ success: false, error: 'Account number and bank code are required' });
    }

    const url = `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`;
    const paystackRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });
    const data = await paystackRes.json();

    if (data.status) {
      return res.json({
        success: true,
        account_name: data.data.account_name,
        account_number: data.data.account_number,
        bank_code,
      });
    } else {
      return res.status(400).json({ success: false, error: data.message || 'Could not resolve bank account details' });
    }
  } catch (err) {
    console.error('Resolve bank error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Create Paystack Subaccount & Save Bank Details
app.post('/api/paystack/create-subaccount', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token' });

    const { bank_code, bank_name, account_number, account_name, role } = req.body;
    if (!bank_code || !bank_name || !account_number || !account_name) {
      return res.status(400).json({ success: false, error: 'Missing required bank details' });
    }

    // Call Paystack Subaccount API
    const paystackRes = await fetch('https://api.paystack.co/subaccount', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
      body: JSON.stringify({
        business_name: account_name,
        settlement_bank: bank_code,
        account_number,
        percentage_charge: 0, // Fee dynamically calculated at checkout
        description: `Propadi Subaccount for ${account_name}`,
      }),
    });

    const data = await paystackRes.json();
    if (!data.status) {
      return res.status(400).json({ success: false, error: data.message || 'Failed to create Paystack subaccount' });
    }

    const subaccountCode = data.data.subaccount_code;
    const purpose = role || 'general';

    // Ensure user_bank_accounts table exists
    await pool.query(
      `CREATE TABLE IF NOT EXISTS public.user_bank_accounts (
        account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
        account_purpose VARCHAR(50) NOT NULL,
        bank_name VARCHAR(100) NOT NULL,
        bank_code VARCHAR(20) NOT NULL,
        account_number VARCHAR(20) NOT NULL,
        account_name VARCHAR(255) NOT NULL,
        paystack_subaccount_code VARCHAR(100) NOT NULL,
        is_verified BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, account_purpose)
      );`
    );

    // Upsert into user_bank_accounts for the specific purpose tag
    await pool.query(
      `INSERT INTO user_bank_accounts (user_id, account_purpose, bank_name, bank_code, account_number, account_name, paystack_subaccount_code, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       ON CONFLICT (user_id, account_purpose)
       DO UPDATE SET bank_name = EXCLUDED.bank_name, bank_code = EXCLUDED.bank_code, account_number = EXCLUDED.account_number, account_name = EXCLUDED.account_name, paystack_subaccount_code = EXCLUDED.paystack_subaccount_code, is_verified = TRUE, created_at = CURRENT_TIMESTAMP`,
      [user.id, purpose, bank_name, bank_code, account_number, account_name, subaccountCode]
    );

    // Sync to respective legacy table columns for backward compatibility
    if (purpose === 'landlord' || purpose === 'owner') {
      await pool.query(
        `UPDATE users 
         SET bank_name = $1, bank_code = $2, account_number = $3, account_name = $4, 
             paystack_subaccount_code = $5, is_bank_verified = TRUE 
         WHERE user_id = $6`,
        [bank_name, bank_code, account_number, account_name, subaccountCode, user.id]
      );
    } else if (purpose === 'provider' || purpose === 'service_provider') {
      await pool.query(
        `UPDATE service_providers 
         SET bank_name = $1, bank_code = $2, account_number = $3, account_name = $4, 
             paystack_subaccount_code = $5 
         WHERE provider_id = $6`,
        [bank_name, bank_code, account_number, account_name, subaccountCode, user.id]
      );
    } else if (purpose === 'agency' || purpose === 'agent') {
      await pool.query(
        `ALTER TABLE agents 
         ADD COLUMN IF NOT EXISTS paystack_subaccount_code VARCHAR(100),
         ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
         ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
         ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
         ADD COLUMN IF NOT EXISTS account_name VARCHAR(255);`
      );

      await pool.query(
        `UPDATE agents 
         SET paystack_subaccount_code = $1, bank_name = $2, bank_code = $3, account_number = $4, account_name = $5 
         WHERE user_id = $6`,
        [subaccountCode, bank_name, bank_code, account_number, account_name, user.id]
      );
    } else {
      // General Payouts: Update users table if no landlord subaccount is present
      await pool.query(
        `UPDATE users 
         SET bank_name = COALESCE(bank_name, $1), bank_code = COALESCE(bank_code, $2), account_number = COALESCE(account_number, $3), account_name = COALESCE(account_name, $4), paystack_subaccount_code = COALESCE(paystack_subaccount_code, $5), is_bank_verified = TRUE 
         WHERE user_id = $6`,
        [bank_name, bank_code, account_number, account_name, subaccountCode, user.id]
      );
    }

    res.json({
      success: true,
      message: 'Bank account verified and Paystack subaccount linked successfully',
      subaccount_code: subaccountCode,
      account_name,
      bank_name,
      purpose,
    });
  } catch (err) {
    console.error('Create subaccount error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4a. Fetch All Purpose Subaccounts for User
app.get('/api/paystack/subaccounts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    await pool.query(
      `CREATE TABLE IF NOT EXISTS public.user_bank_accounts (
        account_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
        account_purpose VARCHAR(50) NOT NULL,
        bank_name VARCHAR(100) NOT NULL,
        bank_code VARCHAR(20) NOT NULL,
        account_number VARCHAR(20) NOT NULL,
        account_name VARCHAR(255) NOT NULL,
        paystack_subaccount_code VARCHAR(100) NOT NULL,
        is_verified BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, account_purpose)
      );`
    );

    const result = await pool.query(
      `SELECT account_id, account_purpose as purpose, bank_name, bank_code, account_number, account_name, paystack_subaccount_code as subaccount_code, is_verified, created_at
       FROM user_bank_accounts
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId]
    );

    res.json({ success: true, accounts: result.rows });
  } catch (err) {
    console.error('Fetch user subaccounts list error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b. Fetch Legacy Primary Subaccount Info for User
app.get('/api/paystack/subaccount/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userRes = await pool.query(
      `SELECT bank_name, bank_code, account_number, account_name, paystack_subaccount_code, is_bank_verified 
       FROM users WHERE user_id = $1`,
      [userId]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      subaccount: userRes.rows[0],
    });
  } catch (err) {
    console.error('Fetch subaccount error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4c. Delete / Unlink Purpose Payout Bank Account
app.delete('/api/paystack/subaccount/:userId/:purpose', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user || user.id !== req.params.userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { userId, purpose } = req.params;
    await pool.query(
      `DELETE FROM user_bank_accounts WHERE user_id = $1 AND account_purpose = $2`,
      [userId, purpose]
    );

    // Clear legacy table columns if purpose matches
    if (purpose === 'landlord' || purpose === 'owner') {
      await pool.query(
        `UPDATE users SET bank_name = NULL, bank_code = NULL, account_number = NULL, account_name = NULL, paystack_subaccount_code = NULL, is_bank_verified = FALSE WHERE user_id = $1`,
        [userId]
      );
    } else if (purpose === 'agency' || purpose === 'agent') {
      await pool.query(
        `UPDATE agents SET bank_name = NULL, bank_code = NULL, account_number = NULL, account_name = NULL, paystack_subaccount_code = NULL WHERE user_id = $1`,
        [userId]
      );
    } else if (purpose === 'service_provider' || purpose === 'provider') {
      await pool.query(
        `UPDATE service_providers SET bank_name = NULL, bank_code = NULL, account_number = NULL, account_name = NULL, paystack_subaccount_code = NULL WHERE provider_id = $1`,
        [userId]
      );
    }

    res.json({ success: true, message: 'Purpose payout account unlinked successfully.' });
  } catch (err) {
    console.error('Delete subaccount error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Initialize Paystack Multi-Split Payment (Owner, Agency, Propadi Platform)
app.post('/api/payments/initialize-split', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ success: false, error: 'Invalid token' });

    const { type, amount, base_rent, agency_fee, legal_fee, caution_deposit, service_charge, recipient_id, tenancy_id, service_id, property_id, title } = req.body;
    const baseRentAmount = parseFloat(base_rent || amount || 0);
    if (!type || baseRentAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Type and positive rent amount are required' });
    }

    // Ensure transactions table has Phase 3 columns
    await pool.query(
      `ALTER TABLE transactions
       ADD COLUMN IF NOT EXISTS owner_share_amount NUMERIC(12, 2),
       ADD COLUMN IF NOT EXISTS agency_share_amount NUMERIC(12, 2),
       ADD COLUMN IF NOT EXISTS propadi_fee_amount NUMERIC(12, 2),
       ADD COLUMN IF NOT EXISTS caution_deposit_amount NUMERIC(12, 2),
       ADD COLUMN IF NOT EXISTS owner_subaccount_code VARCHAR(100),
       ADD COLUMN IF NOT EXISTS agency_subaccount_code VARCHAR(100),
       ADD COLUMN IF NOT EXISTS paystack_split_code VARCHAR(100);`
    );

    let ownerSubaccountCode = null;
    let agencySubaccountCode = null;
    let agencyCommissionRate = 5.00;
    let ownerId = recipient_id;

    // Determine Property Owner & Appointed Agency Subaccounts
    if (property_id) {
      const propRes = await pool.query(
        `SELECT p.user_id as owner_id, u.paystack_subaccount_code as owner_subaccount,
                aa.agent_id, aa.commission_rate, ag.paystack_subaccount_code as agency_subaccount,
                u_agent.paystack_subaccount_code as user_agent_subaccount
         FROM properties p
         JOIN users u ON p.user_id = u.user_id
         LEFT JOIN agent_assignments aa ON p.property_id = aa.property_id AND aa.status IN ('active', 'accepted_pending_signature')
         LEFT JOIN agents ag ON aa.agent_id = ag.agent_id
         LEFT JOIN users u_agent ON ag.user_id = u_agent.user_id
         WHERE p.property_id = $1`,
        [property_id]
      );

      if (propRes.rows.length > 0) {
        const pRow = propRes.rows[0];
        ownerId = ownerId || pRow.owner_id;
        ownerSubaccountCode = pRow.owner_subaccount;
        if (pRow.agent_id) {
          agencySubaccountCode = pRow.agency_subaccount || pRow.user_agent_subaccount;
          agencyCommissionRate = parseFloat(pRow.commission_rate) || 5.00;
        }
      }
    }

    // Fallback Owner lookup if recipient_id provided without property_id
    if (!ownerSubaccountCode && ownerId) {
      const recipientRes = await pool.query(
        `SELECT paystack_subaccount_code FROM users WHERE user_id = $1`,
        [ownerId]
      );
      ownerSubaccountCode = recipientRes.rows[0]?.paystack_subaccount_code;

      if (!ownerSubaccountCode) {
        const spRes = await pool.query(
          `SELECT paystack_subaccount_code FROM service_providers WHERE provider_id = $1`,
          [ownerId]
        );
        ownerSubaccountCode = spRes.rows[0]?.paystack_subaccount_code;
      }
    }

    if (!ownerSubaccountCode) {
      return res.status(400).json({
        success: false,
        error: 'Property Owner / Recipient has not linked their verified bank payout account yet.',
      });
    }

    // Multi-Party Revenue Sharing Formula
    let grossAgencyFee = agency_fee ? parseFloat(agency_fee) : baseRentAmount * (agencyCommissionRate / 100);
    let grossLegalFee = legal_fee ? parseFloat(legal_fee) : baseRentAmount * 0.05;
    let cautionDepositFee = caution_deposit ? parseFloat(caution_deposit) : 0;
    let serviceChargeFee = service_charge ? parseFloat(service_charge) : 0;

    let propadiFromAgency = grossAgencyFee * 0.05; // 5% of Agency Fee
    let propadiFromLegal = grossLegalFee * 0.05; // 5% of Legal Fee
    let propadiFromOwner = baseRentAmount * 0.025; // 2.5% of Base Rent
    let totalPropadiPlatformFee = propadiFromAgency + propadiFromLegal + propadiFromOwner;

    let netAgencyShare = Math.max(0, grossAgencyFee - propadiFromAgency);
    let netLegalShare = Math.max(0, grossLegalFee - propadiFromLegal);
    let netOwnerShare = Math.max(0, (baseRentAmount - propadiFromOwner) + serviceChargeFee);

    let grossTenantCheckout = baseRentAmount + grossAgencyFee + grossLegalFee + cautionDepositFee + serviceChargeFee;

    const totalKobo = Math.round(grossTenantCheckout * 100);
    const ownerShareKobo = Math.round(netOwnerShare * 100);
    const agencyShareKobo = Math.round(netAgencyShare * 100);
    const propadiFeeKobo = Math.round(totalPropadiPlatformFee * 100);

    const reference = `PROPADI_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    let splitCode = null;

    // Create Paystack Multi-Split Payload with bearer_type: 'all' (enforcing shared Paystack charges)
    if (agencySubaccountCode && netAgencyShare > 0) {
      try {
        const splitRes = await fetch('https://api.paystack.co/split', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          },
          body: JSON.stringify({
            name: `Propadi Shared Multi-Split ${reference}`,
            type: 'flat',
            currency: 'NGN',
            subaccounts: [
              { subaccount: ownerSubaccountCode, share: ownerShareKobo },
              { subaccount: agencySubaccountCode, share: agencyShareKobo },
            ],
            bearer_type: 'all',
          }),
        });

        const splitData = await splitRes.json();
        if (splitData.status && splitData.data?.split_code) {
          splitCode = splitData.data.split_code;
        }
      } catch (splitErr) {
        console.error('Paystack split creation error:', splitErr);
      }
    }

    const paystackPayload = {
      email: user.email,
      amount: totalKobo,
      reference,
      metadata: {
        type,
        tenancy_id: tenancy_id || null,
        service_id: service_id || null,
        property_id: property_id || null,
        recipient_id: ownerId,
        payer_id: user.id,
        base_rent: baseRentAmount,
        gross_checkout: grossTenantCheckout,
        owner_share: netOwnerShare,
        agency_share: netAgencyShare,
        legal_share: netLegalShare,
        caution_deposit: cautionDepositFee,
        service_charge: serviceChargeFee,
        platform_commission: totalPropadiPlatformFee,
        owner_subaccount_code: ownerSubaccountCode,
        agency_subaccount_code: agencySubaccountCode || null,
      },
    };

    if (splitCode) {
      paystackPayload.split_code = splitCode;
    } else {
      paystackPayload.subaccount = ownerSubaccountCode;
      paystackPayload.transaction_charge = propadiFeeKobo;
      paystackPayload.bearer = 'all';
    }

    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
      body: JSON.stringify(paystackPayload),
    });

    const data = await paystackRes.json();
    if (!data.status) {
      return res.status(400).json({ success: false, error: data.message || 'Failed to initialize payment' });
    }

    // Insert pending transaction log with itemized multi-party shares
    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, title, amount, status, subaccount_code, platform_commission, 
        owner_share_amount, agency_share_amount, propadi_fee_amount, caution_deposit_amount,
        owner_subaccount_code, agency_subaccount_code, paystack_split_code, reference, property_ref, created_at)
       VALUES ($1, $2, $3, $4, 'Pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
      [
        user.id,
        type,
        title || `Payment for ${type}`,
        grossTenantCheckout,
        ownerSubaccountCode,
        totalPropadiPlatformFee,
        netOwnerShare,
        netAgencyShare,
        totalPropadiPlatformFee,
        cautionDepositFee,
        ownerSubaccountCode,
        agencySubaccountCode || null,
        splitCode || null,
        reference,
        property_id || null,
      ]
    );

    res.json({
      success: true,
      authorization_url: data.data.authorization_url,
      access_code: data.data.access_code,
      reference,
      breakdown: {
        base_rent: baseRentAmount,
        gross_agency_fee: grossAgencyFee,
        gross_legal_fee: grossLegalFee,
        caution_deposit: cautionDepositFee,
        service_charge: serviceChargeFee,
        total_tenant_checkout: grossTenantCheckout,
        net_owner_payout: netOwnerShare,
        net_agency_payout: netAgencyShare,
        net_legal_payout: netLegalShare,
        total_propadi_platform_fee: totalPropadiPlatformFee,
        propadi_deduction_breakdown: {
          from_agency: propadiFromAgency,
          from_legal: propadiFromLegal,
          from_owner: propadiFromOwner,
        },
        split_code: splitCode,
      },
    });
  } catch (err) {
    console.error('Initialize split payment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Paystack Webhook Handler
app.post('/api/paystack/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (secret) {
      const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
      if (hash !== signature) {
        return res.status(400).send('Invalid signature');
      }
    }

    const event = req.body;
    if (event.event === 'charge.success') {
      const { reference, metadata, amount } = event.data;
      const paidAmount = amount / 100;
      const paystackFee = (event.data.fees || 0) / 100;

      // Update Transaction status & itemized breakdown
      await pool.query(
        `UPDATE transactions 
         SET status = 'Completed', paystack_fee = $1,
             owner_share_amount = COALESCE($2, owner_share_amount),
             agency_share_amount = COALESCE($3, agency_share_amount),
             propadi_fee_amount = COALESCE($4, propadi_fee_amount)
         WHERE reference = $5 OR (user_id = $6 AND amount = $7 AND status = 'Pending')`,
        [
          paystackFee,
          metadata?.owner_share || null,
          metadata?.agency_share || null,
          metadata?.platform_commission || null,
          reference,
          metadata?.payer_id,
          paidAmount,
        ]
      );

      // Handle Rent Payment
      if (metadata?.type === 'rent' && metadata?.tenancy_id) {
        await pool.query(
          `UPDATE tenancies 
           SET status = 'Active', payment_status = 'Completed', payment_reference = $1 
           WHERE tenancy_id = $2`,
          [reference, metadata.tenancy_id]
        );

        // Push notification to Property Owner & Appointed Agency
        if (metadata?.recipient_id) {
          await sendPushToUser(
            metadata.recipient_id,
            '💰 Rent Received',
            `Rent payment of ₦${paidAmount.toLocaleString()} has been processed and routed via Paystack Multi-Split.`
          );
        }

        if (metadata?.agency_subaccount_code) {
          // Find Agency User ID to send Push Notification
          const agencyUserRes = await pool.query(
            `SELECT user_id FROM agents WHERE paystack_subaccount_code = $1 LIMIT 1`,
            [metadata.agency_subaccount_code]
          );
          if (agencyUserRes.rows.length > 0) {
            await sendPushToUser(
              agencyUserRes.rows[0].user_id,
              '🎉 Agency Commission Settled',
              `Your agency commission of ₦${parseFloat(metadata.agency_share || 0).toLocaleString()} has been credited to your linked business bank account!`
            );
          }
        }
      }

      // Handle Service Request Payment
      if (metadata?.type === 'service_request' && metadata?.service_id) {
        await pool.query(
          `UPDATE service_requests 
           SET price_status = 'funded', status = 'accepted' 
           WHERE service_id = $1`,
          [metadata.service_id]
        );
        if (metadata?.recipient_id) {
          await sendPushToUser(metadata.recipient_id, '🔧 Service Request Funded', `Service request has been funded. You may proceed with the job.`);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Paystack webhook error:', err);
    res.status(500).send('Webhook Error');
  }
});

// ==========================================
// PHASE 3.2: AGENT & AGENCY PORTAL API ENDPOINTS
// ==========================================

// 1. Register as Agent / Agency
app.post('/api/agents/register', async (req, res) => {
  try {
    const { userId, agencyName, cacNumber, licenseNumber, operatingState, commissionRate } = req.body;
    if (!userId || !agencyName) {
      return res.status(400).json({ success: false, error: 'User ID and Agency Name are required' });
    }

    // Check existing agent status to preserve approval on operational updates
    const existing = await pool.query(`SELECT * FROM agents WHERE user_id = $1`, [userId]);
    let nextStatus = 'pending';

    if (existing.rows.length > 0) {
      const prev = existing.rows[0];
      const cacChanged = (prev.cac_registration_number || '') !== (cacNumber || '');
      const licenseChanged = (prev.license_number || '') !== (licenseNumber || '');

      // If approved and core legal credentials didn't change, retain approval!
      if (prev.verification_status === 'approved' && !cacChanged && !licenseChanged) {
        nextStatus = 'approved';
      }
    }

    const result = await pool.query(
      `INSERT INTO agents (agent_id, user_id, agency_name, cac_registration_number, license_number, operating_state, commission_rate, verification_status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         agency_name = EXCLUDED.agency_name,
         cac_registration_number = EXCLUDED.cac_registration_number,
         license_number = EXCLUDED.license_number,
         operating_state = EXCLUDED.operating_state,
         commission_rate = EXCLUDED.commission_rate,
         verification_status = $7
       RETURNING *`,
      [userId, agencyName, cacNumber || null, licenseNumber || null, operatingState || 'Lagos', commissionRate || 5.00, nextStatus]
    );

    const isUpdatedWithoutStatusReset = nextStatus === 'approved';
    res.json({
      success: true,
      agent: result.rows[0],
      message: isUpdatedWithoutStatusReset
        ? 'Agency settings updated successfully.'
        : 'Agent registration submitted for admin approval.',
    });
  } catch (err) {
    console.error('Register agent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Get Agent profile by User ID
app.get('/api/agents/me/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT a.*, u.name as user_name, u.email as user_email, u.phone_number
       FROM agents a
       JOIN users u ON a.user_id = u.user_id
       WHERE a.user_id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.json({ success: true, agent: null });
    }
    res.json({ success: true, agent: result.rows[0] });
  } catch (err) {
    console.error('Fetch agent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. List verified agents for Property Owners
app.get('/api/agents/list', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.name as user_name, u.email as user_email, u.phone_number, u.profile_picture_url
       FROM agents a
       JOIN users u ON a.user_id = u.user_id
       WHERE a.verification_status = 'approved'
       ORDER BY a.agency_name ASC`
    );
    res.json({ success: true, agents: result.rows });
  } catch (err) {
    console.error('Fetch agents list error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Assign property to a Tier-4 verified agent (Post-Admin Audit)
app.post('/api/agents/assign-property', async (req, res) => {
  try {
    const { agentId, propertyId, ownerId, commissionOverride } = req.body;
    if (!agentId || !propertyId || !ownerId) {
      return res.status(400).json({ success: false, error: 'Agent ID, Property ID, and Owner ID are required' });
    }

    // Tier 4 & Admin Verification Check
    const agentCheck = await pool.query(
      `SELECT a.*, u.kyc_tier, u.kyc_status, u.is_agent, u.is_service_provider
       FROM agents a
       JOIN users u ON a.user_id = u.user_id
       WHERE a.agent_id = $1`,
      [agentId]
    );

    if (agentCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Selected agent profile not found.' });
    }

    const agentData = agentCheck.rows[0];
    if (agentData.verification_status !== 'approved') {
      return res.status(400).json({ success: false, error: 'Selected agent is not approved by Admin oversight.' });
    }

    if ((agentData.kyc_tier || 1) < 4 && agentData.kyc_status !== 'Approved') {
      return res.status(400).json({ success: false, error: 'System Gate Failure: Agent must be Tier 4 Verified to manage viewing delegations.' });
    }

    const commValue = commissionOverride ? parseFloat(commissionOverride) : 5.00;
    const result = await pool.query(
      `INSERT INTO agent_assignments (agent_id, property_id, owner_id, commission_override, commission_rate, status, assigned_at)
       VALUES ($1, $2, $3, $4, $4, 'pending_acceptance', CURRENT_TIMESTAMP)
       ON CONFLICT (agent_id, property_id)
       DO UPDATE SET status = 'pending_acceptance', commission_override = EXCLUDED.commission_override, commission_rate = EXCLUDED.commission_rate, assigned_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [agentId, propertyId, ownerId, commValue]
    );

    // Update Property Status
    await pool.query(
      `UPDATE properties SET status = 'agent_delegated_pending_acceptance' WHERE property_id = $1`,
      [propertyId]
    );

    // Send Push Notification to Agent
    await sendPushToUser(
      agentData.user_id,
      '🏢 Property Viewing Delegation Offer',
      'A property owner has selected you to represent their property. Tap to review limited details and accept/decline.',
      { screen: 'AgentPropertyPreview', assignmentId: result.rows[0].assignment_id, propertyId }
    );

    res.json({ success: true, assignment: result.rows[0] });
  } catch (err) {
    console.error('Assign property error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b. Agent Limited Detail Preview (Street address masked prior to acceptance)
app.get('/api/agents/assignment-preview/:assignmentId', async (req, res) => {
  try {
    const { assignmentId } = req.params;

    // Ensure agents table has required paystack subaccount columns
    await pool.query(
      `ALTER TABLE agents 
       ADD COLUMN IF NOT EXISTS paystack_subaccount_code VARCHAR(100),
       ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
       ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
       ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
       ADD COLUMN IF NOT EXISTS account_name VARCHAR(255);`
    );

    const result = await pool.query(
      `SELECT aa.*,
              p.title as property_title,
              p.category,
              p.sector_tag,
              p.rent_price,
              p.rent_period,
              p.agency_fee_percent,
              p.main_image_url,
              p.gallery_urls,
              p.address_city,
              p.address_lga,
              p.address_state,
              p.landmark_name,
              p.total_beds,
              p.total_baths,
              p.total_units,
              p.finishing_state,
              p.brand_name,
              p.proof_of_ownership_type,
              p.proof_of_ownership_url,
              p.proof_of_ownership_docs,
              p.video_url,
              p.has_video,
              p.service_charge,
              p.caution_fee,
              p.legal_fee_percent,
              p.early_bird_discount_percent,
              p.is_caution_waived,
              '[Masked until agreement signed]' as address_street,
              u.name as owner_name,
              u.email as owner_email,
              (COALESCE(ag.paystack_subaccount_code, u_agent.paystack_subaccount_code) IS NOT NULL AND COALESCE(ag.paystack_subaccount_code, u_agent.paystack_subaccount_code) != '') as agent_has_business_bank
       FROM agent_assignments aa
       JOIN properties p ON aa.property_id = p.property_id
       JOIN users u ON aa.owner_id = u.user_id
       LEFT JOIN agents ag ON aa.agent_id = ag.agent_id
       LEFT JOIN users u_agent ON ag.user_id = u_agent.user_id
       WHERE aa.assignment_id = $1`,
      [assignmentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Assignment record not found.' });
    }

    res.json({ success: true, preview: result.rows[0] });
  } catch (err) {
    console.error('Fetch assignment preview error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4c. Agent Respond to Delegation (Accept or Decline)
app.post('/api/agents/respond-assignment', async (req, res) => {
  try {
    const { assignmentId, response, declineReason } = req.body;
    if (!assignmentId || !response) {
      return res.status(400).json({ success: false, error: 'Assignment ID and response (accept/decline) are required.' });
    }

    await pool.query(
      `ALTER TABLE agents 
       ADD COLUMN IF NOT EXISTS paystack_subaccount_code VARCHAR(100),
       ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
       ADD COLUMN IF NOT EXISTS bank_code VARCHAR(20),
       ADD COLUMN IF NOT EXISTS account_number VARCHAR(20),
       ADD COLUMN IF NOT EXISTS account_name VARCHAR(255);
       
       ALTER TABLE agent_assignments ALTER COLUMN status TYPE VARCHAR(50);`
    );

    const currentAss = await pool.query(
      `SELECT aa.*, ag.user_id as agent_user_id,
              COALESCE(ag.paystack_subaccount_code, u_agent.paystack_subaccount_code) as subaccount_code
       FROM agent_assignments aa
       JOIN agents ag ON aa.agent_id = ag.agent_id
       JOIN users u_agent ON ag.user_id = u_agent.user_id
       WHERE aa.assignment_id = $1`,
      [assignmentId]
    );
    if (currentAss.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Assignment not found.' });
    }
    const assignment = currentAss.rows[0];

    if (response === 'accept') {
      // Require agency business payout bank account before accepting delegation
      if (!assignment.subaccount_code || assignment.subaccount_code.trim() === '') {
        return res.status(400).json({
          success: false,
          requires_bank_setup: true,
          error: 'Business Payout Account Required: Please link your Agency Corporate Bank Account before accepting property delegations.',
        });
      }

      const updated = await pool.query(
        `UPDATE agent_assignments
         SET status = 'accepted_pending_signature', accepted_at = CURRENT_TIMESTAMP
         WHERE assignment_id = $1 RETURNING *`,
        [assignmentId]
      );

      // Notify Owner
      await sendPushToUser(
        assignment.owner_id,
        '🤝 Agent Accepted Delegation!',
        'The selected Propadi Agent accepted your viewing delegation. Please proceed to digitally sign the agency contract.',
        { screen: 'DigitalContractSign', assignmentId }
      );

      res.json({ success: true, assignment: updated.rows[0], message: 'Delegation accepted. Proceeding to digital contract signing.' });
    } else {
      const updated = await pool.query(
        `UPDATE agent_assignments
         SET status = 'declined', declined_at = CURRENT_TIMESTAMP, decline_reason = $1
         WHERE assignment_id = $2 RETURNING *`,
        [declineReason || 'Agent unavailable', assignmentId]
      );

      // Revert Property status to approved_pending_agent
      await pool.query(
        `UPDATE properties SET status = 'approved_pending_agent' WHERE property_id = $1`,
        [assignment.property_id]
      );

      // Notify Owner
      await sendPushToUser(
        assignment.owner_id,
        'ℹ️ Agent Delegation Update',
        `The selected agent declined the offer: ${declineReason || 'Agent unavailable'}. You can now select another verified agent.`,
        { screen: 'SelectPropadiAgent', propertyId: assignment.property_id }
      );

      res.json({ success: true, assignment: updated.rows[0], message: 'Delegation declined.' });
    }
  } catch (err) {
    console.error('Respond assignment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4d. Digital Agreement Signing (Owner & Agent Co-signing)
app.post('/api/agreements/sign-owner-agent-contract', async (req, res) => {
  try {
    const { assignmentId, signerRole, signerId } = req.body;
    if (!assignmentId || !signerRole || !signerId) {
      return res.status(400).json({ success: false, error: 'Assignment ID, signerRole (owner/agent), and signerId are required.' });
    }

    const currentAss = await pool.query(`SELECT * FROM agent_assignments WHERE assignment_id = $1`, [assignmentId]);
    if (currentAss.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Assignment record not found.' });
    }

    let updateQuery = '';
    if (signerRole === 'owner') {
      updateQuery = `UPDATE agent_assignments SET owner_signed_at = CURRENT_TIMESTAMP WHERE assignment_id = $1 RETURNING *`;
    } else {
      updateQuery = `UPDATE agent_assignments SET agent_signed_at = CURRENT_TIMESTAMP WHERE assignment_id = $1 RETURNING *`;
    }

    const updatedRes = await pool.query(updateQuery, [assignmentId]);
    const updated = updatedRes.rows[0];

    // Check if BOTH owner and agent have signed
    if (updated.owner_signed_at && updated.agent_signed_at) {
      // Activate assignment & publish property!
      await pool.query(`UPDATE agent_assignments SET status = 'active' WHERE assignment_id = $1`, [assignmentId]);
      await pool.query(`UPDATE properties SET status = 'Available' WHERE property_id = $1`, [updated.property_id]);

      // Notify Owner & Agent
      await sendPushToUser(
        updated.owner_id,
        '🎉 Contract Signed & Property Published!',
        'Both parties have signed the representation contract. Your listing is now public!',
        { screen: 'PropertyDetails', propertyId: updated.property_id }
      );

      const agentRes = await pool.query(`SELECT user_id FROM agents WHERE agent_id = $1`, [updated.agent_id]);
      if (agentRes.rows.length > 0) {
        await sendPushToUser(
          agentRes.rows[0].user_id,
          '🎉 Contract Fully Executed!',
          'You are now officially authorized to represent and conduct viewings for this property.',
          { screen: 'AgentDashboard' }
        );
      }
    }

    res.json({
      success: true,
      assignment: updated,
      isFullySigned: !!(updated.owner_signed_at && updated.agent_signed_at),
    });
  } catch (err) {
    console.error('Sign owner-agent contract error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Get assignments for Owner
app.get('/api/agents/assignments/owner/:ownerId', async (req, res) => {
  try {
    const { ownerId } = req.params;
    const result = await pool.query(
      `SELECT aa.*, 
              a.agency_name, 
              a.cac_registration_number, 
              a.license_number, 
              a.operating_state, 
              a.verification_status as agency_verification_status, 
              a.commission_rate as default_commission, 
              u.name as agent_user_name, 
              u.email as agent_email, 
              u.phone_number as agent_phone, 
              p.title as property_title, 
              p.category as property_category, 
              p.total_units as property_units, 
              p.address_city, 
              p.address_state, 
              p.rent_price, 
              p.main_image_url
       FROM agent_assignments aa
       JOIN agents a ON aa.agent_id = a.agent_id
       JOIN users u ON a.user_id = u.user_id
       JOIN properties p ON aa.property_id = p.property_id
       WHERE aa.owner_id = $1
       ORDER BY aa.assigned_at DESC`,
      [ownerId]
    );
    res.json({ success: true, assignments: result.rows });
  } catch (err) {
    console.error('Fetch owner assignments error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5b. Admin Oversight: List all property agency delegations
app.get('/api/admin/assignments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT aa.*,
              a.agency_name,
              a.cac_registration_number,
              a.license_number,
              a.operating_state,
              u_agent.name as agent_user_name,
              u_agent.email as agent_email,
              u_agent.phone_number as agent_phone,
              u_owner.name as owner_name,
              u_owner.email as owner_email,
              p.title as property_title,
              p.category as property_category,
              p.total_units as property_units,
              p.rent_price,
              p.address_city,
              p.address_state
       FROM agent_assignments aa
       JOIN agents a ON aa.agent_id = a.agent_id
       JOIN users u_agent ON a.user_id = u_agent.user_id
       JOIN users u_owner ON aa.owner_id = u_owner.user_id
       JOIN properties p ON aa.property_id = p.property_id
       ORDER BY aa.assigned_at DESC`
    );
    res.json({ success: true, assignments: result.rows });
  } catch (err) {
    console.error('Fetch admin assignments error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5c. Admin Oversight: Force revoke agency delegation
app.post('/api/admin/assignments/:assignmentId/revoke', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { reason } = req.body;

    const result = await pool.query(
      `UPDATE agent_assignments
       SET status = 'revoked', decline_reason = $1
       WHERE assignment_id = $2
       RETURNING *`,
      [reason || 'Revoked by System Admin', assignmentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Assignment not found' });
    }

    // Revert property status to audited_ready_for_listing
    await pool.query(
      `UPDATE properties SET status = 'audited_ready_for_listing' WHERE property_id = $1`,
      [result.rows[0].property_id]
    );

    res.json({ success: true, assignment: result.rows[0] });
  } catch (err) {
    console.error('Admin revoke assignment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5d. Owner Revoke Agency Delegation
app.post('/api/agents/assignments/:assignmentId/revoke', async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { reason } = req.body;

    const result = await pool.query(
      `UPDATE agent_assignments
       SET status = 'revoked', decline_reason = $1
       WHERE assignment_id = $2
       RETURNING *`,
      [reason || 'Revoked by Property Owner', assignmentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Assignment not found' });
    }

    // Revert property status to audited_ready_for_listing
    await pool.query(
      `UPDATE properties SET status = 'audited_ready_for_listing' WHERE property_id = $1`,
      [result.rows[0].property_id]
    );

    res.json({ success: true, assignment: result.rows[0] });
  } catch (err) {
    console.error('Owner revoke assignment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Get assignments for Agent
app.get('/api/agents/assignments/agent/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const result = await pool.query(
      `SELECT aa.*, p.title as property_title, p.address_city, p.address_state, p.rent_price, p.main_image_url, p.category, p.status as property_status, u.name as owner_name, u.phone_number as owner_phone
       FROM agent_assignments aa
       JOIN properties p ON aa.property_id = p.property_id
       JOIN users u ON aa.owner_id = u.user_id
       WHERE aa.agent_id = $1
       ORDER BY aa.assigned_at DESC`,
      [agentId]
    );
    res.json({ success: true, assignments: result.rows });
  } catch (err) {
    console.error('Fetch agent assignments error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6b. Get Tenant Applications for Delegated Agent Properties
app.get('/api/agents/applications/agent/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const result = await pool.query(
      `SELECT app.*, 
              p.title as property_title, 
              p.address_city, 
              p.address_state, 
              p.rent_price, 
              p.main_image_url,
              u.name as applicant_name,
              u.email as applicant_email,
              u.phone_number as applicant_phone
       FROM rental_applications app
       JOIN properties p ON app.property_id = p.property_id
       JOIN agent_assignments aa ON p.property_id = aa.property_id
       JOIN users u ON app.applicant_id = u.user_id
       WHERE aa.agent_id = $1 AND aa.status = 'active'
       ORDER BY app.created_at DESC`,
      [agentId]
    );
    res.json({ success: true, applications: result.rows });
  } catch (err) {
    console.error('Fetch agent tenant applications error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Update assignment status (accept/revoke)
app.post('/api/agents/assignments/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const result = await pool.query(
      `UPDATE agent_assignments SET status = $1 WHERE assignment_id = $2 RETURNING *`,
      [status, id]
    );
    res.json({ success: true, assignment: result.rows[0] });
  } catch (err) {
    console.error('Update assignment status error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Admin: Get all agents (pending, approved, rejected)
app.get('/api/admin/agents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, u.name as user_name, u.email as user_email, u.phone_number
       FROM agents a
       JOIN users u ON a.user_id = u.user_id
       ORDER BY a.created_at DESC`
    );
    res.json({ success: true, agents: result.rows });
  } catch (err) {
    console.error('Admin fetch agents error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Admin: Approve or Reject Agent Verification
app.post('/api/admin/agents/:agentId/verify', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { status, rejectionReason } = req.body;

    const agentRes = await pool.query(
      `UPDATE agents 
       SET verification_status = $1, rejection_reason = $2 
       WHERE agent_id = $3 
       RETURNING *`,
      [status, rejectionReason || null, agentId]
    );

    if (agentRes.rows.length > 0) {
      const agent = agentRes.rows[0];
      if (status === 'approved') {
        await pool.query(`UPDATE users SET role = 'agent' WHERE user_id = $1`, [agent.user_id]);
        await sendPushToUser(agent.user_id, '🎉 Agency Approved!', 'Your real estate agency account has been verified. You can now access your Agent Dashboard and manage property portfolios.');
      } else if (status === 'rejected') {
        await sendPushToUser(agent.user_id, 'Agency Verification Update', `Your real estate agency verification was rejected.${rejectionReason ? ` Reason: ${rejectionReason}` : ''}`);
      }
    }

    res.json({ success: true, agent: agentRes.rows[0] });
  } catch (err) {
    console.error('Admin verify agent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// PHASE 3.3: ANALYTICS, RECURRING RENT AUTOPAY & PROVIDER CALENDAR
// ==========================================

// 1. Track Property Detail View
app.post('/api/properties/:id/track-view', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    await pool.query(
      `INSERT INTO property_views (property_id, viewer_user_id) VALUES ($1, $2)`,
      [id, userId || null]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Track view error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Property Owner Portfolio Analytics
app.get('/api/analytics/owner/:ownerId', async (req, res) => {
  try {
    const { ownerId } = req.params;

    // Total Properties Listed & Active
    const propsRes = await pool.query(
      `SELECT COUNT(*) as total_properties, 
              COUNT(CASE WHEN status = 'Available' THEN 1 END) as available_properties,
              COUNT(CASE WHEN status = 'Rented' THEN 1 END) as rented_properties
       FROM properties WHERE owner_id = $1`,
      [ownerId]
    );

    // Total Views Across Owner Properties
    const viewsRes = await pool.query(
      `SELECT COUNT(pv.view_id) as total_views
       FROM property_views pv
       JOIN properties p ON pv.property_id = p.property_id
       WHERE p.owner_id = $1`,
      [ownerId]
    );

    // Total Applications Received
    const appsRes = await pool.query(
      `SELECT COUNT(ra.application_id) as total_applications
       FROM rental_applications ra
       JOIN properties p ON ra.property_id = p.property_id
       WHERE p.owner_id = $1`,
      [ownerId]
    );

    // Total Annual Revenue
    const revRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total_revenue
       FROM transactions
       WHERE user_id = $1 AND status = 'Completed'`,
      [ownerId]
    );

    const totalProps = parseInt(propsRes.rows[0].total_properties, 10) || 0;
    const totalViews = parseInt(viewsRes.rows[0].total_views, 10) || 0;
    const totalApps = parseInt(appsRes.rows[0].total_applications, 10) || 0;
    const conversionRate = totalViews > 0 ? ((totalApps / totalViews) * 100).toFixed(1) : '0.0';

    res.json({
      success: true,
      analytics: {
        totalProperties: totalProps,
        availableProperties: parseInt(propsRes.rows[0].available_properties, 10) || 0,
        rentedProperties: parseInt(propsRes.rows[0].rented_properties, 10) || 0,
        totalViews,
        totalApplications: totalApps,
        conversionRate: parseFloat(conversionRate),
        totalRevenue: parseFloat(revRes.rows[0].total_revenue || 0),
      },
    });
  } catch (err) {
    console.error('Fetch owner analytics error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Service Provider Analytics
app.get('/api/analytics/provider/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;

    // Completed & Active Service Requests
    const jobsRes = await pool.query(
      `SELECT 
         COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_jobs,
         COUNT(CASE WHEN status IN ('accepted', 'in_progress', 'negotiating') THEN 1 END) as active_jobs
       FROM service_requests
       WHERE provider_id = $1`,
      [providerId]
    );

    // Total Earnings
    const earningsRes = await pool.query(
      `SELECT COALESCE(SUM(estimated_cost), 0) as total_earnings
       FROM service_requests
       WHERE provider_id = $1 AND status = 'completed'`,
      [providerId]
    );

    // Provider Rating
    const providerRes = await pool.query(
      `SELECT avg_rating, total_reviews FROM service_providers WHERE provider_id = $1`,
      [providerId]
    );

    const providerInfo = providerRes.rows[0] || {};

    res.json({
      success: true,
      analytics: {
        completedJobs: parseInt(jobsRes.rows[0].completed_jobs, 10) || 0,
        activeJobs: parseInt(jobsRes.rows[0].active_jobs, 10) || 0,
        totalEarnings: parseFloat(earningsRes.rows[0].total_earnings || 0),
        rating: parseFloat(providerInfo.avg_rating || 5.0),
        totalReviews: parseInt(providerInfo.total_reviews, 10) || 0,
      },
    });
  } catch (err) {
    console.error('Fetch provider analytics error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Rent Auto-Pay: Initialize Recurring Subscription
app.post('/api/subscriptions/initialize-autopay', async (req, res) => {
  try {
    const { tenancyId, userId, amount, interval } = req.body;
    if (!tenancyId || !userId || !amount) {
      return res.status(400).json({ success: false, error: 'Tenancy ID, User ID, and Amount are required' });
    }

    const result = await pool.query(
      `INSERT INTO rent_subscriptions (tenancy_id, user_id, amount, interval, status, next_payment_date)
       VALUES ($1, $2, $3, $4, 'active', CURRENT_TIMESTAMP + INTERVAL '1 year')
       RETURNING *`,
      [tenancyId, userId, amount, interval || 'annually']
    );

    res.json({ success: true, subscription: result.rows[0], message: 'Recurring rent auto-pay initialized.' });
  } catch (err) {
    console.error('Initialize autopay error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Get User Rent Auto-Pay Subscriptions
app.get('/api/subscriptions/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT rs.*, p.title as property_title, p.main_image_url
       FROM rent_subscriptions rs
       JOIN tenancies t ON rs.tenancy_id = t.tenancy_id
       JOIN properties p ON t.property_id = p.property_id
       WHERE rs.user_id = $1 AND rs.status = 'active'`,
      [userId]
    );
    res.json({ success: true, subscriptions: result.rows });
  } catch (err) {
    console.error('Fetch user subscriptions error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Cancel or Pause Rent Auto-Pay
app.post('/api/subscriptions/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE rent_subscriptions SET status = 'cancelled' WHERE subscription_id = $1 RETURNING *`,
      [id]
    );
    res.json({ success: true, subscription: result.rows[0] });
  } catch (err) {
    console.error('Cancel subscription error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Provider Availability Calendar: Get Events
app.get('/api/provider/calendar/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    const eventsRes = await pool.query(
      `SELECT * FROM provider_calendar_events WHERE provider_id = $1 ORDER BY start_time ASC`,
      [providerId]
    );
    res.json({ success: true, events: eventsRes.rows });
  } catch (err) {
    console.error('Fetch provider calendar error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Provider Availability Calendar: Add Blackout Date
app.post('/api/provider/calendar/blackout', async (req, res) => {
  try {
    const { providerId, title, startTime, endTime, notes } = req.body;
    if (!providerId || !startTime || !endTime) {
      return res.status(400).json({ success: false, error: 'Provider ID, Start Time, and End Time are required' });
    }

    const result = await pool.query(
      `INSERT INTO provider_calendar_events (provider_id, event_type, title, start_time, end_time, notes)
       VALUES ($1, 'blackout', $2, $3, $4, $5)
       RETURNING *`,
      [providerId, title || 'Blackout Date', startTime, endTime, notes || null]
    );

    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    console.error('Add blackout date error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
