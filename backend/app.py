"""FastAPI server for MakeQubit — sandboxed Qiskit code execution.

The frontend sends the student's current editor contents; this returns stdout,
auto-detected measurement counts, and a text circuit drawing. Learning-trajectory
events are written to Supabase directly from the browser, not through here.
"""

import os
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import runner
from runner import CodeTooLong, WALL_TIMEOUT_SECONDS, run_code
from sandbox_child import MAX_QUBITS, MAX_SHOTS
from admin import router as admin_router
import roster

app = FastAPI(title="MakeQubit Execution API")
app.include_router(admin_router)

origins = [
    "http://localhost:5173",
    "http://localhost:4173",
]
if os.environ.get("FRONTEND_URL"):
    origins.append(os.environ["FRONTEND_URL"])

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    # localhost는 포트가 유동적이라(vite가 점유된 포트를 피해 옮겨간다) 정규식으로 연다
    allow_origin_regex=r"^(http://localhost:\d+|https://.*\.(railway\.app|vercel\.app))$",
    allow_methods=["*"],
    allow_headers=["*"],
)

# One Qiskit process per student is fine; thirty at once is not. Requests past
# the cap wait rather than fail — a classroom submits in bursts.
# Keep this at or below runner.POOL_SIZE: past that, extra requests just queue
# for a warm worker anyway, and the semaphore is the friendlier place to wait.
MAX_CONCURRENT_RUNS = int(os.environ.get("MAX_CONCURRENT_RUNS", str(runner.POOL_SIZE)))
_run_slots = threading.BoundedSemaphore(MAX_CONCURRENT_RUNS)

# Per-participant throttle: a Run button gets mashed.
RUNS_PER_WINDOW = 20
WINDOW_SECONDS = 60
_recent_runs = defaultdict(deque)
_throttle_lock = threading.Lock()


def _throttle(participant: str):
    now = time.monotonic()
    with _throttle_lock:
        history = _recent_runs[participant]
        while history and now - history[0] > WINDOW_SECONDS:
            history.popleft()
        if len(history) >= RUNS_PER_WINDOW:
            raise HTTPException(
                429, f"잠시 후 다시 실행해 주세요 ({WINDOW_SECONDS}초에 {RUNS_PER_WINDOW}번까지)"
            )
        history.append(now)


class RunRequest(BaseModel):
    code: str
    participant_id: str = Field(default="anonymous", max_length=64)
    lesson_id: str = Field(default="", max_length=64)


@app.post("/api/run")
def run(req: RunRequest):
    if not req.code.strip():
        raise HTTPException(400, "코드가 비어 있어요")

    # 명부에 없는 코드로는 실행하지 않는다. 이 검사가 없으면 URL을 아는
    # 사람이 누구나 서버에서 Python을 돌릴 수 있고, 분당 제한도
    # participant_id를 바꿔 가며 무한히 우회된다.
    if not roster.is_known(req.participant_id):
        raise HTTPException(403, "명부에 없는 참여자 코드예요.")

    _throttle(req.participant_id)

    acquired = _run_slots.acquire(timeout=30)
    if not acquired:
        raise HTTPException(503, "지금 실행 중인 친구가 많아요. 잠시 후 다시 눌러 주세요.")
    try:
        return run_code(req.code)
    except CodeTooLong as exc:
        raise HTTPException(400, str(exc))
    finally:
        _run_slots.release()


@app.get("/api/limits")
def limits():
    """Surfaced in the UI so students know what the environment allows."""
    return {
        "timeout_seconds": WALL_TIMEOUT_SECONDS,
        "max_concurrent_runs": MAX_CONCURRENT_RUNS,
        "runs_per_minute": RUNS_PER_WINDOW,
        "roster_size": roster.size(),
        "max_qubits": MAX_QUBITS,
        "max_shots": MAX_SHOTS,
        "allowed_modules": ["qiskit", "qiskit_aer", "numpy", "math", "random",
                            "cmath", "itertools", "collections", "json"],
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
def _warm_workers():
    """Start the qiskit imports before the first student presses 실행.

    In a thread so the health check answers immediately — Railway would
    otherwise mark the deploy unhealthy while four workers import qiskit.
    """
    threading.Thread(target=runner._fill_pool, daemon=True).start()


@app.on_event("shutdown")
def _stop_workers():
    runner.shutdown_pool()
