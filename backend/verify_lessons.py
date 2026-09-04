"""레슨 35개를 실제 샌드박스로 돌려 본다.

두 가지를 확인한다.
  - 정답을 넣으면 판정을 통과하는가
  - 시작 코드 그대로는 통과하지 못하는가 (판정이 실제로 무언가를 보고 있는가)

두 번째가 없으면 '아무 코드나 통과하는 판정'을 못 잡는다. 자유 탐구 레슨
(check.type == "none")만 예외다.

    cd backend && python3 verify_lessons.py
"""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from runner import run_code, shutdown_pool

LESSONS = pathlib.Path(__file__).parent.parent / "data" / "lessons.json"


def load():
    raw = json.loads(LESSONS.read_text(encoding="utf-8"))
    return raw["lessons"] if isinstance(raw, dict) else raw


def solve(lesson):
    """시작 코드의 TODO 자리에 정답을 끼워 넣는다.

    TODO가 여럿이면 모든 자리에 같은 정답을 넣는다 — 번스타인-바지라니처럼
    같은 모양을 앞뒤로 두 번 쓰는 레슨이 있다.

    들여쓰기: 정답 줄이 이미 공백으로 시작하면 그대로 두고, 아니면 그 TODO
    줄의 들여쓰기를 붙인다.
    """
    lines = lesson["starter_code"].split("\n")
    code = (lesson.get("solution") or {}).get("code")
    if not code:
        return "\n".join(lines)

    # 숫자 하나만 바꾸는 레슨(shots, p)은 있는 줄을 갈아 끼운다.
    if "=" in code and not code.lstrip().startswith("qc."):
        name = code.split("=")[0].strip()
        for i, line in enumerate(lines):
            if line.strip().startswith(name + " ="):
                out = list(lines)
                out[i] = code
                return "\n".join(out)

    out = []
    i = 0
    while i < len(lines):
        out.append(lines[i])
        if "TODO" in lines[i]:
            indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
            # TODO에 이어지는 주석 줄은 그대로 두고 그 뒤에 넣는다.
            while i + 1 < len(lines) and lines[i + 1].strip().startswith("#"):
                i += 1
                out.append(lines[i])
            out.extend(
                ln if ln.startswith(" ") else indent + ln for ln in code.split("\n")
            )
        i += 1
    return "\n".join(out)


def one(spec, result):
    kind = spec["type"]
    counts = result.get("counts")
    total = sum(counts.values()) if counts else 0

    if kind == "none":
        return True
    if kind == "counts_keys":
        return bool(counts) and sorted(counts) == sorted(spec["keys"])
    if kind == "counts_balanced":
        if not counts:
            return False
        n = spec.get("outcomes", 2)
        tol = spec.get("tolerance", 0.15)
        if len(counts) != n:
            return False
        return all(abs(v / total - 1 / n) <= tol for v in counts.values())
    if kind == "counts_ratio":
        if not counts:
            return False
        got = counts.get(spec["key"], 0) / total
        return abs(got - spec["target"]) <= spec.get("tolerance", 0.05)
    if kind == "counts_total_min":
        return bool(counts) and total >= spec["min"]
    if kind == "counts_total_min_max":
        return bool(counts) and spec["min"] <= total <= spec["max"]
    if kind == "circuit_contains":
        text = result.get("circuit_text") or ""
        return all(g in text for g in spec["gates"])
    if kind == "circuit_ops":
        ops = (result.get("circuit_spec") or {}).get("ops")
        if not ops:
            return False
        return all(
            any(
                op["name"] == want["name"]
                and ("qubits" not in want or op["qubits"] == want["qubits"])
                for op in ops
            )
            for want in spec["ops"]
        )
    if kind == "stdout_contains":
        text = result.get("stdout") or ""
        return all(n in text for n in spec["needles"])
    raise SystemExit(f"모르는 판정 유형: {kind}")


def passes(lesson, result):
    if result["status"] != "success":
        return False
    specs = lesson["check"] if isinstance(lesson["check"], list) else [lesson["check"]]
    return all(one(s, result) for s in specs)


def main():
    lessons = load()
    problems = 0
    for lesson in lessons:
        starter = run_code(lesson["starter_code"])
        solved = run_code(solve(lesson))
        starter_ok = passes(lesson, starter)
        solved_ok = passes(lesson, solved)

        free = (lesson["check"] or {}).get("type") == "none" if isinstance(
            lesson["check"], dict) else False
        bad = (not solved_ok) or (starter_ok and not free)
        if bad:
            problems += 1

        mark = "  " if not bad else "!!"
        print(f"{mark} {lesson['id']:22} 시작={'통과' if starter_ok else '미통과'}"
              f"  정답={'통과' if solved_ok else '미통과'}")
        if bad and not solved_ok:
            err = solved.get("error") or {}
            print(f"     정답 실패: {solved['status']} {err.get('type','')} "
                  f"{(err.get('message') or '')[:70]}")

    print(f"\n문제 {problems}건 / {len(lessons)}개")
    shutdown_pool()
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
