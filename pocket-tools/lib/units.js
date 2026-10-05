// Unit definitions and conversion. Each linear unit has a factor to the
// category's base unit; temperature uses explicit formulas.

const u = (id, label, factor, aliases, system, to) => ({ id, label, factor, aliases, system, to });

export const CATEGORIES = {
  length: {
    label: 'Length',
    base: 'm',
    units: [
      u('mm', 'millimetres', 0.001, ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'], 'metric', ['in']),
      u('cm', 'centimetres', 0.01, ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'], 'metric', ['in', 'ft']),
      u('m', 'metres', 1, ['m', 'meter', 'meters', 'metre', 'metres'], 'metric', ['ft', 'yd']),
      u('km', 'kilometres', 1000, ['km', 'kms', 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'klick', 'klicks'], 'metric', ['mi']),
      u('in', 'inches', 0.0254, ['in', 'inch', 'inches', '"', '″', "''"], 'imperial', ['cm', 'mm']),
      u('ft', 'feet', 0.3048, ['ft', 'foot', 'feet', "'", '′'], 'imperial', ['m', 'cm']),
      u('yd', 'yards', 0.9144, ['yd', 'yds', 'yard', 'yards'], 'imperial', ['m']),
      u('mi', 'miles', 1609.344, ['mi', 'mile', 'miles'], 'imperial', ['km', 'm']),
      u('nmi', 'nautical miles', 1852, ['nmi', 'nautical mile', 'nautical miles'], 'other', ['km', 'mi']),
    ],
  },
  mass: {
    label: 'Mass',
    base: 'kg',
    units: [
      u('mg', 'milligrams', 1e-6, ['mg', 'milligram', 'milligrams'], 'metric', ['oz']),
      u('g', 'grams', 0.001, ['g', 'gr', 'gram', 'grams', 'gramme', 'grammes'], 'metric', ['oz']),
      u('kg', 'kilograms', 1, ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'], 'metric', ['lb']),
      u('t', 'tonnes', 1000, ['t', 'tonne', 'tonnes', 'metric ton', 'metric tons'], 'metric', ['lb', 'ton']),
      u('oz', 'ounces', 0.028349523125, ['oz', 'ounce', 'ounces'], 'imperial', ['g']),
      u('lb', 'pounds', 0.45359237, ['lb', 'lbs', 'pound', 'pounds'], 'imperial', ['kg']),
      u('st', 'stone', 6.35029318, ['st', 'stone', 'stones'], 'imperial', ['kg', 'lb']),
      u('ton', 'US tons', 907.18474, ['ton', 'tons', 'short ton', 'short tons'], 'imperial', ['t', 'kg']),
    ],
  },
  temperature: {
    label: 'Temperature',
    base: 'c',
    units: [
      u('c', '°C', null, ['°c', 'c', 'celsius', 'centigrade', 'degc', 'degrees celsius', 'degree celsius', 'deg c', '℃'], 'metric', ['f']),
      u('f', '°F', null, ['°f', 'f', 'fahrenheit', 'degf', 'degrees fahrenheit', 'degree fahrenheit', 'deg f', '℉'], 'imperial', ['c']),
      u('k', 'K', null, ['k', 'kelvin', 'kelvins'], 'other', ['c', 'f']),
    ],
  },
  volume: {
    label: 'Volume',
    base: 'l',
    units: [
      u('ml', 'millilitres', 0.001, ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc', 'cm3'], 'metric', ['floz', 'tsp']),
      u('l', 'litres', 1, ['l', 'liter', 'liters', 'litre', 'litres', 'ltr'], 'metric', ['gal', 'qt']),
      u('m3', 'cubic metres', 1000, ['m3', 'cubic meter', 'cubic meters', 'cubic metre', 'cubic metres'], 'metric', ['gal', 'ft3']),
      u('tsp', 'teaspoons', 0.00492892159375, ['tsp', 'teaspoon', 'teaspoons'], 'imperial', ['ml']),
      u('tbsp', 'tablespoons', 0.01478676478125, ['tbsp', 'tablespoon', 'tablespoons'], 'imperial', ['ml']),
      u('floz', 'US fluid ounces', 0.0295735295625, ['fl oz', 'floz', 'fluid ounce', 'fluid ounces', 'fl. oz'], 'imperial', ['ml']),
      u('cup', 'US cups', 0.2365882365, ['cup', 'cups'], 'imperial', ['ml']),
      u('pt', 'US pints', 0.473176473, ['pt', 'pint', 'pints'], 'imperial', ['ml', 'l']),
      u('qt', 'US quarts', 0.946352946, ['qt', 'quart', 'quarts'], 'imperial', ['l']),
      u('gal', 'US gallons', 3.785411784, ['gal', 'gallon', 'gallons', 'us gal'], 'imperial', ['l']),
      u('impgal', 'imperial gallons', 4.54609, ['imp gal', 'imperial gallon', 'imperial gallons', 'uk gallon', 'uk gallons'], 'imperial', ['l', 'gal']),
      u('ft3', 'cubic feet', 0.028316846592, ['ft3', 'cu ft', 'cubic foot', 'cubic feet'], 'imperial', ['l', 'm3']),
    ],
  },
  area: {
    label: 'Area',
    base: 'm2',
    units: [
      u('cm2', 'square centimetres', 1e-4, ['cm2', 'sq cm', 'square centimeter', 'square centimeters', 'square centimetre', 'square centimetres'], 'metric', ['in2']),
      u('m2', 'square metres', 1, ['m2', 'sq m', 'sqm', 'square meter', 'square meters', 'square metre', 'square metres'], 'metric', ['ft2']),
      u('ha', 'hectares', 1e4, ['ha', 'hectare', 'hectares'], 'metric', ['acre']),
      u('km2', 'square kilometres', 1e6, ['km2', 'sq km', 'square kilometer', 'square kilometers', 'square kilometre', 'square kilometres'], 'metric', ['mi2']),
      u('in2', 'square inches', 0.00064516, ['in2', 'sq in', 'square inch', 'square inches'], 'imperial', ['cm2']),
      u('ft2', 'square feet', 0.09290304, ['ft2', 'sq ft', 'sqft', 'square foot', 'square feet'], 'imperial', ['m2']),
      u('yd2', 'square yards', 0.83612736, ['yd2', 'sq yd', 'square yard', 'square yards'], 'imperial', ['m2']),
      u('acre', 'acres', 4046.8564224, ['acre', 'acres', 'ac'], 'imperial', ['ha', 'm2']),
      u('mi2', 'square miles', 2589988.110336, ['mi2', 'sq mi', 'square mile', 'square miles'], 'imperial', ['km2']),
    ],
  },
  speed: {
    label: 'Speed',
    base: 'mps',
    units: [
      u('mps', 'metres/second', 1, ['m/s', 'mps', 'meters per second', 'metres per second'], 'metric', ['kmh', 'mph']),
      u('kmh', 'km/h', 1 / 3.6, ['km/h', 'kmh', 'kph', 'kmph', 'km/hr', 'kilometers per hour', 'kilometres per hour'], 'metric', ['mph']),
      u('mph', 'mph', 0.44704, ['mph', 'mi/h', 'miles per hour', 'mile per hour'], 'imperial', ['kmh']),
      u('fps', 'feet/second', 0.3048, ['ft/s', 'fps', 'feet per second'], 'imperial', ['mps']),
      u('kn', 'knots', 1852 / 3600, ['kn', 'kt', 'kts', 'knot', 'knots'], 'other', ['kmh', 'mph']),
    ],
  },
  data: {
    label: 'Data',
    base: 'B',
    units: [
      u('bit', 'bits', 0.125, ['bit', 'bits'], 'other', ['B']),
      u('B', 'bytes', 1, ['b', 'byte', 'bytes'], 'other', ['KiB']),
      u('KB', 'kilobytes', 1e3, ['kb', 'kilobyte', 'kilobytes'], 'decimal', ['KiB']),
      u('MB', 'megabytes', 1e6, ['mb', 'megabyte', 'megabytes'], 'decimal', ['MiB']),
      u('GB', 'gigabytes', 1e9, ['gb', 'gigabyte', 'gigabytes'], 'decimal', ['GiB']),
      u('TB', 'terabytes', 1e12, ['tb', 'terabyte', 'terabytes'], 'decimal', ['TiB', 'GB']),
      u('PB', 'petabytes', 1e15, ['pb', 'petabyte', 'petabytes'], 'decimal', ['PiB', 'TB']),
      u('KiB', 'kibibytes', 1024, ['kib', 'kibibyte', 'kibibytes'], 'binary', ['KB']),
      u('MiB', 'mebibytes', 1024 ** 2, ['mib', 'mebibyte', 'mebibytes'], 'binary', ['MB']),
      u('GiB', 'gibibytes', 1024 ** 3, ['gib', 'gibibyte', 'gibibytes'], 'binary', ['GB']),
      u('TiB', 'tebibytes', 1024 ** 4, ['tib', 'tebibyte', 'tebibytes'], 'binary', ['TB']),
      u('PiB', 'pebibytes', 1024 ** 5, ['pib', 'pebibyte', 'pebibytes'], 'binary', ['PB']),
    ],
  },
  time: {
    label: 'Time',
    base: 's',
    units: [
      u('ms', 'milliseconds', 0.001, ['ms', 'msec', 'millisecond', 'milliseconds'], 'other', ['s']),
      u('s', 'seconds', 1, ['s', 'sec', 'secs', 'second', 'seconds'], 'other', ['min']),
      u('min', 'minutes', 60, ['min', 'mins', 'minute', 'minutes'], 'other', ['h', 's']),
      u('h', 'hours', 3600, ['h', 'hr', 'hrs', 'hour', 'hours'], 'other', ['min', 'd']),
      u('d', 'days', 86400, ['d', 'day', 'days'], 'other', ['h', 'wk']),
      u('wk', 'weeks', 604800, ['wk', 'wks', 'week', 'weeks'], 'other', ['d']),
      u('mo', 'months', 2629746, ['mo', 'month', 'months'], 'other', ['wk', 'd']),
      u('yr', 'years', 31556952, ['yr', 'yrs', 'year', 'years'], 'other', ['d', 'wk']),
    ],
  },
};

// alias -> { category, unit }
const ALIASES = new Map();
for (const [category, def] of Object.entries(CATEGORIES)) {
  for (const unit of def.units) {
    unit.category = category;
    for (const a of unit.aliases) {
      if (!ALIASES.has(a)) ALIASES.set(a, unit);
    }
  }
}

export function getUnit(category, id) {
  const def = CATEGORIES[category];
  return def ? def.units.find(x => x.id === id) || null : null;
}

export function normalizeUnitText(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/\^([23])/g, '$1')
    .replace(/\s*\/\s*/g, '/')
    .replace(/^square\s+/, 'square ')
    .replace(/^sq\.?\s*/, 'sq ')
    .replace(/^cu\.?\s*/, 'cu ')
    .replace(/^(?:deg(?:rees?)?\.?\s*|°\s*)(c|f|celsius|fahrenheit)$/, '°$1')
    .replace(/\.$/, '')
    .replace(/\s+/g, ' ');
}

export function findUnit(text) {
  const norm = normalizeUnitText(text);
  if (ALIASES.has(norm)) return ALIASES.get(norm);
  // "sq ft" written as "ft2" style or "feet squared".
  const squared = norm.match(/^(.+?) squared$/);
  if (squared) return findUnit('sq ' + squared[1]);
  if (norm.startsWith('°')) return ALIASES.get(norm.slice(1)) || null;
  return null;
}

function toCelsius(value, from) {
  if (from === 'c') return value;
  if (from === 'f') return (value - 32) * 5 / 9;
  if (from === 'k') return value - 273.15;
  throw new Error('Unknown temperature unit ' + from);
}

function fromCelsius(value, to) {
  if (to === 'c') return value;
  if (to === 'f') return value * 9 / 5 + 32;
  if (to === 'k') return value + 273.15;
  throw new Error('Unknown temperature unit ' + to);
}

export function convert(value, category, fromId, toId) {
  const v = Number(value);
  if (!Number.isFinite(v)) return NaN;
  if (category === 'temperature') return fromCelsius(toCelsius(v, fromId), toId);
  const from = getUnit(category, fromId);
  const to = getUnit(category, toId);
  if (!from || !to) throw new Error(`Unknown unit ${fromId} or ${toId} in ${category}`);
  return (v * from.factor) / to.factor;
}

export function convertAll(value, category, fromId) {
  return CATEGORIES[category].units.map(unit => ({ unit, value: convert(value, category, fromId, unit.id) }));
}

// Pretty number with up to `digits` significant digits; avoids "1e-7" noise.
export function formatNumber(n, { digits = 6, locale } = {}) {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-6) return n.toExponential(Math.max(0, digits - 1)).replace(/\.?0+e/, 'e');
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: digits }).format(n);
}

function unitSymbol(unit) {
  const short = { c: '°C', f: '°F', k: 'K', m2: 'm²', cm2: 'cm²', km2: 'km²', in2: 'in²', ft2: 'ft²', yd2: 'yd²', mi2: 'mi²', m3: 'm³', ft3: 'ft³', floz: 'fl oz', impgal: 'imp gal', mps: 'm/s', kmh: 'km/h', fps: 'ft/s' };
  return short[unit.id] || unit.id;
}
export { unitSymbol };

const NUMBER = String.raw`[-−+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[-−+]?\.\d+`;
const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

export function parseNumber(str) {
  let s = String(str).trim().replace(/−/g, '-');
  let extra = 0;
  const lastCh = s.slice(-1);
  if (FRACTIONS[lastCh] !== undefined) { extra = FRACTIONS[lastCh]; s = s.slice(0, -1).trim() || '0'; }
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n + (n < 0 ? -extra : extra) : NaN;
}

/**
 * Parse a quantity such as "5 miles", "72°F", "3.5kg", "5'11\"", "1,200 sq ft".
 * Returns { value, unit, category } or null.
 */
export function parseQuantity(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/\s+/g, ' ');
  if (s.length > 60) return null;
  // Feet and inches: 5'11", 5 ft 11 in
  const fi = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|′|ft|feet|foot)\s*(\d+(?:\.\d+)?)\s*(?:"|″|''|in|inch|inches)?$/i);
  if (fi) {
    return { value: Number(fi[1]) * 12 + Number(fi[2]), unit: getUnit('length', 'in'), category: 'length', display: s };
  }
  const m = s.match(new RegExp(`^(${NUMBER})\\s*([½¼¾⅓⅔⅛])?\\s*(.+)$`));
  if (!m) return null;
  const value = parseNumber(m[1] + (m[2] || ''));
  if (!Number.isFinite(value)) return null;
  const unit = findUnit(m[3]);
  if (!unit) return null;
  return { value, unit, category: unit.category, display: s };
}

export function quantityConversions(q) {
  const targets = q.unit.to.map(id => getUnit(q.category, id)).filter(Boolean);
  return targets.map(t => ({
    unit: t,
    value: convert(q.value, q.category, q.unit.id, t.id),
  }));
}
