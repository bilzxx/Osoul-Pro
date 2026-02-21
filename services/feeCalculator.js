(function initSpotFeeCalculatorService(global) {
  'use strict';

  const STORAGE_KEYS = Object.freeze({
    country: 'spotFees.selectedCountry',
    exchange: 'spotFees.selectedExchange'
  });

  const DEFAULT_COUNTRY = 'US';
  const DEFAULT_RATE_TYPE = 'taker';

  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // Ignore storage write failures in private mode.
    }
  }

  function normalizeCountry(countryCode) {
    if (!global.SpotExchangeData) return String(countryCode || '').trim().toUpperCase();
    return global.SpotExchangeData.normalizeCountryCode(countryCode);
  }

  function normalizeExchange(exchangeId) {
    if (!global.SpotExchangeData) return String(exchangeId || '').trim().toLowerCase();
    return global.SpotExchangeData.normalizeExchangeId(exchangeId);
  }

  function getSupportedExchanges(countryCode) {
    if (!global.SpotExchangeData) return [];
    return global.SpotExchangeData.getSupportedExchangesByCountry(countryCode);
  }

  function pickDefaultExchange(countryCode) {
    const supported = getSupportedExchanges(countryCode);
    if (supported.length > 0) {
      return supported[0].exchangeId;
    }

    if (!global.SpotExchangeData || !Array.isArray(global.SpotExchangeData.EXCHANGES)) {
      return '';
    }

    return global.SpotExchangeData.EXCHANGES[0]?.exchangeId || '';
  }

  function getSelection() {
    const rawCountry = readStorage(STORAGE_KEYS.country);
    const countryCode = normalizeCountry(rawCountry || DEFAULT_COUNTRY);
    const rawExchange = readStorage(STORAGE_KEYS.exchange);
    let exchangeId = normalizeExchange(rawExchange || '');

    if (!exchangeId) {
      exchangeId = pickDefaultExchange(countryCode);
    }

    const supported = getSupportedExchanges(countryCode);
    const isExchangeSupported = supported.some((item) => item.exchangeId === exchangeId);
    if (!isExchangeSupported) {
      exchangeId = pickDefaultExchange(countryCode);
    }

    return {
      countryCode,
      exchangeId
    };
  }

  function saveSelection(countryCode, exchangeId) {
    const nextCountry = normalizeCountry(countryCode || DEFAULT_COUNTRY);
    const supported = getSupportedExchanges(nextCountry);
    let nextExchange = normalizeExchange(exchangeId || '');

    if (!nextExchange || !supported.some((item) => item.exchangeId === nextExchange)) {
      nextExchange = pickDefaultExchange(nextCountry);
    }

    if (!nextExchange) return getSelection();

    writeStorage(STORAGE_KEYS.country, nextCountry);
    writeStorage(STORAGE_KEYS.exchange, nextExchange);

    return {
      countryCode: nextCountry,
      exchangeId: nextExchange
    };
  }

  function getActiveFeeProfile() {
    if (!global.SpotExchangeData) return null;
    const selection = getSelection();
    return global.SpotExchangeData.resolveFeeProfile(selection.exchangeId, selection.countryCode);
  }

  function getAppliedFeeRate(profile, preferredRateType = DEFAULT_RATE_TYPE) {
    const normalizedType = String(preferredRateType || DEFAULT_RATE_TYPE).toLowerCase();
    const maker = toNumber(profile?.maker);
    const taker = toNumber(profile?.taker);
    if (normalizedType === 'maker') return maker;
    return taker;
  }

  function calculateSpotFees(input) {
    const buyAmountUSD = Math.max(0, toNumber(input?.buyAmountUSD));
    const sellAmountUSD = Math.max(0, toNumber(input?.sellAmountUSD));
    const feeRate = Math.max(0, toNumber(input?.feeRate));

    const buyFee = buyAmountUSD * feeRate;
    const sellFee = sellAmountUSD * feeRate;
    const totalFees = buyFee + sellFee;

    return {
      buyAmountUSD,
      sellAmountUSD,
      feeRate,
      buyFee,
      sellFee,
      totalFees
    };
  }

  function calculateWithActiveProfile(input, options = {}) {
    const activeProfile = getActiveFeeProfile();
    const preferredRateType = options.rateType || DEFAULT_RATE_TYPE;
    const appliedRate = getAppliedFeeRate(activeProfile, preferredRateType);
    const base = calculateSpotFees({
      buyAmountUSD: input?.buyAmountUSD,
      sellAmountUSD: input?.sellAmountUSD,
      feeRate: appliedRate
    });

    return {
      ...base,
      makerRate: toNumber(activeProfile?.maker),
      takerRate: toNumber(activeProfile?.taker),
      rateType: preferredRateType,
      sourceUrl: String(activeProfile?.sourceUrl || '').trim(),
      verifiedAt: String(activeProfile?.verifiedAt || '').trim(),
      exchangeId: String(activeProfile?.exchangeId || ''),
      exchangeName: String(activeProfile?.exchangeName || ''),
      countryCode: String(activeProfile?.countryCode || '')
    };
  }

  function isActiveFeeStale(staleAfterDays = 30) {
    if (!global.SpotExchangeData) return true;
    return global.SpotExchangeData.isFeeProfileStale(getActiveFeeProfile(), staleAfterDays);
  }

  global.spotFeeCalculatorService = Object.freeze({
    STORAGE_KEYS,
    DEFAULT_COUNTRY,
    getSelection,
    saveSelection,
    getActiveFeeProfile,
    getAppliedFeeRate,
    calculateSpotFees,
    calculateWithActiveProfile,
    isActiveFeeStale
  });
})(window);
