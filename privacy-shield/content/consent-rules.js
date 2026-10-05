// Cookie-banner rules for Privacy Shield. Loaded before content/consent.js in the isolated
// world (content scripts cannot import modules, so this file sets a global).
//
// Rule fields
//   id, name      identifiers shown in the popup
//   frame         'top' (default) runs only in the top frame; 'only' runs only in iframes
//   detect        selectors; the rule applies when any of them exists
//   visible       selectors; the banner is "showing" while any of them is visible (default: detect)
//   reject        steps that decline everything except strictly necessary cookies
//   accept        steps that accept all cookies
//   hide          selectors hidden with CSS when clicking is impossible or mode is "hide"
//   lockClasses   classes CMPs put on <html>/<body> to stop the page scrolling
//
// Selectors may pierce one shadow root with "host >>> inner".
// Steps
//   { click: [selectors], text?: RegExp, optional?: true }   click the first visible match
//   { waitFor: [selectors], timeout?: ms, optional?: true }
//   { wait: ms }
//   { uncheck: [selectors] }                                  untick every checked toggle
//   { any: [[steps], [steps], ...] }                          first branch that succeeds
//   { delegate: ms }                                          wait for an iframe rule to close it

(() => {
  const REJECT = /^\s*(reject|decline|deny|refuse|disagree|do not (agree|accept|consent)|don't (agree|accept)|i do not agree|only (strictly )?(necessary|essential|required)|(strictly )?(necessary|essential|required) (cookies )?only|use (only )?(necessary|essential) cookies|continue without (accepting|agreeing)|alle ablehnen|ablehnen|nur (notwendige|essenzielle|erforderliche)|tout refuser|refuser|continuer sans accepter|rechazar|rechazar todo|rifiuta|rifiuta tutto|weigeren|alles weigeren|odrzuć|recusar|avvisa|afvis|hylkää|nej tack)/i;
  const ACCEPT = /^\s*(accept|agree|allow( all)?|i agree|i accept|ok(ay)?|got it|understood|i understand|yes,? i agree|alle akzeptieren|akzeptieren|zustimmen|tout accepter|accepter|j'accepte|aceptar|aceptar todo|accetta|accetta tutto|accepteren|akceptuj|aceitar|godkänn|acceptér|hyväksy)/i;

  const rules = [
    {
      id: 'onetrust',
      name: 'OneTrust',
      detect: ['#onetrust-banner-sdk', '#onetrust-pc-sdk', '#onetrust-consent-sdk'],
      visible: ['#onetrust-banner-sdk', '#onetrust-pc-sdk'],
      reject: [{
        any: [
          [{ click: ['#onetrust-reject-all-handler'] }],
          [
            { click: ['#onetrust-pc-btn-handler', '.ot-sdk-show-settings'] },
            { waitFor: ['#onetrust-pc-sdk .ot-pc-refuse-all-handler', '#onetrust-pc-sdk .save-preference-btn-handler'], timeout: 4000 },
            {
              any: [
                [{ click: ['#onetrust-pc-sdk .ot-pc-refuse-all-handler'] }],
                [
                  { uncheck: ['#onetrust-pc-sdk input[type="checkbox"]:not(:disabled)'] },
                  { click: ['#onetrust-pc-sdk .save-preference-btn-handler'] },
                ],
              ],
            },
          ],
        ],
      }],
      accept: [{ click: ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler'] }],
      hide: ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk', '.onetrust-pc-dark-filter'],
      lockClasses: ['ot-overflow-hidden'],
    },
    {
      id: 'cookiebot',
      name: 'Cookiebot',
      detect: ['#CybotCookiebotDialog'],
      reject: [{
        any: [
          [{ click: ['#CybotCookiebotDialogBodyButtonDecline'] }],
          [{ click: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'] }],
          [
            { uncheck: ['#CybotCookiebotDialog input[type="checkbox"]:not(:disabled)'] },
            { click: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection', '#CybotCookiebotDialogBodyButtonAcceptSelected', '#CybotCookiebotDialogBodyLevelButtonAccept'] },
          ],
        ],
      }],
      accept: [{ click: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept'] }],
      hide: ['#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay'],
      lockClasses: ['CybotCookiebotDialogActive'],
    },
    {
      id: 'quantcast',
      name: 'Quantcast Choice (TCF)',
      detect: ['#qc-cmp2-ui', '.qc-cmp2-container', '#qc-cmp2-container'],
      visible: ['#qc-cmp2-ui'],
      reject: [{
        any: [
          [{ click: ['.qc-cmp2-summary-buttons button', '#qc-cmp2-ui button'], text: REJECT }],
          [
            { click: ['.qc-cmp2-summary-buttons button[mode="secondary"]', '.qc-cmp2-summary-buttons button'], text: /more options|options|manage|preferences|settings|weitere optionen|plus d'options/i },
            { waitFor: ['.qc-cmp2-footer button', '.qc-cmp2-header-links button'], timeout: 4000 },
            { click: ['.qc-cmp2-header-links button'], text: /reject|disagree|deselect|ablehnen|refuser|tout refuser/i, optional: true },
            { click: ['.qc-cmp2-footer button[mode="primary"]', '.qc-cmp2-footer button'], text: /save|exit|confirm|speichern|enregistrer/i },
          ],
        ],
      }],
      accept: [{ click: ['.qc-cmp2-summary-buttons button[mode="primary"]'] }],
      hide: ['.qc-cmp2-container', '#qc-cmp2-container', '#qc-cmp2-ui'],
      lockClasses: ['qc-cmp-showing', 'qc-cmp-ui-showing'],
    },
    {
      id: 'didomi',
      name: 'Didomi',
      detect: ['#didomi-notice', '#didomi-popup', '#didomi-host'],
      visible: ['#didomi-notice', '#didomi-popup .didomi-popup-container', '#didomi-popup'],
      reject: [{
        any: [
          [{ click: ['#didomi-notice-disagree-button'] }],
          [{ click: ['.didomi-continue-without-agreeing', '#didomi-notice .didomi-continue-without-agreeing'] }],
          [
            { click: ['#didomi-notice-learn-more-button'] },
            { waitFor: ['#didomi-popup button', '#didomi-consent-popup button'], timeout: 4000 },
            { click: ['#didomi-popup button', '#didomi-consent-popup button'], text: /disagree to all|refuse all|reject all|tout refuser|alle ablehnen|rechazar todo|rifiuta tutto/i },
            { click: ['#didomi-popup button', '#didomi-consent-popup button'], text: /save|confirm|enregistrer|speichern|guardar|salva/i, optional: true },
          ],
        ],
      }],
      accept: [{ click: ['#didomi-notice-agree-button'] }],
      hide: ['#didomi-host', '#didomi-popup', '#didomi-notice'],
      lockClasses: ['didomi-popup-open', 'didomi-popup-open-ios'],
    },
    {
      id: 'trustarc',
      name: 'TrustArc',
      detect: ['#truste-consent-track', '#truste-consent-content', '#consent_blackbar', '.truste_box_overlay'],
      visible: ['#truste-consent-track', '#truste-consent-content', '#consent_blackbar > *', '.truste_box_overlay'],
      reject: [{
        any: [
          [{ click: ['#truste-consent-required'] }],
          [{ click: ['#truste-consent-track button', '#consent_blackbar button', '#consent_blackbar a'], text: REJECT }],
          // The preference centre lives in a trustarc.com iframe that the frame rule below handles.
          [{ delegate: 5000 }],
        ],
      }],
      accept: [{ click: ['#truste-consent-button'] }],
      hide: ['#truste-consent-track', '#truste-consent-content', '#consent_blackbar', '.truste_overlay', '.truste_box_overlay'],
      lockClasses: [],
    },
    {
      id: 'trustarc-frame',
      name: 'TrustArc',
      frame: 'only',
      frameUrl: /(consent-pref|consent)\.trustarc\.com|\.truste\.com/i,
      detect: ['body'],
      visible: ['body'],
      reject: [
        { waitFor: ['.rejectAll', '.pdynamicbutton a', 'button', 'a.call'], timeout: 4000 },
        { click: ['.rejectAll', '.pdynamicbutton a', 'button', 'a.call'], text: /reject all|decline all|refuse all|required only|tout refuser|alle ablehnen/i },
        { click: ['.pdynamicbutton a', 'button', 'a.call', '.close'], text: /submit|save|close|done|fermer|schließen/i, optional: true },
      ],
      accept: [{ click: ['.acceptAll', 'button', 'a.call'], text: /accept all|agree and proceed|agree all|tout accepter|alle akzeptieren/i }],
      hide: [],
      frameReportOnly: true,
    },
    {
      id: 'usercentrics',
      name: 'Usercentrics',
      detect: ['#usercentrics-root', '#usercentrics-cmp-ui'],
      visible: [
        '#usercentrics-root >>> [data-testid="uc-deny-all-button"]',
        '#usercentrics-root >>> [data-testid="uc-accept-all-button"]',
        '#usercentrics-root >>> [data-testid="uc-default-banner"]',
        '#usercentrics-cmp-ui >>> #deny',
        '#usercentrics-cmp-ui >>> #accept',
        '#usercentrics-cmp-ui >>> .cmp-wrapper',
      ],
      reject: [
        { waitFor: ['#usercentrics-root >>> [data-testid="uc-deny-all-button"]', '#usercentrics-cmp-ui >>> #deny', '#usercentrics-cmp-ui >>> button.deny'], timeout: 4000 },
        { click: ['#usercentrics-root >>> [data-testid="uc-deny-all-button"]', '#usercentrics-cmp-ui >>> #deny', '#usercentrics-cmp-ui >>> button.deny'] },
      ],
      accept: [{ click: ['#usercentrics-root >>> [data-testid="uc-accept-all-button"]', '#usercentrics-cmp-ui >>> #accept', '#usercentrics-cmp-ui >>> button.accept'] }],
      hide: ['#usercentrics-root', '#usercentrics-cmp-ui'],
      lockClasses: ['overflowHidden'],
    },
    {
      id: 'sourcepoint',
      name: 'Sourcepoint',
      detect: ['div[id^="sp_message_container_"]', 'iframe[id^="sp_message_iframe_"]'],
      visible: ['div[id^="sp_message_container_"]', 'iframe[id^="sp_message_iframe_"]'],
      // The buttons live in a cross-origin iframe; the frame rule clicks them and the
      // message container is removed. If that does not happen in time, hide it.
      reject: [{ delegate: 5000 }],
      accept: [{ delegate: 5000 }],
      hide: ['div[id^="sp_message_container_"]', '.sp_veil'],
      lockClasses: ['sp-message-open'],
    },
    {
      id: 'sourcepoint-frame',
      name: 'Sourcepoint',
      frame: 'only',
      detect: ['.message-container .message-button', '.sp_choice_type_11', '.sp_choice_type_13', '.sp_choice_type_REJECT_ALL', '.sp_choice_type_ACCEPT_ALL'],
      visible: ['.message-button', '[class*="sp_choice_type_"]'],
      reject: [{
        any: [
          [{ click: ['.sp_choice_type_REJECT_ALL', '.sp_choice_type_13'] }],
          [{ click: ['button.message-button', '[class*="sp_choice_type_"]'], text: REJECT }],
        ],
      }],
      accept: [{ click: ['.sp_choice_type_ACCEPT_ALL', '.sp_choice_type_11'] }],
      hide: [],
      frameReportOnly: true,
    },
    {
      id: 'osano',
      name: 'Osano',
      detect: ['.osano-cm-window', '.osano-cm-dialog'],
      visible: ['.osano-cm-dialog:not(.osano-cm-dialog--hidden)', '.osano-cm-info-dialog--open'],
      reject: [{
        any: [
          [{ click: ['.osano-cm-denyAll', '.osano-cm-button--type_denyAll', '.osano-cm-deny'] }],
          [
            { uncheck: ['.osano-cm-dialog input.osano-cm-toggle__input:not(:disabled)'] },
            { click: ['.osano-cm-save', '.osano-cm-button--type_save'] },
          ],
        ],
      }],
      accept: [{ click: ['.osano-cm-accept-all', '.osano-cm-button--type_accept', '.osano-cm-accept'] }],
      hide: ['.osano-cm-window', '.osano-cm-dialog'],
      lockClasses: [],
    },
    {
      id: 'cookieyes',
      name: 'CookieYes',
      detect: ['.cky-consent-container', '.cky-modal', '#cookie-law-info-bar'],
      visible: ['.cky-consent-container:not(.cky-hide)', '.cky-modal.cky-modal-open', '#cookie-law-info-bar'],
      reject: [{ click: ['.cky-btn-reject', '#cookie_action_close_header_reject', '.cli_action_button[data-cli_action="reject"]', '#wt-cli-reject-btn'] }],
      accept: [{ click: ['.cky-btn-accept', '#wt-cli-accept-all-btn', '#cookie_action_close_header'] }],
      hide: ['.cky-consent-container', '.cky-overlay', '.cky-modal', '#cookie-law-info-bar', '.cli-modal-backdrop'],
      lockClasses: ['cky-modal-open', 'cli-modal-open'],
    },
    {
      id: 'klaro',
      name: 'Klaro',
      detect: ['.klaro .cookie-notice', '.klaro .cookie-modal'],
      visible: ['.klaro .cookie-notice:not(.cookie-notice-hidden)', '.klaro .cookie-modal'],
      reject: [{
        any: [
          [{ click: ['.klaro .cn-decline', '.klaro .cm-btn-decline', '.klaro .cm-btn-danger'] }],
          [
            { click: ['.klaro .cn-learn-more', '.klaro .cm-link'] },
            { waitFor: ['.klaro .cookie-modal'], timeout: 3000 },
            { click: ['.klaro .cm-btn-decline', '.klaro .cm-btn-danger'] },
          ],
        ],
      }],
      accept: [{ click: ['.klaro .cm-btn-accept-all', '.klaro .cm-btn-success', '.klaro .cm-btn-accept'] }],
      hide: ['.klaro .cookie-notice', '.klaro .cookie-modal'],
      lockClasses: [],
    },
    {
      id: 'funding-choices',
      name: 'Google Funding Choices',
      detect: ['.fc-consent-root', '.fc-dialog-container'],
      visible: ['.fc-consent-root .fc-dialog', '.fc-consent-root'],
      reject: [{
        any: [
          [{ click: ['.fc-cta-do-not-consent', '.fc-secondary-button.fc-cta-do-not-consent'] }],
          [
            { click: ['.fc-cta-manage-options'] },
            { waitFor: ['.fc-confirm-choices'], timeout: 4000 },
            { uncheck: ['.fc-preference-consent', '.fc-preference-legitimate-interest', '.fc-preference-slider input[type="checkbox"]'] },
            { click: ['.fc-confirm-choices'] },
          ],
        ],
      }],
      accept: [{ click: ['.fc-cta-consent'] }],
      hide: ['.fc-consent-root', '.fc-dialog-overlay'],
      lockClasses: [],
    },
    {
      id: 'cookieconsent',
      name: 'Cookie Consent (Osano open source)',
      detect: ['.cc-window', '.cc-banner'],
      visible: ['.cc-window:not(.cc-invisible)'],
      reject: [{
        any: [
          [{ click: ['.cc-window .cc-deny'] }],
          [{ click: ['.cc-window .cc-btn', '.cc-window a'], text: REJECT }],
        ],
      }],
      accept: [{ click: ['.cc-window .cc-allow', '.cc-window .cc-dismiss'] }],
      hide: ['.cc-window', '.cc-revoke'],
      lockClasses: [],
    },
    {
      id: 'generic',
      name: 'Cookie banner',
      generic: true,
      containers: [
        '#cookie-banner', '#cookieBanner', '.cookie-banner', '#cookie-notice', '.cookie-notice', '#cookie-consent',
        '.cookie-consent', '#cookieConsent', '#cookies-banner', '.cookies-banner', '#gdpr-banner', '.gdpr-banner',
        '#gdpr-cookie-message', '#cookie-bar', '.cookie-bar', '#cookiebar', '#cookie-popup', '.cookie-popup',
        '#consent-banner', '.consent-banner', '#privacy-banner', '.privacy-banner', '#cookie-law', '.cookie-law',
        '[aria-label*="cookie" i]', '[aria-describedby*="cookie" i]', '[id*="cookie" i][class*="banner" i]',
        '[class*="cookie-consent" i]', '[class*="cookieconsent" i]', '[class*="CookieBanner"]', '[id*="consent-banner" i]',
        '[role="dialog"]', '[role="alertdialog"]', '[role="region"][aria-label*="consent" i]',
      ],
      textRe: /cookie|consent|gdpr|datenschutz|privacy|tracking|einwilligung|rgpd/i,
      rejectRe: REJECT,
      acceptRe: ACCEPT,
      lockClasses: ['no-scroll', 'noscroll', 'cookie-open'],
    },
  ];

  globalThis.PRIVACY_SHIELD_CONSENT = { rules, REJECT, ACCEPT };
})();
