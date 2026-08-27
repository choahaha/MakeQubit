/**
 * 회로 도식 렌더러.
 *
 * Qiskit의 텍스트 그림(qc.draw())은 ┤├─ 같은 박스 문자가 폰트에 따라
 * 끊겨 보인다. 학생 기기를 통제할 수 없으므로 백엔드가 보내 준 구조
 * (circuit_spec)로 직접 SVG를 그린다.
 */

const COLUMN_WIDTH = 46;
const ROW_HEIGHT = 44;
const LEFT_LABEL = 34;
const GATE_SIZE = 28;
const PADDING = 10;

/** 게이트별 색 — EduQubit 팔레트를 따른다. */
const GATE_COLORS = {
  h: '#6366f1',
  x: '#f97316',
  y: '#f97316',
  z: '#0ea5e9',
  s: '#0ea5e9',
  t: '#0ea5e9',
  rx: '#f97316',
  ry: '#f97316',
  rz: '#0ea5e9',
  default: '#64748b',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * 각 연산에 열 번호를 준다. 한 열에 서로 겹치지 않는 연산은 같이 놓는다
 * (Qiskit 그림과 같은 방식) — 회로가 옆으로 길어지지 않는다.
 */
function assignColumns(ops, numQubits) {
  const nextFree = new Array(numQubits).fill(0);
  return ops.map((op) => {
    const touched = op.qubits.length ? op.qubits : [0];
    // 측정은 고전선까지 세로로 내려가므로 아래 줄을 전부 차지한 것으로 친다.
    // 그러지 않으면 두 측정이 같은 열에 놓여 세로선과 비트 번호가 겹친다.
    const reachesBottom = op.name.toLowerCase() === 'measure';
    const span = [
      Math.min(...touched),
      reachesBottom ? numQubits - 1 : Math.max(...touched),
    ];
    let column = 0;
    for (let q = span[0]; q <= span[1]; q += 1) {
      column = Math.max(column, nextFree[q] ?? 0);
    }
    for (let q = span[0]; q <= span[1]; q += 1) {
      nextFree[q] = column + 1;
    }
    return { ...op, column };
  });
}

function gateLabel(op) {
  const name = op.name.toLowerCase();
  if (name === 'measure') return 'M';
  if (op.params.length) return name.toUpperCase();
  return name.toUpperCase();
}

export function renderCircuitSvg(spec) {
  const placed = assignColumns(spec.ops, spec.num_qubits);
  const columns = placed.length ? Math.max(...placed.map((o) => o.column)) + 1 : 1;

  const width = LEFT_LABEL + columns * COLUMN_WIDTH + PADDING * 2;
  const classicalRow = spec.num_clbits > 0 ? spec.num_qubits : null;
  const rows = spec.num_qubits + (classicalRow !== null ? 1 : 0);
  const height = rows * ROW_HEIGHT + PADDING;

  const svg = el('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `큐비트 ${spec.num_qubits}개짜리 양자 회로`,
  });

  const rowY = (index) => PADDING + index * ROW_HEIGHT + ROW_HEIGHT / 2;
  const colX = (column) => LEFT_LABEL + PADDING + column * COLUMN_WIDTH + COLUMN_WIDTH / 2;
  const wireEnd = width - PADDING;

  // 큐비트 선과 |0⟩ 라벨
  for (let q = 0; q < spec.num_qubits; q += 1) {
    const y = rowY(q);
    svg.appendChild(el('line', {
      x1: LEFT_LABEL, y1: y, x2: wireEnd, y2: y,
      stroke: '#cbd5e1', 'stroke-width': 1.5,
    }));
    const label = el('text', {
      x: PADDING, y: y + 4,
      fill: '#94a3b8', 'font-size': 12, 'font-family': 'ui-monospace, monospace',
    });
    label.textContent = `|0⟩`;
    svg.appendChild(label);
  }

  // 고전 비트 선 (이중선)
  if (classicalRow !== null) {
    const y = rowY(classicalRow);
    for (const offset of [-1.5, 1.5]) {
      svg.appendChild(el('line', {
        x1: LEFT_LABEL, y1: y + offset, x2: wireEnd, y2: y + offset,
        stroke: '#cbd5e1', 'stroke-width': 1,
      }));
    }
    const label = el('text', {
      x: PADDING, y: y + 4,
      fill: '#94a3b8', 'font-size': 11, 'font-family': 'ui-monospace, monospace',
    });
    label.textContent = `c${spec.num_clbits}`;
    svg.appendChild(label);
  }

  for (const op of placed) {
    const name = op.name.toLowerCase();
    const x = colX(op.column);

    if (name === 'cx' || name === 'cz' || name === 'ccx') {
      drawControlled(svg, op, x, rowY, name);
    } else if (name === 'swap') {
      drawSwap(svg, op, x, rowY);
    } else if (name === 'measure') {
      drawMeasure(svg, op, x, rowY, classicalRow);
    } else if (name === 'barrier') {
      for (const q of op.qubits) {
        svg.appendChild(el('line', {
          x1: x, y1: rowY(q) - 18, x2: x, y2: rowY(q) + 18,
          stroke: '#cbd5e1', 'stroke-width': 1, 'stroke-dasharray': '3 3',
        }));
      }
    } else {
      drawBoxGate(svg, op, x, rowY(op.qubits[0] ?? 0), name);
    }
  }

  return svg;
}

function drawBoxGate(svg, op, x, y, name) {
  const color = GATE_COLORS[name] || GATE_COLORS.default;
  svg.appendChild(el('rect', {
    x: x - GATE_SIZE / 2, y: y - GATE_SIZE / 2,
    width: GATE_SIZE, height: GATE_SIZE, rx: 7,
    fill: color, stroke: color,
  }));
  const text = el('text', {
    x, y: y + 4.5, fill: '#ffffff',
    'font-size': 13, 'font-weight': 700, 'text-anchor': 'middle',
    'font-family': 'Outfit, sans-serif',
  });
  text.textContent = gateLabel(op);
  svg.appendChild(text);
}

function drawControlled(svg, op, x, rowY, name) {
  const controls = op.qubits.slice(0, -1);
  const target = op.qubits[op.qubits.length - 1];
  const ys = op.qubits.map(rowY);

  svg.appendChild(el('line', {
    x1: x, y1: Math.min(...ys), x2: x, y2: Math.max(...ys),
    stroke: '#6366f1', 'stroke-width': 2,
  }));

  for (const control of controls) {
    svg.appendChild(el('circle', {
      cx: x, cy: rowY(control), r: 5, fill: '#6366f1',
    }));
  }

  const targetY = rowY(target);
  if (name === 'cz') {
    svg.appendChild(el('circle', { cx: x, cy: targetY, r: 5, fill: '#6366f1' }));
    return;
  }
  // ⊕ 표적
  svg.appendChild(el('circle', {
    cx: x, cy: targetY, r: 11,
    fill: '#ffffff', stroke: '#6366f1', 'stroke-width': 2,
  }));
  svg.appendChild(el('line', {
    x1: x - 11, y1: targetY, x2: x + 11, y2: targetY,
    stroke: '#6366f1', 'stroke-width': 2,
  }));
  svg.appendChild(el('line', {
    x1: x, y1: targetY - 11, x2: x, y2: targetY + 11,
    stroke: '#6366f1', 'stroke-width': 2,
  }));
}

function drawSwap(svg, op, x, rowY) {
  const ys = op.qubits.map(rowY);
  svg.appendChild(el('line', {
    x1: x, y1: Math.min(...ys), x2: x, y2: Math.max(...ys),
    stroke: '#6366f1', 'stroke-width': 2,
  }));
  for (const y of ys) {
    for (const [dx, dy] of [[-6, -6], [-6, 6]]) {
      svg.appendChild(el('line', {
        x1: x + dx, y1: y + dy, x2: x - dx, y2: y - dy,
        stroke: '#6366f1', 'stroke-width': 2, 'stroke-linecap': 'round',
      }));
    }
  }
}

function drawMeasure(svg, op, x, rowY, classicalRow) {
  const y = rowY(op.qubits[0]);

  if (classicalRow !== null && op.clbits.length) {
    const classicalY = rowY(classicalRow);
    for (const offset of [-1.5, 1.5]) {
      svg.appendChild(el('line', {
        x1: x + offset, y1: y, x2: x + offset, y2: classicalY,
        stroke: '#cbd5e1', 'stroke-width': 1,
      }));
    }
    const index = el('text', {
      x: x + 7, y: classicalY + 15, fill: '#94a3b8',
      'font-size': 10, 'font-family': 'ui-monospace, monospace',
    });
    index.textContent = String(op.clbits[0]);
    svg.appendChild(index);
  }

  svg.appendChild(el('rect', {
    x: x - GATE_SIZE / 2, y: y - GATE_SIZE / 2,
    width: GATE_SIZE, height: GATE_SIZE, rx: 7,
    fill: '#ffffff', stroke: '#94a3b8', 'stroke-width': 1.5,
  }));
  // 계기판 눈금 — 측정을 뜻하는 관용 기호
  svg.appendChild(el('path', {
    d: `M ${x - 8} ${y + 6} A 8 8 0 0 1 ${x + 8} ${y + 6}`,
    fill: 'none', stroke: '#475569', 'stroke-width': 1.5,
  }));
  svg.appendChild(el('line', {
    x1: x, y1: y + 6, x2: x + 6, y2: y - 4,
    stroke: '#475569', 'stroke-width': 1.5, 'stroke-linecap': 'round',
  }));
}
