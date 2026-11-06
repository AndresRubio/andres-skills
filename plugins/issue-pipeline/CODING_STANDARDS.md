# Coding standards

Read during review. Each rule below is a fixed pattern; a violation is Important. They come from defects the Phase 2b reviews caught in code the plan itself specified.

## Linear scans on text the pipeline did not write

A regex or hand-written scanner that runs on a Bash command, an issue body, a comment, a tool output or a transcript is linear: no nested quantifiers, and no `[^x]*` run before a required literal that can restart at every position. It ships with a test that feeds about 200 KB of the worst-case character and asserts a sub-second bound. The run guard's hook timeout is 10 seconds and a timed-out hook counts as allow, so a slow scan in a hook is a bypass.

## Redirects by hand

An outbound `fetch` uses `redirect: 'manual'`, caps the hops, and checks each `Location` for `https:` and a host in the allow-list before requesting it. The final host is checked again once the body arrives. A missing allow-list means no redirect is followed.

## External text never reaches a URL raw

A path, ref, name or id taken from issue text, a comment or a config value is percent-encoded per segment before it enters a URL, an API path or a shell argument. A decoded segment of `.`, `..` or empty, or one containing `?`, `#` or a control character, is rejected before that, and a value that fails to decode is rejected too.

## Hooks fail in one direction

A PreToolUse guard fails closed (exit 2 on any doubt). A PostToolUse rewriter fails open (exit 0 and no output on any doubt). Everything a hook does before its decision stays in milliseconds. A path a hook reads from a marker or an input is re-checked to be under the pipeline home before anything is written there.
