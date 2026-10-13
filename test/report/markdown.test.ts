import { describe, expect, it } from 'vitest';
import type { ImpactCandidate, Report, ReviewFinding, ReviewRule } from '../../src/core/types.js';
import type { AiSection } from '../../src/ai/review.js';
import { code, COMMENT_MARKER, describeFinding, prose, renderMarkdown } from '../../src/report/markdown.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    base: SHA_A,
    head: SHA_B,
    diff: {
      status: 'ok',
      evidence: [],
      data: {
        base: SHA_A,
        head: SHA_B,
        diffBase: SHA_A,
        files: [
          { path: 'src/Button.tsx', change: 'modified', additions: 3, deletions: 1, binary: false, hunks: [] },
          { path: 'src/new.ts', oldPath: 'src/old.ts', change: 'renamed', additions: 0, deletions: 0, binary: false, hunks: [] },
          { path: 'logo.png', change: 'added', additions: null, deletions: null, binary: true, hunks: null },
          { path: 'README.md', change: 'modified', additions: 1, deletions: 0, binary: false, hunks: [] },
        ],
        totals: { files: 4, additions: 4, deletions: 1 },
      },
    },
    impact: {
      status: 'ok',
      evidence: [],
      data: {
        candidates: [
          { path: 'src/Button.tsx', certainty: 'confirmed', reason: 'changed', depth: 0, via: ['src/Button.tsx'] },
          { path: 'README.md', certainty: 'unknown', reason: 'non-code-change', depth: 0, via: ['README.md'] },
          { path: 'logo.png', certainty: 'unknown', reason: 'non-code-change', depth: 0, via: ['logo.png'] },
          { path: 'src/Header.tsx', certainty: 'confirmed', reason: 'imports-changed', depth: 1, via: ['src/Header.tsx', 'src/ui/index.ts', 'src/Button.tsx'] },
          { path: 'src/ui/index.ts', certainty: 'confirmed', reason: 're-exports', depth: 1, via: ['src/ui/index.ts', 'src/Button.tsx'] },
          { path: 'src/app.ts', certainty: 'confirmed', reason: 'imports-deleted', depth: 1, via: ['src/app.ts', 'src/old.ts'] },
          { path: 'src/Page.tsx', certainty: 'possible', reason: 'transitive', depth: 2, via: ['src/Page.tsx', 'src/Header.tsx', 'src/Button.tsx'] },
        ],
        unresolved: [],
        stats: { analyzedFiles: 5, skippedFiles: 0, edges: 4, unresolvedSpecifiers: 0 },
      },
    },
    review: {
      status: 'ok',
      evidence: [],
      data: {
        findings: [
          { rule: 'console-log', file: 'src/Button.tsx', line: 12, count: 2 },
          { rule: 'deleted-still-imported', file: 'src/app.ts', related: ['src/old.ts'] },
        ],
      },
    },
    tests: { status: 'skipped', reason: 'not yet', evidence: [] },
    bundle: { status: 'skipped', reason: 'not yet', evidence: [] },
    ...overrides,
  };
}

describe('renderMarkdown', () => {
  it('writes a plain-Korean summary, suggestions by importance, impact and changed files', () => {
    const text = renderMarkdown(makeReport());
    expect(text.startsWith(COMMENT_MARKER)).toBe(true);
    expect(text).toContain('- 바뀐 파일: **4개** (추가 4줄, 삭제 1줄)');
    expect(text).toContain('- 영향을 받을 수 있는 파일: **4개** (확실 3개 · 가능성 1개), 자동으로 판단하기 어려운 변경 1건');
    expect(text).toContain('- 리뷰 제안: **2건** (꼭 확인 1건 · 고쳐 보면 좋아요 1건 · 참고 0건)');
    // Must-fix items come first and are numbered across levels.
    expect(text.indexOf('🔴 꼭 확인해 주세요')).toBeLessThan(text.indexOf('🟡 고쳐 보면 좋아요'));
    expect(text).toContain('1. `src/app.ts` 파일이 삭제되었거나 이름이 바뀐 `src/old.ts` 파일을 아직 불러오고 있어요.');
    expect(text).toContain('2. `src/Button.tsx` 파일 12번째 줄 등 2곳에 `console.log`');
    expect(text).toContain('- `src/Header.tsx`: 바뀐 `src/Button.tsx` 파일의 코드를 사용해요 (`src/ui/index.ts` 파일을 거쳐서)');
    expect(text).toContain('- `src/ui/index.ts`: `src/Button.tsx` 파일의 코드를 모아서 다른 파일에 전달하는 "모음 파일"이에요');
    expect(text).toContain('<details><summary>영향을 받을 수도 있어요 (1개, 눌러서 펼치기)</summary>');
    expect(text).toContain('- `logo.png`: 코드가 아닌 파일');
    expect(text).toContain('📝 문서 파일도 바뀌었어요: `README.md`');
    expect(text).toContain('| `src/new.ts` (이전 이름: `src/old.ts`) | 이름 변경 | +0 / -0 |');
    expect(text).toContain('| `logo.png` | 추가 | 이미지 등 이진 파일 |');
    expect(text).toContain('- 테스트 실행: ⏸️ 아직 지원하지 않아요');
    expect(text).toContain('비교한 커밋: `aaaaaaa` → `bbbbbbb`');
  });

  it('never renders free-text reasons or evidence from the report', () => {
    const report = makeReport({
      impact: { status: 'truncated', reason: '[click me](https://evil.example) @someone', evidence: [{ source: 'git', detail: '<img src=x>' }] },
    });
    const text = renderMarkdown(report);
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('@someone');
    expect(text).not.toContain('<img');
    expect(text).toContain('- 영향 범위 분석: ⚠️ 파일이 많거나 커서 일부만 분석했어요');
    expect(text).toContain('영향 범위를 분석하지 못했어요.');
  });

  it('keeps untrusted paths inside code spans, also in tables', () => {
    const evil = 'a`b|c](https://x.example)<script>@user\u202e.ts';
    const report = makeReport();
    const files = report.diff.data?.files ?? [];
    files[0] = { path: evil, change: 'modified', additions: 1, deletions: 0, binary: false, hunks: [] };
    const text = renderMarkdown(report);
    expect(text).toContain('| ``a`b\\|c](https://x.example)<script>@user.ts`` | 수정 |');
    expect(text).not.toContain('\u202e');
  });

  it('explains that nothing was analysed when the diff failed', () => {
    const text = renderMarkdown(makeReport({ diff: { status: 'failed', evidence: [] } }));
    expect(text).toContain('바뀐 내용을 가져오지 못해서');
    expect(text).toContain('- 바뀐 내용 수집: ❌ 하지 못했어요');
  });

  it('describes changed workflow files', () => {
    const report = makeReport();
    report.impact.data?.candidates.push({ path: '.github/workflows/ci.yml', certainty: 'unknown', reason: 'non-code-change', depth: 0, via: ['.github/workflows/ci.yml'] });
    expect(renderMarkdown(report)).toContain('- `.github/workflows/ci.yml`: GitHub Actions 워크플로 파일이 바뀌었어요.');
  });

  it('says so when no rule matched', () => {
    const text = renderMarkdown(makeReport({ review: { status: 'ok', evidence: [], data: { findings: [] } } }));
    expect(text).toContain('자동 점검 규칙에 걸린 내용이 없어요.');
  });

  it('caps long lists and stays under the GitHub comment size limit', () => {
    const many: ImpactCandidate[] = Array.from({ length: 3000 }, (_, i) => ({
      path: `src/${'deep/'.repeat(20)}file${i}.ts`,
      certainty: i % 2 === 0 ? 'confirmed' : 'possible',
      reason: i % 2 === 0 ? 'imports-changed' : 'transitive',
      depth: i % 2 === 0 ? 1 : 3,
      via: Array.from({ length: 8 }, (_, j) => `src/${'x'.repeat(100)}${j}.ts`),
    }));
    const findings: ReviewFinding[] = Array.from({ length: 500 }, (_, i) => ({ rule: 'console-log', file: `src/f${i}.ts`, line: 1, count: 1 }));
    const report = makeReport();
    const text = renderMarkdown({
      ...report,
      impact: { status: 'ok', evidence: [], data: { candidates: many, unresolved: [], stats: { analyzedFiles: 0, skippedFiles: 0, edges: 0, unresolvedSpecifiers: 0 } } },
      review: { status: 'ok', evidence: [], data: { findings } },
    });
    expect(text.length).toBeLessThanOrEqual(65_536);
    expect(text).toContain('- 이 밖에 490건이 더 있어요.');
    expect(text).toContain('- 이 밖에 1470개가 더 있어요.');
  });
});

describe('describeFinding', () => {
  const rules: ReviewRule[] = [
    'deleted-still-imported',
    'unresolved-import',
    'debugger',
    'console-log',
    'any-type',
    'todo',
    'large-pr',
    'config-change',
    'tests-to-run',
    'no-tests',
  ];
  it.each(rules)('%s has a problem and a fix in Korean', (rule) => {
    const { problem, fix } = describeFinding({ rule, file: 'src/a.ts', line: 3, related: ['package.json'], specifier: './x', count: 900 }, makeReport());
    expect(problem).toMatch(/[가-힣]/);
    expect(fix).toMatch(/[가-힣]/);
  });

  it('mentions the lock file only when package.json changed', () => {
    expect(describeFinding({ rule: 'config-change', related: ['package.json'] }, makeReport()).fix).toContain('lock 파일');
    expect(describeFinding({ rule: 'config-change', related: ['tsconfig.json'] }, makeReport()).fix).not.toContain('lock 파일');
  });
});

describe('AI section', () => {
  const ai: AiSection = {
    status: 'ok',
    dropped: 2,
    omittedFiles: 1,
    data: {
      summary: '버튼이 클릭 시 요청을 보내요.',
      changedAreas: [],
      potentialImpacts: [],
      suggestions: [
        { severity: 'must', file: 'src/Button.tsx', line: 3, problem: '`fetch` 실패를 처리하지 않아요.', suggestion: 'try/catch로 감싸 주세요.', code: 'try {\n  await fetch(url);\n} catch {}\n```\nbreakout' },
      ],
      recommendedTests: ['버튼을 눌러 보세요'],
      uncertainties: ['서버 응답 형식은 알 수 없어요'],
    },
  };

  it('renders the summary, verified suggestions with code, recommendations and uncertainties', () => {
    const text = renderMarkdown(makeReport(), ai);
    expect(text).toContain('- AI 리뷰 제안: **1건**');
    expect(text).toContain('### 🤖 AI 리뷰 (참고용)');
    expect(text).toContain('(확인되지 않은 2건은 뺐어요)');
    expect(text).toContain('분량이 많아서 1개 파일은 AI가 읽지 못했어요.');
    expect(text).toContain('1. 🔴 `src/Button.tsx` 3번째 줄: `fetch` 실패를 처리하지 않아요.');
    expect(text).toContain('   ````\n   try {');
    expect(text).toContain('**AI가 추천하는 확인 방법** (추천일 뿐, 실행하지는 않았어요)');
    expect(text).toContain('- AI 리뷰 (선택 기능): ✅ 완료');
    expect(text.indexOf('### 💡 리뷰 제안')).toBeLessThan(text.indexOf('### 🤖 AI 리뷰'));
  });

  it.each<[AiSection, string]>([
    [{ status: 'skipped', reason: 'no-key' }, 'Claude API 키가 등록되지 않아서 건너뛰었어요'],
    [{ status: 'skipped', reason: 'author-not-allowed' }, '처음 기여하는 사람의 PR이라 건너뛰었어요'],
    [{ status: 'failed', reason: 'invalid-key' }, 'API 키가 올바르지 않거나'],
    [{ status: 'failed', reason: 'rate-limited' }, 'API 사용 한도에 걸렸어요'],
  ])('shows why the AI review did not run: %j', (section, label) => {
    const text = renderMarkdown(makeReport(), section);
    expect(text).toContain(label);
    expect(text).not.toContain('### 🤖 AI 리뷰');
  });

  it('omits the AI row entirely when the AI review is not configured at all', () => {
    expect(renderMarkdown(makeReport())).not.toContain('AI 리뷰');
  });
});

describe('prose', () => {
  it('disables links, mentions, references, HTML and formatting but keeps inline code', () => {
    const text = prose('Click [here](https://evil.example) or www.evil.example <img src=x onerror=alert(1)> @admin #12 **bold** `a_b`\nnext');
    expect(text).not.toMatch(/https?:|www\./);
    expect(text).toContain('(링크 생략)');
    expect(text).toContain('\\<img');
    expect(text).toContain('＠admin');
    expect(text).toContain('＃12');
    expect(text).toContain('\\*\\*bold\\*\\*');
    expect(text).toContain('`a_b`');
    expect(text).not.toContain('\n');
  });

  it('shortens long text', () => {
    expect(prose('가'.repeat(1000)).length).toBeLessThanOrEqual(400);
  });
});

describe('code', () => {
  it.each([
    ['plain.ts', '`plain.ts`'],
    ['a`b', '``a`b``'],
    ['`start', '`` `start ``'],
    ['', '`(빈 값)`'],
    ['line\nbreak', '`linebreak`'],
  ])('%j -> %j', (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it('shortens very long values', () => {
    expect(code('x'.repeat(500)).length).toBeLessThan(130);
  });
});
