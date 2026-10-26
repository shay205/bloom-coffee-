// ==========================================================
// Bloom Coffee Co. — UI logic, animations and interactions
// The 3D scene itself lives in scene.js
// ==========================================================
import './style.css';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initCoffeeScene } from './scene.js';

gsap.registerPlugin(ScrollTrigger);

const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// Tiny helpers so we write less typing
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

// If the user prefers reduced motion, show everything immediately (no hidden start states)
if (reducedMotion) root.classList.remove('js');

/* ---------- Persisted light / dark theme ---------- */
function initThemeToggle() {
  const toggle = $('#theme-toggle');
  const themeColor = $('#theme-color');

  const setTheme = (theme, persist = false) => {
    const isDark = theme === 'dark';
    root.dataset.theme = isDark ? 'dark' : 'light';
    toggle.setAttribute('aria-pressed', String(isDark));
    toggle.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
    themeColor.setAttribute('content', isDark ? '#211810' : '#f6efe4');

    if (persist) {
      try {
        localStorage.setItem('bloom-coffee-theme', isDark ? 'dark' : 'light');
      } catch (error) {
        console.warn('Color theme preference could not be saved:', error);
      }
    }
  };

  setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');
  toggle.addEventListener('click', () => {
    setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });
}

/* ---------- Header: add a background after scrolling ---------- */
function initHeader() {
  const header = $('.site-header');
  const update = () => header.classList.toggle('is-scrolled', window.scrollY > 30);
  update();
  window.addEventListener('scroll', update, { passive: true });
}

/* ---------- Photographic images: retain the styled surface if a remote image fails ---------- */
function initImageFallbacks() {
  $$('img[data-fallback]').forEach((image) => {
    const handleError = () => {
      image.classList.add('is-failed');
      console.warn('Coffee photo could not be loaded:', image.currentSrc || image.src);
    };
    image.addEventListener('error', handleError, { once: true });
    if (image.complete && image.naturalWidth === 0) handleError();
  });
}

/* ---------- Mobile menu ---------- */
function initMobileMenu() {
  const toggle = $('#nav-toggle');
  const nav = $('#site-nav');

  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    document.body.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };

  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  $$('a', nav).forEach((link) => link.addEventListener('click', () => setOpen(false)));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  // If the window grows to desktop size while the menu is open, close it
  window.matchMedia('(min-width: 901px)').addEventListener('change', (e) => e.matches && setOpen(false));
}

/* ---------- Hero entrance animation ---------- */
function initHeroIntro() {
  const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });
  tl.fromTo('.site-header', { yPercent: -100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.9 }, 0)
    .fromTo('.hero__stage', { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 1.6, ease: 'power2.out' }, 0.1)
    .fromTo('.hero .eyebrow', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.8 }, 0.2)
    .fromTo('.hero .line__inner', { yPercent: 110, opacity: 1 }, { yPercent: 0, opacity: 1, duration: 1.2, stagger: 0.14 }, 0.3)
    .fromTo('.hero__tagline, .hero__text', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.9, stagger: 0.12 }, 0.9)
    .fromTo('.hero__actions .btn', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.8, stagger: 0.1 }, 1.15);
}

/* ---------- Scroll reveal for every [data-reveal] element ---------- */
function initScrollReveals() {
  ScrollTrigger.batch('[data-reveal]', {
    start: 'top 90%',
    once: true,
    onEnter: (batch) =>
      gsap.fromTo(
        batch,
        { opacity: 0, y: 44 },
        { opacity: 1, y: 0, duration: 1, ease: 'power3.out', stagger: 0.12, overwrite: true }
      ),
  });

  // Gentle parallax on the story artwork and closing ring
  gsap.to('.arch__inner', {
    yPercent: -12, ease: 'none',
    scrollTrigger: { trigger: '.story__visual', start: 'top bottom', end: 'bottom top', scrub: true },
  });
  gsap.fromTo('.closing__ring', { scale: 0.85 }, {
    scale: 1.1, ease: 'none',
    scrollTrigger: { trigger: '.closing', start: 'top bottom', end: 'bottom top', scrub: true },
  });

  // Count-up numbers
  $$('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    const counter = { value: 0 };
    ScrollTrigger.create({
      trigger: el, start: 'top 92%', once: true,
      onEnter: () =>
        gsap.to(counter, {
          value: target, duration: 1.8, ease: 'power2.out',
          onUpdate: () => { el.textContent = Math.round(counter.value) + suffix; },
        }),
    });
  });

  // Fonts change text sizes, so recalculate trigger positions once they load
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
}

/* ---------- Card hover effects ---------- */
function initCardEffects() {
  // Spotlight that follows the cursor on process cards
  $$('.spotlight').forEach((card) => {
    card.addEventListener('pointermove', (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    });
  });

  // Subtle 3D tilt on product cards (mouse devices only)
  if (!finePointer || reducedMotion) return;
  $$('.product').forEach((card) => {
    gsap.set(card, { transformPerspective: 900 });
    const rotY = gsap.quickTo(card, 'rotationY', { duration: 0.5, ease: 'power3.out' });
    const rotX = gsap.quickTo(card, 'rotationX', { duration: 0.5, ease: 'power3.out' });
    card.addEventListener('pointermove', (event) => {
      const rect = card.getBoundingClientRect();
      rotY(((event.clientX - rect.left) / rect.width - 0.5) * 8);
      rotX(-((event.clientY - rect.top) / rect.height - 0.5) * 8);
    });
    card.addEventListener('pointerleave', () => { rotY(0); rotX(0); });
  });
}

/* ---------- Button ripple + "Add to bag" feedback ---------- */
function initShop() {
  const countEl = $('#cart-count');
  const toast = $('#toast');
  let count = 0;
  let toastTimer;

  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  };

  // Ripple on every button
  $$('.btn').forEach((btn) => {
    btn.addEventListener('pointerdown', (event) => {
      const rect = btn.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      ripple.style.left = `${event.clientX - rect.left}px`;
      ripple.style.top = `${event.clientY - rect.top}px`;
      btn.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });
  });

  $$('.add-btn').forEach((btn) => {
    const originalLabel = btn.textContent;
    btn.addEventListener('click', () => {
      count += 1;
      countEl.textContent = String(count);
      countEl.classList.add('bump');
      setTimeout(() => countEl.classList.remove('bump'), 250);

      btn.classList.add('is-added');
      btn.textContent = 'Added ✓';
      setTimeout(() => {
        btn.classList.remove('is-added');
        btn.textContent = originalLabel;
      }, 1600);

      showToast(`${btn.dataset.name} added to your bag`);
    });
  });
}

/* ---------- Boot ---------- */
$('#year').textContent = new Date().getFullYear();
initImageFallbacks();
initThemeToggle();
initHeader();
initMobileMenu();
initShop();
initCardEffects();

try {
  if (!reducedMotion) {
    initHeroIntro();
    initScrollReveals();
  }
} catch (error) {
  // If animation setup ever fails, make sure content is still visible
  console.error('Animation setup failed:', error);
  root.classList.remove('js');
}

// Start the 3D scene
initCoffeeScene({ container: $('#scene'), reducedMotion });