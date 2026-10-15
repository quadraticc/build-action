import {execFileSync} from 'node:child_process';

try {
  execFileSync('git', ['diff', '--exit-code', '--', 'dist'], {stdio: 'inherit'});
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'dist'], {encoding: 'utf8'});
  if (untracked.trim()) throw new Error('The build generated untracked distribution files.');
} catch {
  console.error('The committed distribution is out of date. Run npm run build and commit the complete dist/ directory.');
  process.exitCode = 1;
}
