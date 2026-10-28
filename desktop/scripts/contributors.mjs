/**
 * Everyone with commits in Paperwing itself, for CONTRIBUTORS.md: the
 * history since Paperwing's first commit, following main's own line (so
 * merged BentoPDF releases are left out) and skipping commits picked from
 * BentoPDF (`git cherry-pick -x` leaves "cherry picked from commit"), and
 * the people whose bug reports were fixed. Bots (Dependabot) are left out.
 *   node desktop/scripts/contributors.mjs [ref]
 */
import { execFileSync } from 'node:child_process';

const ref = process.argv[2] || 'HEAD';
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });

// Paperwing's first commit
const FIRST = 'Add Acrobat-style desktop shell (step 1)';
const first = git(
  'log',
  '--format=%H',
  `--grep=${FIRST}`,
  '--fixed-strings',
  ref
)
  .trim()
  .split('\n')
  .pop();
if (!first) throw new Error(`Paperwing's first commit ("${FIRST}") not found`);

const SEP = '\u001f';
const END = '\u001e';
const log = git(
  'log',
  '--first-parent',
  `--format=%an${SEP}%ae${SEP}%B${END}`,
  `${first}^..${ref}`
);

const people = new Map();
for (const entry of log.split(END)) {
  const [name, email, body = ''] = entry.trim().split(SEP);
  if (!name || /cherry picked from commit/.test(body)) continue;
  if (/\[bot\]/.test(name)) continue;
  // GitHub's noreply addresses carry the account name
  const login = /^\d+\+([^@]+)@users\.noreply\.github\.com$/.exec(email)?.[1];
  // "Rohan Vijaykumar" (an email address) and @rohanvijaykumar are one person
  const key = (login ?? name).toLowerCase().replace(/[\s._-]+/g, '');
  const p = people.get(key) ?? { names: new Set(), commits: 0, login };
  p.names.add(name);
  p.commits++;
  people.set(key, p);
}

const rows = [...people.values()].sort((a, b) => b.commits - a.commits);
for (const p of rows)
  console.log(
    `${String(p.commits).padStart(4)}  ${[...p.names].join(', ')}${p.login ? `  (@${p.login})` : ''}`
  );

// Bug reporters whose issue was fixed: closed as completed, or closed by a
// pull request (also one not merged yet). Needs the GitHub CLI (gh).
const repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(
  git('remote', 'get-url', 'origin').trim()
)?.[1];
let issues = [];
try {
  issues = JSON.parse(
    execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--limit',
        '1000',
        '--json',
        'number,title,author,stateReason,closedByPullRequestsReferences',
      ],
      { encoding: 'utf8' }
    )
  );
} catch {
  console.log('\n(bug reporters: install and sign in to the GitHub CLI, gh)');
}
const reporters = issues.filter(
  (i) =>
    (i.stateReason === 'COMPLETED' ||
      i.closedByPullRequestsReferences?.length) &&
    !i.author.is_bot &&
    i.author.login !== repo?.split('/')[0]
);
if (reporters.length) {
  console.log('\nBug reports fixed:');
  for (const i of reporters.sort((a, b) => a.number - b.number))
    console.log(`  @${i.author.login}  #${i.number} ${i.title}`);
}
