// Command catalog shared by the editor, player and importer.
// target: whether the command uses a selector ('required' | 'optional' | 'none' | 'text')
// value:  hint for the value column ('' means unused)
export const COMMANDS = {
  open:           { group: 'Navigation', label: 'Navigate to URL', target: 'text', targetHint: 'https://example.com', value: '' },
  goBack:         { group: 'Navigation', label: 'Go back', target: 'none', value: '' },
  refresh:        { group: 'Navigation', label: 'Reload page', target: 'none', value: '' },

  click:          { group: 'Interaction', label: 'Click element', target: 'required', value: '' },
  doubleClick:    { group: 'Interaction', label: 'Double-click element', target: 'required', value: '' },
  type:           { group: 'Interaction', label: 'Type text (set value)', target: 'required', value: 'Text to enter' },
  typeKeys:       { group: 'Interaction', label: 'Type text (keystrokes)', target: 'required', value: 'Text typed key by key' },
  pressKey:       { group: 'Interaction', label: 'Press key', target: 'optional', value: 'Enter, Tab, Escape, ArrowDown...' },
  select:         { group: 'Interaction', label: 'Select option', target: 'required', value: 'label=Text, value=v, index=0 or text' },
  check:          { group: 'Interaction', label: 'Check checkbox / radio', target: 'required', value: '' },
  uncheck:        { group: 'Interaction', label: 'Uncheck checkbox', target: 'required', value: '' },
  submit:         { group: 'Interaction', label: 'Submit form', target: 'required', value: '' },
  hover:          { group: 'Interaction', label: 'Hover element', target: 'required', value: '' },
  scroll:         { group: 'Interaction', label: 'Scroll', target: 'optional', value: 'x,y (window) or empty to scroll element into view' },

  waitForElement: { group: 'Waiting', label: 'Wait for element', target: 'required', value: 'Timeout ms (optional)' },
  waitForVisible: { group: 'Waiting', label: 'Wait until visible', target: 'required', value: 'Timeout ms (optional)' },
  waitForGone:    { group: 'Waiting', label: 'Wait until element is gone', target: 'required', value: 'Timeout ms (optional)' },
  pause:          { group: 'Waiting', label: 'Wait (ms)', target: 'none', value: 'Milliseconds, e.g. 1000' },

  assertText:     { group: 'Checks', label: 'Assert text contains', target: 'required', value: 'Expected text or /regex/' },
  assertExists:   { group: 'Checks', label: 'Assert element exists', target: 'required', value: '' },
  assertUrl:      { group: 'Checks', label: 'Assert URL contains', target: 'none', value: 'Expected text or /regex/' },
  assertTitle:    { group: 'Checks', label: 'Assert title contains', target: 'none', value: 'Expected text or /regex/' },

  extract:        { group: 'Data', label: 'Extract text into variable', target: 'required', value: 'varName or varName@attribute' },
  extractAll:     { group: 'Data', label: 'Extract all matches (list)', target: 'required', value: 'varName or varName@attribute' },
  set:            { group: 'Data', label: 'Set variable', target: 'text', targetHint: 'Variable name', value: 'Value (supports ${vars})' },
  echo:           { group: 'Data', label: 'Log message', target: 'none', value: 'Message (supports ${vars})' },
  screenshot:     { group: 'Data', label: 'Take screenshot', target: 'none', value: 'Name (optional)' },

  if:             { group: 'Flow', label: 'If element exists', target: 'required', value: 'Wait ms before deciding (default 0)', block: 'open' },
  ifNot:          { group: 'Flow', label: 'If element does not exist', target: 'required', value: 'Wait ms before deciding (default 0)', block: 'open' },
  ifVar:          { group: 'Flow', label: 'If variable matches', target: 'text', targetHint: '${var}', value: 'Expected text, /regex/, or empty = non-empty', block: 'open' },
  else:           { group: 'Flow', label: 'Else', target: 'none', value: '', block: 'mid' },
  loop:           { group: 'Flow', label: 'Loop N times', target: 'none', value: 'Number of iterations', block: 'open' },
  csvLoop:        { group: 'Flow', label: 'Loop over CSV rows', target: 'none', value: 'Optional row range, e.g. 1-10', block: 'open' },
  break:          { group: 'Flow', label: 'Break out of loop', target: 'none', value: '' },
  end:            { group: 'Flow', label: 'End (if / loop)', target: 'none', value: '', block: 'close' },
  stop:           { group: 'Flow', label: 'Stop macro', target: 'none', value: 'Reason (optional)' },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

export function newStep(command = 'click', target = '', value = '') {
  return { id: uid(), command, target, targets: target ? [target] : [], value, comment: '', disabled: false };
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Pairs block commands. Returns { ok, errors, pairs } where pairs[i] = { else?, end?, open? }.
 */
export function analyzeBlocks(steps) {
  const pairs = steps.map(() => ({}));
  const stack = [];
  const errors = [];
  const depth = [];
  steps.forEach((s, i) => {
    const meta = COMMANDS[s.command];
    if (s.disabled || !meta) { depth[i] = stack.length; return; }
    if (meta.block === 'open') {
      depth[i] = stack.length;
      stack.push(i);
    } else if (meta.block === 'mid') {
      const top = stack[stack.length - 1];
      if (top === undefined || !['if', 'ifNot', 'ifVar'].includes(steps[top].command)) {
        errors.push({ index: i, message: '"else" without matching "if"' });
        depth[i] = stack.length;
      } else if (pairs[top].else !== undefined) {
        errors.push({ index: i, message: 'Second "else" for the same "if"' });
        depth[i] = stack.length - 1;
      } else {
        pairs[top].else = i; pairs[i].open = top; depth[i] = stack.length - 1;
      }
    } else if (meta.block === 'close') {
      const top = stack.pop();
      if (top === undefined) { errors.push({ index: i, message: '"end" without an open block' }); depth[i] = 0; }
      else {
        pairs[top].end = i; pairs[i].open = top; depth[i] = stack.length;
        if (pairs[top].else !== undefined) pairs[pairs[top].else].end = i;
      }
    } else {
      depth[i] = stack.length;
    }
  });
  for (const i of stack) errors.push({ index: i, message: `"${steps[i].command}" is missing its "end"` });
  return { ok: errors.length === 0, errors, pairs, depth };
}
