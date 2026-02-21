(function initSpotExchangeSettingsUI(global) {
  'use strict';

  const ELEMENT_IDS = Object.freeze({
    button: 'exchangeSettingsBtn',
    label: 'exchangeSettingsLabel',
    flag: 'exchangeSettingsCountryFlag',
    warning: 'exchangeFeeWarning',
    warningText: 'exchangeFeeWarningText',
    warningAction: 'exchangeFeeWarningAction'
  });

  const STALE_DAYS_LIMIT = 30;
  let isBound = false;

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

  function getFlagImageSources(iso2) {
    const code = normalizeIso2(iso2);
    if (!code) return [];
    const lowerCode = code.toLowerCase();
    return [
      `https://flagcdn.com/${lowerCode}.svg`,
      `https://cdn.jsdelivr.net/gh/hampusborgos/country-flags@main/svg/${lowerCode}.svg`
    ];
  }

  function setCountryFlag(flagEl, iso2) {
    if (!flagEl) return;
    const code = normalizeIso2(iso2);
    if (!code) {
      flagEl.innerHTML = '<span class="spot-flag-media is-fallback">--</span>';
      return;
    }

    flagEl.innerHTML = `<span class="spot-flag-media is-fallback" data-code="${code}">${code}</span>`;
    const mediaEl = flagEl.querySelector('.spot-flag-media');
    if (!mediaEl) return;
    const sources = getFlagImageSources(code);
    if (!sources.length) {
      mediaEl.classList.add('is-fallback');
      mediaEl.textContent = code;
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
        mediaEl.classList.add('is-fallback');
        mediaEl.textContent = code;
        return;
      }
      sourceIndex = index;
      image.src = sources[sourceIndex];
    };

    image.addEventListener('load', () => {
      mediaEl.classList.remove('is-fallback');
    });
    image.addEventListener('error', () => {
      loadSource(sourceIndex + 1);
    });
    mediaEl.textContent = '';
    mediaEl.appendChild(image);
    loadSource(0);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setWarningVisible(visible) {
    const warningEl = $(ELEMENT_IDS.warning);
    if (!warningEl) return;
    warningEl.hidden = !visible;
  }

  function render() {
    const feeApi = getFeeApi();
    const dataApi = getDataApi();
    if (!feeApi || !dataApi) return;

    const buttonEl = $(ELEMENT_IDS.button);
    const labelEl = $(ELEMENT_IDS.label);
    const flagEl = $(ELEMENT_IDS.flag);
    const warningTextEl = $(ELEMENT_IDS.warningText);
    const warningActionEl = $(ELEMENT_IDS.warningAction);
    if (!buttonEl || !labelEl || !flagEl) return;

    const selection = feeApi.getSelection();
    const country = dataApi.getCountryByCode(selection.countryCode);
    const exchange = dataApi.getExchangeById(selection.exchangeId);
    const profile = feeApi.getActiveFeeProfile();

    const countryLabel = country?.nameAr || selection.countryCode || 'بلد غير محدد';
    const exchangeLabel = exchange?.name || selection.exchangeId || 'منصة غير محددة';
    const makerPercent = ((Number(profile?.maker) || 0) * 100).toFixed(3);
    const takerPercent = ((Number(profile?.taker) || 0) * 100).toFixed(3);

    labelEl.textContent = `${countryLabel} / ${exchangeLabel}`;
    setCountryFlag(flagEl, selection.countryCode);
    buttonEl.title = `Spot Fees (${selection.countryCode} - ${exchangeLabel}) | Maker ${makerPercent}% | Taker ${takerPercent}%`;

    const isStale = feeApi.isActiveFeeStale(STALE_DAYS_LIMIT);
    if (isStale && profile?.sourceUrl) {
      setWarningVisible(true);
      if (warningTextEl) {
        warningTextEl.textContent = 'قد تكون الرسوم تغيّرت - تحقق من المصدر';
      }
      if (warningActionEl) {
        warningActionEl.onclick = () => {
          window.open(profile.sourceUrl, '_blank', 'noopener,noreferrer');
        };
      }
    } else {
      setWarningVisible(false);
    }
  }

  function bindEvents() {
    if (isBound) return;
    isBound = true;

    const buttonEl = $(ELEMENT_IDS.button);
    if (buttonEl) {
      buttonEl.addEventListener('click', () => {
        if (global.spotOnboardingModalUI?.open) {
          global.spotOnboardingModalUI.open({ force: true });
        }
      });
    }

    global.addEventListener('spot-fees:selection-changed', () => {
      render();
    });
  }

  function init() {
    bindEvents();
    render();
  }

  global.spotExchangeSettingsUI = Object.freeze({
    init,
    render
  });
})(window);
