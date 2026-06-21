# Visit Book CRM — Setup Guide

This is your complete CRM: client visits, follow-ups, meetings, the Swa Data workflow, and real WhatsApp Business API sending — all in one app, with your own database.

## What's inside

- A **backend** (the engine — stores your data, talks to WhatsApp's servers)
- A **frontend** (the screens you and your team will actually use, served by the same backend)
- One SQLite database file — all your data lives in a single file your backend manages

You do **not** need to know how to code to deploy this. Follow the steps below in order.

---

## Step 1 — Put this code on GitHub

1. Create a free GitHub account if you don't have one: https://github.com
2. Create a new repository (e.g. `visitbook-crm`)
3. Upload everything inside this `backend` folder to that repository
   (the easiest way: on the repo page, click "uploading an existing file" and drag the whole folder in)

## Step 2 — Deploy on Render

1. Go to https://render.com and sign up / log in (you said you already have Render — good)
2. Click **New +** → **Web Service**
3. Connect your GitHub account and pick the `visitbook-crm` repository
4. Render will detect the `render.yaml` file automatically and pre-fill the settings:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - It will also create a **1GB Persistent Disk** mounted at `/var/data` — this is critical,
     it's where your client data actually lives so it survives every future deploy/restart.
5. Click **Create Web Service**. Wait 2–3 minutes for the first build.
6. Once it says "Live", click the URL Render gives you (something like `https://visitbook-crm.onrender.com`) — that's your app.

> ⚠️ **Important about the database**: if you skip attaching the Persistent Disk, Render wipes
> the filesystem on every deploy and you'd lose all client data. The `render.yaml` blueprint
> sets this up for you automatically — just don't remove the disk in the Render dashboard.

## Step 3 — First login

- Go to your app URL.
- Username: `admin`
- Password: `admin123`
- **Immediately go to Settings → Account tab and change this password.**

## Step 4 — Connect your WhatsApp Business API

You'll need three things from your Meta for Developers dashboard (developers.facebook.com/apps → your app → WhatsApp → API Setup):

1. **Access Token** — generate a *permanent* token (not the 24-hour temporary one), so it doesn't expire and break your sending every day
2. **Phone Number ID** — found on the same API Setup page
3. **WhatsApp Business Account ID (WABA ID)** — found in the same area, sometimes under "Business Settings"

In the app:
1. Go to **Settings → WhatsApp API**
2. Paste in the three values above
3. Click **Save Connection**
4. Click **Sync Templates from Meta** — this pulls in all your approved templates so they appear as dropdown options everywhere you send a message

### Webhook (for delivery/read status — optional but recommended)
1. In Settings, set a **Webhook Verify Token** (you make this up — any random string, e.g. `visitbook-secret-2026`) and click Save
2. Copy the **Webhook URL** shown right below it (your app URL + `/api/whatsapp/webhook`)
3. In Meta for Developers → your app → WhatsApp → Configuration, paste that URL and verify token, and subscribe to the `messages` field
4. Now every message you send will update its status (sent → delivered → read) automatically in the WA Log page

---

## How each page works

| Page | What it does |
|---|---|
| 🏠 Client Visits | Prospects you're nurturing. Each row has a Hot/Cold lead tag. Click a row to see full visit history, orders, and AI summary. Use the ⋮ menu to log a visit, send WhatsApp, edit, or **mark converted** (moves them to Active Clients, carrying all visit history along). |
| 🔔 Today's Follow-ups | Auto-pulls anyone from Client Visits whose follow-up date is today or earlier. One click marks it done. |
| ⭐ Active Clients | Your regular paying clients, with monthly value and order tracking. Click a row for full order history (bill no, products, quantities, totals). Use ⋮ to log a visit, send WhatsApp, edit, or add an order. |
| 📅 Meetings | Schedule meetings with date/time/notes, independent of visits. |
| 📊 Swa Data | Import a CSV/Excel with columns SR, COMPANY, CLIENT, PHONE, ADDRESS, REMARKS (use the "Import Template" button to download a blank starter file). Select rows with checkboxes. |
| ✅ Swa Selected | When you click "Move & Send" in Swa Data, selected rows move here AND a WhatsApp summary message is sent to one number you choose. |
| 💬 WA Log | Every WhatsApp message ever sent through the app, with live delivery status. |
| 📈 Reports | Visit counts, follow-ups pending, meetings done, WhatsApp send/delivery stats — filterable by date range. |
| ⚙️ Settings | WhatsApp connection, approved templates, AI (OpenAI) connection, and your account password. |

### Visit logging & history
Client Visits no longer has a single "Remarks" box. Instead, use **⋮ → Log a Visit** every time you
visit someone — it asks for visit date, next follow-up date, Hot/Cold status, and remarks. Every
log is kept permanently; the client's row always shows the *latest* entry, but clicking into the
row's detail popup shows the complete timeline, so nothing from earlier visits is ever lost.

### Converting a prospect to a client
When a Client Visits prospect is ready to buy regularly, use **⋮ → Mark Converted**. This:
- Creates a fresh row in Active Clients
- Carries over their entire visit history (so you can still see how they were nurtured)
- Removes them from Client Visits completely

### Orders (Active Clients only)
Use **⋮ → Add Order** or the button inside a client's detail popup. Each order has a bill number,
date, and any number of product lines (product, quantity, rate) — the amount per line and the
order total calculate automatically.

### AI Features (optional, needs your OpenAI key)
Go to **Settings → AI Features**, paste your OpenAI API key, and these light up automatically:
- ✨ One-line AI summary of a client's full visit history (shown in the detail popup)
- ✨ AI-suggested next follow-up date when logging a visit
- ✨ AI-suggested Hot/Cold lead status based on visit remarks
- ✨ AI-drafted WhatsApp message based on a client's latest remarks (shown as a reference next to the approved-template preview — actual sends still use your Meta-approved template, since WhatsApp requires that for business-initiated messages)
- 🎤 Voice-to-text — tap the mic icon while logging a visit to dictate your remarks instead of typing (uses OpenAI Whisper)

Every AI feature fails gracefully with a clear message if the key isn't set yet — nothing else in
the app is affected.

---

## What's new in this update

### 1. Zero data loss, even with multiple people working at once
Every single change now saves to disk **immediately** using an atomic write (never a
half-written file, even if the server crashes mid-save). A rolling backup snapshot is
taken automatically every 10 minutes and kept for 14 days, and you can download a full
backup any time from **Settings → Backups**. If the main database file is ever somehow
corrupted, the app automatically recovers from the most recent valid backup on startup
instead of silently starting empty.

### 2 & 3. Client Visits form — Company field added, Status field removed
The form now has **Company Name**. The old "Status" dropdown (Active/Inactive/Prospect)
is gone — Lead Status (Hot/Cold) is the only status you manage going forward.

### 4. Save & Send WhatsApp
Every Add/Edit form (Client Visits, Active Clients, Meetings) has a **"Save & Send
WhatsApp"** button next to the normal Save — it saves the record and immediately opens
the WhatsApp send screen pre-filled with the phone number you just typed in.

### 5. Visit history never overwrites itself
If you type remarks into the very first "Add Client" form (before ever using "Log a
Visit"), that's now automatically saved as the first entry in their permanent visit
history. Every later "Log a Visit" adds to that history — nothing is ever silently
replaced.

### 6. Today's Follow-ups — rebuilt around your sales executives' daily routes
- Grouped by **area** automatically, matching a fixed daily territory
- Checkbox on every row — select several, then **"Send to Number"** sends a summary
  via WhatsApp to one number (e.g. your own, for a daily digest) without removing
  anyone from the list
- An entry **only disappears once "Log a Visit" is completed** — there's no separate
  "mark done" shortcut anymore, so the list always reflects real ground truth

### 7. Meetings — Save & Send to any number
After picking a client (auto-fills their phone/area), "Save & Send WhatsApp" opens the
send screen — and the "To" number field is editable, so you can target a different
number than the client's own if needed.

### 8. Swa Data — two ways to send
- **Move & Send to One Number** (original flow): consolidates selected rows into one
  summary message to one number (e.g. your dispatch team)
- **Send Individually** (new): select multiple rows, pick a template, map which Swa
  field fills each `{{1}}`, `{{2}}`... — then every row sends its **own** message to
  its **own** phone number (5 rows selected = 5 separate sends), and all move to Swa
  Selected together

### 9 & 10. Swa Selected — AI area sorting for lead assignment
Click **"✨ AI: Sort by Area"** and OpenAI reads each row's address field and extracts
the locality/area (handles messy real-world addresses like "Ring Road opp Hotel X").
Use the area filter dropdown to see leads area-by-area, ready to hand off to whichever
sales executive covers that territory that day.

### 11. Sales Targets report
New "🎯 Sales Targets" tab inside Reports. Set a weekly tonnage target per sales
executive — actual tons achieved is calculated automatically from Orders (using each
line item's kg/tons unit). Any shortfall automatically rolls forward: if Ravi's target
is 5 tons and he does 3.5, the next week's target becomes 5 + 1.5 = 6.5 tons due.

### 12. Active Clients — Grade, Lead Converted By, richer conversion
- New **Grade** field (A/B/C) to rank customers
- New **Lead Converted By** — pick which sales executive gets credit, set right at
  the moment you click "Mark Converted" on a Client Visit (or edit it later)
- Filter Active Clients by who converted them
- Sales executives are managed in **Settings → Sales Team** (separate from login
  accounts, just a name + phone list)

### 13. WhatsApp — built to never silently fail
- Failed sends are automatically **retried** on a backoff schedule (1 min, 5 min, 15
  min, 1 hour, 4 hours) for transient issues like rate limits or network blips —
  permanent failures (bad number, rejected template) are not retried and are clearly
  marked
- The webhook now also captures **inbound replies** from clients, visible via the WA
  Log / replies endpoints, linked back to the message they're replying to
- Delivery status (sent → delivered → read) keeps updating automatically as before

---

## Upgrading from an earlier version of this app

If you already have this app deployed with real data, just replace the code with this new version
and redeploy — **your existing data is preserved automatically**. On first boot, the app adds the
new `lead_status` column and any new tables (`visit_logs`, `orders`, `order_items`) to your existing
database without touching anything already there.



## Local testing (optional, if you want to try it on your own computer first)

```
cd backend
npm install
npm start
```
Then open `http://localhost:3000` in your browser.

---

## Backing up your data

Your data lives in one file. On Render, you can download a backup from the **Shell** tab of your
service by running:
```
cat /var/data/visitbook.sqlite | base64
```
and saving the output, or ask me for a script that emails/exports a backup on a schedule if you want this automated.
