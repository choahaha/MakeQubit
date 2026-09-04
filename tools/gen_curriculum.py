#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""data/lessons.json에서 커리큘럼 문서를 다시 만든다.

    python3 tools/gen_curriculum.py

결과를 Artifact로 올리면 검토용 문서가 갱신된다.

손으로 고치지 않는다 — 레슨이 바뀌면 이 스크립트를 다시 돌린다.
따로 관리하는 문서는 반드시 언젠가 레슨과 어긋난다.
"""
import html as H
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tools'

lessons = json.loads((ROOT / 'data/lessons.json').read_text(encoding='utf-8'))
lessons = lessons['lessons'] if isinstance(lessons, dict) else lessons
# hidden은 이번 수업에서 뺀 레슨이다. 학생이 안 보는 것을 문서가 보여주면
# 검토할 때 없는 수업을 검토하게 된다.
lessons = [l for l in lessons if not l.get('hidden')]
quizzes = json.loads((ROOT / 'data/assessments.json').read_text(encoding='utf-8'))
quizzes = quizzes['sets'] if isinstance(quizzes, dict) else quizzes

STYLE = (OUT / 'curriculum_style.css').read_text(encoding='utf-8')
# 정답 줄 색을 추가한다. accent는 이 문서의 파란 계열이다.
STYLE = STYLE.replace(
    "pre.code .todo {",
    """pre.code .ans {
  color: var(--accent);
  font-weight: 600;
}
pre.code .todo {""", 1)

e = H.escape


def api_calls(code):
    """이 코드에서 처음 쓰이는 호출 이름."""
    names = re.findall(r'\b(?:qc|sim)\.([a-z_]+)\(', code)
    names += re.findall(r'\bAerSimulator\b', code) and ['AerSimulator'] or []
    out = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


CHIP = {
    'none': '판정 없음',
    'counts_keys': '측정 결과 일치',
    'counts_balanced': '고른 분포',
    'counts_ratio': '특정 비율로 나오기',
    'counts_total_min': '충분히 여러 번 재기',
    'counts_total_min_max': '정해진 횟수만 재기',
    'circuit_ops': '회로에 특정 연산 포함',
    'circuit_contains': '회로에 게이트 포함',
    'stdout_contains': '출력에 문자열 포함',
}
DESC = {
    'counts_keys': lambda s: f"측정 결과가 {', '.join(s['keys'])} 만 나와야 통과.",
    'counts_balanced': lambda s: f"{s.get('outcomes', 2)}가지가 각각 ±{round(s.get('tolerance', .15)*100)}%p 안으로 고르게 나와야 통과.",
    'counts_ratio': lambda s: f"'{s['key']}'이 {round(s['target']*100)}% ±{round(s.get('tolerance', .05)*100)}%p로 나와야 통과.",
    'counts_total_min': lambda s: f"{s['min']}번 이상 재야 통과.",
    'counts_total_min_max': lambda s: f"{s['min']}~{s['max']}번 사이로 재야 통과.",
    'circuit_ops': lambda s: "회로에 " + ', '.join(
        f"{o['name'].upper()}({', '.join(map(str, o['qubits']))})" if o.get('qubits')
        else o['name'].upper() for o in s['ops']) + " 이(가) 있어야 통과.",
    'circuit_contains': lambda s: f"회로 그림에 {', '.join(s['gates'])} 게이트가 보여야 통과.",
    'stdout_contains': lambda s: "출력에 " + ', '.join(f"'{n}'" for n in s['needles']) + " 이(가) 있어야 통과.",
    'none': lambda s: "자동 판정이 없는 자유 탐구 레슨.",
}


def specs_of(lesson):
    c = lesson['check']
    return c if isinstance(c, list) else [c]


def solved_lines(lesson):
    """시작 코드에 정답을 끼워 넣고, 정답 줄의 위치를 함께 돌려준다.

    verify_lessons.py와 같은 규칙을 쓴다. 여기서 다르게 넣으면 문서가 보여주는
    코드와 실제로 검증한 코드가 갈라진다.
    """
    lines = lesson['starter_code'].split('\n')
    code = (lesson.get('solution') or {}).get('code')
    if not code:
        return lines, set()

    if '=' in code and not code.lstrip().startswith('qc.'):
        name = code.split('=')[0].strip()
        for i, line in enumerate(lines):
            if line.strip().startswith(name + ' ='):
                out = list(lines)
                out[i] = code
                return out, {i}

    out, answers, i = [], set(), 0
    while i < len(lines):
        out.append(lines[i])
        if 'TODO' in lines[i]:
            indent = lines[i][:len(lines[i]) - len(lines[i].lstrip())]
            while i + 1 < len(lines) and lines[i + 1].strip().startswith('#'):
                i += 1
                out.append(lines[i])
            for ln in code.split('\n'):
                answers.add(len(out))
                out.append(ln if ln.startswith(' ') else indent + ln)
        i += 1
    return out, answers


def code_block(lesson):
    lines, answers = solved_lines(lesson)
    rows = []
    for i, line in enumerate(lines):
        if i in answers:
            cls = 'ans'
        elif 'TODO' in line:
            cls = 'todo'
        elif line.strip().startswith('#'):
            cls = 'cmt'
        else:
            cls = ''
        rows.append(f'<span class="cl {cls}">{e(line) if line.strip() else "&nbsp;"}</span>')
    # span을 줄바꿈 없이 잇는다. pre 안에서는 span 사이의 개행이 빈 줄로 한 번
    # 더 렌더되어 모든 줄이 두 칸씩 벌어진다 (.cl이 이미 display:block이다).
    return '<pre class="code">' + ''.join(rows) + '</pre>'


def lesson_card(lesson, number):
    seen = lesson['_seen_apis']
    new_apis = ''.join(f'<code class="api">{e(a)}</code>' for a in seen)
    chk = ''.join(
        f'<p class="chkline"><span class="chip">{CHIP.get(s.get("type"), s.get("type"))}</span>'
        f'{e(DESC.get(s.get("type"), lambda x: "")(s))}</p>'
        for s in specs_of(lesson))
    docs = ''
    if lesson.get('docs'):
        docs = ('<div class="docs"><span class="f">docs[]</span>'
                + ''.join(f'<a class="doc" href="{e(d["url"])}">{e(d["label"])}</a>'
                          for d in lesson['docs']) + '</div>')
    return f"""<article class="lesson" id="{lesson['id']}">
  <header class="lh">
    <span class="ln">{number:02d}</span>
    <div class="lt">
      <h3>{e(lesson['title'])}</h3>
      <p class="lsub">{e(lesson.get('subtitle') or '')}</p>
    </div>
    <code class="lid">{lesson['id']}</code>
  </header>

  <div class="blk goal-blk">
    <div class="bh"><h4>이번에 할 일</h4><span class="f">goal</span></div>
    <p class="goal">{e(lesson['goal'])}</p>
  </div>

  <div class="blk">
    <div class="bh"><h4>알아 두기</h4><span class="f">concept[]</span></div>
    <ul class="concept">{''.join(f'<li>{e(c)}</li>' for c in lesson['concept'])}</ul>
  </div>

  <div class="blk">
    <div class="bh"><h4>학생에게 주어지는 시작 코드</h4><span class="f">starter_code + solution</span></div>
    {f'<div class="newapi"><span class="lbl">처음 나오는 호출</span>{new_apis}</div>' if new_apis else ''}
    {code_block(lesson)}
  </div>

  <div class="blk">
    <div class="bh"><h4>단계별 힌트</h4><span class="f">hints[]</span></div>
    <ol class="hints">{''.join(f'<li><span class="hn">{i+1}</span><span class="ht">{e(h)}</span></li>' for i, h in enumerate(lesson['hints']))}</ol>
  </div>

  <div class="blk check-blk">
    <div class="bh"><h4>성공 판정</h4><span class="f">check</span></div>
    {chk}
    <p class="chknote">판정은 실행 결과만 본다. 코드 문자열은 보지 않는다 — 같은 회로를 여러 방식으로 쓸 수 있다.</p>
  </div>

  {f'<div class="blk"><div class="bh"><h4>더 해보기</h4><span class="f">extra</span></div><p class="ss-extra">{e(lesson["extra"])}</p></div>' if lesson.get('extra') else ''}
  {docs}
</article>"""


# --- 처음 나오는 호출 표시 ---
seen = set()
for l in lessons:
    fresh = [a for a in api_calls(l['starter_code'] + '\n' + ((l.get('solution') or {}).get('code') or '')) if a not in seen]
    seen.update(fresh)
    l['_seen_apis'] = fresh

# --- 차시별로 묶기 ---
groups = []
for l in lessons:
    key = (l['week'], l['session'])
    if not groups or groups[-1][0] != key:
        groups.append((key, []))
    groups[-1][1].append(l)

rows, n = [], 0
for (week, session), items in groups:
    for l in items:
        n += 1
        apis = ''.join(f'<code class="api">{e(a)}</code>' for a in l['_seen_apis']) or '<span class="none">—</span>'
        chips = ' + '.join(CHIP.get(s.get('type'), '') for s in specs_of(l))
        rows.append(f"""<tr>
      <td class="num">{n}</td>
      <td class="wk">{week}-{session}</td>
      <td class="ttl"><a href="#{l['id']}">{e(l['title'])}</a><span class="sub">{e(l.get('subtitle') or '')}</span></td>
      <td class="apis">{apis}</td>
      <td class="chk">{e(chips)}</td>
      <td class="rfl">·</td>
    </tr>""")

nav = ''.join(f'<a href="#{l["id"]}"><span class="nn">{i+1:02d}</span>{e(l["title"])}</a>'
              for i, l in enumerate(lessons))

sections = []
for (week, session), items in groups:
    quiz = next((q for q in quizzes if q['week'] == week and q['session'] == session), None)
    extra = f" · 형성평가 {len(quiz['items'])}문항" if quiz else ''
    sections.append(f'<h2 class="week" id="week-{week}-{session}">'
                    f'<span class="wknum">{week}주차 {session}차시</span>'
                    f'<span class="wkcount">레슨 {len(items)}개 · 50분{extra}</span></h2>')
    start = sum(len(g[1]) for g in groups[:groups.index(((week, session), items))])
    for k, l in enumerate(items):
        sections.append(lesson_card(l, start + k + 1))

page = f"""<title>MakeQubit 3주 커리큘럼</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Nanum+Myeongjo:wght@700;800&display=swap">
{STYLE}
<div class="wrap">

  <header class="cover">
    <div>
      <p class="eyebrow">MakeQubit · 고등학생 대상 Qiskit 실습</p>
      <h1>3주 커리큘럼</h1>
      <p class="lede">
        학생이 실제로 보는 문장, 받는 시작 코드, 눌러서 여는 힌트, 통과 조건을 전부 그대로 옮겼다.
        시작 코드 안의 <b style="color:var(--accent)">파란 줄이 학생이 직접 써야 하는 정답</b>이고,
        나머지는 미리 주어진다. 원본은 <code>data/lessons.json</code> 한 파일이고, 이 페이지는 거기서 생성했다.
      </p>
    </div>
    <div class="stats">
      <div class="stat"><b>{len(groups)}</b><span>차시</span></div>
      <div class="stat"><b>{len(lessons)}</b><span>레슨</span></div>
    </div>
  </header>

  <nav>
    <p class="navlbl">레슨</p>
    {nav}
  </nav>

  <main>
    <section class="summary">
      <h2 class="sec">한눈에 보기</h2>
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>주차</th><th>레슨</th>
              <th>처음 나오는 호출</th><th>판정</th><th>회고</th>
            </tr>
          </thead>
          <tbody>
            {''.join(rows)}
          </tbody>
        </table>
      </div>
    </section>

    {''.join(sections)}
  </main>

  <footer>
    <span>원본: <code>data/lessons.json</code> · 판정 로직: <code>src/lib/check.js</code></span>
    <span>실행 환경: Qiskit + qiskit-aer (noise-free)</span>
  </footer>

</div>
"""

out = OUT / 'curriculum.html'
out.write_text(page, encoding='utf-8')
print(f"{out}  ({len(page):,} bytes)")
print(f"  차시 {len(groups)}개 · 레슨 {len(lessons)}개")
