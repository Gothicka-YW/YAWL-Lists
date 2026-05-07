# WTB & WTS Hosting, Selling, Distribution, and Security Options

This document outlines practical options to host, sell, and distribute WTB & WTS without running a server at home, plus security guidance for a paid Chrome extension.

## Constraints and goals

- Do not self-host from home.
- Sell through a reliable payment flow.
- Distribute primarily through Chrome Web Store.
- Reduce copying abuse while accepting that client code can be extracted.

## 1. Hosting options (no home server)

### Option A: Serverless backend (recommended starting point)

Use hosted serverless functions plus managed storage.

Examples:
- Cloudflare Workers + D1 + KV/R2
- Vercel Functions + Neon/Supabase Postgres + Blob storage
- AWS Lambda + API Gateway + DynamoDB + S3

Use cases:
- License verification endpoint
- Entitlement checks for premium features
- Usage/rate-limit enforcement

Pros:
- No server maintenance
- Scales automatically
- Pay for usage

Cons:
- Vendor-specific limits
- Requires good monitoring and retries

### Option B: Backend-as-a-Service (BaaS)

Use a hosted platform with auth and database included.

Examples:
- Supabase
- Firebase

Use cases:
- User auth and session management
- License state storage
- Admin dashboard for entitlements

Pros:
- Fast to ship
- Built-in auth and data APIs

Cons:
- Security rules must be carefully configured
- Vendor lock-in risk

### Option C: Managed app hosting (PaaS)

Run a normal API service on a managed host.

Examples:
- Render
- Railway
- Fly.io

Pros:
- Full control of API framework/runtime

Cons:
- More ops than serverless/BaaS
- Must manage scaling and uptime settings

## 2. Selling options

### Merchant of Record platforms (simplest for tax/compliance)

Examples:
- Paddle
- Lemon Squeezy

Pros:
- Handles VAT/sales tax and many compliance tasks
- Quick checkout setup

Cons:
- Platform fees and payout schedule constraints

### Direct processor

Example:
- Stripe

Pros:
- Full checkout control
- Broad ecosystem

Cons:
- You handle tax stack, invoicing rules, and more legal overhead

## 3. Distribution options

### Primary: Chrome Web Store

- Best install trust and update flow for Chrome users.
- Required for mainstream reach.

### Secondary: Edge Add-ons

- Minimal extra work for more users.
- Same client code exposure risk as Chrome.

### Avoid for paid consumer workflow

- Direct CRX distribution for general users.
- Manual update channels that increase support burden.

## 4. Security model for paid extensions

## What cannot be fully protected

- Client-side extension code can be unpacked and inspected.
- Obfuscation slows reverse engineering but does not stop it.

## What you can protect effectively

- Paid feature access
- License validity
- Entitlement decisions

### Recommended controls

- Keep license checks and entitlement logic server-side.
- Use short-lived signed tokens (for example, 5 to 30 minutes).
- Revalidate entitlements periodically and on startup.
- Add rate limits per account/license/IP.
- Add abuse detection and revoke compromised keys quickly.
- Remove source maps and debug helpers from release builds.
- Minify/obfuscate release JS as a deterrent.

## 5. Legal and privacy assets to publish

Required project assets:
- Privacy Policy
- Terms of Use / EULA
- Refund policy
- Non-affiliation disclaimer
- Support and legal contact email

Suggested minimum disclosures:
- What data is stored locally/synced
- What data is sent to third-party APIs
- Whether personal data is sold (usually no)
- Retention/deletion process
- How paid-license data is processed

## 6. Suggested rollout plan (no home server)

### Phase 1: Foundation (1 week)

- Pick payment platform (Paddle/Lemon Squeezy/Stripe).
- Publish Privacy Policy and Terms drafts.
- Add legal disclaimers in extension and store listing.

### Phase 2: License API MVP (1 to 2 weeks)

- Build endpoints: activate, validate, deactivate license.
- Store license state and device/session limits.
- Add logging, rate limits, and admin revoke action.

### Phase 3: Extension integration (1 week)

- Add startup entitlement check and periodic refresh.
- Gate premium features behind server-validated status.
- Add graceful offline behavior and clear user messaging.

### Phase 4: Hardening and launch prep (1 week)

- Minify/obfuscate release assets.
- Remove debug logs/source maps.
- Run abuse test cases (shared keys, replay, expired tokens).

## 7. Recommended stack for your case

If you want low ops and fast launch:

- Hosting: Cloudflare Workers + D1 (or Supabase)
- Selling: Paddle or Lemon Squeezy
- Distribution: Chrome Web Store (+ Edge Add-ons later)
- Security: server-side entitlement checks + short-lived signed tokens + revocation

This gives strong business protection without home hosting and without heavy infrastructure overhead.

## 8. Pricing options and budget planning (estimates)

Pricing changes often. Treat these as planning ranges, then verify current platform pricing pages before launch.

### Hosting budget ranges (monthly)

| Stack | Starter budget | Growth budget | Notes |
|---|---:|---:|---|
| Cloudflare Workers + D1/KV | $0 to $15 | $15 to $75 | Lowest ops overhead; good for license API and entitlement checks |
| Supabase (Auth + DB + functions) | $0 to $25 | $25 to $150 | Fast setup with built-in auth and database |
| Vercel Functions + managed DB | $0 to $30 | $30 to $200 | Good DX; watch bandwidth/function limits |
| Render/Railway/Fly API service | $7 to $30 | $30 to $250 | More control, slightly more operations work |

### Payment fee model options

| Model | Typical fee shape | Best when |
|---|---|---|
| Merchant of Record (Paddle/Lemon Squeezy) | Often higher percentage + fixed fee per sale | You want tax/VAT and compliance handled for you |
| Direct processor (Stripe) | Usually lower processor fee; you add tax/compliance stack | You want maximum control and lower processor cost |

### Practical launch budget examples

Assume:
- 100 paid users in month 1
- Low-ops serverless hosting
- One-time extension pricing

Estimated monthly non-transaction costs:
- Lean setup: $10 to $40
- Growth setup: $40 to $180

One-time store/admin costs:
- Chrome Web Store developer registration: one-time fee
- Domain + email: usually low monthly cost

### NH, USA business setup and operating costs (add to pricing)

This is a planning guide, not legal or tax advice. Confirm current amounts and filing requirements with NH resources and a qualified tax professional.

Potential one-time startup costs:

| Item | Typical planning range | Notes |
|---|---:|---|
| NH LLC filing | $100 to $120 | Filing fee can vary by filing method and updates over time |
| Registered agent setup | $0 to $150 | $0 if you self-serve and qualify; paid services cost more |
| Basic legal templates/review | $0 to $600 | Depends on whether you use templates or attorney review |

Potential recurring annual or monthly costs:

| Item | Typical planning range | Notes |
|---|---:|---|
| NH annual report | About $100/year | Budget as a recurring compliance cost |
| Registered agent service | $100 to $300/year | If you use a commercial registered agent |
| Business banking | $0 to $25/month | Varies by bank and account type |
| Accounting/tax prep | $300 to $2,000/year | Depends on complexity and sales volume |
| Business insurance (optional but common) | $300 to $1,200/year | Coverage and risk profile drive cost |

Tax/compliance note for planning:
- NH does not have a broad state sales tax, but business-level NH taxes and federal tax obligations may still apply.
- If you use a Merchant of Record, many indirect-tax tasks are simplified, but your own business taxes and reporting still remain your responsibility.

### Price-point math (quick guide)

If you use a fee model around `8% + $0.50` per transaction, approximate net per sale is:

`net = price - (price * 0.08 + 0.50)`

Examples:
- $5.00 price -> about $4.10 net before hosting/support
- $10.00 price -> about $8.70 net before hosting/support
- $15.00 price -> about $13.30 net before hosting/support
- $20.00 price -> about $17.90 net before hosting/support

To include business overhead in pricing, use:

net_after_fees = price - (price * processor_rate + processor_fixed)

monthly_fixed_costs = hosting + business_overhead + software_tools

sales_needed_for_break_even = monthly_fixed_costs / net_after_fees

Quick examples (using 8% + $0.50):
- At $12 price, net_after_fees is about $10.54.
- If monthly_fixed_costs is $150, break-even is about 15 sales/month.
- If monthly_fixed_costs is $350, break-even is about 34 sales/month.

### Suggested pricing options to test

- Early-access lifetime: $9 to $12
- Standard lifetime: $14 to $19
- Optional launch discount window: 20% to 35% for first adopters

For WTB & WTS, a practical starting point is often:
- Launch at around $12 to $15 lifetime
- Re-evaluate after first 50 to 100 buyers based on support load and conversion rate
