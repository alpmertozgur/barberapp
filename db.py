"""
PostgreSQL connection and schema management for BarberApp.
All database credentials and hosts are loaded strictly from environment variables.
"""

from contextlib import contextmanager
import logging
import os
from pathlib import Path
import threading
from urllib.parse import quote_plus

import psycopg2
from psycopg2.extras import RealDictCursor

from security import hash_password

logger = logging.getLogger(__name__)

_INIT_LOCK = threading.Lock()
_DB_INITIALIZED = False
_ADVISORY_LOCK_ID = 84729104
SCHEMA_PATH = Path(__file__).with_name("schema.sql")


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
            cur.execute(SCHEMA_PATH.read_text(encoding="utf-8"))

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
