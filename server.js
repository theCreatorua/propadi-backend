require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());

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

// ======== ADMIN ROUTES ========
// 1. Get all withdrawals (TYPO FIXED HERE: 'withdrawals')
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM withdrawals ORDER BY created_at DESC',
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

// ======== SERVER SETUP ========
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
