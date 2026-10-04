document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".faq details").forEach(details => {
    const summary = details.querySelector("summary");
    const answer = details.querySelector("summary + p");
    if (!summary || !answer) return;

    summary.addEventListener("click", event => {
      if (!details.open) return;
      event.preventDefault();
      if (details.classList.contains("is-closing")) return;

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        details.open = false;
        return;
      }

      details.classList.add("is-closing");
      answer.addEventListener("animationend", () => {
        details.open = false;
        details.classList.remove("is-closing");
      }, { once: true });
    });
  });

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

  const checkoutButtons = [...document.querySelectorAll("[data-stripe-checkout]")];
  const checkoutButton = checkoutButtons[0];
  const checkoutStatus = document.querySelector(".checkout-status");
  const telegramOpenButton = document.querySelector(".telegram-open");
  if (checkoutButton && checkoutStatus) {
    const recoveryStorageKey = "highheels_checkout_recovery";
    const sessionStorageKey = "highheels_checkout_session";
    const checkoutParams = new URLSearchParams(window.location.search);
    const checkoutCompleted = checkoutParams.get("checkout") === "complete";

    const setCheckoutButtonsDisabled = (disabled, busyButton = null) => {
      checkoutButtons.forEach(button => {
        if (disabled) button.setAttribute("aria-disabled", "true");
        else button.removeAttribute("aria-disabled");
        if (button === busyButton) button.setAttribute("aria-busy", "true");
        else button.removeAttribute("aria-busy");
      });
    };

    const showPaidState = (telegramUrl, autoOpen) => {
      checkoutStatus.hidden = false;
      checkoutStatus.textContent = autoOpen
        ? "Оплата подтверждена! Сейчас откроется Telegram. Если переход не сработал, нажми «Открыть Telegram»."
        : "Оплата подтверждена. Нажми, чтобы продолжить в Telegram.";
      checkoutButtons.forEach(button => {
        button.classList.add("is-paid");
        button.setAttribute("aria-disabled", "true");
        const checkoutLabel = button.querySelector(".final-cta-label") || button;
        if (button === checkoutButton) {
          const label = button.querySelector(".final-cta-label");
          if (label) label.textContent = button.dataset.paidLabel || "КУРС ОПЛАЧЕН";
        } else {
          checkoutLabel.textContent = button.dataset.paidLabel || "КУРС ОПЛАЧЕН";
        }
      });
      const sticky = document.querySelector(".sticky");
      if (sticky) sticky.hidden = true;
      if (telegramOpenButton) {
        telegramOpenButton.href = telegramUrl;
        telegramOpenButton.hidden = false;
      }
      if (checkoutCompleted) window.history.replaceState(null, "", `${window.location.pathname}#buy`);
      if (autoOpen) window.location.assign(telegramUrl);
    };

    const postJson = async (path, data) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Проверка пока недоступна.");
      return result;
    };

    const recoverWithToken = async (recoveryToken, autoOpen) => {
      const result = await postJson("/api/recover-purchase", { recovery_token: recoveryToken });
      if (result.paid && result.telegram_url) {
        showPaidState(result.telegram_url, autoOpen && !result.preview_only);
        return true;
      }
      return false;
    };

    const recoverSavedPurchase = async autoOpen => {
      const recoveryToken = (() => {
        try { return localStorage.getItem(recoveryStorageKey); }
        catch { return null; }
      })();
      if (recoveryToken) {
        try {
          if (await recoverWithToken(recoveryToken, autoOpen)) return true;
        } catch { /* Try the saved Stripe Session ID below. */ }
      }

      // The session ID lets the server re-check Stripe even if its temporary
      // recovery-token file was lost during a local restart.
      const sessionId = (() => {
        try { return localStorage.getItem(sessionStorageKey); }
        catch { return null; }
      })();
      if (!sessionId) return false;
      const result = await postJson("/api/create-telegram-claim", { session_id: sessionId });
      if (!result.telegram_url) return false;
      showPaidState(result.telegram_url, autoOpen);
      return true;
    };

    const recoveryToken = (() => {
      try { return localStorage.getItem(recoveryStorageKey); }
      catch { return null; }
    })();

    if (checkoutCompleted) {
      checkoutStatus.hidden = false;
      checkoutStatus.textContent = "Проверяем оплату Stripe…";
      const sessionId = checkoutParams.get("session_id");
      if (sessionId) {
        try { localStorage.setItem(sessionStorageKey, sessionId); }
        catch { /* Keep using the current success URL for this verification. */ }
      }
      (async () => {
        try {
          if (recoveryToken && await recoverWithToken(recoveryToken, true)) return;
          if (sessionId) {
            const result = await postJson("/api/create-telegram-claim", { session_id: sessionId });
            if (result.telegram_url) {
              showPaidState(result.telegram_url, !result.preview_only);
              return;
            }
          }
          checkoutStatus.textContent = "Stripe пока не подтвердил оплату. Обнови страницу через минуту или напиши нам.";
        } catch (error) {
          checkoutStatus.textContent = error.message || "Не удалось проверить оплату. Напиши нам, и мы поможем.";
        }
      })();
    } else if (recoveryToken || (() => {
      try { return Boolean(localStorage.getItem(sessionStorageKey)); }
      catch { return false; }
    })()) {
      recoverSavedPurchase(false).catch(() => {
        // A pending or expired Checkout Session leaves the normal purchase button available.
      });
    }

    checkoutButtons.forEach(button => button.addEventListener("click", async event => {
      event.preventDefault();
      if (button.getAttribute("aria-disabled") === "true") return;

      setCheckoutButtonsDisabled(true, button);
      checkoutStatus.hidden = false;
      checkoutStatus.textContent = "Готовим безопасную страницу оплаты…";

      try {
        const response = await fetch("/api/create-checkout-session", {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ currency: button.dataset.currency || "uah" })
        });
        const result = await response.json();
        if (!response.ok || !result.url || !result.recovery_token) throw new Error(result.error || "Не удалось открыть оплату.");
        try {
          localStorage.setItem(recoveryStorageKey, result.recovery_token);
          if (result.session_id) localStorage.setItem(sessionStorageKey, result.session_id);
        }
        catch { /* The success URL still carries a Checkout Session fallback. */ }
        window.location.assign(result.url);
      } catch (error) {
        checkoutStatus.textContent = error.message || "Не удалось открыть оплату. Попробуй ещё раз.";
        setCheckoutButtonsDisabled(false);
      }
    }));

    // Browsers can restore the pre-Stripe page from the back-forward cache
    // without firing DOMContentLoaded again. Re-run the saved-purchase check
    // instead of leaving the original disabled button in place.
    window.addEventListener("pageshow", event => {
      if (!event.persisted) return;
      const restoredUrl = new URL(window.location.href);
      if (restoredUrl.searchParams.get("checkout") === "complete") {
        window.location.reload();
        return;
      }
      const hasSavedCheckout = (() => {
        try {
          return Boolean(localStorage.getItem(recoveryStorageKey) || localStorage.getItem(sessionStorageKey));
        } catch { return false; }
      })();
      if (!hasSavedCheckout) {
        setCheckoutButtonsDisabled(false);
        checkoutStatus.hidden = true;
        checkoutStatus.textContent = "";
        return;
      }
      setCheckoutButtonsDisabled(true, checkoutButton);
      checkoutStatus.hidden = false;
      checkoutStatus.textContent = "Проверяем оплату Stripe…";
      recoverSavedPurchase(false).then(recovered => {
        if (recovered) return;
        setCheckoutButtonsDisabled(false);
        checkoutStatus.textContent = "Stripe пока не подтвердил оплату. Если оплата уже прошла, не оплачивай повторно и напиши нам.";
      }).catch(() => {
        setCheckoutButtonsDisabled(false);
        checkoutStatus.textContent = "Не удалось проверить оплату. Если ты уже оплатила, не запускай оплату повторно — напиши нам.";
      });
    });
  }

  document.querySelectorAll(".results-card").forEach(card => {
    const video = card.querySelector("video");
    const playButton = card.querySelector(".results-play");
    if (!video || !playButton) return;

    const label = card.querySelector(".results-label")?.textContent || "";
    const syncPlaybackState = () => {
      const isPlaying = !video.paused && !video.ended;
      card.classList.toggle("is-playing", isPlaying);
      playButton.setAttribute("aria-label", `${isPlaying ? "Приостановить" : "Воспроизвести"} видео ${label}`);
      playButton.setAttribute("aria-pressed", String(isPlaying));
    };
    const togglePlayback = () => {
      if (video.paused) video.play().catch(syncPlaybackState);
      else video.pause();
    };

    playButton.addEventListener("click", togglePlayback);
    video.addEventListener("click", togglePlayback);
    ["play", "pause", "ended"].forEach(eventName => video.addEventListener(eventName, syncPlaybackState));
    syncPlaybackState();
  });

  const reviewGrid = document.querySelector(".review-grid");
  if (reviewGrid) {
    const reviewCards = [...reviewGrid.querySelectorAll(".review-card")];
    const reviewDots = [...document.querySelectorAll(".review-dot")];
    const previousButton = document.querySelector(".review-prev");
    const nextButton = document.querySelector(".review-next");
    const mobileLayout = window.matchMedia("(max-width: 560px)");
    let activeReview = 0;

    const updateReviews = () => {
      reviewCards.forEach((card, index) => {
        const isActive = index === activeReview;
        card.hidden = false;
        card.style.order = mobileLayout.matches ? String(index) : String((index - activeReview + reviewCards.length) % reviewCards.length);
        if (isActive) card.setAttribute("aria-current", "true");
        else card.removeAttribute("aria-current");
      });
      reviewGrid.style.transform = mobileLayout.matches ? `translateX(-${activeReview * 100}%)` : "";

      reviewDots.forEach((dot, index) => {
        const isActive = index === activeReview;
        dot.classList.toggle("is-active", isActive);
        dot.setAttribute("aria-pressed", String(isActive));
      });
    };

    const showReview = index => {
      activeReview = (index + reviewCards.length) % reviewCards.length;
      updateReviews();
    };

    previousButton.addEventListener("click", () => showReview(activeReview - 1));
    nextButton.addEventListener("click", () => showReview(activeReview + 1));
    reviewDots.forEach((dot, index) => dot.addEventListener("click", () => showReview(index)));
    mobileLayout.addEventListener("change", updateReviews);
    updateReviews();
  }
});
