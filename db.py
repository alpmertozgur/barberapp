"""
PostgreSQL connection and schema management for BarberApp.
All database credentials and hosts are loaded strictly from environment variables.
"""

from contextlib import contextmanager
import logging
import os
import threading
from urllib.parse import quote_plus

import psycopg2
from psycopg2.extras import RealDictCursor

from security import hash_password

logger = logging.getLogger(__name__)

_INIT_LOCK = threading.Lock()
_DB_INITIALIZED = False
_ADVISORY_LOCK_ID = 84729104

SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        shop_id TEXT UNIQUE NOT NULL,
        shop_name TEXT NOT NULL DEFAULT '',
        username TEXT UNIQUE NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS barbers (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES admins(shop_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        username TEXT UNIQUE NOT NULL,
        avatar TEXT NOT NULL DEFAULT '💈',
        commission_rate NUMERIC(5, 2) NOT NULL DEFAULT 50.00,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        barber_id TEXT NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
        amount NUMERIC(12, 2) NOT NULL,
        tip NUMERIC(12, 2) NOT NULL DEFAULT 0,
        commission_rate NUMERIC(5, 2) NOT NULL DEFAULT 50.00,
        payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card')),
        barber_share NUMERIC(12, 2) NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES admins(shop_id) ON DELETE CASCADE,
        category TEXT NOT NULL DEFAULT 'other'
            CHECK (category IN ('rent', 'supplies', 'bills', 'maintenance', 'food', 'other')),
        amount NUMERIC(12, 2) NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card')),
        description TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT 'admin',
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS payouts (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL REFERENCES admins(shop_id) ON DELETE CASCADE,
        barber_id TEXT NOT NULL,
        amount NUMERIC(12, 2) NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card')),
        note TEXT NOT NULL DEFAULT '',
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_barbers_shop_id ON barbers(shop_id);",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_username_lower ON admins(LOWER(username));",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_barbers_username_lower ON barbers(LOWER(username));",
    "CREATE INDEX IF NOT EXISTS idx_services_barber_ts ON services(barber_id, timestamp DESC);",
    "CREATE INDEX IF NOT EXISTS idx_expenses_shop_ts ON expenses(shop_id, timestamp DESC);",
    "CREATE INDEX IF NOT EXISTS idx_payouts_shop_ts ON payouts(shop_id, timestamp DESC);",
)


def _normalize_dsn(raw_url: str) -> str:
    url = raw_url.strip()
    if url.startswith("postgresql+psycopg2://"):
        return "postgresql://" + url[len("postgresql+psycopg2://") :]
    if url.startswith("postgres://"):
        return "postgresql://" + url[len("postgres://") :]
    return url


def get_database_dsn() -> str:
    """Build PostgreSQL DSN strictly from environment variables."""
    raw_url = os.environ.get("DATABASE_URL", "").strip()
    if raw_url:
        return _normalize_dsn(raw_url)

    host = os.environ.get("POSTGRES_HOST", "").strip()
    port = os.environ.get("POSTGRES_PORT", "5432").strip() or "5432"
    user = os.environ.get("POSTGRES_USER", "").strip()
    password = os.environ.get("POSTGRES_PASSWORD", "").strip()
    dbname = os.environ.get("POSTGRES_DB", "").strip()
    sslmode = os.environ.get("POSTGRES_SSLMODE", "").strip()

    missing = [
        name
        for name, val in (
            ("POSTGRES_HOST", host),
            ("POSTGRES_USER", user),
            ("POSTGRES_PASSWORD", password),
            ("POSTGRES_DB", dbname),
        )
        if not val
    ]
    if missing:
        raise RuntimeError(
            "Database configuration missing. Set DATABASE_URL or "
            + ", ".join(missing)
            + " environment variables."
        )

    dsn = f"postgresql://{quote_plus(user)}:{quote_plus(password)}@{host}:{port}/{quote_plus(dbname)}"
    if sslmode:
        dsn += f"?sslmode={quote_plus(sslmode)}"
    return dsn


@contextmanager
def get_cursor(commit: bool = False):
    """Yield a RealDictCursor over a PostgreSQL connection with safe cleanup."""
    conn = psycopg2.connect(get_database_dsn(), connect_timeout=5)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            yield cur
        if commit:
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create relational tables, indexes, signing secret, and default admin if configured."""
    global _DB_INITIALIZED
    with get_cursor(commit=True) as cur:
        cur.execute("SELECT pg_advisory_lock(%s);", (_ADVISORY_LOCK_ID,))
        try:
            for statement in SCHEMA_STATEMENTS:
                cur.execute(statement)

            cur.execute(
                """
                INSERT INTO app_meta (key, value)
                VALUES ('app_secret', %s)
                ON CONFLICT (key) DO NOTHING;
                """,
                (os.urandom(32).hex(),),
            )

            default_admin_pw = os.environ.get("ADMIN_DEFAULT_PASSWORD", "").strip()
            if default_admin_pw:
                salt, pw_hash = hash_password(default_admin_pw)
                cur.execute(
                    """
                    INSERT INTO admins (id, shop_id, shop_name, username, password_salt, password_hash)
                    VALUES ('admin', 'default', '', 'admin', %s, %s)
                    ON CONFLICT (id) DO NOTHING;
                    """,
                    (salt, pw_hash),
                )
            else:
                logger.warning("ADMIN_DEFAULT_PASSWORD is not set; default admin seed skipped.")
        finally:
            cur.execute("SELECT pg_advisory_unlock(%s);", (_ADVISORY_LOCK_ID,))
    _DB_INITIALIZED = True


def ensure_db_initialized() -> None:
    """Thread-safe lazy initialization for Gunicorn workers or delayed DB startup."""
    global _DB_INITIALIZED
    if _DB_INITIALIZED:
        return
    with _INIT_LOCK:
        if not _DB_INITIALIZED:
            init_db()


def check_db() -> tuple[bool, str | None]:
    """Verify PostgreSQL connectivity for the /health endpoint."""
    try:
        with get_cursor(commit=False) as cur:
            cur.execute("SELECT 1;")
            cur.fetchone()
        return True, None
    except Exception as exc:
        logger.warning("Database health check failed: %s", type(exc).__name__)
        return False, "disconnected"


def get_signing_secret() -> str:
    """Return APP_SECRET from env var or the persisted database secret."""
    env_secret = os.environ.get("APP_SECRET", "").strip()
    if env_secret:
        return env_secret
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        cur.execute("SELECT value FROM app_meta WHERE key = 'app_secret';")
        row = cur.fetchone()
    if row and row["value"]:
        return row["value"]
    raise RuntimeError("Signing secret unavailable.")
