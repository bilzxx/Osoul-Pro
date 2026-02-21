(function initSpotExchangeData(global) {
  'use strict';

  const VERIFIED_DATE = '2026-02-17';

  const COUNTRY_CATALOG = Object.freeze([
    { code: 'MA', nameAr: 'المغرب', nameEn: 'Morocco' },
    { code: 'FR', nameAr: 'فرنسا', nameEn: 'France' },
    { code: 'US', nameAr: 'الولايات المتحدة', nameEn: 'United States' },
    { code: 'AE', nameAr: 'الإمارات', nameEn: 'United Arab Emirates' },
    { code: 'SA', nameAr: 'السعودية', nameEn: 'Saudi Arabia' },
    { code: 'GB', nameAr: 'المملكة المتحدة', nameEn: 'United Kingdom' },
    { code: 'DE', nameAr: 'ألمانيا', nameEn: 'Germany' },
    { code: 'ES', nameAr: 'إسبانيا', nameEn: 'Spain' },
    { code: 'IT', nameAr: 'إيطاليا', nameEn: 'Italy' },
    { code: 'NL', nameAr: 'هولندا', nameEn: 'Netherlands' }
  ]);

  function makeFeeProfile(maker, taker, sourceUrl) {
    return Object.freeze({
      maker: Number(maker) || 0,
      taker: Number(taker) || 0,
      sourceUrl: String(sourceUrl || '').trim(),
      verifiedAt: VERIFIED_DATE
    });
  }

  // Official fee sources (Spot only) + shared verification date for this dataset.
  // verifiedAt is embedded in each profile via makeFeeProfile(...).
  const BINANCE_SOURCE = 'https://www.binance.com/en/fee/trading';
  const BYBIT_SOURCE = 'https://www.bybit.com/en/help-center/article/Bybit-Spot-Fees-Explained';
  const KRAKEN_SOURCE = 'https://www.kraken.com/features/fee-schedule';
  const COINBASE_SOURCE = 'https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees';
  const OKX_SOURCE = 'https://www.okx.com/learn/what-are-okx-trading-fees';
  const BITGET_SOURCE = 'https://www.bitget.com/fee/spot-trading';
  const KUCOIN_SOURCE = 'https://www.kucoin.com/vip/level';
  const GATEIO_SOURCE = 'https://www.gate.io/fee';
  const MEXC_SOURCE = 'https://www.mexc.com/fee';
  const BINGX_SOURCE = 'https://bingx.com/en-us/spot/fees/';
  const BITMART_SOURCE = 'https://www.bitmart.com/fee/en';
  const WEEX_SOURCE = 'https://www.weex.com/';
  const HTX_SOURCE = 'https://www.htx.com/fee/';

  const BINANCE_SPOT_REGULAR = makeFeeProfile(0.001, 0.001, BINANCE_SOURCE);
  const BYBIT_SPOT_REGULAR = makeFeeProfile(0.001, 0.001, BYBIT_SOURCE);
  const KRAKEN_SPOT_REGULAR = makeFeeProfile(0.0025, 0.004, KRAKEN_SOURCE);
  const COINBASE_SPOT_REGULAR = makeFeeProfile(0.004, 0.006, COINBASE_SOURCE);
  const OKX_SPOT_REGULAR = makeFeeProfile(0.0008, 0.001, OKX_SOURCE);
  const BITGET_SPOT_REGULAR = makeFeeProfile(0.001, 0.001, BITGET_SOURCE);
  const KUCOIN_SPOT_REGULAR = makeFeeProfile(0.001, 0.001, KUCOIN_SOURCE);
  const GATEIO_SPOT_REGULAR = makeFeeProfile(0.002, 0.002, GATEIO_SOURCE);
  const MEXC_SPOT_REGULAR = makeFeeProfile(0.001, 0.001, MEXC_SOURCE);
  const BINGX_SPOT_REGULAR = makeFeeProfile(0.001, 0.001, BINGX_SOURCE);
  const BITMART_SPOT_REGULAR = makeFeeProfile(0.001, 0.001, BITMART_SOURCE);
  const WEEX_SPOT_REGULAR = makeFeeProfile(0.001, 0.001, WEEX_SOURCE);
  const HTX_SPOT_REGULAR = makeFeeProfile(0.002, 0.002, HTX_SOURCE);

  function mapCountriesToFee(countries, feeProfile) {
    const result = {};
    countries.forEach((code) => {
      result[code] = feeProfile;
    });
    return Object.freeze(result);
  }

  function createIconConfig(simpleIconSlug, simpleColor, domain) {
    const slug = String(simpleIconSlug || '').trim().toLowerCase();
    const color = String(simpleColor || '').trim().replace('#', '');
    const normalizedDomain = String(domain || '').trim().toLowerCase();
    const iconUrl = slug
      ? `https://cdn.simpleicons.org/${slug}${color ? `/${color}` : ''}`
      : '';
    const fallbackList = [];

    if (slug) {
      fallbackList.push(`https://cdn.simpleicons.org/${slug}`);
      fallbackList.push(`https://cdn.jsdelivr.net/npm/simple-icons@v11/icons/${slug}.svg`);
    }
    if (normalizedDomain) {
      fallbackList.push(`https://logo.clearbit.com/${normalizedDomain}`);
      fallbackList.push(`https://icons.duckduckgo.com/ip3/${normalizedDomain}.ico`);
    }

    return Object.freeze({
      iconUrl,
      iconFallbackUrls: Object.freeze(Array.from(new Set(fallbackList))),
      iconSourceUrl: slug ? `https://simpleicons.org/icons/${slug}.svg` : ''
    });
  }

  function withLocalIcon(exchangeId, iconConfig) {
    const id = String(exchangeId || '').trim().toLowerCase();
    if (!id) return iconConfig;

    const localPath = LOCAL_ICON_PATHS[id] || `../assets/icons/exchanges/${id}.svg`;

    return Object.freeze({
      iconUrl: localPath,
      iconFallbackUrls: Object.freeze([localPath]),
      iconSourceUrl: localPath
    });
  }

  // Icon sources were downloaded from official exchange domains and stored locally.
  // This avoids runtime CORS/rate-limit failures and keeps rendering stable in static mode.
  const LOCAL_ICON_PATHS = Object.freeze({
    binance: '../assets/icons/exchanges/binance.png',
    coinbase: '../assets/icons/exchanges/coinbase.png',
    okx: '../assets/icons/exchanges/okx.png',
    bybit: '../assets/icons/exchanges/bybit.svg',
    bitget: '../assets/icons/exchanges/bitget.png',
    gateio: '../assets/icons/exchanges/gateio.png',
    kucoin: '../assets/icons/exchanges/kucoin.png',
    mexc: '../assets/icons/exchanges/mexc.png',
    bingx: '../assets/icons/exchanges/bingx.png',
    kraken: '../assets/icons/exchanges/kraken.png',
    bitmart: '../assets/icons/exchanges/bitmart.png',
    weex: '../assets/icons/exchanges/weex.png',
    htx: '../assets/icons/exchanges/htx.svg'
  });

  const NON_US_COUNTRIES = Object.freeze(['MA', 'FR', 'AE', 'SA', 'GB', 'DE', 'ES', 'IT', 'NL']);
  const GLOBAL_COUNTRIES = Object.freeze(COUNTRY_CATALOG.map((country) => country.code));

  const EXCHANGES = Object.freeze([
    {
      exchangeId: 'binance',
      name: 'Binance',
      ...withLocalIcon('binance', createIconConfig('binance', 'F3BA2F', 'binance.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        BINANCE_SPOT_REGULAR
      ),
      fallbackFees: BINANCE_SPOT_REGULAR,
      notes: 'Spot only. Regular/Non-VIP tier is used as default. VIP tiers are intentionally disabled.'
    },
    {
      exchangeId: 'coinbase',
      name: 'Coinbase',
      ...withLocalIcon('coinbase', createIconConfig('coinbase', '0052FF', 'coinbase.com')),
      countriesSupported: Object.freeze(['US', 'FR', 'GB', 'DE', 'ES', 'IT', 'NL']),
      feesByCountry: mapCountriesToFee(
        ['US', 'FR', 'GB', 'DE', 'ES', 'IT', 'NL'],
        COINBASE_SPOT_REGULAR
      ),
      fallbackFees: COINBASE_SPOT_REGULAR,
      notes: 'Spot only. Uses regular non-VIP fee tier from Coinbase Exchange help page.'
    },
    {
      exchangeId: 'okx',
      name: 'OKX',
      ...withLocalIcon('okx', createIconConfig('okx', 'FFFFFF', 'okx.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        OKX_SPOT_REGULAR
      ),
      fallbackFees: OKX_SPOT_REGULAR,
      notes: 'Spot only. Uses OKX Learn official baseline rates for Regular users.'
    },
    {
      exchangeId: 'bybit',
      name: 'Bybit',
      ...withLocalIcon('bybit', createIconConfig('bybit', 'F7A600', 'bybit.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        BYBIT_SPOT_REGULAR
      ),
      fallbackFees: BYBIT_SPOT_REGULAR,
      notes: 'Spot only. Bybit may apply regional adjustments; this uses public Regular defaults.'
    },
    {
      exchangeId: 'bitget',
      name: 'Bitget',
      ...withLocalIcon('bitget', createIconConfig('bitget', '00E5A8', 'bitget.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        BITGET_SPOT_REGULAR
      ),
      fallbackFees: BITGET_SPOT_REGULAR,
      notes: 'Spot only. Uses standard non-VIP spot fee baseline.'
    },
    // "Gate" المقصود بها Gate.io
    {
      exchangeId: 'gateio',
      name: 'Gate',
      ...withLocalIcon('gateio', createIconConfig('gateio', '2354E6', 'gate.io')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        GATEIO_SPOT_REGULAR
      ),
      fallbackFees: GATEIO_SPOT_REGULAR,
      notes: 'Spot only. Uses regular baseline rate.'
    },
    {
      exchangeId: 'kucoin',
      name: 'KuCoin',
      ...withLocalIcon('kucoin', createIconConfig('kucoin', '24AE8F', 'kucoin.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        KUCOIN_SPOT_REGULAR
      ),
      fallbackFees: KUCOIN_SPOT_REGULAR,
      notes: 'Spot only. Uses base regular tier; some tokens can have custom fee classes.'
    },
    {
      exchangeId: 'mexc',
      name: 'MEXC',
      ...withLocalIcon('mexc', createIconConfig('mexc', '2EE6D5', 'mexc.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        MEXC_SPOT_REGULAR
      ),
      fallbackFees: MEXC_SPOT_REGULAR,
      notes: 'Spot only. Uses standard base rate; promotional pair fees may differ.'
    },
    {
      exchangeId: 'bingx',
      name: 'BingX',
      ...withLocalIcon('bingx', createIconConfig('bingx', '007BFF', 'bingx.com')),
      countriesSupported: GLOBAL_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        GLOBAL_COUNTRIES,
        BINGX_SPOT_REGULAR
      ),
      fallbackFees: BINGX_SPOT_REGULAR,
      notes: 'Spot only. Uses standard baseline fee; event-based 0-fee pairs are excluded.'
    },
    {
      exchangeId: 'kraken',
      name: 'Kraken',
      ...withLocalIcon('kraken', createIconConfig('kraken', '5741D9', 'kraken.com')),
      countriesSupported: Object.freeze(['US', 'FR', 'MA', 'GB', 'DE', 'ES', 'IT', 'NL']),
      feesByCountry: mapCountriesToFee(
        ['US', 'FR', 'MA', 'GB', 'DE', 'ES', 'IT', 'NL'],
        KRAKEN_SPOT_REGULAR
      ),
      fallbackFees: KRAKEN_SPOT_REGULAR,
      notes: 'Spot only. Uses base maker/taker tier from official schedule.'
    },
    {
      exchangeId: 'bitmart',
      name: 'BitMart',
      ...withLocalIcon('bitmart', createIconConfig('bitmart', '16A5FF', 'bitmart.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        BITMART_SPOT_REGULAR
      ),
      fallbackFees: BITMART_SPOT_REGULAR,
      notes: 'Spot only. Uses regular baseline rate from official fee page.'
    },
    {
      exchangeId: 'weex',
      name: 'WEEX',
      ...withLocalIcon('weex', createIconConfig('', '', 'weex.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        WEEX_SPOT_REGULAR
      ),
      fallbackFees: WEEX_SPOT_REGULAR,
      notes: 'Spot only. Uses regular baseline rate. Verify latest regional policy from official source.'
    },
    {
      exchangeId: 'htx',
      name: 'HTX',
      ...withLocalIcon('htx', createIconConfig('htx', '4F86FF', 'htx.com')),
      countriesSupported: NON_US_COUNTRIES,
      feesByCountry: mapCountriesToFee(
        NON_US_COUNTRIES,
        HTX_SPOT_REGULAR
      ),
      fallbackFees: HTX_SPOT_REGULAR,
      notes: 'Spot only. Uses regular baseline rate from official fee page.'
    }
  ]);

  function normalizeCountryCode(countryCode) {
    return String(countryCode || '').trim().toUpperCase();
  }

  function normalizeExchangeId(exchangeId) {
    return String(exchangeId || '').trim().toLowerCase();
  }

  function getCountryByCode(countryCode) {
    const code = normalizeCountryCode(countryCode);
    return COUNTRY_CATALOG.find((country) => country.code === code) || null;
  }

  function getExchangeById(exchangeId) {
    const id = normalizeExchangeId(exchangeId);
    return EXCHANGES.find((exchange) => exchange.exchangeId === id) || null;
  }

  function getSupportedExchangesByCountry(countryCode) {
    const code = normalizeCountryCode(countryCode);
    return EXCHANGES.filter((exchange) => exchange.countriesSupported.includes(code));
  }

  function resolveFeeProfile(exchangeId, countryCode) {
    const exchange = getExchangeById(exchangeId);
    if (!exchange) return null;

    const code = normalizeCountryCode(countryCode);
    const byCountry = exchange.feesByCountry || {};
    const feeProfile = byCountry[code] || exchange.fallbackFees || null;

    if (!feeProfile) return null;

    return {
      exchangeId: exchange.exchangeId,
      exchangeName: exchange.name,
      countryCode: code,
      maker: Number(feeProfile.maker) || 0,
      taker: Number(feeProfile.taker) || 0,
      sourceUrl: String(feeProfile.sourceUrl || '').trim(),
      verifiedAt: String(feeProfile.verifiedAt || '').trim()
    };
  }

  function isFeeProfileStale(feeProfile, staleAfterDays = 30) {
    if (!feeProfile || !feeProfile.verifiedAt) return true;
    const verifiedDate = new Date(feeProfile.verifiedAt);
    if (Number.isNaN(verifiedDate.getTime())) return true;

    const thresholdMs = Math.max(1, Number(staleAfterDays) || 30) * 24 * 60 * 60 * 1000;
    const ageMs = Date.now() - verifiedDate.getTime();
    return ageMs > thresholdMs;
  }

  global.SpotExchangeData = Object.freeze({
    VERIFIED_DATE,
    COUNTRY_CATALOG,
    EXCHANGES,
    getCountryByCode,
    getExchangeById,
    getSupportedExchangesByCountry,
    resolveFeeProfile,
    isFeeProfileStale,
    normalizeCountryCode,
    normalizeExchangeId
  });
})(window);
