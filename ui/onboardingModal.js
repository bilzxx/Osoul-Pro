(function initSpotOnboardingModalUI(global) {
  'use strict';

  const MODAL_ID = 'spotFeesOnboardingModal';
  const BACKDROP_VISIBLE_CLASS = 'is-open';

  const state = {
    isMounted: false,
    isOpen: false,
    step: 1,
    countryCode: '',
    exchangeId: '',
    countrySearch: ''
  };

  function getDataApi() {
    return global.SpotExchangeData || null;
  }

  function getFeeApi() {
    return global.spotFeeCalculatorService || null;
  }

  function normalizeIso2(iso2) {
    const code = String(iso2 || '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : '';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getExchangeIconSources(exchange) {
    if (!exchange || typeof exchange !== 'object') return [];
    const urls = [];
    if (typeof exchange.iconUrl === 'string' && exchange.iconUrl.trim()) {
      urls.push(exchange.iconUrl.trim());
    }
    if (Array.isArray(exchange.iconFallbackUrls)) {
      exchange.iconFallbackUrls.forEach((url) => {
        if (typeof url === 'string' && url.trim()) {
          urls.push(url.trim());
        }
      });
    }
    if (typeof exchange.iconSourceUrl === 'string' && exchange.iconSourceUrl.trim()) {
      urls.push(exchange.iconSourceUrl.trim());
    }
    return Array.from(new Set(urls));
  }

  function getExchangeAbbr(name) {
    const normalized = String(name || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    return normalized.slice(0, 3) || 'EX';
  }

  function hydrateExchangeIcons(root) {
    if (!root) return;
    root.querySelectorAll('.spot-exchange-icon').forEach((iconWrap) => {
      if (iconWrap.dataset.hydrated === '1') return;
      iconWrap.dataset.hydrated = '1';

      const img = iconWrap.querySelector('img');
      if (!img) return;

      let sources = [];
      try {
        sources = JSON.parse(iconWrap.dataset.iconSources || '[]');
      } catch (error) {
        sources = [];
      }

      if (!Array.isArray(sources) || !sources.length) {
        iconWrap.classList.add('is-fallback');
        return;
      }

      let index = 0;
      const loadFromIndex = (nextIndex) => {
        if (nextIndex >= sources.length) {
          iconWrap.classList.add('is-fallback');
          img.removeAttribute('src');
          return;
        }
        index = nextIndex;
        img.src = String(sources[index] || '');
      };

      img.addEventListener('load', () => {
        iconWrap.classList.remove('is-fallback');
      });
      img.addEventListener('error', () => {
        loadFromIndex(index + 1);
      });

      loadFromIndex(0);
    });
  }

  function getFlagImageSources(iso2) {
    const code = normalizeIso2(iso2);
    if (!code) return [];
    const lowerCode = code.toLowerCase();
    return [
      `https://flagcdn.com/${lowerCode}.svg`,
      `https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@main/svg/${lowerCode}.svg`
    ];
  }

  function createFlagMarkup(iso2) {
    const code = normalizeIso2(iso2);
    if (!code) {
      return '<span class="spot-country-flag" aria-hidden="true"><span class="spot-flag-media is-fallback">--</span></span>';
    }
    return `<span class="spot-country-flag" aria-hidden="true"><span class="spot-flag-media is-fallback" data-code="${code}">${code}</span></span>`;
  }

  function hydrateFlagMedia(root) {
    if (!root) return;
    root.querySelectorAll('.spot-flag-media[data-code]').forEach((flagEl) => {
      if (flagEl.dataset.hydrated === '1') return;
      flagEl.dataset.hydrated = '1';
      const code = normalizeIso2(flagEl.dataset.code);
      if (!code) {
        flagEl.classList.add('is-fallback');
        flagEl.textContent = '--';
        return;
      }

      const sources = getFlagImageSources(code);
      if (!sources.length) {
        flagEl.classList.add('is-fallback');
        flagEl.textContent = code;
        return;
      }

      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      let sourceIndex = 0;

      const loadSource = (index) => {
        if (index >= sources.length) {
          flagEl.classList.add('is-fallback');
          flagEl.textContent = code;
          return;
        }
        sourceIndex = index;
        image.src = sources[sourceIndex];
      };

      image.addEventListener('load', () => {
        flagEl.classList.remove('is-fallback');
      });
      image.addEventListener('error', () => {
        loadSource(sourceIndex + 1);
      });
      flagEl.textContent = '';
      flagEl.appendChild(image);
      loadSource(0);
    });
  }

  function getModalEl() {
    return document.getElementById(MODAL_ID);
  }

  function normalizeSearchText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .trim();
  }

  function getCountriesFiltered() {
    const dataApi = getDataApi();
    const countries = dataApi?.COUNTRY_CATALOG || [];
    const query = normalizeSearchText(state.countrySearch);
    if (!query) return countries;

    return countries.filter((country) => {
      const text = normalizeSearchText(`${country.code} ${country.nameAr} ${country.nameEn}`);
      return text.includes(query);
    });
  }

  function renderStepIndicator(modal) {
    const indicatorEl = modal.querySelector('.spot-onboarding__steps');
    if (!indicatorEl) return;

    indicatorEl.innerHTML = `
      <span class="spot-step ${state.step === 1 ? 'is-active' : ''}">1</span>
      <span class="spot-step-sep"></span>
      <span class="spot-step ${state.step === 2 ? 'is-active' : ''}">2</span>
    `;
  }

  function renderCountryStep(modal) {
    const titleEl = modal.querySelector('#spotOnboardingTitle');
    const subtitleEl = modal.querySelector('#spotOnboardingSubtitle');
    const bodyEl = modal.querySelector('#spotOnboardingBody');
    const backBtn = modal.querySelector('#spotOnboardingBack');
    const confirmBtn = modal.querySelector('#spotOnboardingConfirm');

    if (!titleEl || !subtitleEl || !bodyEl || !backBtn || !confirmBtn) return;

    titleEl.textContent = 'اختر بلدك';
    subtitleEl.textContent = 'نحتاج البلد لتحديد رسوم المنصات المتاحة والرسوم الرسمية الصحيحة حسب المنطقة.';
    backBtn.hidden = true;
    confirmBtn.hidden = true;

    const buildCountriesHtml = (countries) => (
      countries.length
        ? countries
            .map((country) => {
              const isActive = state.countryCode === country.code;
              return `
                <button type="button" class="spot-country-item ${isActive ? 'is-active' : ''}" data-country="${country.code}">
                  ${createFlagMarkup(country.code)}
                  <span class="spot-country-names">
                    <strong>${country.nameAr}</strong>
                    <small>${country.nameEn}</small>
                  </span>
                  <span class="spot-country-code">${country.code}</span>
                </button>
              `;
            })
            .join('')
        : '<div class="spot-empty">لا توجد نتائج مطابقة.</div>'
    );

    const safeSearchValue = escapeHtml(state.countrySearch);
    bodyEl.innerHTML = `
      <div class="spot-country-search-wrap">
        <input id="spotCountrySearchInput" class="spot-input spot-country-search-input" type="text" dir="auto" inputmode="search" autocomplete="off" spellcheck="false" placeholder="ابحث عن بلد أو رمز الدولة (ISO2) مثل MA, FR, US" value="${safeSearchValue}">
      </div>
      <div class="spot-country-list" id="spotCountryList"></div>
    `;

    const countryListEl = bodyEl.querySelector('#spotCountryList');
    const renderCountryListItems = () => {
      if (!countryListEl) return;
      countryListEl.innerHTML = buildCountriesHtml(getCountriesFiltered());
      hydrateFlagMedia(countryListEl);
    };
    renderCountryListItems();

    const searchInput = bodyEl.querySelector('#spotCountrySearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (event) => {
        state.countrySearch = String(event.target.value || '');
        renderCountryListItems();
      });
      searchInput.focus();
    }

    countryListEl?.addEventListener('click', (event) => {
      const button = event.target.closest('.spot-country-item');
      if (!button) return;
      const previouslySelectedExchangeId = String(state.exchangeId || '').toLowerCase();
      state.countryCode = String(button.dataset.country || '').toUpperCase();
      if (!state.countryCode) return;
      const supported = getDataApi()?.getSupportedExchangesByCountry(state.countryCode) || [];
      const savedSelectionExchangeId = String(getFeeApi()?.getSelection?.().exchangeId || '').toLowerCase();
      const preferredExchangeId =
        [previouslySelectedExchangeId, savedSelectionExchangeId].find((exchangeId) =>
          supported.some((item) => item.exchangeId === exchangeId)
        ) || '';

      state.exchangeId = preferredExchangeId || supported[0]?.exchangeId || '';
      state.step = 2;
      state.countrySearch = '';
      render(modal);
    });
  }

  function renderExchangeStep(modal) {
    const dataApi = getDataApi();
    const feeApi = getFeeApi();
    const titleEl = modal.querySelector('#spotOnboardingTitle');
    const subtitleEl = modal.querySelector('#spotOnboardingSubtitle');
    const bodyEl = modal.querySelector('#spotOnboardingBody');
    const backBtn = modal.querySelector('#spotOnboardingBack');
    const confirmBtn = modal.querySelector('#spotOnboardingConfirm');

    if (!titleEl || !subtitleEl || !bodyEl || !backBtn || !confirmBtn || !dataApi || !feeApi) return;

    titleEl.textContent = 'اختر منصة التداول (Spot)';
    const country = dataApi.getCountryByCode(state.countryCode);
    const countryLabel = escapeHtml(country?.nameAr || state.countryCode || 'غير محدد');
    subtitleEl.innerHTML = `البلد المحدد: <span class="spot-selected-country">${countryLabel}</span> ${createFlagMarkup(state.countryCode)}`;
    backBtn.hidden = false;
    confirmBtn.hidden = false;
    confirmBtn.disabled = !state.exchangeId;
    confirmBtn.textContent = 'تأكيد';
    hydrateFlagMedia(modal);

    const exchanges = dataApi.getSupportedExchangesByCountry(state.countryCode);
    if (!state.exchangeId && exchanges.length) {
      state.exchangeId = exchanges[0].exchangeId;
      confirmBtn.disabled = false;
    }

    if (!exchanges.length) {
      bodyEl.innerHTML = `
        <div class="spot-empty">
          لا توجد منصة Spot مضافة لهذا البلد حالياً.
        </div>
      `;
      confirmBtn.disabled = true;
      return;
    }

    bodyEl.innerHTML = `
      <div class="spot-exchange-grid">
        ${exchanges
          .map((exchange) => {
            const profile = dataApi.resolveFeeProfile(exchange.exchangeId, state.countryCode);
            const makerPercent = (Number(profile?.maker) * 100).toFixed(3);
            const takerPercent = (Number(profile?.taker) * 100).toFixed(3);
            const isActive = state.exchangeId === exchange.exchangeId;
            const iconSources = getExchangeIconSources(exchange);
            const iconSourcesJson = escapeHtml(JSON.stringify(iconSources));
            const exchangeName = escapeHtml(exchange.name);
            const exchangeAbbr = escapeHtml(getExchangeAbbr(exchange.name));

            return `
              <div tabindex="0" role="button" class="spot-exchange-card ${isActive ? 'is-active' : ''}" data-exchange="${exchange.exchangeId}">
                <div class="spot-exchange-head">
                  <span class="spot-exchange-icon" data-icon-sources='${iconSourcesJson}' aria-hidden="true">
                    <img src="" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
                    <span class="spot-exchange-icon-fallback">${exchangeAbbr}</span>
                  </span>
                  <span class="spot-exchange-name">${exchangeName}</span>
                </div>
                <div class="spot-exchange-fees">
                  <span>Maker: ${makerPercent}%</span>
                  <span>Taker: ${takerPercent}%</span>
                </div>
                <div class="spot-exchange-meta">
                  <a href="${profile?.sourceUrl || '#'}" target="_blank" rel="noopener noreferrer" class="spot-source-link" title="فتح المصدر الرسمي">
                    <i class="fas fa-circle-info" aria-hidden="true"></i>
                    <span>المصدر الرسمي</span>
                  </a>
                  <span class="spot-verified-date">${profile?.verifiedAt || ''}</span>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
    hydrateExchangeIcons(bodyEl);

    const exchangeCards = Array.from(bodyEl.querySelectorAll('.spot-exchange-card'));
    const syncActiveExchangeCard = (activeExchangeId) => {
      const normalizedActiveId = String(activeExchangeId || '').toLowerCase();
      exchangeCards.forEach((cardEl) => {
        const cardExchangeId = String(cardEl.dataset.exchange || '').toLowerCase();
        cardEl.classList.toggle('is-active', cardExchangeId === normalizedActiveId);
      });
      confirmBtn.disabled = !normalizedActiveId;
    };

    exchangeCards.forEach((card) => {
      const activateCard = (event) => {
        const anchor = event.target.closest('a');
        if (anchor) return;
        const nextExchangeId = String(card.dataset.exchange || '').toLowerCase();
        if (!nextExchangeId) return;
        state.exchangeId = nextExchangeId;
        syncActiveExchangeCard(nextExchangeId);
      };

      card.addEventListener('click', activateCard);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activateCard(event);
        }
      });
    });
    syncActiveExchangeCard(state.exchangeId);

    backBtn.onclick = () => {
      state.step = 1;
      render(modal);
    };

    confirmBtn.onclick = () => {
      const saved = feeApi.saveSelection(state.countryCode, state.exchangeId);
      const profile = feeApi.getActiveFeeProfile();
      close();
      global.dispatchEvent(
        new CustomEvent('spot-fees:selection-changed', {
          detail: {
            countryCode: saved.countryCode,
            exchangeId: saved.exchangeId,
            profile
          }
        })
      );
    };
  }

  function render(modal) {
    renderStepIndicator(modal);
    if (state.step === 1) {
      renderCountryStep(modal);
      return;
    }
    renderExchangeStep(modal);
  }

  function ensureMounted() {
    if (state.isMounted) return;

    const wrapper = document.createElement('div');
    wrapper.id = MODAL_ID;
    wrapper.className = 'spot-onboarding';
    wrapper.hidden = true;
    wrapper.innerHTML = `
      <div class="spot-onboarding__backdrop"></div>
      <div class="spot-onboarding__dialog" role="dialog" aria-modal="true" aria-labelledby="spotOnboardingTitle">
        <header class="spot-onboarding__header">
          <div class="spot-onboarding__steps"></div>
          <h3 id="spotOnboardingTitle"></h3>
          <p id="spotOnboardingSubtitle"></p>
        </header>
        <section id="spotOnboardingBody" class="spot-onboarding__body"></section>
        <footer class="spot-onboarding__footer">
          <button id="spotOnboardingBack" type="button" class="spot-btn spot-btn--ghost">رجوع</button>
          <button id="spotOnboardingConfirm" type="button" class="spot-btn spot-btn--primary">تأكيد</button>
        </footer>
      </div>
    `;

    document.body.appendChild(wrapper);
    wrapper.addEventListener('click', (event) => {
      if (event.target.classList.contains('spot-onboarding__backdrop')) {
        close();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.isOpen) {
        close();
      }
    });

    state.isMounted = true;
  }

  function open(options = {}) {
    const dataApi = getDataApi();
    const feeApi = getFeeApi();
    if (!dataApi || !feeApi) return;

    ensureMounted();
    const modal = getModalEl();
    if (!modal) return;

    const selection = feeApi.getSelection();
    state.countryCode = String(options.countryCode || selection.countryCode || 'US').toUpperCase();
    state.exchangeId = String(options.exchangeId || selection.exchangeId || '').toLowerCase();

    const supported = dataApi.getSupportedExchangesByCountry(state.countryCode) || [];
    if (!supported.some((item) => item.exchangeId === state.exchangeId)) {
      state.exchangeId = supported[0]?.exchangeId || '';
    }

    const shouldOpenOnExchangeStep = Boolean(options.force) && Boolean(state.countryCode) && supported.length > 0;
    state.step = shouldOpenOnExchangeStep ? 2 : 1;
    state.countrySearch = '';

    modal.hidden = false;
    requestAnimationFrame(() => {
      modal.classList.add(BACKDROP_VISIBLE_CLASS);
    });
    document.body.classList.add('modal-open');
    state.isOpen = true;
    render(modal);
  }

  function close() {
    const modal = getModalEl();
    if (!modal) return;
    modal.classList.remove(BACKDROP_VISIBLE_CLASS);
    state.isOpen = false;
    setTimeout(() => {
      if (!state.isOpen) {
        modal.hidden = true;
      }
    }, 180);
    document.body.classList.remove('modal-open');
  }

  function maybeOpenOnFirstVisit() {
    const feeApi = getFeeApi();
    if (!feeApi) return;
    const selection = feeApi.getSelection();
    const keys = feeApi.STORAGE_KEYS || {};
    let hasCountry = false;
    let hasExchange = false;

    try {
      hasCountry = Boolean(localStorage.getItem(keys.country || ''));
      hasExchange = Boolean(localStorage.getItem(keys.exchange || ''));
    } catch (error) {
      hasCountry = false;
      hasExchange = false;
    }

    if (!hasCountry || !hasExchange || !selection.exchangeId) {
      open();
    }
  }

  global.spotOnboardingModalUI = Object.freeze({
    open,
    close,
    maybeOpenOnFirstVisit
  });
})(window);
