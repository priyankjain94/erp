# Make My Space — CRM + Operations platform

One application for the whole business: CRM (leads, partners, automations), project and item pipeline (survey → drawing → PI → order → dispatch → install → snag → handover → feedback), tasks with WhatsApp reminders, installer mobile app, customer portal, users and access control, WhatsApp Cloud API and Meta Lead Ads.

```
apps/api     Node 22 + TypeScript API, PostgreSQL 16, job queue + scheduler (no Redis needed)
apps/web     The web + mobile app (served by the API at /, customer portal at /c, installable as a PWA)
deploy/      Caddyfile (HTTPS) and backup script
```

| Who | Logs in at | With |
|---|---|---|
| Staff (owner, ops head, PM, sales, surveyor, designer, purchase) | `https://DOMAIN/` | WhatsApp number + OTP |
| Installation teams (team lead) | same URL on the phone; opens the Installer app | WhatsApp number + OTP |
| Customers | `https://DOMAIN/c` | the mobile number on their project + OTP |

---

## 1. Server

A **Hostinger KVM VPS** works well. Shared/"web hosting" plans do **not** work (they cannot run Node services, PostgreSQL or background jobs).

| Size | Fits |
|---|---|
| KVM 2 (2 vCPU, 8 GB RAM, 100 GB NVMe) | recommended: up to ~50 staff, thousands of projects, photos on disk |
| KVM 1 (1 vCPU, 4 GB) | trial / under 15 users |

Pick the **India (Mumbai)** data centre if offered, and the **Ubuntu 24.04 with Docker** template.

## 2. Deploy (about 20 minutes)

```bash
# DNS: add an A record  erp.yourdomain.in → VPS IP   (wait until `ping erp.yourdomain.in` shows the IP)
ssh root@VPS_IP
apt update && apt -y upgrade
curl -fsSL https://get.docker.com | sh            # skip if the Docker template is used
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

git clone https://github.com/<owner>/<repo>.git /opt/mms-platform   # or upload the zip and unzip there
cd /opt/mms-platform
cp .env.example .env && nano .env                  # fill DOMAIN, POSTGRES_PASSWORD, JWT secrets, ADMIN_PHONE
docker compose up -d --build
docker compose logs -f app                         # wait for "Make My Space API on :8080 (production)"
```

Open `https://DOMAIN` → log in with `ADMIN_PHONE`. Until WhatsApp is connected (section 3) codes cannot be delivered, so in that "simulated" mode the server prints them to its log for the first login:

```bash
docker compose logs app | grep "whatsapp simulated"   # → ... login_otp - code 4821
```

Once `WHATSAPP_ACCESS_TOKEN` is set, codes go only to WhatsApp and are wiped from the message log after sending.

Then add users in **Users and access**, and installation teams in **Installer management → Add installation team**.

**Updates:** `git pull && docker compose up -d --build` (migrations run automatically on start).

**Backups:** `chmod +x deploy/backup.sh` and add to `crontab -e`: `30 2 * * * /opt/mms-platform/deploy/backup.sh`. Also enable Hostinger's weekly VPS snapshot, and copy `/var/backups/mms` off the server (rclone to Google Drive/S3).

## 3. Connect WhatsApp (Meta Cloud API)

What you need: a Meta Business Portfolio (verified), a phone number that is **not** on the WhatsApp app, and a payment method in WhatsApp Manager.

1. developers.facebook.com → **Create app** → type *Business* → add **WhatsApp**.
2. WhatsApp → API setup → add and verify your business number. Copy **Phone number ID** and **WhatsApp Business Account ID** into `.env`.
3. Business Settings → **System users** → add an admin system user → **Generate token** for your app with `whatsapp_business_messaging` and `whatsapp_business_management`, expiry *Never*. Put it in `WHATSAPP_ACCESS_TOKEN`. (Do not use the 24-hour test token.)
4. App → Settings → Basic → copy **App secret** to `META_APP_SECRET`. Choose any random `WHATSAPP_VERIFY_TOKEN`.
5. `docker compose up -d` to load the new settings.
6. App → WhatsApp → **Configuration → Webhook**: Callback URL `https://DOMAIN/api/v1/webhooks/whatsapp`, Verify token = `WHATSAPP_VERIFY_TOKEN` → Verify and save → subscribe to **messages**.
7. In the app, **Users and access → WhatsApp and Meta → Sync templates**. This submits all 23 message templates (OTP, task assigned/reminder/escalation, daily digest, drawing approval, installation scheduled, feedback, lead follow-ups…). Meta usually approves utility/authentication templates within minutes to a few hours; status shows on the same screen.

Until templates are approved, sends fail and are retried by the job queue; nothing is lost.

## 4. Connect Meta Lead Ads (Facebook + Instagram lead forms)

1. In the same Meta app add **Webhooks** → object **Page** → Callback `https://DOMAIN/api/v1/webhooks/meta-leads`, Verify token = `META_LEADS_VERIFY_TOKEN` → subscribe to **leadgen**.
2. Give the system user access to your Facebook Page and ad account, and generate a token with `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement`, `ads_management`. Put it in `META_PAGE_ACCESS_TOKEN`, Page ID in `META_PAGE_ID`, restart.
3. Subscribe the Page once: log in as owner and call
   `POST /api/v1/admin/meta/subscribe-page` (e.g. from the browser console: `API.call('POST','/admin/meta/subscribe-page')`).
4. Business Settings → Integrations → **Leads access** → allow your app (CRM) for the Page.
5. Test with the **Lead Ads Testing Tool** (developers.facebook.com/tools/lead-ads-testing). The lead appears in the CRM within seconds, owner assigned round-robin, welcome WhatsApp sent, "Call new lead" task created.

Form questions map automatically: full name, phone, email, city; any other question (e.g. "what do you need") goes into the lead's interest/notes. A 15-minute poll also picks up any lead whose webhook was missed, without duplicates.

App Review: if the app is used only by your own business with your own Page and system user, *Standard access* is enough for most setups. If Meta asks for Advanced access for `leads_retrieval`, submit App Review with a screen recording of the CRM.

## 5. Security built in

- OTP-only login (no passwords): hashed codes, 5-minute expiry, 5 attempts, per-number and per-IP rate limits.
- Short access tokens (15 min) + rotating refresh sessions in httpOnly cookies; deactivating a user logs them out everywhere.
- Permissions enforced on the server for every request; installers see only their jobs, customers only their project; no money data to installers.
- Every webhook verified with Meta's HMAC signature; duplicate deliveries ignored; WhatsApp button replies honoured only from the right person's number.
- Audit log of every user, role and override change; stage gates with owner-only override that records a reason.
- Security headers + CSP, HTTPS with HSTS via Caddy, database not exposed to the internet.

## 6. Development

```bash
docker run -d --name pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:16-alpine
cd apps/api && npm install
DEMO_MODE=true SEED_DEMO=true npm run dev            # http://localhost:8080  (OTP shown on screen; demo numbers +91 90000 00001…14)
createdb -h localhost -U postgres mms_test && DATABASE_URL=postgres://postgres@localhost:5432/mms_test npm test
```

Tests: `apps/api/test/acceptance.test.ts` — 15 end-to-end scenarios (logins and role scoping, teams, assignment, CRM automations and conversion, survey with photo upload, every stage gate, customer approval, payments, installer OTP sign-off with snags, task handover/proof/repeat, permissions, WhatsApp send/webhook/buttons, Meta Lead Ads webhook + poll, reminders, token rotation). They wipe the target database.

## 7. Running costs (approx.)

- Hostinger KVM 2: about ₹700–900/month on a 24-month plan.
- Domain: about ₹800/year.
- WhatsApp: charged per delivered template message by category (utility and authentication are cheap in India, marketing costs more). Meta's pricing changes from time to time; check WhatsApp Manager → Pricing.
