"""
Security helpers for BarberApp:
- Scrypt password hashing and constant-time verification
- HMAC-SHA256 signed bearer tokens
- Environment-based master key lookup
"""

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60  # 180 days


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(encoded: str) -> bytes:
    padding = "=" * (-len(encoded) % 4)
    return base64.urlsafe_b64decode(encoded + padding)


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    """Hash a password with scrypt and return (salt_hex, hash_hex)."""
    salt_hex = salt or os.urandom(16).hex()
    digest = hashlib.scrypt(
        str(password).encode("utf-8"),
        salt=salt_hex.encode("utf-8"),
        n=16384,
        r=8,
        p=1,
        dklen=32,
    )
    return salt_hex, digest.hex()


def verify_password(password: str, salt_hex: str, expected_hash_hex: str) -> bool:
    """Verify a candidate password against stored scrypt salt and hash."""
    if not salt_hex or not expected_hash_hex:
        return False
    _, candidate_hex = hash_password(password, salt_hex)
    return hmac.compare_digest(candidate_hex, expected_hash_hex)


def sign_token(payload: dict[str, Any], secret: str) -> str:
    """Create a signed bearer token carrying payload and expiration timestamp."""
    body_obj = {**payload, "exp": int(time.time()) + TOKEN_TTL_SECONDS}
    body_b64 = _b64url_encode(json.dumps(body_obj, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), body_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{body_b64}.{_b64url_encode(sig)}"


def verify_token(token: str, secret: str) -> dict[str, Any] | None:
    """Validate token signature and expiry; return decoded payload or None."""
    if not token or not secret or "." not in token:
        return None
    parts = token.split(".", 1)
    if len(parts) != 2:
        return None
    body_b64, sig_b64 = parts
    expected_sig = _b64url_encode(
        hmac.new(secret.encode("utf-8"), body_b64.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(sig_b64, expected_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(body_b64).decode("utf-8"))
    except (ValueError, TypeError):
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        return None
    return payload


def get_master_key() -> str:
    """Load the master authorization key strictly from environment variables."""
    return os.environ.get("MASTER_KEY", "").strip()
