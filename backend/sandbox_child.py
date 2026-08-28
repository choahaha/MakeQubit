"""Isolated child process that executes a student's Qiskit code.

Never run this module directly on user input from the parent process — it is
spawned by ``runner.py`` as a separate process so that resource limits, the
import guard, and the timeout kill actually have something to bite on.

Protocol:
    python sandbox_child.py <code_file> <result_file>

The child writes a JSON object to ``result_file`` and exits. Anything the
student printed is captured, not streamed.
"""

import builtins
import contextlib
import io
import json
import os
import resource
import sys
import time
import traceback

# --- limits (seconds / bytes) ------------------------------------------------
CPU_SECONDS = 5          # hard CPU ceiling; wall-clock timeout lives in runner.py

# Headroom the student's program gets *on top of* whatever the interpreter is
# already holding. It must not be an absolute ceiling: by the time limits are
# applied, qiskit, qiskit_aer, numpy and BLAS have reserved a large virtual
# address space, and an absolute 512MB left so little room that `[0] * 100000`
# raised MemoryError on Linux. (macOS ignores RLIMIT_AS, so this only ever
# showed up once deployed.) The curriculum tops out at 12 qubits — 4096
# amplitudes — so the headroom is about catching runaway allocations, not about
# fitting the simulator.
STUDENT_MEMORY_BYTES = 256 * 1024 * 1024
MEMORY_BYTES = 512 * 1024 * 1024   # fallback when the baseline is unreadable
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_PROCESSES = 64       # qiskit/numpy spawn threads; too low breaks imports
MAX_OUTPUT_CHARS = 20_000

# 커리큘럼은 큐비트 3개를 넘지 않는다. 12개면 자유 탐구에도 충분하고,
# 2^12 = 4096 상태라 메모리가 터지지 않는다. 상한이 없으면 QuantumCircuit(30)
# 한 줄로 슬롯 하나가 몇 초씩 묶이고, 학생은 '실행이 중단됐어요'라는
# 원인 모를 메시지만 본다.
MAX_QUBITS = 12
MAX_SHOTS = 20_000

# --- import policy -----------------------------------------------------------
# Denied wins over everything, including modules already loaded by qiskit.
DENIED_MODULES = {
    "os", "sys", "subprocess", "socket", "shutil", "pathlib", "glob",
    "importlib", "ctypes", "multiprocessing", "threading", "signal",
    "urllib", "http", "ftplib", "smtplib", "telnetlib", "requests",
    "pickle", "shelve", "marshal", "builtins", "gc", "inspect", "pty",
    "resource", "tempfile", "webbrowser", "runpy", "code", "codeop",
}

# 그림을 직접 그리는 경로. 설치되어 있든 아니든 여기서는 쓸 수 없다 —
# matplotlib Figure는 브라우저로 보낼 수단이 없어서, 되더라도 아무 일도
# 일어나지 않는 것처럼 보인다. 조용한 무반응보다 분명한 안내가 낫다.
PLOTTING_MODULES = {"matplotlib", "pylatexenc", "seaborn", "PIL"}
PLOTTING_MESSAGE = (
    "여기서는 그림을 직접 그리지 않아요. 실행하면 측정 결과 그래프와 회로가 "
    "오른쪽에 자동으로 나와요."
)

# Allowed on top of whatever the interpreter pre-imported at startup.
ALLOWED_MODULES = {
    "qiskit", "qiskit_aer", "numpy", "np",
    "math", "cmath", "random", "statistics", "fractions", "decimal",
    "itertools", "functools", "operator", "collections", "heapq", "bisect",
    "string", "re", "json", "typing", "dataclasses", "enum", "copy", "time",
    "abc", "numbers", "warnings",
}

# Builtins a student never needs and that widen the blast radius.
REMOVED_BUILTINS = {
    "open", "input", "breakpoint", "help", "exit", "quit",
    "compile", "memoryview", "globals", "vars",
}


def _address_space_in_use():
    """Virtual size this process already holds, in bytes. 0 if unknown."""
    try:
        with open("/proc/self/statm") as fh:
            pages = int(fh.read().split()[0])
        return pages * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError, AttributeError):
        return 0   # macOS and friends: RLIMIT_AS is not enforced there anyway


def apply_limits():
    """Best-effort rlimits. Some are unavailable or partial on macOS."""
    baseline = _address_space_in_use()
    as_limit = baseline + STUDENT_MEMORY_BYTES if baseline else MEMORY_BYTES

    for res, value in (
        (resource.RLIMIT_CPU, CPU_SECONDS),
        (resource.RLIMIT_AS, as_limit),
        (resource.RLIMIT_FSIZE, MAX_FILE_BYTES),
        (resource.RLIMIT_NPROC, MAX_PROCESSES),
        (resource.RLIMIT_CORE, 0),
    ):
        try:
            resource.setrlimit(res, (value, value))
        except (ValueError, OSError, AttributeError):
            pass


def build_student_builtins():
    """A restricted builtins mapping used *only* for the student's namespace.

    Mutating the real ``builtins`` module would also strip ``open`` and
    ``__import__`` from qiskit's own internals, which breaks AerSimulator. The
    import statement resolves ``__import__`` through the executing frame's
    builtins, so installing the guard here confines it to student code.
    """
    real_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]

        # qiskit.visualization은 root가 'qiskit'이라 화이트리스트를 통과한다.
        # 전체 이름과 fromlist를 같이 봐야 걸린다.
        if name == "qiskit.visualization" or (
            root == "qiskit" and "visualization" in (fromlist or ())
        ):
            raise ImportError(PLOTTING_MESSAGE)
        if root in PLOTTING_MODULES:
            raise ImportError(PLOTTING_MESSAGE)

        if root in DENIED_MODULES:
            raise ImportError(
                f"'{root}' 모듈은 이 실습 환경에서 사용할 수 없어요. "
                f"qiskit, numpy, math 같은 모듈을 써 주세요."
            )
        if root not in ALLOWED_MODULES:
            raise ImportError(
                f"'{root}' 모듈은 이 실습 환경에 없어요. "
                f"사용 가능: qiskit, qiskit_aer, numpy, math, random 등"
            )
        return real_import(name, globals, locals, fromlist, level)

    restricted = dict(vars(builtins))
    for name in REMOVED_BUILTINS:
        restricted.pop(name, None)
    restricted["__import__"] = guarded_import
    return restricted


def preimport():
    """Load the heavy stack before limits apply, so students get the full budget."""
    import numpy  # noqa: F401
    import qiskit  # noqa: F401
    from qiskit import QuantumCircuit  # noqa: F401
    try:
        import qiskit_aer  # noqa: F401
    except ImportError:
        pass


def install_size_caps():
    """큐비트 수와 shots에 상한을 건다.

    rlimit도 결국은 막지만, 그건 프로세스가 죽는 방식이라 학생에게
    '실행이 중단됐어요'밖에 못 보여준다. 어디가 문제인지 짚어 주려면
    만드는 순간에 잡아야 한다.
    """
    from qiskit import QuantumCircuit

    original_init = QuantumCircuit.__init__

    def guarded_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        if self.num_qubits > MAX_QUBITS:
            raise ValueError(
                f"큐비트는 {MAX_QUBITS}개까지 쓸 수 있어요 "
                f"({self.num_qubits}개를 만들려고 했어요). "
                f"이 수업에서는 1~3개면 충분해요."
            )

    QuantumCircuit.__init__ = guarded_init

    try:
        from qiskit_aer import AerSimulator
    except ImportError:
        return

    original_run = AerSimulator.run

    def guarded_run(self, *args, **kwargs):
        shots = kwargs.get("shots")
        if shots is not None and shots > MAX_SHOTS:
            raise ValueError(
                f"shots는 {MAX_SHOTS:,}번까지 할 수 있어요 "
                f"({shots:,}번을 요청했어요). 1024번이면 충분히 보여요."
            )
        return original_run(self, *args, **kwargs)

    AerSimulator.run = guarded_run


def extract_artifacts(namespace):
    """Pull anything renderable out of the student's namespace.

    Returns (counts, circuit_text, circuit_spec). Prefers the conventional
    names ``counts`` and ``qc``, then falls back to any value of the right shape.
    """
    from qiskit import QuantumCircuit

    counts = None
    circuit_text = None

    def looks_like_counts(value):
        return (
            isinstance(value, dict)
            and value
            and all(isinstance(k, str) for k in value)
            and all(isinstance(v, int) for v in value.values())
        )

    candidate = namespace.get("counts")
    if looks_like_counts(candidate):
        counts = dict(candidate)
    else:
        # qiskit Counts is a dict subclass, so this catches result.get_counts() too
        for key, value in namespace.items():
            if key.startswith("_"):
                continue
            if looks_like_counts(value):
                counts = dict(value)
                break

    circuit = namespace.get("qc")
    if not isinstance(circuit, QuantumCircuit):
        circuit = next(
            (v for k, v in namespace.items()
             if not k.startswith("_") and isinstance(v, QuantumCircuit)),
            None,
        )
    circuit_spec = None
    if circuit is not None:
        try:
            circuit_text = str(circuit.draw(output="text", fold=80))
        except Exception:
            circuit_text = None
        circuit_spec = describe_circuit(circuit)

    return counts, circuit_text, circuit_spec


MAX_SPEC_OPS = 60


def describe_circuit(circuit):
    """A JSON-able description the frontend draws as SVG.

    The text drawing depends on box-drawing glyphs lining up, which they do not
    on every student machine. Sending structure instead lets the browser draw a
    real diagram.
    """
    try:
        qubit_index = {bit: i for i, bit in enumerate(circuit.qubits)}
        clbit_index = {bit: i for i, bit in enumerate(circuit.clbits)}

        ops = []
        for instruction in circuit.data[:MAX_SPEC_OPS]:
            ops.append({
                "name": instruction.operation.name,
                "qubits": [qubit_index[b] for b in instruction.qubits],
                "clbits": [clbit_index[b] for b in instruction.clbits],
                "params": [
                    round(float(p), 4)
                    for p in instruction.operation.params
                    if isinstance(p, (int, float))
                ],
            })

        return {
            "num_qubits": circuit.num_qubits,
            "num_clbits": circuit.num_clbits,
            "ops": ops,
            "truncated": len(circuit.data) > MAX_SPEC_OPS,
        }
    except Exception:
        return None


def format_error(exc, code):
    """A traceback trimmed to the student's own code."""
    frames = traceback.extract_tb(exc.__traceback__)
    student_frames = [f for f in frames if f.filename == "<student>"]
    line = student_frames[-1].lineno if student_frames else None

    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, SyntaxError) and exc.lineno:
        line = exc.lineno

    source_line = None
    if line:
        lines = code.splitlines()
        if 0 < line <= len(lines):
            source_line = lines[line - 1]

    return {"type": type(exc).__name__, "message": str(exc),
            "line": line, "source_line": source_line, "detail": detail}


class _AlreadyReported(BaseException):
    """Sentinel: the error was recorded before exec was reached."""


def execute(code, result_file):
    """Run one student program and write its result. Assumes the heavy imports
    are already done and ``apply_limits`` has fired.

    Split out of ``main`` so ``sandbox_worker`` can reuse it after fork: the
    worker pays the qiskit import once at startup instead of once per run,
    which is 0.37s of the 0.42s a run used to cost.
    """
    # Compile separately from exec so syntax errors carry a real line number.
    compile_fn = builtins.compile

    stdout = io.StringIO()
    namespace = {"__name__": "__main__", "__builtins__": build_student_builtins()}
    result = {"status": "success", "error": None}

    started = time.perf_counter()
    try:
        compiled = compile_fn(code, "<student>", "exec")
    except SyntaxError as exc:
        result["status"] = "error"
        result["error"] = format_error(exc, code)
        compiled = None

    try:
        if compiled is None:
            raise _AlreadyReported
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stdout):
            exec(compiled, namespace)
    except _AlreadyReported:
        pass
    except MemoryError as exc:
        result["status"] = "error"
        result["error"] = {"type": "MemoryError", "message": "메모리를 너무 많이 썼어요. 큐비트 수를 줄여 보세요.",
                           "line": None, "source_line": None, "detail": str(exc)}
    except BaseException as exc:  # SystemExit/KeyboardInterrupt included
        result["status"] = "error"
        result["error"] = format_error(exc, code)
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    output = stdout.getvalue()
    truncated = len(output) > MAX_OUTPUT_CHARS
    if truncated:
        output = output[:MAX_OUTPUT_CHARS]

    counts, circuit_text, circuit_spec = (None, None, None)
    if result["status"] == "success":
        try:
            counts, circuit_text, circuit_spec = extract_artifacts(namespace)
        except Exception:
            pass

    result.update({
        "stdout": output,
        "stdout_truncated": truncated,
        "counts": counts,
        "circuit_text": circuit_text,
        "circuit_spec": circuit_spec,
        "execution_time_ms": elapsed_ms,
    })

    with open(result_file, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)


def main():
    """Standalone path: one process per run, imports and all.

    ``runner.py`` prefers the warm worker pool; this stays as the fallback for
    when no worker is available, and keeps the module runnable on its own.
    """
    code_file, result_file = sys.argv[1], sys.argv[2]
    with open(code_file, encoding="utf-8") as fh:
        code = fh.read()

    preimport()
    install_size_caps()
    apply_limits()
    execute(code, result_file)


if __name__ == "__main__":
    main()
