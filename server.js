require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const dns        = require('dns');

// Render's network does not support outbound IPv6 — force IPv4 DNS
// resolution so SMTP connections (e.g. Hostinger) don't fail with
// ENETUNREACH on the IPv6 address.
dns.setDefaultResultOrder('ipv4first');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust Render's reverse proxy so express-rate-limit can correctly
// read the client IP from X-Forwarded-For.
app.set('trust proxy', 1);

// ─── DB (JSON file) ──────────────────────────────────────────────────────────
// NOTE: Render's filesystem is ephemeral on most plans — this file resets on
// every redeploy/restart. Fine for low volume / early stage, but if lead
// volume grows, migrate to a persistent disk (Render add-on) or a hosted DB
// (MongoDB Atlas, Postgres, etc). See README → "Production Notes".
const DB_PATH = path.join(__dirname, 'data', 'leads.json');
if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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

// ─── EMAIL CONFIG HELPERS ─────────────────────────────────────────────────────

// Many SMTP outages come down to a PORT / SECURE mismatch:
//   - Port 465  → secure: true  (implicit TLS)
//   - Port 587  → secure: false (STARTTLS)
// If SMTP_SECURE is explicitly set in the environment, it always wins.
// Otherwise it's auto-derived from the port so a misconfigured .env can't
// silently break delivery.
function resolveSecure() {
  if (process.env.SMTP_SECURE !== undefined) return process.env.SMTP_SECURE === 'true';
  return parseInt(process.env.SMTP_PORT || '587', 10) === 465;
}

function resolvePort() {
  return parseInt(process.env.SMTP_PORT || '587', 10);
}

function emailConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return null;
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(user.length - 2, 1))}@${domain}`;
}

function notifyRecipients() {
  return process.env.NOTIFY_EMAIL || process.env.SMTP_USER;
}

function fromAddress() {
  return process.env.EMAIL_FROM || process.env.SMTP_USER;
}

// ─── EMAIL TRANSPORTER ───────────────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    host   : process.env.SMTP_HOST || 'smtp.gmail.com',
    port   : resolvePort(),
    secure : resolveSecure(),
    family : 4, // force IPv4 — avoids ENETUNREACH on hosts without IPv6 egress (e.g. Render)
    auth   : {
      user : process.env.SMTP_USER,
      pass : process.env.SMTP_PASS
    },
    connectionTimeout : 15000,
    greetingTimeout   : 15000,
    socketTimeout     : 20000,
    logger : process.env.SMTP_DEBUG === 'true',
    debug  : process.env.SMTP_DEBUG === 'true'
  });
}

// Verifies the SMTP connection on boot and logs a clear, actionable result to
// the Render log stream. This is the single biggest time-saver when
// diagnosing "form submits fine but no email arrives" — the failure shows up
// immediately on deploy instead of silently swallowing errors per-request.
async function verifyEmailConfig() {
  if (!emailConfigured()) {
    console.log('[Email] ⚠ SMTP_USER / SMTP_PASS not set — email sending is DISABLED.');
    return;
  }
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log(`[Email] ✓ SMTP connection verified — ${process.env.SMTP_HOST || 'smtp.gmail.com'}:${resolvePort()} (secure=${resolveSecure()})`);
    console.log(`[Email]   Sending as : ${process.env.SMTP_USER}`);
    console.log(`[Email]   Notify     : ${notifyRecipients()}`);
  } catch (err) {
    console.error('[Email] ✗ SMTP VERIFICATION FAILED — emails will NOT be delivered.');
    console.error(`[Email]   message      : ${err.message}`);
    if (err.code)         console.error(`[Email]   code         : ${err.code}`);
    if (err.responseCode) console.error(`[Email]   responseCode : ${err.responseCode}`);
    if (err.response)     console.error(`[Email]   response     : ${err.response}`);
    console.error('[Email]   → Check SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS.');
    console.error('[Email]   → Use POST /api/test-email (admin) to re-test without redeploying.');
  }
}

async function sendNotificationEmail(lead) {
  if (!emailConfigured()) {
    console.log('[Email] SMTP not configured — skipping notification.');
    return { sent: false, reason: 'SMTP not configured' };
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

  try {
    const info = await transporter.sendMail({
      from    : `"${process.env.EMAIL_FROM_NAME || 'LOCA Agency'}" <${fromAddress()}>`,
      to      : notifyRecipients(),
      replyTo : lead.email,
      subject : `New Inquiry: ${lead.name} — ${lead.brand || lead.email}`,
      html
    });
    console.log(`[Email] ✓ Notification sent for lead ${lead.id} (messageId: ${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email] ✗ Notification FAILED for lead ${lead.id}: ${err.message}`);
    if (err.responseCode) console.error(`[Email]   responseCode: ${err.responseCode} response: ${err.response}`);
    return { sent: false, reason: err.message, code: err.code || null, responseCode: err.responseCode || null };
  }
}

async function sendAutoReplyEmail(lead) {
  if (!emailConfigured()) {
    return { sent: false, reason: 'SMTP not configured' };
  }
  const transporter = createTransporter();
  try {
    const info = await transporter.sendMail({
      from    : `"${process.env.EMAIL_FROM_NAME || 'LOCA Agency'}" <${fromAddress()}>`,
      to      : lead.email,
      replyTo : notifyRecipients(),
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
    console.log(`[Email] ✓ Auto-reply sent to ${lead.email} (messageId: ${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email] ✗ Auto-reply FAILED for ${lead.email}: ${err.message}`);
    if (err.responseCode) console.error(`[Email]   responseCode: ${err.responseCode} response: ${err.response}`);
    return { sent: false, reason: err.message, code: err.code || null, responseCode: err.responseCode || null };
  }
}

// ─── OPTIONAL: TELEGRAM INSTANT-ALERT (BACKUP CHANNEL) ───────────────────────
// Email can be delayed by spam filters or silently dropped by a provider.
// If TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set, every new lead also fires
// an instant push notification straight to your phone via Telegram — fully
// independent of SMTP. Entirely optional; skipped if not configured.
async function sendTelegramAlert(lead) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'Telegram not configured' };
  }
  const lines = [
    '🎯 New Campaign Inquiry — LOCA Agency',
    '',
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone || '—'}`,
    `Brand: ${lead.brand || '—'}`,
    `Campaign Type: ${lead.campaignType || '—'}`,
    `Budget: ${lead.budget || '—'}`,
    `Message: ${lead.message || '—'}`,
    '',
    `ID: ${lead.id}`
  ];
  try {
    const url  = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: lines.join('\n') })
    });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.description || 'Telegram API error');
    console.log(`[Telegram] ✓ Alert sent for lead ${lead.id}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Telegram] ✗ Alert failed for lead ${lead.id}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
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

// Health check — also surfaces (non-sensitive) email config status so you can
// confirm SMTP is wired up correctly without exposing secrets.
app.get('/api/health', (req, res) => {
  res.json({
    success   : true,
    status    : 'LOCA Agency backend is running.',
    timestamp : new Date().toISOString(),
    email: {
      configured : emailConfigured(),
      host       : process.env.SMTP_HOST || 'smtp.gmail.com',
      port       : resolvePort(),
      secure     : resolveSecure(),
      sendingAs  : process.env.SMTP_USER ? maskEmail(process.env.SMTP_USER) : null,
      notifyTo   : notifyRecipients() ? maskEmail(notifyRecipients()) : null
    },
    telegram: {
      configured : Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
    }
  });
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
    emailStatus : null,           // populated once notification/auto-reply attempts finish
    createdAt   : new Date().toISOString(),
    updatedAt   : new Date().toISOString()
  };

  const db = readDB();
  db.leads.push(lead);
  writeDB(db);
  console.log(`[Lead] New inquiry from ${lead.name} <${lead.email}>`);

  // Respond immediately — don't make the visitor wait on SMTP round-trips.
  res.status(201).json({
    success : true,
    message : 'Thank you! We\'ll be in touch within 1–2 business days.',
    leadId  : lead.id
  });

  // Fire notification + auto-reply + optional Telegram alert in the
  // background, then persist the outcome on the lead so you can see in
  // GET /api/leads whether delivery actually succeeded.
  Promise.allSettled([
    sendNotificationEmail(lead),
    sendAutoReplyEmail(lead),
    sendTelegramAlert(lead)
  ]).then(([notif, auto, tg]) => {
    const result = (r) => (r.status === 'fulfilled' ? r.value : { sent: false, reason: r.reason?.message || 'Unknown error' });
    const emailStatus = {
      notification : result(notif),
      autoReply    : result(auto),
      telegram     : result(tg),
      checkedAt    : new Date().toISOString()
    };
    const fresh = readDB();
    const idx = fresh.leads.findIndex(l => l.id === lead.id);
    if (idx !== -1) {
      fresh.leads[idx].emailStatus = emailStatus;
      writeDB(fresh);
    }
    if (!emailStatus.notification.sent) {
      console.error(`[Lead ${lead.id}] ⚠ Notification email did not send. Use POST /api/leads/${lead.id}/resend-email after fixing SMTP config.`);
    }
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

// POST /api/leads/:id/resend-email — Re-attempt notification + auto-reply (admin)
// Use this after fixing SMTP env vars to retroactively deliver email for a
// lead that came in while email was broken.
app.post('/api/leads/:id/resend-email', adminLimiter, adminAuth, async (req, res) => {
  const db  = readDB();
  const idx = db.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Lead not found.' });
  const lead = db.leads[idx];

  const [notif, auto] = await Promise.allSettled([sendNotificationEmail(lead), sendAutoReplyEmail(lead)]);
  const result = (r) => (r.status === 'fulfilled' ? r.value : { sent: false, reason: r.reason?.message || 'Unknown error' });

  db.leads[idx].emailStatus = {
    ...(lead.emailStatus || {}),
    notification : result(notif),
    autoReply    : result(auto),
    checkedAt    : new Date().toISOString()
  };
  writeDB(db);
  res.json({ success: true, emailStatus: db.leads[idx].emailStatus });
});

// POST /api/test-email — Send a one-off test email to confirm SMTP works (admin)
// Body (optional): { "to": "someone@example.com" }
// Returns the raw SMTP error (code/response) on failure so you can diagnose
// auth, port, or TLS issues directly — without redeploying or digging through
// Render logs.
app.post('/api/test-email', adminLimiter, adminAuth, async (req, res) => {
  if (!emailConfigured()) {
    return res.status(503).json({
      success : false,
      message : 'SMTP not configured. Set SMTP_USER and SMTP_PASS in your environment.'
    });
  }
  const to = (req.body && req.body.to) || notifyRecipients();
  const transporter = createTransporter();
  try {
    const info = await transporter.sendMail({
      from    : `"${process.env.EMAIL_FROM_NAME || 'LOCA Agency'}" <${fromAddress()}>`,
      to,
      subject : 'LOCA Agency — Test Email ✓',
      html    : `<div style="font-family:sans-serif;padding:24px;background:#060606;color:#f5f2ed;border-radius:8px;">
                   <h2 style="margin:0 0 12px;">Test email successful</h2>
                   <p style="color:rgba(245,242,237,0.6);">If you're reading this in your inbox, SMTP delivery from this server is working.</p>
                   <p style="color:rgba(245,242,237,0.4);font-size:12px;">Sent ${new Date().toISOString()}</p>
                 </div>`
    });
    res.json({ success: true, message: `Test email sent to ${to}`, messageId: info.messageId });
  } catch (err) {
    res.status(500).json({
      success      : false,
      message      : 'Failed to send test email — see fields below for the exact SMTP error.',
      error        : err.message,
      code         : err.code || null,
      responseCode : err.responseCode || null,
      response     : err.response || null
    });
  }
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
  const emailFailures = leads.filter(l => l.emailStatus && l.emailStatus.notification && !l.emailStatus.notification.sent).length;

  res.json({ success: true, stats: { total: leads.length, thisMonth, byStatus, byCampaignType: byType, emailFailures } });
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
  console.log(`  Admin    : ${process.env.ADMIN_TOKEN ? '✓ Secured' : '✗ Set ADMIN_TOKEN in .env'}`);
  verifyEmailConfig();
});
