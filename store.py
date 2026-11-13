"""
Domain logic and PostgreSQL CRUD operations for BarberApp.
Used by both action-based POST /api and RESTful /api/<resource> endpoints.
"""

from datetime import datetime, timezone
import math
from typing import Any
import uuid

import psycopg2

from db import ensure_db_initialized, get_cursor, get_signing_secret
from security import get_master_key, hash_password, sign_token, verify_password, verify_token

ADMIN_USERNAME = "admin"
DEFAULT_SHOP_ID = "default"
EXPENSE_CATEGORIES = ("rent", "supplies", "bills", "maintenance", "food", "other")


class ApiError(Exception):
    """HTTP error carrying status code and i18n error key."""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def _clean_text(value: Any, max_len: int = 200) -> str:
    return str(value if value is not None else "").strip()[:max_len]


def _parse_rate(rate: Any) -> float:
    try:
        num = float(rate)
    except (TypeError, ValueError):
        return 50.0
    if not math.isfinite(num) or num < 0 or num > 100:
        return 50.0
    return round(num, 2)


def _parse_amount(value: Any, allow_zero: bool = False) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError) as exc:
        raise ApiError(400, "invalid_amount") from exc
    invalid = (not math.isfinite(num)) or (num < 0 if allow_zero else num <= 0) or num > 1_000_000
    if invalid:
        raise ApiError(400, "invalid_amount")
    return round(num, 2)


def _parse_payment_method(value: Any) -> str:
    return "card" if value == "card" else "cash"


def _parse_expense_category(value: Any) -> str:
    return value if value in EXPENSE_CATEGORIES else "other"


def _iso_str(dt: Any) -> str:
    if isinstance(dt, datetime):
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(dt or "")


def _public_admin(row: dict[str, Any]) -> dict[str, Any]:
    is_default = row["id"] == ADMIN_USERNAME
    shop_name = row.get("shop_name") or ""
    return {
        "id": row["id"],
        "name": "Admin" if is_default else (shop_name or row["username"]),
        "username": row["username"],
        "shopName": shop_name,
    }


def _public_barber(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "username": row["username"],
        "avatar": row.get("avatar") or "💈",
        "commissionRate": float(row["commission_rate"]) if row.get("commission_rate") is not None else 50.0,
        "shopId": row.get("shop_id") or DEFAULT_SHOP_ID,
        "createdAt": _iso_str(row.get("created_at")),
    }


def _serialize_service(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "barberId": row["barber_id"],
        "amount": float(row["amount"]),
        "tip": float(row["tip"]),
        "commissionRate": float(row["commission_rate"]),
        "paymentMethod": row["payment_method"],
        "barberShare": float(row["barber_share"]),
        "timestamp": _iso_str(row["timestamp"]),
        "note": row.get("note") or "",
    }


def _serialize_expense(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "shopId": row["shop_id"],
        "category": row["category"],
        "amount": float(row["amount"]),
        "paymentMethod": row["payment_method"],
        "description": row.get("description") or "",
        "createdBy": row["created_by"],
        "timestamp": _iso_str(row["timestamp"]),
    }


def _serialize_payout(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "shopId": row["shop_id"],
        "barberId": row["barber_id"],
        "amount": float(row["amount"]),
        "paymentMethod": row["payment_method"],
        "note": row.get("note") or "",
        "timestamp": _iso_str(row["timestamp"]),
    }


def _username_taken(cur, username: str, exclude_barber_id: str | None = None) -> bool:
    cur.execute("SELECT 1 FROM admins WHERE LOWER(username) = LOWER(%s) LIMIT 1;", (username,))
    if cur.fetchone():
        return True
    if exclude_barber_id:
        cur.execute(
            "SELECT 1 FROM barbers WHERE LOWER(username) = LOWER(%s) AND id <> %s LIMIT 1;",
            (username, exclude_barber_id),
        )
    else:
        cur.execute("SELECT 1 FROM barbers WHERE LOWER(username) = LOWER(%s) LIMIT 1;", (username,))
    return bool(cur.fetchone())


def _require_master_key(candidate: Any) -> None:
    expected = get_master_key()
    provided = str(candidate or "").strip()
    if not expected or provided != expected:
        raise ApiError(403, "invalid_master_key")


def _require_admin_info(cur, session: dict[str, Any]) -> dict[str, Any]:
    if session.get("role") != "admin":
        raise ApiError(403, "forbidden")
    cur.execute("SELECT * FROM admins WHERE id = %s LIMIT 1;", (session.get("id"),))
    row = cur.fetchone()
    if not row:
        raise ApiError(401, "unauthorized")
    return {**_public_admin(row), "shopId": row["shop_id"]}


def _require_barber_row(cur, barber_id: str) -> dict[str, Any]:
    cur.execute("SELECT * FROM barbers WHERE id = %s LIMIT 1;", (barber_id,))
    row = cur.fetchone()
    if not row:
        raise ApiError(401, "unauthorized")
    return row


def _resolve_actor_scope(cur, session: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
    """Return (is_admin, shop_id, actor_user_dict) for the authenticated session."""
    if session.get("role") == "admin":
        admin_info = _require_admin_info(cur, session)
        return True, admin_info["shopId"], admin_info
    barber_row = _require_barber_row(cur, str(session.get("id") or ""))
    return False, barber_row["shop_id"], _public_barber(barber_row)


def authenticate_bearer_header(auth_header: str) -> dict[str, Any]:
    """Validate Authorization: Bearer <token> header and return session payload."""
    ensure_db_initialized()
    token = (auth_header or "").strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    session = verify_token(token, get_signing_secret())
    if not session:
        raise ApiError(401, "unauthorized")
    return session


# === AUTHENTICATION & ACCOUNT ACTIONS ===


def login(params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    username = _clean_text(params.get("username"), 50).lower()
    password = str(params.get("password") or "")
    if not username or not password:
        raise ApiError(400, "missing_fields")

    with get_cursor(commit=False) as cur:
        cur.execute("SELECT * FROM admins WHERE LOWER(username) = LOWER(%s) LIMIT 1;", (username,))
        admin_row = cur.fetchone()
        if admin_row:
            if not verify_password(password, admin_row["password_salt"], admin_row["password_hash"]):
                raise ApiError(401, "invalid_credentials")
            token = sign_token(
                {"role": "admin", "id": admin_row["id"], "shopId": admin_row["shop_id"]},
                get_signing_secret(),
            )
            return {"token": token, "role": "admin", "user": _public_admin(admin_row)}

        cur.execute("SELECT * FROM barbers WHERE LOWER(username) = LOWER(%s) LIMIT 1;", (username,))
        barber_row = cur.fetchone()
        if not barber_row or not verify_password(password, barber_row["password_salt"], barber_row["password_hash"]):
            raise ApiError(401, "invalid_credentials")
        token = sign_token(
            {"role": "barber", "id": barber_row["id"], "shopId": barber_row["shop_id"]},
            get_signing_secret(),
        )
        return {"token": token, "role": "barber", "user": _public_barber(barber_row)}


def register_admin(params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    shop_name = _clean_text(params.get("shopName"), 60)
    username = _clean_text(params.get("username"), 30)
    password = str(params.get("password") or "")
    master_key = params.get("masterKey")

    if not shop_name or not username or not password or not str(master_key or "").strip():
        raise ApiError(400, "missing_fields")
    _require_master_key(master_key)
    if len(password) < 4:
        raise ApiError(400, "password_too_short")
    if username.lower() == ADMIN_USERNAME:
        raise ApiError(400, "username_reserved")

    admin_id = str(uuid.uuid4())
    shop_id = str(uuid.uuid4())
    salt, pw_hash = hash_password(password)

    try:
        with get_cursor(commit=True) as cur:
            if _username_taken(cur, username):
                raise ApiError(409, "username_taken")
            cur.execute(
                """
                INSERT INTO admins (id, shop_id, shop_name, username, password_salt, password_hash)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING *;
                """,
                (admin_id, shop_id, shop_name, username, salt, pw_hash),
            )
            created = cur.fetchone()
    except psycopg2.errors.UniqueViolation as exc:
        raise ApiError(409, "username_taken") from exc

    token = sign_token(
        {"role": "admin", "id": created["id"], "shopId": created["shop_id"]},
        get_signing_secret(),
    )
    return {"token": token, "role": "admin", "user": _public_admin(created)}


def reset_password(params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    username = _clean_text(params.get("username"), 50).lower()
    master_key = params.get("masterKey")
    new_password = str(params.get("newPassword") or "")

    if not username or not str(master_key or "").strip() or not new_password:
        raise ApiError(400, "missing_fields")
    _require_master_key(master_key)
    if len(new_password) < 4:
        raise ApiError(400, "password_too_short")

    salt, pw_hash = hash_password(new_password)
    with get_cursor(commit=True) as cur:
        if username == ADMIN_USERNAME:
            cur.execute(
                """
                INSERT INTO admins (id, shop_id, shop_name, username, password_salt, password_hash)
                VALUES ('admin', 'default', '', 'admin', %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET password_salt = EXCLUDED.password_salt,
                    password_hash = EXCLUDED.password_hash;
                """,
                (salt, pw_hash),
            )
            return {"ok": True}

        cur.execute(
            """
            UPDATE admins
            SET password_salt = %s, password_hash = %s
            WHERE LOWER(username) = LOWER(%s)
            RETURNING id;
            """,
            (salt, pw_hash, username),
        )
        if cur.fetchone():
            return {"ok": True}

        cur.execute(
            """
            UPDATE barbers
            SET password_salt = %s, password_hash = %s
            WHERE LOWER(username) = LOWER(%s)
            RETURNING id;
            """,
            (salt, pw_hash, username),
        )
        if cur.fetchone():
            return {"ok": True}

    raise ApiError(404, "user_not_found")


def change_admin_password(session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    password = str(params.get("password") or "")
    if len(password) < 4:
        raise ApiError(400, "password_too_short")

    salt, pw_hash = hash_password(password)
    with get_cursor(commit=True) as cur:
        admin_info = _require_admin_info(cur, session)
        cur.execute(
            "UPDATE admins SET password_salt = %s, password_hash = %s WHERE id = %s;",
            (salt, pw_hash, admin_info["id"]),
        )
    return {"ok": True}


# === DASHBOARD READ ===


def get_data(session: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        is_admin, shop_id, actor_user = _resolve_actor_scope(cur, session)
        if is_admin:
            cur.execute("SELECT * FROM barbers WHERE shop_id = %s ORDER BY created_at ASC;", (shop_id,))
            barbers = [_public_barber(r) for r in cur.fetchall()]

            cur.execute(
                """
                SELECT s.* FROM services s
                JOIN barbers b ON b.id = s.barber_id
                WHERE b.shop_id = %s
                ORDER BY s.timestamp DESC;
                """,
                (shop_id,),
            )
            services = [_serialize_service(r) for r in cur.fetchall()]

            cur.execute("SELECT * FROM expenses WHERE shop_id = %s ORDER BY timestamp DESC;", (shop_id,))
            expenses = [_serialize_expense(r) for r in cur.fetchall()]

            cur.execute("SELECT * FROM payouts WHERE shop_id = %s ORDER BY timestamp DESC;", (shop_id,))
            payouts = [_serialize_payout(r) for r in cur.fetchall()]

            return {
                "user": {k: v for k, v in actor_user.items() if k != "shopId"},
                "barbers": barbers,
                "services": services,
                "expenses": expenses,
                "payouts": payouts,
            }

        barber_id = actor_user["id"]
        cur.execute("SELECT * FROM services WHERE barber_id = %s ORDER BY timestamp DESC;", (barber_id,))
        services = [_serialize_service(r) for r in cur.fetchall()]

        cur.execute(
            "SELECT * FROM expenses WHERE shop_id = %s AND created_by = %s ORDER BY timestamp DESC;",
            (shop_id, barber_id),
        )
        expenses = [_serialize_expense(r) for r in cur.fetchall()]

        cur.execute(
            "SELECT * FROM payouts WHERE shop_id = %s AND barber_id = %s ORDER BY timestamp DESC;",
            (shop_id, barber_id),
        )
        payouts = [_serialize_payout(r) for r in cur.fetchall()]

        return {
            "user": actor_user,
            "barbers": [actor_user],
            "services": services,
            "expenses": expenses,
            "payouts": payouts,
        }


# === BARBERS CRUD ===


def list_barbers(session: dict[str, Any]) -> list[dict[str, Any]]:
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        if not is_admin:
            return [actor]
        cur.execute("SELECT * FROM barbers WHERE shop_id = %s ORDER BY created_at ASC;", (shop_id,))
        return [_public_barber(r) for r in cur.fetchall()]


def get_barber_item(session: dict[str, Any], barber_id: str) -> dict[str, Any]:
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        if not is_admin and actor["id"] != barber_id:
            raise ApiError(403, "forbidden")
        cur.execute("SELECT * FROM barbers WHERE id = %s AND shop_id = %s LIMIT 1;", (barber_id, shop_id))
        row = cur.fetchone()
        if not row:
            raise ApiError(404, "not_found")
        return _public_barber(row)


def add_barber(session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    name = _clean_text(params.get("name"), 40)
    username = _clean_text(params.get("username"), 30)
    password = str(params.get("password") or "")
    avatar = _clean_text(params.get("avatar"), 16) or "💈"
    rate = _parse_rate(params.get("commissionRate"))

    if not name or not username or not password:
        raise ApiError(400, "missing_fields")
    if len(password) < 4:
        raise ApiError(400, "password_too_short")
    if username.lower() == ADMIN_USERNAME:
        raise ApiError(400, "username_reserved")

    barber_id = str(uuid.uuid4())
    salt, pw_hash = hash_password(password)

    try:
        with get_cursor(commit=True) as cur:
            admin_info = _require_admin_info(cur, session)
            if _username_taken(cur, username):
                raise ApiError(409, "username_taken")
            cur.execute(
                """
                INSERT INTO barbers (id, shop_id, name, username, avatar, commission_rate, password_salt, password_hash)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *;
                """,
                (barber_id, admin_info["shopId"], name, username, avatar, rate, salt, pw_hash),
            )
            created = cur.fetchone()
    except psycopg2.errors.UniqueViolation as exc:
        raise ApiError(409, "username_taken") from exc

    return {"barber": _public_barber(created)}


def update_barber(session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    barber_id = _clean_text(params.get("id"), 64)
    name = _clean_text(params.get("name"), 40)
    username = _clean_text(params.get("username"), 30)
    password = str(params.get("password") or "")
    avatar = _clean_text(params.get("avatar"), 16)
    rate = _parse_rate(params.get("commissionRate"))

    if not barber_id or not name or not username:
        raise ApiError(400, "missing_fields")
    if password and len(password) < 4:
        raise ApiError(400, "password_too_short")
    if username.lower() == ADMIN_USERNAME:
        raise ApiError(400, "username_reserved")

    try:
        with get_cursor(commit=True) as cur:
            admin_info = _require_admin_info(cur, session)
            cur.execute("SELECT * FROM barbers WHERE id = %s LIMIT 1;", (barber_id,))
            current = cur.fetchone()
            if not current:
                raise ApiError(404, "user_not_found")
            if current["shop_id"] != admin_info["shopId"]:
                raise ApiError(403, "forbidden")
            if _username_taken(cur, username, exclude_barber_id=barber_id):
                raise ApiError(409, "username_taken")

            next_avatar = avatar or current["avatar"] or "💈"
            if password:
                salt, pw_hash = hash_password(password)
                cur.execute(
                    """
                    UPDATE barbers
                    SET name = %s, username = %s, avatar = %s, commission_rate = %s,
                        password_salt = %s, password_hash = %s
                    WHERE id = %s
                    RETURNING *;
                    """,
                    (name, username, next_avatar, rate, salt, pw_hash, barber_id),
                )
            else:
                cur.execute(
                    """
                    UPDATE barbers
                    SET name = %s, username = %s, avatar = %s, commission_rate = %s
                    WHERE id = %s
                    RETURNING *;
                    """,
                    (name, username, next_avatar, rate, barber_id),
                )
            updated = cur.fetchone()
    except psycopg2.errors.UniqueViolation as exc:
        raise ApiError(409, "username_taken") from exc

    return {"barber": _public_barber(updated)}


def delete_barber(session: dict[str, Any], barber_id: str) -> dict[str, Any]:
    ensure_db_initialized()
    clean_id = _clean_text(barber_id, 64)
    if not clean_id:
        raise ApiError(400, "missing_fields")

    with get_cursor(commit=True) as cur:
        admin_info = _require_admin_info(cur, session)
        cur.execute("SELECT shop_id FROM barbers WHERE id = %s LIMIT 1;", (clean_id,))
        target = cur.fetchone()
        if not target:
            raise ApiError(404, "not_found")
        if target["shop_id"] != admin_info["shopId"]:
            raise ApiError(403, "forbidden")
        cur.execute("DELETE FROM barbers WHERE id = %s;", (clean_id,))
    return {"ok": True}


# === SERVICES CRUD ===


def list_services(session: dict[str, Any], barber_id_filter: str | None = None) -> list[dict[str, Any]]:
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        if not is_admin:
            cur.execute("SELECT * FROM services WHERE barber_id = %s ORDER BY timestamp DESC;", (actor["id"],))
            return [_serialize_service(r) for r in cur.fetchall()]

        if barber_id_filter:
            cur.execute(
                """
                SELECT s.* FROM services s
                JOIN barbers b ON b.id = s.barber_id
                WHERE b.shop_id = %s AND s.barber_id = %s
                ORDER BY s.timestamp DESC;
                """,
                (shop_id, barber_id_filter),
            )
        else:
            cur.execute(
                """
                SELECT s.* FROM services s
                JOIN barbers b ON b.id = s.barber_id
                WHERE b.shop_id = %s
                ORDER BY s.timestamp DESC;
                """,
                (shop_id,),
            )
        return [_serialize_service(r) for r in cur.fetchall()]


def get_service_item(session: dict[str, Any], service_id: str) -> dict[str, Any]:
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        cur.execute(
            """
            SELECT s.*, b.shop_id FROM services s
            JOIN barbers b ON b.id = s.barber_id
            WHERE s.id = %s LIMIT 1;
            """,
            (service_id,),
        )
        row = cur.fetchone()
        if not row:
            raise ApiError(404, "not_found")
        if is_admin and row["shop_id"] != shop_id:
            raise ApiError(403, "forbidden")
        if not is_admin and row["barber_id"] != actor["id"]:
            raise ApiError(403, "forbidden")
        return _serialize_service(row)


def add_service(session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    amount = _parse_amount(params.get("amount") or 0, allow_zero=True)
    tip = _parse_amount(params.get("tip") or 0, allow_zero=True)
    if amount <= 0 and tip <= 0:
        raise ApiError(400, "invalid_amount")

    payment_method = _parse_payment_method(params.get("paymentMethod"))
    note = _clean_text(params.get("note"), 120)

    with get_cursor(commit=True) as cur:
        if session.get("role") == "admin":
            admin_info = _require_admin_info(cur, session)
            target_barber_id = _clean_text(params.get("barberId"), 64)
            if not target_barber_id:
                raise ApiError(400, "missing_fields")
            barber = _require_barber_row(cur, target_barber_id)
            if barber["shop_id"] != admin_info["shopId"]:
                raise ApiError(403, "forbidden")
        elif session.get("role") == "barber":
            barber = _require_barber_row(cur, str(session.get("id") or ""))
        else:
            raise ApiError(403, "forbidden")

        rate = float(barber["commission_rate"]) if barber.get("commission_rate") is not None else 50.0
        barber_share = round(amount * rate) / 100.0
        service_id = str(uuid.uuid4())

        cur.execute(
            """
            INSERT INTO services (id, barber_id, amount, tip, commission_rate, payment_method, barber_share, note)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *;
            """,
            (service_id, barber["id"], amount, tip, rate, payment_method, barber_share, note),
        )
        created = cur.fetchone()
    return {"service": _serialize_service(created)}


def update_service(session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    service_id = _clean_text(params.get("id"), 64)
    if not service_id:
        raise ApiError(400, "missing_fields")

    amount = _parse_amount(params.get("amount") or 0, allow_zero=True)
    tip = _parse_amount(params.get("tip") or 0, allow_zero=True)
    if amount <= 0 and tip <= 0:
        raise ApiError(400, "invalid_amount")

    payment_method = _parse_payment_method(params.get("paymentMethod"))
    note = _clean_text(params.get("note"), 120)

    with get_cursor(commit=True) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        cur.execute(
            """
            SELECT s.*, b.shop_id FROM services s
            JOIN barbers b ON b.id = s.barber_id
            WHERE s.id = %s LIMIT 1;
            """,
            (service_id,),
        )
        current = cur.fetchone()
        if not current:
            raise ApiError(404, "not_found")
        if is_admin and current["shop_id"] != shop_id:
            raise ApiError(403, "forbidden")
        if not is_admin and current["barber_id"] != actor["id"]:
            raise ApiError(403, "forbidden")

        rate = float(current["commission_rate"])
        barber_share = round(amount * rate) / 100.0

        cur.execute(
            """
            UPDATE services
            SET amount = %s, tip = %s, payment_method = %s, barber_share = %s, note = %s
            WHERE id = %s
            RETURNING *;
            """,
            (amount, tip, payment_method, barber_share, note, service_id),
        )
        updated = cur.fetchone()
    return {"ok": True, "service": _serialize_service(updated)}


def delete_service(session: dict[str, Any], service_id: str) -> dict[str, Any]:
    ensure_db_initialized()
    clean_id = _clean_text(service_id, 64)
    if not clean_id:
        raise ApiError(400, "missing_fields")

    with get_cursor(commit=True) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        cur.execute(
            """
            SELECT s.barber_id, b.shop_id FROM services s
            JOIN barbers b ON b.id = s.barber_id
            WHERE s.id = %s LIMIT 1;
            """,
            (clean_id,),
        )
        current = cur.fetchone()
        if not current:
            raise ApiError(404, "not_found")
        if is_admin and current["shop_id"] != shop_id:
            raise ApiError(403, "forbidden")
        if not is_admin and current["barber_id"] != actor["id"]:
            raise ApiError(403, "forbidden")
        cur.execute("DELETE FROM services WHERE id = %s;", (clean_id,))
    return {"ok": True}


# === EXPENSES CRUD ===


def list_expenses(session: dict[str, Any]) -> list[dict[str, Any]]:
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        if is_admin:
            cur.execute("SELECT * FROM expenses WHERE shop_id = %s ORDER BY timestamp DESC;", (shop_id,))
        else:
            cur.execute(
                "SELECT * FROM expenses WHERE shop_id = %s AND created_by = %s ORDER BY timestamp DESC;",
                (shop_id, actor["id"]),
            )
        return [_serialize_expense(r) for r in cur.fetchall()]


def get_expense_item(session: dict[str, Any], expense_id: str) -> dict[str, Any]:
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        cur.execute("SELECT * FROM expenses WHERE id = %s LIMIT 1;", (expense_id,))
        row = cur.fetchone()
        if not row:
            raise ApiError(404, "not_found")
        if row["shop_id"] != shop_id or (not is_admin and row["created_by"] != actor["id"]):
            raise ApiError(403, "forbidden")
        return _serialize_expense(row)


def add_expense(session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    category = _parse_expense_category(params.get("category"))
    amount = _parse_amount(params.get("amount"))
    payment_method = _parse_payment_method(params.get("paymentMethod"))
    description = _clean_text(params.get("description"), 160)

    with get_cursor(commit=True) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        if not is_admin and category != "supplies":
            raise ApiError(403, "only_supplies")

        created_by = ADMIN_USERNAME if is_admin else actor["id"]
        expense_id = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO expenses (id, shop_id, category, amount, payment_method, description, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING *;
            """,
            (expense_id, shop_id, category, amount, payment_method, description, created_by),
        )
        created = cur.fetchone()
    return {"expense": _serialize_expense(created)}


def update_expense(session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    expense_id = _clean_text(params.get("id"), 64)
    if not expense_id:
        raise ApiError(400, "missing_fields")

    category = _parse_expense_category(params.get("category"))
    amount = _parse_amount(params.get("amount"))
    payment_method = _parse_payment_method(params.get("paymentMethod"))
    description = _clean_text(params.get("description"), 160)

    with get_cursor(commit=True) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        if not is_admin and category != "supplies":
            raise ApiError(403, "only_supplies")

        cur.execute("SELECT * FROM expenses WHERE id = %s LIMIT 1;", (expense_id,))
        current = cur.fetchone()
        if not current:
            raise ApiError(404, "not_found")
        if current["shop_id"] != shop_id or (not is_admin and current["created_by"] != actor["id"]):
            raise ApiError(403, "forbidden")

        next_cat = category if is_admin else "supplies"
        cur.execute(
            """
            UPDATE expenses
            SET category = %s, amount = %s, payment_method = %s, description = %s
            WHERE id = %s
            RETURNING *;
            """,
            (next_cat, amount, payment_method, description, expense_id),
        )
        updated = cur.fetchone()
    return {"ok": True, "expense": _serialize_expense(updated)}


def delete_expense(session: dict[str, Any], expense_id: str) -> dict[str, Any]:
    ensure_db_initialized()
    clean_id = _clean_text(expense_id, 64)
    if not clean_id:
        raise ApiError(400, "missing_fields")

    with get_cursor(commit=True) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        cur.execute("SELECT shop_id, created_by FROM expenses WHERE id = %s LIMIT 1;", (clean_id,))
        current = cur.fetchone()
        if not current:
            raise ApiError(404, "not_found")
        if current["shop_id"] != shop_id or (not is_admin and current["created_by"] != actor["id"]):
            raise ApiError(403, "forbidden")
        cur.execute("DELETE FROM expenses WHERE id = %s;", (clean_id,))
    return {"ok": True}


# === PAYOUTS CRUD ===


def list_payouts(session: dict[str, Any], barber_id_filter: str | None = None) -> list[dict[str, Any]]:
    ensure_db_initialized()
    with get_cursor(commit=False) as cur:
        is_admin, shop_id, actor = _resolve_actor_scope(cur, session)
        if not is_admin:
            cur.execute(
                "SELECT * FROM payouts WHERE shop_id = %s AND barber_id = %s ORDER BY timestamp DESC;",
                (shop_id, actor["id"]),
            )
        elif barber_id_filter:
            cur.execute(
                "SELECT * FROM payouts WHERE shop_id = %s AND barber_id = %s ORDER BY timestamp DESC;",
                (shop_id, barber_id_filter),
            )
        else:
            cur.execute("SELECT * FROM payouts WHERE shop_id = %s ORDER BY timestamp DESC;", (shop_id,))
        return [_serialize_payout(r) for r in cur.fetchall()]


def add_payout(session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    ensure_db_initialized()
    barber_id = _clean_text(params.get("barberId"), 64)
    if not barber_id:
        raise ApiError(400, "missing_fields")

    amount = _parse_amount(params.get("amount"))
    payment_method = _parse_payment_method(params.get("paymentMethod"))
    note = _clean_text(params.get("note"), 160)

    with get_cursor(commit=True) as cur:
        admin_info = _require_admin_info(cur, session)
        barber = _require_barber_row(cur, barber_id)
        if barber["shop_id"] != admin_info["shopId"]:
            raise ApiError(403, "forbidden")

        payout_id = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO payouts (id, shop_id, barber_id, amount, payment_method, note)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING *;
            """,
            (payout_id, admin_info["shopId"], barber_id, amount, payment_method, note),
        )
        created = cur.fetchone()
    return {"payout": _serialize_payout(created)}


def delete_payout(session: dict[str, Any], payout_id: str) -> dict[str, Any]:
    ensure_db_initialized()
    clean_id = _clean_text(payout_id, 64)
    if not clean_id:
        raise ApiError(400, "missing_fields")

    with get_cursor(commit=True) as cur:
        admin_info = _require_admin_info(cur, session)
        cur.execute("SELECT shop_id FROM payouts WHERE id = %s LIMIT 1;", (clean_id,))
        current = cur.fetchone()
        if not current:
            raise ApiError(404, "not_found")
        if current["shop_id"] != admin_info["shopId"]:
            raise ApiError(403, "forbidden")
        cur.execute("DELETE FROM payouts WHERE id = %s;", (clean_id,))
    return {"ok": True}
