import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';

/**
 * VITE_ 로 시작하는 값은 빌드된 자바스크립트에 그대로 박혀 누구나 볼 수 있다.
 * 그 자리에 service_role 키가 들어간 적이 있다 — 배포된 번들에 실려 공개
 * URL에 올라갔고, 앞 글자 하나가 빠져 401이 나는 바람에 우연히 발견했다.
 * 그 키는 RLS를 통째로 우회하므로 반 전체 기록을 읽고 지울 수 있다.
 *
 * 사람이 헷갈릴 수 있는 자리이므로 빌드가 대신 확인한다. 값이 없는 경우는
 * 막지 않는다 — 키 없이 빌드하면 로깅만 꺼지고 수업은 돌아가야 한다.
 */
function forbidSecretKeys() {
  return {
    name: 'makequbit-forbid-secret-keys',
    config(_config, { mode }) {
      const env = loadEnv(mode, process.cwd(), 'VITE_');
      for (const [name, value] of Object.entries(env)) {
        if (!value) continue;
        const role = jwtRole(value);
        const bad = value.startsWith('sb_secret_') || role === 'service_role';
        if (bad) {
          throw new Error(
            `${name}에 비밀 키가 들어 있습니다 (${role || 'sb_secret_'}). ` +
            'VITE_ 로 시작하는 값은 브라우저에 그대로 공개됩니다. ' +
            'anon 키나 sb_publishable_ 키를 넣으세요.'
          );
        }
      }
    },
  };
}

/** JWT라면 role 클레임을, 아니면 null. */
function jwtRole(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json).role ?? null;
  } catch {
    return null;
  }
}

export default defineConfig({
  plugins: [forbidSecretKeys()],
  // 포트를 고정한다. 기본 동작은 5173이 막혀 있으면 조용히 5174로 옮겨가는데,
  // 수업 중에 주소가 바뀌면 학생 20명이 동시에 못 들어온다. 막혀 있으면
  // 옮겨가지 말고 실패시켜서 무엇이 물고 있는지 바로 알게 한다.
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        lessons: resolve(__dirname, 'lessons.html'),
        lesson: resolve(__dirname, 'lesson.html'),
        quiz: resolve(__dirname, 'quiz.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
});
