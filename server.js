const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const africastalking = require('africastalking');
require('dotenv').config();

const db = require('./db');
const app = express();

const allowedOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(',').map((origin) => origin.trim())
  : true;

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));

let sms = null;
if (process.env.AT_API_KEY && !process.env.AT_API_KEY.includes('your_africas_talking')) {
  const at = africastalking({
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME,
  });
  sms = at.SMS;
  console.log("Africa's Talking SMS initialized.");
} else {
  console.warn("Africa's Talking SMS is not configured.");
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied.' });

  jwt.verify(token, process.env.JWT_SECRET, (error, user) => {
    if (error) return res.status(403).json({ error: 'Invalid token.' });
    req.user = user;
    next();
  });
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions.' });
  }
  next();
};

const toAmount = (value) => Number(Number(value || 0).toFixed(2));

const ledgerTotal = (ledger) => toAmount(
  toAmount(ledger.rent_due)
  + toAmount(ledger.utilities_water)
  + toAmount(ledger.utilities_electricity)
  + toAmount(ledger.utilities_garbage)
  + toAmount(ledger.penalty_fee)
);

const paymentStatus = (total, paid) => {
  if (paid > total) return 'overpaid';
  if (paid === total) return 'paid';
  if (paid > 0) return 'partial';
  return 'unpaid';
};

const kenyaMonthStart = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-01`;
};

const isBillingMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(value);
const invoiceNumber = (tenancyId, billingMonth) => `KAN-${billingMonth.slice(0, 7).replace('-', '')}-${tenancyId}`;
const dueDate = (billingMonth) => `${billingMonth.slice(0, 7)}-05`;

const createOrUpdateInvoice = async (client, ledger) => {
  const billingMonth = String(ledger.billing_month).slice(0, 10);
  const total = ledgerTotal(ledger);
  const paid = toAmount(ledger.amount_paid);
  const balance = toAmount(total - paid);
  const status = paymentStatus(total, paid);

  const result = await client.query(
    `INSERT INTO invoices (
      tenancy_id, ledger_id, invoice_number, billing_month, due_date,
      rent_due, utilities_water, utilities_electricity, utilities_garbage,
      penalty_fee, amount_paid, balance, status
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13
    )
    ON CONFLICT (tenancy_id, billing_month) DO UPDATE SET
      ledger_id = EXCLUDED.ledger_id,
      rent_due = EXCLUDED.rent_due,
      utilities_water = EXCLUDED.utilities_water,
      utilities_electricity = EXCLUDED.utilities_electricity,
      utilities_garbage = EXCLUDED.utilities_garbage,
      penalty_fee = EXCLUDED.penalty_fee,
      amount_paid = EXCLUDED.amount_paid,
      balance = EXCLUDED.balance,
      status = EXCLUDED.status
    RETURNING *`,
    [
      ledger.tenancy_id,
      ledger.id,
      invoiceNumber(ledger.tenancy_id, billingMonth),
      billingMonth,
      dueDate(billingMonth),
      toAmount(ledger.rent_due),
      toAmount(ledger.utilities_water),
      toAmount(ledger.utilities_electricity),
      toAmount(ledger.utilities_garbage),
      toAmount(ledger.penalty_fee),
      paid,
      balance,
      status,
    ]
  );

  return result.rows[0];
};

const issueMonthlyInvoices = async (billingMonth) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const tenancies = await client.query(
      `SELECT t.id AS tenancy_id, p.base_rent
       FROM tenancies t
       JOIN properties p ON p.id = t.property_id
       WHERE t.status = 'active'`
    );

    const invoices = [];
    for (const tenancy of tenancies.rows) {
      await client.query(
        `INSERT INTO ledgers (tenancy_id, billing_month, rent_due, status)
         VALUES ($1, $2, $3, 'unpaid')
         ON CONFLICT (tenancy_id, billing_month) DO NOTHING`,
        [tenancy.tenancy_id, billingMonth, tenancy.base_rent]
      );
      const ledger = await client.query(
        `SELECT * FROM ledgers
         WHERE tenancy_id = $1 AND billing_month = $2
         FOR UPDATE`,
        [tenancy.tenancy_id, billingMonth]
      );
      invoices.push(await createOrUpdateInvoice(client, ledger.rows[0]));
    }

    await client.query('COMMIT');
    return invoices;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const findInvoiceForTenant = async (client, tenantId, invoiceId) => {
  const invoice = await client.query(
    `SELECT i.id, i.ledger_id
     FROM invoices i
     JOIN tenancies t ON t.id = i.tenancy_id
     WHERE i.id = $1 AND t.tenant_id = $2 AND t.status = 'active'`,
    [invoiceId, tenantId]
  );
  return invoice.rows[0];
};

app.post('/api/auth/request-otp', async (req, res) => {
  const { phone_number: phoneNumber } = req.body;
  try {
    const userResult = await db.query(
      "SELECT id FROM users WHERE phone_number = $1 AND role = 'tenant'",
      [phoneNumber]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Phone number not registered.' });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await db.query(
      'INSERT INTO otps (user_id, code, expires_at) VALUES ($1, $2, $3)',
      [userResult.rows[0].id, otp, expiresAt]
    );

    if (!sms) {
      return res.status(503).json({ error: 'OTP messaging is unavailable. Please contact the property manager.' });
    }

    try {
      await sms.send({
        to: [phoneNumber],
        message: `Your Kandaria Rent Management OTP is: ${otp}`,
        from: process.env.AT_SENDER_ID || 'AT',
      });
      res.json({ message: 'OTP sent successfully.' });
    } catch (error) {
      console.error('OTP SMS failed:', error.message);
      res.status(503).json({ error: 'OTP could not be delivered. Please try again later.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send OTP.' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone_number: phoneNumber, otp } = req.body;
  try {
    const result = await db.query(
      `SELECT o.user_id, u.full_name, u.role
       FROM otps o
       JOIN users u ON u.id = o.user_id
       WHERE u.phone_number = $1 AND o.code = $2 AND o.expires_at > NOW()
       ORDER BY o.created_at DESC
       LIMIT 1`,
      [phoneNumber, otp]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    await db.query('DELETE FROM otps WHERE user_id = $1', [result.rows[0].user_id]);
    const user = result.rows[0];
    const token = jwt.sign({ id: user.user_id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.user_id, full_name: user.full_name, role: user.role } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

app.post('/api/auth/caretaker-login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const result = await db.query(
      "SELECT * FROM users WHERE phone_number = $1 AND role IN ('caretaker', 'landlord', 'accountant')",
      [phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found.' });

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, full_name: user.full_name, role: user.role } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/caretaker/onboard', authenticateToken, requireRole('caretaker', 'landlord', 'accountant'), async (req, res) => {
  const {
    full_name: fullName,
    id_number: idNumber,
    phone_number: phoneNumber,
    emergency_contact: emergencyContact,
    move_in_date: moveInDate,
    location,
    plot_name: plotName,
    house_number: houseNumber,
    house_type: houseType,
    rent_amount: rentAmount,
    deposit_amount: depositAmount,
  } = req.body;
  const rent = toAmount(rentAmount);

  if (!fullName || !phoneNumber || !moveInDate || !location || !plotName || !houseNumber || rent <= 0) {
    return res.status(400).json({ error: 'Complete all required tenant and property details.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      "INSERT INTO users (full_name, phone_number, id_number, emergency_contact, role) VALUES ($1, $2, $3, $4, 'tenant') RETURNING id",
      [fullName, phoneNumber, idNumber || null, emergencyContact || null]
    );
    const propertyResult = await client.query(
      "INSERT INTO properties (location, plot_name, house_number, house_type, base_rent, status) VALUES ($1, $2, $3, $4, $5, 'occupied') RETURNING id",
      [location, plotName, houseNumber, houseType || null, rent]
    );
    const tenancyResult = await client.query(
      "INSERT INTO tenancies (tenant_id, property_id, start_date, deposit_amount, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id",
      [userResult.rows[0].id, propertyResult.rows[0].id, moveInDate, toAmount(depositAmount)]
    );
    const billingMonth = kenyaMonthStart();
    const ledgerResult = await client.query(
      "INSERT INTO ledgers (tenancy_id, billing_month, rent_due, status) VALUES ($1, $2, $3, 'unpaid') RETURNING *",
      [tenancyResult.rows[0].id, billingMonth, rent]
    );
    await createOrUpdateInvoice(client, ledgerResult.rows[0]);
    await client.query('COMMIT');

    if (sms) {
      sms.send({
        to: [phoneNumber],
        message: `Welcome to Kandaria Properties. Your rent account for ${houseNumber} is active. Log in to the Tenant Portal to view your invoice and balance.`,
        from: process.env.AT_SENDER_ID || 'AT',
      }).catch((error) => console.error('Welcome SMS failed:', error.message));
    }

    res.status(201).json({ message: 'Tenant onboarded and first invoice issued.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Failed to onboard tenant.' });
  } finally {
    client.release();
  }
});

app.get('/api/tenant/ledger', authenticateToken, requireRole('tenant'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT l.*, p.house_number, p.location, i.id AS invoice_id, i.invoice_number, i.due_date,
              COALESCE((
                SELECT SUM(GREATEST(previous_ledger.balance, 0))
                FROM ledgers previous_ledger
                WHERE previous_ledger.tenancy_id = l.tenancy_id
                  AND previous_ledger.billing_month < l.billing_month
              ), 0) AS arrears,
              COALESCE((
                SELECT SUM(all_ledger.balance)
                FROM ledgers all_ledger
                WHERE all_ledger.tenancy_id = l.tenancy_id
              ), 0) AS account_balance
       FROM ledgers l
       JOIN tenancies t ON t.id = l.tenancy_id
       JOIN properties p ON p.id = t.property_id
       LEFT JOIN invoices i ON i.ledger_id = l.id
       WHERE t.tenant_id = $1 AND t.status = 'active'
       ORDER BY l.billing_month DESC
       LIMIT 1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No current bill found.' });

    const ledger = result.rows[0];
    const total = ledgerTotal(ledger);
    res.json({
      house_number: ledger.house_number,
      location: ledger.location,
      rent: toAmount(ledger.rent_due),
      water: toAmount(ledger.utilities_water),
      electricity: toAmount(ledger.utilities_electricity),
      garbage: toAmount(ledger.utilities_garbage),
      penalties: toAmount(ledger.penalty_fee),
      amount_paid: toAmount(ledger.amount_paid),
      current_balance: toAmount(ledger.balance),
      arrears: toAmount(ledger.arrears),
      total_due: Math.max(toAmount(ledger.account_balance), 0),
      status: ledger.status,
      month: new Date(`${String(ledger.billing_month).slice(0, 10)}T00:00:00`).toLocaleDateString('en-KE', { month: 'long', year: 'numeric' }),
      due_date: ledger.due_date,
      invoice_id: ledger.invoice_id,
      invoice_number: ledger.invoice_number,
      total_charges: total,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch current balance.' });
  }
});

app.get('/api/tenant/invoices', authenticateToken, requireRole('tenant'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.id, i.invoice_number, i.billing_month, i.issued_at, i.due_date, i.balance, i.status,
              p.house_number, p.location,
              latest_delivery.status AS delivery_status, latest_delivery.sent_at AS delivered_at
       FROM invoices i
       JOIN tenancies t ON t.id = i.tenancy_id
       JOIN properties p ON p.id = t.property_id
       LEFT JOIN LATERAL (
         SELECT status, sent_at
         FROM invoice_deliveries
         WHERE invoice_id = i.id
         ORDER BY sent_at DESC
         LIMIT 1
       ) latest_delivery ON true
       WHERE t.tenant_id = $1
       ORDER BY i.billing_month DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch invoices.' });
  }
});

app.get('/api/tenant/invoices/:id', authenticateToken, requireRole('tenant'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT i.*, u.full_name, u.phone_number, p.location, p.plot_name, p.house_number, p.house_type
       FROM invoices i
       JOIN tenancies t ON t.id = i.tenancy_id
       JOIN users u ON u.id = t.tenant_id
       JOIN properties p ON p.id = t.property_id
       WHERE i.id = $1 AND t.tenant_id = $2`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch invoice.' });
  }
});

app.post('/api/payments/upload-proof', authenticateToken, requireRole('tenant'), async (req, res) => {
  const { amount, proof_url: proofUrl, invoice_id: invoiceId, mpesa_code: mpesaCode } = req.body;
  const paymentAmount = toAmount(amount);
  let parsedProofUrl;

  try {
    parsedProofUrl = new URL(proofUrl);
  } catch {
    return res.status(400).json({ error: 'A valid payment proof link is required.' });
  }
  if (paymentAmount <= 0 || parsedProofUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Enter a valid payment amount and HTTPS proof link.' });
  }
  if (mpesaCode && String(mpesaCode).trim().length > 30) {
    return res.status(400).json({ error: 'Transaction reference is too long.' });
  }

  const client = await db.getClient();
  try {
    let invoice;
    if (invoiceId) {
      invoice = await findInvoiceForTenant(client, req.user.id, invoiceId);
    } else {
      const latestInvoice = await client.query(
        `SELECT i.id, i.ledger_id
         FROM invoices i
         JOIN tenancies t ON t.id = i.tenancy_id
         WHERE t.tenant_id = $1 AND t.status = 'active'
         ORDER BY i.billing_month DESC
         LIMIT 1`,
        [req.user.id]
      );
      invoice = latestInvoice.rows[0];
    }
    if (!invoice) return res.status(404).json({ error: 'No active invoice found.' });

    const tenancy = await client.query(
      "SELECT id FROM tenancies WHERE tenant_id = $1 AND status = 'active'",
      [req.user.id]
    );
    await client.query(
      `INSERT INTO payments (tenancy_id, ledger_id, amount, payment_date, proof_image_url, mpesa_code, status, method)
       VALUES ($1, $2, $3, NOW(), $4, $5, 'pending', 'M-Pesa')`,
      [tenancy.rows[0].id, invoice.ledger_id, paymentAmount, parsedProofUrl.toString(), mpesaCode?.trim() || null]
    );
    res.status(201).json({ message: 'Payment proof submitted for review.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to upload proof.' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/tenants', authenticateToken, requireRole('landlord', 'accountant'), async (req, res) => {
  const { location } = req.query;
  try {
    const params = [kenyaMonthStart()];
    let locationFilter = '';
    if (location && location !== 'All') {
      params.push(location);
      locationFilter = `AND p.location = $${params.length}`;
    }

    const result = await db.query(
      `SELECT p.location AS property, p.house_number, u.full_name AS name, u.phone_number,
              p.base_rent AS expected_monthly, COALESCE(l.rent_due, p.base_rent) AS rent_due,
              COALESCE(l.rent_due, p.base_rent)
                + COALESCE(l.utilities_water, 0)
                + COALESCE(l.utilities_electricity, 0)
                + COALESCE(l.utilities_garbage, 0)
                + COALESCE(l.penalty_fee, 0)
                - COALESCE(l.amount_paid, 0) AS balance,
              COALESCE(l.status, 'unpaid') AS ledger_status, l.billing_month
       FROM tenancies t
       JOIN users u ON u.id = t.tenant_id
       JOIN properties p ON p.id = t.property_id
       LEFT JOIN ledgers l ON l.tenancy_id = t.id AND l.billing_month = $1
       WHERE t.status = 'active' ${locationFilter}
       ORDER BY p.location, p.house_number`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch tenants.' });
  }
});

app.get('/api/admin/payments/pending', authenticateToken, requireRole('landlord', 'accountant', 'caretaker'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pay.id, pay.amount, pay.payment_date, pay.proof_image_url, pay.method, pay.mpesa_code,
              u.full_name, u.phone_number, p.house_number, i.invoice_number
       FROM payments pay
       JOIN tenancies t ON t.id = pay.tenancy_id
       JOIN users u ON u.id = t.tenant_id
       JOIN properties p ON p.id = t.property_id
       LEFT JOIN invoices i ON i.ledger_id = pay.ledger_id
       WHERE pay.status = 'pending'
       ORDER BY pay.payment_date DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch pending payments.' });
  }
});

app.patch('/api/admin/payments/:id/verify', authenticateToken, requireRole('landlord', 'accountant', 'caretaker'), async (req, res) => {
  const { status } = req.body;
  if (!['verified', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const paymentResult = await client.query(
      'SELECT * FROM payments WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const payment = paymentResult.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found.' });
    }
    if (payment.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Payment has already been reviewed.' });
    }

    if (status === 'rejected') {
      await client.query(
        "UPDATE payments SET status = 'rejected', verified_by = $1, verified_at = NOW() WHERE id = $2",
        [req.user.id, payment.id]
      );
      await client.query('COMMIT');
      return res.json({ message: 'Payment rejected.' });
    }

    let ledgerResult;
    if (payment.ledger_id) {
      ledgerResult = await client.query('SELECT * FROM ledgers WHERE id = $1 FOR UPDATE', [payment.ledger_id]);
    } else {
      ledgerResult = await client.query(
        `SELECT * FROM ledgers
         WHERE tenancy_id = $1
         ORDER BY billing_month DESC
         LIMIT 1
         FOR UPDATE`,
        [payment.tenancy_id]
      );
    }
    if (ledgerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No ledger is available for this payment.' });
    }

    const ledger = ledgerResult.rows[0];
    const newPaidAmount = toAmount(toAmount(ledger.amount_paid) + toAmount(payment.amount));
    const newStatus = paymentStatus(ledgerTotal(ledger), newPaidAmount);
    const updatedLedger = await client.query(
      'UPDATE ledgers SET amount_paid = $1, status = $2 WHERE id = $3 RETURNING *',
      [newPaidAmount, newStatus, ledger.id]
    );
    await client.query(
      "UPDATE payments SET status = 'verified', ledger_id = $1, verified_by = $2, verified_at = NOW() WHERE id = $3",
      [ledger.id, req.user.id, payment.id]
    );
    await createOrUpdateInvoice(client, updatedLedger.rows[0]);
    await client.query('COMMIT');
    res.json({ message: 'Payment verified and balance updated.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Failed to update payment.' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/invoices/issue', authenticateToken, requireRole('landlord', 'accountant'), async (req, res) => {
  const billingMonth = req.body.billing_month || kenyaMonthStart();
  if (!isBillingMonth(billingMonth)) {
    return res.status(400).json({ error: 'Billing month must use YYYY-MM-01.' });
  }
  try {
    const invoices = await issueMonthlyInvoices(billingMonth);
    res.json({ message: `${invoices.length} invoices are ready.`, invoices });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to issue invoices.' });
  }
});

app.get('/api/admin/invoices', authenticateToken, requireRole('landlord', 'accountant'), async (req, res) => {
  const { billing_month: billingMonth, location, status } = req.query;
  const params = [];
  const filters = [];
  if (billingMonth) {
    if (!isBillingMonth(billingMonth)) return res.status(400).json({ error: 'Billing month must use YYYY-MM-01.' });
    params.push(billingMonth);
    filters.push(`i.billing_month = $${params.length}`);
  }
  if (location && location !== 'All') {
    params.push(location);
    filters.push(`p.location = $${params.length}`);
  }
  if (status && status !== 'All') {
    if (!['unpaid', 'partial', 'paid', 'overpaid'].includes(status)) return res.status(400).json({ error: 'Invalid invoice status.' });
    params.push(status);
    filters.push(`i.status = $${params.length}`);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT i.*, u.full_name, u.phone_number, p.location, p.house_number,
              latest_delivery.status AS delivery_status, latest_delivery.sent_at AS delivered_at
       FROM invoices i
       JOIN tenancies t ON t.id = i.tenancy_id
       JOIN users u ON u.id = t.tenant_id
       JOIN properties p ON p.id = t.property_id
       LEFT JOIN LATERAL (
         SELECT status, sent_at
         FROM invoice_deliveries
         WHERE invoice_id = i.id
         ORDER BY sent_at DESC
         LIMIT 1
       ) latest_delivery ON true
       ${whereClause}
       ORDER BY i.billing_month DESC, p.location, p.house_number`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch invoices.' });
  }
});

app.post('/api/admin/invoices/:id/send', authenticateToken, requireRole('landlord', 'accountant'), async (req, res) => {
  try {
    const invoiceResult = await db.query(
      `SELECT i.id, i.invoice_number, i.billing_month, i.due_date, i.balance, u.phone_number
       FROM invoices i
       JOIN tenancies t ON t.id = i.tenancy_id
       JOIN users u ON u.id = t.tenant_id
       WHERE i.id = $1`,
      [req.params.id]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });

    if (!sms) {
      await db.query(
        `INSERT INTO invoice_deliveries (invoice_id, channel, recipient, status, error_message)
         VALUES ($1, 'sms', $2, 'unavailable', $3)`,
        [invoice.id, invoice.phone_number, 'Africa’s Talking SMS is not configured.']
      );
      return res.status(503).json({ error: 'SMS delivery is not configured. The invoice remains available in the tenant portal.' });
    }

    try {
      const result = await sms.send({
        to: [invoice.phone_number],
        message: `Kandaria invoice ${invoice.invoice_number} for ${String(invoice.billing_month).slice(0, 7)} is ready. Balance: KES ${toAmount(invoice.balance).toLocaleString()}. Due: ${String(invoice.due_date).slice(0, 10)}. Log in to the Tenant Portal to view or print it.`,
        from: process.env.AT_SENDER_ID || 'AT',
      });
      const providerRef = result?.SMSMessageData?.Recipients?.[0]?.messageId || null;
      await db.query(
        `INSERT INTO invoice_deliveries (invoice_id, channel, recipient, status, provider_ref)
         VALUES ($1, 'sms', $2, 'accepted', $3)`,
        [invoice.id, invoice.phone_number, providerRef]
      );
      res.json({ message: 'Invoice notification accepted for SMS delivery.' });
    } catch (error) {
      await db.query(
        `INSERT INTO invoice_deliveries (invoice_id, channel, recipient, status, error_message)
         VALUES ($1, 'sms', $2, 'failed', $3)`,
        [invoice.id, invoice.phone_number, error.message]
      );
      console.error('Invoice SMS failed:', error.message);
      res.status(503).json({ error: 'Invoice notification could not be sent.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send invoice.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Kandaria Backend running on port ${PORT}`));
