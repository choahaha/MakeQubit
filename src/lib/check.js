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

  /** 충분히 여러 번 쟀는가 (shots) */
  counts_total_min: (result, spec) => {
    if (!result.counts) return fail('측정 결과가 아직 없어요.');
    const total = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
    return total >= spec.min
      ? { passed: true }
      : fail(`${spec.min}번 이상 재야 하는데 ${total}번만 쟀어요.`);
  },

  /** 특정 결과가 원하는 비율로 나왔는가 (RY로 확률을 맞추는 레슨용) */
  counts_ratio: (result, spec) => {
    if (!result.counts) return fail('측정 결과가 아직 없어요.');
    const total = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
    const ratio = (result.counts[spec.key] || 0) / total;
    const target = spec.target;
    const tolerance = spec.tolerance ?? 0.05;
    return Math.abs(ratio - target) <= tolerance
      ? { passed: true }
      : fail(`'${spec.key}'이(가) ${Math.round(ratio * 100)}% 나왔어요. `
             + `${Math.round(target * 100)}% 근처가 되어야 해요.`);
  },

  /** 잰 횟수가 정해진 범위 안인가 (shots 자체가 배울 내용인 레슨용) */
  counts_total_min_max: (result, spec) => {
    if (!result.counts) return fail('측정 결과가 아직 없어요.');
    const total = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
    if (total < spec.min) return fail(`${spec.min}번 이상 재야 해요 (${total}번 쟀어요).`);
    if (total > spec.max) return fail(`${spec.max}번까지만 재야 해요 (${total}번 쟀어요).`);
    return { passed: true };
  },

  /**
   * 회로에 특정 연산이 들어 있는가.
   *
   * counts로는 확인할 수 없는 레슨이 있다 — Z만 건 회로는 측정 결과가
   * 안 걸었을 때와 같고, 방향을 뒤집은 CX는 아무 일도 하지 않는다.
   * 그 '아무 일도 안 일어남'이 배울 내용이므로, 게이트 자체를 확인해야 한다.
   */
  circuit_ops: (result, spec) => {
    const ops = result.circuit_spec?.ops;
    if (!ops) return fail('회로가 아직 만들어지지 않았어요.');
    const missing = spec.ops.filter((wanted) => !ops.some((op) =>
      op.name === wanted.name
      && (!wanted.qubits || JSON.stringify(op.qubits) === JSON.stringify(wanted.qubits))));
    if (!missing.length) return { passed: true };
    const names = missing.map((m) =>
      m.qubits ? `${m.name.toUpperCase()}(${m.qubits.join(', ')})` : m.name.toUpperCase());
    return fail(`회로에 ${names.join(', ')}이(가) 아직 없어요.`);
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
  // 조건이 둘 이상이면 전부 만족해야 한다. 첫 실패를 그대로 돌려준다 —
  // 한 번에 하나씩 짚어 주는 편이 학생에게 낫다.
  const specs = Array.isArray(lesson.check) ? lesson.check : [lesson.check];
  for (const spec of specs) {
    const outcome = runOne(spec, result);
    if (!outcome.passed) return outcome;
  }
  return { passed: true };
}

function runOne(spec, result) {
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

/**
 * 성공 조건을 한 줄로 옮긴다 — 편집기 위 목표 배너에 쓴다.
 *
 * 레슨에 따로 문구를 두지 않고 `check`에서 뽑는다. 판정 조건을 고쳤는데
 * 배너 문구가 옛 조건을 말하고 있으면 학생이 못 맞히는 목표를 좇게 된다.
 *
 * 원인은 여전히 말하지 않는다. '무엇이 나와야 하는가'만 알려 주고,
 * '왜 안 나오는가'는 학생 몫이다.
 *
 * @returns {string|null} 자유 탐구 레슨이면 null
 */
export function targetLine(check) {
  const specs = Array.isArray(check) ? check : [check];
  // 뒤에서부터 찾는다. circuit_ops 같은 구조 조건이 앞에 오고
  // 실제 목표인 측정 결과가 뒤에 오는 레슨이 있다.
  for (let i = specs.length - 1; i >= 0; i -= 1) {
    const line = describe(specs[i]);
    if (line) return line;
  }
  return null;
}

function describe(spec) {
  if (!spec || !spec.type) return null;
  switch (spec.type) {
    case 'counts_keys':
      return `결과에 ${spec.keys.join(', ')} 만 나오면 성공`;
    case 'counts_balanced':
      return `${spec.outcomes ?? 2}가지 결과가 골고루 나오면 성공`;
    case 'counts_ratio':
      return `'${spec.key}'이(가) ${Math.round(spec.target * 100)}% 근처면 성공`;
    case 'counts_total_min':
      return `${spec.min}번 이상 재면 성공`;
    case 'counts_total_min_max':
      return `${spec.min}~${spec.max}번 사이로 재면 성공`;
    // circuit_ops / circuit_contains / stdout_contains는 일부러 비운다.
    // 어떤 게이트를 걸어야 하는지, 어떤 출력이 나와야 하는지가 곧 정답이다.
    // 번즈타인-바지라니(l34)에서는 숨은 값 자체가 기대 출력에 들어 있어서,
    // 그대로 보여 주면 학생이 회로를 만들기 전에 답을 알게 된다.
    // 성공줄은 '재 보면 무엇이 나오는가'까지만 말한다.
    default:
      return null;
  }
}
