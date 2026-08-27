/**
 * 레슨 성공 판정.
 *
 * 실패 문구는 관찰된 사실만 말한다. 'CX가 빠졌을 수 있어요' 같은 원인 지목은
 * 하지 않는다 — 플랫폼이 먼저 원인을 알려주면 학생이 힌트를 요청하는지
 * 스스로 고치는지가 데이터에서 사라지고, 그 분기가 이 연구의 관심사다.
 *
 * 자동 채점은 일부러 느슨하다. 목표는 점수를 주는 것이 아니라 "이 학생이
 * 목표 상태에 도달했는가"를 로그에 한 줄 남기는 것이다. 판정은 실행 결과만
 * 보고 하며, 코드 문자열을 정규식으로 맞추지 않는다 — 같은 회로를 여러 방식으로
 * 쓸 수 있기 때문이다.
 */

const CHECKERS = {
  /** 아무 조건 없음 (자유 탐구 레슨) */
  none: () => ({ passed: true }),

  /** 측정 결과에 나온 비트열 집합이 기대와 같은가 */
  counts_keys: (result, spec) => {
    if (!result.counts) return fail('측정 결과가 아직 없어요.');
    const observed = Object.keys(result.counts).sort();
    const expected = [...spec.keys].sort();
    const same = observed.length === expected.length
      && observed.every((key, i) => key === expected[i]);
    return same
      ? { passed: true }
      : fail(`측정 결과가 ${expected.join(', ')} 만 나와야 하는데 ${observed.join(', ') || '없음'}이 나왔어요.`);
  },

  /** 두 결과가 비슷한 비율로 나오는가 (중첩·얽힘 확인용) */
  counts_balanced: (result, spec) => {
    if (!result.counts) return fail('측정 결과(counts)가 없어요.');
    const entries = Object.entries(result.counts);
    if (entries.length !== (spec.outcomes ?? 2)) {
      return fail(`결과가 ${spec.outcomes ?? 2}가지 나와야 하는데 ${entries.length}가지가 나왔어요.`);
    }
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    const tolerance = spec.tolerance ?? 0.15;
    const target = 1 / entries.length;
    const off = entries.find(([, n]) => Math.abs(n / total - target) > tolerance);
    return off
      ? fail(`'${off[0]}'이(가) ${Math.round((off[1] / total) * 100)}% 나왔어요.`)
      : { passed: true };
  },

  /** 회로 그림에 특정 게이트가 들어 있는가 */
  circuit_contains: (result, spec) => {
    if (!result.circuit_text) return fail('회로가 아직 만들어지지 않았어요.');
    const missing = spec.gates.filter((gate) => !result.circuit_text.includes(gate));
    return missing.length
      ? fail(`회로에 ${missing.join(', ')} 게이트가 보이지 않아요.`)
      : { passed: true };
  },

  /** 출력에 특정 문자열이 있는가 */
  stdout_contains: (result, spec) => {
    const text = result.stdout || '';
    const missing = spec.needles.filter((needle) => !text.includes(needle));
    return missing.length
      ? fail(`출력에 ${missing.map((n) => `'${n}'`).join(', ')}이(가) 없어요.`)
      : { passed: true };
  },
};

function fail(reason) {
  return { passed: false, reason };
}

/**
 * @returns {{passed: boolean, reason?: string}}
 */
export function checkLesson(lesson, result) {
  if (result.status !== 'success') {
    return fail('먼저 오류 없이 실행되어야 해요.');
  }
  const spec = lesson.check;
  if (!spec || !spec.type) return { passed: true };

  const checker = CHECKERS[spec.type];
  if (!checker) {
    console.warn(`[check] unknown check type: ${spec.type}`);
    return { passed: true };
  }

  const outcome = checker(result, spec);
  if (!outcome.passed && spec.message) outcome.reason = spec.message;
  return outcome;
}
