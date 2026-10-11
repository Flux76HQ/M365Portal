// The offline page's only script (static: the CSP of this page allows no inline code). It wires the retry
// buttons. Both languages are in the markup already, side by side, so the page is complete without it.
// It does not read navigator.languages: locale tags are normalised once, by detectLocale of
// @m365portal/shared, which a static file cannot import (single-implementation guard, FR-A-008).
(function () {
  var buttons = document.querySelectorAll('[data-action="reload"]');
  for (var position = 0; position < buttons.length; position += 1) {
    buttons[position].addEventListener('click', function () {
      location.reload();
    });
  }
})();
