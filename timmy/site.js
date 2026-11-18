// sip&tell shared behaviour for inner pages: mobile menu, "Get a price" buttons, draft request forms
(function(){
  var btn = document.getElementById('menu-btn');
  var menu = document.getElementById('mobile-menu');
  if (btn && menu){
    var setOpen = function(open){
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    btn.addEventListener('click', function(){ setOpen(menu.hidden); });
    menu.addEventListener('click', function(e){ if (e.target.closest('a')) setOpen(false); });
    window.addEventListener('resize', function(){ if (window.innerWidth > 1000) setOpen(false); });
  }

  // Any button with data-fill="selectId|Value" fills that field and jumps to the form
  var form = document.querySelector('form.quote');
  document.querySelectorAll('[data-fill]').forEach(function(b){
    b.addEventListener('click', function(){
      var parts = b.getAttribute('data-fill').split('|');
      var field = document.getElementById(parts[0]);
      if (field) field.value = parts[1];
      if (!form) return;
      form.scrollIntoView({behavior: 'smooth', block: 'center'});
      form.classList.remove('highlight'); void form.offsetWidth; form.classList.add('highlight');
      var first = form.querySelector('input[required]');
      if (first) setTimeout(function(){ first.focus({preventScroll: true}); }, 500);
    });
  });

  // Draft forms: not connected to email or WhatsApp yet
  document.querySelectorAll('form[data-draft]').forEach(function(f){
    f.addEventListener('submit', function(e){
      e.preventDefault();
      var note = f.querySelector('.sent');
      var missing = [].slice.call(f.querySelectorAll('[required]')).filter(function(i){ return !i.value.trim(); });
      note.hidden = false;
      if (missing.length){
        note.textContent = f.getAttribute('data-missing') || 'Please fill in the required fields.';
        missing[0].focus();
        return;
      }
      note.textContent = f.getAttribute('data-draft');
    });
  });
})();
