# WDNR Studio: website + request backend

This folder is your whole site. One small Node.js server:

- serves the website (`public/index.html`)
- saves every "free quote" and "free call" request from the contact form in a database
- emails you when a new request arrives (optional)
- gives you a private admin page at **/admin** to read, track and export requests

## What's inside

| File | What it does |
|---|---|
| `server.js` | The backend: saves requests, login, admin API, spam protection |
| `public/index.html` | The website |
| `admin/` | The admin page (only works after you log in) |
| `.env.example` | Settings template: copy it to `.env` |
| `Dockerfile` | For hosts that run Docker |

The database is one file, `requests.db`, in the folder set by `DATA_DIR`.

## Try it on your computer

You need Node.js 22.13 or newer (nodejs.org).

```bash
npm install
cp .env.example .env      # then open .env and fill in ADMIN_PASSWORD and SESSION_SECRET
npm start
```

Open http://localhost:3000 for the site and http://localhost:3000/admin for your requests.

To make `SESSION_SECRET`, run:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Get an email for every request (optional)

With your Gmail:

1. Turn on 2-Step Verification on your Google account.
2. Go to Google Account → Security → App passwords, and create one called "WDNR".
3. Paste that 16-letter password into `SMTP_PASS` in `.env` (or in your host's settings).

The email's "Reply" goes straight to the client when they gave an email address.

## Put it online

Pick a host that runs Node.js **and keeps files between restarts** (called a "volume" or "persistent disk"). Without one, your requests are erased every time the server restarts. Railway, Render (with a disk) or any small VPS work.

1. Put this folder on GitHub (the `.gitignore` already keeps `.env`, `data/` and `node_modules/` out).
2. Create a new service on your host from that repository. It will run `npm install` and `npm start`, or use the `Dockerfile`.
3. Add a volume or disk mounted at `/data`.
4. Add these settings (environment variables) in the host's dashboard:
   - `NODE_ENV` = `production`
   - `DATA_DIR` = `/data`
   - `ADMIN_PASSWORD` = your admin password
   - `SESSION_SECRET` = the long random string
   - the `SMTP_...` lines if you want email alerts
5. Connect your domain (for example wdnrstudio.com) in the host's settings.

Then go to `https://your-domain/admin` and log in.

## Using the admin page

- **New** requests have a black border and a small black square.
- Change the **status** as you go: New, Contacted, Quote sent, Won, Lost. It saves right away.
- Write **notes** (budget, next step) and press "Save notes".
- **WhatsApp**, **Call** and **Email** buttons open a conversation with the client in one tap. A number with 8 digits and no country code is treated as a Cyprus number (+357).
- **Export CSV** downloads everything for Excel or Google Sheets. Do it from time to time as a backup.
- **Delete** asks you to press a second time to confirm.

## Protection built in

- The admin page needs your password; the login lasts 7 days and is locked to your browser.
- Too many wrong passwords from one address are blocked for 15 minutes.
- One address can send at most 5 requests every 15 minutes.
- A hidden field catches most spam bots.
- What clients type is always shown as plain text, so nobody can inject code into your admin page.

If the server can't be reached, the contact form on the site automatically falls back to "Send on WhatsApp" and "Send by email", so you never lose a client.
