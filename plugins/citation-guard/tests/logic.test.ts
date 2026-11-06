import { describe, expect, test } from 'claude-code/testing'

import type { Change, Ledger } from '../types'
import {
  EMPTY_LEDGER,
  applyEdit,
  changeLine,
  cite,
  contextNote,
  describeChanges,
  diffNumbers,
  endTurn,
  facts,
  hasTurnWork,
  kindOf,
  listText,
  mayMatter,
  record,
  tokenize,
  toastText,
} from '../hooks/logic'

// Snippets are copied from the warhammer repo's src/data (empire.ts,
// orcsGoblins.ts, woodElves.ts, undead.ts, magicItems.ts, movement.ts).

const EMPIRE_UNITS = `const units: UnitProfile[] = [
  // ===== Characters / PERSONAJES (0-50%) =====

  {
    id: 'emp-general',
    name: 'General of the Empire',
    nameEs: 'General del Imperio',
    role: 'character',
    pointsPerModel: 100,
    statLine: human({ WS: 6, BS: 6, S: 4, T: 4, W: 3, I: 6, A: 4, Ld: 9 }),
    isCharacter: true,
    characterRank: 'lord',
    canBeGeneral: true,
    mounts: FIGHTER_MOUNTS,
    specialRules: [
      'Commander (up to 3 magic items)',
      'Sword',
      'May ride a Warhorse (+3 pts) or a Monster',
    ],
  },
  {
    id: 'emp-battle-standard',
    name: 'Battle Standard Bearer',
    nameEs: 'Portaestandarte de Batalla',
    role: 'character',
    pointsPerModel: 80,
    statLine: human({ WS: 4, BS: 4, S: 4, T: 3, W: 1, I: 4, A: 2, Ld: 7 }),
    isCharacter: true,
    characterRank: 'champion',
  },
]
`

const MAGIC_ITEMS = `export const COMMON_MAGIC_ITEMS: MagicItem[] = [
  {"id": "mi-sword-of-defiance", "name": "Sword of Defiance", "nameEs": "Espada del Desafío", "category": "weapon", "points": 150, "description": "Increases the Toughness characteristic by +3.", "descEs": "Incrementa en +3 el atributo de Resistencia."},
  {"id": "mi-sword-of-death", "name": "Sword of Death", "nameEs": "Espada de Muerte", "category": "weapon", "points": 100, "description": "The wielder has Strength 10.", "descEs": "Quien la empuñe tendrá Fuerza 10."},
]
`

const MOVEMENT = `export const MOVEMENT_CM: Readonly<Partial<Record<number, number>>> = {
  0: 0,
  2: 5,
  3: 8,
  4: 10,
  5: 12,
}
`

const NIBLIT = `    // Orcos y Goblins p.91: Hacha de Grom +50, Niblit +65 con el Estandarte de Batalla,
    // Carruaje +62 (OLD-63).
    fixedMagicItems: [{ id: 'mi-elf-biter-the-axe-of-grom' }],
    fixedExtras: [
      { id: 'niblit', name: 'Niblit, with the army Battle Standard', nameEs: 'Niblit, con el Estandarte de Batalla', points: 65 },
      { id: 'wolf-chariot', name: 'Wolf Chariot', nameEs: 'Carruaje de lobos', points: 62 },
    ],
    // Orcos y Goblins p.91 (OLD-71): "Niblit 10 3 4 4 3 1 3 2 5", M10cm = 4".
    profiles: [
      { name: 'Niblit', statLine: { M: 4, WS: 3, BS: 4, S: 4, T: 3, W: 1, I: 3, A: 2, Ld: 5 } },
    ],
`

const OPTIONS = `const SHIELD_1: EquipmentOption = { id: 'shield', name: 'Shields', pointsPerModel: 1 }
const SHIELD_HALF: EquipmentOption = { id: 'shield', name: 'Shields', pointsPerModel: 0.5 }
`

const TREEMAN_BEFORE = `  {
    id: 'we-treeman',
    name: 'Treeman',
    nameEs: 'Hombre Árbol',
    role: 'monster',
    pointsPerModel: 280,
    statLine: { M: 6, WS: 8, BS: 3, S: 6, T: 7, W: 6, I: 2, A: 4, Ld: 9 },
    specialRules: [
      'Causes fear',
      'Hatred of Orcs & Goblins',
      '0-1 per 1,000 pts (max 3)',
    ],
  },
`

const TREEMAN_AFTER = `  {
    id: 'we-treeman',
    name: 'Treeman',
    nameEs: 'Hombre Árbol',
    // Elfos Silvanos p.66 and p.68 (OLD-73): a Regiment-section entry ("no es necesario organizar a
    // los Hombres Árbol en unidades"), so a lone Treeman is legal and has no command group.
    role: 'regiment',
    noCommand: true,
    pointsPerModel: 280,
    statLine: { M: 6, WS: 8, BS: 3, S: 6, T: 7, W: 6, I: 2, A: 4, Ld: 9 },
    specialRules: [
      'Causes fear',
      'Hatred of Orcs & Goblins',
      '0-1 per 1,000 pts',
    ],
  },
`

const only = (changes: Change[]) => {
  expect(changes).toHaveLength(1)
  return changes[0] as Change
}

describe('a points change', () => {
  test('is found with its unit and field', async () => {
    const changed = EMPIRE_UNITS.replace('pointsPerModel: 100,', 'pointsPerModel: 110,')
    const c = only(diffNumbers(EMPIRE_UNITS, changed))
    expect(c).toMatchObject({ where: 'emp-general', field: 'pointsPerModel', from: 100, to: 110 })
    expect(changeLine(c)).toBe('emp-general pointsPerModel: 100 -> 110')
  })

  test('stays with the right unit when two units share a field', async () => {
    const changed = EMPIRE_UNITS.replace('pointsPerModel: 80,', 'pointsPerModel: 85,')
    expect(only(diffNumbers(EMPIRE_UNITS, changed))).toMatchObject({
      where: 'emp-battle-standard',
      field: 'pointsPerModel',
      from: 80,
      to: 85,
    })
  })

  test('in a list of options reads the option, not the unit', async () => {
    const changed = NIBLIT.replace('points: 62', 'points: 60')
    expect(only(diffNumbers(NIBLIT, changed))).toMatchObject({ where: 'wolf-chariot', field: 'points', from: 62, to: 60 })
  })

  test('in a magic item line reads the item', async () => {
    const changed = MAGIC_ITEMS.replace('"points": 150', '"points": 140')
    expect(only(diffNumbers(MAGIC_ITEMS, changed))).toMatchObject({
      where: 'mi-sword-of-defiance',
      field: 'points',
      from: 150,
      to: 140,
    })
  })

  test('a fraction counts: a shield at half a point', async () => {
    const changed = OPTIONS.replace('pointsPerModel: 0.5', 'pointsPerModel: 1')
    expect(only(diffNumbers(OPTIONS, changed))).toMatchObject({ field: 'pointsPerModel', from: 0.5, to: 1 })
  })

  test('two options with one id are told apart by their constant', async () => {
    const changed = OPTIONS.replace('pointsPerModel: 0.5', 'pointsPerModel: 1')
    expect(only(diffNumbers(OPTIONS, changed)).where).toBe('SHIELD_HALF > shield')
  })

  test('a number in a table counts', async () => {
    const changed = MOVEMENT.replace('3: 8,', '3: 7,')
    expect(only(diffNumbers(MOVEMENT, changed))).toMatchObject({ where: 'MOVEMENT_CM', field: '3', from: 8, to: 7 })
  })

  test('a negative number counts', async () => {
    const before = "const o = { id: 'card-prices', pointsPerModel: -5 }"
    const c = only(diffNumbers(before, "const o = { id: 'card-prices', pointsPerModel: 0 }"))
    expect(c).toMatchObject({ from: -5, to: 0 })
  })
})

describe('a stat change', () => {
  test('in a helper call names the stat', async () => {
    const changed = EMPIRE_UNITS.replace('human({ WS: 6, BS: 6', 'human({ WS: 5, BS: 6')
    expect(only(diffNumbers(EMPIRE_UNITS, changed))).toMatchObject({
      where: 'emp-general',
      field: 'statLine.WS',
      from: 6,
      to: 5,
    })
  })

  test('in an inline stat line names the stat, under the companion it belongs to', async () => {
    const changed = NIBLIT.replace('S: 4, T: 3, W: 1, I: 3, A: 2, Ld: 5', 'S: 4, T: 3, W: 1, I: 3, A: 2, Ld: 6')
    expect(only(diffNumbers(NIBLIT, changed))).toMatchObject({ where: 'Niblit', field: 'statLine.Ld', from: 5, to: 6 })
  })

  test('several stats come back one by one, in file order', async () => {
    const changed = EMPIRE_UNITS.replace('W: 3, I: 6, A: 4, Ld: 9', 'W: 4, I: 6, A: 5, Ld: 9')
    const lines = diffNumbers(EMPIRE_UNITS, changed).map(changeLine)
    expect(lines).toEqual(['emp-general statLine.W: 3 -> 4', 'emp-general statLine.A: 4 -> 5'])
  })
})

describe('an edit that touches no value', () => {
  test('wording, comments and rule text', async () => {
    expect(diffNumbers(TREEMAN_BEFORE, TREEMAN_AFTER)).toEqual([])
    const reworded = EMPIRE_UNITS.replace("'May ride a Warhorse (+3 pts) or a Monster'", "'May ride a Warhorse (+4 pts), or a Monster'")
      .replace("name: 'General of the Empire'", "name: 'Empire General'")
      .replace('PERSONAJES (0-50%)', 'PERSONAJES (0-60%)')
      .replace("'Commander (up to 3 magic items)'", "'Commander (up to 4 magic items)'")
    expect(reworded).not.toBe(EMPIRE_UNITS)
    expect(diffNumbers(EMPIRE_UNITS, reworded)).toEqual([])
  })

  test('a page citation in a comment', async () => {
    const recited = NIBLIT.replace('Orcos y Goblins p.91 (OLD-71)', 'Orcos y Goblins p.92 (OLD-73)').replace('+65', '+66')
    expect(recited).not.toBe(NIBLIT)
    expect(diffNumbers(NIBLIT, recited)).toEqual([])
  })

  test('the text of a magic item', async () => {
    const reworded = MAGIC_ITEMS.replace('The wielder has Strength 10.', 'The wielder has Strength 9.').replace('Fuerza 10', 'Fuerza 9')
    expect(diffNumbers(MAGIC_ITEMS, reworded)).toEqual([])
  })

  test('layout: lines, quotes, commas, key order, 100 written as 100.0', async () => {
    const relaid = `const units: UnitProfile[] = [
  {
    "id": "emp-general", "name": "General of the Empire", "nameEs": "General del Imperio",
    "role": "character", "isCharacter": true, "characterRank": "lord", "canBeGeneral": true,
    "mounts": FIGHTER_MOUNTS,
    "statLine": human({
      Ld: 9,
      A: 4, I: 6, W: 3,
      T: 4, S: 4, BS: 6, WS: 6,
    }),
    "pointsPerModel": 100.0,
    "specialRules": ['Commander (up to 3 magic items)', 'Sword', 'May ride a Warhorse (+3 pts) or a Monster'],
  },
  { id: 'emp-battle-standard', name: 'Battle Standard Bearer', nameEs: 'Portaestandarte de Batalla', role: 'character',
    pointsPerModel: 80, statLine: human({ WS: 4, BS: 4, S: 4, T: 3, W: 1, I: 4, A: 2, Ld: 7 }), isCharacter: true, characterRank: 'champion' }
]
`
    expect(diffNumbers(EMPIRE_UNITS, relaid)).toEqual([])
  })

  test('entries in another order', async () => {
    const [first = '', second = ''] = MAGIC_ITEMS.split('\n').slice(1, 3)
    const swapped = ['export const COMMON_MAGIC_ITEMS: MagicItem[] = [', second, first, ']', ''].join('\n')
    expect(swapped).not.toBe(MAGIC_ITEMS)
    expect(diffNumbers(MAGIC_ITEMS, swapped)).toEqual([])
  })

  test('a renamed entry keeps its numbers', async () => {
    expect(diffNumbers(EMPIRE_UNITS, EMPIRE_UNITS.replace("id: 'emp-general'", "id: 'emp-lord-general'"))).toEqual([])
  })

  test('numbers lifted out into a shared constant', async () => {
    const before = `const A: MountOption = {
  id: 'mount-skeletal-steed', name: 'Skeletal Steed',
  points: 2, statLine: { M: 8, WS: 2, BS: 0, S: 3, T: 3, W: 1, I: 2, A: 1, Ld: 5 },
}
const B: MountOption = {
  id: 'mount-nightmare', name: 'Nightmare',
  points: 2, statLine: { M: 8, WS: 2, BS: 0, S: 3, T: 3, W: 1, I: 2, A: 1, Ld: 5 },
}
`
    const after = `const SKELETAL_STEED_STATS: StatLine = { M: 8, WS: 2, BS: 0, S: 3, T: 3, W: 1, I: 2, A: 1, Ld: 5 }
const A: MountOption = {
  id: 'mount-skeletal-steed', name: 'Skeletal Steed',
  points: 2, statLine: SKELETAL_STEED_STATS,
}
const B: MountOption = {
  id: 'mount-nightmare', name: 'Skeletal Steed',
  points: 2, statLine: SKELETAL_STEED_STATS,
}
`
    expect(diffNumbers(before, after)).toEqual([])
  })

  test('a file that did not change', async () => {
    expect(diffNumbers(EMPIRE_UNITS, EMPIRE_UNITS)).toEqual([])
  })
})

describe('what is not code', () => {
  test('text, comments and quotes never read as numbers', async () => {
    const src = `// pp. 54-66, 12 pts
/* 3 x 2 = 6 */
const x = { id: 'a', note: "it's 5 pts // not a comment", url: 'http://x/10', n: 7 } // 9
`
    expect(facts(src).map(f => [f.field, f.value])).toEqual([['n', 7]])
  })

  test('an unterminated quote does not swallow the rest of the file', async () => {
    const src = "const a = { id: 'x, n: 1 }\nconst b = { id: 'y', n: 2 }\n"
    expect(facts(src).map(f => f.value)).toContain(2)
  })

  test('tokens: numbers keep their value, signs and separators', async () => {
    const values = tokenize('a: [1_000, .5, 0x10, 2e3, -4, 3 - 1]').flatMap(t => (t.kind === 'num' ? [t.value] : []))
    expect(values).toEqual([1000, 0.5, 16, 2000, -4, 3, 1])
  })

  test('a malformed file does not throw', async () => {
    expect(() => diffNumbers('const a = { id: "x", n: 1', 'const a = { id: "x", n: 2 }}} )))')).not.toThrow()
    expect(diffNumbers('const a = { id: "x", n: 1', 'const a = { id: "x", n: 2 }}} )))')).toHaveLength(1)
  })
})

describe('added and removed numbers', () => {
  test('a new unit adds its numbers', async () => {
    const added = EMPIRE_UNITS.replace(
      '\n]\n',
      "\n  { id: 'emp-new', name: 'New', pointsPerModel: 9, statLine: human({ WS: 4 }) },\n]\n",
    )
    expect(diffNumbers(EMPIRE_UNITS, added).map(changeLine)).toEqual([
      'emp-new pointsPerModel: (new) -> 9',
      'emp-new statLine.WS: (new) -> 4',
    ])
  })

  test('a dropped option removes its number', async () => {
    const ratio = `    ratioCaps: [
      { unitId: 'we-treeman', perPoints: 1000, absoluteMax: 3, labelEn: 'Treeman', labelEs: 'Hombre Árbol' },
    ],
`
    const after = ratio.replace('absoluteMax: 3', 'countModels: true')
    expect(diffNumbers(ratio, after).map(changeLine)).toEqual(['we-treeman absoluteMax: 3 -> (removed)'])
  })

  test('a whole new file is all new', async () => {
    expect(diffNumbers('', MOVEMENT)).toHaveLength(5)
  })
})

describe('an edit seen as a fragment', () => {
  test('still finds the number, without a unit to name', async () => {
    const c = only(diffNumbers('pointsPerModel: 100,', 'pointsPerModel: 110,'))
    expect(c).toMatchObject({ where: '(top level)', field: 'pointsPerModel', from: 100, to: 110 })
  })

  test('applyEdit rebuilds the file from old_string and new_string', async () => {
    expect(applyEdit('a 1 a 1', 'a 1', 'b 2', false)).toBe('b 2 a 1')
    expect(applyEdit('a 1 a 1', 'a 1', 'b 2', true)).toBe('b 2 b 2')
    expect(applyEdit('abc', 'zzz', 'x', false)).toBeUndefined()
    expect(applyEdit('', '', 'new text', false)).toBe('new text')
  })
})

describe('files', () => {
  test('army data, the catalogue and the shared tables are data', async () => {
    for (const rel of [
      'src/data/armies/empire.ts',
      'src/data/armies/orcsGoblins.ts',
      'src/data/magicItems.ts',
      'src/data/unitOptions.ts',
      'src/data/movement.ts',
      'src/data/lores.ts',
    ]) {
      expect(kindOf(rel)).toBe('data')
    }
    expect(kindOf('CITATIONS.md')).toBe('citations')
  })

  test('tests, the assembly point, the integrity checks and everything else are not', async () => {
    for (const rel of [
      'src/data/armies/armies.test.ts',
      'src/data/armies/bookCorrections.test.ts',
      'src/data/armies/index.ts',
      'src/data/armies/integrity.ts',
      'src/data/types.ts',
      'src/data/rules.ts',
      'src/rules/points.ts',
      'docs/CITATIONS.md',
      'README.md',
    ]) {
      expect(kindOf(rel)).toBeUndefined()
    }
  })

  test('the path filter lets candidates through and nothing else', async () => {
    expect(mayMatter('/r/src/data/armies/empire.ts')).toBe(true)
    expect(mayMatter('/r/src/data/magicItems.ts')).toBe(true)
    expect(mayMatter('/r/CITATIONS.md')).toBe(true)
    expect(mayMatter('/r/src/App.tsx')).toBe(false)
    expect(mayMatter('/r/PROGRESS.md')).toBe(false)
  })
})

const change = (key: string, from: number | undefined, to: number | undefined, file = 'a'): Change => ({
  key: `${file}/${key}`,
  where: key,
  field: 'pointsPerModel',
  ...(from === undefined ? {} : { from }),
  ...(to === undefined ? {} : { to }),
})

describe('the ledger', () => {
  test('records a change under the current turn', async () => {
    const { ledger, fresh } = record(EMPTY_LEDGER, '/r', 'src/data/armies/empire.ts', [change('u1', 1, 2)])
    expect(fresh).toHaveLength(1)
    expect(ledger.entries).toMatchObject([{ root: '/r', file: 'src/data/armies/empire.ts', from: 1, to: 2, turn: 0, isCited: false }])
  })

  test('two edits of one number make one change from the first old value', async () => {
    const one = record(EMPTY_LEDGER, '/r', 'f', [change('u1', 1, 2)]).ledger
    const two = record(one, '/r', 'f', [change('u1', 2, 5)]).ledger
    expect(two.entries).toHaveLength(1)
    expect(two.entries[0]).toMatchObject({ from: 1, to: 5 })
  })

  test('a number put back is no change, and the edit that did it is not fresh', async () => {
    const one = record(EMPTY_LEDGER, '/r', 'f', [change('u1', 1, 2)]).ledger
    const back = record(one, '/r', 'f', [change('u1', 2, 1)])
    expect(back.ledger.entries).toEqual([])
    expect(back.fresh).toEqual([])
    expect(hasTurnWork(back.ledger)).toBe(false)
  })

  test('a number added and then removed is no change', async () => {
    const one = record(EMPTY_LEDGER, '/r', 'f', [change('u1', undefined, 4)]).ledger
    expect(record(one, '/r', 'f', [change('u1', 4, undefined)]).ledger.entries).toEqual([])
  })

  test('the same number in another file or repo is its own change', async () => {
    const one = record(EMPTY_LEDGER, '/r', 'f', [change('u1', 1, 2)]).ledger
    const two = record(one, '/r', 'g', [change('u1', 1, 2)]).ledger
    const three = record(two, '/s', 'f', [change('u1', 1, 2)]).ledger
    expect(three.entries).toHaveLength(3)
  })

  test('citing covers what is open in that repo, and what the turn adds after', async () => {
    const open = record(EMPTY_LEDGER, '/r', 'f', [change('u1', 1, 2)]).ledger
    const elsewhere = record(open, '/s', 'f', [change('u1', 1, 2)]).ledger
    const cited = cite(elsewhere, '/r')
    expect(cited.entries.map(e => [e.root, e.isCited])).toEqual([
      ['/r', true],
      ['/s', false],
    ])
    const later = record(cited, '/r', 'f', [change('u2', 3, 4)]).ledger
    expect(later.entries.find(e => e.key === 'a/u2')?.isCited).toBe(true)
  })

  test('the turn ends with a report of the uncited repos and files, then starts clean', async () => {
    let l: Ledger = record(EMPTY_LEDGER, '/r', 'src/data/armies/empire.ts', [change('u1', 1, 2)]).ledger
    l = record(l, '/r', 'src/data/magicItems.ts', [change('u2', 1, 2)]).ledger
    l = record(l, '/r', 'src/data/armies/empire.ts', [change('u3', 1, 2)]).ledger
    expect(hasTurnWork(l)).toBe(true)

    const ended = endTurn(l)
    expect(ended.report).toEqual([{ root: '/r', files: ['src/data/armies/empire.ts', 'src/data/magicItems.ts'] }])
    expect(ended.ledger).toMatchObject({ turn: 1, citedRoots: [] })
    expect(ended.ledger.entries).toHaveLength(3)
    expect(endTurn(ended.ledger).report).toEqual([])
  })

  test('a repo that was cited this turn is left out of the report', async () => {
    let l: Ledger = record(EMPTY_LEDGER, '/r', 'f', [change('u1', 1, 2)]).ledger
    l = record(l, '/s', 'f', [change('u1', 1, 2)]).ledger
    l = cite(l, '/r')
    expect(endTurn(l).report).toEqual([{ root: '/s', files: ['f'] }])
  })

  test('an old change is not reported again, but is listed until it is cited', async () => {
    const l = record(EMPTY_LEDGER, '/r', 'f', [change('u1', 1, 2)]).ledger
    const next = endTurn(l).ledger
    expect(endTurn(next).report).toEqual([])
    expect(listText(next)).toContain('u1 pointsPerModel: 1 -> 2')
    expect(listText(cite(next, '/r'))).toBe('Citation guard: no uncited value changes this session.')
  })

  test('keeps the newest 400 entries', async () => {
    const many = Array.from({ length: 450 }, (_, i) => change(`u${i}`, 1, 2))
    const { ledger } = record(EMPTY_LEDGER, '/r', 'f', many)
    expect(ledger.entries).toHaveLength(400)
    expect(ledger.entries[0]?.key).toBe('a/u50')
  })
})

describe('what is shown', () => {
  const changes = [
    { key: 'k1', where: 'emp-general', field: 'pointsPerModel', from: 100, to: 110 },
    { key: 'k2', where: 'emp-general', field: 'statLine.WS', from: 6, to: 5 },
  ] satisfies Change[]

  test('the note for the model names the file, the values and what to do', async () => {
    const note = contextNote('src/data/armies/empire.ts', changes, false)
    expect(note).toContain('changed game values in src/data/armies/empire.ts')
    expect(note).toContain('- emp-general pointsPerModel: 100 -> 110')
    expect(note).toContain('- emp-general statLine.WS: 6 -> 5')
    expect(note).toContain('CITATIONS.md')
    expect(note).toContain('book page')
    expect(note).toContain('same turn')
  })

  test('the note says so when CITATIONS.md was already edited this turn', async () => {
    const note = contextNote('src/data/armies/empire.ts', changes, true)
    expect(note).toContain('already edited this turn')
    expect(note).not.toContain('Add that entry')
  })

  test('long lists are cut', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, where: 'u', field: `f${i}`, from: 1, to: 2 }))
    const lines = describeChanges(many, 15)
    expect(lines).toHaveLength(16)
    expect(lines[15]).toBe('and 5 more')
  })

  test('the toast names the files without the data folder', async () => {
    expect(toastText([{ root: '/w/warhammer', files: ['src/data/armies/empire.ts'] }])).toBe(
      'Citation guard: values changed in armies/empire.ts, but CITATIONS.md was not edited this turn. /citation-guard lists them.',
    )
    expect(toastText([{ root: '/w/warhammer', files: ['src/data/armies/empire.ts', 'src/data/magicItems.ts'] }])).toContain(
      'armies/empire.ts and magicItems.ts',
    )
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(n => `src/data/armies/${n}.ts`)
    expect(toastText([{ root: '/w/warhammer', files: six }])).toContain('armies/a.ts, armies/b.ts, armies/c.ts, armies/d.ts and 2 more')
  })

  test('the toast says which repo when there are several', async () => {
    const text = toastText([
      { root: '/w/warhammer', files: ['src/data/magicItems.ts'] },
      { root: '/w/wt/old-76', files: ['src/data/magicItems.ts'] },
    ])
    expect(text).toContain('warhammer:magicItems.ts and old-76:magicItems.ts')
  })

  test('the list gives file, old value and new value', async () => {
    let l: Ledger = record(EMPTY_LEDGER, '/w/warhammer', 'src/data/armies/empire.ts', changes).ledger
    l = record(l, '/w/warhammer', 'src/data/magicItems.ts', [{ key: 'm', where: 'mi-sword-of-death', field: 'points', from: 100, to: 90 }]).ledger
    expect(listText(l)).toBe(
      [
        'Citation guard: 3 uncited value changes in 2 files this session (old -> new).',
        '',
        'src/data/armies/empire.ts',
        '  emp-general pointsPerModel: 100 -> 110',
        '  emp-general statLine.WS: 6 -> 5',
        '',
        'src/data/magicItems.ts',
        '  mi-sword-of-death points: 100 -> 90',
        '',
        'CITATIONS.md has not been edited since these changes. Each corrected value needs an entry there with its book page.',
      ].join('\n'),
    )
  })
})
