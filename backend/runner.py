"""Parent-side driver for sandboxed student code execution.

Student code runs in a grandchild process forked by a warm worker
(``sandbox_worker.py``) that has already imported qiskit. The worker is a
latency fix, not a safety change: each program still gets its own process, its
own process group, its own rlimits, and the restricted builtins. If no worker
is available the code runs the old way — a fresh ``sandbox_child.py`` process
that imports qiskit itself — so a broken pool degrades to slow, never to
unsandboxed.

The wall-clock timeout stays here, on top of the child's own CPU rlimit.
"""

import json
import os
import queue
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

CHILD = Path(__file__).parent / "sandbox_child.py"
WORKER = Path(__file__).parent / "sandbox_worker.py"

WALL_TIMEOUT_SECONDS = 8    # must exceed sandbox_child.CPU_SECONDS
MAX_CODE_CHARS = 20_000

# One warm worker per concurrent run. Each holds ~77MB once qiskit is loaded,
# so this is the knob to turn down on a small instance.
POOL_SIZE = int(os.environ.get("SANDBOX_WORKERS", "4"))
WORKER_START_TIMEOUT = 60   # a cold container can be slow to import qiskit


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
        # qiskit_aer's simulator is Rust; its thread pool is Rayon's, which
        # ignores the OMP vars. Parallelising one student's 2-qubit circuit
        # only steals CPU from the other nineteen.
        "RAYON_NUM_THREADS": "1",
        # glibc opens a fresh 64MB arena per thread. Left alone it eats the
        # address-space headroom that RLIMIT_AS grants the student.
        "MALLOC_ARENA_MAX": "2",
    }


# --- warm worker pool --------------------------------------------------------

class _Worker:
    """One warm process. Used by a single thread at a time (checked out of the
    pool), so its pipes need no locking."""

    def __init__(self):
        self.home = tempfile.mkdtemp(prefix="makequbit-worker-")
        self.proc = subprocess.Popen(
            [sys.executable, str(WORKER)],
            cwd=str(WORKER.parent),
            env=_child_env(self.home),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
        hello = self._read(WORKER_START_TIMEOUT)
        if not hello or not hello.get("ready"):
            self.close()
            raise RuntimeError("worker failed to start")

    def _read(self, timeout):
        """One JSON line, or None if it did not arrive in time."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            ready, _, _ = select.select([self.proc.stdout], [], [], remaining)
            if not ready:
                return None
            line = self.proc.stdout.readline()
            if not line:          # worker died
                return None
            line = line.strip()
            if line:
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    return None

    def run(self, job, timeout):
        """Returns (waitpid_status, timed_out). Raises if the worker is unusable."""
        self.proc.stdin.write(json.dumps(job) + "\n")
        self.proc.stdin.flush()

        started = self._read(10)
        if not started or "pid" not in started:
            raise RuntimeError("worker did not fork")
        pid = started["pid"]

        done = self._read(timeout)
        if done is not None:
            return done.get("code", 0), False

        # Wall timeout: kill the grandchild's whole group, then collect the
        # worker's report so the pipe stays in sync and the worker is reusable.
        _kill_group_pid(pid)
        done = self._read(5)
        if done is None:
            raise RuntimeError("worker stuck after kill")
        return done.get("code", 0), True

    def alive(self):
        return self.proc.poll() is None

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass
        try:
            import shutil
            shutil.rmtree(self.home, ignore_errors=True)
        except Exception:
            pass


_pool = queue.Queue()
_pool_lock = threading.Lock()
_pool_filled = False
_pool_started = 0        # how many workers actually came up


def _fill_pool():
    global _pool_filled, _pool_started
    with _pool_lock:
        if _pool_filled:
            return
        _pool_filled = True
    for _ in range(POOL_SIZE):
        try:
            _pool.put(_Worker())
            with _pool_lock:
                _pool_started += 1
        except Exception:
            # A pool that will not start is not fatal — run_code falls back to
            # spawning a cold child per run, which is how this used to work.
            break


def _acquire_worker():
    """A live worker, or None to fall back to a cold spawn.

    Waits when every worker is busy rather than spawning a cold child: a cold
    run costs ~0.45s against a warm one's ~0.08s, so queueing for a warm worker
    beats jumping the queue slowly. The wait is bounded because a busy worker
    is released within the wall timeout, one way or another.
    """
    _fill_pool()
    with _pool_lock:
        have_workers = _pool_started > 0
    if not have_workers:
        return None

    try:
        worker = _pool.get(timeout=WALL_TIMEOUT_SECONDS * POOL_SIZE + 5)
    except queue.Empty:
        return None
    if worker.alive():
        return worker
    worker.close()
    return _new_worker()


def _new_worker():
    try:
        return _Worker()
    except Exception:
        return None


def _release_worker(worker, healthy):
    """Warm workers are reusable; a wedged one is replaced in the background."""
    if healthy and worker.alive():
        _pool.put(worker)
        return
    worker.close()
    threading.Thread(target=_replace_worker, daemon=True).start()


def _replace_worker():
    replacement = _new_worker()
    if replacement is not None:
        _pool.put(replacement)


def shutdown_pool():
    while True:
        try:
            _pool.get_nowait().close()
        except queue.Empty:
            return


# --- running -----------------------------------------------------------------

def run_code(code: str) -> dict:
    """Execute ``code`` in an isolated process and return a result dict.

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
        worker = _acquire_worker()
        if worker is not None:
            status, timed_out, stderr = _run_on_worker(
                worker, workdir, code_file, result_file)
        else:
            status, timed_out, stderr = _run_cold(workdir, code_file, result_file)
        wall_ms = int((time.perf_counter() - started) * 1000)

        return _collect(status, timed_out, stderr, result_file, wall_ms)


def _run_on_worker(worker, workdir, code_file, result_file):
    job = {"workdir": workdir, "code_file": code_file, "result_file": result_file}
    try:
        status, timed_out = worker.run(job, WALL_TIMEOUT_SECONDS)
    except Exception:
        _release_worker(worker, healthy=False)
        # Losing the worker mid-run tells us nothing about the student's code,
        # so redo the run the slow way rather than blaming them for a crash.
        return _run_cold(workdir, code_file, result_file)
    _release_worker(worker, healthy=True)
    return status, timed_out, _read_stderr(workdir)


def _run_cold(workdir, code_file, result_file):
    """The original path: a fresh process that imports qiskit itself."""
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

    # Normalise to a waitpid-style status so _collect reads one shape.
    status = 0
    if proc.returncode is not None and proc.returncode < 0:
        status = -proc.returncode          # signal number
    return status, timed_out, (stderr or b"").decode("utf-8", "replace")


def _read_stderr(workdir):
    path = os.path.join(workdir, "stderr.log")
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def _collect(status, timed_out, stderr, result_file, wall_ms):
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
    if _killed_by(status, signal.SIGXCPU):
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
        (stderr or "")[-2000:],
    )


def _killed_by(status, sig):
    """``status`` is a waitpid status from the worker, or a bare signal number
    from the cold path. Both read the same way: a bare signal number *is* a
    valid 'killed by that signal, no core dumped' status, so WIFSIGNALED and
    WTERMSIG decode it correctly either way."""
    return os.WIFSIGNALED(status) and os.WTERMSIG(status) == sig


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


def _kill_group_pid(pid):
    """Kill a grandchild by pid. It called setsid, so its group id is its pid —
    but read it back anyway in case the fork was killed before setsid ran."""
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
