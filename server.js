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
      WHERE p.status = 'Available'
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
    const { state, lga, city, minPrice, maxPrice, bedrooms, amenities, query } =
      req.query;
    let sql = `
      SELECT p.*, array_agg(DISTINCT pa.amenity_name) as amenities_list
      FROM properties p
      LEFT JOIN properties_amenities pa ON p.property_id = pa.property_id
      WHERE p.status = 'Available'
    `;
    const values = [];
    let paramIndex = 1;
    if (state) {
      sql += ` AND p.address_state = $${paramIndex}`;
      values.push(state);
      paramIndex++;
    }
    if (lga) {
      sql += ` AND p.address_lga = $${paramIndex}`;
      values.push(lga);
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
    if (query) {
      sql += ` AND (p.title ILIKE $${paramIndex} OR p.address_city ILIKE $${paramIndex} OR p.address_street ILIKE $${paramIndex})`;
      values.push(`%${query}%`);
      paramIndex++;
    }
    sql += ` GROUP BY p.property_id ORDER BY p.rent_price ASC`;
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
      gallery_urls,
      visually_verified_amenities,
      landmark_name,
      landmark_type,
      size_sqm,
      parking_spaces,
      year_built,
      floor_number,
    } = req.body;

    const propQuery = `
      INSERT INTO properties (
        owner_id, status, category, furnishing_status, title, description,
        rent_price, rent_period, total_beds, total_baths, address_street,
        address_city, address_lga, address_state, map_coordinates, main_image_url,
        gallery_urls, total_kitchens, total_stores, landmark_name, landmark_type,
        size_sqm, parking_spaces, year_built, floor_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
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
      gallery_urls || [],
      total_kitchens || 0,
      total_stores || 0,
      landmark_name || null,
      landmark_type || null,
      size_sqm || null,
      parking_spaces || null,
      year_built || null,
      floor_number || null,
    ];
    const propResult = await client.query(propQuery, propValues);
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
      `UPDATE tenancies SET renter_signature_date=CURRENT_TIMESTAMP, status='Signed' WHERE tenancy_id=$1 RETURNING *`,
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
        `₦${rentAmount.toLocaleString()} has been added to your wallet for ${propertyTitle}`,
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
      } catch (e) {}
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
    const { base64, fileType } = req.body;
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
       (provider_id, trade_type, license_number, license_document_url, years_experience, daily_wage, service_radius_km, is_verified, availability_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'available')
       RETURNING *`,
      [
        user.id,
        trade_type,
        license_number || null,
        licenseUrlsJson,
        years_experience || '0-1',
        daily_wage,
        service_radius_km || 20,
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

// GET /api/provider/dashboard – get provider dashboard data
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

    // Get provider record
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

    // Get current job (if any)
    let currentJob = null;
    if (provider.current_job_id) {
      const jobResult = await pool.query(
        `SELECT sr.*, mr.title, mr.description, mr.media_url, p.title as property_title, p.address_street, p.address_city, p.address_state
         FROM service_requests sr
         JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
         JOIN properties p ON sr.property_id = p.property_id
         WHERE sr.service_id = $1`,
        [provider.current_job_id],
      );
      if (jobResult.rows.length) currentJob = jobResult.rows[0];
    }

    // Get pending job offers (previews without full address)
    const pendingJobs = await pool.query(
      `SELECT sr.service_id, sr.trade_type, sr.estimated_hours, sr.created_at,
              mr.title, mr.description, mr.media_url,
              p.title as property_title, p.address_city, p.address_state
       FROM service_requests sr
       JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       JOIN properties p ON sr.property_id = p.property_id
       WHERE sr.provider_id IS NULL AND sr.status = 'pending' AND sr.trade_type = $1
       ORDER BY sr.created_at ASC
       LIMIT 20`,
      [provider.trade_type],
    );

    // Get job history (completed)
    const jobHistory = await pool.query(
      `SELECT sr.*, mr.title, p.title as property_title
       FROM service_requests sr
       JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       JOIN properties p ON sr.property_id = p.property_id
       WHERE sr.provider_id = $1 AND sr.status IN ('completed', 'rejected')
       ORDER BY sr.completed_at DESC
       LIMIT 20`,
      [user.id],
    );

    // Get earnings summary
    const earnings = await pool.query(
      `SELECT COALESCE(SUM(actual_cost), 0) as total_earned
       FROM service_requests
       WHERE provider_id = $1 AND status = 'completed'`,
      [user.id],
    );

    res.json({
      success: true,
      provider,
      currentJob,
      pendingJobs: pendingJobs.rows,
      jobHistory: jobHistory.rows,
      totalEarned: parseFloat(earnings.rows[0].total_earned),
    });
  } catch (err) {
    console.error('Provider dashboard error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/provider/availability – update availability status
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
        AND sp.trade_type = $1
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

    const { maintenance_request_id, provider_id, estimated_hours, notes } =
      req.body;
    if (!maintenance_request_id) {
      return res
        .status(400)
        .json({ success: false, error: 'Maintenance request ID is required' });
    }

    await client.query('BEGIN');

    // Get maintenance request and property details
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

    // Ensure the owner matches the authenticated user
    if (maint.owner_id !== user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        error: 'You are not the owner of this property',
      });
    }

    // If provider_id is provided, verify provider exists and is verified
    let providerCheck = null;
    if (provider_id) {
      providerCheck = await client.query(
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
    }

    // Calculate estimated cost (daily_wage * estimated_days) – simplify: daily_wage * 1 day for now
    const dailyWage = providerCheck ? providerCheck.rows[0].daily_wage : 0;
    const estimatedCost =
      dailyWage * (estimated_hours ? Math.ceil(estimated_hours / 8) : 1);

    // Create service request
    const insertResult = await client.query(
      `INSERT INTO service_requests 
       (maintenance_request_id, property_id, owner_id, provider_id, trade_type, description, estimated_hours, estimated_cost, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING *`,
      [
        maintenance_request_id,
        maint.property_id,
        user.id,
        provider_id || null,
        maint.category, // trade type based on maintenance category (plumbing, electrical, etc.)
        maint.description,
        estimated_hours || null,
        estimatedCost,
      ],
    );
    const serviceRequest = insertResult.rows[0];

    await client.query('COMMIT');

    // If a specific provider was assigned, send push notification
    if (provider_id) {
      await sendPushToUser(
        provider_id,
        '🔧 New Service Request',
        `You have a new ${maint.category} request for "${maint.property_title}". Please check your dashboard.`,
        { screen: 'ProviderDashboard', service_id: serviceRequest.service_id },
      );
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

    const providerResult = await pool.query(
      `SELECT trade_type FROM service_providers WHERE provider_id = $1 AND is_verified = true`,
      [user.id],
    );
    if (providerResult.rows.length === 0) {
      return res
        .status(403)
        .json({ success: false, error: 'Not a verified service provider' });
    }
    const tradeType = providerResult.rows[0].trade_type;

    const pendingQuery = `
      SELECT sr.*, mr.title, mr.description, mr.media_url,
             p.title as property_title, p.address_city, p.address_state
      FROM service_requests sr
      JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
      JOIN properties p ON sr.property_id = p.property_id
      WHERE LOWER(sr.trade_type) = LOWER($1)
        AND sr.status = 'pending'
        AND (sr.provider_id IS NULL OR sr.provider_id = $2)
      ORDER BY sr.created_at ASC
      LIMIT 30
    `;
    const result = await pool.query(pendingQuery, [tradeType, user.id]);
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

    // Get service request
    const serviceResult = await client.query(
      `SELECT sr.*, p.address_street, p.address_city, p.address_state
       FROM service_requests sr
       JOIN properties p ON sr.property_id = p.property_id
       WHERE sr.service_id = $1 AND sr.status = 'pending'`,
      [id],
    );
    if (serviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Service request not found or already accepted',
      });
    }
    const service = serviceResult.rows[0];

    // Update service request
    await client.query(
      `UPDATE service_requests SET provider_id = $1, status = 'accepted', accepted_at = NOW() WHERE service_id = $2`,
      [user.id, id],
    );

    // Update provider availability
    await client.query(
      `UPDATE service_providers SET availability_status = 'at_work', current_job_id = $1, last_status_update = NOW() WHERE provider_id = $2`,
      [id, user.id],
    );

    await client.query('COMMIT');

    // Notify owner
    await sendPushToUser(
      service.owner_id,
      '🔧 Service Provider Accepted',
      `Your service request for "${service.title}" has been accepted. The provider will contact you.`,
      { screen: 'ServiceRequest', service_id: id },
    );

    res.json({
      success: true,
      message: 'Job accepted',
      address: {
        street: service.address_street,
        city: service.address_city,
        state: service.address_state,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Accept service request error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/service-requests/:id/decline – provider declines a job
app.put('/api/service-requests/:id/decline', async (req, res) => {
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

    // Only allow decline if provider is assigned or no provider yet
    const result = await pool.query(
      `UPDATE service_requests SET status = 'rejected' WHERE service_id = $1 AND (provider_id = $2 OR provider_id IS NULL) RETURNING *`,
      [id, user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Service request not found or already assigned',
      });
    }
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

    const result = await pool.query(
      `UPDATE service_requests SET status = 'completed', completed_at = NOW() WHERE service_id = $1 AND provider_id = $2 AND status = 'accepted' RETURNING *`,
      [id, user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Service request not found or not in accepted state',
      });
    }
    // Update provider availability back to available (trigger already does this, but safe)
    await pool.query(
      `UPDATE service_providers SET availability_status = 'available', current_job_id = NULL, last_status_update = NOW() WHERE provider_id = $1`,
      [user.id],
    );
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

    const result = await pool.query(
      `SELECT sr.*, mr.title, mr.description, p.title as property_title, u_provider.name as provider_name
       FROM service_requests sr
       JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       JOIN properties p ON sr.property_id = p.property_id
       LEFT JOIN users u_provider ON sr.provider_id = u_provider.user_id
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

// GET /api/service-requests/:id – get single service request details (for tracking)
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

    const result = await pool.query(
      `SELECT sr.*, mr.title, mr.description, mr.media_url,
              p.title as property_title, p.address_street, p.address_city, p.address_state,
              u_provider.name as provider_name, u_provider.phone_number as provider_phone
       FROM service_requests sr
       JOIN maintenance_requests mr ON sr.maintenance_request_id = mr.request_id
       JOIN properties p ON sr.property_id = p.property_id
       LEFT JOIN users u_provider ON sr.provider_id = u_provider.user_id
       WHERE sr.service_id = $1 AND (sr.owner_id = $2 OR sr.provider_id = $2)`,
      [id, user.id],
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Service request not found' });
    }
    res.json({ success: true, serviceRequest: result.rows[0] });
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

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
