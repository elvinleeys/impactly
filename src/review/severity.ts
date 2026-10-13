import type { ReviewRule } from '../core/types.js';

export type Severity = 'must' | 'consider' | 'info';

/** How important each rule is. Kept in trusted code, not in the report data. */
export const RULE_SEVERITY: Readonly<Record<ReviewRule, Severity>> = {
  'deleted-still-imported': 'must',
  'unresolved-import': 'must',
  debugger: 'must',
  'console-log': 'consider',
  'any-type': 'consider',
  'large-pr': 'consider',
  'no-tests': 'consider',
  todo: 'info',
  'config-change': 'info',
  'tests-to-run': 'info',
};
