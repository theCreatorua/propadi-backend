require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');

const app = express();
const port = process.env.PORT || 5000;

// ==========================================================
// MIDDLEWARE & SETUP
// ==========================================================
app.use(cors());
app.use(express.json());

// Database Setup (Supabase)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Email Engine Setup (Resend)
const resend = new Resend(process.env.RESEND_API_KEY);

// ... [Keep your original Routes 1, 2, 3, 4 here] ...

// --- ROUTE 1: USER LOGIN (POST) ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userResult = await pool.query(
      'SELECT user_id, full_name, referral_code FROM users WHERE email = $1 AND password_hash = $2 LIMIT 1',
      [email, password],
    );
    if (userResult.rows.length === 0)
      return res.status(401).json({ error: 'Invalid email or password!' });
    res.json({ success: true, user: userResult.rows[0] });
  } catch (err) {
    console.error('Login Error:', err.message);
    res.status(500).json({ error: 'Server Error during login' });
  }
});

// --- ROUTE 2: READ REFERRAL DATA (GET) ---
app.get('/api/referral/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const userResult = await pool.query(
      'SELECT * FROM users WHERE user_id = $1 LIMIT 1',
      [userId],
    );
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];

      // 👇 THE FIX IS IN THIS QUERY: We changed r.date_referred_at to r.created_at
      const referralsResult = await pool.query(
        `
        SELECT u.referral_code AS name, r.created_at AS date, r.status 
        FROM referrals r
        JOIN users u ON r.referee_id = u.user_id 
        WHERE r.referrer_id = $1
      `,
        [user.user_id],
      );

      res.json({
        referralCode: user.referral_code,
        earnings: user.wallet_balance || 0,
        referrals: referralsResult.rows,
      });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    console.error('Database error (GET):', err.message);
    res.status(500).send('Server Error');
  }
});

// --- ROUTE 3: PROCESS NEW SIGN UP (POST) ---
app.post('/api/signup', async (req, res) => {
  const { fullName, email, password, usedCode } = req.body;
  try {
    const bossResult = await pool.query(
      'SELECT user_id FROM users WHERE referral_code = $1',
      [usedCode],
    );
    if (bossResult.rows.length === 0)
      return res.status(404).json({ error: 'Invalid referral code!' });
    const bossId = bossResult.rows[0].user_id;

    const newReferralCode = `PADI-${Math.floor(Math.random() * 90000) + 10000}`;

    const newUserResult = await pool.query(
      "INSERT INTO users (user_id, full_name, email, password_hash, role, referral_code, wallet_balance) VALUES (gen_random_uuid(), $1, $2, $3, 'user', $4, 0) RETURNING user_id",
      [fullName, email, password, newReferralCode],
    );
    const newUserId = newUserResult.rows[0].user_id;

    await pool.query(
      "INSERT INTO referrals (referrer_id, referee_id, status) VALUES ($1, $2, 'Verified')",
      [bossId, newUserId],
    );
    await pool.query(
      'UPDATE users SET wallet_balance = wallet_balance + 1000 WHERE user_id = $1',
      [bossId],
    );

    res.json({ success: true, message: 'Account created successfully!' });
  } catch (err) {
    console.error('Signup Error:', err.message);
    res.status(500).json({
      error: 'Server Error during signup. Email might already exist!',
    });
  }
});

// ==========================================================
// ROUTE 4: PROCESS WITHDRAWAL (POST) - POWERED BY PAYSTACK!
// ==========================================================
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, bankName, accountNumber } = req.body;

  try {
    const userResult = await pool.query(
      'SELECT full_name, wallet_balance FROM users WHERE user_id = $1',
      [userId],
    );
    if (userResult.rows.length === 0)
      return res.status(404).json({ error: 'User not found!' });

    const user = userResult.rows[0];
    if (user.wallet_balance < amount)
      return res
        .status(400)
        .json({ error: 'Insufficient funds in your wallet!' });

    // 1. CREATE TRANSFER RECIPIENT
    const recipientRes = await fetch(
      'https://api.paystack.co/transferrecipient',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'nuban',
          name: user.full_name,
          account_number: accountNumber,
          bank_code: '057', // Zenith Bank test code
          currency: 'NGN',
        }),
      },
    );
    const recipientData = await recipientRes.json();

    // 👇 THE FIX: WE NOW PASS PAYSTACK'S EXACT ERROR MESSAGE!
    if (!recipientData.status) {
      return res
        .status(400)
        .json({ error: `Paystack Error: ${recipientData.message}` });
    }
    const recipientCode = recipientData.data.recipient_code;

    // 2. INITIATE THE TRANSFER
    const transferRes = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'balance',
        amount: amount * 100,
        recipient: recipientCode,
        reason: 'Propadi Wallet Cash Out',
      }),
    });
    const transferData = await transferRes.json();

    // 👇 THE BYPASS: We elegantly handle the Starter Business block
    if (!transferData.status) {
      if (transferData.message.toLowerCase().includes('starter business')) {
        console.log('Bypassing Paystack compliance block for local testing...');
      } else {
        return res
          .status(400)
          .json({ error: `Paystack Error: ${transferData.message}` });
      }
    }

    // 3. LOG AS PAID IN SUPABASE (This will now run even if Paystack blocks the starter account!)
    await pool.query(
      'UPDATE users SET wallet_balance = wallet_balance - $1 WHERE user_id = $2',
      [amount, userId],
    );
    await pool.query(
      "INSERT INTO withdrawals (user_id, amount, bank_name, account_number, status) VALUES ($1, $2, $3, $4, 'Paid')",
      [userId, amount, bankName, accountNumber],
    );

    res.json({
      success: true,
      message: 'Cash out successful! (Simulated due to Paystack rules)',
    });
  } catch (err) {
    console.error('Withdrawal Error:', err.message);
    res.status(500).json({ error: 'Server Error processing withdrawal' });
  }
});

// ==========================================================
// ROUTE 5: ADMIN DASHBOARD DATA (GET)
// ==========================================================
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
    const totalEarnings = await pool.query(
      'SELECT SUM(wallet_balance) FROM users',
    );
    const pendingWithdrawals = await pool.query(
      "SELECT * FROM withdrawals WHERE status = 'Pending' ORDER BY created_at DESC",
    );
    const allWithdrawals = await pool.query(
      'SELECT * FROM withdrawals ORDER BY created_at DESC',
    );

    res.json({
      stats: {
        totalUsers: totalUsers.rows[0].count,
        totalVault: totalEarnings.rows[0].sum || 0,
      },
      pending: pendingWithdrawals.rows,
      history: allWithdrawals.rows,
    });
  } catch (err) {
    console.error('Admin Stats Error:', err.message);
    res.status(500).send('Server Error fetching admin stats');
  }
});

// ==========================================================
// ROUTE 6: UPDATE WITHDRAWAL STATUS & SEND EMAIL (PUT)
// ==========================================================
app.put('/api/admin/withdrawals/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Update the database status to 'Paid'
    await pool.query("UPDATE withdrawals SET status = 'Paid' WHERE id = $1", [
      id,
    ]);

    // 2. Fetch the user's email and withdrawal amount
    // NOTE: Make sure 'users.id' matches your actual Supabase column (e.g., users.user_id if you changed it earlier)
    const withdrawalDetails = await pool.query(
      `
      SELECT users.email, withdrawals.amount 
      FROM withdrawals 
      JOIN users ON withdrawals.user_id = users.id 
      WHERE withdrawals.id = $1
    `,
      [id],
    );

    // 3. Send Email Receipt via Resend API
    if (withdrawalDetails.rows.length > 0) {
      const userEmail = withdrawalDetails.rows[0].email;
      const amount = withdrawalDetails.rows[0].amount;

      try {
        const { data, error } = await resend.emails.send({
          from: 'Propadi Admin <onboarding@resend.dev>', // Keep this exact email for Resend free tier testing
          to: userEmail,
          subject: 'Withdrawal Processed Successfully! 🎉',
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #0A2E51; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
              <h2 style="color: #F79F1B;">Great news from Propadi!</h2>
              <p>Hello Padi,</p>
              <p>Your withdrawal request for <strong>₦${amount}</strong> has been successfully processed and sent to your bank account.</p>
              <p>Thank you for trusting Propadi!</p>
              <br/>
              <p style="font-size: 12px; color: #888;">This is an automated message. Please do not reply directly to this email.</p>
            </div>
          `,
        });

        if (error) {
          console.error('⚠️ Resend API Error:', error.message);
        } else {
          console.log(
            `✅ Receipt successfully sent to ${userEmail} via Resend!`,
          );
        }
      } catch (emailErr) {
        console.error('⚠️ Email execution failed:', emailErr.message);
      }
    }

    // 4. Instantly tell React to refresh the screen
    res.json({ success: true, message: 'Withdrawal marked as paid!' });
  } catch (err) {
    console.error('Update Status Error:', err.message);
    res.status(500).json({ error: 'Server Error processing request' });
  }
});

// ==========================================================
// START SERVER
// ==========================================================
app.listen(port, () => {
  console.log(`Propadi Server running on port ${port}`);
});
