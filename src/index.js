import './style.css';
import { lessons } from './lib/curriculum.js';
import { enterWithCode, getParticipant } from './lib/session.js';
import { logEvent, flush } from './lib/logger.js';

const form = document.getElementById('enter-form');
const input = document.getElementById('participant-code');
const button = document.getElementById('enter-button');
const errorEl = document.getElementById('enter-error');

function renderCurriculum() {
  const list = document.getElementById('curriculum');
  let lastKey = null;

  for (const lesson of lessons) {
    const key = `${lesson.week}-${lesson.session}`;
    if (key !== lastKey) {
      lastKey = key;
      const header = document.createElement('li');
      header.className = 'pt-3 first:pt-0 text-xs font-bold text-primary';
      header.textContent = `${lesson.week}주차 ${lesson.session}차시`;
      list.appendChild(header);
    }
    const item = document.createElement('li');
    item.className = 'flex items-baseline gap-2.5 text-sm';
    item.innerHTML = `
      <span class="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0 translate-y-[-2px]"></span>
      <span class="font-medium"></span>
      <span class="text-slate-500 text-xs"></span>`;
    item.children[1].textContent = lesson.title;
    item.children[2].textContent = lesson.subtitle;
    list.appendChild(item);
  }
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
  input.classList.add('shake');
  setTimeout(() => input.classList.remove('shake'), 320);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.classList.add('hidden');
  button.disabled = true;

  try {
    await enterWithCode(input.value);
    logEvent('session_start', {
      user_agent: navigator.userAgent,
      screen: `${window.screen.width}x${window.screen.height}`,
    });
    await flush();
    window.location.href = '/lessons.html';
  } catch (error) {
    showError(error.message);
    button.disabled = false;
  }
});

renderCurriculum();

// 이미 입장한 적이 있으면 코드를 채워 둔다 — 수업 중 새로고침이 잦다
const existing = getParticipant();
if (existing) input.value = existing.code;

document.body.classList.add('ready');
input.focus();
