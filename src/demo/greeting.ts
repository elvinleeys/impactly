import { DEFAULT_LIMITS } from '../core/limits.js';

// TODO: replace this demo once the comment e2e test is done
export function greeting(name: any): string {
  console.log('greeting', name);
  return `hello ${String(name)} (${DEFAULT_LIMITS.maxDepth})`;
}
