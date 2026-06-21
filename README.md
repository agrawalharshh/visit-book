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
| 🏠 Client Visits | All clients you've visited or plan to visit. Has its own follow-up date field. |
| 🔔 Today's Follow-ups | Auto-pulls anyone from Client Visits whose follow-up date is today or earlier. One click marks it done. |
| ⭐ Active Clients | Your regular paying clients, with monthly value tracking. |
| 📅 Meetings | Schedule meetings with date/time/notes, independent of visits. |
| 📊 Swa Data | Import a CSV/Excel with columns SR, COMPANY, CLIENT, PHONE, ADDRESS, REMARKS. Select rows with checkboxes. |
| ✅ Swa Selected | When you click "Move & Send" in Swa Data, selected rows move here AND a WhatsApp summary message is sent to one number you choose (e.g. your dispatch/team number). |
| 💬 WA Log | Every WhatsApp message ever sent through the app, with live delivery status. |
| 📈 Reports | Visit counts, follow-ups pending, meetings done, WhatsApp send/delivery stats — filterable by date range. |
| ⚙️ Settings | WhatsApp connection, approved templates list, and your account password. |

Every WhatsApp send anywhere in the app uses your **approved Meta templates** — you pick the template from a dropdown, the app fills in the variables from that client's data, you can edit them, preview the exact message, then send.

---

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
