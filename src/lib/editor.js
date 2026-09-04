import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, keymap } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';

/** 오류 줄 표시 — 실행 결과가 돌아온 뒤 편집기에 직접 표시한다. */
const setErrorLine = StateEffect.define();

const errorLineField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setErrorLine)) continue;
      const lineNumber = effect.value;
      if (!lineNumber) {
        decorations = Decoration.none;
        break;
      }
      const total = tr.state.doc.lines;
      const clamped = Math.min(Math.max(lineNumber, 1), total);
      const line = tr.state.doc.line(clamped);
      decorations = Decoration.set([
        Decoration.line({ class: 'error-line' }).range(line.from),
      ]);
    }
    // 학생이 코드를 고치기 시작하면 빨간 줄은 즉시 사라져야 한다
    if (tr.docChanged && !tr.effects.some((e) => e.is(setErrorLine))) {
      decorations = Decoration.none;
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Enter를 누르면 앞 줄과 같은 깊이에서 시작한다.
 *
 * CodeMirror는 문법 트리로 들여쓰기를 계산하는데, 함수 안 주석 뒤가 빈 줄이면
 * 함수가 끝난 것으로 보고 0칸을 준다. 학생이 def 안에서 Enter를 누르면 왼쪽
 * 끝으로 떨어지고, 그대로 실행하면 IndentationError가 난다.
 *
 * 파이썬을 처음 쓰는 학생에게는 '앞 줄을 따라간다'가 예측 가능한 규칙이다.
 * 줄이 콜론으로 끝나면 한 단계 더 들어간다.
 */
function newlineKeepIndent(view) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const indent = line.text.match(/^[ \t]*/)[0];
  // 뒤에 붙은 주석은 떼고 본다. 'for i in range(3):  # 반복' 도 콜론으로 끝난다.
  const body = line.text.replace(/#.*$/, '').trimEnd();
  const deeper = body.endsWith(':') ? '    ' : '';
  view.dispatch(state.replaceSelection('\n' + indent + deeper), {
    scrollIntoView: true,
    userEvent: 'input',
  });
  return true;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.parent
 * @param {string} options.doc 초기 코드
 * @param {(code: string) => void} options.onChange 편집이 일어날 때마다
 * @param {(info: {chars: number, preview: string}) => void} options.onPaste 붙여넣기 감지
 */
export function createEditor({ parent, doc = '', onChange, onPaste }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        python(),
        // 레슨 코드는 4칸으로 들여쓴다. 이 값을 안 맞추면 CodeMirror가 파일이
        // 아니라 자기 기본값(2칸)으로 다시 계산해서, for 문 안에서 Enter를
        // 누른 학생이 8칸 자리에 6칸으로 내려앉는다 — 그대로 실행하면
        // IndentationError다. 학생 잘못처럼 보이지만 편집기 설정 문제였다.
        indentUnit.of('    '),
        // Tab으로 들여쓰고 Shift+Tab으로 내어쓴다. CodeMirror는 기본으로
        // Tab을 포커스 이동에 쓰기 때문에 직접 걸어 줘야 한다.
        keymap.of([indentWithTab]),
        Prec.high(keymap.of([{ key: 'Enter', run: newlineKeepIndent }])),
        errorLineField,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) onChange(update.state.doc.toString());
        }),
        // Tab을 편집기가 가져갔으므로 빠져나갈 길을 열어 둔다. Esc를 누르면
        // 포커스가 풀려서 Tab으로 다음 버튼(실행하기)으로 갈 수 있다.
        keymap.of([{ key: 'Escape', run: (view) => { view.contentDOM.blur(); return true; } }]),
        EditorView.domEventHandlers({
          paste(event) {
            if (!onPaste) return false;
            const text = event.clipboardData?.getData('text') ?? '';
            if (text) onPaste({ chars: text.length, preview: text.slice(0, 500) });
            return false; // 붙여넣기 자체는 막지 않는다. 기록만 한다.
          },
        }),
      ],
    }),
  });

  return {
    view,
    getCode: () => view.state.doc.toString(),
    setCode(code) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
      });
    },
    markError(lineNumber) {
      view.dispatch({ effects: setErrorLine.of(lineNumber ?? null) });
    },
    focus: () => view.focus(),
  };
}
