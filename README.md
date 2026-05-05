# Vittoria Order Processor

Upload a Vittoria PDF purchase order → Claude AI extracts the line items → review and edit → one click creates a **Bill** (owed to Vittoria Coffee USA) in QuickBooks Online.

---

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- **QuickBooks Online** account (any plan)
- **QuickBooks developer app** with OAuth 2.0 credentials

---

## Step 1 — Create a QuickBooks Developer App

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in.
2. Click **Dashboard → Create an app → QuickBooks Online and Payments**.
3. Give it a name (e.g. "Vittoria Order Processor").
4. Under **Development → Keys & credentials**, copy your **Client ID** and **Client Secret**.
5. Under **Redirect URIs**, add: `http://localhost:3000/callback`
6. Under **Scopes**, enable **Accounting**.

---

## Step 2 — Install Dependencies

```bash
cd vittoria-order-app
npm install
```

---

## Step 3 — Configure Environment Variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

Open `.env` and set:

| Variable | Where to find it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com/settings/api-keys](https://console.anthropic.com/settings/api-keys) |
| `QBO_CLIENT_ID` | Intuit developer dashboard → your app → Keys & credentials |
| `QBO_CLIENT_SECRET` | Same as above |
| `QBO_REDIRECT_URI` | Leave as `http://localhost:3000/callback` |
| `QBO_REALM_ID` | Filled in during Step 4 |
| `QBO_REFRESH_TOKEN` | Filled in during Step 4 |
| `QBO_ENVIRONMENT` | `production` (or `sandbox` for testing against a sandbox company) |
| `PORT` | Leave as `3000` |

---

## Step 4 — Connect QuickBooks (one-time OAuth)

1. Start the server:
   ```bash
   npm start
   ```
2. Open your browser and go to: **http://localhost:3000/auth**
3. Log in to QuickBooks and authorize the app.
4. You will be redirected back and shown two values:
   ```
   QBO_REALM_ID=123456789
   QBO_REFRESH_TOKEN=AB11...
   ```
5. Copy both into your `.env` file.
6. Stop the server (`Ctrl+C`) and restart it:
   ```bash
   npm start
   ```

> **Refresh tokens** expire after 100 days of inactivity. Repeat Step 4 if you see a token error after a long break.

---

## Step 5 — QuickBooks Setup Requirements

Before processing orders, ensure the following exist in your QBO company:

| Requirement | How to add |
|---|---|
| A vendor whose **Display Name** contains "Vittoria" | QBO → Expenses → Vendors → New Vendor |
| At least one **Income** account | Usually pre-exists (e.g. "Sales of Product Income") |
| At least one **Cost of Goods Sold** or **Expense** account | Usually pre-exists (e.g. "Cost of Goods Sold") |

The app will automatically create **NonInventory items** in QBO the first time each product name is processed.

---

## Step 6 — Run the App

```bash
npm start
```

Open **http://localhost:3000** and follow the three-step workflow:

1. **Upload** — drag and drop a Vittoria PDF purchase order.
2. **Review** — check the extracted data (PO number, date, line items and costs).
3. **Confirm** — click the links to open the new Bill and Invoice directly in QuickBooks Online.

---

## Development Mode (auto-restart on file changes)

```bash
npm run dev
```

---

## Troubleshooting

| Error | Fix |
|---|---|
| `QBO_REFRESH_TOKEN not set` | Complete Step 4 |
| `No vendor matching "Vittoria" found` | Add a vendor in QBO whose Display Name contains "Vittoria" |
| `Vendor "Vittoria Coffee USA" not found` | Add a vendor in QBO with the Display Name "Vittoria Coffee USA" |
| `No active Income account found` | Add an Income-type account in QBO → Chart of Accounts |
| `Claude returned unexpected output` | Re-upload the PDF; some scanned/image-only PDFs may not extract cleanly |
| OAuth token expired | Revisit `/auth` to get a new refresh token |
