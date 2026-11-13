# BarberApp — 3-Tier Cloud Application (Flask + PostgreSQL + Docker)

Multi-language (`TR` / `PL` / `UA`) Barber Shop management PWA migrated to a **3-tier cloud architecture** compliant with *Creation and Administration of Cloud Based Applications (WSB Merito Wrocław)*:

1. **Presentation Tier (Frontend):** HTML/CSS/JavaScript PWA in [`public/`](public/)
2. **Application Tier (Backend):** Python 3.12 / Flask REST CRUD API (`app.py`, `store.py`, `security.py`)
3. **Data Tier (Database):** PostgreSQL 16 relational database (`db.py`)

---

## Project Structure

```text
.
├── .github/workflows/deploy.yml  # CI/CD: build linux/amd64 image -> GHCR -> Render Deploy Hook
├── app.py                        # Flask entrypoint, static serving, /health, /api & REST CRUD routes
├── db.py                         # Environment-based PostgreSQL DSN, schema init, health probe
├── schema.sql                    # PostgreSQL relational schema (tables & indexes)
├── store.py                      # Business logic & relational CRUD operations
├── security.py                   # Scrypt password hashing & HMAC-SHA256 token utilities
├── public/                       # Frontend PWA (HTML, CSS, JS, i18n tr/pl/uk, manifest, sw.js)
├── requirements.txt              # Python dependencies (Flask, psycopg2-binary, python-dotenv, gunicorn)
├── Dockerfile                    # Production container image (Python 3.12-slim + Gunicorn)
├── docker-compose.yml            # One-command local 3-tier stack (Flask web + PostgreSQL 16)
├── .env.example                  # Environment variable template (safe to commit)
└── .gitignore                    # Excludes .venv, __pycache__, .env, and build artifacts
```

---

## Quick Start (One-Command Docker Compose)

```bash
cp .env.example .env   # optional: customize passwords/secrets
docker compose up --build
```

- Web UI: <http://localhost:5000>
- Health Check: <http://localhost:5000/health> (returns `{"status": "ok", "db": "connected"}`)

---

## Local Development (Without Compose for Web Tier)

1. **Create virtual environment and install dependencies:**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your local PostgreSQL credentials, ADMIN_DEFAULT_PASSWORD, and MASTER_KEY
   ```

3. **Start PostgreSQL 16 container:**
   ```bash
   docker run -d --name postgres-barber \
     -p 5432:5432 \
     -e POSTGRES_USER=postgres \
     -e POSTGRES_PASSWORD=barber_local_password \
     -e POSTGRES_DB=barberapp \
     postgres:16
   ```

4. **Run Flask app:**
   ```bash
   python app.py
   ```

5. **Inspect PostgreSQL tables (`psql`):**
   ```bash
   docker exec -it postgres-barber psql -U postgres -d barberapp
   # Inside psql: \dt | \d barbers | SELECT * FROM services; | \q
   ```

---

## API Overview

- **Health Check:** `GET /health` → `200 {"status": "ok", "db": "connected"}` (or `503` if DB unreachable)
- **Authentication:**
  - `POST /api/auth/login`
  - `POST /api/auth/register-admin` (requires `MASTER_KEY`)
  - `POST /api/auth/reset-password` (requires `MASTER_KEY`)
  - `PUT /api/auth/password` (Bearer token, admin)
- **Dashboard Summary:** `GET /api/dashboard`
- **RESTful CRUD Resources (Bearer token required):**
  - **Barbers:** `GET /api/barbers`, `GET /api/barbers/<id>`, `POST /api/barbers`, `PUT/PATCH /api/barbers/<id>`, `DELETE /api/barbers/<id>`
  - **Services:** `GET /api/services`, `GET /api/services/<id>`, `POST /api/services`, `PUT/PATCH /api/services/<id>`, `DELETE /api/services/<id>`
  - **Expenses:** `GET /api/expenses`, `GET /api/expenses/<id>`, `POST /api/expenses`, `PUT/PATCH /api/expenses/<id>`, `DELETE /api/expenses/<id>`
  - **Payouts:** `GET /api/payouts`, `POST /api/payouts`, `DELETE /api/payouts/<id>`
- **Frontend Action Endpoint:** `POST /api` (routes `action` payloads from `public/data.js`)

---

## Environment Variables

All credentials and configuration values are read from environment variables (never hardcoded):

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Full PostgreSQL URI (supports `postgresql://`, `postgres://`, `postgresql+psycopg2://`) |
| `POSTGRES_HOST` | PostgreSQL hostname (used if `DATABASE_URL` is unset; `db` inside Docker Compose) |
| `POSTGRES_PORT` | PostgreSQL port (default `5432`) |
| `POSTGRES_USER` | PostgreSQL username |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `POSTGRES_DB` | PostgreSQL database name |
| `POSTGRES_SSLMODE` | Optional SSL mode (e.g., `require` for Azure Database for PostgreSQL) |
| `ADMIN_DEFAULT_PASSWORD` | Initial password for the seeded `admin` account |
| `MASTER_KEY` | Authorization key required for new shop registration & password resets |
| `APP_SECRET` | HMAC token signing secret (persisted in DB `app_meta` if omitted) |
| `PORT` | HTTP listening port (default `5000`) |

---

## GitHub (Public Repository)

Ensure `.env` is **not** tracked (`.gitignore` excludes it):

```bash
git init
git branch -M main
git add .
git status   # verify .env is NOT listed
git commit -m "Initial 3-tier Flask + PostgreSQL + Docker BarberApp"
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

---

## Render + GHCR CI/CD Deployment (Task 2 — Option 2)

1. **Managed PostgreSQL on Render:**
   - Create a PostgreSQL instance in Render.
   - Connect from VS Code using the **External Database URL** and run `schema.sql` to initialize the tables.
2. **Render Web Service:**
   - Create a Web Service (**Existing Image** `ghcr.io/<owner>/<repo>:latest` or Docker), set **Auto-Deploy** to **No**, and set Health Check Path to `/health`.
   - Configure Environment Variables on Render:
     - `DATABASE_URL` → Render **Internal Database URL**
     - `ADMIN_DEFAULT_PASSWORD`, `MASTER_KEY`, `APP_SECRET`
   - Copy the **Deploy Hook** URL from Render Web Service settings.
3. **GitHub Configuration & CI/CD:**
   - **Settings → Actions → General → Workflow permissions:** set to **Read and write permissions**.
   - **Settings → Secrets and variables → Actions:** add `RENDER_DEPLOY_HOOK_URL`.
   - Ensure the published GHCR package (`Packages → barberapp → Package settings`) is **Public** (or configure registry credentials on Render).
   - Pushing to `main` automatically runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), builds the `linux/amd64` Docker image, pushes to `ghcr.io`, and triggers the Render Deploy Hook.

---

## Azure Web App Deployment Checklist (Python 3.12)

1. In **Azure Portal → App Services → Create Web App**:
   - **Subscription:** Azure for Students
   - **Publish:** `Code` (or Docker Container via ACR)
   - **Runtime stack:** `Python 3.12`
   - **Operating System:** `Linux`
   - **Region:** Subscription-allowed region (e.g., `Sweden Central`, `Norway East`, `Italy North`, `Spain Central`, `UK South`)
   - **Pricing Plan:** `Free F1`
2. Provision **Azure Database for PostgreSQL (Flexible Server)** (or external managed PostgreSQL).
3. In **Web App → Settings → Environment variables**, set:
   - `DATABASE_URL` (with `?sslmode=require`)
   - `ADMIN_DEFAULT_PASSWORD`
   - `MASTER_KEY`
   - `APP_SECRET`
4. In **Web App → Configuration → Startup Command** (if using Code deployment):
   ```bash
   gunicorn --bind=0.0.0.0:8000 --workers=2 app:app
   ```
5. In **Web App → Monitoring → Health check**, set Path to `/health`.
