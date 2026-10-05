// Turns a free-form snippet ("5 miles", "72°F", "3pm PST", "0xFF",
// "1700000000") into a list of conversions. Used by the selection tooltip
// (through the service worker) and the popup's quick-convert box.

import { parseQuantity, quantityConversions, formatNumber, unitSymbol, CATEGORIES } from './units.js';
import {
  parseTimeWithZone, formatInZone, zoneOffset, formatOffset, cityLabel, localZone,
  parsePrefixedInteger, toBase, parseUnixTimestamp, relativeTime, groupDigits,
} from './timeutil.js';

/**
 * @param {string} text
 * @param {{now?:number, zones?:string[], homeZone?:string, locale?:string}} ctx
 * @returns {{kind:string, title:string, items:{label:string,value:string}[]}|null}
 */
export function convertText(text, ctx = {}) {
  if (!text) return null;
  const s = String(text).trim();
  if (!s || s.length > 60) return null;
  const now = ctx.now ?? Date.now();
  const locale = ctx.locale;

  const q = parseQuantity(s);
  if (q) {
    const items = quantityConversions(q).map(r => ({
      label: r.unit.label,
      value: `${formatNumber(r.value, { locale })} ${unitSymbol(r.unit)}`,
    }));
    if (items.length) {
      return {
        kind: 'unit',
        category: q.category,
        title: `${formatNumber(q.value, { locale })} ${unitSymbol(q.unit)} (${CATEGORIES[q.category].label.toLowerCase()})`,
        items,
      };
    }
  }

  const t = parseTimeWithZone(s, now);
  if (t) {
    const home = ctx.homeZone || localZone();
    const zones = [home, ...(ctx.zones || []).filter(z => z !== home)].slice(0, 6);
    const items = zones.map((zone, i) => ({
      label: i === 0 ? `Your time (${cityLabel(zone)})` : cityLabel(zone),
      value: `${formatInZone(t.ms, zone, { locale, withDate: true })} · ${formatOffset(zoneOffset(t.ms, zone))}`,
    }));
    items.push({ label: 'UTC', value: new Date(t.ms).toISOString().replace('.000', '') });
    return { kind: 'time', title: `${s} → ${cityLabel(home)}`, items, ms: t.ms };
  }

  const p = parsePrefixedInteger(s);
  if (p) {
    const items = [
      { label: 'Decimal', value: groupDigits(p.value.toString(10), 3, ',') },
      { label: 'Hex', value: '0x' + toBase(p.value, 16).toUpperCase() },
      { label: 'Binary', value: '0b' + groupDigits(toBase(p.value, 2), 4) },
      { label: 'Octal', value: '0o' + toBase(p.value, 8) },
    ].filter(it => it.label.toLowerCase() !== { 16: 'hex', 2: 'binary', 8: 'octal' }[p.base]);
    return { kind: 'base', title: s, items };
  }

  // Bare 10- or 13-digit numbers in a plausible range are probably unix timestamps.
  if (/^\d{10}(?:\d{3})?$/.test(s)) {
    const ts = parseUnixTimestamp(s);
    const year = ts && new Date(ts.ms).getUTCFullYear();
    if (ts && year >= 1990 && year <= 2100) {
      return {
        kind: 'timestamp',
        title: `Unix timestamp (${ts.unit})`,
        items: [
          { label: 'Local', value: new Date(ts.ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' }) },
          { label: 'UTC', value: new Date(ts.ms).toISOString().replace('.000Z', 'Z') },
          { label: 'Relative', value: relativeTime(ts.ms, now, locale) },
        ],
      };
    }
  }
  return null;
}
