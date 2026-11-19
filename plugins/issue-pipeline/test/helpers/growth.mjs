// Linear time is checked as growth, never as a time limit: a limit in milliseconds fails on a busy
// machine (the 200 KB scan in hydrate takes 60 ms alone and took 750 ms with the suite running under
// load). Four times the input may take up to eight times as long; a quadratic scan takes sixteen.
// Each size is timed five times, the two sizes in turn so that a busy moment falls on both, and the
// best times are compared. A scan under 5 ms counts as 5 so that noise near zero cannot fail the
// test. A failed comparison is measured once more: load passes, a quadratic scan stays quadratic.
// The clock is this process's CPU time. Wall-clock time also counts the wait for a free core, and
// a long run waits for one more often than a short one: with 30 busy processes on 10 cores, a
// linear loop measured up to 16.6 times as long at four times the size and the check failed 14
// times in 48, where its CPU time grew 4.0 to 4.2 times and the check never failed.
const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

// run(size) does the work for one input size; n is the small size and 4 * n the big one.
// Returns { ok, small, big } with the best CPU times in whole milliseconds.
export function growsLinearly(run, n) {
  const time = (size) => {
    const t0 = cpuMs();
    run(size);
    return cpuMs() - t0;
  };
  const measure = () => {
    let small = Infinity;
    let big = Infinity;
    for (let round = 0; round < 5; round += 1) {
      small = Math.min(small, time(n));
      big = Math.min(big, time(4 * n));
    }
    return { ok: big < 8 * Math.max(small, 5), small: Math.round(small), big: Math.round(big) };
  };
  const first = measure();
  return first.ok ? first : measure();
}
