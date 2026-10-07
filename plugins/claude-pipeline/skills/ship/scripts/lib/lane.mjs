import { TRUSTED } from './lock.mjs';
import { parseMarker } from './marker.mjs';

const no = (reason) => ({ run: false, reason });
const yes = (prompt, key) => ({ run: true, prompt, key, concurrency: `ship-${key}` });
const names = (labels) => (labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
const pipelinePrFor = (n, openPrs) => openPrs.find((p) => !p.isCrossRepository && (p.headRefName === `claude/${n}` || p.headRefName.startsWith(`claude/${n}-`)));

export function laneTarget({ name, payload }, { openPrs = [] } = {}) {
  if (name === 'issues' && payload.action === 'labeled') {
    const { issue, label, sender } = payload;
    if (!['claude', 'claude-go'].includes(label?.name)) return no(`label ${label?.name} is not an intake label`);
    if (issue.pull_request) return no('pull requests are not issues');
    if (issue.state !== 'open') return no('issue is not open');
    if (!TRUSTED.has(issue.author_association)) return no('issue author is not trusted');
    // GitHub sends no author_association for the sender. In a solo repo the trusted labellers are
    // the issue's (trusted) author and the repository owner.
    if (sender?.login !== issue.user?.login && sender?.login !== payload.repository?.owner?.login) {
      return no('label sender is not the issue author or the repo owner');
    }
    return yes(`/claude-pipeline:ship #${issue.number} --mode auto`, String(issue.number));
  }
  if (name === 'issue_comment' && payload.action === 'created') {
    const { issue, comment } = payload;
    if (issue.pull_request) return no('comment is on a pull request');
    if (issue.state !== 'open') return no('issue is not open');
    if (!names(issue.labels).includes('needs-decision')) return no('issue is not waiting for a decision');
    if (!TRUSTED.has(comment.author_association)) return no('commenter is not trusted');
    if (!TRUSTED.has(issue.author_association)) return no('issue author is not trusted');
    if (parseMarker(comment.body)) return no('pipeline comment');
    const pr = pipelinePrFor(issue.number, openPrs);
    return pr
      ? yes(`/claude-pipeline:ship ${pr.number} --mode auto --fix`, String(issue.number))
      : yes(`/claude-pipeline:ship #${issue.number} --mode auto`, String(issue.number));
  }
  if (name === 'pull_request' && payload.action === 'labeled') {
    const pr = payload.pull_request;
    if (payload.label?.name !== 'claude-fix') return no('label is not claude-fix');
    if (pr.state !== 'open') return no('pull request is not open');
    if (pr.head?.repo?.full_name !== pr.base?.repo?.full_name) return no('pull request is from a fork');
    if (!String(pr.head?.ref ?? '').startsWith('claude/')) return no('not a pipeline branch');
    if (names(pr.labels).includes('needs-local')) return no('needs-local PRs are fixed only by the local runner');
    return yes(`/claude-pipeline:ship ${pr.number} --mode auto --fix`, `PR-${pr.number}`);
  }
  return no(`event ${name}/${payload.action ?? ''} is not routed`);
}
