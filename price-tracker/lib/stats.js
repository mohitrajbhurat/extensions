/* Price Tracker: history statistics and deal verdicts.
 * Classic script exposing `PriceStats` on globalThis (also CommonJS for node:test).
 * History points: { t: epoch ms, p: price|null, a: 'in_stock'|'out_of_stock'|'unknown', s?: source }
 */
(function (root) {
  'use strict';

  const DAY = 86400000;

  function validPoints(history) {
    return (history || []).filter(h => h && typeof h.p === 'number' && isFinite(h.p) && h.p > 0)
      .sort((a, b) => a.t - b.t);
  }

  /**
   * Compute statistics over a history. The average is time-weighted (each price counts for
   * as long as it was the current price) so a burst of checks does not skew it.
   */
  function computeStats(history, opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    let pts = validPoints(history);
    if (opts.windowDays) {
      const from = now - opts.windowDays * DAY;
      const before = pts.filter(p => p.t < from);
      pts = pts.filter(p => p.t >= from);
      // Carry the last price before the window so the window starts with a known price.
      if (before.length) pts.unshift({ ...before[before.length - 1], t: from });
    }
    if (!pts.length) {
      return { count: 0, current: null, min: null, max: null, avg: null, pctVsAvg: null, minAt: null, maxAt: null, first: null, spanDays: 0 };
    }
    let min = Infinity, max = -Infinity, minAt = null, maxAt = null;
    for (const p of pts) {
      if (p.p < min) { min = p.p; minAt = p.t; }
      if (p.p > max) { max = p.p; maxAt = p.t; }
    }
    let weighted = 0, totalW = 0;
    for (let i = 0; i < pts.length; i++) {
      const end = i + 1 < pts.length ? pts[i + 1].t : Math.max(now, pts[i].t);
      const w = Math.max(end - pts[i].t, 0);
      weighted += pts[i].p * w;
      totalW += w;
    }
    const simple = pts.reduce((s, p) => s + p.p, 0) / pts.length;
    const avg = totalW > 0 ? weighted / totalW : simple;
    const last = pts[pts.length - 1];
    const current = last.p;
    const prev = pts.length > 1 ? findPreviousDifferent(pts) : null;
    return {
      count: pts.length,
      current,
      currentAt: last.t,
      previous: prev,
      min, max, minAt, maxAt,
      avg: Math.round(avg * 100) / 100,
      pctVsAvg: avg ? ((current - avg) / avg) * 100 : null,
      pctVsMin: min ? ((current - min) / min) * 100 : null,
      first: pts[0].p,
      firstAt: pts[0].t,
      spanDays: (Math.max(now, last.t) - pts[0].t) / DAY,
    };
  }

  function findPreviousDifferent(pts) {
    const cur = pts[pts.length - 1].p;
    for (let i = pts.length - 2; i >= 0; i--) if (pts[i].p !== cur) return pts[i].p;
    return null;
  }

  /**
   * Decide whether the current price is a good deal.
   * @returns {{level:'great'|'good'|'fair'|'high'|'unknown', label:string, detail:string}}
   */
  function verdict(stats, opts) {
    opts = opts || {};
    const threshold = opts.goodDealPct != null ? opts.goodDealPct : 5;
    if (!stats || !stats.count || stats.current == null) {
      return { level: 'unknown', label: 'No data yet', detail: 'No price has been recorded yet.' };
    }
    const { current, min, max, avg, pctVsAvg, spanDays, count } = stats;
    if (count < 2 || spanDays < 2 || min === max) {
      if (min === max && count >= 2 && spanDays >= 14) {
        return { level: 'fair', label: 'Stable price', detail: `Unchanged for ${Math.round(spanDays)} days.` };
      }
      return { level: 'unknown', label: 'Collecting history', detail: 'Need a few days of history to judge this price.' };
    }
    const range = max - min;
    const posInRange = range > 0 ? (current - min) / range : 0;
    const vsAvg = Math.round(Math.abs(pctVsAvg));
    if (current <= min * 1.01) {
      return { level: 'great', label: current < min + 1e-9 && current === min ? 'All-time low' : 'Near all-time low', detail: `${vsAvg}% below the average price.` };
    }
    if (pctVsAvg <= -threshold || posInRange <= 0.2) {
      return { level: 'good', label: 'Good deal', detail: `${vsAvg}% below the average price.` };
    }
    if (pctVsAvg < threshold) {
      return { level: 'fair', label: 'Typical price', detail: `Within ${Math.max(vsAvg, 1)}% of the average price.` };
    }
    return { level: 'high', label: 'Above average', detail: `${vsAvg}% above the average. Consider waiting.` };
  }

  /**
   * Compare a store's claimed discount ("was" / list price) with recorded history.
   * Returns null when there is nothing to say.
   */
  function saleCheck(current, listPrice, stats) {
    if (!current || !listPrice || listPrice <= current) return null;
    const claimed = ((listPrice - current) / listPrice) * 100;
    if (!stats || stats.count < 2 || stats.spanDays < 7 || !stats.avg) {
      return { claimed, real: null, honest: null, text: `Store claims ${Math.round(claimed)}% off. Not enough history to verify yet.` };
    }
    const real = ((stats.avg - current) / stats.avg) * 100;
    const listSeen = stats.max >= listPrice * 0.98;
    let honest = real >= claimed * 0.6 && listSeen;
    let text;
    if (real <= 1) text = `Store claims ${Math.round(claimed)}% off, but this is not below the usual price.`;
    else if (!listSeen) text = `Store claims ${Math.round(claimed)}% off, but the "was" price was never seen. Real saving vs average: ${Math.round(real)}%.`;
    else if (!honest) text = `Store claims ${Math.round(claimed)}% off; real saving vs average is ${Math.round(real)}%.`;
    else text = `Genuine sale: ${Math.round(real)}% below the average price.`;
    return { claimed, real, honest, text };
  }

  /** Should an alert fire for target? target = {type:'price'|'percent'|'any'|'none', value} */
  function targetPrice(target, baseline) {
    if (!target || target.type === 'none') return null;
    if (target.type === 'price') return Number(target.value) > 0 ? Number(target.value) : null;
    if (target.type === 'percent') {
      const pct = Number(target.value);
      return baseline && pct > 0 && pct < 100 ? Math.round(baseline * (1 - pct / 100) * 100) / 100 : null;
    }
    if (target.type === 'any') return baseline ? baseline - 0.005 : null;
    return null;
  }

  /**
   * Evaluate alerts for a new observation against the existing history (before adding it).
   * Returns a list of { kind: 'target'|'low'|'stock', ... } and the new alert state.
   */
  function evaluateAlerts(item, obs) {
    const alerts = [];
    const pts = validPoints(item.history);
    const state = { ...(item.alertState || {}) };
    const prevAll = (item.history || []).filter(h => h).sort((a, b) => a.t - b.t);
    const prevObs = prevAll[prevAll.length - 1];

    if (obs.a === 'in_stock' && prevObs && prevObs.a === 'out_of_stock') {
      alerts.push({ kind: 'stock' });
    }
    if (typeof obs.p === 'number' && obs.p > 0) {
      if (pts.length) {
        const prevMin = Math.min(...pts.map(p => p.p));
        if (obs.p < prevMin - 0.004 && obs.a !== 'out_of_stock') alerts.push({ kind: 'low', previousLow: prevMin });
      }
      const tp = targetPrice(item.target, item.baselinePrice);
      if (tp != null) {
        const hit = obs.p <= tp + 0.004 && obs.a !== 'out_of_stock';
        if (hit && !state.targetHit) alerts.push({ kind: 'target', targetPrice: tp });
        state.targetHit = hit;
      } else {
        state.targetHit = false;
      }
    }
    return { alerts, state };
  }

  const api = { computeStats, verdict, saleCheck, targetPrice, evaluateAlerts, validPoints, DAY };
  root.PriceStats = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
