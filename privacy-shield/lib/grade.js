// Per-site privacy grade, A (no trackers seen) to F (heavy cross-site tracking).
// The grade describes what the site tries to load, not what got through, so it stays
// stable whether or not protection is on; `exposure` reports what actually got through.

export const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F'];

const SEVERITY = { advertising: 2, analytics: 1, social: 1.5, fingerprinting: 3, sessionReplay: 3, learned: 1.5 };

/**
 * @param {{domain:string, category:string, blocked:number, allowed:number}[]} trackers
 * @param {{params?:number, banner?:boolean}} [extra]
 */
export function gradeSite(trackers, extra = {}) {
  const list = Array.isArray(trackers) ? trackers : [];
  let score = 0;
  const cats = new Set();
  for (const t of list) {
    score += SEVERITY[t.category] ?? 1;
    cats.add(t.category);
  }
  if (extra.params) score += 0.5;
  let grade;
  if (list.length === 0) grade = extra.params ? 'B' : 'A';
  else if (score <= 3) grade = 'B';
  else if (score <= 10) grade = 'C';
  else if (score <= 24) grade = 'D';
  else grade = 'F';
  // Fingerprinting or session replay is never better than C.
  if ((cats.has('fingerprinting') || cats.has('sessionReplay')) && GRADE_ORDER.indexOf(grade) < 2) grade = 'C';
  const allowed = list.filter((t) => t.allowed > 0 && !t.blocked);
  const exposure = allowed.length === 0 ? 'none' : allowed.length <= 2 ? 'low' : allowed.length <= 6 ? 'medium' : 'high';
  return { grade, score: Math.round(score * 10) / 10, trackers: list.length, categories: [...cats], exposure, unblocked: allowed.length };
}

export function gradeLabel(grade) {
  return {
    A: 'No trackers detected',
    B: 'Light tracking',
    C: 'Moderate tracking',
    D: 'Heavy tracking',
    F: 'Extreme tracking',
  }[grade] || 'Unknown';
}
