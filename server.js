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
app.post('/api/viewings', async (req, res) => {
  try {
    const { property_id, renter_id, landlord_id, viewing_date } = req.body;

    const result = await pool.query(
      `INSERT INTO viewings (property_id, renter_id, landlord_id, viewing_date, status) 
       VALUES ($1, $2, $3, $4, 'Pending') RETURNING *`,
      [property_id, renter_id, landlord_id, viewing_date],
    );

    // Bonus: We automatically insert a "Smart Message" into the chat so both users see the request!
    await pool.query(
      `INSERT INTO messages (property_id, sender_id, receiver_id, content) 
       VALUES ($1, $2, $3, $4)`,
      [
        property_id,
        renter_id,
        landlord_id,
        `🗓️ I have requested a viewing for ${new Date(viewing_date).toLocaleString()}. Please accept or decline.`,
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
      `UPDATE viewings SET status = $1 WHERE id = $2 RETURNING *`,
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

// ======== SERVER SETUP ========
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
