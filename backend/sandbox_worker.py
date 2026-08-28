"""A long-lived process that forks one grandchild per student program.

Why this exists: importing qiskit and qiskit_aer costs ~0.37s, and the circuits
this curriculum builds simulate in ~0.03s. Spawning a fresh interpreter per run
meant 92% of the wall clock was import. A worker pays that once at startup and
forks afterwards, so a class of twenty pressing 실행 at the same moment drains
in well under a second instead of several.

What does NOT change: every student program still runs in its own process that
exits when the program does, still gets its own process group so the runner can
kill it as a unit, still has the rlimits applied before its first statement, and
still sees the restricted builtins. Forking moves *when* qiskit is imported, not
what the student's process is allowed to do.

The worker never executes student code itself and never runs a circuit — it only
imports. Keeping the simulator untouched here means no Aer thread pool exists at
fork time, which is what makes forking safe.

Protocol, one JSON object per line each way:
    in   {"code_file": ..., "result_file": ..., "workdir": ...}
    out  {"pid": 12345}                    as soon as the fork succeeds
    out  {"done": true, "code": <status>}  when that grandchild is reaped

``code`` is the raw ``os.waitpid`` status, so the runner can tell a SIGXCPU kill
from a clean exit exactly as it did with a spawned child.
"""

import json
import os
import sys

import sandbox_child as child


def _diagnose(result_file):
    """Report what a student's process actually sees. Same fork, same limits —
    this is a probe of the real execution site, not of the worker."""
    import resource
    import traceback

    child.apply_limits()
    info = {}
    for name in ("RLIMIT_CPU", "RLIMIT_AS", "RLIMIT_NPROC", "RLIMIT_FSIZE"):
        try:
            info[name] = resource.getrlimit(getattr(resource, name))
        except Exception as exc:
            info[name] = f"?: {exc}"

    for path, key in (("/proc/self/status", "status"),
                      ("/sys/fs/cgroup/pids.max", "cgroup_pids_max"),
                      ("/sys/fs/cgroup/pids.current", "cgroup_pids_current"),
                      ("/sys/fs/cgroup/memory.max", "cgroup_memory_max")):
        try:
            with open(path) as fh:
                text = fh.read()
            if key == "status":
                info[key] = {k: v.strip() for k, v in
                             (l.split(":", 1) for l in text.splitlines() if ":" in l)
                             if k in ("Threads", "VmSize", "VmRSS")}
            else:
                info[key] = text.strip()
        except Exception as exc:
            info[key] = f"?: {exc}"

    # The failing call itself, with the real traceback.
    try:
        from qiskit import QuantumCircuit, transpile
        from qiskit_aer import AerSimulator
        qc = QuantumCircuit(1, 1)
        qc.h(0)
        qc.measure(0, 0)
        sim = AerSimulator()
        info["aer"] = str(sim.run(transpile(qc, sim), shots=8).result().get_counts())
    except BaseException:
        info["aer"] = "FAILED"
        info["aer_traceback"] = traceback.format_exc()[-1500:]

    with open(result_file, "w", encoding="utf-8") as fh:
        json.dump(info, fh, ensure_ascii=False)


def _run_student(job):
    """Inside the forked grandchild. Never returns."""
    try:
        # Own process group: runner.py kills the whole group on wall timeout,
        # so anything the student's program spawned goes with it.
        os.setsid()

        workdir = job["workdir"]
        os.chdir(workdir)
        # The worker's own env is shared by every job, so point HOME and TMPDIR
        # at this run's directory here rather than at spawn time.
        os.environ["HOME"] = workdir
        os.environ["TMPDIR"] = workdir

        # The worker's stdout carries the protocol. A grandchild must never
        # write to it — a stray print would be read as a reply. Student output
        # is captured in-process and written to result.json regardless; this
        # file only catches what escapes that, which is what the runner shows
        # as the crash detail.
        log = os.open(os.path.join(workdir, "stderr.log"),
                      os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(log, 1)
        os.dup2(log, 2)
        os.close(log)

        if job.get("diag"):
            _diagnose(job["result_file"])
            os._exit(0)

        with open(job["code_file"], encoding="utf-8") as fh:
            code = fh.read()

        child.apply_limits()
        child.execute(code, job["result_file"])
    except BaseException:
        # Never unwind past here: an exception escaping into the fork would
        # leave a second copy of the worker loop running.
        os._exit(1)
    os._exit(0)


def main():
    # Pay the import once, before any job arrives. install_size_caps patches
    # QuantumCircuit and AerSimulator in this process; forked grandchildren
    # inherit the patched classes.
    child.preimport()
    child.install_size_caps()

    # Tell the runner the import is done, so it does not hand work to a worker
    # that is still starting up.
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)

        pid = os.fork()
        if pid == 0:
            _run_student(job)

        sys.stdout.write(json.dumps({"pid": pid}) + "\n")
        sys.stdout.flush()

        _, status = os.waitpid(pid, 0)
        sys.stdout.write(json.dumps({"done": True, "code": status}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
