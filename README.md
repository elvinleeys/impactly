# Impactly

> PR이 **어떤 파일에 영향을 주는지** 자동으로 찾아주는 도구

Pull Request를 merge하기 전에 "이 변경 때문에 다른 화면이나 기능이 깨지지 않을까?"를 확인하는 일은 생각보다 어렵습니다.
특히 프로젝트에 익숙하지 않은 개발자는 수정한 파일을 **누가 가져다 쓰고 있는지** 파악하기 힘듭니다.

Impactly는 두 커밋(기준 브랜치와 PR)을 비교해서

1. **무엇이 바뀌었는지** — 추가·수정·삭제·이름 변경된 파일과 변경된 줄
2. **무엇이 영향을 받을 수 있는지** — 바뀐 파일을 `import` 하고 있는 파일들

을 찾아 **근거(어떤 import 경로로 연결되는지)** 와 함께 알려줍니다.

---

## 📌 현재 개발 상태

> ⚠️ **아직 GitHub Action으로 설치해서 쓸 수는 없습니다.** 지금은 **명령줄(CLI)로 로컬에서 실행**할 수 있습니다.

| 기능 | 상태 |
|---|---|
| 변경 파일 / 변경 줄 분석 (Git diff) | ✅ 사용 가능 |
| import 관계를 따라가는 영향 범위 분석 | ✅ 사용 가능 |
| 관련 테스트 찾기·추천 | 🚧 개발 예정 |
| JavaScript 번들 크기 비교 | 🚧 개발 예정 |
| Markdown 리포트 생성 + PR 코멘트 게시 (GitHub Action) | 🚧 개발 예정 |
| AI 요약 (본인 API 키를 넣을 때만 동작하는 선택 기능) | 🚧 개발 예정 |
| Lighthouse 성능 지표 비교 | 🗓️ 이후 단계 |

아직 구현되지 않은 항목은 결과에서 항상 `skipped`(건너뜀)로 표시됩니다. **실행하지 않은 검사를 "성공"으로 표시하지 않습니다.**

---

## 🎯 프로젝트 목적

- **주니어 개발자의 PR 셀프 점검** — merge 전에 내 변경이 어디까지 퍼지는지 확인
- **리뷰어의 부담 감소** — "이 파일 고치면 어디가 영향받아요?"를 사람이 일일이 찾지 않도록
- **무료 · 서버 없음** — GitHub가 제공하는 무료 러너에서 동작하도록 설계 (별도 서버·계정 불필요)
- **fork PR 지원** — 개인 저장소(fork)에서 organization 저장소로 올리는 PR에서도 안전하게 동작하도록 설계
- **근거 중심** — 모든 결과에 "왜 그렇게 판단했는지"와 "확실한 정도"를 함께 표시

---

## 🚀 사용 방법

### 1. 준비물

- [Node.js](https://nodejs.org/) **24 이상**
- [Git](https://git-scm.com/)

### 2. 설치 및 빌드

```bash
git clone <이 저장소 주소> impactly
cd impactly
npm install
npm run build
```

### 3. 분석할 두 커밋의 SHA 확인

분석하려는 프로젝트 폴더에서 비교할 두 커밋의 SHA(커밋 ID)를 확인합니다.

```bash
cd 분석할-프로젝트

git rev-parse main          # 기준 브랜치의 SHA  → --base 에 사용
git rev-parse my-feature    # PR(작업) 브랜치의 SHA → --head 에 사용
```

> 💡 `--base`, `--head`에는 **SHA만** 넣을 수 있습니다. `main`, `HEAD~1` 같은 이름은 보안상 받지 않으니 위처럼 `git rev-parse`로 SHA를 먼저 구해주세요.

### 4. 실행

```bash
# 읽기 쉬운 텍스트로 보기
node <impactly 경로>/dist/entry/cli.js --base <기준 SHA> --head <PR SHA> --cwd <분석할 프로젝트 경로> --text

# 다른 도구에서 쓰기 좋은 JSON으로 보기 (기본값)
node <impactly 경로>/dist/entry/cli.js --base <기준 SHA> --head <PR SHA> --cwd <분석할 프로젝트 경로> > report.json
```

### 실행 예시

`src/theme.ts` 를 수정했고, `Button.tsx` 가 `theme.ts` 를, `App.tsx` 가 `Button.tsx` 를 import 하는 프로젝트의 결과입니다.

```text
diff: ok
  modified     src/theme.ts (+1 -1)
impact: ok
  [confirmed] src/theme.ts — changed, via src/theme.ts
  [confirmed] src/Button.tsx — imports-changed, via src/Button.tsx -> src/theme.ts
  [possible] src/App.tsx — transitive, via src/App.tsx -> src/Button.tsx -> src/theme.ts
  · git: Diff taken from merge-base af0db9a1a400 to head 0a84eb3fff99
  · config: No root tsconfig.json or jsconfig.json; path aliases are not resolved
tests: skipped (Test discovery is not implemented yet)
bundle: skipped (Bundle comparison is not implemented yet)
```

### 옵션

| 옵션 | 설명 | 기본값 |
|---|---|---|
| `--base <sha>` | 기준(비교 대상) 커밋 SHA | **필수** |
| `--head <sha>` | PR(변경된) 커밋 SHA | **필수** |
| `--cwd <폴더>` | 분석할 Git 저장소 경로 | 현재 폴더 |
| `--text` | JSON 대신 사람이 읽기 쉬운 텍스트로 출력 | 꺼짐 |
| `--mode <방식>` | `merge-base`: PR 화면과 같은 방식(공통 조상과 비교) / `direct`: 두 커밋을 그대로 비교 | `merge-base` |
| `--max-depth <n>` | import 관계를 몇 단계까지 따라갈지 | `5` |
| `--max-files <n>` | 보고할 최대 변경 파일 수 | `3000` |
| `-h`, `--help` | 도움말 | |

**종료 코드:** `0` 정상 · `1` 분석 중 일부 단계 실패 · `2` 잘못된 입력(옵션 오류, Git 저장소가 아님 등)

---

## 📖 결과 읽는 법

### 확실한 정도 (`certainty`)

| 표시 | 의미 | 예시 |
|---|---|---|
| `confirmed` (확정) | 바뀐 파일 자체이거나, 바뀐 파일을 **직접 import** 하는 파일 | `Button.tsx`가 `theme.ts`를 import |
| `possible` (가능성) | 바뀐 파일을 **간접적으로** 사용하는 파일 (2단계 이상). 실제로 영향이 있는지는 확인 필요 | `App.tsx` → `Button.tsx` → `theme.ts` |
| `unknown` (미확인) | 코드 분석만으로는 영향 범위를 알 수 없음 | `package.json`·설정 파일 변경, 변수로 경로를 만드는 동적 import |

### 판단 이유 (`reason`)

| 값 | 의미 |
|---|---|
| `changed` | 이번 PR에서 바뀐 파일 |
| `imports-changed` | 바뀐 파일을 직접 import 함 |
| `imports-deleted` | **삭제되었거나 이름이 바뀐 파일을 아직 import 함 → 깨질 가능성이 높음** |
| `transitive` | 다른 파일을 거쳐 간접적으로 연결됨 |
| `dynamic-import` | `import(\`./locales/${lang}\`)`처럼 동적으로 불러오는 경로에 바뀐 파일이 포함될 수 있음 |
| `config-change` | `package.json`, `tsconfig.json`, `*.config.js`, `.env` 등 프로젝트 전체에 영향을 주는 설정 변경 |
| `non-code-change` | 아무도 import 하지 않는 코드 외 파일(문서, 이미지 등) 변경 |

`via`는 연결 경로입니다. `src/App.tsx -> src/Button.tsx -> src/theme.ts`는 "App이 Button을, Button이 theme을 import 한다"는 뜻입니다.

### 단계별 상태 (`status`)

| 값 | 의미 |
|---|---|
| `ok` | 정상 완료 |
| `truncated` | 제한(파일 수, 탐색 깊이 등)에 걸려 **일부만** 분석함 — `reason`에 이유가 적혀 있음 |
| `skipped` | 실행하지 않음 (아직 미구현 등) |
| `failed` | 실패 — `reason`에 이유가 적혀 있음 |

---

## 🗂️ 디렉토리 구조

```text
impactly/
├── src/
│   ├── core/          # 공통 타입, 리소스 제한값, 경로 안전 처리
│   ├── git/           # Git 명령 실행과 diff 결과 해석
│   │   ├── runner.ts      # git을 안전하게 실행 (셸 미사용, SHA 검증)
│   │   ├── parse.ts       # git 출력 → 변경 파일/변경 줄 정보
│   │   ├── collect.ts     # 두 커밋 사이의 변경 내용 수집
│   │   └── tree.ts        # 커밋 안의 파일 목록 읽기
│   ├── impact/        # import 관계를 따라 영향 범위 계산
│   │   ├── parseImports.ts  # 파일에서 import/export 구문 추출
│   │   ├── resolve.ts       # './Button', '@/utils' 같은 경로를 실제 파일로 연결
│   │   ├── config.ts        # tsconfig.json / jsconfig.json의 경로 별칭 읽기
│   │   ├── classify.ts      # 변경 파일 분류 (코드 / 설정 / 기타)
│   │   ├── graph.ts         # "누가 누구를 import 하는지" 그래프 탐색
│   │   └── analyze.ts       # 위 단계를 묶어 영향 범위 분석 실행
│   └── entry/
│       ├── run.ts         # 전체 분석 실행 → 리포트 생성
│       └── cli.ts         # 명령줄 실행 진입점
├── test/              # 테스트 (실행 시 임시 Git 저장소를 만들어 검증)
├── dist/              # 빌드 결과물 (npm run build 시 생성)
├── CLAUDE.md          # AI 코딩 도우미용 개발 가이드
└── package.json
```

---

## 🔒 안전성

- 분석 대상 프로젝트의 코드를 **실행하지 않습니다.** Git에 저장된 파일 내용만 읽습니다.
- 입력받은 SHA는 형식을 검사하고, Git은 셸을 거치지 않고 실행합니다.
- 저장소 밖을 가리키는 경로(`../`, 절대 경로, 심볼릭 링크)는 따라가지 않습니다.
- 파일 수, diff 크기, 파일 크기, 전체 읽기 용량, 탐색 깊이에 제한을 두어 큰 저장소에서도 자원을 과도하게 쓰지 않습니다.

## ⚠️ 알려진 한계

- **배럴 파일**(`index.ts`에서 모든 것을 다시 export 하는 파일)이 있으면 `possible` 결과가 매우 많아질 수 있습니다. 먼저 `confirmed` 항목부터 확인하는 것을 권장합니다.
- 모노레포에서는 루트의 `tsconfig.json`만 읽습니다 (패키지별 설정은 아직 미반영).
- `.vue`, `.svelte`, `.mdx` 파일 내부의 import는 아직 분석하지 않습니다.
- 타입만 가져오는 import(`import type`)도 일반 import와 동일하게 취급합니다.

---

## 🛠️ 개발자용

```bash
npm test                                  # 전체 테스트
npx vitest run test/impact/units.test.ts  # 특정 파일만
npx vitest run -t "rename"                # 이름에 rename이 들어간 테스트만
npm run typecheck                         # 타입 검사
npm run lint                              # 코드 스타일 검사
npm run build                             # dist/ 로 빌드
```

> `typescript`는 `6.0.3`으로 고정되어 있습니다. TypeScript 7에는 이 도구가 사용하는 컴파일러 API가 없으므로 임의로 올리지 마세요.
