"""Parent-side driver for sandboxed student code execution.

Spawns ``sandbox_child.py`` in its own process group so a runaway program can
be killed as a group, with a wall-clock timeout on top of the child's own
CPU rlimit.
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CHILD = Path(__file__).parent / "sandbox_child.py"

WALL_TIMEOUT_SECONDS = 8    # must exceed sandbox_child.CPU_SECONDS
MAX_CODE_CHARS = 20_000


class CodeTooLong(ValueError):
    pass


def _child_env(home: str) -> dict:
    """A deliberately thin environment — no inherited secrets."""
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": home,
        "TMPDIR": home,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "PYTHONHASHSEED": "0",
        "MPLBACKEND": "Agg",
        # keep BLAS from grabbing every core when several students run at once
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
    }


def run_code(code: str) -> dict:
    """Execute ``code`` in an isolated subprocess and return a result dict.

    Always returns a dict with a ``status`` of success / error / timeout /
    crashed — it does not raise on student mistakes.
    """
    if len(code) > MAX_CODE_CHARS:
        raise CodeTooLong(f"코드가 너무 길어요 (최대 {MAX_CODE_CHARS}자)")

    with tempfile.TemporaryDirectory(prefix="makequbit-") as workdir:
        code_file = os.path.join(workdir, "student.py")
        result_file = os.path.join(workdir, "result.json")
        Path(code_file).write_text(code, encoding="utf-8")

        started = time.perf_counter()
        proc = subprocess.Popen(
            [sys.executable, str(CHILD), code_file, result_file],
            cwd=workdir,
            env=_child_env(workdir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,   # own process group -> killable as a unit
        )

        try:
            _, stderr = proc.communicate(timeout=WALL_TIMEOUT_SECONDS)
            timed_out = False
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            _, stderr = proc.communicate()
            timed_out = True

        wall_ms = int((time.perf_counter() - started) * 1000)

        if timed_out:
            return {
                "status": "timeout",
                "stdout": "",
                "stdout_truncated": False,
                "counts": None,
                "circuit_text": None,
                "circuit_spec": None,
                "execution_time_ms": wall_ms,
                "error": {
                    "type": "Timeout",
                    "message": f"{WALL_TIMEOUT_SECONDS}초 안에 끝나지 않아 중단했어요. "
                               f"무한 반복이나 큐비트 수가 너무 많지 않은지 확인해 보세요.",
                    "line": None,
                    "source_line": None,
                    "detail": "wall-clock timeout",
                },
            }

        # CPU rlimit kills fire as SIGXCPU before the child can write a result.
        if proc.returncode == -signal.SIGXCPU:
            return _aborted(
                "timeout", wall_ms, "CpuLimit",
                "계산이 너무 오래 걸려서 중단했어요. 큐비트 수나 반복 횟수를 줄여 보세요.",
                "SIGXCPU",
            )

        if os.path.exists(result_file):
            try:
                result = json.loads(Path(result_file).read_text(encoding="utf-8"))
                result["wall_time_ms"] = wall_ms
                return result
            except json.JSONDecodeError:
                pass

        # Child died before writing a result: segfault, OOM kill, rlimit.
        return _aborted(
            "crashed", wall_ms, "ExecutionAborted",
            "실행이 중단됐어요. 메모리나 시간 제한을 넘었을 수 있어요.",
            (stderr or b"").decode("utf-8", "replace")[-2000:],
        )


def _aborted(status, wall_ms, error_type, message, detail):
    """A result dict for a child that never reported back."""
    return {
        "status": status,
        "stdout": "",
        "stdout_truncated": False,
        "counts": None,
        "circuit_text": None,
        "circuit_spec": None,
        "execution_time_ms": wall_ms,
        "wall_time_ms": wall_ms,
        "error": {
            "type": error_type,
            "message": message,
            "line": None,
            "source_line": None,
            "detail": detail,
        },
    }


def _kill_group(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()
