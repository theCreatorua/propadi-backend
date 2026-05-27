require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

// Database Connection (Supabase PostgreSQL)
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

    await pool.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0)', [
      user_id,
    ]);

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

    const insertResult = await pool.query(
      `INSERT INTO transactions (user_id, type, title, amount, status) 
       VALUES ($1, 'credit', 'Vault Deposit', $2, 'Completed') RETURNING *`,
      [userId, amount],
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

    const insertResult = await pool.query(
      `INSERT INTO withdrawals (user_id, email, amount, bank_name, account_number, status, type) 
       VALUES ($1, $2, $3, $4, $5, 'Pending', 'Withdrawal') RETURNING *`,
      [userId, email, amount, bankName, accountNumber],
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
      `SELECT u.email, COALESCE(w.balance, 0) as balance 
       FROM users u 
       LEFT JOIN wallets w ON u.user_id = w.user_id 
       WHERE u.user_id = $1`,
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

    if (!nin || nin.length < 11) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid NIN provided.' });
    }

    await pool.query(
      `UPDATE users 
       SET nin_verified = TRUE, kyc_tier = 2, renter_score = renter_score + 15 
       WHERE user_id = $1`,
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
    const query = `SELECT * FROM properties WHERE status = 'Available' ORDER BY date_listed DESC;`;
    const result = await pool.query(query);
    res.json({ success: true, properties: result.rows });
  } catch (err) {
    console.error('Error fetching feed:', err);
    res.status(500).json({ success: false, error: 'Failed to load the feed' });
  }
});

app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const propQuery = `SELECT * FROM properties WHERE property_id = $1;`;
    const propResult = await pool.query(propQuery, [id]);

    if (propResult.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Property not found in database' });
    }

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

// ==========================================
// MESSAGING ROUTES
// ==========================================

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

// ISOLATED UPDATE: Automatically insert an "In Progress" ledger message into the chat.
app.put('/api/viewings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Look up the viewing to get context for the chat message
    const viewData = await pool.query(
      'SELECT property_id, owner_id, renter_id FROM viewings WHERE viewing_id = $1',
      [id],
    );
    const v = viewData.rows[0];

    let query;
    let values;

    if (status === 'Accepted') {
      const securePin = crypto.randomInt(100000, 999999).toString();
      const expiryTime = new Date();
      expiryTime.setMinutes(expiryTime.getMinutes() + 5);

      query = `UPDATE viewings 
               SET status = $1, secure_handshake_pin = $2, pin_expiry = $3 
               WHERE viewing_id = $4 RETURNING *`;
      values = [status, securePin, expiryTime.toISOString(), id];

      // Inject Ledger Message
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
      query = `UPDATE viewings SET status = $1 WHERE viewing_id = $2 RETURNING *`;
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

// ISOLATED UPDATE: Automatically insert a "Completed" ledger message into the chat.
app.post('/api/viewings/:id/validate', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { pin, owner_lat, owner_lng } = req.body;

    if (!pin) {
      return res
        .status(400)
        .json({ success: false, error: 'Handshake PIN is required.' });
    }

    await client.query('BEGIN');

    const viewingResult = await client.query(
      `SELECT secure_handshake_pin, pin_expiry, status, property_id, owner_id, renter_id 
       FROM viewings WHERE viewing_id = $1 FOR UPDATE`,
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
      // Inject Failed Ledger Message
      await client.query(
        `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1, $2, $3, $4)`,
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
      `UPDATE viewings 
       SET status = 'Completed', 
           owner_checkin_location = $2,
           updated_at = CURRENT_TIMESTAMP 
       WHERE viewing_id = $1 RETURNING *`,
      [id, `${owner_lat},${owner_lng}`],
    );

    // Inject Success Ledger Message
    await client.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1, $2, $3, $4)`,
      [
        viewing.property_id,
        viewing.owner_id,
        viewing.renter_id,
        `✅ **Secure Viewing Completed Successfully.** The physical property inspection has been verified.`,
      ],
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Secure Handshake verified! Viewing officially completed.',
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

      const sqlStartDate = start.toISOString().split('T')[0];
      const sqlEndDate = end.toISOString().split('T')[0];

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

app.put('/api/tenancies/:id/sign', async (req, res) => {
  try {
    const { id } = req.params;

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

app.get('/api/applications/check/:property_id/:renter_id', async (req, res) => {
  try {
    const { property_id, renter_id } = req.params;

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
  try {
    const { id } = req.params;

    const refResult = await pool.query(
      `SELECT payment_reference FROM tenancies WHERE tenancy_id = $1`,
      [id],
    );
    const reference = refResult.rows[0]?.payment_reference;

    if (!reference)
      return res
        .status(400)
        .json({ success: false, error: 'No payment reference found.' });

    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      },
    );

    const verifyData = await verifyResponse.json();

    if (verifyData.data.status === 'success') {
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

// ==========================================
// LANDLORD WALLET & SECURE LEDGER
// ==========================================

app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const walletResult = await pool.query(
      'SELECT balance, total_earned, pending_clearance FROM wallets WHERE user_id = $1',
      [userId],
    );
    let wallet = walletResult.rows[0];

    if (!wallet) {
      wallet = { balance: 0, total_earned: 0, pending_clearance: 0 };
    }

    const txnResult = await pool.query(
      `SELECT id, type, title, property_ref as property, amount, created_at as date, status 
       FROM transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId],
    );

    res.json({
      success: true,
      balance: wallet.balance,
      total_earned: wallet.total_earned,
      pending_clearance: wallet.pending_clearance,
      transactions: txnResult.rows || [],
    });
  } catch (error) {
    console.error('Wallet fetch error:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch wallet data' });
  }
});

app.post('/api/wallet/withdraw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, amount, bankName, accountNumber } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid withdrawal amount' });
    }

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

    const propertyRef = `To ${bankName} (${accountNumber.slice(-4)})`;
    const txnResult = await client.query(
      `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) 
       VALUES ($1, 'withdrawal', 'Bank Withdrawal', $2, $3, 'Pending') RETURNING *`,
      [userId, propertyRef, -withdrawAmount],
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Withdrawal initiated successfully',
      transaction: txnResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Withdrawal error:', error);
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
       FROM maintenance_requests m
       JOIN properties p ON m.property_id = p.property_id
       WHERE m.renter_id = $1 OR m.owner_id = $1
       ORDER BY m.date_submitted DESC`,
      [userId],
    );
    res.json({ success: true, tickets: result.rows });
  } catch (err) {
    console.error('Maintenance fetch error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch maintenance requests' });
  }
});

app.post('/api/maintenance', async (req, res) => {
  try {
    const { renter_id, category, title, description, media_url } = req.body;

    const tenancyResult = await pool.query(
      `SELECT tenancy_id, property_id, owner_id FROM tenancies 
       WHERE renter_id = $1 AND status = 'Signed' 
       LIMIT 1`,
      [renter_id],
    );

    if (tenancyResult.rows.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'No active tenancy found.' });
    }

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

    const newTicket = {
      id: result.rows[0].request_id,
      category: result.rows[0].category,
      title: result.rows[0].title,
      description: result.rows[0].description,
      status: result.rows[0].status,
      created_at: result.rows[0].date_submitted,
      media_url: result.rows[0].media_url,
      property_title: propResult.rows[0].title,
    };

    res.json({ success: true, ticket: newTicket });
  } catch (err) {
    console.error('Create request error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to submit maintenance request' });
  }
});

app.put('/api/maintenance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    let query = `UPDATE maintenance_requests SET status = $1 WHERE request_id = $2 RETURNING *`;
    if (status === 'Resolved') {
      query = `UPDATE maintenance_requests SET status = $1, date_resolved = CURRENT_TIMESTAMP WHERE request_id = $2 RETURNING *`;
    }

    const result = await pool.query(query, [status, id]);
    res.json({ success: true, ticket: result.rows[0] });
  } catch (err) {
    console.error('Update request error:', err);
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

// ======== SERVER SETUP ========
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
