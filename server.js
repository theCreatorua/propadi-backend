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

// Legacy simulated withdrawal (kept for compatibility)
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

    // === PUSH NOTIFICATION FOR CHAT ===
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
    // === END PUSH ===

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
// VIEWING TRACKER & TRUST AUDIT ROUTES
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

app.put('/api/viewings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

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

    await client.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1, $2, $3, $4)`,
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
        `INSERT INTO inspection_audits (viewing_id, amenity_id, is_physically_present, renter_notes)
         VALUES ($1, $2, $3, $4)`,
        [id, item.amenity_id, item.is_present, renter_notes],
      );
      if (item.is_present === false) {
        missingCount++;
      }
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

    if (totalCount === 0) {
      conclusionText = `*No specific amenities were verified.*`;
    }

    const reportContent =
      `📋 **Immutable Inspection Report**\n` +
      `Amenities Verified: ${totalCount - missingCount}/${totalCount}\n` +
      `Discrepancies Found: ${missingCount}\n` +
      `Renter's Decision: **${final_decision}**\n\n` +
      conclusionText;

    await client.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) VALUES ($1, $2, $3, $4)`,
      [v.property_id, v.renter_id, v.owner_id, reportContent],
    );

    await client.query(
      `UPDATE viewings SET status = 'Audited', updated_at = CURRENT_TIMESTAMP WHERE viewing_id = $1`,
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
      `INSERT INTO applications (property_id, renter_id, owner_id, proposed_rent, cover_letter, move_in_date, is_sight_unseen) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
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
        `INSERT INTO tenancies (application_id, property_id, renter_id, owner_id, rent_amount, rent_period, lease_start_date, lease_end_date, status, is_sight_unseen) 
         VALUES ($1, $2, $3, $4, $5, 'Per Annum', $6, $7, 'Draft', $8)`,
        [
          application.application_id,
          application.property_id,
          application.renter_id,
          application.owner_id,
          application.proposed_rent,
          sqlStartDate,
          sqlEndDate,
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
// SMART CONTRACT & PAYSTACK ESCROW ENGINE
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

app.get('/api/tenancies/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT payment_status, status FROM tenancies WHERE tenancy_id = $1`,
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
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

// Multi-party escrow verification endpoint (manual fallback)
app.post('/api/tenancies/:id/verify', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

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

      await client.query(
        `UPDATE tenancies SET payment_status = 'Paid' WHERE tenancy_id = $1`,
        [id],
      );

      const rentAmount = parseFloat(tenancy.rent_amount);
      let gatewayFee = rentAmount * 0.015 + 100;
      if (gatewayFee > 2000) gatewayFee = 2000;

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
        `UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [rentAmount, tenancy.owner_id],
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

// Paystack webhook for charge.success
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

      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) VALUES ($1, 'payment', 'Annual Rent Payment', $2, $3, 'Completed')`,
        [tenancy.renter_id, propertyTitle, -rentAmount],
      );

      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) VALUES ($1, 'fee', 'Propadi Secure Gateway Fee', 'Platform Service', $2, 'Completed')`,
        [tenancy.renter_id, -gatewayFee],
      );

      await client.query(
        `INSERT INTO transactions (user_id, type, title, property_ref, amount, status) VALUES ($1, 'credit', 'Rent Payment Received', $2, $3, 'Completed')`,
        [tenancy.owner_id, propertyTitle, rentAmount],
      );

      await client.query(
        `UPDATE wallets SET balance = balance + $1, total_earned = total_earned + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
        [rentAmount, tenancy.owner_id],
      );

      await client.query('COMMIT');
      console.log(
        `[WEBHOOK SUCCESS] Tenancy ${tenancyId} automatically funded and verified.`,
      );

      // === PUSH NOTIFICATION TO LANDLORD ===
      await sendPushToUser(
        tenancy.owner_id,
        '💰 Rent Payment Received',
        `₦${rentAmount.toLocaleString()} has been added to your wallet for ${propertyTitle}`,
        { screen: 'LandlordWallet' },
      );
      // === END PUSH ===
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

app.get('/api/tenant-wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const paidResult = await pool.query(
      `SELECT SUM(ABS(amount)) as total_paid FROM transactions WHERE user_id = $1 AND type IN ('payment', 'fee') AND status = 'Completed'`,
      [userId],
    );
    const totalPaid = paidResult.rows[0].total_paid || 0;

    const rentalsResult = await pool.query(
      `SELECT COUNT(*) as active_count FROM tenancies WHERE renter_id = $1 AND payment_status = 'Paid'`,
      [userId],
    );
    const activeRentals = rentalsResult.rows[0].active_count || 0;

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
      `SELECT renter_id, owner_id, property_id, rent_amount, lease_end_date, payment_status 
       FROM tenancies WHERE tenancy_id = $1 FOR UPDATE`,
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
      `INSERT INTO tenancies (
        property_id, renter_id, owner_id, rent_amount, rent_period,
        lease_start_date, lease_end_date, status, payment_status,
        renewal_of_tenancy_id, renewal_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Draft', 'Pending', $8, 'Pending')
      RETURNING *`,
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

    // === PUSH NOTIFICATION FOR RENEWAL OFFER ===
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
    // === END PUSH ===

    res.json({
      success: true,
      message: 'Renewal offer created. The tenant will see it in their wallet.',
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
      `SELECT t.*, p.title as property_title, p.address_street, p.address_city,
              o.name as owner_name
       FROM tenancies t
       JOIN properties p ON t.property_id = p.property_id
       JOIN users o ON t.owner_id = o.user_id
       WHERE t.renter_id = $1 
         AND t.renewal_of_tenancy_id IS NOT NULL 
         AND t.renewal_status = 'Pending'
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
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Renewal not found' });
    }
    res.json({ success: true, tenancy: result.rows[0] });
  } catch (err) {
    console.error('Accept renewal error:', err);
    res.status(500).json({ success: false, error: 'Failed to accept renewal' });
  }
});

app.get('/api/tenancies/landlord/:ownerId', async (req, res) => {
  try {
    const { ownerId } = req.params;
    console.log('Fetching tenancies for landlord:', ownerId);
    const result = await pool.query(
      `SELECT t.tenancy_id, t.rent_amount, t.lease_start_date, t.lease_end_date, t.payment_status,
              p.title as property_title, p.address_street, p.address_city,
              u.name as renter_name
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
  if (data.status) {
    return data.data.recipient_code;
  } else {
    throw new Error(data.message || 'Failed to create transfer recipient');
  }
}

app.post('/api/wallet/withdraw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, amount, bankName, bankCode, accountNumber } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount <= 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid withdrawal amount' });
    }

    const userResult = await client.query(
      'SELECT email FROM users WHERE user_id = $1',
      [userId],
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
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
       VALUES ($1, $2, $3, $4, $5, 'Processing', 'Withdrawal', 'Processing')
       RETURNING *`,
      [userId, userEmail, withdrawAmount, bankName, accountNumber],
    );
    const withdrawal = withdrawalResult.rows[0];

    await client.query(
      `INSERT INTO transactions (user_id, type, title, property_ref, amount, status)
       VALUES ($1, 'withdrawal', 'Bank Withdrawal', $2, $3, 'Pending')`,
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
          `UPDATE transactions SET status = 'Processing' 
           WHERE id = (SELECT id FROM transactions WHERE user_id = $1 AND type = 'withdrawal' AND amount = $2 ORDER BY created_at DESC LIMIT 1)`,
          [userId, -withdrawAmount],
        );
        res.json({
          success: true,
          message:
            'Withdrawal initiated successfully. Funds will be sent to your bank account shortly.',
          transfer_code: transferData.data.transfer_code,
        });
      } else {
        console.error('Paystack transfer error:', transferData);
        await pool.query(
          `UPDATE withdrawals SET transfer_status = 'Failed', failure_reason = $1, status = 'Failed' WHERE id = $2`,
          [transferData.message || 'Unknown error', withdrawal.id],
        );
        await pool.query(
          `UPDATE transactions SET status = 'Failed' 
           WHERE id = (SELECT id FROM transactions WHERE user_id = $1 AND type = 'withdrawal' AND amount = $2 ORDER BY created_at DESC LIMIT 1)`,
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
        `UPDATE transactions SET status = 'Failed' 
         WHERE id = (SELECT id FROM transactions WHERE user_id = $1 AND type = 'withdrawal' AND amount = $2 ORDER BY created_at DESC LIMIT 1)`,
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
  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).send('Invalid signature');
  }
  const event = req.body;
  if (event.event === 'transfer.success') {
    const transferCode = event.data.transfer_code;
    await pool.query(
      `UPDATE withdrawals SET transfer_status = 'Success', status = 'Completed' WHERE transfer_code = $1`,
      [transferCode],
    );
    await pool.query(
      `UPDATE transactions SET status = 'Completed' 
       WHERE user_id = (SELECT user_id FROM withdrawals WHERE transfer_code = $1) 
       AND type = 'withdrawal' ORDER BY created_at DESC LIMIT 1`,
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
// PUSH NOTIFICATIONS HELPERS & ENDPOINT
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
    if (result.errors) {
      console.error('Expo push errors:', result.errors);
    }
    // Store notification in database for history
    for (const msg of messages) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, body, data) VALUES ($1, $2, $3, $4)`,
        [userId, title, body, JSON.stringify(data)],
      );
    }
  } catch (err) {
    console.error('sendPushToUser error:', err);
  }
}

app.post('/api/notifications/register-token', async (req, res) => {
  const { userId, token } = req.body;
  if (!userId || !token) {
    return res
      .status(400)
      .json({ success: false, error: 'Missing userId or token' });
  }
  try {
    await pool.query(
      `INSERT INTO user_push_tokens (user_id, token, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (token) DO UPDATE SET updated_at = NOW()`,
      [userId, token],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Register token error:', err);
    res.status(500).json({ success: false, error: 'Failed to register token' });
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
    // TODO: Add push notification for maintenance status change when userId is known
    res.json({ success: true, ticket: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

// ==========================================
// SERVER SETUP
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
