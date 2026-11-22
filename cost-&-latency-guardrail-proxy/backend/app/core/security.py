import hashlib
import hmac
import ipaddress
import os
import secrets
from urllib.parse import urlparse

_EPHEMERAL_SECRET = secrets.token_hex(32)


def get_session_secret() -> str:
    return os.getenv("SESSION_SECRET") or _EPHEMERAL_SECRET


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_password_scrypt(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=64)
    return f"{salt.hex()}:{derived.hex()}"


def verify_password_scrypt(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, original_hex = stored_hash.split(":", 1)
        salt = bytes.fromhex(salt_hex)
        original = bytes.fromhex(original_hex)
        derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=64)
        return hmac.compare_digest(derived, original)
    except Exception:
        return False


def constant_time_equals(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def is_safe_external_url(raw_url: str) -> bool:
    try:
        parsed = urlparse(raw_url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").lower()
        if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):
            return False
        try:
            ip = ipaddress.ip_address(host)
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                return False
        except ValueError:
            pass
        return True
    except Exception:
        return False
