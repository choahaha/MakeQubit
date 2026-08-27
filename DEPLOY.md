# 배포 전 체크리스트

프론트엔드는 Vercel(정적 빌드), 백엔드는 Railway(Dockerfile)를 전제로 한다.
EduQubit과 같은 구성이다.

## 1. 환경변수 — 여기가 가장 중요하다

### 프론트엔드 (Vercel → Settings → Environment Variables)

| 이름 | 값 |
|---|---|
| `VITE_SUPABASE_URL` | `https://igzzobxbnbngofpppaoj.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | anon 키 |
| `VITE_API_URL` | Railway 백엔드 URL (예: `https://makequbit-api.up.railway.app`) |

`VITE_*`는 **빌드 결과물에 그대로 박힌다.** 브라우저에서 누구나 읽을 수 있다.
anon 키는 그래도 되는 값이다 — RLS가 막아 준다. **service_role 키를 여기 넣으면
그 순간 DB 전체가 공개된다.**

### 백엔드 (Railway → Variables)

| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | 위와 같음 |
| `SUPABASE_SERVICE_KEY` | service_role 키 (Dashboard → Settings → API) |
| `ADMIN_TOKEN` | **service_role 키와 다른** 무작위 문자열 |
| `FRONTEND_URL` | Vercel 배포 URL (CORS 허용에 쓰인다) |
| `MAX_CONCURRENT_RUNS` | `4` (학생 20명이면 4~6) |

`ADMIN_TOKEN`은 이렇게 만든다:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(24))"
```

**`ADMIN_TOKEN`에 service_role 키를 넣지 말 것.** 그 값은 브라우저에 입력되고
sessionStorage에 남고 요청 헤더로 매번 오간다. 그게 DB 전체 권한이면
연구자 화면을 여는 것만으로 키가 새어 나간다.

## 2. CORS

`backend/app.py`가 허용하는 출처:

- `http://localhost:*` (개발)
- `*.railway.app`, `*.vercel.app`
- `FRONTEND_URL` 환경변수 값

**커스텀 도메인**(예: `makequbit.org`)을 쓰면 `FRONTEND_URL`에 넣어야 한다.
안 넣으면 브라우저가 API 요청을 막고, 학생 화면에서 "서버에 연결하지 못했어요"만 뜬다.

## 3. 배포 후 확인 (5분)

```bash
API=https://<백엔드-주소>

# 살아 있는가
curl -s $API/api/health

# 명부를 읽고 있는가 — roster_size가 0이면 SUPABASE_SERVICE_KEY가 잘못된 것
curl -s $API/api/limits

# 명부에 없는 코드는 막히는가 (403이어야 한다)
curl -s -X POST $API/api/run -H 'Content-Type: application/json' \
  -d '{"code":"print(1)","participant_id":"ZZZZ"}'

# 명부에 있는 코드는 도는가
curl -s -X POST $API/api/run -H 'Content-Type: application/json' \
  -d '{"code":"print(1)","participant_id":"Q00"}'

# 분석 뷰가 anon 키로 새지 않는가 (401이어야 한다)
curl -s -o /dev/null -w "%{http_code}\n" \
  "$SUPABASE_URL/rest/v1/v_paste_events?select=*" -H "apikey: $ANON_KEY"
```

브라우저에서:

1. 학생 화면 — `Q00`으로 입장 → 레슨 실행 → 결과가 나오는가
2. 연구자 화면 `/admin.html` — 토큰으로 열리는가, 그 실행이 격자에 보이는가
3. **개발자 도구 → Network → 아무 요청의 응답을 열어 `service_role`이 보이는지 확인.**
   보이면 즉시 배포를 내리고 환경변수를 고칠 것.

## 4. 수업 직전

- [ ] 테스트 데이터 삭제 — `Q00`, `T00`은 `is_test`라 분석 뷰에서 자동으로 빠진다.
      실제 명부 코드(Q01~Q20)로 테스트했다면 그 행은 지워야 한다.
- [ ] 참여자 코드 인쇄해서 섞어서 배부 (출석번호 순으로 주지 말 것 — 코드가 곧 학번이 된다)
- [ ] 학생용 URL을 짧게 안내할 방법 (칠판, QR)
- [ ] 백엔드가 콜드 스타트에서 깨어나는 데 몇 초 걸린다. 수업 시작 5분 전에
      한 번 눌러 두면 첫 학생이 기다리지 않는다.

## 5. 남아 있는 위험

**샌드박스는 Python 수준 방어다.** 컨테이너 안에서 돌지만 컨테이너 자체가
학생 코드마다 새로 뜨지는 않는다. 지금은 명부에 있는 코드로만 실행되므로
닫힌 환경에 가깝다. 명부 없이 누구나 접근하게 열 계획이 생기면 실행마다
컨테이너를 띄우는 구조로 바꿔야 한다.

**메모리 제한(`RLIMIT_AS`)은 Linux에서만 적용된다.** Railway는 Linux라 동작한다.
로컬 macOS에서는 안 걸리므로, 로컬 테스트로 메모리 제한을 확인했다고 믿으면 안 된다.

**관리자 화면은 공개 URL에 노출된다.** `/admin.html`은 누구나 열 수 있고
방어선은 `ADMIN_TOKEN` 하나다. 토큰을 짧게 만들지 말 것.
