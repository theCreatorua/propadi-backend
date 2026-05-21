require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase for Storage uploads
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // <-- The VIP Admin Key!
);
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// === API KEY DIAGNOSTIC ===
console.log('=== API KEY DIAGNOSTIC ===');
console.log(
  'Does Render see the key?:',
  process.env.RESEND_API_KEY ? 'YES' : 'NO',
);
console.log(
  'Key Length:',
  process.env.RESEND_API_KEY ? process.env.RESEND_API_KEY.length : 0,
);

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Database Connection (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==========================================
// AUTHENTICATION & USER ROUTES
// ==========================================

// 1. Sign Up a New User
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;

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
      'INSERT INTO users (email, password, name, balance) VALUES ($1, $2, $3, 0) RETURNING user_id, email, name, balance',
      [email, password, name],
    );

    res.json({
      success: true,
      message: 'Welcome to Propadi!',
      user: newUser.rows[0],
    });
  } catch (err) {
    console.error('Sign Up Error:', err);
    res.status(500).json({ success: false, error: 'Failed to create account' });
  }
});

// 2. Log In an Existing User
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT user_id, email, name, balance FROM users WHERE email = $1 AND password = $2',
      [email, password],
    );

    if (result.rows.length === 0) {
      return res
        .status(401)
        .json({ success: false, error: 'Invalid email or password' });
    }

    res.json({
      success: true,
      message: 'Login successful',
      user: result.rows[0],
    });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ success: false, error: 'Failed to log in' });
  }
});

// 3. Deposit / Fund Vault
app.post('/api/user/deposit', async (req, res) => {
  const { userId, amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res
      .status(400)
      .json({ success: false, error: 'Please enter a valid amount' });
  }

  try {
    const updateResult = await pool.query(
      'UPDATE users SET balance = balance + $1 WHERE user_id = $2 RETURNING balance',
      [amount, userId],
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const insertResult = await pool.query(
      'INSERT INTO withdrawals (user_id, amount, status, type) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, amount, 'Paid', 'Deposit'],
    );

    res.json({
      success: true,
      message: 'Vault funded successfully!',
      newBalance: updateResult.rows[0].balance,
      transaction: insertResult.rows[0],
    });
  } catch (err) {
    console.error('Deposit Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process deposit' });
  }
});

// 4. Request Withdrawal
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
      'SELECT balance FROM users WHERE user_id = $1',
      [userId],
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const currentBalance = parseFloat(userResult.rows[0].balance);
    if (currentBalance < amount) {
      return res
        .status(400)
        .json({ success: false, error: 'Insufficient funds in vault' });
    }

    const insertResult = await pool.query(
      `INSERT INTO withdrawals (user_id, email, amount, bank_name, account_number, status, type) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [userId, email, amount, bankName, accountNumber, 'Pending', 'Withdrawal'],
    );

    res.json({
      success: true,
      message: 'Withdrawal requested successfully!',
      withdrawal: insertResult.rows[0],
    });
  } catch (err) {
    console.error('Withdraw Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process withdrawal request' });
  }
});

// Get user dashboard data
app.get('/api/user/dashboard/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const balanceResult = await pool.query(
      'SELECT balance FROM users WHERE user_id = $1',
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

// Get User Profile Details
app.get('/api/user/profile/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      'SELECT email, balance FROM users WHERE user_id = $1',
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('Profile Fetch Error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

// ==========================================
// PROPADI TRUST & KYC ENGINE
// ==========================================

// Get a user's current KYC Tier and Trust Status
app.get('/api/users/:id/trust', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT kyc_tier, phone_verified, nin_verified, address_verified, propadi_score 
       FROM users WHERE user_id = $1`,
      [id],
    );

    if (result.rows.length > 0) {
      res.json({ success: true, trust_data: result.rows[0] });
    } else {
      res.status(404).json({ success: false, error: 'User not found' });
    }
  } catch (err) {
    console.error('Error fetching trust data:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch trust data' });
  }
});

// ==========================================
// PROPERTIES ROUTES (CLEANED & DEDUPLICATED)
// ==========================================

// 1. GET ALL ROUTE (For the Renter's Home Feed)
app.get('/api/properties', async (req, res) => {
  try {
    const query = `SELECT * FROM properties WHERE status = 'Available' ORDER BY date_listed DESC;`;
    const result = await pool.query(query);
    res.json({ success: true, properties: result.rows });
  } catch (err) {
    console.error('Error fetching feed:', err);
    res.status(500).json({ success: false, error: 'Failed to load the feed' });
  }
});

// 2. GET SINGLE ROUTE (For the Property Details & Visual Verification)
app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Step A: Get the core property
    const propQuery = `SELECT * FROM properties WHERE property_id = $1;`;
    const propResult = await pool.query(propQuery, [id]);

    if (propResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Property not found in database' });
    }

    const property = propResult.rows[0];

    // Step B: Get the visually verified amenities
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

// 3. POST ROUTE: Create a new property listing AND its visually verified amenities
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

    const propQuery = `
      INSERT INTO properties (
        owner_id, status, category, furnishing_status, title, description,
        rent_price, rent_period, total_beds, total_baths, address_street,
        address_city, address_lga, address_state, map_coordinates, main_image_url,
        gallery_urls, total_kitchens, total_stores
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 
        NULL, $15, ARRAY[]::text[], $16, $17
      )
      RETURNING *;
    `;

    const propValues = [
      owner_id,
      status || 'Available',
      category,
      furnishing_status,
      title,
      description,
      rent_price,
      rent_period || 'Yearly',
      total_beds || 0,
      total_baths || 0,
      address_street,
      address_city,
      address_lga,
      address_state,
      main_image_url,
      total_kitchens || 0,
      total_stores || 0,
    ];

    const propResult = await client.query(propQuery, propValues);
    const savedProperty = propResult.rows[0];

    if (visually_verified_amenities && visually_verified_amenities.length > 0) {
      for (const amenity of visually_verified_amenities) {
        await client.query(
          `INSERT INTO properties_amenities (property_id, amenity_name, verification_url, media_type)
           VALUES ($1, $2, $3, $4)`,
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
    console.error('Transaction Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to publish verified listing' });
  } finally {
    client.release();
  }
});

// ==========================================
// ADMIN ROUTES
// ==========================================

// 1. Get all withdrawals
app.get('/api/admin/withdrawals', async (req, res) => {
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

// 2. Mark withdrawal as Paid, DEDUCT BALANCE, and send email
app.put('/api/admin/withdrawals/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const checkResult = await pool.query(
      'SELECT * FROM withdrawals WHERE id = $1',
      [id],
    );

    if (checkResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Withdrawal not found' });
    }

    const withdrawal = checkResult.rows[0];

    const updateResult = await pool.query(
      'UPDATE withdrawals SET status = $1 WHERE id = $2 RETURNING *',
      [status, id],
    );

    if (status === 'Paid') {
      await pool.query(
        'UPDATE users SET balance = balance - $1 WHERE user_id = $2',
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

// ==========================================
// MESSAGING ROUTES
// ==========================================

// 1. Send a new message
app.post('/api/messages', async (req, res) => {
  try {
    const { property_id, sender_id, receiver_id, content } = req.body;

    const result = await pool.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [property_id, sender_id, receiver_id, content],
    );

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// 2. Get chat history between two users for a specific property
app.get('/api/messages/:property_id/:user1_id/:user2_id', async (req, res) => {
  try {
    const { property_id, user1_id, user2_id } = req.params;

    const result = await pool.query(
      `SELECT * FROM messages 
       WHERE property_id = $1 
       AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))
       ORDER BY created_at ASC`,
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

// 3. GET INBOX
app.get('/api/inbox/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const query = `
      SELECT DISTINCT ON (
        m.property_id, 
        CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END
      )
        m.id,
        m.property_id,
        m.content as last_message,
        m.created_at,
        m.sender_id,
        m.receiver_id,
        p.title as property_title,
        p.main_image_url
      FROM messages m
      JOIN properties p ON m.property_id = p.property_id
      WHERE m.sender_id = $1 OR m.receiver_id = $1
      ORDER BY 
        m.property_id, 
        CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END,
        m.created_at DESC;
    `;

    const result = await pool.query(query, [userId]);

    const sortedConversations = result.rows.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );

    res.json({ success: true, conversations: sortedConversations });
  } catch (err) {
    console.error('Error fetching inbox:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch inbox' });
  }
});

// ==========================================
// VIEWING TRACKER ROUTES
// ==========================================

// 1. Request a New Viewing
// 1. Request a New Viewing (WITH HIDDEN ID FOR BUTTONS)
app.post('/api/viewings', async (req, res) => {
  try {
    const { property_id, renter_id, landlord_id, viewing_date } = req.body;

    const startTime = new Date(viewing_date);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO viewings (property_id, renter_id, owner_id, scheduled_start_time, scheduled_end_time, status) 
       VALUES ($1, $2, $3, $4, $5, 'Pending') RETURNING *`,
      [
        property_id,
        renter_id,
        landlord_id,
        startTime.toISOString(),
        endTime.toISOString(),
      ],
    );

    // THE FIX: We secretly attach the viewing_id to the end of the text using "||"
    await pool.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) 
       VALUES ($1, $2, $3, $4)`,
      [
        property_id,
        renter_id,
        landlord_id,
        `🗓️ I have requested a viewing for ${startTime.toLocaleString()}. Please accept or decline.||${result.rows[0].viewing_id}`,
      ],
    );

    res.json({ success: true, viewing: result.rows[0] });
  } catch (err) {
    console.error('Error creating viewing:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to request viewing' });
  }
});
// 2. Update Viewing Status (Accept/Decline)
app.put('/api/viewings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'Accepted' or 'Declined'

    const result = await pool.query(
      `UPDATE viewings SET status = $1 WHERE viewing_id = $2 RETURNING *`, // THE FIX: using viewing_id to match schema
      [status, id],
    );

    res.json({ success: true, viewing: result.rows[0] });
  } catch (err) {
    console.error('Error updating viewing:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to update viewing status' });
  }
});

// ==========================================
// FORMAL APPLICATION ROUTES
// ==========================================

// Submit a new application
app.post('/api/applications', async (req, res) => {
  try {
    const {
      property_id,
      renter_id,
      owner_id,
      proposed_rent,
      cover_letter,
      move_in_date,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO applications (property_id, renter_id, owner_id, proposed_rent, cover_letter, move_in_date) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        property_id,
        renter_id,
        owner_id,
        proposed_rent,
        cover_letter,
        move_in_date || 'Immediately',
      ],
    );

    res.json({ success: true, application: result.rows[0] });
  } catch (err) {
    console.error('Error submitting application:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to submit application' });
  }
});

// 1. Fetch all applications for a specific landlord (WITH TRUST METRICS)
app.get('/api/applications/owner/:owner_id', async (req, res) => {
  try {
    const { owner_id } = req.params;
    const result = await pool.query(
      `SELECT 
         a.application_id, a.property_id, a.proposed_rent, a.cover_letter, a.status, a.date_applied,
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

// 2. Accept or Decline an Application (WITH SMART CONTRACT AUTO-GENERATION)
// Accept or Decline an Application (WITH SMART CONTRACT DATE MATH)
app.put('/api/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'Approved' or 'Rejected'

    // 1. Update the application status
    const appResult = await pool.query(
      `UPDATE applications SET status = $1, date_status_updated = CURRENT_TIMESTAMP WHERE application_id = $2 RETURNING *`,
      [status, id],
    );

    const application = appResult.rows[0];

    // 2. The Magic - Auto-draft the Tenancy Agreement with Dates!
    if (status === 'Approved' && application) {
      // --- THE DATE MATH ENGINE ---
      const start = new Date();
      const moveIn = (application.move_in_date || '').toLowerCase();

      if (moveIn.includes('next week')) {
        start.setDate(start.getDate() + 7);
      } else if (moveIn.includes('next month')) {
        start.setMonth(start.getMonth() + 1);
      } else if (!moveIn.includes('immediately') && moveIn !== '') {
        // If it's a custom date, safely default to 14 days from now
        start.setDate(start.getDate() + 14);
      }

      const end = new Date(start);
      end.setFullYear(end.getFullYear() + 1); // Standard 1 Year Nigerian Lease

      const sqlStartDate = start.toISOString().split('T')[0];
      const sqlEndDate = end.toISOString().split('T')[0];
      // -----------------------------

      await pool.query(
        `INSERT INTO tenancies (application_id, property_id, renter_id, owner_id, rent_amount, rent_period, lease_start_date, lease_end_date, status) 
         VALUES ($1, $2, $3, $4, $5, 'Per Annum', $6, $7, 'Draft')`,
        [
          application.application_id,
          application.property_id,
          application.renter_id,
          application.owner_id,
          application.proposed_rent,
          sqlStartDate,
          sqlEndDate,
        ],
      );
    }

    res.json({ success: true, application });
  } catch (err) {
    console.error('Error updating application:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process application' });
  }
});

// ==========================================
// SMART CONTRACT & TENANCY ROUTES
// ==========================================

// 1. Fetch a specific Tenancy Agreement with all details
app.get('/api/tenancies/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT 
         t.*, 
         p.title as property_title, p.address_street, p.address_city, p.address_state,
         o.name as owner_name, o.email as owner_email,
         r.name as renter_name, r.email as renter_email, r.occupation, r.nok_full_name
       FROM tenancies t
       JOIN properties p ON t.property_id = p.property_id
       JOIN users o ON t.owner_id = o.user_id
       JOIN users r ON t.renter_id = r.user_id
       WHERE t.tenancy_id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Agreement not found' });
    }

    res.json({ success: true, tenancy: result.rows[0] });
  } catch (err) {
    console.error('Error fetching tenancy:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch agreement' });
  }
});

// 2. Electronically Sign the Agreement
app.put('/api/tenancies/:id/sign', async (req, res) => {
  try {
    const { id } = req.params;

    // We stamp the exact server time as the legal signature
    const result = await pool.query(
      `UPDATE tenancies 
       SET renter_signature_date = CURRENT_TIMESTAMP, status = 'Signed' 
       WHERE tenancy_id = $1 RETURNING *`,
      [id],
    );

    res.json({ success: true, tenancy: result.rows[0] });
  } catch (err) {
    console.error('Error signing tenancy:', err);
    res.status(500).json({ success: false, error: 'Failed to sign agreement' });
  }
});

// 3. Fetch all applications for a specific RENTER (Includes the Draft Tenancy ID!)
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

// 4. Check if a Renter has already applied for a specific property
app.get('/api/applications/check/:property_id/:renter_id', async (req, res) => {
  try {
    const { property_id, renter_id } = req.params;

    // We only block it if the application is 'Pending' or 'Approved'.
    // If it was 'Rejected', we allow them to apply again.
    const result = await pool.query(
      `SELECT status FROM applications 
       WHERE property_id = $1 AND renter_id = $2 AND status IN ('Pending', 'Approved') 
       LIMIT 1`,
      [property_id, renter_id],
    );

    if (result.rows.length > 0) {
      res.json({
        success: true,
        hasApplied: true,
        status: result.rows[0].status,
      });
    } else {
      res.json({ success: true, hasApplied: false });
    }
  } catch (err) {
    console.error('Error checking application status:', err);
    res.status(500).json({ success: false, error: 'Failed to check status' });
  }
});

// ==========================================
// PAYSTACK PAYMENT INTEGRATION
// ==========================================

// 1. Initialize a Paystack Transaction
app.post('/api/tenancies/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;

    const tenancyResult = await pool.query(
      `SELECT t.rent_amount, u.email 
       FROM tenancies t JOIN users u ON t.renter_id = u.user_id WHERE t.tenancy_id = $1`,
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

    const totalAmountNaira = rentAmount + gatewayFee;
    const totalAmountKobo = Math.round(totalAmountNaira * 100);

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
      // THE FIX: Save the reference in the database before sending the link to the app!
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

// 2. NEW: Verify the Payment
app.post('/api/tenancies/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the reference we saved earlier
    const refResult = await pool.query(
      `SELECT payment_reference FROM tenancies WHERE tenancy_id = $1`,
      [id],
    );
    const reference = refResult.rows[0]?.payment_reference;

    if (!reference)
      return res
        .status(400)
        .json({ success: false, error: 'No payment reference found.' });

    // Ask Paystack if this reference was actually paid
    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      },
    );

    const verifyData = await verifyResponse.json();

    if (verifyData.data.status === 'success') {
      // THE MAGIC: If Paystack says yes, lock the contract to Paid!
      await pool.query(
        `UPDATE tenancies SET payment_status = 'Paid' WHERE tenancy_id = $1`,
        [id],
      );
      res.json({
        success: true,
        message: 'Payment verified and contract activated!',
      });
    } else {
      res.json({
        success: false,
        status: verifyData.data.status,
        message: 'Payment is still pending or failed.',
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to verify payment' });
  }
});
// ======== SERVER SETUP ========
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
