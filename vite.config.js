import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
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
