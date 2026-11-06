import { describe, expect, test } from 'claude-code/testing'

import {
  GATE_COMMAND,
  GMAIL_READ_ACTIONS,
  GMAIL_WRITE_ACTIONS,
  describeFindings,
  findIdentifiers,
  findPushes,
  gmailWriteAction,
  hasSiteSegment,
  isUnderSite,
  judgeGate,
  normalizePath,
  pushDenyText,
  redact,
  resolvePath,
  resolveShellDir,
  targetPath,
  unmask,
  writeDenyText,
  writtenText,
} from '../hooks/logic'

// Written for these tests: no real address anywhere, only made-up names.
const lines = (text: string) => findIdentifiers(text).map(f => f.line)
const names = (text: string) => findIdentifiers(text).flatMap(f => f.patterns)

describe('findIdentifiers: what matches', () => {
  test('a plain address, and a bare domain', async () => {
    expect(names('write to jane.doe+news@gmail.com today')).toEqual(['@gmail.com'])
    expect(names('every @gmail.com address')).toEqual(['@gmail.com'])
    expect(names('jane@googlemail.com')).toEqual(['@googlemail.com'])
  })

  test('an address at the end of a sentence or inside punctuation', async () => {
    expect(lines('Mail jane@gmail.com.')).toEqual([1])
    expect(lines('(jane@gmail.com)')).toEqual([1])
    expect(lines('<b>jane@gmail.com</b>')).toEqual([1])
    expect(lines('"jane@gmail.com",')).toEqual([1])
  })

  test('in HTML attributes', async () => {
    expect(names('<a href="mailto:jane@gmail.com">write</a>')).toEqual(['@gmail.com'])
    expect(names("<a href='https://mail.google.com/mail/u/0/#inbox/abc'>src</a>")).toEqual(['mail.google.com'])
    expect(names('<meta name="author" content="jane@googlemail.com">')).toEqual(['@googlemail.com'])
    expect(names('<img alt="x" data-from=jane@gmail.com>')).toEqual(['@gmail.com'])
  })

  test('in markdown links', async () => {
    expect(names('[mail me](mailto:jane@gmail.com)')).toEqual(['@gmail.com'])
    expect(names('[the thread](https://mail.google.com/mail/u/0/#all/18c)')).toEqual(['mail.google.com'])
    expect(names('<https://mail.google.com/mail/?view=cm>')).toEqual(['mail.google.com'])
    expect(names('[ref]: https://mail.google.com/x "title"')).toEqual(['mail.google.com'])
  })

  test('URL-encoded', async () => {
    expect(names('https://example.org/?to=jane%40gmail.com')).toEqual(['@gmail.com'])
    expect(names('jane%40GMAIL%2ECOM')).toEqual(['@gmail.com'])
    expect(names('https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0')).toEqual(['mail.google.com'])
    expect(names('jane%2540gmail.com')).toEqual(['@gmail.com'])
    expect(names('jane%40googlemail.com')).toEqual(['@googlemail.com'])
    expect(names('https%3A%2F%2Foutlook.office365.com%2Fowa%2F%3FItemID%3Dabc')).toEqual([
      'outlook.office365.com',
      '/owa/?ItemID',
    ])
  })

  test('as HTML entities', async () => {
    expect(names('jane&#64;gmail.com')).toEqual(['@gmail.com'])
    expect(names('jane&#x40;gmail&#46;com')).toEqual(['@gmail.com'])
    expect(names('jane&commat;gmail&period;com')).toEqual(['@gmail.com'])
    expect(names('jane&#64gmail.com')).toEqual(['@gmail.com'])
    expect(names('https:&sol;&sol;mail.google.com')).toEqual(['mail.google.com'])
  })

  test('in any case', async () => {
    expect(names('Jane@GMail.Com')).toEqual(['@gmail.com'])
    expect(names('JANE@GOOGLEMAIL.COM')).toEqual(['@googlemail.com'])
    expect(names('HTTPS://MAIL.GOOGLE.COM/mail')).toEqual(['mail.google.com'])
    expect(names('Mail.Google.Com')).toEqual(['mail.google.com'])
  })

  test('dressed up with width, invisible characters or a subdomain', async () => {
    expect(names('jane＠gmail.com')).toEqual(['@gmail.com'])
    expect(names('jane@ｇｍａｉｌ.com')).toEqual(['@gmail.com'])
    expect(names('jane@gm​ail.com')).toEqual(['@gmail.com'])
    expect(names('jane@gm­ail.com')).toEqual(['@gmail.com'])
    expect(names('https://x.mail.google.com/')).toEqual(['mail.google.com'])
  })

  test('the other mailbox hosts the CI screen names', async () => {
    expect(names('https://outlook.office365.com/mail/inbox')).toEqual(['outlook.office365.com'])
    expect(names('https://outlook.live.com/mail/0/')).toEqual(['outlook.live.com'])
    expect(names('https://x.example/owa/?ItemID=AAMk')).toEqual(['/owa/?ItemID'])
  })

  test('reports the line, counting CRLF and CR as one break each', async () => {
    expect(lines('clean\nclean\njane@gmail.com\nclean\nhttps://mail.google.com')).toEqual([3, 5])
    expect(lines('a\r\nb\r\njane@gmail.com')).toEqual([3])
    expect(lines('a\rjane@gmail.com')).toEqual([2])
    expect(lines('\n\n\njane@gmail.com')).toEqual([4])
  })

  test('lists every pattern on one line once', async () => {
    const found = findIdentifiers('jane@gmail.com and https://mail.google.com and jane@gmail.com')
    expect(found).toEqual([{ line: 1, patterns: ['@gmail.com', 'mail.google.com'] }])
  })
})

describe('findIdentifiers: what must not match', () => {
  test('inside longer domains and words', async () => {
    expect(findIdentifiers('jane@gmail.company')).toEqual([])
    expect(findIdentifiers('jane@gmail.community.org')).toEqual([])
    expect(findIdentifiers('jane@gmail.comedy')).toEqual([])
    expect(findIdentifiers('jane@googlemail.community')).toEqual([])
    expect(findIdentifiers('jane@notgmail.com')).toEqual([])
    expect(findIdentifiers('jane@mygooglemail.com')).toEqual([])
    expect(findIdentifiers('mail.google.community')).toEqual([])
    expect(findIdentifiers('mail.google.comedy')).toEqual([])
    expect(findIdentifiers('webmail.google.com')).toEqual([])
    expect(findIdentifiers('email.google.com')).toEqual([])
    expect(findIdentifiers('web-mail.google.com')).toEqual([])
    expect(findIdentifiers('outlook.live.community')).toEqual([])
    expect(findIdentifiers('myoutlook.office365.com')).toEqual([])
    expect(findIdentifiers('/owa/ItemID')).toEqual([])
  })

  test('names that only resemble one', async () => {
    expect(findIdentifiers('gmail')).toEqual([])
    expect(findIdentifiers('gmail.com is Google\'s mail service')).toEqual([])
    expect(findIdentifiers('mail.google')).toEqual([])
    expect(findIdentifiers('google.com/mail')).toEqual([])
    expect(findIdentifiers('jane@hotmail.com')).toEqual([])
    expect(findIdentifiers('jane@example.com')).toEqual([])
    expect(findIdentifiers('git@github.com:AndresRubio/ai-digest.git')).toEqual([])
    expect(findIdentifiers('mail.google.org')).toEqual([])
    expect(findIdentifiers('100%40 off')).toEqual([])
  })

  test('text with no identifiers at all', async () => {
    expect(findIdentifiers('')).toEqual([])
    expect(findIdentifiers('\n\n')).toEqual([])
    expect(
      findIdentifiers(
        '<article class="story" id="s1"><h4><a href="https://openai.com/index/x">Title</a></h4><p>TLDR AI (Sep 11) reports a release.</p></article>',
      ),
    ).toEqual([])
    expect(findIdentifiers('Newsletter: The Batch (Oct 3). Source: https://arxiv.org/abs/2501.00001')).toEqual([])
  })

  test('a percent sign or entity that decodes to nothing relevant', async () => {
    expect(unmask('50%25 and %zz and &#xZZ; and &#9999999;')).toBe('50% and %zz and &#xZZ; and &#9999999;')
    expect(unmask('%00%1f')).toBe('%00%1f')
  })
})

describe('what a refusal says', () => {
  test('names the pattern and line, never the address', async () => {
    const text = 'a\nwrite to jane.doe@gmail.com now\nb'
    const found = findIdentifiers(text)
    const said = writeDenyText('Write', 'site/topics/x.html', found)
    expect(said).toContain('line 2')
    expect(said).toContain('@gmail.com')
    expect(said).toContain('site/topics/x.html')
    expect(said).not.toContain('jane')
    expect(said).not.toContain('doe')
  })

  test('caps a long list', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ line: i + 1, patterns: ['@gmail.com'] }))
    expect(describeFindings(many, 3)).toBe('line 1 (@gmail.com), line 2 (@gmail.com), line 3 (@gmail.com) and 6 more')
    expect(describeFindings(many.slice(0, 2))).toBe('line 1 (@gmail.com), line 2 (@gmail.com)')
  })

  test('redact hides an address wherever it shows up', async () => {
    expect(redact('see jane.doe+x@gmail.com and JANE@GoogleMail.com.')).toBe('see [address] and [address].')
    expect(redact('nothing here')).toBe('nothing here')
  })
})

describe('writtenText and targetPath', () => {
  test('read the text each tool writes', async () => {
    expect(writtenText('Write', { content: 'c', new_string: 'n' })).toBe('c')
    expect(writtenText('Edit', { old_string: 'o', new_string: 'n', content: 'c' })).toBe('n')
    expect(writtenText('NotebookEdit', { new_source: 's', new_string: 'n' })).toBe('s')
    expect(writtenText('Write', {})).toBeUndefined()
    expect(writtenText('Edit', { new_string: 3 })).toBeUndefined()
  })

  test('read the path each tool names', async () => {
    expect(targetPath('Write', { file_path: '/a/b' })).toBe('/a/b')
    expect(targetPath('NotebookEdit', { notebook_path: '/a/n.ipynb', file_path: '/x' })).toBe('/a/n.ipynb')
    expect(targetPath('Edit', {})).toBeUndefined()
    expect(targetPath('Edit', { file_path: '' })).toBeUndefined()
  })
})

describe('gmailWriteAction', () => {
  const servers = ['74ffd4a8-ffa4-4112-b84a-7123ff1ec349', 'claude_ai_Gmail', 'plugin_mail_gmail', 'x']

  test('knows all 24 write actions, on any server id', async () => {
    expect(GMAIL_WRITE_ACTIONS.size).toBe(24)
    for (const server of servers) {
      for (const action of GMAIL_WRITE_ACTIONS) {
        expect(gmailWriteAction(`mcp__${server}__${action}`)).toBe(action)
      }
    }
  })

  test('lets the six read actions through', async () => {
    expect(GMAIL_READ_ACTIONS.length).toBe(6)
    for (const server of servers) {
      for (const action of GMAIL_READ_ACTIONS) {
        expect(gmailWriteAction(`mcp__${server}__${action}`)).toBeUndefined()
      }
    }
  })

  test('ignores tools that are not MCP tools or not exact matches', async () => {
    expect(gmailWriteAction('reply')).toBeUndefined()
    expect(gmailWriteAction('Bash')).toBeUndefined()
    expect(gmailWriteAction('send_message')).toBeUndefined()
    expect(gmailWriteAction('mcp__x__send_messages')).toBeUndefined()
    expect(gmailWriteAction('mcp__x__slack_send_message')).toBeUndefined()
    expect(gmailWriteAction('mcp__x__resend_message')).toBeUndefined()
    expect(gmailWriteAction('mcp__send_message')).toBeUndefined()
    expect(gmailWriteAction('mcp__x__get_thread__send_message_info')).toBeUndefined()
    expect(gmailWriteAction('')).toBeUndefined()
  })

  test('reads the action after the last double underscore, in any case', async () => {
    expect(gmailWriteAction('mcp__a__b__trash_thread')).toBe('trash_thread')
    expect(gmailWriteAction('mcp__x__SEND_MESSAGE')).toBe('send_message')
  })
})

describe('findPushes', () => {
  test('finds plain and option-laden pushes', async () => {
    expect(findPushes('git push')).toEqual([{ steps: [] }])
    expect(findPushes('git push origin main')).toEqual([{ steps: [] }])
    expect(findPushes('git push --force-with-lease -u origin HEAD')).toEqual([{ steps: [] }])
    expect(findPushes('git -c user.name=AndresRubio push')).toEqual([{ steps: [] }])
    expect(findPushes('git --no-pager push')).toEqual([{ steps: [] }])
    expect(findPushes('/usr/bin/git push')).toEqual([{ steps: [] }])
    expect(findPushes('GIT_SSH_COMMAND=ssh git push')).toEqual([{ steps: [] }])
    expect(findPushes('git add -A && git commit -m x && git push')).toEqual([{ steps: [] }])
    expect(findPushes('git --git-dir /x/.git push')).toEqual([{ steps: [] }])
    expect(findPushes('git --git-dir=/x/.git push')).toEqual([{ steps: [] }])
    expect(findPushes('false || git push; echo done')).toEqual([{ steps: [] }])
    expect(findPushes('git\tpush')).toEqual([{ steps: [] }])
  })

  test('finds a push inside quotes, a subshell or a substitution', async () => {
    expect(findPushes('bash -c "git push"')).toHaveLength(1)
    expect(findPushes("sh -c 'cd x && git push'")).toHaveLength(1)
    expect(findPushes('(git push)')).toHaveLength(1)
    expect(findPushes('echo $(git push)')).toHaveLength(1)
    expect(findPushes('{ git push; }')).toHaveLength(1)
    expect(findPushes('x=`git push`')).toHaveLength(1)
  })

  test('reads the folder the push runs in', async () => {
    expect(findPushes('git -C ../ai-digest push')).toEqual([{ steps: ['../ai-digest'] }])
    expect(findPushes('git -C "/a b/c" push origin')).toEqual([{ steps: ['/a b/c'] }])
    expect(findPushes('cd ai-digest && git push')).toEqual([{ steps: ['ai-digest'] }])
    expect(findPushes("cd '/x y' ; cd z && git push")).toEqual([{ steps: ['/x y', 'z'] }])
    expect(findPushes('cd a && git -C b push')).toEqual([{ steps: ['a', 'b'] }])
    expect(findPushes('git -C a -C b push')).toEqual([{ steps: ['a', 'b'] }])
    expect(findPushes('cd ~/p/ai-digest && git push')).toEqual([{ steps: ['~/p/ai-digest'] }])
  })

  test('returns every push of a command, each with its own folder', async () => {
    expect(findPushes('git push && cd x && git push')).toEqual([{ steps: [] }, { steps: ['x'] }])
    expect(findPushes('git -C a push; git -C b push')).toEqual([{ steps: ['a'] }, { steps: ['b'] }])
  })

  test('skips a dry run, which pushes nothing', async () => {
    expect(findPushes('git push --dry-run')).toEqual([])
    expect(findPushes('git push -n origin main')).toEqual([])
    expect(findPushes('git push origin --dry-run')).toEqual([])
    expect(findPushes('bash -c "git push --dry-run"')).toEqual([])
    expect(findPushes('git push --dry-run && git push')).toEqual([{ steps: [] }])
    expect(findPushes('git push origin main-not-a-flag-n')).toHaveLength(1)
  })

  test('ignores what is not a push', async () => {
    expect(findPushes('git status')).toEqual([])
    expect(findPushes('git log --grep push')).toEqual([])
    expect(findPushes('git push-to-checkout')).toEqual([])
    expect(findPushes('git pull && git commit -m x')).toEqual([])
    expect(findPushes('legit push')).toEqual([])
    expect(findPushes('gitlab push')).toEqual([])
    expect(findPushes('echo gitpush')).toEqual([])
    expect(findPushes('docker push image')).toEqual([])
    expect(findPushes('npm run push')).toEqual([])
    expect(findPushes('')).toEqual([])
  })
})

describe('paths', () => {
  test('normalizePath folds dots and slashes', async () => {
    expect(normalizePath('/a//b/./c/../d')).toBe('/a/b/d')
    expect(normalizePath('/../..')).toBe('/')
    expect(normalizePath('a/../../b')).toBe('../b')
    expect(normalizePath('')).toBe('.')
    expect(normalizePath('site/topics/')).toBe('site/topics')
  })

  test('resolvePath: absolute, relative and home', async () => {
    expect(resolvePath('/cwd', '/a/b', '/h')).toBe('/a/b')
    expect(resolvePath('/cwd/x', '../site/i.html', '/h')).toBe('/cwd/site/i.html')
    expect(resolvePath('/cwd', '~/p/f.html', '/home/me')).toBe('/home/me/p/f.html')
    expect(resolvePath('/cwd', '~', '/home/me')).toBe('/home/me')
    expect(resolvePath('/cwd', '~x/f', '/home/me')).toBe('/cwd/~x/f')
  })

  test('resolveShellDir follows each step, and gives up on what it cannot know', async () => {
    expect(resolveShellDir('/cwd', [], '/h')).toBe('/cwd')
    expect(resolveShellDir('/cwd', ['a', '../b'], '/h')).toBe('/cwd/b')
    expect(resolveShellDir('/cwd', ['/abs', 'rel'], '/h')).toBe('/abs/rel')
    expect(resolveShellDir('/cwd', ['~/x'], '/h')).toBe('/h/x')
    expect(resolveShellDir('/cwd', ['$HOME/x'], '/h')).toBe('/h/x')
    expect(resolveShellDir('/cwd', ['${HOME}/x'], '/h')).toBe('/h/x')
    expect(resolveShellDir('/cwd', ['$PROJECT/x'], '/h')).toBeUndefined()
    expect(resolveShellDir('/cwd', ['$(pwd)'], '/h')).toBeUndefined()
    expect(resolveShellDir('/cwd', ['a*'], '/h')).toBeUndefined()
    expect(resolveShellDir('/cwd', ['-'], '/h')).toBeUndefined()
    expect(resolveShellDir('/cwd', ['~other/x'], '/h')).toBeUndefined()
    expect(resolveShellDir('/cwd', ['`pwd`'], '/h')).toBeUndefined()
  })

  test('isUnderSite: the first segment, without case', async () => {
    expect(isUnderSite('site/index.html')).toBe(true)
    expect(isUnderSite('site/topics/a.html')).toBe(true)
    expect(isUnderSite('Site/index.html')).toBe(true)
    expect(isUnderSite('./site//index.html')).toBe(true)
    expect(isUnderSite('site')).toBe(false)
    expect(isUnderSite('docs/site/x.html')).toBe(false)
    expect(isUnderSite('sitemap/x.html')).toBe(false)
    expect(isUnderSite('digest-routine/site.md')).toBe(false)
    expect(isUnderSite('../site/x.html')).toBe(false)
  })

  test('hasSiteSegment is the cheap test before asking git', async () => {
    expect(hasSiteSegment('/a/ai-digest/site/x.html')).toBe(true)
    expect(hasSiteSegment('/a/SITE/x.html')).toBe(true)
    expect(hasSiteSegment('/a/ai-digest/docs/x.html')).toBe(false)
    expect(hasSiteSegment('/a/sitemap/x.html')).toBe(false)
  })
})

// The real output of `python3 digest-routine/check-structure.py` on the
// ai-digest repo, exit 0, captured 2026-10-30.
const REAL_PASS = `check_no_mailbox_links             PASS
check_anchors_resolve              PASS
check_flat_structure               PASS
check_index_counts                 PASS
check_lead_length                  PASS
check_lead_counts                  PASS
check_story_link_state             PASS
check_timeline_order               PASS
check_no_wall_of_text              PASS
check_no_legacy_prose              PASS
check_sidebar_consistency          PASS

11 topic page(s) checked structurally, 118 published page(s) screened for mailbox identifiers, 0 failure(s)
`

// The real output on a copy of site/ with a made-up address added to a daily
// page (exit 1), captured 2026-10-30.
const FAILING = `check_no_mailbox_links             FAIL (1)
check_anchors_resolve              PASS
check_flat_structure               PASS
check_index_counts                 PASS
check_lead_length                  PASS
check_lead_counts                  PASS
check_story_link_state             PASS
check_timeline_order               PASS
check_no_wall_of_text              PASS
check_no_legacy_prose              PASS
check_sidebar_consistency          PASS
  site/daily/2026-05-28.html:47 mailbox identifier in published page

11 topic page(s) checked structurally, 118 published page(s) screened for mailbox identifiers, 1 failure(s)
`

describe('judgeGate', () => {
  test('passes the real output of a passing run', async () => {
    expect(judgeGate(0, REAL_PASS)).toEqual({ ok: true })
  })

  test('fails an exit 1 with the script\'s failure lines', async () => {
    const verdict = judgeGate(1, FAILING)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? '' : verdict.reason).toContain('code 1')
  })

  test('does not take an exit 0 for a pass without the summary', async () => {
    expect(judgeGate(0, '').ok).toBe(false)
    expect(judgeGate(0, 'Python 3.9.6\n').ok).toBe(false)
    expect(judgeGate(0, REAL_PASS.replace('0 failure(s)', '10 failure(s)')).ok).toBe(false)
  })

  test('does not take an exit 0 that printed a FAIL line', async () => {
    expect(judgeGate(0, `${REAL_PASS}check_x   FAIL (2)\n`).ok).toBe(false)
  })

  test('fails an exit 127 and a missing script', async () => {
    expect(judgeGate(127, 'sh: python3: command not found').ok).toBe(false)
    expect(judgeGate(2, "python3: can't open file 'digest-routine/check-structure.py'").ok).toBe(false)
  })
})

describe('pushDenyText', () => {
  test('carries the gate output and says what to do, with any address hidden', async () => {
    const said = pushDenyText('/Users/me/ai-digest', 'the gate exited with code 1', `${FAILING}\nstray jane@gmail.com`)
    expect(said).toContain('git push was stopped')
    expect(said).toContain('ai-digest')
    expect(said).toContain('python3 digest-routine/check-structure.py')
    expect(said).not.toContain('2>&1')
    expect(said).toContain('site/daily/2026-05-28.html:47 mailbox identifier in published page')
    expect(said).toContain('[address]')
    expect(said).not.toContain('jane')
  })

  test('keeps the end of a very long output', async () => {
    const out = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const said = pushDenyText('/r/ai-digest', 'x', out)
    expect(said).toContain('line 199')
    expect(said).not.toContain('line 10\n')
  })

  test('the command it names is the routine\'s', async () => {
    expect(GATE_COMMAND).toBe('python3 digest-routine/check-structure.py 2>&1')
  })
})
