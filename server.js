require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── DB (JSON file) ──────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'leads.json');
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH));
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ leads: [] }, null, 2));

function readDB()       { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function writeDB(data)  { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve front-end static files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const contactLimiter = rateLimit({
  windowMs : 15 * 60 * 1000, // 15 minutes
  max      : 5,
  message  : { success: false, message: 'Too many submissions. Please try again in 15 minutes.' }
});

const adminLimiter = rateLimit({
  windowMs : 5 * 60 * 1000,
  max      : 30,
  message  : { success: false, message: 'Too many requests.' }
});

// ─── EMAIL TRANSPORTER ───────────────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    host   : process.env.SMTP_HOST   || 'smtp.gmail.com',
    port   : parseInt(process.env.SMTP_PORT || '587'),
    secure : process.env.SMTP_SECURE === 'true',
    auth   : {
      user : process.env.SMTP_USER,
      pass : process.env.SMTP_PASS
    }
  });
}

async function sendNotificationEmail(lead) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('[Email] SMTP not configured — skipping notification.');
    return;
  }
  const transporter = createTransporter();
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#060606;color:#f5f2ed;padding:40px;border-radius:8px;">
      <h2 style="font-size:24px;margin-bottom:24px;border-bottom:1px solid #333;padding-bottom:16px;">
        🎯 New Campaign Inquiry — LOCA Agency
      </h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:10px 0;color:#999;width:160px;vertical-align:top;">Name</td>
            <td style="padding:10px 0;font-weight:500;">${lead.name}</td></tr>
        <tr><td style="padding:10px 0;color:#999;vertical-align:top;">Email</td>
            <td style="padding:10px 0;"><a href="mailto:${lead.email}" style="color:#f5f2ed;">${lead.email}</a></td></tr>
        <tr><td style="padding:10px 0;color:#999;vertical-align:top;">Phone</td>
            <td style="padding:10px 0;">${lead.phone || '—'}</td></tr>
        <tr><td style="padding:10px 0;color:#999;vertical-align:top;">Brand / Company</td>
            <td style="padding:10px 0;">${lead.brand || '—'}</td></tr>
        <tr><td style="padding:10px 0;color:#999;vertical-align:top;">Campaign Type</td>
            <td style="padding:10px 0;">${lead.campaignType || '—'}</td></tr>
        <tr><td style="padding:10px 0;color:#999;vertical-align:top;">Budget Range</td>
            <td style="padding:10px 0;">${lead.budget || '—'}</td></tr>
        <tr><td style="padding:10px 0;color:#999;vertical-align:top;">Message</td>
            <td style="padding:10px 0;line-height:1.6;">${lead.message || '—'}</td></tr>
        <tr><td style="padding:10px 0;color:#999;vertical-align:top;">Submitted At</td>
            <td style="padding:10px 0;">${new Date(lead.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</td></tr>
      </table>
      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #333;font-size:12px;color:#555;">
        ID: ${lead.id} · LOCA Agency Backend
      </div>
    </div>`;

  await transporter.sendMail({
    from    : `"LOCA Agency" <${process.env.SMTP_USER}>`,
    to      : process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
    subject : `New Inquiry: ${lead.name} — ${lead.brand || lead.email}`,
    html
  });
  console.log(`[Email] Notification sent for lead ${lead.id}`);
}

async function sendAutoReplyEmail(lead) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const transporter = createTransporter();
  await transporter.sendMail({
    from    : `"LOCA Agency" <${process.env.SMTP_USER}>`,
    to      : lead.email,
    subject : 'We received your inquiry — LOCA Agency',
    html    : `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#060606;color:#f5f2ed;padding:48px;border-radius:8px;">
        <div style="font-size:22px;font-weight:800;letter-spacing:0.18em;margin-bottom:32px;">LOCA</div>
        <h2 style="font-size:26px;font-weight:300;line-height:1.1;margin-bottom:20px;">
          Hi ${lead.name.split(' ')[0]},<br>we'll be in touch.
        </h2>
        <p style="font-size:14px;line-height:1.8;color:rgba(245,242,237,0.5);margin-bottom:24px;">
          Thank you for reaching out to LOCA Agency. We've received your campaign inquiry and our team will review it and get back to you within <strong style="color:#f5f2ed;">1–2 business days</strong>.
        </p>
        <p style="font-size:14px;line-height:1.8;color:rgba(245,242,237,0.5);">
          In the meantime, feel free to reach us directly at 
          <a href="mailto:hello@locaagency.com" style="color:#f5f2ed;">hello@locaagency.com</a> 
          or call us at <a href="tel:+919119627388" style="color:#f5f2ed;">+91 91196 27388</a>.
        </p>
        <div style="margin-top:40px;padding-top:24px;border-top:1px solid #1a1a1a;font-size:11px;color:#444;letter-spacing:0.12em;">
          LOCA AGENCY · GORAKHPUR, UTTAR PRADESH · WE GROW TOGETHER
        </div>
      </div>`
  });
  console.log(`[Email] Auto-reply sent to ${lead.email}`);
}

// ─── SIMPLE ADMIN AUTH ────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ success: false, message: 'Admin token not configured.' });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }
  next();
}

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────────
function validateContact(body) {
  const errors = [];
  if (!body.name    || body.name.trim().length < 2)   errors.push('Name must be at least 2 characters.');
  if (!body.email   || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) errors.push('Valid email is required.');
  if (body.phone    && !/^[\d\s\+\-\(\)]{7,15}$/.test(body.phone))     errors.push('Invalid phone number.');
  if (body.message  && body.message.length > 2000)                      errors.push('Message must be under 2000 characters.');
  return errors;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'LOCA Agency backend is running.', timestamp: new Date().toISOString() });
});

// POST /api/contact — Submit a campaign inquiry
app.post('/api/contact', contactLimiter, async (req, res) => {
  const { name, email, phone, brand, campaignType, budget, message } = req.body;

  const errors = validateContact(req.body);
  if (errors.length) return res.status(400).json({ success: false, errors });

  const lead = {
    id          : crypto.randomUUID(),
    name        : name.trim(),
    email       : email.trim().toLowerCase(),
    phone       : phone?.trim() || null,
    brand       : brand?.trim() || null,
    campaignType: campaignType || null,
    budget      : budget || null,
    message     : message?.trim() || null,
    status      : 'new',         // new | contacted | closed
    createdAt   : new Date().toISOString(),
    updatedAt   : new Date().toISOString()
  };

  const db = readDB();
  db.leads.push(lead);
  writeDB(db);
  console.log(`[Lead] New inquiry from ${lead.name} <${lead.email}>`);

  // Fire emails without blocking the response
  Promise.allSettled([
    sendNotificationEmail(lead),
    sendAutoReplyEmail(lead)
  ]).then(results => {
    results.forEach(r => { if (r.status === 'rejected') console.error('[Email Error]', r.reason?.message); });
  });

  res.status(201).json({
    success : true,
    message : 'Thank you! We\'ll be in touch within 1–2 business days.',
    leadId  : lead.id
  });
});

// GET /api/leads — List all leads (admin)
app.get('/api/leads', adminLimiter, adminAuth, (req, res) => {
  const db     = readDB();
  const status = req.query.status;
  const leads  = status ? db.leads.filter(l => l.status === status) : db.leads;
  res.json({
    success : true,
    total   : leads.length,
    leads   : leads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  });
});

// GET /api/leads/:id — Get single lead (admin)
app.get('/api/leads/:id', adminLimiter, adminAuth, (req, res) => {
  const db   = readDB();
  const lead = db.leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ success: false, message: 'Lead not found.' });
  res.json({ success: true, lead });
});

// PATCH /api/leads/:id — Update lead status (admin)
app.patch('/api/leads/:id', adminLimiter, adminAuth, (req, res) => {
  const { status } = req.body;
  const allowed = ['new', 'contacted', 'closed'];
  if (!allowed.includes(status)) return res.status(400).json({ success: false, message: `Status must be one of: ${allowed.join(', ')}` });

  const db  = readDB();
  const idx = db.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Lead not found.' });

  db.leads[idx].status    = status;
  db.leads[idx].updatedAt = new Date().toISOString();
  writeDB(db);
  res.json({ success: true, lead: db.leads[idx] });
});

// DELETE /api/leads/:id — Delete a lead (admin)
app.delete('/api/leads/:id', adminLimiter, adminAuth, (req, res) => {
  const db  = readDB();
  const idx = db.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Lead not found.' });
  db.leads.splice(idx, 1);
  writeDB(db);
  res.json({ success: true, message: 'Lead deleted.' });
});

// GET /api/stats — Dashboard stats (admin)
app.get('/api/stats', adminLimiter, adminAuth, (req, res) => {
  const db    = readDB();
  const leads = db.leads;
  const byStatus = leads.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {});
  const byType = leads.reduce((acc, l) => {
    const k = l.campaignType || 'Unspecified';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const thisMonth = leads.filter(l => {
    const d = new Date(l.createdAt);
    const n = new Date();
    return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
  }).length;

  res.json({ success: true, stats: { total: leads.length, thisMonth, byStatus, byCampaignType: byType } });
});

// Catch-all: serve index.html for SPA routing
app.get('/{*path}', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ success: true, message: 'LOCA Agency API is running. Place your front-end in the /public folder.' });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ██╗      ██████╗  ██████╗ █████╗ `);
  console.log(`  ██║     ██╔═══██╗██╔════╝██╔══██╗`);
  console.log(`  ██║     ██║   ██║██║     ███████║`);
  console.log(`  ██║     ██║   ██║██║     ██╔══██║`);
  console.log(`  ███████╗╚██████╔╝╚██████╗██║  ██║`);
  console.log(`  ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝\n`);
  console.log(`  LOCA Agency Backend`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Server   : http://localhost:${PORT}`);
  console.log(`  API Base : http://localhost:${PORT}/api`);
  console.log(`  Leads DB : ${DB_PATH}`);
  console.log(`  Email    : ${process.env.SMTP_USER ? '✓ Configured' : '✗ Not configured (set SMTP_USER & SMTP_PASS)'}`);
  console.log(`  Admin    : ${process.env.ADMIN_TOKEN ? '✓ Secured' : '✗ Set ADMIN_TOKEN in .env'}\n`);
});
