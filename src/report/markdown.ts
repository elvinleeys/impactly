import type { ChangeKind, ImpactCandidate, Report, ReviewFinding, Section, Status } from '../core/types.js';
import { RULE_SEVERITY, type Severity } from '../review/severity.js';

/**
 * Renders a report as a PR comment in plain Korean for readers with basic web knowledge.
 *
 * Every value that comes from the analysed repository (paths, import specifiers) is shown only
 * inside an escaped code span, and every sentence is written here. The report may come from an
 * untrusted PR run, so its free-text fields (`reason`, `evidence`) are never rendered. Pure.
 */

/** Hidden marker used to find and update the comment instead of posting a new one each time. */
export const COMMENT_MARKER = '<!-- impactly-report -->';

/** GitHub rejects comments over 65,536 characters. */
const MAX_LENGTH = 60_000;
const MAX_FINDINGS_PER_LEVEL = 10;
const MAX_CONFIRMED = 30;
const MAX_POSSIBLE = 40;
const MAX_CHANGED_FILES = 40;
const MAX_RELATED = 5;
const MAX_CODE_LENGTH = 120;

export function renderMarkdown(report: Report): string {
  const lines: string[] = [COMMENT_MARKER, '## 🔍 Impactly PR 점검 결과', ''];
  lines.push('> 이 PR에서 바뀐 내용을 자동으로 살펴본 결과예요. 자동 분석이라 틀릴 수 있으니, 사람이 한 번 더 확인해 주세요.', '');

  const diff = report.diff.data;
  if (diff === undefined) {
    lines.push('❌ 바뀐 내용을 가져오지 못해서 이번에는 분석하지 못했어요. 다음 커밋을 올리면 다시 시도해요.', '');
    lines.push(...statusSection(report), ...footer(report));
    return finish(lines);
  }

  const candidates = report.impact.data?.candidates ?? [];
  const confirmed = candidates.filter((c) => c.depth > 0 && c.certainty === 'confirmed');
  const possible = candidates.filter((c) => c.depth > 0 && c.certainty === 'possible');
  const docs = candidates.filter((c) => c.reason === 'non-code-change' && isDocFile(c.path));
  const unknown = candidates.filter((c) => c.certainty === 'unknown' && !docs.includes(c));
  const findings = report.review.data?.findings ?? [];
  const byLevel = (level: Severity): ReviewFinding[] => findings.filter((f) => RULE_SEVERITY[f.rule] === level);

  lines.push('### 한눈에 보기', '');
  lines.push(`- 바뀐 파일: **${diff.totals.files}개** (추가 ${diff.totals.additions}줄, 삭제 ${diff.totals.deletions}줄)`);
  if (report.impact.data === undefined) lines.push('- 영향을 받을 수 있는 파일: 분석하지 못했어요');
  else {
    lines.push(
      `- 영향을 받을 수 있는 파일: **${confirmed.length + possible.length}개** (확실 ${confirmed.length}개 · 가능성 ${possible.length}개)` +
        (unknown.length > 0 ? `, 자동으로 판단하기 어려운 변경 ${unknown.length}건` : ''),
    );
  }
  if (report.review.data === undefined) lines.push('- 리뷰 제안: 점검하지 못했어요');
  else {
    lines.push(
      `- 리뷰 제안: **${findings.length}건** (꼭 확인 ${byLevel('must').length}건 · 고쳐 보면 좋아요 ${byLevel('consider').length}건 · 참고 ${byLevel('info').length}건)`,
    );
  }
  lines.push('');

  lines.push(...reviewSection(report, byLevel));
  lines.push(...impactSection(confirmed, possible, unknown, docs, report.impact.data === undefined));
  lines.push(...changedFilesSection(report));
  lines.push(...statusSection(report), ...footer(report));
  return finish(lines);
}

function reviewSection(report: Report, byLevel: (level: Severity) => ReviewFinding[]): string[] {
  const lines = ['### 💡 리뷰 제안', ''];
  if (report.review.data === undefined) {
    lines.push('리뷰 규칙 점검을 하지 못했어요.', '');
    return lines;
  }
  if (report.review.data.findings.length === 0) {
    lines.push('자동 점검 규칙에 걸린 내용이 없어요. 그래도 바뀐 화면과 기능은 직접 확인해 주세요.', '');
    return lines;
  }
  const levels: readonly [Severity, string][] = [
    ['must', '🔴 꼭 확인해 주세요'],
    ['consider', '🟡 고쳐 보면 좋아요'],
    ['info', '🔵 참고해 주세요'],
  ];
  let number = 0;
  for (const [level, title] of levels) {
    const items = byLevel(level);
    if (items.length === 0) continue;
    lines.push(`**${title}**`, '');
    for (const finding of items.slice(0, MAX_FINDINGS_PER_LEVEL)) {
      const { problem, fix } = describeFinding(finding, report);
      number++;
      lines.push(`${number}. ${problem}`, `   👉 ${fix}`);
    }
    if (items.length > MAX_FINDINGS_PER_LEVEL) lines.push(`- 이 밖에 ${items.length - MAX_FINDINGS_PER_LEVEL}건이 더 있어요.`);
    lines.push('');
  }
  return lines;
}

/** The sentence for each rule. Only structured fields of the finding are used. */
export function describeFinding(finding: ReviewFinding, report: Report): { problem: string; fix: string } {
  const file = finding.file === undefined ? '' : code(finding.file);
  const at = atLine(finding);
  switch (finding.rule) {
    case 'deleted-still-imported':
      return {
        problem: `${file} 파일이 삭제되었거나 이름이 바뀐 ${list(finding.related)} 파일을 아직 불러오고 있어요. 이대로 합치면 빌드가 실패하거나 화면이 깨질 수 있어요.`,
        fix: '불러오는 경로를 새 파일 위치로 고치거나, 더 이상 쓰지 않는다면 그 import 줄을 지워 주세요.',
      };
    case 'unresolved-import':
      return {
        problem: `${file} 파일이 불러오는 ${code(finding.specifier ?? '')} 경로에 해당하는 파일을 찾지 못했어요. 경로에 오타가 있거나, 파일이 아직 추가되지 않았을 수 있어요.`,
        fix: '경로와 파일 이름이 맞는지(대소문자 포함) 확인해 주세요. 외부 패키지라면 설치되어 있는지도 확인해 주세요.',
      };
    case 'debugger':
      return {
        problem: `${file} 파일${at}에 \`debugger\`가 추가됐어요. 브라우저 개발자 도구가 열려 있으면 이 줄에서 실행이 멈춰요.`,
        fix: '디버깅이 끝났다면 합치기 전에 이 줄을 지워 주세요.',
      };
    case 'console-log':
      return {
        problem: `${file} 파일${at}에 \`console.log\` 같은 출력 코드가 추가됐어요. 사용하는 사람의 브라우저 콘솔에 불필요한 내용이 보일 수 있어요.`,
        fix: '확인용으로 넣은 코드라면 지워 주세요. 꼭 남겨야 하는 로그라면 이유를 주석으로 적어 두면 좋아요.',
      };
    case 'any-type':
      return {
        problem: `${file} 파일${at}에 \`any\` 타입이 쓰였어요. \`any\`를 쓰면 TypeScript가 그 값에 대한 실수를 잡아 주지 못해요.`,
        fix: '가능하면 실제 값의 모양에 맞는 타입(예: `string`, 직접 만든 `interface`)이나 `unknown`을 써 보세요.',
      };
    case 'todo':
      return {
        problem: `${file} 파일${at}에 \`TODO\`나 \`FIXME\` 같은 "나중에 할 일" 주석이 추가됐어요.`,
        fix: '이번 PR에서 마무리할 일인지 확인해 주세요. 나중에 할 일이라면 이슈로 남겨 두면 잊지 않아요.',
      };
    case 'large-pr':
      return {
        problem: `이번 PR에서 파일 ${report.diff.data?.totals.files ?? 0}개, 코드 ${finding.count ?? 0}줄이 바뀌었어요. 한 번에 바뀐 양이 많으면 리뷰하는 사람이 실수를 놓치기 쉬워요.`,
        fix: '기능별로 PR을 나눠서 올리는 것을 고려해 보세요.',
      };
    case 'config-change': {
      const hasPackageJson = (finding.related ?? []).some((p) => p === 'package.json' || p.endsWith('/package.json'));
      return {
        problem: `프로젝트 전체에 영향을 주는 설정 파일이 바뀌었어요: ${list(finding.related)}`,
        fix:
          '설치(`npm install`), 빌드, 앱 실행이 잘 되는지 직접 확인해 주세요.' +
          (hasPackageJson ? ' `package.json`의 패키지를 바꿨다면 lock 파일(`package-lock.json` 등)도 함께 바뀌었는지 확인해 주세요.' : ''),
      };
    }
    case 'tests-to-run':
      return {
        problem: `바뀐 코드를 사용하는 테스트 파일이 있어요: ${list(finding.related)} (Impactly가 직접 실행하지는 않았어요)`,
        fix: '합치기 전에 이 테스트들을 실행해서 통과하는지 확인해 주세요.',
      };
    case 'no-tests':
      return {
        problem: '코드가 바뀌었지만, 이 코드와 연결된 테스트 파일을 찾지 못했어요.',
        fix: '중요한 기능이라면 바뀐 동작을 확인하는 테스트를 추가하는 것을 고려해 보세요.',
      };
  }
}

function impactSection(
  confirmed: ImpactCandidate[],
  possible: ImpactCandidate[],
  unknown: ImpactCandidate[],
  docs: ImpactCandidate[],
  failed: boolean,
): string[] {
  const lines = ['### 🎯 영향을 받을 수 있는 파일', ''];
  if (failed) {
    lines.push('영향 범위를 분석하지 못했어요.', '');
    return lines;
  }
  const docsLine = docs.length > 0 ? [`📝 문서 파일도 바뀌었어요: ${list(docs.map((c) => c.path))} (앱 동작에는 영향이 없어요)`, ''] : [];
  if (confirmed.length + possible.length + unknown.length === 0) {
    lines.push('바뀐 파일을 가져다 쓰는 다른 파일을 찾지 못했어요.', '', ...docsLine);
    return lines;
  }
  lines.push('> 바뀐 파일의 코드를 가져다 쓰는 파일들이에요. 이 파일들이 담당하는 화면이나 기능도 한 번 확인해 보세요.', '');

  if (confirmed.length > 0) {
    lines.push('**확실히 영향을 받아요** (바뀐 코드를 직접 사용해요)', '');
    for (const candidate of confirmed.slice(0, MAX_CONFIRMED)) lines.push(`- ${code(candidate.path)}: ${describeConfirmed(candidate)}`);
    if (confirmed.length > MAX_CONFIRMED) lines.push(`- 이 밖에 ${confirmed.length - MAX_CONFIRMED}개가 더 있어요.`);
    lines.push('');
  }
  if (possible.length > 0) {
    lines.push(`<details><summary>영향을 받을 수도 있어요 (${possible.length}개, 눌러서 펼치기)</summary>`, '');
    lines.push('다른 파일을 여러 단계 거쳐 연결된 파일이에요. 실제로 영향이 있는지는 확실하지 않아요.', '');
    for (const candidate of possible.slice(0, MAX_POSSIBLE)) lines.push(`- ${code(candidate.path)}: ${route(candidate.via)}`);
    if (possible.length > MAX_POSSIBLE) lines.push(`- 이 밖에 ${possible.length - MAX_POSSIBLE}개가 더 있어요.`);
    lines.push('', '</details>', '');
  }
  if (unknown.length > 0) {
    lines.push('**자동으로 판단하기 어려워요**', '');
    for (const candidate of unknown.slice(0, MAX_CONFIRMED)) lines.push(`- ${code(candidate.path)}: ${describeUnknown(candidate)}`);
    if (unknown.length > MAX_CONFIRMED) lines.push(`- 이 밖에 ${unknown.length - MAX_CONFIRMED}개가 더 있어요.`);
    lines.push('');
  }
  lines.push(...docsLine);
  return lines;
}

function describeConfirmed(candidate: ImpactCandidate): string {
  const source = candidate.via[candidate.via.length - 1] ?? '';
  const barrels = candidate.via.slice(1, -1);
  const through = barrels.length > 0 ? ` (${barrels.map(code).join(', ')} 파일을 거쳐서)` : '';
  switch (candidate.reason) {
    case 'imports-deleted':
      return `삭제되었거나 이름이 바뀐 ${code(source)} 파일을 아직 불러와요${through}`;
    case 're-exports':
      return `${code(source)} 파일의 코드를 모아서 다른 파일에 전달하는 "모음 파일"이에요`;
    default:
      return `바뀐 ${code(source)} 파일의 코드를 사용해요${through}`;
  }
}

function describeUnknown(candidate: ImpactCandidate): string {
  switch (candidate.reason) {
    case 'config-change':
      return '프로젝트 전체 설정이 바뀌었어요. 설치, 빌드, 실행을 직접 확인해 주세요.';
    case 'dynamic-import':
      return `실행 중에 경로를 만들어 파일을 불러오고 있어서(동적 import), 바뀐 ${code(candidate.via[candidate.via.length - 1] ?? '')} 파일을 쓰는지 정확히 알 수 없어요.`;
    default:
      if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(candidate.path)) {
        return 'GitHub Actions 워크플로 파일이 바뀌었어요. PR에서 자동으로 도는 검사나 배포 방식이 달라질 수 있어요.';
      }
      return '코드가 아닌 파일(문서, 이미지, 데이터 등)이 바뀌었는데, 어디에서 쓰이는지 찾지 못했어요.';
  }
}

/** A short connection route: this file ← ... ← changed file. */
function route(via: readonly string[]): string {
  const source = via[via.length - 1] ?? '';
  const steps = via.length - 1;
  if (via.length <= 4) return `연결 경로: ${via.map(code).join(' → ')}`;
  return `바뀐 ${code(source)} 파일과 ${steps}단계를 거쳐 연결돼 있어요 (${code(via[0] ?? '')} → ${code(via[1] ?? '')} → … → ${code(source)})`;
}

const CHANGE_LABEL: Readonly<Record<ChangeKind, string>> = {
  added: '추가',
  modified: '수정',
  deleted: '삭제',
  renamed: '이름 변경',
  copied: '복사',
  'type-changed': '종류 변경',
};

function changedFilesSection(report: Report): string[] {
  const files = report.diff.data?.files ?? [];
  if (files.length === 0) return ['### 📂 바뀐 파일', '', '바뀐 파일이 없어요.', ''];
  const lines = [`<details><summary>📂 바뀐 파일 목록 (${report.diff.data?.totals.files ?? files.length}개, 눌러서 펼치기)</summary>`, ''];
  lines.push('| 파일 | 변경 | 줄 수 |', '|---|---|---|');
  for (const file of files.slice(0, MAX_CHANGED_FILES)) {
    const name = file.oldPath === undefined ? cell(file.path) : `${cell(file.path)} (이전 이름: ${cell(file.oldPath)})`;
    const counts = file.binary ? '이미지 등 이진 파일' : `+${file.additions ?? 0} / -${file.deletions ?? 0}`;
    lines.push(`| ${name} | ${CHANGE_LABEL[file.change]} | ${counts} |`);
  }
  const hidden = (report.diff.data?.totals.files ?? files.length) - Math.min(files.length, MAX_CHANGED_FILES);
  if (hidden > 0) lines.push('', `이 밖에 ${hidden}개 파일이 더 바뀌었어요.`);
  lines.push('', '</details>', '');
  return lines;
}

function statusSection(report: Report): string[] {
  const lines = ['### ℹ️ 이번 점검에서 한 일', ''];
  const rows: readonly [string, Section<unknown>][] = [
    ['바뀐 내용 수집', report.diff],
    ['영향 범위 분석', report.impact],
    ['리뷰 규칙 점검', report.review],
    ['테스트 실행', report.tests],
    ['번들 크기 비교', report.bundle],
  ];
  for (const [name, part] of rows) lines.push(`- ${name}: ${STATUS_LABEL[part.status]}`);
  lines.push('');
  return lines;
}

const STATUS_LABEL: Readonly<Record<Status, string>> = {
  ok: '✅ 완료',
  truncated: '⚠️ 파일이 많거나 커서 일부만 분석했어요',
  failed: '❌ 하지 못했어요',
  skipped: '⏸️ 아직 지원하지 않아요',
  unsupported: '➖ 이 프로젝트 형식은 지원하지 않아요',
};

function footer(report: Report): string[] {
  return [
    '---',
    `<sub>🤖 Impactly가 자동으로 만든 댓글이에요. 새 커밋을 올리면 이 댓글이 새 결과로 바뀌어요. 비교한 커밋: ${code(report.base.slice(0, 7))} → ${code(report.head.slice(0, 7))}</sub>`,
  ];
}

/** Documentation that the app never loads. `.mdx` is excluded because frameworks import it as pages. */
function isDocFile(repoPath: string): boolean {
  const name = repoPath.slice(repoPath.lastIndexOf('/') + 1);
  return /\.(md|markdown|txt|rst|adoc)$/i.test(name) || /^(LICENSE|LICENCE|NOTICE|AUTHORS|CODEOWNERS)(\.|$)/i.test(name);
}

function finish(lines: readonly string[]): string {
  const text = `${lines.join('\n')}\n`;
  if (text.length <= MAX_LENGTH) return text;
  return `${text.slice(0, MAX_LENGTH)}\n\n…(댓글이 너무 길어서 뒷부분을 생략했어요)\n`;
}

function atLine(finding: ReviewFinding): string {
  if (finding.line === undefined) return '';
  const more = finding.count !== undefined && finding.count > 1 ? ` 등 ${finding.count}곳` : '';
  return ` ${finding.line}번째 줄${more}`;
}

function list(paths: readonly string[] | undefined): string {
  const items = paths ?? [];
  const shown = items.slice(0, MAX_RELATED).map(code).join(', ');
  return items.length > MAX_RELATED ? `${shown} 외 ${items.length - MAX_RELATED}개` : shown;
}

/**
 * Shows untrusted text as an inline code span: control and bidirectional-override characters are
 * removed, the length is capped, and the fence is longer than any backtick run inside, so the text
 * can never close the span and turn into Markdown, HTML, links or @mentions.
 */
export function code(text: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
  if (clean.length > MAX_CODE_LENGTH) clean = `${clean.slice(0, MAX_CODE_LENGTH - 1)}…`;
  if (clean === '') return '`(빈 값)`';
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/** A code span inside a table cell: GitHub splits cells on `|` even inside code spans. */
function cell(text: string): string {
  return code(text).replace(/\|/g, '\\|');
}
