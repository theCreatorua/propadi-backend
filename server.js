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

// ======== USER ROUTES ========
// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

// 1. Sign Up a New User
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;

  try {
    // Check if the email is already taken
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [
      email,
    ]);
    if (userCheck.rows.length > 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Email is already registered' });
    }

    // Create the new user with a starting balance of ₦0
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
    // Find the user with the matching email and password
    const result = await pool.query(
      'SELECT user_id, email, name, balance FROM users WHERE email = $1 AND password = $2',
      [email, password],
    );

    if (result.rows.length === 0) {
      return res
        .status(401)
        .json({ success: false, error: 'Invalid email or password' });
    }

    // Success! Send the user data back to the mobile app
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
// 3. Deposit / Fund Vault
app.post('/api/user/deposit', async (req, res) => {
  const { userId, amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res
      .status(400)
      .json({ success: false, error: 'Please enter a valid amount' });
  }

  try {
    // 1. Add money to the user's balance
    const updateResult = await pool.query(
      'UPDATE users SET balance = balance + $1 WHERE user_id = $2 RETURNING balance',
      [amount, userId],
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // 2. NEW: Log this deposit in the master ledger!
    const insertResult = await pool.query(
      'INSERT INTO withdrawals (user_id, amount, status, type) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, amount, 'Paid', 'Deposit'],
    );

    res.json({
      success: true,
      message: 'Vault funded successfully!',
      newBalance: updateResult.rows[0].balance,
      transaction: insertResult.rows[0], // Send the new receipt back to the app
    });
  } catch (err) {
    console.error('Deposit Error:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to process deposit' });
  }
});

// 4. Request Withdrawal
// 4. Request Withdrawal (UPGRADED WITH BANK DETAILS)
app.post('/api/user/withdraw', async (req, res) => {
  // Catch the new bankName and accountNumber from the app
  const { userId, amount, email, bankName, accountNumber } = req.body;

  if (!amount || isNaN(amount) || amount <= 0) {
    return res
      .status(400)
      .json({ success: false, error: 'Please enter a valid amount' });
  }

  // Safety check: ensure bank details were actually sent
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

    // Insert the new bank details into the database!
    const insertResult = await pool.query(
      `INSERT INTO withdrawals 
      (user_id, email, amount, bank_name, account_number, status, type) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
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
    // We fetch the email and balance directly from the users table
    const result = await pool.query(
      'SELECT email, balance FROM users WHERE user_id = $1',
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      user: result.rows[0],
    });
  } catch (err) {
    console.error('Profile Fetch Error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

// Request a new withdrawal
app.post('/api/user/withdrawals', async (req, res) => {
  const { user_id, amount, email } = req.body;

  try {
    // Insert the new request into the database with a 'Pending' status
    const result = await pool.query(
      "INSERT INTO withdrawals (user_id, amount, status, email) VALUES ($1, $2, 'Pending', $3) RETURNING *",
      [user_id, amount, email],
    );

    res.json({
      success: true,
      message: 'Withdrawal requested successfully',
      data: result.rows[0],
    });
  } catch (err) {
    console.error('Error creating withdrawal:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to request withdrawal' });
  }
});

// ======== PROPERTIES ROUTES ========
// GET ALL PROPERTIES (For the Public Home Feed)
app.get('/api/properties', async (req, res) => {
  try {
    // Fetches all properties, newest first. Limit to 50 to keep the app blazing fast.
    const result = await pool.query(
      `SELECT * FROM properties ORDER BY property_id DESC LIMIT 50`,
    );

    res.json({ success: true, properties: result.rows });
  } catch (err) {
    console.error('Error fetching all properties:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch properties' });
  }
});
// Get all properties for a specific user (including their amenities)
app.get('/api/properties/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `SELECT 
        p.*, 
        COALESCE(
          json_agg(a.amenity_name) FILTER (WHERE a.amenity_name IS NOT NULL), 
          '[]'
        ) as amenities 
       FROM properties p 
       LEFT JOIN properties_amenities a ON p.property_id = a.property_id 
       -- WHERE p.owner_id = $1 -- Uncomment this later to filter by actual owner!
       GROUP BY p.property_id 
       ORDER BY p.date_listed DESC`,
      // [userId] -- Uncomment this when you start filtering by owner!
    );

    res.json({ success: true, properties: result.rows });
  } catch (err) {
    console.error('Error fetching properties:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch properties' });
  }
});
// GET A SINGLE PROPERTY BY ID
app.get('/api/properties/detail/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM properties WHERE property_id = $1',
      [id],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'Property not found' });
    }

    res.json({ success: true, property: result.rows[0] });
  } catch (err) {
    console.error('Error fetching single property:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch property' });
  }
});
// Add a new Property WITH Image Upload & Amenities
app.post('/api/properties', async (req, res) => {
  const {
    owner_id,
    title,
    description,
    category,
    furnishing_status,
    rent_price,
    rent_period,
    total_beds,
    total_baths,
    total_kitchens,
    total_stores,
    address_street,
    address_city,
    address_lga,
    address_state,
    amenities,
    image_base64, // <-- NEW: Catching the image data
  } = req.body;

  try {
    let finalImageUrl =
      'https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=800&q=80'; // Fallback

    // 1. IF AN IMAGE WAS UPLOADED, SAVE IT TO SUPABASE STORAGE FIRST
    if (image_base64) {
      // Convert the base64 string back into a real file buffer
      const buffer = Buffer.from(image_base64, 'base64');
      const fileName = `prop_${Date.now()}.jpg`; // Creates a unique name

      // Upload to the bucket we just created
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('property-images')
        .upload(fileName, buffer, { contentType: 'image/jpeg' });

      if (uploadError) throw uploadError;

      // Get the public URL of the uploaded image
      const { data: publicUrlData } = supabase.storage
        .from('property-images')
        .getPublicUrl(fileName);

      finalImageUrl = publicUrlData.publicUrl;
    }

    // 2. INSERT THE PROPERTY INTO THE DATABASE (Now using finalImageUrl)
    const propertyResult = await pool.query(
      `INSERT INTO properties (
        owner_id, title, description, category, furnishing_status,
        rent_price, rent_period, total_beds, total_baths, total_kitchens, total_stores,
        address_street, address_city, address_lga, address_state, main_image_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [
        owner_id || '00000000-0000-0000-0000-000000000000',
        title,
        description,
        category,
        furnishing_status,
        rent_price,
        rent_period,
        total_beds,
        total_baths,
        total_kitchens,
        total_stores,
        address_street,
        address_city,
        address_lga,
        address_state,
        finalImageUrl,
      ],
    );

    const newProperty = propertyResult.rows[0];

    // 3. INSERT AMENITIES
    if (amenities && amenities.length > 0) {
      const amenityQueries = amenities.map((amenity) => {
        return pool.query(
          `INSERT INTO properties_amenities (property_id, amenity_name) VALUES ($1, $2)`,
          [newProperty.property_id, amenity],
        );
      });
      await Promise.all(amenityQueries);
    }

    res.json({ success: true, property: newProperty });
  } catch (err) {
    console.error('Error adding property:', err);
    res.status(500).json({ success: false, error: 'Failed to add property' });
  }
});

// ======== ADMIN ROUTES ========
// 1. Get all withdrawals (TYPO FIXED HERE: 'withdrawals')
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    // Find your Admin fetch route and update the pool.query to this:

    const result = await pool.query(
      "SELECT * FROM withdrawals WHERE type = 'Withdrawal' ORDER BY created_at DESC",
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching withdrawals:', err);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// 2. Mark withdrawal as Paid and send email
// 2. Mark withdrawal as Paid, DEDUCT BALANCE, and send email
app.put('/api/admin/withdrawals/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    // 1. Get the withdrawal details FIRST so we know how much to deduct
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

    // 2. Update the withdrawal status in the database
    const updateResult = await pool.query(
      'UPDATE withdrawals SET status = $1 WHERE id = $2 RETURNING *',
      [status, id],
    );

    // 3. THE BUSINESS LOGIC: Deduct money ONLY if marked as 'Paid'
    if (status === 'Paid') {
      // Deduct the exact amount from the user's vault balance
      // (Using user_id to find the correct user account)
      await pool.query(
        'UPDATE users SET balance = balance - $1 WHERE user_id = $2',
        [withdrawal.amount, withdrawal.user_id],
      );

      // Send the beautiful success email
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

// --- MESSAGING ROUTES ---

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
      [property_id, user1_id, user2_id, user1_id, user2_id],
    );

    res.json({ success: true, messages: result.rows });
  } catch (err) {
    console.error('Error fetching messages:', err);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch chat history' });
  }
});

// ======== SERVER SETUP ========
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
