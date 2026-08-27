"""명부 확인.

/api/run이 참여자 코드를 검사하지 않으면, URL을 아는 사람은 누구나 서버에서
Python을 실행할 수 있다. participant_id는 그냥 문자열이라 분당 제한도
아이디를 바꾸면 그대로 우회된다.

명부는 수업 중에 바뀌지 않으므로 캐시해 두고 주기적으로만 새로 읽는다.
"""

import os
import threading
import time

import httpx

REFRESH_SECONDS = 300

_lock = threading.Lock()
_codes: set[str] | None = None   # None = 아직 한 번도 못 읽음
_loaded_at = 0.0


def _fetch_codes() -> set[str] | None:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        return None
    try:
        response = httpx.get(
            f"{url}/rest/v1/participants?select=participant_code",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=10,
        )
        if response.status_code >= 400:
            return None
        return {row["participant_code"] for row in response.json()}
    except Exception:
        return None


def is_known(code: str) -> bool:
    """명부에 있는 코드인가.

    한 번도 명부를 못 읽었으면(로컬 개발 등) True를 돌려준다 — 설정이
    덜 된 환경에서 실습 자체가 막히면 안 된다. 한 번이라도 읽은 뒤에는
    캐시를 믿는다. Supabase가 잠깐 죽어도 수업은 굴러가야 한다.
    """
    global _codes, _loaded_at

    with _lock:
        stale = time.monotonic() - _loaded_at > REFRESH_SECONDS
        if _codes is None or stale:
            fresh = _fetch_codes()
            if fresh is not None:
                _codes = fresh
                _loaded_at = time.monotonic()
            elif _codes is None:
                return True   # 명부를 아예 못 읽는 환경

        return code.strip().upper() in _codes


def size() -> int:
    return len(_codes) if _codes else 0
