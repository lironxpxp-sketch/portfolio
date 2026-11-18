// sip&tell site-wide: show the phone action bar once the visitor scrolls past the first screen
(function(){
  var bar = document.querySelector('.cta-bar');
  if (!bar) return;
  var ticking = false;
  function update(){
    ticking = false;
    var nearEnd = window.innerHeight + window.scrollY > document.documentElement.scrollHeight - 220;
    bar.classList.toggle('show', window.scrollY > window.innerHeight * 0.6 && !nearEnd);
  }
  window.addEventListener('scroll', function(){ if (!ticking){ ticking = true; requestAnimationFrame(update); } }, {passive:true});
  update();
})();
