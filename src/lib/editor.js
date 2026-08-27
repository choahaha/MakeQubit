import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
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
        errorLineField,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) onChange(update.state.doc.toString());
        }),
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
