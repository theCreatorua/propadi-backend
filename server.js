require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Initialize Supabase for Storage uploads
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

// ==========================================
// AUTHENTICATION & USER ROUTES
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  const { user_id, email, name } = req.body;

  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [
      email,
    ]);
    if (userCheck.rows.length > 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Email is already registered' });
    }

    const newUser = await pool.query(
      'INSERT INTO users (user_id, email, name) VALUES ($1, $2, $3) RETURNING user_id, email, name',
      [user_id, email, name],
    );

    // Initialize an empty wallet for EVERY user upon registration
    await pool.query(
      'INSERT INTO wallets (user_id, balance, total_earned, pending_clearance) VALUES ($1, 0, 0, 0)',
      [user_id],
    );

    res.json({
      success: true,
      message: 'Welcome to Propadi!',
      user: newUser.rows[0],
    });
  } catch (err) {
    console.error('Sign Up Error:', err);
    res.status(500).json({ success: false, error: 'Failed to create profile' });
  }
});

app.get('/api/user/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT u.email, COALESCE(w.balance, 0) as balance 
       FROM users u LEFT JOIN wallets w ON u.user_id = w.user_id 
       WHERE u.user_id = $1`,
      [userId],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
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
      `SELECT kyc_tier, phone_verified, nin_verified, address_verified, renter_score 
       FROM users WHERE user_id = $1`,
      [id],
    );
    if (result.rows.length > 0) {
      res.json({ success: true, trust_data: result.rows[0] });
    } else {
      res.status(404).json({ success: false, error: 'User not found' });
    }
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
    const result = await pool.query(
      `SELECT * FROM properties WHERE status = 'Available' ORDER BY date_listed DESC;`,
    );
    res.json({ success: true, properties: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load the feed' });
  }
});

app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const propResult = await pool.query(
      `SELECT * FROM properties WHERE property_id = $1;`,
      [id],
    );
    if (propResult.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Property not found' });

    const property = propResult.rows[0];
    const amenitiesResult = await pool.query(
      `SELECT * FROM properties_amenities WHERE property_id = $1;`,
      [id],
    );
    property.visually_verified_amenities = amenitiesResult.rows;

    res.json({ success: true, property });
  } catch (err) {
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
      furnishing_status,
      title,
      description,
      rent_price,
      rent_period,
      total_beds,
      total_baths,
      address_street,
      address_city,
      address_lga,
      address_state,
      main_image_url,
      total_kitchens,
      total_stores,
      visually_verified_amenities,
    } = req.body;

    const propResult = await client.query(
      `
      INSERT INTO properties (
        owner_id, status, category, furnishing_status, title, description, rent_price, rent_period, total_beds, total_baths, 
        address_street, address_city, address_lga, address_state, main_image_url, gallery_urls, total_kitchens, total_stores
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, ARRAY[]::text[], $16, $17) RETURNING *;
    `,
      [
        owner_id,
        status || 'Available',
        category,
        furnishing_status,
        title,
        description,
        rent_price,
        rent_period || 'Year',
        total_beds || 0,
        total_baths || 0,
        address_street,
        address_city,
        address_lga,
        address_state,
        main_image_url,
        total_kitchens || 0,
        total_stores || 0,
      ],
    );
    const savedProperty = propResult.rows[0];

    if (visually_verified_amenities && visually_verified_amenities.length > 0) {
      for (const amenity of visually_verified_amenities) {
        await client.query(
          `INSERT INTO properties_amenities (property_id, amenity_name, verification_url, media_type) VALUES ($1, $2, $3, $4)`,
          [
            savedProperty.property_id,
            amenity.amenity_name,
            amenity.verification_url,
            amenity.media_type,
          ],
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, property: savedProperty });
  } catch (err) {
    await client.query('ROLLBACK');
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
    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
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
        m.id, m.property_id, m.content as last_message, m.created_at, m.sender_id, m.receiver_id, p.title as property_title, p.main_image_url
      FROM messages m JOIN properties p ON m.property_id = p.property_id
      WHERE m.sender_id = $1 OR m.receiver_id = $1
      ORDER BY m.property_id, CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END, m.created_at DESC;
    `;
    const result = await pool.query(query, [userId]);
    const sortedConversations = result.rows.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );
    res.json({ success: true, conversations: sortedConversations });
  } catch (err) {
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
      `INSERT INTO viewings (property_id, renter_id, owner_id, scheduled_start_time, scheduled_end_time, status) VALUES ($1, $2, $3, $4, $5, 'Pending') RETURNING *`,
      [
        property_id,
        renter_id,
        landlord_id,
        startTime.toISOString(),
        endTime.toISOString(),
      ],
    );

    await pool.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1, $2, $3, $4)`,
      [
        property_id,
        renter_id,
        landlord_id,
        `🗓️ I have requested a viewing for ${startTime.toLocaleString()}. Please accept or decline.||${result.rows[0].viewing_id}`,
      ],
    );
    res.json({ success: true, viewing: result.rows[0] });
  } catch (err) {
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

    if (status === 'Accepted') {
      const securePin = crypto.randomInt(100000, 999999).toString();
      const expiryTime = new Date();
      expiryTime.setMinutes(expiryTime.getMinutes() + 5);

      await pool.query(
        `UPDATE viewings SET status = $1, secure_handshake_pin = $2, pin_expiry = $3 WHERE viewing_id = $4`,
        [status, securePin, expiryTime.toISOString(), id],
      );
      if (v) {
        await pool.query(
          `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1, $2, $3, $4)`,
          [
            v.property_id,
            v.owner_id,
            v.renter_id,
            `⏳ **Viewing In Progress:** Both parties have agreed. Awaiting physical Secure Handshake.`,
          ],
        );
      }
    } else {
      await pool.query(
        `UPDATE viewings SET status = $1 WHERE viewing_id = $2`,
        [status, id],
      );
    }
    res.json({ success: true });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to update viewing status' });
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
      `INSERT INTO applications (property_id, renter_id, owner_id, proposed_rent, cover_letter, move_in_date, is_sight_unseen) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
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
    res.json({ success: true, application: result.rows[0] });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to submit application' });
  }
});

// --- RESTORED: GET Landlord's Applications ---
app.get('/api/applications/owner/:owner_id', async (req, res) => {
  try {
    const { owner_id } = req.params;
    const result = await pool.query(
      `SELECT 
         a.application_id, a.property_id, a.proposed_rent, a.cover_letter, a.status, a.date_applied, a.is_sight_unseen,
         u.user_id as renter_id, u.name, u.profile_picture_url, u.role, u.renter_score, u.kyc_status, u.occupation, u.email,
         p.title as property_title
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

// --- RESTORED: GET Renter's Applications ---
app.get('/api/applications/renter/:renter_id', async (req, res) => {
  try {
    const { renter_id } = req.params;
    const result = await pool.query(
      `SELECT 
         a.application_id, a.property_id, a.proposed_rent, a.status, a.date_applied,
         p.title as property_title, p.address_street, p.address_city,
         t.tenancy_id
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

app.put('/api/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const appResult = await pool.query(
      `UPDATE applications SET status = $1, date_status_updated = CURRENT_TIMESTAMP WHERE application_id = $2 RETURNING *`,
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
        `INSERT INTO tenancies (application_id, property_id, renter_id, owner_id, rent_amount, rent_period, lease_start_date, lease_end_date, status, is_sight_unseen) VALUES ($1, $2, $3, $4, $5, 'Per Annum', $6, $7, 'Draft', $8)`,
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
    res.json({ success: true, application });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to process application' });
  }
});

app.get('/api/applications/check/:property_id/:renter_id', async (req, res) => {
  try {
    const { property_id, renter_id } = req.params;
    const result = await pool.query(
      `SELECT status FROM applications WHERE property_id = $1 AND renter_id = $2 AND status IN ('Pending', 'Approved') LIMIT 1`,
      [property_id, renter_id],
    );
    res.json({
      success: true,
      hasApplied: result.rows.length > 0,
      status: result.rows[0]?.status,
    });
  } catch (err) {
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
      `SELECT t.*, p.title as property_title, p.address_street, p.address_city, p.address_state, o.name as owner_name, o.email as owner_email, r.name as renter_name, r.email as renter_email, r.occupation, r.nok_full_name
       FROM tenancies t JOIN properties p ON t.property_id = p.property_id JOIN users o ON t.owner_id = o.user_id JOIN users r ON t.renter_id = r.user_id WHERE t.tenancy_id = $1`,
      [id],
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, error: 'Agreement not found' });
    res.json({ success: true, tenancy: result.rows[0] });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch agreement' });
  }
});

app.put('/api/tenancies/:id/sign', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE tenancies SET renter_signature_date = CURRENT_TIMESTAMP, status = 'Signed' WHERE tenancy_id = $1 RETURNING *`,
      [id],
    );
    res.json({ success: true, tenancy: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to sign agreement' });
  }
});

app.post('/api/tenancies/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;
    const tenancyResult = await pool.query(
      `SELECT t.rent_amount, u.email FROM tenancies t JOIN users u ON t.renter_id = u.user_id WHERE t.tenancy_id = $1`,
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

// MULTI-PARTY ESCROW ROUTING ENGINE (THE FIX)
app.post('/api/tenancies/:id/verify', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    // 1. Fetch the payment reference and tenancy details
    const refResult = await client.query(
      `SELECT t.*, p.title as property_title 
       FROM tenancies t 
       JOIN properties p ON t.property_id = p.property_id 
       WHERE t.tenancy_id = $1`,
      [id],
    );
    const tenancy = refResult.rows[0];
    if (!tenancy || !tenancy.payment_reference)
      return res
        .status(400)
        .json({ success: false, error: 'No active payment found.' });

    // 2. Call Paystack API to confirm payment
    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${tenancy.payment_reference}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      },
    );
    const verifyData = await verifyResponse.json();

    if (verifyData.data.status === 'success') {
      await client.query('BEGIN'); // Start safe database transaction

      // 3. Mark the Tenancy as officially active
      await client.query(
        `UPDATE tenancies SET payment_status = 'Paid' WHERE tenancy_id = $1`,
        [id],
      );

      const rentAmount = parseFloat(tenancy.rent_amount);
      let gatewayFee = rentAmount * 0.015 + 100;
      if (gatewayFee > 2000) gatewayFee = 2000;

      // 4. Log the Renter's Payment Receipt in the ledger
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'payment', 'Annual Rent Payment', $2, $3, 'Completed')`,
        [tenancy.renter_id, tenancy.property_title, -rentAmount],
      );

      // 5. Log the Renter's Gateway Fee Receipt
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'fee', 'Propadi Secure Gateway Fee', 'Platform Service', $2, 'Completed')`,
        [tenancy.renter_id, -gatewayFee],
      );

      // 6. Log the Landlord's Incoming Credit in their ledger
      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
         VALUES ($1, 'credit', 'Rent Payment Received', $2, $3, 'Completed')`,
        [tenancy.owner_id, tenancy.property_title, rentAmount],
      );

      // 7. Fund the Landlord's Wallet Balance directly
      await client.query(
        `UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [rentAmount, tenancy.owner_id],
      );

      await client.query('COMMIT'); // Lock it into the database permanently
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
    res.status(500).json({
      success: false,
      error: 'Failed to verify payment and process ledgers',
    });
  } finally {
    client.release();
  }
});

// ==========================================
// ROLE-BASED WALLET & LEDGER ROUTES
// ==========================================

// Landlord Wallet Read Route
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
      `SELECT id, type, title, property_ref as property, amount, created_at as date, status 
       FROM transactions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );

    res.json({ success: true, ...wallet, transactions: txnResult.rows || [] });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch landlord wallet' });
  }
});

// Tenant Wallet Read Route
app.get('/api/tenant-wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Sum all payments explicitly marked as 'payment' or 'fee' for the renter
    const paidResult = await pool.query(
      `SELECT SUM(ABS(amount)) as total_paid FROM transactions WHERE user_id = $1 AND type IN ('payment', 'fee') AND status = 'Completed'`,
      [userId],
    );
    const totalPaid = paidResult.rows[0].total_paid || 0;

    // Count their active tenancies
    const rentalsResult = await pool.query(
      `SELECT COUNT(*) as active_count FROM tenancies WHERE renter_id = $1 AND payment_status = 'Paid'`,
      [userId],
    );
    const activeRentals = rentalsResult.rows[0].active_count || 0;

    // Fetch their digital receipts
    const txnsResult = await pool.query(
      `SELECT id, type, title, property_ref as property, amount, created_at as date, status, id as reference 
       FROM transactions WHERE user_id = $1 AND type IN ('payment', 'fee') ORDER BY created_at DESC`,
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

// Landlord Withdrawal Route
app.post('/api/wallet/withdraw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, amount, bankName, accountNumber } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0)
      return res
        .status(400)
        .json({ success: false, error: 'Invalid withdrawal amount' });

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

    const txnResult = await client.query(
      `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) VALUES ($1, 'withdrawal', 'Bank Withdrawal', $2, $3, 'Pending') RETURNING *`,
      [userId, `To ${bankName} (${accountNumber.slice(-4)})`, -withdrawAmount],
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      transaction: txnResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res
      .status(500)
      .json({ success: false, error: 'Failed to process withdrawal' });
  } finally {
    client.release();
  }
});

// ==========================================
// MAINTENANCE REQUESTS ROUTES
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', CURRENT_TIMESTAMP) RETURNING *`,
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

    res.json({
      success: true,
      ticket: {
        ...result.rows[0],
        id: result.rows[0].request_id,
        created_at: result.rows[0].date_submitted,
        property_title: propResult.rows[0].title,
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

// ======== SERVER SETUP ========
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
