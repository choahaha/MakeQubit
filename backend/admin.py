"""연구자용 조회 API.

학생 데이터는 RLS로 브라우저에서 읽을 수 없다. 읽으려면 service_role 키가
필요한데, 그 키는 RLS를 통째로 우회하므로 절대 프론트엔드로 나가면 안 된다.
그래서 조회는 전부 여기를 거친다 — 키는 서버에만 있고, 브라우저는
ADMIN_TOKEN으로 인증한다.
"""

import os
from collections import Counter, defaultdict
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Header, HTTPException

router = APIRouter(prefix="/api/admin")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")

PAGE = 1000  # PostgREST 기본 상한


def _require_auth(token: str | None):
    if not ADMIN_TOKEN:
        raise HTTPException(503, "ADMIN_TOKEN이 설정되지 않았어요. 서버 환경변수를 확인하세요.")
    if token != ADMIN_TOKEN:
        raise HTTPException(401, "관리자 토큰이 맞지 않아요.")
    if not SUPABASE_URL or not SERVICE_KEY:
        raise HTTPException(503, "SUPABASE_URL 또는 SUPABASE_SERVICE_KEY가 없어요.")


def _fetch(path: str, params: str = "") -> list:
    """service_role로 조회. 1000행 상한을 넘으면 이어서 가져온다."""
    rows, offset = [], 0
    with httpx.Client(timeout=30) as client:
        while True:
            url = f"{SUPABASE_URL}/rest/v1/{path}?{params}"
            response = client.get(
                url,
                headers={
                    "apikey": SERVICE_KEY,
                    "Authorization": f"Bearer {SERVICE_KEY}",
                    "Range": f"{offset}-{offset + PAGE - 1}",
                },
            )
            if response.status_code >= 400:
                raise HTTPException(502, f"Supabase 조회 실패: {response.text[:200]}")
            batch = response.json()
            rows.extend(batch)
            if len(batch) < PAGE:
                return rows
            offset += PAGE


@router.get("/overview")
def overview(
    include_test: bool = False,
    x_admin_token: str | None = Header(None),
):
    """반 전체 현황 — 참여자 × 레슨 진행 격자와 레슨별 요약.

    기본적으로 테스트 참여자(Q00, T00)는 뺀다. 점검용 실행이 반 통계에
    섞이면 연구 데이터를 잘못 읽게 된다. 점검 자체를 확인할 때만
    include_test=true를 쓴다.
    """
    _require_auth(x_admin_token)

    filter_clause = "" if include_test else "&is_test=eq.false"
    participants = _fetch(
        "participants",
        f"select=id,participant_code,group_label,is_test{filter_clause}"
        "&order=participant_code",
    )
    by_id = {p["id"]: p["participant_code"] for p in participants}

    runs = _fetch(
        "code_runs",
        "select=participant_id,lesson_id,run_index,status,error_type,execution_time_ms,created_at"
        "&order=created_at",
    )
    subs = _fetch(
        "submissions",
        "select=participant_id,lesson_id,submission_index,passed,runs,hints_shown,"
        "seconds_on_lesson,created_at&order=created_at",
    )
    hints = _fetch(
        "learning_events",
        "select=participant_id,lesson_id,payload&event_type=eq.hint_open",
    )

    # 참여자 목록에서 뺀 사람의 기록도 같이 빼야 한다. 이걸 안 하면
    # 참여자는 0명인데 실행은 14건인 통계가 나온다 — 실제로 그랬다.
    runs = [r for r in runs if r["participant_id"] in by_id]
    subs = [s for s in subs if s["participant_id"] in by_id]
    hints = [h for h in hints if h["participant_id"] in by_id]

    # 학생×레슨 셀 하나에 담기는 것
    cell = defaultdict(lambda: {
        "runs": 0, "failed": 0, "cleared": False,
        "submitted": 0, "hints": 0, "first_success_run": None,
    })
    for r in runs:
        code = by_id.get(r["participant_id"])
        if not code:
            continue
        c = cell[(code, r["lesson_id"])]
        c["runs"] += 1
        if r["status"] != "success":
            c["failed"] += 1
        elif c["first_success_run"] is None:
            c["first_success_run"] = r["run_index"]

    for h in hints:
        code = by_id.get(h["participant_id"])
        if code and h.get("lesson_id"):
            cell[(code, h["lesson_id"])]["hints"] += 1

    for s in subs:
        code = by_id.get(s["participant_id"])
        if not code:
            continue
        c = cell[(code, s["lesson_id"])]
        c["submitted"] = max(c["submitted"], s["submission_index"])
        if s["passed"]:
            c["cleared"] = True

    grid = {f"{code}|{lesson}": data for (code, lesson), data in cell.items()}

    # 레슨별 요약
    lesson_ids = sorted({r["lesson_id"] for r in runs} | {s["lesson_id"] for s in subs})
    lessons = []
    for lesson_id in lesson_ids:
        lesson_runs = [r for r in runs if r["lesson_id"] == lesson_id]
        lesson_subs = [s for s in subs if s["lesson_id"] == lesson_id]
        firsts = [
            c["first_success_run"]
            for (code, lid), c in cell.items()
            if lid == lesson_id and c["first_success_run"] is not None
        ]
        actives = {r["participant_id"] for r in lesson_runs}
        lessons.append({
            "lesson_id": lesson_id,
            "participants": len(actives),
            "runs": len(lesson_runs),
            "failed": sum(1 for r in lesson_runs if r["status"] != "success"),
            "submitted": len({s["participant_id"] for s in lesson_subs}),
            "passed": len({s["participant_id"] for s in lesson_subs if s["passed"]}),
            "avg_first_success": round(sum(firsts) / len(firsts), 1) if firsts else None,
            "avg_seconds": round(
                sum(s["seconds_on_lesson"] or 0 for s in lesson_subs) / len(lesson_subs)
            ) if lesson_subs else None,
            "hint_users": len({
                code for (code, lid), c in cell.items()
                if lid == lesson_id and c["hints"] > 0
            }),
        })

    return {
        "participants": [
            {"code": p["participant_code"], "group": p["group_label"]}
            for p in participants
        ],
        "lessons": lessons,
        "grid": grid,
        "totals": {
            "participants": len(participants),
            "active": len({by_id.get(r["participant_id"]) for r in runs} - {None}),
            "runs": len(runs),
            "failed_runs": sum(1 for r in runs if r["status"] != "success"),
            "submissions": len(subs),
        },
    }


@router.get("/lesson/{lesson_id}")
def lesson_detail(lesson_id: str, x_admin_token: str | None = Header(None)):
    """한 레슨에서 무엇이 어떻게 틀렸는가."""
    _require_auth(x_admin_token)
    safe = quote(lesson_id, safe="")

    known = {
        p["id"] for p in _fetch("participants", "select=id&is_test=eq.false")
    }
    runs = [
        r for r in _fetch(
            "code_runs",
            f"select=participant_id,run_index,status,error_type,error_message,error_line,"
            f"counts,circuit_spec,created_at&lesson_id=eq.{safe}&order=created_at",
        )
        if r["participant_id"] in known
    ]

    errors = Counter(r["error_type"] for r in runs if r["status"] != "success")

    # 회로 형태 분포 — 개념 오류가 여기서 드러난다
    shapes = Counter()
    cx_direction = Counter()
    for r in runs:
        spec = r.get("circuit_spec") or {}
        ops = spec.get("ops") or []
        if not ops:
            continue
        # barrier는 학생이 넣은 게 아니라 measure_all 같은 함수가 자동으로
        # 붙이는 것이다. 형태 분포에 섞이면 같은 회로가 다르게 세어진다.
        named = [op["name"] for op in ops if op["name"] != "barrier"]
        if named:
            shapes[" → ".join(named)] += 1
        for op in ops:
            if op["name"] == "cx" and len(op.get("qubits", [])) == 2:
                cx_direction[f"{op['qubits'][0]}→{op['qubits'][1]}"] += 1

    # 학생별 실행 횟수 분포
    per_student = Counter(r["participant_id"] for r in runs)

    return {
        "lesson_id": lesson_id,
        "runs": len(runs),
        "error_types": [
            {"type": t or "(없음)", "count": n} for t, n in errors.most_common()
        ],
        "circuit_shapes": [
            {"shape": s, "count": n} for s, n in shapes.most_common(12)
        ],
        "cx_direction": [
            {"direction": d, "count": n} for d, n in cx_direction.most_common()
        ],
        "run_distribution": sorted(Counter(per_student.values()).items()),
    }


@router.get("/participant/{code}")
def participant_detail(code: str, x_admin_token: str | None = Header(None)):
    """한 학생의 궤적 — 실행마다의 코드와 그때 무슨 일이 있었는지."""
    _require_auth(x_admin_token)
    safe = quote(code, safe="")

    rows = _fetch(
        "participants",
        f"select=id,participant_code,group_label&participant_code=eq.{safe}",
    )
    if not rows:
        raise HTTPException(404, f"'{code}' 참여자를 찾을 수 없어요.")
    pid = rows[0]["id"]

    runs = _fetch(
        "code_runs",
        f"select=lesson_id,run_index,code,status,error_type,error_message,error_line,"
        f"stdout,counts,circuit_spec,execution_time_ms,created_at"
        f"&participant_id=eq.{pid}&order=created_at",
    )
    events = _fetch(
        "learning_events",
        f"select=lesson_id,seq,event_type,payload,client_ts"
        f"&participant_id=eq.{pid}"
        f"&event_type=in.(hint_open,paste,reset_code,lesson_open,lesson_leave,"
        f"answer_submitted,solution_viewed)&order=client_ts",
    )
    subs = _fetch(
        "submissions",
        f"select=lesson_id,submission_index,code,answer,passed,runs,hints_shown,"
        f"seconds_on_lesson,created_at&participant_id=eq.{pid}&order=created_at",
    )

    return {
        "code": rows[0]["participant_code"],
        "group": rows[0]["group_label"],
        "runs": runs,
        "events": events,
        "submissions": subs,
    }
