# Impactly

> PR을 올리면 **바뀐 내용, 영향받는 파일, 고치면 좋을 점**을 쉬운 한국어 댓글로 알려주는 도구

Pull Request를 merge하기 전에 "이 변경 때문에 다른 화면이나 기능이 깨지지 않을까?"를 확인하는 일은 생각보다 어렵습니다.
특히 프로젝트에 익숙하지 않은 개발자는 수정한 파일을 **누가 가져다 쓰고 있는지** 파악하기 힘듭니다.

Impactly는 PR을 자동으로 살펴보고 PR에 **댓글**을 남깁니다.

1. **한눈에 보기**: 바뀐 파일 수, 영향을 받을 수 있는 파일 수, 리뷰 제안 수
2. **💡 리뷰 제안**: "삭제한 파일을 아직 불러오고 있어요", "`console.log`가 남아 있어요"처럼 문제와 **고치는 방법**
3. **🎯 영향을 받을 수 있는 파일**: 바뀐 코드를 가져다 쓰는 파일과 그 연결 경로
4. **📂 바뀐 파일 목록**과 **이번 점검에서 한 일**: 하지 않은 검사는 "아직 지원하지 않아요"로 솔직하게 표시

새 커밋을 올리면 댓글을 새로 달지 않고 **같은 댓글을 최신 결과로 고쳐 씁니다.**

<details><summary>댓글 예시 보기</summary>

```markdown
## 🔍 Impactly PR 점검 결과
> 이 PR에서 바뀐 내용을 자동으로 살펴본 결과예요. 자동 분석이라 틀릴 수 있으니, 사람이 한 번 더 확인해 주세요.

### 한눈에 보기
- 바뀐 파일: **3개** (추가 42줄, 삭제 10줄)
- 영향을 받을 수 있는 파일: **5개** (확실 2개 · 가능성 3개)
- 리뷰 제안: **2건** (꼭 확인 1건 · 고쳐 보면 좋아요 1건 · 참고 0건)

### 💡 리뷰 제안
**🔴 꼭 확인해 주세요**
1. `src/App.tsx` 파일이 삭제되었거나 이름이 바뀐 `src/old.ts` 파일을 아직 불러오고 있어요. 이대로 합치면 빌드가 실패하거나 화면이 깨질 수 있어요.
   👉 불러오는 경로를 새 파일 위치로 고치거나, 더 이상 쓰지 않는다면 그 import 줄을 지워 주세요.

**🟡 고쳐 보면 좋아요**
2. `src/Button.tsx` 파일 12번째 줄에 `console.log` 같은 출력 코드가 추가됐어요. …
   👉 확인용으로 넣은 코드라면 지워 주세요. …
```

</details>

---

## 📌 현재 개발 상태

> ⚠️ **아직 다른 저장소에 설치해서 쓰는 GitHub Action(Marketplace)으로는 배포되지 않았습니다.** 지금은 **이 저장소의 PR에 댓글이 달리고**, 다른 프로젝트는 **명령줄(CLI)로 로컬에서** 분석할 수 있습니다.

| 기능 | 상태 |
|---|---|
| 바뀐 파일 / 바뀐 줄 분석 (Git diff) | ✅ 사용 가능 |
| import 관계를 따라가는 영향 범위 분석 (이름 단위) | ✅ 사용 가능 |
| 규칙 기반 리뷰 제안 (아래 표, 무료·외부 서비스 없음) | ✅ 사용 가능 |
| 쉬운 한국어 PR 댓글 (이 저장소) | ✅ 사용 가능 |
| 다른 저장소에서 쓰는 GitHub Action으로 배포 (규칙 기반 리뷰로 제공) | 🚧 개발 예정 |
| 관련 테스트 실행 · JavaScript 번들 크기 비교 | 🚧 개발 예정 |
| Lighthouse 성능 지표 비교 | 🗓️ 이후 단계 |
| AI 리뷰 제안 (본인 API 키를 등록했을 때만 동작하는 선택 기능) | 🗓️ 추후 개발 |

Marketplace 첫 배포는 **규칙 기반 리뷰만으로** 제공합니다. API 키나 사용료 없이 누구나 쓸 수 있게 하기 위해서이고, AI 리뷰는 추후 선택 기능으로 개발합니다.

**실행하지 않은 검사를 "성공"으로 표시하지 않습니다.** 아직 없는 기능은 댓글에 "⏸️ 아직 지원하지 않아요"로 나옵니다.

---

## 💡 리뷰 제안 규칙

모든 제안은 PR의 실제 내용(바뀐 줄, import 관계)에서 확인된 사실에만 근거합니다.

| 중요도 | 언제 나오나요 | 고치는 방법 (댓글에 함께 표시) |
|---|---|---|
| 🔴 꼭 확인 | 삭제되었거나 이름이 바뀐 파일을 다른 파일이 아직 불러옴 | 경로를 새 파일로 고치거나 import 삭제 |
| 🔴 꼭 확인 | 바뀐 파일이 불러오는 경로에 해당하는 파일이 없음 (오타 등) | 경로·파일 이름(대소문자) 확인 |
| 🔴 꼭 확인 | `debugger`가 추가됨 | 합치기 전에 삭제 |
| 🟡 고쳐 보면 좋아요 | `console.log`·`console.debug` 등이 추가됨 (테스트 파일 제외) | 확인용이면 삭제, 남길 거면 이유를 주석으로 |
| 🟡 고쳐 보면 좋아요 | TypeScript에서 `any` 타입이 추가됨 | 실제 타입이나 `unknown` 사용 |
| 🟡 고쳐 보면 좋아요 | 한 PR에서 파일 30개 또는 800줄 넘게 바뀜 (lock 파일 제외) | 기능별로 PR 나누기 |
| 🟡 고쳐 보면 좋아요 | 코드가 바뀌었는데 연결된 테스트를 찾지 못함 | 테스트 추가 고려 |
| 🔵 참고 | `TODO`·`FIXME` 주석이 추가됨 | 이번에 할 일인지, 이슈로 남겼는지 확인 |
| 🔵 참고 | `package.json`, `tsconfig.json`, `*.config.js` 같은 설정 파일이 바뀜 | 설치·빌드·실행 확인, lock 파일도 바뀌었는지 확인 |
| 🔵 참고 | 바뀐 코드를 쓰는 테스트 파일이 있음 | 합치기 전에 그 테스트 실행 (Impactly가 직접 실행하지는 않음) |

---

## 🎯 프로젝트 목적

- **주니어 개발자의 PR 셀프 점검**: merge 전에 내 변경이 어디까지 퍼지는지, 무엇을 고치면 좋을지 확인
- **리뷰어의 부담 감소**: "이 파일 고치면 어디가 영향받아요?"를 사람이 일일이 찾지 않도록
- **무료 · 서버 없음**: GitHub가 제공하는 무료 러너에서 동작 (별도 서버·계정 불필요)
- **fork PR 지원**: 개인 저장소(fork)에서 organization 저장소로 올리는 PR에서도 안전하게 동작
- **근거 중심**: 모든 결과에 "왜 그렇게 판단했는지"와 "확실한 정도"를 함께 표시

---

## 💬 PR 댓글이 달리는 방식 (이 저장소)

```text
PR 올림 / 새 커밋 push
   │
   ▼
① CI의 "Impactly report" 작업 (.github/workflows/ci.yml)
   - 읽기 전용 권한, 비밀값 없음 → fork PR에서도 안전
   - PR을 분석해서 report.json을 만들고 결과물(artifact)로 올림
   │
   ▼
② "Impactly comment" 워크플로 (.github/workflows/impactly-comment.yml)
   - main 브랜치의 코드로 실행 (PR 코드는 실행하지 않음)
   - report.json을 엄격하게 검사하고, PR의 최신 커밋이 분석한 커밋과 같은지 확인
   - 한국어 댓글을 직접 만들어 PR에 달거나, 이전 댓글을 고쳐 씀
```

두 단계로 나눈 이유: fork에서 온 PR의 검사는 GitHub가 **읽기 전용**으로 실행하기 때문에 댓글을 달 수 없습니다. 그래서 댓글은 신뢰할 수 있는 `main` 브랜치 코드가 따로 답니다. PR 쪽에서 만든 결과는 조작될 수 있다고 보고 **파일 경로 같은 값만 가져다 쓰며, 댓글 문장은 직접 만듭니다.**

> `workflow_run` 워크플로는 GitHub 규칙상 **`main`에 merge된 뒤부터** 동작합니다.

---

## 🚀 로컬에서 실행하기 (CLI)

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
# PR 댓글과 같은 한국어 결과 보기 (추천)
node <impactly 경로>/dist/entry/cli.js --base <기준 SHA> --head <PR SHA> --cwd <분석할 프로젝트 경로> --markdown

# 다른 도구에서 쓰기 좋은 JSON으로 보기 (기본값)
node <impactly 경로>/dist/entry/cli.js --base <기준 SHA> --head <PR SHA> --cwd <분석할 프로젝트 경로> > report.json
```

### 옵션

| 옵션 | 설명 | 기본값 |
|---|---|---|
| `--base <sha>` | 기준(비교 대상) 커밋 SHA | **필수** |
| `--head <sha>` | PR(변경된) 커밋 SHA | **필수** |
| `--cwd <폴더>` | 분석할 Git 저장소 경로 | 현재 폴더 |
| `--markdown` | PR 댓글과 같은 한국어 Markdown으로 출력 | 꺼짐 |
| `--text` | 개발자용 짧은 영어 요약으로 출력 | 꺼짐 |
| `--mode <방식>` | `merge-base`: PR 화면과 같은 방식(공통 조상과 비교) / `direct`: 두 커밋을 그대로 비교 | `merge-base` |
| `--max-depth <n>` | import 관계를 몇 단계까지 따라갈지 | `5` |
| `--max-files <n>` | 보고할 최대 변경 파일 수 | `3000` |
| `-h`, `--help` | 도움말 | |

**종료 코드:** `0` 정상 · `1` 분석 중 일부 단계 실패 · `2` 잘못된 입력(옵션 오류, Git 저장소가 아님 등)

---

## 📖 영향 범위는 어떻게 판단하나요?

| 댓글 표시 | 의미 |
|---|---|
| **확실히 영향을 받아요** | 바뀐 파일에 있는 코드를 **직접** 가져다 쓰는 파일 (모음 파일 `index.ts`를 거쳐도 직접 사용으로 봄) |
| **영향을 받을 수도 있어요** | 다른 파일을 **여러 단계 거쳐** 연결된 파일. 실제로 영향이 있는지는 확인이 필요 |
| **자동으로 판단하기 어려워요** | 설정 파일 변경, 실행 중에 경로를 만들어 불러오는 코드(동적 import), 어디서 쓰는지 모르는 데이터 파일 등 |

영향 범위는 **이름 단위**로 따라갑니다.
- 모음 파일(배럴 파일)에서 `{ Modal }`만 가져온 파일은 `Modal`을 정의한 파일이 바뀔 때만 영향을 받습니다. 같은 모음 파일의 `Button`이 바뀌어도 영향을 받지 않습니다.
- 영향받은 파일 안에서도, 바뀐 코드를 실제로 쓰는 export만 다음 단계로 전달합니다.
- 이름을 정확히 따라갈 수 없을 때는 놓치지 않도록 넓게 잡습니다. `import * as X`, CommonJS, 더 이상 export되지 않는 이름이 그런 경우입니다.

<details><summary>JSON 결과의 영어 값 (개발자용)</summary>

- `certainty`: `confirmed`(확실) · `possible`(가능성) · `unknown`(판단 어려움)
- `reason`: `changed`(바뀐 파일) · `imports-changed`(바뀐 코드를 사용) · `imports-deleted`(삭제된 파일을 아직 불러옴) · `transitive`(여러 단계 거쳐 연결) · `re-exports`(모음 파일) · `dynamic-import`(동적 import) · `config-change`(설정 변경) · `non-code-change`(코드 외 파일)
- `status`: `ok`(완료) · `truncated`(일부만 분석) · `skipped`(실행 안 함) · `unsupported`(지원 안 함) · `failed`(실패)
- `review.findings[].rule`: 위 "리뷰 제안 규칙" 표의 각 항목 (`deleted-still-imported`, `unresolved-import`, `debugger`, `console-log`, `any-type`, `large-pr`, `no-tests`, `todo`, `config-change`, `tests-to-run`)

</details>

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
│   │   ├── parseModule.ts   # 파일의 import/export와, 각 export가 쓰는 import 추출
│   │   ├── symbols.ts       # 가져온 이름을 모음 파일을 거쳐 정의된 파일까지 추적
│   │   ├── resolve.ts       # './Button', '@/utils' 같은 경로를 실제 파일로 연결
│   │   ├── config.ts        # tsconfig.json / jsconfig.json의 경로 별칭 읽기
│   │   ├── classify.ts      # 변경 파일 분류 (코드 / 설정 / 기타)
│   │   ├── graph.ts         # "누가 누구를 쓰는지" 그래프 탐색
│   │   └── analyze.ts       # 위 단계를 묶어 영향 범위 분석 실행
│   ├── review/        # 규칙 기반 리뷰 제안
│   │   ├── rules.ts         # 제안 규칙 (추가된 줄, import 관계, PR 크기 등)
│   │   ├── severity.ts      # 규칙별 중요도
│   │   └── review.ts        # PR에서 추가된 줄을 읽어 규칙 적용
│   ├── report/
│   │   └── markdown.ts    # 결과 → 쉬운 한국어 PR 댓글
│   ├── github/        # GitHub API (이 폴더에서만 호출)
│   │   ├── validate.ts      # PR 쪽에서 온 결과를 엄격하게 검사
│   │   └── comment.ts       # PR 댓글 작성·수정
│   └── entry/
│       ├── run.ts         # 전체 분석 실행 → 리포트 생성
│       ├── cli.ts         # 명령줄 실행 진입점
│       └── comment.ts     # 댓글 게시 진입점 (워크플로에서 사용)
├── test/              # 테스트 (실행 시 임시 Git 저장소를 만들어 검증)
├── .github/workflows/ # CI, 보안 검사, PR 댓글 워크플로
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
- 댓글에 들어가는 파일 경로 등은 모두 코드 표시(`` `경로` ``) 안에 넣어서, 파일 이름에 링크나 HTML, `@멘션`을 숨겨도 그대로 동작하지 않습니다.

## ⚠️ 알려진 한계

- 많은 파일이 쓰는 큰 컴포넌트(예: 앱 전체를 담은 `App.tsx`)를 거치면 "영향을 받을 수도 있어요" 목록이 여전히 길 수 있습니다. "확실히 영향을 받아요"부터 확인하세요.
- 리뷰 제안은 정해진 규칙만 확인합니다. 로직이 맞는지, 더 나은 구조가 있는지는 판단하지 못합니다. (추후 개발할 AI 리뷰에서 다룰 예정)
- 파일 안의 의존 관계는 이름으로만 비교합니다. 같은 이름의 지역 변수가 있으면 실제보다 넓게 잡힐 수 있지만, 좁게 잡히지는 않습니다.
- 모듈을 불러오기만 해도 실행되는 코드(부수 효과)는 모음 파일을 거치면 따라가지 않습니다.
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

### 이 저장소의 PR 검사

| 검사 | 실행 시점 | merge 차단 |
|---|---|---|
| **CI** (`.github/workflows/ci.yml`): 타입 검사, lint, 테스트, 빌드 + Impactly 분석 | PR·`main` push마다 자동 | ❌ 결과만 표시 |
| **Impactly 댓글** (`.github/workflows/impactly-comment.yml`): 분석 결과를 PR 댓글로 게시 | CI가 끝난 뒤 자동 | ❌ 댓글만 작성 |
| **보안 검사** (`.github/workflows/security.yml`, 상태 이름 `security-gate`) | PR마다 자동 | ✅ 실패하면 merge 불가 |

보안 검사가 막는 경우:
- `.env`, `.env.*` 파일이 커밋됨 (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`는 허용)
- `.gitignore`가 `.env`, `.env.local`을 제외하지 않음
- API 키·토큰·개인 키 등 비밀값이 PR의 **어느 커밋에든** 들어 있음 ([gitleaks](https://github.com/gitleaks/gitleaks) 기본 규칙. 나중 커밋에서 지웠어도 기록에 남으므로 차단)
- 키스토어 파일(`id_rsa`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`)이 커밋됨

보안 검사는 **`main` 브랜치에 있는** 워크플로·스크립트·`.gitleaks.toml`로 실행되므로, PR에서 이 파일들을 고쳐도 그 PR의 검사에는 적용되지 않습니다(merge 후부터 적용). 오탐이라면 `main`의 `.gitleaks.toml`에 허용 규칙을 추가하세요. 코드 주석 `gitleaks:allow`로는 우회할 수 없습니다.
