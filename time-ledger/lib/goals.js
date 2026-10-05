// Daily goals (reach at least N minutes) and limits (stay under N minutes).
// goal: { id, kind: 'goal'|'limit', scope: 'total'|'category'|'domain'|'project', target, minutes, enabled }

import { dur } from './report.js';
import { MIN } from './util.js';

export function goalLabel(goal, projects = []) {
  const what = {
    total: 'All browsing',
    category: `${(goal.target || '').replace(/^./, (c) => c.toUpperCase())} sites`,
    domain: goal.target,
    project: (projects.find((p) => p.id === goal.target) || {}).name || 'Unknown project',
  }[goal.scope] || goal.target;
  return `${goal.kind === 'limit' ? 'Limit' : 'Goal'}: ${what}`;
}

function matches(goal, it) {
  switch (goal.scope) {
    case 'total': return it.source === 'auto';
    case 'category': return it.source === 'auto' && it.category === goal.target;
    case 'domain': {
      const t = String(goal.target || '').toLowerCase().replace(/^www\./, '');
      return it.source === 'auto' && !!t && (it.domain === t || String(it.domain).endsWith('.' + t));
    }
    // Project goals count both automatic and manual time.
    case 'project': return it.projectId === goal.target;
    default: return false;
  }
}

/** Evaluate goals against one day's items. */
export function evaluateGoals(goals = [], items = []) {
  return goals.filter((g) => g.enabled !== false && +g.minutes > 0).map((g) => {
    const ms = items.filter((it) => matches(g, it)).reduce((a, it) => a + dur(it), 0);
    const targetMs = +g.minutes * MIN;
    const pct = targetMs ? ms / targetMs : 0;
    let status;
    if (g.kind === 'limit') status = ms > targetMs ? 'exceeded' : pct >= 0.8 ? 'warning' : 'ok';
    else status = ms >= targetMs ? 'reached' : 'progress';
    return { goal: g, ms, targetMs, pct, status };
  });
}

/**
 * Which notifications to fire now, given what was already notified today.
 * Returns [{ id, key, title, message }]; `key` is what to remember as notified.
 */
export function pendingNotifications(results, notified = {}, projects = []) {
  const out = [];
  for (const r of results) {
    if (r.goal.notify === false) continue;
    const label = goalLabel(r.goal, projects);
    const mins = Math.round(r.ms / MIN);
    if (r.status === 'exceeded' && !notified[r.goal.id + ':exceeded']) {
      out.push({ id: r.goal.id, key: r.goal.id + ':exceeded', title: 'Daily limit exceeded',
        message: `${label}: ${mins} min today (limit ${r.goal.minutes} min).` });
    } else if (r.status === 'warning' && !notified[r.goal.id + ':warning'] && !notified[r.goal.id + ':exceeded']) {
      out.push({ id: r.goal.id, key: r.goal.id + ':warning', title: 'Approaching daily limit',
        message: `${label}: ${mins} of ${r.goal.minutes} min used.` });
    } else if (r.status === 'reached' && !notified[r.goal.id + ':reached']) {
      out.push({ id: r.goal.id, key: r.goal.id + ':reached', title: 'Daily goal reached',
        message: `${label}: ${mins} min today. Nice work.` });
    }
  }
  return out;
}
