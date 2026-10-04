document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener("click", event => {
      const id = link.getAttribute("href");
      if (!id || id === "#") return;
      const target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  const sticky = document.querySelector(".sticky");
  const hero = document.querySelector(".hero");
  if (sticky && hero && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      sticky.style.opacity = entry.isIntersecting ? "0" : "1";
      sticky.style.pointerEvents = entry.isIntersecting ? "none" : "auto";
      sticky.style.transition = "opacity .2s ease";
    }, { threshold: 0.15 });
    observer.observe(hero);
  }
});
