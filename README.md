# 서면 YBM 사물함 관리 시스템

서면 YBM 어학원 직원용 사물함 대여 관리 웹앱.
정적 HTML + [Supabase](https://supabase.com) (DB · 인증 · 실시간 동기화) 구성이며 별도 빌드가 필요 없습니다.

- 각 층 사물함 재고를 한눈에 파악
- 어느 칸을 누가 언제부터 대여 중인지 확인
- 보증금 수령/환급 추적
- 갱신 마감(매월 마지막 주 금요일) 관리 + 미확인 목록 대시보드
- 여러 PC에서 같은 데이터 공유(실시간 반영) + 직원 로그인

---

## 1. Supabase 설정

### 1-1. 프로젝트 준비
이미 보유한 Supabase 프로젝트의 **Project URL**과 **anon public key**를
`Settings → API` 에서 확인합니다. (anon key는 클라이언트 노출이 전제된 공개 키이며,
실제 보호는 아래 RLS 정책으로 이루어집니다.)

### 1-2. 스키마 & 시드 실행
Supabase 대시보드 `SQL Editor`에서 **순서대로** 실행합니다.

1. `supabase/schema.sql` — 테이블 · 인덱스 · RLS 정책 생성
2. `supabase/seed.sql` — 사물함 127칸(1·2·3·7층) 데이터 입력

> 시드를 다시 실행해도 중복되지 않도록 `on conflict (floor, number) do nothing` 처리되어 있습니다.

### 1-3. 실시간(Realtime) 활성화
`Database → Replication` (또는 `Realtime`) 에서 `rentals` 테이블의 실시간 전송을 켭니다.
스키마 실행 시 `alter publication supabase_realtime add table rentals;` 가 포함되어 있어
대부분 자동 적용됩니다.

### 1-4. 직원 로그인 계정 생성
로그인은 **Supabase Auth(이메일/비밀번호)** 입니다.
`Authentication → Users → Add user` 에서 직원 계정을 만듭니다.
(이메일 확인 절차가 부담되면 `Add user` 시 *Auto Confirm User* 를 체크하세요.)

회원가입 화면은 제공하지 않습니다 — 계정은 관리자가 대시보드에서만 생성합니다.

---

## 2. 앱 설정

`config.js` 파일을 열어 발급받은 값으로 채웁니다.

```js
window.SUPABASE_URL = "https://xxxxxxxx.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOi...";  // anon public key
```

값을 채우지 않으면 앱은 “설정이 필요합니다” 안내 화면을 표시합니다.

---

## 3. 로컬 실행

빌드가 없으므로 정적 서버로 바로 엽니다.

```bash
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

(`file://` 직접 열기는 일부 브라우저에서 모듈/네트워크 제약이 있어 권장하지 않습니다.)

---

## 4. 배포 (무료)

### Vercel (권장)
1. 이 저장소를 GitHub에 푸시
2. [vercel.com](https://vercel.com) → New Project → 저장소 선택
3. Framework Preset: **Other**, 빌드 명령 없음(정적). `vercel.json`이 설정을 담당.
4. 배포되면 `프로젝트이름.vercel.app` 무료 주소가 생성됩니다.

CLI로도 가능: `npm i -g vercel && vercel`

### Netlify (대안)
- [netlify.com](https://app.netlify.com) → Add new site → 저장소 연결,
  빌드 명령 비움 / publish 디렉터리 `.` (루트). 또는 폴더 드래그-드롭 배포.

### 배포 후 Supabase 설정
`Authentication → URL Configuration` 에서 **Site URL** 에 배포 주소
(`https://....vercel.app`)를 추가합니다.

---

## 5. 비즈니스 규칙 요약

| 상태 | 의미 | 색 |
|---|---|---|
| free | 사용 가능(빈 칸) | 초록 `#3ba776` |
| rent | 사용 중(이번 달 갱신 확인됨) | 파랑 `#3b6fd4` |
| due | 갱신 임박(마감 7일 이내·미확인) | 노랑 `#e0a100` |
| over | 연체(마감 경과·미확인) | 빨강 `#d7503a` |

- 보증금: 대여 시작 시 1만원 수령, 반납 시 1만원 환급.
- 갱신 마감: 매월 **마지막 주 금요일** (자동 계산).
- 상태는 DB에 저장하지 않고 `started_on` + `confirmed_month` + 마지막 금요일로 **조회 시 계산**.

---

## 6. 파일 구조

```
index.html      메인 화면 (로그인 게이트 + 사물함 벽)
styles.css      디자인 시스템 (관제판 톤, 상태색)
app.js          로직: 인증 · 렌더링 · 상태계산 · DB CRUD · Realtime
config.js       Supabase URL / anon key (직접 입력)
supabase/
  schema.sql    테이블 · 인덱스 · RLS
  seed.sql      사물함 127칸 시드
vercel.json     정적 배포 설정
```
