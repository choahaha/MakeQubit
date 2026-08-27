const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export async function runCode({ code, participantId, lessonId }) {
  const response = await fetch(`${API_URL}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      participant_id: participantId || 'anonymous',
      lesson_id: lessonId || '',
    }),
  });

  if (!response.ok) {
    let message = `실행 서버 오류 (${response.status})`;
    try {
      const body = await response.json();
      if (body.detail) message = body.detail;
    } catch { /* 본문이 JSON이 아니면 기본 메시지를 쓴다 */ }
    return {
      status: 'error',
      stdout: '',
      counts: null,
      circuit_text: null,
      execution_time_ms: null,
      error: { type: 'ServerError', message, line: null, source_line: null },
    };
  }
  return response.json();
}

export async function fetchLimits() {
  try {
    const response = await fetch(`${API_URL}/api/limits`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
