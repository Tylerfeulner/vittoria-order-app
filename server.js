if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const multer  = require('multer');
const Anthropic   = require('@anthropic-ai/sdk');
const OAuthClient = require('intuit-oauth');
const QuickBooks  = require('node-quickbooks');

const TOKEN_PATH = path.resolve(__dirname, '.qbo-token');

// Read the current refresh token — .qbo-token takes priority over .env.
function readRefreshToken() {
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (t) return t;
  } catch { /* file not created yet */ }
  return process.env.QBO_REFRESH_TOKEN || null;
}

// Persist a rotated token to .qbo-token only — never touches .env.
function saveRefreshToken(token) {
  try {
    fs.writeFileSync(TOKEN_PATH, token, 'utf8');
    process.env.QBO_REFRESH_TOKEN = token; // keep in-memory in sync
    console.log('[qbo-auth] Refresh token saved to .qbo-token');
  } catch (err) {
    console.error('[qbo-auth] Failed to save refresh token to .qbo-token:', err.message);
  }
}

// Seed in-memory value from .qbo-token at startup so the first request works.
const _startupToken = readRefreshToken();
if (_startupToken) process.env.QBO_REFRESH_TOKEN = _startupToken;

const app = express();

app.use(express.json());
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Always create a fresh OAuthClient — never share one instance across requests.
// A shared (singleton) client causes a race condition when two requests call
// setToken() + refresh() concurrently: the second setToken() overwrites the
// first before refresh() resolves, sending the wrong token to Intuit.
function makeOAuthClient() {
  return new OAuthClient({
    clientId:     process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment:  process.env.QBO_ENVIRONMENT || 'production',
    redirectUri:  process.env.QBO_REDIRECT_URI,
  });
}

// ── OAuth routes ──────────────────────────────────────────────────────────────

app.get('/auth', (_req, res) => {
  const authUri = makeOAuthClient().authorizeUri({
    scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
    state: 'vittoria-app',
  });
  res.redirect(authUri);
});

app.get('/callback', async (req, res) => {
  try {
    const authResponse = await makeOAuthClient().createToken(req.url);
    const tokens = authResponse.getJson();
    const realmId = req.query.realmId || '';

    saveRefreshToken(tokens.refresh_token);

    const tokenSaved = (() => {
      try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim() === tokens.refresh_token; }
      catch { return false; }
    })();

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>QuickBooks Connected</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 680px; margin: 60px auto; padding: 24px; }
    h2 { color: #059669; margin-bottom: 16px; }
    .ok  { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
    .warn{ background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
    pre  { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 20px; font-size: 0.9rem; word-break: break-all; white-space: pre-wrap; }
    p    { margin: 10px 0; color: #374151; line-height: 1.6; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    a    { color: #1a56db; }
  </style>
</head>
<body>
  <h2>✓ QuickBooks Connected!</h2>

  <div class="${tokenSaved ? 'ok' : 'warn'}">
    ${tokenSaved
      ? '✓ Refresh token automatically saved to <code>.qbo-token</code> — no manual steps needed.'
      : '⚠ Token was not saved to <code>.qbo-token</code> — check file permissions, then use /save-token.'}
  </div>

  ${realmId ? `
  <p>Add your Realm ID to <code>.env</code> if it isn't already there:</p>
  <pre>QBO_REALM_ID=${realmId}</pre>` : ''}

  <p>The refresh token will rotate and save automatically on every request.</p>
  <p><a href="/">Open the app →</a></p>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<pre style="color:red">OAuth error: ${err.message}</pre>`);
  }
});

app.get('/debug-env', (_req, res) => {
  const preview = (v) => v ? `${v.substring(0, 4)}…` : '(not set)';
  const result = {
    ANTHROPIC_API_KEY:  preview(process.env.ANTHROPIC_API_KEY),
    QBO_CLIENT_ID:      preview(process.env.QBO_CLIENT_ID),
    QBO_CLIENT_SECRET:  preview(process.env.QBO_CLIENT_SECRET),
    QBO_REDIRECT_URI:   process.env.QBO_REDIRECT_URI  || '(not set)',
    QBO_REALM_ID:       preview(process.env.QBO_REALM_ID),
    QBO_REFRESH_TOKEN:  preview(process.env.QBO_REFRESH_TOKEN),
    QBO_ENVIRONMENT:    process.env.QBO_ENVIRONMENT   || '(not set)',
    NODE_ENV:           process.env.NODE_ENV          || '(not set)',
  };
  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    result['.qbo-token'] = t ? `${t.substring(0, 4)}…` : '(empty)';
  } catch {
    result['.qbo-token'] = '(file not found)';
  }
  res.json(result);
});

app.post('/save-token', (req, res) => {
  const token = req.body?.token?.trim();
  if (!token) return res.status(400).json({ error: 'token is required' });
  saveRefreshToken(token);
  res.json({ success: true, message: 'Token saved to .qbo-token' });
});

// ── QBO helpers ───────────────────────────────────────────────────────────────

// Promisify the node-quickbooks callback-based methods
function qboCall(qbo, method, ...args) {
  return new Promise((resolve, reject) => {
    qbo[method](...args, (err, data) => {
      if (err) {
        const detail =
          err?.Fault?.Error?.[0]?.Detail ||
          err?.Fault?.Error?.[0]?.Message ||
          err?.message ||
          JSON.stringify(err);
        reject(new Error(detail));
      } else {
        resolve(data);
      }
    });
  });
}

async function getQBOClient() {
  // ── Determine token source ──
  let refreshToken = null;
  let tokenSource  = '.env fallback';
  try {
    const fileToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (fileToken) { refreshToken = fileToken; tokenSource = '.qbo-token'; }
  } catch { /* file doesn't exist yet */ }
  if (!refreshToken) refreshToken = process.env.QBO_REFRESH_TOKEN || null;

  const env    = process.env.QBO_ENVIRONMENT || 'production';
  const realmId = process.env.QBO_REALM_ID   || '(not set)';

  console.log('[qbo-auth] token source  :', tokenSource);
  console.log('[qbo-auth] token preview :', refreshToken ? refreshToken.substring(0, 20) + '…' : '(none)');
  console.log('[qbo-auth] environment   :', env);
  console.log('[qbo-auth] realm ID      :', realmId);

  if (!refreshToken) {
    throw new Error('No QBO refresh token found. Visit /auth to connect QuickBooks.');
  }

  // Fresh client per request — avoids setToken() race between concurrent calls.
  const client = makeOAuthClient();
  client.setToken({ refresh_token: refreshToken, token_type: 'bearer' });

  const authResponse = await client.refresh();
  const tokens = authResponse.getJson();

  // QBO issues a new refresh token on every use — persist it immediately so
  // the next request doesn't try to reuse the now-invalid old token.
  if (tokens.refresh_token) {
    saveRefreshToken(tokens.refresh_token);
  }

  const isSandbox = env === 'sandbox';
  return new QuickBooks(
    process.env.QBO_CLIENT_ID,
    process.env.QBO_CLIENT_SECRET,
    tokens.access_token,
    false,
    process.env.QBO_REALM_ID,
    isSandbox,
    false,
    null,
    '2.0',
    tokens.refresh_token
  );
}

// Escape a value for use inside a QBO SQL string literal.
function qboEscape(val) {
  return String(val).replace(/'/g, "''");
}

// Look up a QBO item using the product code (sku) against the Name field.
// QBO items are named by code (e.g. "D11921") — description matching is unreliable.
// Sequence: exact Name = code  →  Name LIKE %code%  →  null (caller will create).
// Returns the item object or null. Logs every step to the console.
async function findItemInQBO(qbo, name, sku) {
  console.log(`[item-lookup] ---- code="${sku || '(none)'}" description="${name}"`);

  if (!sku) {
    console.log(`[item-lookup] ✗ no code extracted from PDF — cannot match, will create`);
    return null;
  }

  const escapedSku = qboEscape(sku);

  // 1. Exact Name = code
  const q1 = `SELECT * FROM Item WHERE Name = '${escapedSku}'`;
  console.log(`[item-lookup] try 1: ${q1}`);
  const r1 = await qboCall(qbo, 'query', q1);
  const hit1 = r1.QueryResponse?.Item;
  console.log(`[item-lookup] try 1 result: ${hit1?.length
    ? hit1.map(i => `Name="${i.Name}" Id=${i.Id} UnitPrice=${i.UnitPrice ?? '(none)'}`).join(' | ')
    : 'no results'}`);
  if (hit1?.length) {
    console.log(`[item-lookup] ✓ matched on exact Name`);
    return hit1[0];
  }

  // 2. Name LIKE %code%
  const q2 = `SELECT * FROM Item WHERE Name LIKE '%${escapedSku}%'`;
  console.log(`[item-lookup] try 2: ${q2}`);
  const r2 = await qboCall(qbo, 'query', q2);
  const hit2 = r2.QueryResponse?.Item;
  console.log(`[item-lookup] try 2 result: ${hit2?.length
    ? hit2.map(i => `Name="${i.Name}" Id=${i.Id} UnitPrice=${i.UnitPrice ?? '(none)'}`).join(' | ')
    : 'no results'}`);
  if (hit2?.length) {
    console.log(`[item-lookup] ✓ matched on Name LIKE`);
    return hit2[0];
  }

  console.log(`[item-lookup] ✗ no match for code="${sku}" — will create new item`);
  return null;
}

// Find an existing item (SKU → name) or create a NonInventory item with both
// IncomeAccountRef (for invoices) and ExpenseAccountRef (for bills).
async function findOrCreateItem(qbo, name, sku, cache) {
  const cacheKey = sku || name.replace(/['"]/g, '').substring(0, 100);

  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const existing = await findItemInQBO(qbo, name, sku);
  if (existing) {
    cache.set(cacheKey, existing);
    return existing;
  }

  // Find an income account for invoice lines
  const ir = await qboCall(qbo, 'findAccounts', [
    { field: 'AccountType', value: 'Income', operator: '=' },
    { field: 'Active',      value: 'true',   operator: '=' },
  ]);
  const incomeAccounts = ir.QueryResponse?.Account;
  if (!incomeAccounts?.length) throw new Error('No active Income account found in QuickBooks.');
  const incomeAccount =
    incomeAccounts.find(a => a.AccountSubType === 'SalesOfProductIncome') ||
    incomeAccounts.find(a => a.Name.toLowerCase().includes('sales')) ||
    incomeAccounts[0];

  // Find a COGS/expense account for bill lines
  const er = await qboCall(qbo, 'findAccounts', [
    { field: 'AccountType', value: 'Cost of Goods Sold', operator: '=' },
    { field: 'Active',      value: 'true',               operator: '=' },
  ]);
  let expenseAccount = er.QueryResponse?.Account?.[0];
  if (!expenseAccount) {
    const er2 = await qboCall(qbo, 'findAccounts', [
      { field: 'AccountType', value: 'Expense', operator: '=' },
      { field: 'Active',      value: 'true',    operator: '=' },
    ]);
    expenseAccount =
      er2.QueryResponse?.Account?.find(a => a.Name.toLowerCase().includes('cost of goods')) ||
      er2.QueryResponse?.Account?.[0];
  }
  if (!expenseAccount) throw new Error('No COGS or Expense account found in QuickBooks.');

  // Name new items by code so future lookups find them.
  // Fall back to description only when no code was extracted.
  const newItemName = (sku || name.replace(/['"]/g, '').trim()).substring(0, 100);
  console.log(`[item-lookup] creating new QBO item Name="${newItemName}"`);
  const created = await qboCall(qbo, 'createItem', {
    Name: newItemName,
    Type: 'NonInventory',
    IncomeAccountRef:  { value: incomeAccount.Id,  name: incomeAccount.Name  },
    ExpenseAccountRef: { value: expenseAccount.Id, name: expenseAccount.Name },
    TrackQtyOnHand: false,
  });
  const item = created.Item || created;
  console.log(`[item-lookup] created item Id=${item.Id}`);
  cache.set(cacheKey, item);
  return item;
}

// ── PDF upload + Claude extraction ───────────────────────────────────────────

app.post('/upload', upload.single('po_file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded.' });

  const base64PDF = req.file.buffer.toString('base64');

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system:
        'You extract purchase order data from PDFs and respond with valid JSON only — ' +
        'no markdown fences, no explanation, just the raw JSON object.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64PDF,
              },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Extract all purchase order details from this PDF and return this exact JSON structure:
{
  "po_number": "string or null",
  "order_date": "YYYY-MM-DD or null",
  "line_items": [
    {
      "product_name": "string",
      "sku": "string or null",
      "quantity": number,
      "unit_price": number
    }
  ]
}
Use null for missing strings and 0 for missing numbers. Dates must be YYYY-MM-DD.`,
            },
          ],
        },
      ],
    });

    let text = message.content[0].text.trim();
    // Strip markdown code fences if the model wraps output despite the prompt
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const data = JSON.parse(text);
    res.json(data);
  } catch (err) {
    console.error('Claude extraction error:', err);
    const msg = err instanceof SyntaxError
      ? 'Claude returned unexpected output — please try again.'
      : `PDF extraction failed: ${err.message}`;
    res.status(500).json({ error: msg });
  }
});

// ── Create QBO Bill ──────────────────────────────────────────────────────────

app.post('/create-orders', async (req, res) => {
  const { po_number, order_date, line_items } = req.body;

  if (!line_items?.length) return res.status(400).json({ error: 'No line items provided.' });

  try {
    const qbo     = await getQBOClient();
    const txnDate = order_date || new Date().toISOString().split('T')[0];

    // ── Find Vittoria vendor — exact name first, LIKE fallback ──
    let vendor;
    const vr1 = await qboCall(qbo, 'query',
      "SELECT * FROM Vendor WHERE DisplayName = 'Vittoria Coffee USA'"
    );
    if (vr1.QueryResponse?.Vendor?.length) {
      vendor = vr1.QueryResponse.Vendor[0];
      console.log(`[vendor] matched exact: "${vendor.DisplayName}" Id=${vendor.Id}`);
    } else {
      console.log('[vendor] exact match not found, trying LIKE fallback');
      const vr2 = await qboCall(qbo, 'query',
        "SELECT * FROM Vendor WHERE DisplayName LIKE '%Vittoria%'"
      );
      if (vr2.QueryResponse?.Vendor?.length) {
        vendor = vr2.QueryResponse.Vendor[0];
        console.log(`[vendor] matched LIKE: "${vendor.DisplayName}" Id=${vendor.Id}`);
      }
    }
    if (!vendor) {
      return res.status(400).json({
        error: 'Vendor "Vittoria Coffee USA" not found in QuickBooks. Please add the vendor and try again.',
      });
    }

    // ── Build Bill lines — item lookup matches product code against QBO Name field ──
    const itemCache = new Map();
    const billLines = [];

    for (const item of line_items) {
      const qboItem = await findOrCreateItem(qbo, item.product_name, item.sku, itemCache);
      const desc    = [item.product_name, item.sku ? `(${item.sku})` : ''].filter(Boolean).join(' ');
      billLines.push({
        Amount: parseFloat((item.unit_price * item.quantity).toFixed(2)),
        DetailType: 'ItemBasedExpenseLineDetail',
        Description: desc,
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: qboItem.Id, name: qboItem.Name },
          Qty: item.quantity,
          UnitPrice: item.unit_price,
          BillableStatus: 'NotBillable',
        },
      });
    }

    // ── Create Bill ──
    const billResult = await qboCall(qbo, 'createBill', {
      DocNumber: po_number || undefined,
      TxnDate: txnDate,
      VendorRef: { value: vendor.Id },
      Line: billLines,
    });

    const billId    = billResult.Bill.Id;
    const billTotal = billLines.reduce((s, l) => s + l.Amount, 0).toFixed(2);

    res.json({
      success: true,
      po_number,
      bill: {
        id: billId,
        total: billTotal,
        url: `https://app.qbo.intuit.com/app/bill?txnId=${billId}`,
      },
    });
  } catch (err) {
    console.error('QBO error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vittoria Order Processor → http://localhost:${PORT}`);

  const mask = (v) => v ? `${v.substring(0, 4)}${'*'.repeat(Math.max(0, v.length - 4))}` : '(not set)';
  const flag = (v) => v ? '✓ set' : '✗ MISSING';

  console.log('[env] ANTHROPIC_API_KEY  ', flag(process.env.ANTHROPIC_API_KEY));
  console.log('[env] QBO_CLIENT_ID      ', flag(process.env.QBO_CLIENT_ID),   mask(process.env.QBO_CLIENT_ID));
  console.log('[env] QBO_CLIENT_SECRET  ', flag(process.env.QBO_CLIENT_SECRET));
  console.log('[env] QBO_REDIRECT_URI   ', flag(process.env.QBO_REDIRECT_URI),  process.env.QBO_REDIRECT_URI || '');
  console.log('[env] QBO_REALM_ID       ', flag(process.env.QBO_REALM_ID),    mask(process.env.QBO_REALM_ID));
  console.log('[env] QBO_REFRESH_TOKEN  ', flag(process.env.QBO_REFRESH_TOKEN));
  console.log('[env] QBO_ENVIRONMENT    ', flag(process.env.QBO_ENVIRONMENT),   process.env.QBO_ENVIRONMENT || '(not set — defaults to production)');

  try {
    const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    console.log('[env] .qbo-token file    ✓ present', mask(t));
  } catch {
    console.log('[env] .qbo-token file    (not found — will use QBO_REFRESH_TOKEN from env)');
  }
});
