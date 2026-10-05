/* Accessibility Auditor - rule engine.
 * Classic script injected after lib/color.js, lib/aria.js and lib/accname.js.
 * Exposes window.A11Y.engine with run(options) returning a serialisable report for
 * this frame. Elements referenced by the report are kept in A11Y.state.refs so the
 * extension UI can ask the page to scroll to and outline them later.
 */
(function (root) {
  'use strict';
  const A11Y = (root.A11Y = root.A11Y || {});
  const VERSION = 1;
  if (A11Y.engine && A11Y.engine.version === VERSION) return;

  const HOST_ID = '__a11y-auditor-root';
  const MAX_PER_RULE = 250;

  // WCAG 2.2 success criteria used by the rules: [name, Understanding slug, level].
  const SC = {
    '1.1.1': ['Non-text Content', 'non-text-content', 'A'],
    '1.2.2': ['Captions (Prerecorded)', 'captions-prerecorded', 'A'],
    '1.3.1': ['Info and Relationships', 'info-and-relationships', 'A'],
    '1.3.5': ['Identify Input Purpose', 'identify-input-purpose', 'AA'],
    '1.4.2': ['Audio Control', 'audio-control', 'A'],
    '1.4.3': ['Contrast (Minimum)', 'contrast-minimum', 'AA'],
    '1.4.4': ['Resize Text', 'resize-text', 'AA'],
    '1.4.6': ['Contrast (Enhanced)', 'contrast-enhanced', 'AAA'],
    '2.1.1': ['Keyboard', 'keyboard', 'A'],
    '2.2.1': ['Timing Adjustable', 'timing-adjustable', 'A'],
    '2.2.2': ['Pause, Stop, Hide', 'pause-stop-hide', 'A'],
    '2.4.1': ['Bypass Blocks', 'bypass-blocks', 'A'],
    '2.4.2': ['Page Titled', 'page-titled', 'A'],
    '2.4.3': ['Focus Order', 'focus-order', 'A'],
    '2.4.4': ['Link Purpose (In Context)', 'link-purpose-in-context', 'A'],
    '2.4.6': ['Headings and Labels', 'headings-and-labels', 'AA'],
    '2.4.7': ['Focus Visible', 'focus-visible', 'AA'],
    '2.4.9': ['Link Purpose (Link Only)', 'link-purpose-link-only', 'AAA'],
    '2.5.3': ['Label in Name', 'label-in-name', 'A'],
    '2.5.8': ['Target Size (Minimum)', 'target-size-minimum', 'AA'],
    '3.1.1': ['Language of Page', 'language-of-page', 'A'],
    '3.1.2': ['Language of Parts', 'language-of-parts', 'AA'],
    '3.3.2': ['Labels or Instructions', 'labels-or-instructions', 'A'],
    '4.1.2': ['Name, Role, Value', 'name-role-value', 'A'],
  };

  const RULES = [];
  /**
   * id, title, impact (critical|serious|moderate|minor), wcag [sc...], level
   * ('A'|'AA'|'AAA'|'best-practice'), description, fix, scope ('top' runs only in
   * the top-level document), run(ctx).
   */
  function rule(def) {
    RULES.push(def);
  }

  // ---------------------------------------------------------------- helpers
  let D, C, ARIA;

  function lc(s) {
    return (s == null ? '' : String(s)).trim().toLowerCase();
  }

  function collectElements(doc) {
    const out = [];
    const shadowHosts = [];
    function walk(node) {
      const kids = node.children;
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (el.id === HOST_ID) continue;
        out.push(el);
        if (el.shadowRoot) {
          shadowHosts.push(el);
          walk(el.shadowRoot);
        }
        walk(el);
      }
    }
    if (doc.documentElement) {
      out.push(doc.documentElement);
      walk(doc.documentElement);
    }
    return { all: out, shadowHosts };
  }

  function headingLevel(el) {
    const al = parseInt(D.attr(el, 'aria-level'), 10);
    if (D.attr(el, 'role') && lc(D.attr(el, 'role')).split(/\s+/)[0] === 'heading') return al > 0 ? al : 2;
    const m = /^H([1-6])$/.exec(D.tag(el));
    if (m) return al > 0 ? al : +m[1];
    return al > 0 ? al : 2;
  }

  function explicitRole(el) {
    const raw = lc(D.attr(el, 'role'));
    if (!raw) return null;
    for (const t of raw.split(/\s+/)) if (ARIA.isValidRole(t)) return t;
    return null;
  }

  const NATIVE_INTERACTIVE = /^(A|AREA|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|OPTION|LABEL|DETAILS|IFRAME|VIDEO|AUDIO|EMBED|OBJECT)$/;

  function isNativeInteractive(el) {
    const t = D.tag(el);
    if (!NATIVE_INTERACTIVE.test(t)) return false;
    if ((t === 'A' || t === 'AREA') && !el.hasAttribute('href')) return false;
    if ((t === 'VIDEO' || t === 'AUDIO') && !el.hasAttribute('controls')) return false;
    return true;
  }

  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[n];
  }

  function closest(word, list) {
    let best = null;
    let bestD = 3;
    for (const w of list) {
      const d = levenshtein(word, w);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  // BCP 47 shape check: language[-script][-region][-variant...][-extension][-private].
  const LANG_RE = /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[a-wyz\d](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?$|^x(?:-[a-z\d]{1,8})+$|^i-[a-z]+$/i;

  function validLang(v) {
    return LANG_RE.test(String(v).trim());
  }

  const AUTOCOMPLETE_FIELDS = new Set([
    'name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix',
    'nickname', 'username', 'new-password', 'current-password', 'one-time-code', 'organization-title',
    'organization', 'street-address', 'address-line1', 'address-line2', 'address-line3',
    'address-level4', 'address-level3', 'address-level2', 'address-level1', 'country',
    'country-name', 'postal-code', 'cc-name', 'cc-given-name', 'cc-additional-name',
    'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type',
    'transaction-currency', 'transaction-amount', 'language', 'bday', 'bday-day', 'bday-month',
    'bday-year', 'sex', 'url', 'photo', 'tel', 'tel-country-code', 'tel-national',
    'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension',
    'email', 'impp',
  ]);
  const AUTOCOMPLETE_CONTACT = new Set(['tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp']);

  function validAutocomplete(value) {
    const tokens = lc(value).split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    if (tokens.length === 1 && (tokens[0] === 'on' || tokens[0] === 'off')) return true;
    let i = 0;
    if (/^section-/.test(tokens[i])) i++;
    if (tokens[i] === 'shipping' || tokens[i] === 'billing') i++;
    let contact = false;
    if (/^(home|work|mobile|fax|pager)$/.test(tokens[i] || '')) {
      contact = true;
      i++;
    }
    const field = tokens[i];
    if (!field || !AUTOCOMPLETE_FIELDS.has(field)) return false;
    if (contact && !AUTOCOMPLETE_CONTACT.has(field)) return false;
    i++;
    if (tokens[i] === 'webauthn') i++;
    return i === tokens.length;
  }

  const AMBIGUOUS_LINK = new Set([
    'click here', 'here', 'click', 'more', 'read more', 'learn more', 'more info',
    'more information', 'details', 'link', 'this link', 'go', 'continue', 'click this',
    'see more', 'this', 'info', 'find out more', 'view more', 'view', 'tap here', 'press here',
  ]);
  const SUSPICIOUS_ALT = new Set([
    'image', 'img', 'picture', 'photo', 'photograph', 'graphic', 'icon', 'spacer', 'blank',
    'alt', 'alt text', 'untitled', 'null', 'undefined', 'placeholder', 'thumbnail', 'banner',
  ]);

  // ---------------------------------------------------------------- context
  function makeContext(doc, win, options) {
    const { all, shadowHosts } = collectElements(doc);
    const hiddenCache = new Map();
    const styleCache = new Map();
    const nameCache = new Map();
    const roleCache = new Map();
    const issues = [];
    const counts = {};
    const ctx = {
      doc, win, all, shadowHosts, options, issues,
      isTop: (function () {
        try {
          return win.top === win;
        } catch (e) {
          return false;
        }
      })(),
      style(el) {
        let s = styleCache.get(el);
        if (!s) {
          s = win.getComputedStyle(el);
          styleCache.set(el, s);
        }
        return s;
      },
      hidden(el) {
        let h = hiddenCache.get(el);
        if (h === undefined) {
          h = D.isHiddenFromAT(el);
          hiddenCache.set(el, h);
        }
        return h;
      },
      visible(el) {
        return !ctx.hidden(el) && D.isRendered(el);
      },
      name(el) {
        let n = nameCache.get(el);
        if (!n) {
          try {
            n = D.accessibleName(el);
          } catch (e) {
            n = { name: '', source: 'none' };
          }
          nameCache.set(el, n);
        }
        return n;
      },
      role(el) {
        let r = roleCache.get(el);
        if (r === undefined) {
          r = D.role(el);
          roleCache.set(el, r);
        }
        return r;
      },
      q(test) {
        return typeof test === 'string' ? all.filter((el) => el.matches(test)) : all.filter(test);
      },
      byId(rootNode, id) {
        try {
          return rootNode.getElementById ? rootNode.getElementById(id) : doc.getElementById(id);
        } catch (e) {
          return null;
        }
      },
      report(ruleId, el, message, extra) {
        counts[ruleId] = (counts[ruleId] || 0) + 1;
        if (counts[ruleId] > MAX_PER_RULE) return;
        issues.push(Object.assign({ rule: ruleId, el, message, kind: 'violation' }, extra || {}));
      },
      review(ruleId, el, message, extra) {
        ctx.report(ruleId, el, message, Object.assign({ kind: 'review' }, extra || {}));
      },
      counts,
    };
    return ctx;
  }

  // ================================================================ RULES
  // ---- Colour contrast ----------------------------------------------------
  function textElements(ctx) {
    const out = [];
    for (const el of ctx.all) {
      const t = D.tag(el);
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|TITLE|META|LINK|SVG|OPTION|OPTGROUP|IFRAME|CANVAS|VIDEO|AUDIO|OBJECT)$/.test(t)) continue;
      if (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      let has = false;
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && /[^\s​ ]/.test(n.nodeValue)) {
          has = true;
          break;
        }
      }
      if (t === 'INPUT') {
        const type = lc(el.getAttribute('type') || 'text');
        if (/^(text|email|tel|url|search|password|number|button|submit|reset)$/.test(type) && (el.value || (type !== 'text' && type !== 'email' && type !== 'tel' && type !== 'url' && type !== 'search' && type !== 'password' && type !== 'number'))) has = true;
      }
      if (t === 'TEXTAREA' || t === 'SELECT') has = !!(el.value || el.textContent.trim());
      if (has) out.push(el);
    }
    return out;
  }

  function isDisabledText(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.disabled === true) return true;
      if (lc(n.getAttribute('aria-disabled')) === 'true') return true;
      if (n.matches && n.matches('fieldset[disabled] *')) return true;
      n = n.parentElement;
    }
    // A <label> for a disabled control is "inactive" too.
    if (D.tag(el) === 'LABEL' && el.control && el.control.disabled) return true;
    return false;
  }

  function contrastPass(ctx) {
    if (ctx._contrast) return ctx._contrast;
    const out = [];
    const reviewsPerOwner = new Map();
    for (const el of textElements(ctx)) {
      if (ctx.hidden(el) || !D.isRendered(el)) continue;
      const st = ctx.style(el);
      if (parseFloat(st.fontSize) === 0) continue;
      if (D.isOffscreen(el)) continue;
      if (isDisabledText(el)) continue;
      const fgRaw = C.parse(st.color);
      if (fgRaw && fgRaw.a === 0) continue;
      let bg;
      try {
        bg = C.effectiveBackground(el, ctx.win);
      } catch (e) {
        continue;
      }
      const fg = C.textColor(el, ctx.win, bg.color, bg.opacity);
      const ratio = C.contrast(fg, bg.color);
      const large = C.isLargeText(st.fontSize, st.fontWeight);
      out.push({
        el, ratio, large, fg: C.hex(fg), bg: C.hex(bg.color),
        incomplete: bg.hasImage, imageOwner: bg.imageOwner,
        shadow: st.textShadow && st.textShadow !== 'none',
        fontSize: st.fontSize, fontWeight: st.fontWeight, reviewsPerOwner,
      });
    }
    ctx._contrast = out;
    return out;
  }

  function fmtRatio(r) {
    return (Math.floor(r * 100) / 100).toFixed(2) + ':1';
  }

  function contrastRule(ctx, ruleId, normal, largeReq) {
    for (const c of contrastPass(ctx)) {
      const need = c.large ? largeReq : normal;
      if (c.ratio + 1e-6 >= need) continue;
      if (ruleId === 'color-contrast-enhanced') {
        // Only report what AA did not already flag.
        if (c.ratio + 1e-6 < (c.large ? 3 : 4.5)) continue;
      }
      const data = { ratio: +c.ratio.toFixed(2), fg: c.fg, bg: c.bg, required: need, large: c.large, fontSize: c.fontSize, fontWeight: c.fontWeight };
      const desc = `Contrast ${fmtRatio(c.ratio)} (${c.fg} on ${c.bg}); ${c.large ? 'large' : 'normal'} text needs ${need}:1.`;
      if (c.incomplete) {
        // Text over an image or gradient: the computed colour is only the fallback.
        if (ruleId !== 'color-contrast') continue;
        const owner = c.imageOwner || c.el;
        const seen = c.reviewsPerOwner.get(owner) || 0;
        if (seen >= 3) continue;
        c.reviewsPerOwner.set(owner, seen + 1);
        ctx.review(ruleId, c.el, `Text sits on a background image or gradient. ${desc} Check against the image manually.`, { data });
      } else if (c.shadow) {
        ctx.review(ruleId, c.el, `${desc} The text has a text-shadow that may provide enough contrast; verify visually.`, { data });
      } else {
        ctx.report(ruleId, c.el, desc, { data });
      }
    }
  }

  rule({
    id: 'color-contrast', title: 'Text has insufficient colour contrast', impact: 'serious', wcag: ['1.4.3'], level: 'AA',
    description: 'Text must have a contrast ratio of at least 4.5:1 against its background (3:1 for large text: 24px, or 18.66px bold). The background is computed by compositing every ancestor layer, including opacity.',
    fix: 'Darken the text or lighten the background (or vice versa) until the ratio meets the threshold. Use a contrast checker to pick compliant colours from your palette.',
    run: (ctx) => contrastRule(ctx, 'color-contrast', 4.5, 3),
  });
  rule({
    id: 'color-contrast-enhanced', title: 'Text does not meet enhanced contrast (AAA)', impact: 'minor', wcag: ['1.4.6'], level: 'AAA',
    description: 'At level AAA, text needs 7:1 contrast (4.5:1 for large text).',
    fix: 'Increase the contrast between text and background to 7:1 (4.5:1 for large text).',
    run: (ctx) => contrastRule(ctx, 'color-contrast-enhanced', 7, 4.5),
  });

  // ---- Text alternatives --------------------------------------------------
  function hasAuthorName(el) {
    return !!(D.trimText(D.attr(el, 'aria-label')) || D.idRefs(el, 'aria-labelledby').some((r) => r.el) || D.trimText(D.attr(el, 'title')));
  }

  rule({
    id: 'image-alt', title: 'Image has no text alternative', impact: 'critical', wcag: ['1.1.1'], level: 'A',
    description: 'Every <img> needs an alt attribute. Informative images need a concise description; decorative images need alt="".',
    fix: 'Add alt="description of the image" or, if the image is purely decorative, alt="" so screen readers skip it.',
    run(ctx) {
      for (const el of ctx.q('img')) {
        if (ctx.hidden(el)) continue;
        if (el.hasAttribute('alt')) continue;
        const r = explicitRole(el);
        if (r === 'presentation' || r === 'none') continue;
        if (hasAuthorName(el)) continue;
        ctx.report('image-alt', el, 'Image has no alt attribute, aria-label or title.');
      }
    },
  });

  rule({
    id: 'image-alt-suspicious', title: 'Image alt text looks unhelpful', impact: 'minor', wcag: ['1.1.1'], level: 'A',
    description: 'Alt text should describe the image\'s purpose. File names, generic words such as "image", and text that repeats the adjacent caption do not help.',
    fix: 'Rewrite the alt text to convey the same information as the image, or use alt="" if the surrounding text already says it.',
    run(ctx) {
      for (const el of ctx.q('img[alt], input[type="image" i][alt]')) {
        if (ctx.hidden(el)) continue;
        const alt = D.trimText(el.getAttribute('alt'));
        if (!alt) continue;
        const a = alt.toLowerCase();
        let why = '';
        if (/\.(png|jpe?g|gif|svg|webp|avif|bmp|tiff?|ico)$/i.test(a) || /^(img|dsc|image|screenshot)[-_ ]?\d+/i.test(a)) why = `Alt "${alt}" looks like a file name.`;
        else if (SUSPICIOUS_ALT.has(a)) why = `Alt "${alt}" is a generic word that does not describe the image.`;
        else if (/^(image|picture|photo|graphic) of\b/i.test(a)) why = `Alt "${alt}" starts with "${a.split(' ')[0]} of"; screen readers already announce it as an image.`;
        else if (alt.length > 150) why = `Alt text is ${alt.length} characters long; consider a shorter alt plus a longer description nearby.`;
        else {
          const link = el.closest('a, button');
          const fig = el.closest('figure');
          const cap = fig && fig.querySelector('figcaption');
          if (cap && D.trimText(cap.textContent).toLowerCase() === a) why = 'Alt text repeats the figure caption, so it is read twice.';
          else if (link && D.trimText(link.textContent).toLowerCase() === a) why = 'Alt text repeats the adjacent link text, so it is read twice.';
        }
        if (why) ctx.review('image-alt-suspicious', el, why);
      }
    },
  });

  rule({
    id: 'input-image-alt', title: 'Image button has no text alternative', impact: 'critical', wcag: ['1.1.1', '4.1.2'], level: 'A',
    description: '<input type="image"> acts as a button, so its alt text is the button\'s name.',
    fix: 'Add an alt attribute describing the action, for example alt="Search".',
    run(ctx) {
      for (const el of ctx.q('input[type="image" i]')) {
        if (ctx.hidden(el)) continue;
        if (!ctx.name(el).name) ctx.report('input-image-alt', el, 'Image button has no alt, aria-label or title.');
      }
    },
  });

  rule({
    id: 'area-alt', title: 'Image map area has no text alternative', impact: 'critical', wcag: ['1.1.1', '2.4.4'], level: 'A',
    description: 'Each <area href> in an image map is a link and needs alt text describing its destination.',
    fix: 'Add alt text to every <area> element.',
    run(ctx) {
      for (const el of ctx.q('area[href]')) {
        const map = el.closest('map');
        if (map && map.name && !ctx.doc.querySelector(`img[usemap="#${CSS.escape(map.name)}"]`)) continue;
        if (!D.trimText(el.getAttribute('alt')) && !hasAuthorName(el)) ctx.report('area-alt', el, 'Image map area has no alt text.');
      }
    },
  });

  rule({
    id: 'role-img-alt', title: 'Element with role="img" has no name', impact: 'serious', wcag: ['1.1.1'], level: 'A',
    description: 'SVGs and other elements exposed as images need an accessible name via aria-label, aria-labelledby or an SVG <title>.',
    fix: 'Add aria-label="description" (or a <title> as the first child of the <svg>), or mark decorative graphics with aria-hidden="true".',
    run(ctx) {
      for (const el of ctx.all) {
        if (D.tag(el) === 'IMG') continue;
        const r = explicitRole(el);
        if (r !== 'img' && r !== 'image' && r !== 'graphics-document' && r !== 'graphics-symbol') continue;
        if (ctx.hidden(el)) continue;
        if (!ctx.name(el).name) ctx.report('role-img-alt', el, `Element with role="${r}" has no accessible name.`);
      }
    },
  });

  rule({
    id: 'object-alt', title: '<object> has no text alternative', impact: 'serious', wcag: ['1.1.1'], level: 'A',
    description: 'Embedded objects need an accessible name or fallback content.',
    fix: 'Add aria-label, aria-labelledby or title to the <object>, or provide fallback text inside it.',
    run(ctx) {
      for (const el of ctx.q('object')) {
        if (ctx.hidden(el) || !D.isRendered(el)) continue;
        if (hasAuthorName(el) || D.trimText(el.textContent)) continue;
        ctx.report('object-alt', el, '<object> has no accessible name or fallback text.');
      }
    },
  });

  rule({
    id: 'server-side-image-map', title: 'Server-side image map', impact: 'minor', wcag: ['2.1.1'], level: 'A',
    description: 'Server-side image maps (img ismap) can only be operated with a mouse.',
    fix: 'Replace with a client-side image map (<map>/<area>) or ordinary links.',
    run(ctx) {
      for (const el of ctx.q('img[ismap]')) ctx.report('server-side-image-map', el, 'Image uses a server-side image map.');
    },
  });

  // ---- Links and buttons --------------------------------------------------
  function linksIn(ctx) {
    return ctx.all.filter((el) => {
      const r = ctx.role(el);
      if (r !== 'link') return false;
      if (D.tag(el) === 'AREA') return false;
      return !ctx.hidden(el);
    });
  }

  rule({
    id: 'link-name', title: 'Link has no accessible name', impact: 'serious', wcag: ['2.4.4', '4.1.2'], level: 'A',
    description: 'Links need discernible text so screen-reader users know where they lead. Icon-only links are the usual culprit.',
    fix: 'Add visible link text, an aria-label, or alt text on the image inside the link.',
    run(ctx) {
      for (const el of linksIn(ctx)) {
        if (!ctx.name(el).name) ctx.report('link-name', el, 'Link has no text, aria-label, or image alt.');
      }
    },
  });

  rule({
    id: 'link-ambiguous', title: 'Link text is ambiguous', impact: 'moderate', wcag: ['2.4.4'], level: 'A',
    description: 'Link text like "click here" or "read more" does not describe its destination when links are listed out of context.',
    fix: 'Make the link text describe the destination ("Read more about pricing"), or add context with aria-label or aria-describedby.',
    run(ctx) {
      for (const el of linksIn(ctx)) {
        const n = ctx.name(el);
        const text = lc(n.name).replace(/[.…!?:»>›→\s]+$/u, '').replace(/^[«<‹←\s]+/u, '');
        if (!AMBIGUOUS_LINK.has(text)) continue;
        if (el.hasAttribute('aria-describedby')) continue;
        ctx.review('link-ambiguous', el, `Link text "${n.name}" does not describe the destination on its own.`);
      }
    },
  });

  rule({
    id: 'identical-links-same-purpose', title: 'Links with the same name go to different places', impact: 'minor', wcag: ['2.4.9'], level: 'AAA',
    description: 'Links that share a name should lead to the same destination, otherwise users cannot tell them apart.',
    fix: 'Give each link a name that reflects its specific destination.',
    run(ctx) {
      const groups = new Map();
      for (const el of linksIn(ctx)) {
        const name = lc(ctx.name(el).name);
        if (!name || !el.href) continue;
        const href = String(el.href).replace(/#.*$/, '').replace(/\/$/, '');
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push({ el, href });
      }
      for (const [name, list] of groups) {
        const hrefs = new Set(list.map((x) => x.href));
        if (hrefs.size < 2) continue;
        for (const x of list.slice(1)) {
          if (x.href !== list[0].href) ctx.review('identical-links-same-purpose', x.el, `${hrefs.size} links named "${name}" lead to ${hrefs.size} different URLs.`);
        }
      }
    },
  });

  rule({
    id: 'skip-link', title: 'Skip link target does not exist', impact: 'moderate', wcag: ['2.4.1'], level: 'A',
    description: 'A "skip to content" link only works if the element it points to exists.',
    fix: 'Point the link at the id of the main content container, and make sure that id exists.',
    run(ctx) {
      for (const el of ctx.q('a[href^="#"]')) {
        const href = el.getAttribute('href');
        if (href.length < 2 || /^#[!/]/.test(href)) continue;
        const text = lc(el.textContent + ' ' + (el.getAttribute('aria-label') || ''));
        if (!/\b(skip|jump)\b/.test(text)) continue;
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch (e) { /* keep raw */ }
        const rootNode = el.getRootNode();
        if (!ctx.byId(rootNode, id) && !ctx.doc.getElementsByName(id).length) ctx.report('skip-link', el, `Skip link points to "#${id}", which does not exist.`);
      }
    },
  });

  const BUTTONISH = (el, ctx) => {
    const t = D.tag(el);
    if (t === 'INPUT') {
      const type = lc(el.getAttribute('type'));
      return /^(button|submit|reset)$/.test(type);
    }
    if (t === 'SUMMARY') {
      const details = el.parentElement;
      return details && D.tag(details) === 'DETAILS' && details.querySelector(':scope > summary') === el;
    }
    return ctx.role(el) === 'button';
  };

  rule({
    id: 'button-name', title: 'Button has no accessible name', impact: 'critical', wcag: ['4.1.2'], level: 'A',
    description: 'Buttons need a name that says what they do. Icon-only buttons often have none.',
    fix: 'Add visible text, an aria-label, or alt text on the icon image inside the button.',
    run(ctx) {
      for (const el of ctx.all) {
        if (!BUTTONISH(el, ctx)) continue;
        if (D.tag(el) === 'INPUT' && lc(el.getAttribute('type')) === 'image') continue;
        if (ctx.hidden(el)) continue;
        if (!ctx.name(el).name) ctx.report('button-name', el, `${D.tag(el) === 'SUMMARY' ? 'Disclosure summary' : 'Button'} has no text, aria-label, value or title.`);
      }
    },
  });

  rule({
    id: 'nested-interactive', title: 'Interactive controls are nested', impact: 'serious', wcag: ['4.1.2'], level: 'A',
    description: 'Focusable elements inside a link or button (or other control whose children are presentational) are announced inconsistently and are hard to operate.',
    fix: 'Move the inner control outside, or make the outer element a plain container.',
    run(ctx) {
      const OUTER = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
      for (const el of ctx.all) {
        const r = ctx.role(el);
        if (!OUTER.has(r) || ctx.hidden(el)) continue;
        if (D.tag(el) === 'SELECT') continue;
        const inner = el.querySelectorAll(D.FOCUSABLE_SELECTOR);
        for (const c of inner) {
          if (c === el) continue;
          const ti = D.tabIndexValue(c);
          if (ti != null && ti < 0) continue;
          if (!D.isFocusable(c) || ctx.hidden(c)) continue;
          ctx.report('nested-interactive', el, `A ${r} contains a focusable <${c.tagName.toLowerCase()}>.`);
          break;
        }
      }
    },
  });

  rule({
    id: 'label-content-name-mismatch', title: 'Accessible name does not contain the visible label', impact: 'moderate', wcag: ['2.5.3'], level: 'A',
    description: 'Speech-input users say what they see. When aria-label replaces visible text, the visible words must appear in the accessible name.',
    fix: 'Start the aria-label with the visible text, or remove the aria-label so the visible text is used.',
    run(ctx) {
      const ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option', 'treeitem']);
      const norm = (s) => lc(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      for (const el of ctx.all) {
        const r = ctx.role(el);
        if (!ROLES.has(r) || ctx.hidden(el)) continue;
        const n = ctx.name(el);
        if (n.source !== 'aria-label' && n.source !== 'aria-labelledby') continue;
        const visible = norm(D.subtreeText(el, { visited: new Set(), ignoreHidden: false }));
        if (!visible || visible.length < 2) continue;
        const name = norm(n.name);
        if (name.includes(visible)) continue;
        ctx.report('label-content-name-mismatch', el, `Visible text "${visible}" is not part of the accessible name "${n.name}".`);
      }
    },
  });

  // ---- Forms --------------------------------------------------------------
  function formFields(ctx) {
    return ctx.all.filter((el) => {
      const t = D.tag(el);
      if (t === 'INPUT') {
        const type = lc(el.getAttribute('type') || 'text');
        if (/^(hidden|button|submit|reset|image)$/.test(type)) return false;
      } else if (t !== 'SELECT' && t !== 'TEXTAREA') return false;
      return !ctx.hidden(el);
    });
  }

  rule({
    id: 'label', title: 'Form field has no label', impact: 'critical', wcag: ['1.3.1', '4.1.2'], level: 'A',
    description: 'Inputs, selects and textareas need a programmatic label so assistive technology can announce what to enter.',
    fix: 'Associate a <label for="id"> with the field, wrap it in a <label>, or use aria-labelledby/aria-label.',
    run(ctx) {
      for (const el of formFields(ctx)) {
        const n = ctx.name(el);
        if (n.source === 'none') ctx.report('label', el, `<${el.tagName.toLowerCase()}${el.type ? ` type="${el.type}"` : ''}> has no label.`);
      }
    },
  });

  rule({
    id: 'label-placeholder-only', title: 'Form field is labelled only by its placeholder', impact: 'serious', wcag: ['3.3.2', '1.3.1'], level: 'A',
    description: 'Placeholder text disappears as soon as the user types and often has low contrast, so it cannot replace a label.',
    fix: 'Add a visible <label> for the field. Keep the placeholder for an example value if needed.',
    run(ctx) {
      for (const el of formFields(ctx)) {
        if (ctx.name(el).source === 'placeholder') ctx.report('label-placeholder-only', el, 'Only the placeholder provides a name for this field.');
      }
    },
  });

  rule({
    id: 'label-title-only', title: 'Form field is labelled only by its title attribute', impact: 'moderate', wcag: ['3.3.2'], level: 'best-practice',
    description: 'The title attribute is only shown on mouse hover, so sighted keyboard and touch users never see it.',
    fix: 'Add a visible <label> element.',
    run(ctx) {
      for (const el of formFields(ctx)) {
        if (ctx.name(el).source === 'title') ctx.review('label-title-only', el, 'Only the title attribute provides a name for this field.');
      }
    },
  });

  rule({
    id: 'form-field-multiple-labels', title: 'Form field has multiple labels', impact: 'moderate', wcag: ['3.3.2'], level: 'A',
    description: 'When several <label> elements point at one field, screen readers announce them inconsistently.',
    fix: 'Use a single label; put extra hints in aria-describedby.',
    run(ctx) {
      for (const el of formFields(ctx)) {
        const labels = D.labelsFor(el).filter((l) => !ctx.hidden(l));
        if (labels.length > 1) ctx.review('form-field-multiple-labels', el, `Field has ${labels.length} visible labels.`);
      }
    },
  });

  rule({
    id: 'autocomplete-valid', title: 'autocomplete attribute value is invalid', impact: 'serious', wcag: ['1.3.5'], level: 'AA',
    description: 'Valid autocomplete tokens let browsers and assistive tech fill in and identify personal data fields.',
    fix: 'Use a token from the HTML autofill list, such as "email", "given-name" or "postal-code".',
    run(ctx) {
      for (const el of ctx.q('input[autocomplete], select[autocomplete], textarea[autocomplete]')) {
        if (ctx.hidden(el) || el.type === 'hidden') continue;
        const v = el.getAttribute('autocomplete');
        if (!validAutocomplete(v)) ctx.report('autocomplete-valid', el, `autocomplete="${v}" is not a valid autofill token.`);
      }
    },
  });

  // ---- Headings and structure ---------------------------------------------
  function headings(ctx) {
    if (ctx._headings) return ctx._headings;
    ctx._headings = ctx.all.filter((el) => ctx.role(el) === 'heading' && !ctx.hidden(el));
    return ctx._headings;
  }

  rule({
    id: 'empty-heading', title: 'Heading is empty', impact: 'minor', wcag: ['1.3.1', '2.4.6'], level: 'A',
    description: 'Empty headings are announced as headings with nothing in them, which confuses navigation.',
    fix: 'Add text to the heading or remove the element.',
    run(ctx) {
      for (const el of headings(ctx)) {
        if (!ctx.name(el).name) ctx.report('empty-heading', el, 'Heading has no text content.');
      }
    },
  });

  rule({
    id: 'heading-order', title: 'Heading levels skip', impact: 'moderate', wcag: ['1.3.1'], level: 'best-practice',
    description: 'Heading levels should increase by one at a time so the outline reflects the page structure.',
    fix: 'Use the next heading level down (for example h2 then h3), styling it with CSS if it needs to look different.',
    run(ctx) {
      let prev = 0;
      for (const el of headings(ctx)) {
        if (!D.isRendered(el)) continue;
        const lvl = headingLevel(el);
        if (prev && lvl > prev + 1) ctx.report('heading-order', el, `Heading level jumps from ${prev} to ${lvl}.`);
        prev = lvl;
      }
    },
  });

  rule({
    id: 'page-has-heading-one', title: 'Page has no level-one heading', impact: 'moderate', wcag: ['1.3.1', '2.4.6'], level: 'best-practice', scope: 'top',
    description: 'A single h1 describing the page lets screen-reader users jump straight to the main content.',
    fix: 'Add an <h1> that names the page\'s main content.',
    run(ctx) {
      if (!headings(ctx).some((el) => headingLevel(el) === 1)) ctx.report('page-has-heading-one', ctx.doc.documentElement, 'No <h1> or role="heading" aria-level="1" found.');
    },
  });

  function landmarks(ctx) {
    if (ctx._landmarks) return ctx._landmarks;
    ctx._landmarks = ctx.all.filter((el) => {
      const r = ctx.role(el);
      if (!ARIA.LANDMARK_ROLES.has(r)) return false;
      if (ctx.hidden(el)) return false;
      // <section> and <form> are only landmarks when named.
      if ((r === 'region' || r === 'form') && !ctx.name(el).name) return false;
      return true;
    });
    return ctx._landmarks;
  }

  rule({
    id: 'landmark-one-main', title: 'Page has no main landmark', impact: 'moderate', wcag: ['1.3.1'], level: 'best-practice', scope: 'top',
    description: 'A <main> element lets assistive-technology users jump straight to the primary content.',
    fix: 'Wrap the primary content in a <main> element (exactly one per page).',
    run(ctx) {
      const mains = landmarks(ctx).filter((el) => ctx.role(el) === 'main');
      if (!mains.length) ctx.report('landmark-one-main', ctx.doc.documentElement, 'No <main> or role="main" landmark.');
      for (const el of mains.slice(1)) ctx.report('landmark-one-main', el, `Page has ${mains.length} main landmarks; there should be one.`);
    },
  });

  rule({
    id: 'landmark-no-duplicate-banner', title: 'Page has more than one banner landmark', impact: 'moderate', wcag: ['1.3.1'], level: 'best-practice', scope: 'top',
    description: 'There should be at most one top-level <header> (banner) per page.',
    fix: 'Keep one top-level <header>; nest others inside <article> or <section>, or use a plain <div>.',
    run(ctx) {
      const list = landmarks(ctx).filter((el) => ctx.role(el) === 'banner');
      for (const el of list.slice(1)) ctx.report('landmark-no-duplicate-banner', el, `Page has ${list.length} banner landmarks.`);
    },
  });

  rule({
    id: 'landmark-no-duplicate-contentinfo', title: 'Page has more than one contentinfo landmark', impact: 'moderate', wcag: ['1.3.1'], level: 'best-practice', scope: 'top',
    description: 'There should be at most one top-level <footer> (contentinfo) per page.',
    fix: 'Keep one top-level <footer>; nest others inside <article> or <section>.',
    run(ctx) {
      const list = landmarks(ctx).filter((el) => ctx.role(el) === 'contentinfo');
      for (const el of list.slice(1)) ctx.report('landmark-no-duplicate-contentinfo', el, `Page has ${list.length} contentinfo landmarks.`);
    },
  });

  rule({
    id: 'landmark-unique', title: 'Landmarks of the same type are not distinguishable', impact: 'minor', wcag: ['1.3.1'], level: 'best-practice',
    description: 'When a page has several landmarks of one type (for example two <nav>), each needs a unique name.',
    fix: 'Give each landmark a distinct aria-label, e.g. aria-label="Primary" and aria-label="Footer".',
    run(ctx) {
      const seen = new Map();
      for (const el of landmarks(ctx)) {
        const key = ctx.role(el) + '|' + lc(ctx.name(el).name);
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(el);
      }
      for (const [key, list] of seen) {
        if (list.length < 2) continue;
        const [r, n] = key.split('|');
        for (const el of list.slice(1)) ctx.report('landmark-unique', el, `${list.length} ${r} landmarks share the name "${n || '(none)'}".`);
      }
    },
  });

  rule({
    id: 'region', title: 'Content is outside landmarks', impact: 'moderate', wcag: ['1.3.1'], level: 'best-practice', scope: 'top',
    description: 'Content outside landmarks is skipped by users who navigate by landmark.',
    fix: 'Place all content inside <header>, <nav>, <main>, <aside> or <footer> (or named regions).',
    run(ctx) {
      const lm = landmarks(ctx);
      if (!lm.length) return; // landmark-one-main already covers pages without landmarks
      const isLm = new Set(lm);
      const containsLm = (el) => lm.some((l) => l !== el && el.contains(l));
      const isSkip = (el) => D.tag(el) === 'A' && /^#/.test(el.getAttribute('href') || '');
      const check = (el) => {
        if (isLm.has(el) || ctx.hidden(el)) return;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|DIALOG)$/.test(D.tag(el))) return;
        const r = ctx.role(el);
        if (r === 'dialog' || r === 'alertdialog' || r === 'alert' || r === 'status' || r === 'log') return;
        if (isSkip(el)) return;
        if (containsLm(el)) {
          for (const c of el.children) check(c);
          for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3 && n.nodeValue.trim()) {
              ctx.report('region', el, 'Text is not inside a landmark.');
              return;
            }
          }
          return;
        }
        if (!D.isRendered(el)) return;
        if (D.hasVisibleText(el) || el.querySelector('img, svg, video, canvas, input, select, textarea, button')) {
          // Skip links alone in a container are fine.
          const kids = el.querySelectorAll('a, button, input, select, textarea');
          if (kids.length === 1 && isSkip(kids[0]) && D.trimText(el.textContent) === D.trimText(kids[0].textContent)) return;
          ctx.report('region', el, 'Content is not contained by any landmark.');
        }
      };
      if (ctx.doc.body) for (const c of ctx.doc.body.children) check(c);
    },
  });

  rule({
    id: 'bypass', title: 'No way to bypass repeated blocks', impact: 'serious', wcag: ['2.4.1'], level: 'A', scope: 'top',
    description: 'Keyboard users need a way to skip repeated navigation: a main landmark, headings, or a skip link.',
    fix: 'Add a <main> landmark and headings, and ideally a "Skip to main content" link as the first focusable element.',
    run(ctx) {
      const focusables = ctx.all.filter((el) => D.isFocusable(el) && !ctx.hidden(el));
      if (focusables.length < 10) return;
      if (landmarks(ctx).some((el) => ctx.role(el) === 'main')) return;
      if (headings(ctx).length) return;
      const firstLinks = focusables.slice(0, 5).filter((el) => /^#./.test(el.getAttribute('href') || ''));
      if (firstLinks.length) return;
      ctx.report('bypass', ctx.doc.documentElement, 'Page has no main landmark, no headings and no skip link.');
    },
  });

  // ---- IDs ----------------------------------------------------------------
  const IDREF_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-errormessage', 'aria-details', 'aria-flowto', 'headers'];

  function duplicateIds(ctx) {
    if (ctx._dups) return ctx._dups;
    const byRoot = new Map();
    for (const el of ctx.all) {
      const id = el.getAttribute('id');
      if (!id) continue;
      const r = el.getRootNode();
      if (!byRoot.has(r)) byRoot.set(r, new Map());
      const m = byRoot.get(r);
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(el);
    }
    const referenced = new Set();
    for (const el of ctx.all) {
      for (const a of IDREF_ATTRS) {
        const v = el.getAttribute(a);
        if (v) v.trim().split(/\s+/).forEach((id) => referenced.add(id));
      }
      if (D.tag(el) === 'LABEL' && el.htmlFor) referenced.add(el.htmlFor);
    }
    const out = [];
    for (const m of byRoot.values()) {
      for (const [id, list] of m) if (list.length > 1) out.push({ id, list, referenced: referenced.has(id) });
    }
    ctx._dups = out;
    return out;
  }

  rule({
    id: 'duplicate-id-aria', title: 'ID used by ARIA or labels is not unique', impact: 'serious', wcag: ['1.3.1', '4.1.2'], level: 'A',
    description: 'When an id referenced by aria-labelledby, aria-describedby, label[for] or headers is duplicated, only the first element is used and relationships break.',
    fix: 'Make every id on the page unique.',
    run(ctx) {
      for (const d of duplicateIds(ctx)) {
        if (!d.referenced) continue;
        for (const el of d.list.slice(1)) ctx.report('duplicate-id-aria', el, `id="${d.id}" is used ${d.list.length} times and is referenced by a label or ARIA attribute.`);
      }
    },
  });

  rule({
    id: 'duplicate-id', title: 'ID is not unique', impact: 'minor', wcag: ['4.1.2'], level: 'best-practice',
    description: 'Duplicate ids make fragment links, scripts and future ARIA relationships unreliable. (WCAG 2.2 removed 4.1.1 Parsing, so this is best practice.)',
    fix: 'Make every id on the page unique.',
    run(ctx) {
      for (const d of duplicateIds(ctx)) {
        if (d.referenced) continue;
        for (const el of d.list.slice(1)) ctx.report('duplicate-id', el, `id="${d.id}" is used ${d.list.length} times.`);
      }
    },
  });

  // ---- ARIA ---------------------------------------------------------------
  function ariaAttrs(el) {
    const out = [];
    for (const a of el.attributes) if (a.name.startsWith('aria-')) out.push(a);
    return out;
  }

  rule({
    id: 'aria-roles', title: 'ARIA role is invalid', impact: 'critical', wcag: ['4.1.2'], level: 'A',
    description: 'role must be a defined, non-abstract WAI-ARIA role. Invalid roles are ignored and the element loses its intended semantics.',
    fix: 'Correct the role value (check for typos) or remove it and use a native HTML element.',
    run(ctx) {
      for (const el of ctx.q('[role]')) {
        const raw = lc(el.getAttribute('role'));
        if (!raw) continue;
        const tokens = raw.split(/\s+/);
        const first = tokens[0];
        if (ARIA.isValidRole(first)) continue;
        const fallback = tokens.find((t) => ARIA.isValidRole(t));
        const abstract = ARIA.isAbstract(first);
        const guess = !abstract && closest(first, Object.keys(ARIA.ROLES).filter((r) => !ARIA.isAbstract(r)));
        const msg = abstract ? `role="${first}" is an abstract role and must not be used in content.` : `role="${first}" is not a valid ARIA role${guess ? ` (did you mean "${guess}"?)` : ''}.`;
        ctx.report('aria-roles', el, msg + (fallback ? ` The fallback "${fallback}" is used instead.` : ''), fallback ? { impact: 'minor' } : null);
      }
    },
  });

  rule({
    id: 'aria-valid-attr', title: 'ARIA attribute name is not valid', impact: 'critical', wcag: ['4.1.2'], level: 'A',
    description: 'Misspelled aria-* attributes are ignored by browsers, so the intended state or name is lost.',
    fix: 'Fix the attribute name (for example aria-labelledby, not aria-labeledby).',
    run(ctx) {
      const known = Object.keys(ARIA.ATTR_TYPES);
      for (const el of ctx.all) {
        for (const a of ariaAttrs(el)) {
          if (ARIA.ATTR_TYPES[a.name]) continue;
          const guess = closest(a.name, known);
          ctx.report('aria-valid-attr', el, `${a.name} is not a valid ARIA attribute${guess ? ` (did you mean ${guess}?)` : ''}.`);
        }
      }
    },
  });

  rule({
    id: 'aria-valid-attr-value', title: 'ARIA attribute has an invalid value', impact: 'critical', wcag: ['4.1.2'], level: 'A',
    description: 'ARIA attributes must use allowed values, and id references must point to elements that exist.',
    fix: 'Use one of the allowed values, or fix the referenced id.',
    run(ctx) {
      for (const el of ctx.all) {
        const attrs = ariaAttrs(el);
        if (!attrs.length) continue;
        for (const a of attrs) {
          const spec = ARIA.ATTR_TYPES[a.name];
          if (!spec) continue;
          const v = ARIA.validateValue(a.name, a.value);
          if (!v.ok) {
            if ((spec.type === 'id' || spec.type === 'idlist') && a.value.trim() === '') continue; // empty ref = no relation
            ctx.report('aria-valid-attr-value', el, `${a.name}="${a.value}" is invalid; expected ${v.expected}.`);
            continue;
          }
          if (spec.type === 'id' || spec.type === 'idlist') {
            if (a.name === 'aria-controls' && lc(el.getAttribute('aria-expanded')) !== 'true') continue; // collapsed popups may not be in the DOM yet
            const ids = a.value.trim().split(/\s+/).filter(Boolean);
            if (!ids.length) continue;
            const rootNode = el.getRootNode();
            const missing = ids.filter((id) => !ctx.byId(rootNode, id));
            if (missing.length === ids.length) ctx.report('aria-valid-attr-value', el, `${a.name} references id${ids.length > 1 ? 's' : ''} "${missing.join(' ')}" which ${missing.length > 1 ? 'do' : 'does'} not exist.`);
          }
        }
      }
    },
  });

  rule({
    id: 'aria-allowed-attr', title: 'ARIA attribute is not allowed on this role', impact: 'serious', wcag: ['4.1.2'], level: 'A',
    description: 'Each role supports a specific set of states and properties. Unsupported ones are ignored or misreported.',
    fix: 'Remove the attribute, or change the role to one that supports it.',
    run(ctx) {
      for (const el of ctx.all) {
        const attrs = ariaAttrs(el);
        if (!attrs.length) continue;
        const r = ctx.role(el);
        if (!r || !ARIA.ROLES[r]) continue;
        if (r === 'presentation' || r === 'none') continue; // handled by presentation-role-conflict
        const allowed = ARIA.allowedAttrs(r);
        for (const a of attrs) {
          if (!ARIA.ATTR_TYPES[a.name]) continue;
          if (allowed.indexOf(a.name) !== -1) continue;
          if ((a.name === 'aria-label' || a.name === 'aria-labelledby') && ARIA.NO_NAME_ROLES.has(r)) continue; // aria-prohibited-attr
          ctx.report('aria-allowed-attr', el, `${a.name} is not supported on role "${r}".`);
        }
      }
    },
  });

  rule({
    id: 'aria-prohibited-attr', title: 'Element cannot be named with aria-label', impact: 'serious', wcag: ['4.1.2'], level: 'A',
    description: 'aria-label and aria-labelledby are prohibited on generic containers (div, span), paragraphs and similar roles; screen readers often ignore them there.',
    fix: 'Give the element an appropriate role (for example role="img" or role="group"), or put the text in the content or a visually hidden span.',
    run(ctx) {
      for (const el of ctx.q('[aria-label], [aria-labelledby]')) {
        const r = ctx.role(el);
        if (!ARIA.NO_NAME_ROLES.has(r) || r === 'presentation' || r === 'none') continue;
        if (D.isFocusable(el)) continue; // focusable generics get treated as named widgets
        if (!D.trimText(el.getAttribute('aria-label')) && !el.getAttribute('aria-labelledby')) continue;
        ctx.report('aria-prohibited-attr', el, `aria-label/aria-labelledby is not allowed on role "${r}" (<${el.tagName.toLowerCase()}>).`);
      }
    },
  });

  rule({
    id: 'presentation-role-conflict', title: 'role="none/presentation" is ignored', impact: 'minor', wcag: ['4.1.2'], level: 'best-practice',
    description: 'Browsers ignore role="none" or "presentation" on focusable elements or on elements with global ARIA attributes, so the element keeps its semantics.',
    fix: 'Remove the role, or remove the tabindex/ARIA attributes if the element really is decorative.',
    run(ctx) {
      for (const el of ctx.all) {
        const r = explicitRole(el);
        if (r !== 'none' && r !== 'presentation') continue;
        if (ctx.hidden(el)) continue;
        const globals = ariaAttrs(el).filter((a) => ARIA.GLOBAL_ATTRS.indexOf(a.name) !== -1 && a.name !== 'aria-hidden');
        if (D.isFocusable(el)) ctx.report('presentation-role-conflict', el, `role="${r}" is ignored because the element is focusable.`);
        else if (globals.length) ctx.report('presentation-role-conflict', el, `role="${r}" is ignored because the element has ${globals.map((a) => a.name).join(', ')}.`);
      }
    },
  });

  const REQUIRED_SKIP = { heading: ['aria-level'], option: ['aria-selected'], combobox: [] };

  rule({
    id: 'aria-required-attr', title: 'Required ARIA attribute is missing', impact: 'critical', wcag: ['4.1.2'], level: 'A',
    description: 'Some roles must expose a state, such as aria-checked on a checkbox or aria-valuenow on a slider.',
    fix: 'Add the missing attribute and keep it updated with script, or use the equivalent native element.',
    run(ctx) {
      for (const el of ctx.q('[role]')) {
        const r = explicitRole(el);
        const def = r && ARIA.ROLES[r];
        if (!def || !def.required) continue;
        if (ctx.hidden(el)) continue;
        const t = D.tag(el);
        const type = lc(el.getAttribute('type'));
        const missing = def.required.filter((a) => {
          if (el.hasAttribute(a)) return false;
          if ((REQUIRED_SKIP[r] || []).indexOf(a) !== -1) return false;
          if (a === 'aria-checked' && t === 'INPUT' && (type === 'checkbox' || type === 'radio')) return false;
          if (a === 'aria-valuenow' && t === 'INPUT' && (type === 'range' || type === 'number')) return false;
          if (a === 'aria-expanded' && r === 'combobox' && (t === 'SELECT' || (t === 'INPUT' && el.hasAttribute('list')))) return false;
          return true;
        });
        if (missing.length) ctx.report('aria-required-attr', el, `role="${r}" requires ${missing.join(', ')}.`);
      }
    },
  });

  function ownedChildren(ctx, el) {
    const out = [];
    const visit = (node) => {
      for (const c of node.children) {
        if (ctx.hidden(c)) continue;
        const r = ctx.role(c);
        if (!r || r === 'generic' || r === 'none' || r === 'presentation') visit(c);
        else out.push({ el: c, role: r });
      }
    };
    visit(el);
    for (const ref of D.idRefs(el, 'aria-owns')) {
      if (ref.el && !ctx.hidden(ref.el)) out.push({ el: ref.el, role: ctx.role(ref.el) });
    }
    return out;
  }

  rule({
    id: 'aria-required-children', title: 'ARIA role is missing required children', impact: 'critical', wcag: ['1.3.1'], level: 'A',
    description: 'Composite roles such as list, menu, listbox, tablist and grid must contain (or own) the right child roles.',
    fix: 'Give the children the matching roles (e.g. role="menuitem" inside role="menu"), or use aria-owns.',
    run(ctx) {
      const STRICT = new Set(['listbox', 'menu', 'menubar', 'tablist', 'tree', 'grid', 'treegrid', 'table', 'row', 'rowgroup', 'feed', 'radiogroup', 'list']);
      const EXTRA_OK = { menu: ['separator'], menubar: ['separator'], listbox: [], tablist: [], radiogroup: ['group'] };
      for (const el of ctx.q('[role]')) {
        const r = explicitRole(el);
        const def = r && ARIA.ROLES[r];
        if (!def || !def.children || ctx.hidden(el)) continue;
        if (lc(el.getAttribute('aria-busy')) === 'true') continue;
        const kids = ownedChildren(ctx, el);
        const allowed = def.children.concat(EXTRA_OK[r] || []);
        const good = kids.filter((k) => allowed.indexOf(k.role) !== -1);
        if (!good.length) {
          ctx.report('aria-required-children', el, `role="${r}" must contain ${def.children.map((c) => `role="${c}"`).join(' or ')}.`);
          continue;
        }
        if (!STRICT.has(r)) continue;
        const bad = kids.filter((k) => allowed.indexOf(k.role) === -1 && ARIA.ROLES[k.role] && k.role !== 'group');
        if (bad.length) ctx.report('aria-required-children', el, `role="${r}" contains child role${bad.length > 1 ? 's' : ''} ${Array.from(new Set(bad.map((b) => '"' + b.role + '"'))).join(', ')} which ${bad.length > 1 ? 'are' : 'is'} not allowed.`, { impact: 'serious' });
      }
    },
  });

  rule({
    id: 'aria-required-parent', title: 'ARIA role is missing its required parent', impact: 'critical', wcag: ['1.3.1'], level: 'A',
    description: 'Roles such as option, tab, menuitem, row and cell only make sense inside their container role.',
    fix: 'Wrap the element in a container with the required role (e.g. role="tablist" around role="tab").',
    run(ctx) {
      for (const el of ctx.q('[role]')) {
        const r = explicitRole(el);
        const def = r && ARIA.ROLES[r];
        if (!def || !def.parent || ctx.hidden(el)) continue;
        let ok = false;
        let p = el.parentElement || (el.getRootNode().host || null);
        while (p) {
          const pr = ctx.role(p);
          if (pr && pr !== 'generic' && pr !== 'none' && pr !== 'presentation') {
            ok = def.parent.indexOf(pr) !== -1;
            break;
          }
          p = p.parentElement || (p.getRootNode().host || null);
        }
        if (!ok && el.id) {
          const owner = ctx.doc.querySelector(`[aria-owns~="${CSS.escape(el.id)}"]`);
          if (owner && def.parent.indexOf(ctx.role(owner)) !== -1) ok = true;
        }
        if (!ok) ctx.report('aria-required-parent', el, `role="${r}" must be inside ${def.parent.map((x) => `role="${x}"`).join(' or ')}.`);
      }
    },
  });

  rule({
    id: 'aria-hidden-body', title: 'aria-hidden is set on the document body', impact: 'critical', wcag: ['4.1.2'], level: 'A',
    description: 'aria-hidden="true" on <body> or <html> hides the entire page from assistive technology.',
    fix: 'Remove aria-hidden from <body>/<html>. To hide background content behind a dialog, use the inert attribute on sibling containers.',
    run(ctx) {
      for (const el of [ctx.doc.documentElement, ctx.doc.body]) {
        if (el && lc(el.getAttribute('aria-hidden')) === 'true') ctx.report('aria-hidden-body', el, `<${el.tagName.toLowerCase()}> has aria-hidden="true".`);
      }
    },
  });

  rule({
    id: 'aria-hidden-focus', title: 'Focusable element is hidden with aria-hidden', impact: 'serious', wcag: ['4.1.2'], level: 'A',
    description: 'Keyboard users can still tab to elements inside aria-hidden="true", but screen readers announce nothing.',
    fix: 'Add tabindex="-1" to the focusable descendants, use the inert attribute, or remove aria-hidden.',
    run(ctx) {
      for (const el of ctx.q('[aria-hidden="true" i]')) {
        if (el === ctx.doc.body || el === ctx.doc.documentElement) continue;
        const candidates = [el].concat(Array.from(el.querySelectorAll(D.FOCUSABLE_SELECTOR)));
        for (const c of candidates) {
          if (!D.isFocusable(c)) continue;
          const ti = D.tabIndexValue(c);
          if (ti != null && ti < 0) continue;
          const st = ctx.style(c);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          if (c.closest('[inert]')) continue;
          ctx.report('aria-hidden-focus', c, c === el ? 'Element has aria-hidden="true" but is focusable.' : 'Element is focusable inside an aria-hidden="true" container.');
        }
      }
    },
  });

  rule({
    id: 'aria-widget-name', title: 'ARIA widget or container has no accessible name', impact: 'serious', wcag: ['4.1.2'], level: 'A',
    description: 'Custom widgets (checkbox, combobox, slider, tab, dialog, progressbar, tree, ...) built with ARIA roles need an accessible name.',
    fix: 'Add aria-label or aria-labelledby that points at the visible label.',
    run(ctx) {
      const SKIP = new Set(['button', 'link', 'img', 'image', 'heading', 'region', 'form', 'graphics-document']);
      for (const el of ctx.q('[role]')) {
        const r = explicitRole(el);
        const def = r && ARIA.ROLES[r];
        if (!def || !def.nameRequired || SKIP.has(r)) continue;
        if (ctx.hidden(el)) continue;
        if (ctx.name(el).name) continue;
        ctx.report('aria-widget-name', el, `Element with role="${r}" has no accessible name.`, r === 'tabpanel' ? { impact: 'moderate' } : null);
      }
    },
  });

  // ---- Keyboard -----------------------------------------------------------
  rule({
    id: 'tabindex', title: 'Positive tabindex', impact: 'serious', wcag: ['2.4.3'], level: 'A',
    description: 'A tabindex greater than 0 moves the element ahead of everything else in the tab order, which almost always produces an illogical focus order.',
    fix: 'Use tabindex="0" (or no tabindex) and order the DOM to match the visual order.',
    run(ctx) {
      for (const el of ctx.q('[tabindex]')) {
        const v = D.tabIndexValue(el);
        if (v > 0 && !ctx.hidden(el)) ctx.report('tabindex', el, `tabindex="${v}" changes the natural tab order.`);
      }
    },
  });

  function insideInteractive(el) {
    let p = el.parentElement;
    while (p) {
      if (isNativeInteractive(p) || ARIA.INTERACTIVE_ROLES.has(explicitRole(p) || '')) return true;
      p = p.parentElement;
    }
    return false;
  }

  rule({
    id: 'click-events-keyboard', title: 'Click handler is not keyboard accessible', impact: 'serious', wcag: ['2.1.1'], level: 'A',
    description: 'Elements that respond to clicks must also be reachable and operable from the keyboard. Inline onclick handlers on non-interactive, unfocusable elements are a strong signal; pointer cursors on plain elements are a weaker one.',
    fix: 'Use a <button> or <a href>. If you must use another element, add role, tabindex="0" and Enter/Space key handlers.',
    run(ctx) {
      for (const el of ctx.all) {
        if (isNativeInteractive(el) || ctx.hidden(el)) continue;
        if (el === ctx.doc.body || el === ctx.doc.documentElement) continue;
        const hasHandler = el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.hasAttribute('onmouseup');
        const focusable = D.isFocusable(el);
        if (hasHandler) {
          if (!focusable) ctx.report('click-events-keyboard', el, 'Element has a mouse handler (onclick) but cannot receive keyboard focus.');
          else if (!el.hasAttribute('onkeydown') && !el.hasAttribute('onkeyup') && !el.hasAttribute('onkeypress') && !ARIA.INTERACTIVE_ROLES.has(explicitRole(el) || '')) {
            ctx.review('click-events-keyboard', el, 'Focusable element has onclick but no role or key handler; check that Enter/Space work.');
          }
          continue;
        }
        if (focusable || ARIA.INTERACTIVE_ROLES.has(explicitRole(el) || '')) continue;
        const st = ctx.style(el);
        if (st.cursor !== 'pointer') continue;
        const parent = el.parentElement;
        if (parent && ctx.style(parent).cursor === 'pointer') continue; // report the outermost only
        if (insideInteractive(el)) continue;
        if (el.querySelector('a[href], button, input, select, textarea, summary, [tabindex], [role="button"], [role="link"]')) continue;
        if (!D.isRendered(el) || D.isOffscreen(el)) continue;
        ctx.review('click-events-keyboard', el, 'Element looks clickable (cursor: pointer) but is not focusable and has no interactive role.', { impact: 'moderate' });
      }
    },
  });

  rule({
    id: 'scrollable-region-focusable', title: 'Scrollable region is not keyboard accessible', impact: 'serious', wcag: ['2.1.1'], level: 'A',
    description: 'Keyboard users can only scroll an overflow container if it (or something inside it) can receive focus.',
    fix: 'Add tabindex="0" plus an accessible name (aria-label) and a role such as "region" to the scrolling container.',
    run(ctx) {
      for (const el of ctx.all) {
        if (el === ctx.doc.documentElement || el === ctx.doc.body) continue;
        const t = D.tag(el);
        if (/^(TEXTAREA|SELECT|IFRAME|INPUT)$/.test(t)) continue;
        if (el.scrollHeight <= el.clientHeight + 4 && el.scrollWidth <= el.clientWidth + 4) continue;
        const st = ctx.style(el);
        const sy = /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 4;
        const sx = /(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 4;
        if (!sx && !sy) continue;
        if (ctx.hidden(el) || !D.isRendered(el) || el.clientHeight < 8) continue;
        if (D.isFocusable(el)) continue;
        if (!D.hasVisibleText(el)) continue;
        const inner = el.querySelectorAll(D.FOCUSABLE_SELECTOR);
        let anyFocusable = false;
        for (const c of inner) {
          if (D.isFocusable(c) && (D.tabIndexValue(c) == null || D.tabIndexValue(c) >= 0)) {
            anyFocusable = true;
            break;
          }
        }
        if (!anyFocusable) ctx.report('scrollable-region-focusable', el, 'Region scrolls but neither it nor its content can receive focus.');
      }
    },
  });

  // Static analysis of style sheets: :focus rules that remove the outline with no replacement.
  function focusStyleRules(ctx) {
    const removing = [];
    const providing = [];
    const visit = (rules, depth) => {
      if (!rules || depth > 6) return;
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) {
          if (r.media && !ctx.win.matchMedia(r.media.mediaText).matches) continue;
          visit(r.cssRules, depth + 1);
          continue;
        }
        if (!r.selectorText || !r.style) continue;
        const sel = r.selectorText;
        if (!/:focus/.test(sel) && !/(^|[\s,>+~])(\*|a|button|input|select|textarea|\[tabindex[^\]]*\])(\s*,|\s*$)/i.test(sel)) continue;
        const s = r.style;
        const outlineGone = /^(none|0|0px)$/.test(s.outlineStyle) || /^(0|0px)$/.test(s.outlineWidth) || /^(none|0|0px)$/.test((s.outline || '').trim());
        const visual = (s.boxShadow && s.boxShadow !== 'none') || s.borderColor || s.borderStyle || s.borderBottomColor || s.backgroundColor || s.background || s.textDecoration || s.textDecorationLine || s.color || (s.outlineStyle && !/^(none)$/.test(s.outlineStyle) && !outlineGone);
        for (const part of splitSelectors(sel)) {
          if (/:not\(\s*:focus-visible\s*\)/.test(part)) continue; // the recommended pattern
          if (!/:focus/.test(part)) {
            if (outlineGone) removing.push({ base: part, sel: part, text: r.cssText.slice(0, 140) });
            continue;
          }
          const base = part.replace(/:focus(-visible|-within)?(?![\w-])/g, '').replace(/([\s>+~])$/, '$1*').trim() || '*';
          if (/:focus-within/.test(part)) {
            if (visual) providing.push({ base: base + ' *', within: true });
            continue;
          }
          if (outlineGone && !visual) removing.push({ base, sel: part, text: r.cssText.slice(0, 140) });
          else if (visual || (s.outlineStyle && !outlineGone) || (s.outline && !outlineGone)) providing.push({ base });
        }
      }
    };
    const sheets = Array.from(ctx.doc.styleSheets || []);
    for (const root of ctx.shadowHosts) {
      if (root.shadowRoot && root.shadowRoot.adoptedStyleSheets) sheets.push(...root.shadowRoot.adoptedStyleSheets);
    }
    if (ctx.doc.adoptedStyleSheets) sheets.push(...ctx.doc.adoptedStyleSheets);
    let unreadable = 0;
    for (const sheet of sheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        unreadable++;
        continue;
      }
      visit(rules, 0);
    }
    return { removing, providing, unreadable };
  }

  function splitSelectors(sel) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of sel) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function safeMatches(el, sel) {
    try {
      return el.matches(sel);
    } catch (e) {
      return false;
    }
  }

  rule({
    id: 'focus-visible', title: 'Focus indicator may be removed', impact: 'serious', wcag: ['2.4.7'], level: 'AA',
    description: 'Keyboard users need to see where focus is. Style sheets that set outline: none on focus without another visible change (border, box-shadow, background) hide the indicator.',
    fix: 'Keep the default outline, or replace it with a clearly visible :focus-visible style (for example outline: 2px solid; outline-offset: 2px).',
    run(ctx) {
      const { removing, providing } = focusStyleRules(ctx);
      if (!removing.length) return;
      const focusables = ctx.all.filter((el) => D.isFocusable(el) && (D.tabIndexValue(el) == null || D.tabIndexValue(el) >= 0) && !ctx.hidden(el) && D.isRendered(el));
      for (const el of focusables) {
        const hit = removing.find((r) => safeMatches(el, r.base));
        if (!hit) continue;
        if (providing.some((p) => safeMatches(el, p.base))) continue;
        ctx.review('focus-visible', el, `CSS rule "${hit.sel}" removes the focus outline and no other :focus style was found.`, { data: { css: hit.text } });
      }
    },
  });

  // ---- Language and document --------------------------------------------
  rule({
    id: 'html-has-lang', title: 'Page has no lang attribute', impact: 'serious', wcag: ['3.1.1'], level: 'A',
    description: 'The lang attribute on <html> tells screen readers which language and pronunciation rules to use.',
    fix: 'Add a lang attribute to <html>, for example <html lang="en">.',
    run(ctx) {
      const html = ctx.doc.documentElement;
      if (!html || D.tag(html) !== 'HTML') return;
      if (!D.trimText(html.getAttribute('lang')) && !D.trimText(html.getAttribute('xml:lang'))) ctx.report('html-has-lang', html, '<html> has no lang attribute.');
    },
  });

  rule({
    id: 'html-lang-valid', title: 'Page lang attribute is not valid', impact: 'serious', wcag: ['3.1.1'], level: 'A',
    description: 'The lang value must be a valid BCP 47 language tag such as "en", "en-GB" or "pt-BR".',
    fix: 'Use a valid language tag (note the hyphen: en-US, not en_US).',
    run(ctx) {
      const html = ctx.doc.documentElement;
      const v = html && D.trimText(html.getAttribute('lang'));
      if (v && !validLang(v)) ctx.report('html-lang-valid', html, `lang="${v}" is not a valid language tag.`);
    },
  });

  rule({
    id: 'valid-lang', title: 'lang attribute on an element is not valid', impact: 'serious', wcag: ['3.1.2'], level: 'AA',
    description: 'Language changes within the page must use valid BCP 47 language tags.',
    fix: 'Correct the lang value, for example lang="fr".',
    run(ctx) {
      for (const el of ctx.q('[lang]')) {
        if (el === ctx.doc.documentElement) continue;
        const v = D.trimText(el.getAttribute('lang'));
        if (v && !validLang(v)) ctx.report('valid-lang', el, `lang="${v}" is not a valid language tag.`);
      }
    },
  });

  rule({
    id: 'document-title', title: 'Page has no title', impact: 'serious', wcag: ['2.4.2'], level: 'A', scope: 'top',
    description: 'The <title> is the first thing announced and is used for tabs, bookmarks and history.',
    fix: 'Add a descriptive, unique <title> in the <head>.',
    run(ctx) {
      if (!D.trimText(ctx.doc.title)) ctx.report('document-title', ctx.doc.documentElement, 'Document has no <title> or it is empty.');
    },
  });

  rule({
    id: 'meta-viewport', title: 'Zooming is disabled', impact: 'critical', wcag: ['1.4.4'], level: 'AA', scope: 'top',
    description: 'user-scalable=no or maximum-scale below 2 stops low-vision users from zooming on mobile.',
    fix: 'Remove user-scalable=no and maximum-scale from the viewport meta tag (or set maximum-scale to at least 5).',
    run(ctx) {
      for (const el of ctx.q('meta[name="viewport" i]')) {
        const content = lc(el.getAttribute('content'));
        const props = {};
        content.split(/[,;]/).forEach((p) => {
          const [k, v] = p.split('=').map((x) => (x || '').trim());
          if (k) props[k] = v;
        });
        if (props['user-scalable'] === 'no' || props['user-scalable'] === '0') ctx.report('meta-viewport', el, 'Viewport sets user-scalable=no.');
        else if (props['maximum-scale'] && parseFloat(props['maximum-scale']) < 2) ctx.report('meta-viewport', el, `Viewport sets maximum-scale=${props['maximum-scale']}.`);
      }
    },
  });

  rule({
    id: 'meta-refresh', title: 'Page refreshes or redirects on a timer', impact: 'critical', wcag: ['2.2.1'], level: 'A', scope: 'top',
    description: 'Timed refreshes move or reload content before users can finish reading or interacting.',
    fix: 'Remove the meta refresh, or redirect on the server instead.',
    run(ctx) {
      for (const el of ctx.q('meta[http-equiv="refresh" i]')) {
        const secs = parseFloat(el.getAttribute('content') || '');
        if (secs > 0 && secs < 72000) ctx.report('meta-refresh', el, `Page refreshes or redirects after ${secs} seconds.`);
      }
    },
  });

  rule({
    id: 'blink-marquee', title: 'Blinking or scrolling text', impact: 'serious', wcag: ['2.2.2'], level: 'A',
    description: '<blink> and <marquee> move content that users cannot pause, which distracts and is hard to read.',
    fix: 'Remove the element, or replace it with static content or an animation that can be paused.',
    run(ctx) {
      for (const el of ctx.q('blink, marquee')) ctx.report('blink-marquee', el, `<${el.tagName.toLowerCase()}> cannot be paused by the user.`);
    },
  });

  // ---- Media --------------------------------------------------------------
  rule({
    id: 'no-autoplay-audio', title: 'Media plays audio automatically', impact: 'moderate', wcag: ['1.4.2'], level: 'A',
    description: 'Sound that starts automatically interferes with screen readers. If it lasts more than 3 seconds there must be a way to pause or mute it.',
    fix: 'Remove autoplay, add muted, or provide visible controls to pause or mute the audio.',
    run(ctx) {
      for (const el of ctx.q('audio[autoplay], video[autoplay]')) {
        if (el.muted || el.hasAttribute('muted')) continue;
        if (el.duration && isFinite(el.duration) && el.duration <= 3) continue;
        if (D.tag(el) === 'VIDEO' && el.readyState >= 1 && el.mozHasAudio === false) continue;
        if (el.hasAttribute('controls')) ctx.review('no-autoplay-audio', el, 'Media autoplays with sound; it has controls, but check the user can pause or mute it quickly.', { impact: 'minor' });
        else ctx.report('no-autoplay-audio', el, 'Media autoplays with sound and has no controls.');
      }
    },
  });

  rule({
    id: 'video-caption', title: 'Video may lack captions', impact: 'critical', wcag: ['1.2.2'], level: 'A',
    description: 'Prerecorded video with audio needs synchronised captions.',
    fix: 'Add <track kind="captions" src="captions.vtt" srclang="en"> (or confirm captions are burned in).',
    run(ctx) {
      for (const el of ctx.q('video')) {
        if (ctx.hidden(el)) continue;
        if (el.querySelector('track[kind="captions" i], track[kind="subtitles" i]')) continue;
        if (el.muted && el.hasAttribute('autoplay') && el.hasAttribute('loop')) continue; // background video
        ctx.review('video-caption', el, 'Video has no <track kind="captions">. Verify captions exist (they may be burned in or provided by the player).');
      }
    },
  });

  // ---- Lists --------------------------------------------------------------
  rule({
    id: 'list', title: 'List contains non-list-item children', impact: 'serious', wcag: ['1.3.1'], level: 'A',
    description: '<ul> and <ol> may only contain <li>, <script> or <template> as direct children, otherwise the list semantics break.',
    fix: 'Wrap the content in <li> elements, or move it outside the list.',
    run(ctx) {
      for (const el of ctx.q('ul, ol')) {
        if (explicitRole(el) && explicitRole(el) !== 'list') continue;
        if (ctx.hidden(el)) continue;
        const bad = Array.from(el.children).filter((c) => {
          const t = D.tag(c);
          if (t === 'LI' && (!explicitRole(c) || explicitRole(c) === 'listitem')) return false;
          if (/^(SCRIPT|TEMPLATE)$/.test(t)) return false;
          if (ctx.hidden(c)) return false;
          return true;
        });
        if (bad.length) ctx.report('list', el, `List has ${bad.length} direct child${bad.length > 1 ? 'ren' : ''} that ${bad.length > 1 ? 'are' : 'is'} not <li> (${Array.from(new Set(bad.map((b) => '<' + b.tagName.toLowerCase() + '>'))).join(', ')}).`);
      }
    },
  });

  rule({
    id: 'listitem', title: 'List item is not inside a list', impact: 'serious', wcag: ['1.3.1'], level: 'A',
    description: '<li> must be contained in a <ul>, <ol> or <menu> (or an element with role="list").',
    fix: 'Wrap list items in <ul> or <ol>.',
    run(ctx) {
      for (const el of ctx.q('li')) {
        if (explicitRole(el) && explicitRole(el) !== 'listitem') continue;
        if (ctx.hidden(el)) continue;
        const p = el.parentElement;
        if (!p) continue;
        const pr = explicitRole(p);
        if (pr === 'list' || pr === 'directory') continue;
        if (/^(UL|OL|MENU)$/.test(D.tag(p)) && (!pr)) continue;
        ctx.report('listitem', el, `<li> is inside <${p.tagName.toLowerCase()}${pr ? ` role="${pr}"` : ''}> instead of a list.`);
      }
    },
  });

  rule({
    id: 'definition-list', title: 'Definition list is malformed', impact: 'serious', wcag: ['1.3.1'], level: 'A',
    description: '<dl> may only contain <dt>/<dd> groups (optionally wrapped in <div>), <script> or <template>; <dt> and <dd> must be inside a <dl>.',
    fix: 'Restructure the list so each <dt> is followed by its <dd> elements, directly inside <dl>.',
    run(ctx) {
      for (const el of ctx.q('dl')) {
        if (explicitRole(el) || ctx.hidden(el)) continue;
        const bad = Array.from(el.children).filter((c) => {
          const t = D.tag(c);
          if (/^(DT|DD|SCRIPT|TEMPLATE)$/.test(t)) return false;
          if (t === 'DIV') return Array.from(c.children).some((g) => !/^(DT|DD|SCRIPT|TEMPLATE)$/.test(D.tag(g)));
          return true;
        });
        if (bad.length) ctx.report('definition-list', el, `<dl> contains ${Array.from(new Set(bad.map((b) => '<' + b.tagName.toLowerCase() + '>'))).join(', ')}.`);
      }
      for (const el of ctx.q('dt, dd')) {
        if (ctx.hidden(el)) continue;
        let p = el.parentElement;
        if (p && D.tag(p) === 'DIV') p = p.parentElement;
        if (!p || D.tag(p) !== 'DL') ctx.report('definition-list', el, `<${el.tagName.toLowerCase()}> is not inside a <dl>.`);
      }
    },
  });

  // ---- Tables -------------------------------------------------------------
  function isDataTable(ctx, table) {
    const r = explicitRole(table);
    if (r === 'presentation' || r === 'none') return false;
    if (r === 'grid' || r === 'treegrid' || r === 'table') return true;
    if (table.querySelector('th, caption, thead, [scope], [headers]') || table.getAttribute('summary')) return true;
    if (table.querySelector('table')) return false;
    const rows = table.rows ? table.rows.length : 0;
    if (rows < 2) return false;
    const cols = table.rows[0] ? table.rows[0].cells.length : 0;
    return cols >= 2;
  }

  rule({
    id: 'table-headers', title: 'Data table has no header cells', impact: 'serious', wcag: ['1.3.1'], level: 'A',
    description: 'Data tables need <th> cells (with scope where needed) so screen readers can announce the row and column a cell belongs to.',
    fix: 'Mark header cells with <th scope="col"> / <th scope="row">. If the table is only for layout, add role="presentation".',
    run(ctx) {
      for (const el of ctx.q('table')) {
        if (ctx.hidden(el) || !isDataTable(ctx, el)) continue;
        if (el.querySelector('th, [role="columnheader"], [role="rowheader"]')) continue;
        const rows = el.rows ? el.rows.length : 0;
        if (rows < 2) continue;
        ctx.review('table-headers', el, `Table with ${rows} rows has no header cells. If it presents data, add <th>; if it is for layout, add role="presentation".`);
      }
    },
  });

  rule({
    id: 'td-headers-attr', title: 'Table cell headers attribute is broken', impact: 'serious', wcag: ['1.3.1'], level: 'A',
    description: 'The headers attribute must list ids of header cells in the same table.',
    fix: 'Point headers at the ids of <th> elements in the same table.',
    run(ctx) {
      for (const el of ctx.q('td[headers], th[headers]')) {
        const table = el.closest('table');
        if (!table || ctx.hidden(el)) continue;
        const ids = el.getAttribute('headers').trim().split(/\s+/).filter(Boolean);
        const bad = ids.filter((id) => {
          const t = table.querySelector('#' + CSS.escape(id));
          return !t || t === el || !/^(TH|TD)$/.test(D.tag(t));
        });
        if (bad.length) ctx.report('td-headers-attr', el, `headers references ${bad.map((b) => '"' + b + '"').join(', ')}, which ${bad.length > 1 ? 'are' : 'is'} not a header cell in this table.`);
      }
    },
  });

  rule({
    id: 'empty-table-header', title: 'Table header cell is empty', impact: 'minor', wcag: ['1.3.1'], level: 'best-practice',
    description: 'Header cells with no text give screen-reader users nothing to orient by.',
    fix: 'Add text to the header, or use <td> if the cell is not a header.',
    run(ctx) {
      for (const el of ctx.q('th')) {
        if (ctx.hidden(el)) continue;
        const table = el.closest('table');
        if (table && !isDataTable(ctx, table)) continue;
        if (!ctx.name(el).name) ctx.report('empty-table-header', el, 'Header cell has no text.');
      }
    },
  });

  // ---- Frames -------------------------------------------------------------
  rule({
    id: 'frame-title', title: 'Frame has no accessible name', impact: 'serious', wcag: ['4.1.2'], level: 'A',
    description: 'Screen readers announce iframes by their title; without one, users cannot tell what the frame contains.',
    fix: 'Add a short title attribute describing the frame, e.g. title="Map of our office".',
    run(ctx) {
      for (const el of ctx.q('iframe, frame')) {
        if (ctx.hidden(el)) continue;
        if (D.tabIndexValue(el) === -1 && !D.isRendered(el)) continue;
        if (!ctx.name(el).name) ctx.report('frame-title', el, `<${el.tagName.toLowerCase()}${el.getAttribute('src') ? ` src="${el.getAttribute('src').slice(0, 60)}"` : ''}> has no title.`);
      }
    },
  });

  rule({
    id: 'frame-title-unique', title: 'Frames share the same title', impact: 'minor', wcag: ['4.1.2'], level: 'best-practice',
    description: 'Frames with identical titles but different content cannot be told apart.',
    fix: 'Give each frame a unique, descriptive title.',
    run(ctx) {
      const seen = new Map();
      for (const el of ctx.q('iframe, frame')) {
        if (ctx.hidden(el)) continue;
        const n = lc(ctx.name(el).name);
        if (!n) continue;
        const src = el.getAttribute('src') || '';
        if (seen.has(n) && seen.get(n) !== src) ctx.report('frame-title-unique', el, `Another frame is also titled "${n}".`);
        else seen.set(n, src);
      }
    },
  });

  // ---- Target size --------------------------------------------------------
  function isInlineTextLink(ctx, el) {
    if (D.tag(el) !== 'A') return false;
    const st = ctx.style(el);
    if (!/^inline/.test(st.display) || st.display === 'inline-block' || st.display === 'inline-flex') return false;
    let p = el.parentElement;
    while (p && /^inline/.test(ctx.style(p).display)) p = p.parentElement;
    if (!p) return false;
    const all = D.trimText(p.textContent);
    const own = D.trimText(el.textContent);
    return all.length > own.length + 8;
  }

  rule({
    id: 'target-size', title: 'Touch target is too small', impact: 'serious', wcag: ['2.5.8'], level: 'AA',
    description: 'Pointer targets must be at least 24 by 24 CSS pixels, unless a 24px circle centred on the target does not overlap any other target (spacing exception), or the target is a link inside a sentence.',
    fix: 'Increase the clickable area to at least 24x24px (padding or min-width/min-height), or add spacing between small targets.',
    run(ctx) {
      const targets = [];
      const TARGET_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'combobox', 'textbox', 'searchbox', 'treeitem']);
      for (const el of ctx.all) {
        const r = ctx.role(el);
        const t = D.tag(el);
        if (!TARGET_ROLES.has(r) && t !== 'SUMMARY') continue;
        if (t === 'OPTION' || t === 'AREA') continue;
        if (r === 'textbox' || r === 'searchbox') continue; // text fields are large by nature; skip
        if (ctx.hidden(el) || D.isDisabled(el) || !D.isRendered(el)) continue;
        if (!D.isFocusable(el) && !el.hasAttribute('onclick')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        if (D.isOffscreen(el)) continue;
        targets.push({ el, rect, small: rect.width < 24 - 0.01 || rect.height < 24 - 0.01 });
      }
      if (targets.length > 3000) targets.length = 3000;
      for (const tg of targets) {
        if (!tg.small) continue;
        const el = tg.el;
        const type = lc(el.getAttribute('type'));
        if (D.tag(el) === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
          // Native, unstyled controls are sized by the user agent (exception).
          const st = ctx.style(el);
          if (st.appearance !== 'none' && !el.style.width && !el.style.height) continue;
        }
        if (isInlineTextLink(ctx, el)) continue;
        const cx = tg.rect.left + tg.rect.width / 2;
        const cy = tg.rect.top + tg.rect.height / 2;
        let conflict = null;
        for (const other of targets) {
          if (other === tg) continue;
          if (other.el.contains(el) || el.contains(other.el)) continue;
          const o = other.rect;
          if (Math.abs(o.left - cx) > 200 && Math.abs(o.right - cx) > 200) continue;
          if (other.small) {
            const ox = o.left + o.width / 2;
            const oy = o.top + o.height / 2;
            if (Math.hypot(ox - cx, oy - cy) < 24) {
              conflict = other.el;
              break;
            }
          } else {
            const dx = Math.max(o.left - cx, 0, cx - o.right);
            const dy = Math.max(o.top - cy, 0, cy - o.bottom);
            if (Math.hypot(dx, dy) < 12) {
              conflict = other.el;
              break;
            }
          }
        }
        if (!conflict) continue;
        ctx.report('target-size', el, `Target is ${Math.round(tg.rect.width)}x${Math.round(tg.rect.height)}px and too close to another target (${D.selectorFor(conflict)}).`, { data: { width: Math.round(tg.rect.width), height: Math.round(tg.rect.height) } });
      }
    },
  });

  rule({
    id: 'accesskeys', title: 'accesskey values are duplicated', impact: 'minor', wcag: ['2.1.1'], level: 'best-practice',
    description: 'Duplicate accesskey values make shortcuts unpredictable.',
    fix: 'Give each element a unique accesskey, or remove them.',
    run(ctx) {
      const seen = new Map();
      for (const el of ctx.q('[accesskey]')) {
        const k = lc(el.getAttribute('accesskey'));
        if (!k) continue;
        if (seen.has(k)) ctx.report('accesskeys', el, `accesskey="${k}" is also used by ${D.selectorFor(seen.get(k))}.`);
        else seen.set(k, el);
      }
    },
  });

  // ================================================================ runner
  function initLibs() {
    D = A11Y.dom;
    C = A11Y.color;
    ARIA = A11Y.aria;
    if (!D || !C || !ARIA) throw new Error('Accessibility Auditor libraries are not loaded');
  }

  function state() {
    if (!A11Y.state) A11Y.state = { refs: new Map(), seq: 0 };
    return A11Y.state;
  }

  function refFor(el) {
    const s = state();
    if (!el.__a11yRef || s.refs.get(el.__a11yRef) !== el) {
      s.seq += 1;
      el.__a11yRef = 'r' + s.seq;
      s.refs.set(el.__a11yRef, el);
    }
    return el.__a11yRef;
  }

  function ruleMeta(r) {
    return {
      id: r.id, title: r.title, impact: r.impact, level: r.level, description: r.description, fix: r.fix,
      wcag: (r.wcag || []).map((sc) => ({
        sc, name: SC[sc] ? SC[sc][0] : '', level: SC[sc] ? SC[sc][2] : '',
        url: SC[sc] ? `https://www.w3.org/WAI/WCAG22/Understanding/${SC[sc][1]}.html` : 'https://www.w3.org/TR/WCAG22/',
      })),
    };
  }

  function outline(ctx) {
    const hs = headings(ctx).map((el) => ({
      ref: refFor(el), level: headingLevel(el), text: ctx.name(el).name.slice(0, 200),
      visible: D.isRendered(el),
    }));
    let prev = 0;
    for (const h of hs) {
      h.skipped = !!prev && h.level > prev + 1;
      prev = h.level;
    }
    const lms = landmarks(ctx).map((el) => {
      let depth = 0;
      for (let p = el.parentElement; p; p = p.parentElement) if (landmarks(ctx).indexOf(p) !== -1) depth++;
      return { ref: refFor(el), role: ctx.role(el), name: ctx.name(el).name.slice(0, 120), tag: el.tagName.toLowerCase(), depth };
    });
    return { headings: hs, landmarks: lms };
  }

  /**
   * Run every enabled rule on this document.
   * options: { includeAAA, includeBestPractice, rules: [ids] (optional allow-list) }
   */
  function run(options) {
    initLibs();
    const opts = Object.assign({ includeAAA: false, includeBestPractice: true }, options || {});
    const t0 = performance.now();
    const doc = root.document;
    const ctx = makeContext(doc, root, opts);
    const ran = [];
    const errors = [];
    for (const r of RULES) {
      if (r.level === 'AAA' && !opts.includeAAA) continue;
      if (r.level === 'best-practice' && !opts.includeBestPractice) continue;
      if (opts.rules && opts.rules.indexOf(r.id) === -1) continue;
      if (r.scope === 'top' && !ctx.isTop) continue;
      try {
        r.run(ctx);
        ran.push(r.id);
      } catch (e) {
        errors.push({ rule: r.id, message: String((e && e.message) || e) });
      }
    }
    const byId = {};
    RULES.forEach((r) => (byId[r.id] = r));
    const issues = ctx.issues.map((i) => {
      const def = byId[i.rule];
      let rect = null;
      try {
        const b = i.el.getBoundingClientRect();
        rect = { x: Math.round(b.left + root.scrollX), y: Math.round(b.top + root.scrollY), w: Math.round(b.width), h: Math.round(b.height) };
      } catch (e) { /* ignore */ }
      return {
        ref: refFor(i.el), rule: i.rule, kind: i.kind, impact: i.impact || def.impact,
        message: i.message, selector: D.selectorFor(i.el), snippet: D.snippetFor(i.el, 220),
        inShadow: i.el.getRootNode() !== doc, rect, data: i.data || null,
      };
    });
    const truncated = {};
    Object.keys(ctx.counts).forEach((k) => {
      if (ctx.counts[k] > MAX_PER_RULE) truncated[k] = ctx.counts[k];
    });
    const rules = {};
    ran.forEach((id) => (rules[id] = ruleMeta(byId[id])));
    let out;
    try {
      out = outline(ctx);
    } catch (e) {
      out = { headings: [], landmarks: [] };
    }
    return {
      engineVersion: VERSION,
      url: String(root.location.href),
      title: doc.title || '',
      isTop: ctx.isTop,
      lang: doc.documentElement ? doc.documentElement.getAttribute('lang') || '' : '',
      elementCount: ctx.all.length,
      durationMs: Math.round(performance.now() - t0),
      rulesRun: ran,
      rules,
      issues,
      truncated,
      errors,
      outline: out,
    };
  }

  function ruleList() {
    return RULES.map(ruleMeta);
  }

  A11Y.engine = { version: VERSION, run, ruleList, refFor, SC, _internals: { validLang, validAutocomplete, splitSelectors } };
})(typeof window !== 'undefined' ? window : self);
