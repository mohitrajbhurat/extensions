// Reading Studio: final content-script piece. Marks the full feature set as loaded and reports tab state.
(function () {
  const RS = globalThis.RS;
  if (!RS || RS.fullLoaded) return;
  RS.fullLoaded = true;

  RS.handlers['get-state'] = async () => {
    const readerOpen = !!(RS.reader && RS.reader.isOpen());
    const sel = window.getSelection();
    return {
      host: RS.host,
      title: document.title,
      reader: readerOpen,
      tts: RS.tts ? RS.tts.state() : { active: false },
      dark: RS.dark ? RS.dark.state() : null,
      ruler: !!(RS.focus && RS.focus.rulerOn),
      bionic: readerOpen ? !!RS.settings.focus.bionic : !!(RS.focus && RS.focus.pageBionic),
      hasSelection: !!(sel && !sel.isCollapsed && sel.toString().trim())
    };
  };

  RS.handlers['tts-selection'] = async (args) => RS.tts.start({ source: 'selection', text: args && args.text });
})();
