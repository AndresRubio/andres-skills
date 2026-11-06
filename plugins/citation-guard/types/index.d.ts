// One game number that an edit added, changed or removed in a data file.
export type Change = {
  // Where the number sits in the file: stays the same when the file is
  // reformatted or the entries are reordered.
  key: string
  // The entry it belongs to ("emp-general", "emp-halberdiers > shield").
  where: string
  // Which number it is ("pointsPerModel", "statLine.WS").
  field: string
  // Absent: the number is new. `to` absent: the number is gone.
  from?: number
  to?: number
}

// A change the session made, until CITATIONS.md is edited after it.
export type Entry = Change & {
  root: string
  // Path from the repo root.
  file: string
  turn: number
  isCited: boolean
}

export type Ledger = {
  // Counts main-loop turns. Entries of the turn that is running carry it.
  turn: number
  entries: Entry[]
  // Repo roots whose CITATIONS.md was edited in the turn that is running.
  citedRoots: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'citation-guard': { ledger: Shaped<Ledger> }
  }
}
