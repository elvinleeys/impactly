import { runAction } from './main.js';

// Bundled entry of the GitHub Action (see action.yml). Kept separate from main.ts so tests can
// import runAction without running it.
void runAction(process.env).then((code) => {
  process.exitCode = code;
});
