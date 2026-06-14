# LOCA Agency — Backend

The Node.js + Express API powering the LOCA Agency website: campaign inquiry intake, automated email replies, lead notifications, and an admin dashboard API for managing incoming leads.

*LOCA Agency · Influencer Marketing · Gorakhpur, Uttar Pradesh · We Grow Together.*

---

## Features

- **Campaign inquiry form** — collects lead data from the website contact form
- **JSON database** — leads stored in `data/leads.json`, zero external DB required to get started
- **Email notifications** — the agency gets a branded email on every new inquiry
- **Auto-reply** — the submitter receives a branded confirmation email
- **Delivery diagnostics** — built-in SMTP verification, a one-click test-email endpoint, and per-lead delivery status so "no email arrived" is never a mystery again
- **Optional Telegram alerts** — instant push notification to your phone for every new lead, independent of email
- **Admin REST API** — view, filter, update status, resend email, and delete leads
- **Rate limiting** — 5 form submissions per IP per 15 minutes
- **Security headers** — via Helmet.js

---

## Project Structure

```
loca-backend/
├── server.js          # Main Express application
├── package.json
├── package-lock.json
├── .env.example        # Template for .env (copy → .env)
├── .gitignore
├── README.md
├── data/
│   └── leads.json      # Auto-created lead database (git-ignored)
└── public/              # Front-end, served automatically
    └── index.html
```

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# then edit .env — see "Environment Variables" below

# 3. Run
npm run dev     # auto-restarts on file changes (Node 18+)
# or
npm start       # production mode
```

The server starts at `http://localhost:3000` and serves the front-end from `/public` automatically.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default `3000`) |
| `ALLOWED_ORIGIN` | No | CORS origin (default `*`) |
| `ADMIN_TOKEN` | **Yes** | Secret token for admin API access |
| `SMTP_HOST` | For email | SMTP server (e.g. `smtp.hostinger.com`, `smtp.gmail.com`) |
| `SMTP_PORT` | For email | SMTP port — `465` or `587` |
| `SMTP_SECURE` | No | `true`/`false`. Auto-derived from `SMTP_PORT` if omitted (465→true, else false) |
| `SMTP_USER` | For email | Mailbox / account username (full email address) |
| `SMTP_PASS` | For email | Mailbox password or app password |
| `NOTIFY_EMAIL` | No | Where lead notifications are sent (default: `SMTP_USER`). Comma-separate for multiple recipients |
| `EMAIL_FROM` | No | Override the "From" address (default: `SMTP_USER`) |
| `EMAIL_FROM_NAME` | No | "From" display name (default `LOCA Agency`) |
| `SMTP_DEBUG` | No | `true` to log the full SMTP conversation (debugging only) |
| `TELEGRAM_BOT_TOKEN` | No | Enables instant Telegram lead alerts |
| `TELEGRAM_CHAT_ID` | No | Chat ID to receive Telegram alerts |

A fully-commented version with both Hostinger and Gmail examples lives in **`.env.example`**.

---

## Deploying — GitHub → Render

### 1. Push to GitHub

```bash
cd loca-backend
git init
git add .
git commit -m "Initial commit — LOCA Agency backend"
git branch -M main
git remote add origin https://github.com/<your-username>/loca-backend.git
git push -u origin main
```

`.env` and `data/leads.json` are git-ignored on purpose — never commit real credentials or lead data.

### 2. Create the Render service

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub account and select the `loca-backend` repo
3. Configure:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free is fine to start
4. Under **Environment → Environment Variables**, add every variable from the table above (at minimum: `ADMIN_TOKEN`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL`)
5. Click **Create Web Service** — Render will build and deploy automatically on every push to `main`

### 3. Point your domain (optional)

In Render → your service → **Settings → Custom Domains**, add `locaagency.com` / `www.locaagency.com` and follow the DNS instructions (CNAME/A record at your domain registrar, e.g. Hostinger DNS).

---

## API Reference

### Public

#### `POST /api/contact`
Submit a campaign inquiry.

```json
{
  "name":         "Priya Sharma",
  "email":        "priya@brand.com",
  "phone":        "+91 98765 43210",
  "brand":        "My Brand",
  "campaignType": "Product Launch",
  "budget":       "₹50,000 – ₹1,50,000",
  "message":      "Tell us more..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "Thank you! We'll be in touch within 1–2 business days.",
  "leadId":  "uuid-here"
}
```

#### `GET /api/health`
Returns server status plus a **non-sensitive** snapshot of the email config (host, port, secure, masked addresses) and whether Telegram alerts are enabled. Useful for a quick sanity check after deploying.

---

### Admin
*(requires `x-admin-token: <ADMIN_TOKEN>` header, or `?token=<ADMIN_TOKEN>` query param)*

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/leads` | List all leads. Optional `?status=new\|contacted\|closed` |
| `GET` | `/api/leads/:id` | Get a single lead |
| `PATCH` | `/api/leads/:id` | Update status — body: `{ "status": "contacted" }` |
| `DELETE` | `/api/leads/:id` | Permanently delete a lead |
| `POST` | `/api/leads/:id/resend-email` | Re-attempt notification + auto-reply for one lead |
| `POST` | `/api/test-email` | Send a one-off test email (body: `{ "to": "you@example.com" }`, optional) |
| `GET` | `/api/stats` | Summary stats — totals, by status, by campaign type, and `emailFailures` count |

#### Example: curl

```bash
# List new leads
curl -H "x-admin-token: YOUR_TOKEN" https://your-app.onrender.com/api/leads?status=new

# Mark a lead as contacted
curl -X PATCH \
     -H "x-admin-token: YOUR_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"contacted"}' \
     https://your-app.onrender.com/api/leads/LEAD_ID

# Send yourself a test email
curl -X POST -H "x-admin-token: YOUR_TOKEN" https://your-app.onrender.com/api/test-email
```

---

## Troubleshooting: "hello@locaagency.com isn't receiving emails"

This backend now does most of the diagnostic work for you. Walk through these steps in order:

### Step 1 — Check `/api/health`
```bash
curl https://your-app.onrender.com/api/health
```
- `email.configured` must be `true`. If `false`, `SMTP_USER`/`SMTP_PASS` aren't set in Render's environment variables (the `.env` file is **not** deployed — it's git-ignored on purpose).
- Confirm `email.host`, `email.port`, and `email.secure` match your provider (see table below).

### Step 2 — Check the Render deploy logs
On boot, the server logs a clear SMTP verification result:
- `[Email] ✓ SMTP connection verified ...` → credentials and connection are good
- `[Email] ✗ SMTP VERIFICATION FAILED ...` → the log includes the exact error code/response from your mail provider (auth failure, wrong port, etc.)

### Step 3 — Send a live test email
```bash
curl -X POST -H "x-admin-token: YOUR_ADMIN_TOKEN" https://your-app.onrender.com/api/test-email
```
This returns the **raw SMTP error** (code, response, responseCode) if it fails — no guessing required.

### Step 4 — Check `PORT` / `SECURE` match your provider

| Provider | Host | Port | Secure |
|---|---|---|---|
| Hostinger (custom domain mailbox) | `smtp.hostinger.com` | `465` | `true` |
| Gmail | `smtp.gmail.com` | `587` | `false` (STARTTLS) |

A mismatch here is the **#1 cause** of "form submits fine, no email ever arrives" — the connection either hangs (timeout) or is rejected outright.

### Step 5 — Check the lead record itself
```bash
curl -H "x-admin-token: YOUR_TOKEN" https://your-app.onrender.com/api/leads
```
Every lead now has an `emailStatus` object showing exactly what happened:
```json
"emailStatus": {
  "notification": { "sent": true,  "messageId": "..." },
  "autoReply":    { "sent": false, "reason": "Invalid login: 535-5.7.8 ..." },
  "telegram":      { "sent": false, "reason": "Telegram not configured" },
  "checkedAt": "2026-06-14T12:00:00.000Z"
}
```
If `notification.sent` is `false`, the `reason` field tells you exactly why (auth error, timeout, etc).

### Step 6 — After fixing the config
You don't need to wait for a new lead — re-send email for an existing one:
```bash
curl -X POST -H "x-admin-token: YOUR_TOKEN" https://your-app.onrender.com/api/leads/LEAD_ID/resend-email
```

### Step 7 — Still nothing? Check spam / SPF
If `/api/test-email` reports success but the email never appears, check the **Spam/Junk** folder of the receiving mailbox. For custom-domain mail (Hostinger etc.), make sure SPF/DKIM records are correctly set on your domain's DNS — Hostinger configures these automatically for its own mail service, but if you're relaying through a different provider while using a `@locaagency.com` "From" address, SPF can cause silent rejection.

### Common root causes, ranked
1. `SMTP_USER` / `SMTP_PASS` were never added to Render's environment variables (most common — they only existed in a local `.env`, which is git-ignored)
2. `SMTP_PORT` / `SMTP_SECURE` mismatch (465 needs `true`, 587 needs `false`)
3. Gmail without an **App Password** (regular account password is rejected)
4. `NOTIFY_EMAIL` unset and `SMTP_USER` isn't actually `hello@locaagency.com` — notifications were going somewhere else the whole time
5. Email delivered but landing in spam due to SPF/DKIM misalignment

---

## Optional: Instant Telegram Lead Alerts

Because email can be delayed or silently dropped, you can enable a parallel, SMTP-independent channel:

1. Message **@BotFather** on Telegram → `/newbot` → copy the bot token
2. Send your new bot any message, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your `chat.id`
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in Render's environment variables

Every new lead will now also trigger an instant message to your Telegram chat — no redeploy of the frontend needed.

---

## Production Notes

- **Ephemeral filesystem**: on Render's default plans, the filesystem resets on every redeploy/restart. `data/leads.json` will be wiped along with it. This is fine for low volume / early stage, but as a next step consider:
  - Render **persistent disks** (mount `/data` and point `DB_PATH` there), or
  - Migrating to a hosted database (MongoDB Atlas, Postgres/Neon, etc.)
- **Admin token**: rotate `ADMIN_TOKEN` periodically and never expose it in frontend code or commits.
- **Rate limiting**: defaults are 5 submissions / 15 min per IP for the public form, and 30 requests / 5 min per IP for admin endpoints — adjust in `server.js` if needed.

---

*LOCA Agency · Gorakhpur, Uttar Pradesh · We Grow Together.*
