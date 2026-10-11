// The offline page's only script (static: the CSP of this page allows no inline code). It marks the
// language the browser prefers, so the stylesheet can put that text first, and wires the retry buttons.
// Both texts are in the markup already, so the page is complete without this script.
(function () {
  var languages = navigator.languages || [];
  var preferred = 'en';
  for (var index = 0; index < languages.length; index += 1) {
    var primary = String(languages[index]).toLowerCase().split('-')[0];
    if (primary === 'nl' || primary === 'en') {
      preferred = primary;
      break;
    }
  }
  document.documentElement.setAttribute('data-preferred', preferred);

  var buttons = document.querySelectorAll('[data-action="reload"]');
  for (var position = 0; position < buttons.length; position += 1) {
    buttons[position].addEventListener('click', function () {
      location.reload();
    });
  }
})();
