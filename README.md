# LOCA Agency — Backend

Node.js + Express backend for the LOCA Influencer Marketing Agency website.

---

## Features

- **Campaign inquiry form** — collects lead data from the website contact form
- **JSON database** — leads stored in `data/leads.json` (no external DB needed)
- **Email notifications** — agency gets an email on every new inquiry (via Nodemailer/Gmail)
- **Auto-reply** — submitter receives a branded confirmation email
- **Admin REST API** — view, filter, update status, and delete leads
- **Rate limiting** — 5 submissions per IP per 15 minutes
- **Security headers** — via Helmet.js

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env` and fill in your values (see below).

### 3. Place your front-end files
Copy `index.html` and `style.css` into the `public/` folder.
The server will serve them automatically.

### 4. Run the server
```bash
# Development (auto-restarts on file changes — Node 18+)
npm run dev

# Production
npm start
```
The server starts at `http://localhost:3000`

---

## Environment Variables (`.env`)

| Variable         | Required | Description |
|-----------------|----------|-------------|
| `PORT`           | No       | Server port (default: 3000) |
| `ALLOWED_ORIGIN` | No       | CORS origin (default: `*`) |
| `ADMIN_TOKEN`    | **Yes**  | Secret token for admin API access |
| `SMTP_HOST`      | No       | SMTP server (default: `smtp.gmail.com`) |
| `SMTP_PORT`      | No       | SMTP port (default: `587`) |
| `SMTP_SECURE`    | No       | Use TLS (default: `false`) |
| `SMTP_USER`      | No       | Your Gmail address |
| `SMTP_PASS`      | No       | Gmail App Password |
| `NOTIFY_EMAIL`   | No       | Email to receive lead notifications |

### Setting up Gmail
1. Enable 2-Factor Authentication on your Google account
2. Go to [Google Account → Security → App Passwords](https://myaccount.google.com/apppasswords)
3. Generate an App Password for "Mail"
4. Use that as `SMTP_PASS` in your `.env`

---

## API Reference

### Public

#### `POST /api/contact`
Submit a campaign inquiry.

**Body (JSON):**
```json
{
  "name":         "Priya Sharma",         // required
  "email":        "priya@brand.com",      // required
  "phone":        "+91 98765 43210",      // optional
  "brand":        "My Brand",             // optional
  "campaignType": "Product Launch",       // optional
  "budget":       "₹50K – ₹1.5L",        // optional
  "message":      "Tell us more..."       // optional
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

---

### Admin (requires `x-admin-token` header or `?token=` query param)

#### `GET /api/leads`
List all leads. Optional `?status=new|contacted|closed` filter.

#### `GET /api/leads/:id`
Get a single lead by ID.

#### `PATCH /api/leads/:id`
Update lead status.
```json
{ "status": "contacted" }
```

#### `DELETE /api/leads/:id`
Delete a lead permanently.

#### `GET /api/stats`
Get summary stats (total, this month, by status, by campaign type).

---

## Example: Fetching leads with curl

```bash
# List all new leads
curl -H "x-admin-token: YOUR_TOKEN" http://localhost:3000/api/leads?status=new

# Mark a lead as contacted
curl -X PATCH \
     -H "x-admin-token: YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"status":"contacted"}' \
     http://localhost:3000/api/leads/LEAD_ID

# Get stats
curl -H "x-admin-token: YOUR_TOKEN" http://localhost:3000/api/stats
```

---

## Deploying to Production

### Railway / Render / Fly.io (recommended)
1. Push this folder to a GitHub repo
2. Connect to Railway/Render and deploy
3. Set environment variables in the dashboard
4. Done — your server is live

### VPS (Ubuntu/Debian)
```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 (process manager)
npm install -g pm2

# Start the server
pm2 start server.js --name loca-backend
pm2 save
pm2 startup
```

### Nginx reverse proxy (optional)
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Project Structure

```
loca-backend/
├── server.js          # Main Express application
├── package.json
├── .env               # Your secrets (git-ignored)
├── .env.example       # Template for .env
├── data/
│   └── leads.json     # Auto-created lead database
└── public/            # Place your front-end files here
    ├── index.html
    └── style.css
```

---

*LOCA Agency · Gorakhpur, Uttar Pradesh · We Grow Together.*
