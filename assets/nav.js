(function(){
  var toggle = document.querySelector('.nav-toggle');
  var sidebar = document.querySelector('.nav-sidebar');
  var overlay = document.querySelector('.nav-overlay');
  if (!toggle || !sidebar) return;
  function open() { sidebar.classList.add('open'); overlay.hidden = false; }
  function close() { sidebar.classList.remove('open'); overlay.hidden = true; }
  toggle.addEventListener('click', function(){ sidebar.classList.contains('open') ? close() : open(); });
  overlay.addEventListener('click', close);
})();
