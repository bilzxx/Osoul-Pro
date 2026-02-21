


const RETRY_CONFIG = {
    MAX_RETRIES: 5,
    INITIAL_DELAY: 1000,
    MAX_DELAY: 30000,
    BACKOFF_MULTIPLIER: 2,
    TIMEOUT: 5000
};

const BINANCE_SPOT_PRICE_ENDPOINTS = [
    'https://api.binance.com/api/v3/ticker/price',
    'https://data-api.binance.vision/api/v3/ticker/price'
];

const QUOTE_ASSET_SUFFIXES = ['FDUSD', 'USDT', 'USDC', 'BUSD', 'TUSD', 'USD', 'BTC', 'ETH'];
const REQUIRED_PAIR_QUOTES = ['USDT', 'USDC', 'BTC', 'ETH'];
const SUPPORTED_PAIR_QUOTES = Array.from(new Set([...REQUIRED_PAIR_QUOTES, ...QUOTE_ASSET_SUFFIXES]))
    .sort((left, right) => right.length - left.length);
const UPDATE_NOTICE_ENDPOINT = new URL('../update_popup.json', window.location.href).toString();
const SW_FILE_URL = new URL('../service-worker.js', window.location.href).toString();
const SW_SCOPE_PATH = (() => {
    const scopePath = new URL('../', window.location.href).pathname;
    return scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
})();
const LS_KEY_LAST_SEEN_UPDATE_NOTICE_ID = 'osoulPro_lastSeenUpdateNoticeId';
const MANUAL_UPDATE_CHECK_COOLDOWN_MS = 15000;
const MANUAL_UPDATE_CHECK_MIN_LOADING_MS = 650;

let pwaRegistration = null;
let waitingServiceWorker = null;
let shouldReloadAfterSwActivation = false;
let latestUpdateNoticePayload = null;
let isAppUpdatePopupEventsBound = false;
let isManualUpdateCheckInProgress = false;
let lastManualUpdateCheckAt = 0;

function getAppUpdatePopupElements() {
    return {
        overlay: document.getElementById('appUpdatePopup'),
        title: document.getElementById('appUpdateTitle'),
        versionText: document.getElementById('appUpdateVersion'),
        notesList: document.getElementById('appUpdateNotes'),
        closeBtn: document.getElementById('appUpdateCloseBtn'),
        installHint: document.getElementById('appInstallHint')
    };
}

function getFooterUpdateCheckElements() {
    const button = document.getElementById('footerUpdateCheckBtn');
    return {
        button,
        icon: button?.querySelector('i') || null,
        label: button?.querySelector('.footer-update-check-label') || null
    };
}

function setFooterUpdateCheckButtonState(isLoading = false, temporaryLabel = '') {
    const { button, icon, label } = getFooterUpdateCheckElements();
    if (!button || !label) return;

    const currentLabel = String(label.textContent || '').trim();
    if (!button.dataset.defaultLabel && currentLabel) {
        button.dataset.defaultLabel = currentLabel;
    }

    const defaultLabel = button.dataset.defaultLabel || 'التحقق من التحديثات';
    button.disabled = !!isLoading;
    button.classList.toggle('is-loading', !!isLoading);
    if (icon) icon.classList.toggle('fa-spin', !!isLoading);

    if (isLoading) {
        label.textContent = temporaryLabel || 'جارٍ فحص التحديثات...';
        return;
    }

    label.textContent = defaultLabel;
}

function bindFooterUpdateCheckButton() {
    const footerUpdateCheckBtn = document.getElementById('footerUpdateCheckBtn');
    if (!footerUpdateCheckBtn) return;
    if (footerUpdateCheckBtn.dataset.boundUpdateCheck === '1') return;

    footerUpdateCheckBtn.addEventListener('click', handleManualUpdateCheck);
    footerUpdateCheckBtn.dataset.boundUpdateCheck = '1';
    setFooterUpdateCheckButtonState(false);
}

function normalizeUpdateNoticePayload(payload) {
    if (!payload || typeof payload !== 'object') return null;

    const updateId = String(payload.updateId || payload.id || payload.version || '').trim();
    if (!updateId) return null;

    const notes = Array.isArray(payload.notes)
        ? payload.notes.map((note) => String(note || '').trim()).filter(Boolean)
        : [];

    return {
        updateId,
        title: String(payload.title || 'تحديث جديد متوفر').trim() || 'تحديث جديد متوفر',
        version: String(payload.version || '').trim(),
        summary: String(payload.summary || payload.message || '').trim(),
        publishedAt: String(payload.publishedAt || '').trim(),
        notes
    };
}

function getLastSeenUpdateNoticeId() {
    return localStorage.getItem(LS_KEY_LAST_SEEN_UPDATE_NOTICE_ID) || '';
}

function markUpdateNoticeAsSeen(updateId) {
    const normalizedId = String(updateId || '').trim();
    if (!normalizedId) return;
    localStorage.setItem(LS_KEY_LAST_SEEN_UPDATE_NOTICE_ID, normalizedId);
}

async function fetchLatestUpdateNotice() {
    const response = await fetch(UPDATE_NOTICE_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`update_popup HTTP ${response.status}`);
    }

    const payload = await response.json();
    return normalizeUpdateNoticePayload(payload);
}

function isIosDevice() {
    const userAgent = navigator.userAgent || '';
    return /iPad|iPhone|iPod/i.test(userAgent);
}

function isStandaloneMode() {
    const matchStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const iosStandalone = window.navigator.standalone === true;
    return matchStandalone || iosStandalone;
}

function renderIosInstallHint() {
    const { installHint } = getAppUpdatePopupElements();
    if (!installHint) return;

    if (isIosDevice() && !isStandaloneMode()) {
        installHint.hidden = false;
        installHint.textContent = 'لتثبيت التطبيق على iPhone: من Safari اضغط مشاركة ثم اختر Add to Home Screen.';
        return;
    }

    installHint.hidden = true;
    installHint.textContent = '';
}

function showAppUpdatePopup(payload) {
    const { overlay, title, versionText, notesList } = getAppUpdatePopupElements();
    const normalizedPayload = normalizeUpdateNoticePayload(payload);
    if (!overlay || !title || !versionText || !notesList || !normalizedPayload) return;

    const { updateId, version, summary, publishedAt, notes } = normalizedPayload;
    overlay.dataset.updateId = updateId;
    title.textContent = normalizedPayload.title;

    const metaParts = [];
    if (version) metaParts.push(`الإصدار: ${version}`);
    if (publishedAt) metaParts.push(`تاريخ النشر: ${publishedAt}`);
    versionText.innerHTML = '';
    if (metaParts.length === 0) {
        const fallbackBadge = document.createElement('span');
        fallbackBadge.className = 'app-update-popup__meta-badge';
        fallbackBadge.textContent = 'تفاصيل التحديث الجديد';
        versionText.appendChild(fallbackBadge);
    } else {
        metaParts.forEach((part) => {
            const badge = document.createElement('span');
            badge.className = 'app-update-popup__meta-badge';
            badge.textContent = part;
            versionText.appendChild(badge);
        });
    }

    notesList.innerHTML = '';
    const displayNotes = [];
    if (summary) displayNotes.push(summary);
    displayNotes.push(...notes);
    if (displayNotes.length === 0) {
        displayNotes.push('تحسينات عامة على الأداء والاستقرار.');
    }

    displayNotes.forEach((note) => {
        const item = document.createElement('li');
        item.textContent = note;
        notesList.appendChild(item);
    });

    renderIosInstallHint();

    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('app-update-popup-open');
}

function hideAppUpdatePopup() {
    const { overlay } = getAppUpdatePopupElements();
    if (!overlay) return;

    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('app-update-popup-open');
}

function dismissAppUpdatePopup() {
    hideAppUpdatePopup();
}

function bindAppUpdatePopupEvents() {
    if (isAppUpdatePopupEventsBound) return;
    isAppUpdatePopupEventsBound = true;

    const { overlay, closeBtn } = getAppUpdatePopupElements();
    if (!overlay || !closeBtn) return;

    closeBtn.addEventListener('click', () => {
        dismissAppUpdatePopup();
    });

    overlay.addEventListener('click', (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.dataset.action === 'dismiss-update') {
            dismissAppUpdatePopup();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (overlay.hidden) return;
        dismissAppUpdatePopup();
    });
}

function handleServiceWorkerMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'PWA_UPDATE_READY') {
        waitingServiceWorker = pwaRegistration?.waiting || waitingServiceWorker;
    }
}

async function registerAppServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (!window.isSecureContext && !isLocalhost) return;

    try {
        pwaRegistration = await navigator.serviceWorker.register(SW_FILE_URL, { scope: SW_SCOPE_PATH });
        waitingServiceWorker = pwaRegistration.waiting || null;

        pwaRegistration.addEventListener('updatefound', () => {
            const newWorker = pwaRegistration.installing;
            if (!newWorker) return;

            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    waitingServiceWorker = pwaRegistration.waiting || newWorker;
                }
            });
        });

        navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (shouldReloadAfterSwActivation) {
                shouldReloadAfterSwActivation = false;
                window.location.reload();
            }
        });

        pwaRegistration.update().catch((error) => {
            console.warn('[PWA] registration.update() failed:', error);
        });
    } catch (error) {
        console.warn('[PWA] Service worker registration failed:', error);
    }
}

async function checkForUpdates(options = {}) {
    const { forcePrompt = false } = options;

    try {
        const payload = await fetchLatestUpdateNotice();
        if (!payload) {
            return { status: 'empty', payload: null };
        }

        latestUpdateNoticePayload = payload;
        const alreadySeen = getLastSeenUpdateNoticeId() === payload.updateId;
        if (!forcePrompt && alreadySeen) {
            return { status: 'already_seen', payload };
        }

        showAppUpdatePopup(payload);
        if (!forcePrompt) {
            markUpdateNoticeAsSeen(payload.updateId);
        }

        return { status: 'shown', payload };
    } catch (error) {
        console.warn('[PWA] checkForUpdates failed:', error);
        return { status: 'error', payload: null, error };
    }
}

async function handleManualUpdateCheck() {
    if (isManualUpdateCheckInProgress) return;

    const now = Date.now();
    const cooldownRemainingMs = MANUAL_UPDATE_CHECK_COOLDOWN_MS - (now - lastManualUpdateCheckAt);
    if (cooldownRemainingMs > 0) {
        const remainingSeconds = Math.ceil(cooldownRemainingMs / 1000);
        showToast(`تم الفحص قبل لحظات. أعد المحاولة بعد ${remainingSeconds} ثانية.`, 'info', 2500);
        return;
    }

    isManualUpdateCheckInProgress = true;
    lastManualUpdateCheckAt = now;
    setFooterUpdateCheckButtonState(true, 'جارٍ فحص التحديثات...');
    const loadingStart = Date.now();

    try {
        const result = await checkForUpdates({ forcePrompt: true });
        const elapsed = Date.now() - loadingStart;
        if (elapsed < MANUAL_UPDATE_CHECK_MIN_LOADING_MS) {
            await new Promise((resolve) => setTimeout(resolve, MANUAL_UPDATE_CHECK_MIN_LOADING_MS - elapsed));
        }

        if (result?.status === 'shown') {
            const versionSuffix = result?.payload?.version ? ` (${result.payload.version})` : '';
            showToast(`تم عرض تفاصيل التحديث${versionSuffix}.`, 'success', 3200);
            return;
        }

        if (result?.status === 'empty' || result?.status === 'already_seen') {
            showToast('لا توجد رسالة تحديث جديدة حالياً.', 'info', 3000);
            return;
        }

        showToast('تعذر التحقق من التحديثات حالياً. حاول مرة أخرى.', 'warning', 3400);
    } catch (error) {
        console.warn('[PWA] manual update check failed:', error);
        showToast('تعذر التحقق من التحديثات حالياً. حاول مرة أخرى.', 'warning', 3400);
    } finally {
        setFooterUpdateCheckButtonState(false);
        isManualUpdateCheckInProgress = false;
    }
}


// =========================================
//       WhatsApp Bug Report System
// =========================================

// Config
const BUG_REPORT_CONFIG = {
    PHONE: '212625904452', // Provided Number
    WHATSAPP_URL: 'https://wa.me/'
};

// 1. Collect System Data
function collectBugData() {
    return {
        url: window.location.href,
        userAgent: navigator.userAgent,
        os: navigator.platform,
        screenSize: `${window.screen.width}x${window.screen.height}`,
        timestamp: new Date().toLocaleString('en-US', { hour12: true })
    };
}

// 2. Format Message (Clean Professional Text)
function formatWhatsAppMessage(formData, systemData) {
    const typeLabels = {
        bug: 'BUG',
        ui: 'UI',
        performance: 'PERFORMANCE',
        suggestion: 'SUGGESTION'
    };

    const typeLabel = typeLabels[formData.type] || String(formData.type || '').toUpperCase();

    return `
*BUG REPORT*
────────────────
TYPE: ${typeLabel}
TITLE: ${formData.title}
SEVERITY: ${formData.severity.toUpperCase()}
────────────────
DESCRIPTION:
${formData.description}
    `.trim();
}

// 3. UI: Open Modal
function openBugReportModal() {
    // Close other dropdowns first
    const dropdowns = document.querySelectorAll('.notification-dropdown, .user-dropdown');
    dropdowns.forEach(d => d.classList.remove('active'));

    const modal = document.getElementById('bugReportModal');
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Reset to initial state
        const formBody = document.getElementById('bugReportFormBody');
        const preview = document.getElementById('bugReportPreview');
        const success = document.getElementById('bugReportSuccess');

        if (formBody) formBody.style.display = 'block';
        if (preview) preview.style.display = 'none';
        if (success) success.style.display = 'none';

        // Reset form
        const form = document.getElementById('bugReportForm');
        if (form) form.reset();
        toggleSeverity(true);

        // Reset file label
        const fileLabel = document.getElementById('fileNameDisplay');
        if (fileLabel) fileLabel.textContent = 'اختر ملف (اختياري)...';

        setTimeout(() => {
            const titleInput = document.getElementById('bugTitle');
            if (titleInput) titleInput.focus();
        }, 100);
    }
}

function closeBugReportModal() {
    const modal = document.getElementById('bugReportModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// 4. Logic: Prepare Preview
async function prepareBugPreview() {
    const btn = document.getElementById('submitBugBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');

    // Basic Validation
    const title = document.getElementById('bugTitle').value;
    const desc = document.getElementById('bugDescription').value;

    if (!title.trim() || !desc.trim()) {
        alert('يرجى ملء العنوان والوصف للمتابعة.');
        return;
    }

    // UX Loading
    if (btn) {
        btn.disabled = true;
        if (btnText) btnText.style.display = 'none';
        if (btnLoader) btnLoader.style.display = 'inline-block';
    }

    // Simulate Processing time
    await new Promise(r => setTimeout(r, 600));

    // Gather Data
    const formData = {
        type: document.querySelector('input[name="issueType"]:checked')?.value || 'bug',
        severity: document.querySelector('input[name="severity"]:checked')?.value || 'medium',
        title: title,
        description: desc
    };

    const systemData = collectBugData();

    // Format Message
    const message = formatWhatsAppMessage(formData, systemData);

    // Store message for sending phase
    window.currentBugMessage = message;

    // Show Preview UI
    const formBody = document.getElementById('bugReportFormBody');
    const previewSection = document.getElementById('bugReportPreview');
    const previewBox = document.getElementById('whatsappPreviewText');

    if (formBody) formBody.style.display = 'none';
    if (previewSection) previewSection.style.display = 'block';
    if (previewBox) {
        previewBox.textContent = message;
        // Ensure scroll to top
        previewBox.scrollTop = 0;
    }

    // Reset Button
    if (btn) {
        btn.disabled = false;
        if (btnText) btnText.style.display = 'inline-block';
        if (btnLoader) btnLoader.style.display = 'none';
    }
}

// 5. Logic: Back to Form
function backToBugForm() {
    const preview = document.getElementById('bugReportPreview');
    const form = document.getElementById('bugReportFormBody');
    if (preview) preview.style.display = 'none';
    if (form) form.style.display = 'block';
}

// 6. Logic: Confirm & Send
function confirmSendWhatsApp() {
    if (!window.currentBugMessage) return;

    const encodedMessage = encodeURIComponent(window.currentBugMessage);
    const whatsappLink = `${BUG_REPORT_CONFIG.WHATSAPP_URL}${BUG_REPORT_CONFIG.PHONE}?text=${encodedMessage}`;

    // Open WhatsApp
    window.open(whatsappLink, '_blank');

    // Show Success State
    const preview = document.getElementById('bugReportPreview');
    const success = document.getElementById('bugReportSuccess');
    if (preview) preview.style.display = 'none';
    if (success) success.style.display = 'block';
}

// UI Helpers
function toggleSeverity(show) {
    const group = document.getElementById('severityGroup');
    const form = document.getElementById('bugReportForm');
    if (group) {
        group.style.display = show ? '' : 'none';
    }
    if (form) {
        form.classList.toggle('bug-no-severity', !show);
    }
}

function handleFileSelect(input) {
    // Function removed
}

// Global Listeners
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBugReportModal();
});

document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('bugReportModal');
    if (modal) {
        modal.addEventListener('click', function (e) {
            if (e.target === this) {
                closeBugReportModal();
            }
        });
    }
});
// Unified dropdown toggle function - reduces code duplication
function toggleDropdown(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    const backdrop = document.getElementById('dropdownBackdrop');
    if (!dropdown) return;

    const isCurrentlyOpen = dropdown.classList.contains('active');

    // Close Bug Report Modal if open
    closeBugReportModal();

    // Close all dropdowns
    document.querySelectorAll('.notification-dropdown').forEach(d => {
        d.classList.remove('active');
    });

    // Remove active from all buttons
    document.querySelectorAll('.header-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // Toggle the requested dropdown
    if (!isCurrentlyOpen) {
        dropdown.classList.add('active');
        if (backdrop) {
            backdrop.classList.add('active');
            document.body.style.overflow = 'hidden';
        }
    } else {
        if (backdrop) {
            backdrop.classList.remove('active');
            document.body.style.overflow = '';
        }
    }
}

// Wrapper functions for backward compatibility
function toggleMessages() {
    toggleDropdown('messagesDropdown');
}

function toggleNotifications() {
    toggleDropdown('notificationDropdown');
}

function toggleSettings() {
    toggleDropdown('settingsDropdown');
}



// Close dropdowns when clicking outside
document.addEventListener('click', function (event) {
    const allDropdowns = document.querySelectorAll('.notification-dropdown');
    const clickedInsideDropdown = event.target.closest('.notification-dropdown');
    const clickedButton = event.target.closest('.header-btn, .user-btn');

    // If clicked outside dropdown and not on a button, close all dropdowns
    if (!clickedInsideDropdown && !clickedButton) {
        allDropdowns.forEach(dropdown => {
            dropdown.classList.remove('active');
        });
    }
});



async function retryWithBackoff(operation, operationName, maxRetries = RETRY_CONFIG.MAX_RETRIES) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await operation();


            if (result && result.price !== null && result.error === null) {
                if (attempt > 0) {
                    console.log(`[OK] ${operationName} نجح في المحاولة ${attempt + 1}`);
                }
                return result;
            }


            lastError = result?.error || 'لا توجد بيانات سعر متاحة';
        } catch (error) {
            lastError = error;
            console.warn(`[WARN] ${operationName} المحاولة ${attempt + 1} فشلت: `, error.message);
        }


        if (attempt < maxRetries) {
            const delay = Math.min(
                RETRY_CONFIG.INITIAL_DELAY * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, attempt),
                RETRY_CONFIG.MAX_DELAY
            );
            console.log(`[RETRY] إعادة محاولة ${operationName} خلال ${delay}ms... (محاولة ${attempt + 2}/${maxRetries + 1})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }


    console.error(`[ERROR] ${operationName} فشل بعد ${maxRetries + 1} محاولات`);
    return { symbol: operationName, price: null, source: null, error: lastError };
}



function toggleMessages() {
    const dropdown = document.getElementById('messagesDropdown');
    const notificationDropdown = document.getElementById('notificationDropdown');


    if (notificationDropdown) {
        notificationDropdown.classList.remove('active');
    }


    dropdown.classList.toggle('active');
}

function toggleSettings() {
    const dropdown = document.getElementById('settingsDropdown');
    const messagesDropdown = document.getElementById('messagesDropdown');
    const notificationDropdown = document.getElementById('notificationDropdown');
    if (messagesDropdown) messagesDropdown.classList.remove('active');
    if (notificationDropdown) notificationDropdown.classList.remove('active');
    dropdown.classList.toggle('active');
}


document.addEventListener('click', function (event) {
    const messagesWrapper = document.querySelector('.messages-wrapper');
    const messagesDropdown = document.getElementById('messagesDropdown');
    const notificationWrapper = document.querySelector('.notification-wrapper');
    const notificationDropdown = document.getElementById('notificationDropdown');
    const settingsWrapper = document.querySelector('.settings-wrapper');
    const settingsDropdown = document.getElementById('settingsDropdown');



    if (messagesWrapper && messagesDropdown && !messagesWrapper.contains(event.target)) {
        messagesDropdown.classList.remove('active');
    }


    if (notificationWrapper && notificationDropdown && !notificationWrapper.contains(event.target)) {
        notificationDropdown.classList.remove('active');
    }

    if (settingsWrapper && settingsDropdown && !settingsWrapper.contains(event.target)) {
        settingsDropdown.classList.remove('active');
    }


});










const coinIconCache = {};


function getCoinSymbol(fullSymbol) {
    const normalized = normalizeInput(fullSymbol);
    if (!normalized) return '';

    if (normalized.includes('/')) {
        const parsedPair = parsePair(normalized);
        if (parsedPair.base) return parsedPair.base;
    }

    if (SUPPORTED_PAIR_QUOTES.includes(normalized) || normalized === 'BNB') {
        return normalized;
    }

    return normalized.replace(/USDT$|USDC$|BUSD$|USD$|BTC$|ETH$|BNB$/i, '');
}



function getCoinIconSources(coinSymbol) {
    const symbol = coinSymbol.toLowerCase();
    const symbolUpper = coinSymbol.toUpperCase();


    const coinCapSpecialNames = {
        'dot': 'dot2',
        'uni': 'uniswap',
        'sand': 'sandbox',
        'mana': 'decentraland',
        'bnb': 'binancecoin',
        'atom': 'cosmos',
        'link': 'chainlink',
        'avax': 'avalanche-2'
    };

    const coinCapSymbol = coinCapSpecialNames[symbol] || symbol;

    return [

        `https://cryptoicons.org/api/icon/${symbol}/200`,


        `https://assets.coincap.io/assets/icons/${coinCapSymbol}@2x.png`,


        `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons@master/128/color/${symbol}.png`,


        `https://s3-symbol-logo.tradingview.com/crypto/XTVC${symbolUpper}.svg`,
        `https://s3-symbol-logo.tradingview.com/${symbol}.svg`,


        `https://lcw.nyc3.cdn.digitaloceanspaces.com/production/currencies/64/${symbol}.png`
    ];
}


function getCoinMarketCapId(symbol) {
    const ids = {

        'btc': 1, 'eth': 1027, 'bnb': 1839, 'usdt': 825, 'usdc': 3408,
        'xrp': 52, 'ada': 2010, 'doge': 74, 'sol': 5426, 'dot': 6636,
        'matic': 3890, 'ltc': 2, 'trx': 1958, 'avax': 5805, 'link': 1975,
        'uni': 7083, 'atom': 3794, 'etc': 1321, 'xlm': 512, 'near': 6535,

        'apt': 21794, 'gala': 7080, 'sand': 6210, 'mana': 1966, 'axs': 6783,
        'imx': 10603, 'enj': 2130, 'alice': 8766, 'chr': 3978, 'tlm': 8857,

        'shib': 5994, 'pepe': 24478, 'floki': 10804, 'bonk': 23095,
        'wif': 28752, 'bome': 29870, 'brett': 29743, 'mog': 27659,
        'turbo': 28000, 'popcat': 28782, 'neiro': 30462, 'mew': 29609,

        'goat': 30897, 'fartcoin': 31382, 'ai16z': 31441, 'zerebro': 31890,
        'virtual': 31280, 'griffain': 31567, 'fwog': 30733, 'chillguy': 32261,
        'grass': 28260, 'render': 5690, 'fet': 3773, 'agix': 2424,

        'cake': 7186, 'sushi': 6758, 'comp': 5692, 'aave': 7278, 'mkr': 1518,
        'crv': 6538, 'snx': 2586, '1inch': 8104, 'ldo': 8000, 'rpl': 2943,

        'parti': 9816, 'doto': 13502, 'arb': 11841, 'op': 11840, 'blur': 23121,
        'inj': 7226, 'sei': 23149, 'tia': 22861, 'jup': 29210, 'pyth': 28177, 'dot': 6636,
    };
    return ids[symbol] || 1;
}


function createFallbackIcon(symbol, size = 24) {
    const coinSymbol = getCoinSymbol(symbol);
    const firstLetter = coinSymbol.charAt(0).toUpperCase();

    const colors = [
        '#3B82F6', '#EF4444', '#8B5CF6', '#10B981', '#F59E0B',
        '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#84CC16'
    ];


    const colorIndex = firstLetter.charCodeAt(0) % colors.length;
    const color = colors[colorIndex];

    const div = document.createElement('div');
    div.className = 'coin-icon-fallback';
    div.style.width = `${size}px`;
    div.style.height = `${size}px`;
    div.style.fontSize = `${size * 0.5}px`;
    div.style.background = `linear-gradient(135deg, ${color}, ${adjustColor(color, -20)})`;
    div.textContent = firstLetter;
    div.title = coinSymbol;

    return div;
}


function adjustColor(color, amount) {
    const clamp = (num) => Math.min(Math.max(num, 0), 255);
    const num = parseInt(color.replace('#', ''), 16);
    const r = clamp((num >> 16) + amount);
    const g = clamp(((num >> 8) & 0x00FF) + amount);
    const b = clamp((num & 0x0000FF) + amount);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}




async function verifyCoinExistsInBinance(coinSymbol) {
    try {
        const binanceSymbol = `${coinSymbol.toUpperCase()}USDT`;
        const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`);
        return response.ok;
    } catch (error) {
        return false;
    }
}


async function searchCoinOnCoinGecko(coinSymbol) {
    try {
        const response = await fetch(`https://api.coingecko.com/api/v3/search?query=${coinSymbol}`);
        if (!response.ok) return null;

        const data = await response.json();
        if (data.coins && data.coins.length > 0) {

            const exactMatch = data.coins.find(coin =>
                coin.symbol.toLowerCase() === coinSymbol.toLowerCase()
            );

            if (exactMatch) {
                return {
                    id: exactMatch.id,
                    name: exactMatch.name,
                    symbol: exactMatch.symbol,
                    image: exactMatch.large || exactMatch.thumb,
                    marketCapRank: exactMatch.market_cap_rank
                };
            }


            const firstResult = data.coins[0];
            return {
                id: firstResult.id,
                name: firstResult.name,
                symbol: firstResult.symbol,
                image: firstResult.large || firstResult.thumb,
                marketCapRank: firstResult.market_cap_rank
            };
        }
    } catch (error) {
        console.log(`[WARN] خطأ في البحث عن ${coinSymbol} في CoinGecko:`, error);
    }
    return null;
}


async function smartSearchCoinIcon(coinSymbol) {
    console.log(`[INFO] بدء البحث الذكي عن أيقونة ${coinSymbol}...`);

    const results = {
        symbol: coinSymbol,
        sources: [],
        verified: false,
        bestIcon: null,
        coinInfo: null
    };


    const existsInBinance = await verifyCoinExistsInBinance(coinSymbol);
    results.verified = existsInBinance;

    if (existsInBinance) {
        console.log(`[OK] ${coinSymbol} موجودة في Binance`);
    } else {
        console.log(`[WARN] ${coinSymbol} غير موجودة في Binance`);
    }


    const geckoInfo = await searchCoinOnCoinGecko(coinSymbol);
    if (geckoInfo) {
        results.coinInfo = geckoInfo;
        results.sources.push({
            name: 'CoinGecko',
            url: geckoInfo.image,
            verified: true,
            rank: geckoInfo.marketCapRank || 999
        });
        console.log(`[OK] وجدت في CoinGecko: ${geckoInfo.name} (${geckoInfo.symbol})`);
    }


    const staticSources = getCoinIconSources(coinSymbol);
    staticSources.forEach((url, index) => {
        const sourceName = url.includes('cryptoicons') ? 'CryptoIcons' :
            url.includes('coincap') ? 'CoinCap' :
                url.includes('jsdelivr') ? 'GitHub' :
                    url.includes('coinmarketcap') ? 'CoinMarketCap' :
                        url.includes('tradingview') ? 'TradingView' : 'Other';

        results.sources.push({
            name: sourceName,
            url: url,
            verified: false,
            rank: 1000 + index
        });
    });


    results.sources.sort((a, b) => {

        if (a.verified && !b.verified) return -1;
        if (!a.verified && b.verified) return 1;

        return a.rank - b.rank;
    });


    if (results.sources.length > 0) {
        results.bestIcon = results.sources[0];
        console.log(`[BEST] أفضل مصدر لـ ${coinSymbol}: ${results.bestIcon.name}`);
    }

    return results;
}


async function analyzeImageQuality(imageUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            try {

                if (img.width < 10 || img.height < 10) {
                    resolve({ valid: false, reason: 'حجم صغير جداً' });
                    return;
                }


                const canvas = document.createElement('canvas');
                canvas.width = Math.min(img.width, 100);
                canvas.height = Math.min(img.height, 100);
                const ctx = canvas.getContext('2d');

                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;


                let colorVariance = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    colorVariance += Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
                }

                const avgVariance = colorVariance / (data.length / 4);

                if (avgVariance < 3) {
                    resolve({ valid: false, reason: 'صورة placeholder' });
                } else {
                    resolve({ valid: true, variance: avgVariance });
                }
            } catch (e) {

                resolve({ valid: true, reason: 'لا يمكن التحليل (CORS)' });
            }
        };

        img.onerror = () => resolve({ valid: false, reason: 'فشل التحميل' });
        img.src = imageUrl;
    });
}


function createCoinIcon(symbol, size = 24) {
    const coinSymbol = getCoinSymbol(symbol);


    if (coinIconCache[coinSymbol]) {
        return createImgElement(coinIconCache[coinSymbol], coinSymbol, size);
    }


    try {
        const tickerCache = localStorage.getItem('smcw_ticker_data');
        if (tickerCache) {
            const { data } = JSON.parse(tickerCache);
            if (Array.isArray(data)) {
                const tickerCoin = data.find(c => c.symbol.toLowerCase() === coinSymbol.toLowerCase());
                if (tickerCoin && tickerCoin.image) {
                    coinIconCache[coinSymbol] = tickerCoin.image;
                    return createImgElement(tickerCoin.image, coinSymbol, size);
                }
            }
        }
    } catch (e) { console.error(e); }


    const sources = getCoinIconSources(coinSymbol);
    const img = createImgElement(sources[0], coinSymbol, size);


    let currentSourceIndex = 0;
    const tryNext = () => {
        currentSourceIndex++;
        if (currentSourceIndex < sources.length) {
            img.src = sources[currentSourceIndex];
        } else {
            img.replaceWith(createFallbackIcon(symbol, size));
        }
    };
    img.onerror = tryNext;


    img.onload = () => {
        if (img.naturalWidth > 10) coinIconCache[coinSymbol] = img.src;
        else tryNext();
    };

    return img;
}

function createImgElement(src, alt, size) {
    const img = document.createElement('img');
    img.className = 'coin-icon';
    img.alt = alt;
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.src = src;
    img.loading = 'lazy';
    return img;
}

function createTradingPairIcon(symbol, baseSize = 30, quoteSize = 16) {
    const pair = splitTradingPairSymbol(symbol);
    if (!pair.base || !pair.quote) {
        return createCoinIcon(symbol, baseSize);
    }

    const pairIcon = document.createElement('span');
    pairIcon.className = 'coin-icon-pair';
    pairIcon.setAttribute('title', `${pair.base}/${pair.quote}`);
    pairIcon.setAttribute('aria-label', `${pair.base}/${pair.quote}`);

    const baseWrap = document.createElement('span');
    baseWrap.className = 'coin-icon-base-wrap';
    const baseIcon = createCoinIcon(pair.base, baseSize);
    baseIcon.classList.add('coin-icon-base');
    baseWrap.appendChild(baseIcon);

    const quoteWrap = document.createElement('span');
    quoteWrap.className = 'coin-icon-quote-wrap';
    const quoteIcon = createCoinIcon(pair.quote, quoteSize);
    quoteIcon.classList.add('coin-icon-quote');
    quoteWrap.appendChild(quoteIcon);

    pairIcon.appendChild(baseWrap);
    pairIcon.appendChild(quoteWrap);
    return pairIcon;
}




function addCoinIconToText(symbol, textElement) {
    const icon = createTradingPairIcon(symbol, 30, 16);
    textElement.style.display = 'flex';
    textElement.style.alignItems = 'center';
    textElement.style.gap = '6px';
    textElement.insertBefore(icon, textElement.firstChild);
}


async function smartSearchAllCoins() {
    console.log('\n[START] ===== بدء البحث الذكي عن جميع الأيقونات =====\n');

    const allCoins = new Set();


    if (window.allData && window.allData.length > 0) {
        window.allData.forEach(item => {
            const coinSymbol = getCoinSymbol(item.symbol);
            allCoins.add(coinSymbol);
        });
    }

    if (allCoins.size === 0) {
        console.log('[WARN] لا توجد عملات في المحفظة');
        showToast('لا توجد عملات في المحفظة', 'warning');
        return;
    }

    console.log(`[INFO] عدد العملات: ${allCoins.size}`);
    showToast(`جاري البحث عن أيقونات ${allCoins.size} عملة...`, 'info', 3000);

    const results = [];
    let successCount = 0;
    let failCount = 0;


    for (const coinSymbol of allCoins) {
        const result = await smartSearchCoinIcon(coinSymbol);
        results.push(result);

        if (result.bestIcon) {

            coinIconCache[coinSymbol] = result.bestIcon.url;
            successCount++;

            console.log(`[OK] ${coinSymbol}: ${result.bestIcon.name} ${result.verified ? '(متحقق منها)' : ''}`);
        } else {
            failCount++;
            console.log(`[ERROR] ${coinSymbol}: لم يتم العثور على أيقونة`);
        }


        await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log('\n[REPORT] ===== نتائج البحث =====');
    console.log(`[OK] نجح: ${successCount} عملة`);
    console.log(`[ERROR] فشل: ${failCount} عملة`);
    console.log(`[RATE] معدل النجاح: ${((successCount / allCoins.size) * 100).toFixed(1)}%\n`);


    const verified = results.filter(r => r.verified).length;
    console.log(`[VERIFIED] عملات متحقق منها في Binance: ${verified}`);

    const byCoinGecko = results.filter(r => r.coinInfo).length;
    console.log(`[COINGECKO] عملات وجدت في CoinGecko: ${byCoinGecko}`);

    console.log('\n=====================================\n');


    showToast(`تم العثور على ${successCount} أيقونة من ${allCoins.size} عملة`, 'success');
    updateSummaryTable();

    return results;
}


window.smartSearchAllCoins = smartSearchAllCoins;


function showIconReport() {
    console.log('\n[REPORT] ===== تقرير أيقونات العملات =====\n');

    const sources = {};
    let total = 0;

    for (const [coin, url] of Object.entries(coinIconCache)) {
        total++;
        const sourceName = url.includes('coingecko') ? 'CoinGecko' :
            url.includes('cryptoicons') ? 'CryptoIcons' :
                url.includes('coincap') ? 'CoinCap' :
                    url.includes('jsdelivr') ? 'GitHub' :
                        url.includes('coinmarketcap') ? 'CoinMarketCap' :
                            url.includes('tradingview') ? 'TradingView' :
                                url.includes('lcw.nyc3') ? 'LiveCoinWatch' : 'Other';

        if (!sources[sourceName]) sources[sourceName] = [];
        sources[sourceName].push(coin);
    }

    if (total === 0) {
        console.log('[WARN] لا توجد أيقونات محملة حالياً');
        console.log('[TIP] لبدء البحث الذكي، اكتب: smartSearchAllCoins()');
        return;
    }

    console.log(`إجمالي العملات المحملة: ${total}\n`);


    const sortedSources = Object.entries(sources).sort((a, b) => b[1].length - a[1].length);

    for (const [source, coins] of sortedSources) {
        const percentage = ((coins.length / total) * 100).toFixed(1);
        console.log(`${source}: ${coins.length} عملة (${percentage}%)`);
        console.log(`  العملات: ${coins.join(', ')}\n`);
    }

    console.log('=====================================');
    console.log('[TIP] الأوامر المتاحة:');
    console.log('  - showIconReport() : عرض هذا التقرير');
    console.log('  - smartSearchAllCoins() : بحث ذكي عن جميع الأيقونات');
    console.log('=====================================\n');
}


window.showIconReport = showIconReport;


function toggleSidebar() {
    const sidebar = document.getElementById('mobileSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.toggle('active');
    overlay.classList.toggle('active');
}

function toggleMobileSearch() {
    const searchOverlay = document.getElementById('mobileSearchOverlay');
    const searchInput = document.getElementById('mobileSearchInput');
    searchOverlay.classList.toggle('active');

    if (searchOverlay.classList.contains('active')) {
        setTimeout(() => searchInput.focus(), 100);
    }
}

function handleMobileSearch(query) {

    console.log('Searching for:', query);
}




let notifications = [];
let unreadCount = 0;
let currentTab = 'updates';


loadNotifications();

function loadNotifications() {
    const saved = localStorage.getItem('smcw_notifications');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);

            notifications = parsed.map(n => ({ ...n, time: new Date(n.time) }));


            unreadCount = notifications.filter(n => !n.read).length;
            updateNotificationUI();
        } catch (e) {
            console.error('Failed to load notifications', e);
            notifications = [];
        }
    }
}

function saveNotifications() {
    localStorage.setItem('smcw_notifications', JSON.stringify(notifications));
}

function addToNotifications(message, type) {
    const notif = {
        id: Date.now(),
        message: message,
        type: type,
        time: new Date(),
        read: false
    };

    notifications.unshift(notif);
    if (notifications.length > 50) notifications.pop();

    unreadCount++;
    saveNotifications();
    updateNotificationUI();
}

function updateNotificationUI() {

    const badge = document.getElementById('notificationBadge');
    if (unreadCount > 0) {
        badge.innerText = unreadCount > 99 ? '99+' : unreadCount;
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }


    renderNotifications();
}

function switchTab(tabName) {
    currentTab = tabName;


    const tabs = document.querySelectorAll('.notif-tab');
    tabs.forEach(tab => {
        if ((tabName === 'updates' && tab.innerText === 'التحديثات') ||
            (tabName === 'alerts' && tab.innerText === 'التنبيهات')) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    renderNotifications();
}

function renderNotifications() {
    const list = document.getElementById('notificationList');


    const filteredNotifications = notifications.filter(n => {
        if (currentTab === 'updates') {

            return n.type === 'info' || n.type === 'success';
        } else {

            return n.type === 'warning' || n.type === 'error';
        }
    });

    if (!filteredNotifications.length) {
        list.innerHTML = `
                    <div class="empty-notifications">
                        <i class="far fa-bell-slash"></i>
                        <p>لا توجد إشعارات في قسم ${currentTab === 'updates' ? 'التحديثات' : 'التنبيهات'}</p>
                    </div>`;
        return;
    }

    list.innerHTML = filteredNotifications.map(notif => {
        let iconClass = 'info';
        let icon = 'fa-info';
        let title = 'معلومة';

        if (notif.type === 'success') { iconClass = 'success'; icon = 'fa-check'; title = 'نجاح'; }
        else if (notif.type === 'error') { iconClass = 'error'; icon = 'fa-times'; title = 'خطأ'; }
        else if (notif.type === 'warning') { iconClass = 'warning'; icon = 'fa-exclamation'; title = 'تنبيه'; }

        const timeString = notif.time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        return `
                    <div class="notification-item ${notif.read ? '' : 'unread'}" onclick="markAsRead(${notif.id})">
                        <div class="notif-icon ${iconClass}">
                            <i class="fas ${icon}"></i>
                        </div>
                        <div class="notif-content">
                            <div class="notif-title">${title}</div>
                            <div class="notif-message">${notif.message}</div>
                            <div class="notif-time">${timeString}</div>
                        </div>
                        <button class="flex items-center justify-center w-6 h-6 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg dark:hover:bg-rose-900/20 transition-all" onclick="deleteNotification(${notif.id}, event)" title="حذف">
                            <i class="fas fa-times text-xs"></i>
                        </button>
                    </div>
                `;
    }).join('');
}

function toggleNotifications() {
    const dropdown = document.getElementById('notificationDropdown');
    dropdown.classList.toggle('active');
}



function markAllAsRead() {
    notifications.forEach(n => n.read = true);
    unreadCount = 0;
    saveNotifications();
    updateNotificationUI();
}

function clearAllNotifications() {
    notifications = [];
    unreadCount = 0;
    saveNotifications();
    updateNotificationUI();
}

function markAsRead(id) {
    const notif = notifications.find(n => n.id === id);
    if (notif && !notif.read) {
        notif.read = true;
        unreadCount = Math.max(0, unreadCount - 1);
        saveNotifications();
        updateNotificationUI();
    }
}

function deleteNotification(id, event) {
    event.stopPropagation();
    const index = notifications.findIndex(n => n.id === id);
    if (index !== -1) {
        if (!notifications[index].read) {
            unreadCount = Math.max(0, unreadCount - 1);
        }
        notifications.splice(index, 1);
        saveNotifications();
        updateNotificationUI();
    }
}




function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'pointer-events-auto transition-all duration-300 transform translate-y-5 opacity-0';

    const icons = {
        success: {
            bg: 'text-emerald-500 bg-emerald-100 dark:bg-emerald-800 dark:text-emerald-200',
            svg: '<svg class="w-5 h-5" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20"><path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm3.707 8.207-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 0 1 1.414-1.414L9 10.586l3.293-3.293a1 1 0 0 1 1.414 1.414Z"/></svg>',
            title: 'نجح'
        },
        error: {
            bg: 'text-rose-500 bg-rose-100 dark:bg-rose-800 dark:text-rose-200',
            svg: '<svg class="w-5 h-5" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20"><path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm3.707 11.793a1 1 0 1 1-1.414 1.414L10 11.414l-2.293 2.293a1 1 0 0 1-1.414-1.414L8.586 10 6.293 7.707a1 1 0 0 1 1.414-1.414L10 8.586l2.293-2.293a1 1 0 0 1 1.414 1.414L11.414 10l2.293 2.293Z"/></svg>',
            title: 'خطأ'
        },
        warning: {
            bg: 'text-amber-500 bg-amber-100 dark:bg-amber-800 dark:text-amber-200',
            svg: '<svg class="w-5 h-5" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20"><path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM10 15a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1-4a1 1 0 0 1-2 0V6a1 1 0 0 1 2 0v5Z"/></svg>',
            title: 'تحذير'
        },
        info: {
            bg: 'text-blue-500 bg-blue-100 dark:bg-blue-800 dark:text-blue-200',
            svg: '<svg class="w-5 h-5" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20"><path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM9.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 15H8a1 1 0 0 1 0-2h1v-3H8a1 1 0 0 1 0-2h2a1 1 0 0 1 1 1v4h1a1 1 0 0 1 0 2Z"/></svg>',
            title: 'معلومة'
        }
    };

    const config = icons[type] || icons.info;

    toast.innerHTML = `
        <div class="flex items-center w-full max-w-xs p-4 text-slate-600 bg-white rounded-2xl shadow-xl dark:text-slate-400 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 relative overflow-hidden">
            <div class="inline-flex items-center justify-center flex-shrink-0 w-8 h-8 ${config.bg} rounded-lg">
                ${config.svg}
                <span class="sr-only">${config.title} icon</span>
            </div>
            <div class="ms-3 text-sm font-semibold">${message}</div>
            <div class="absolute bottom-0 start-0 h-1 bg-blue-600 dark:bg-blue-500 transition-all linear" style="width: 100%; transition-duration: ${duration}ms; animation: toast-progress ${duration}ms linear forwards;"></div>
        </div>
    `;

    container.appendChild(toast);

    // Trigger entry animation
    requestAnimationFrame(() => {
        toast.classList.remove('translate-y-5', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');
    });

    const timer = setTimeout(() => {
        closeToast(toast);
    }, duration);

    toast._timer = timer;

    return toast;
}


function closeToast(element) {
    let toast = element;
    if (element.tagName === 'BUTTON') {
        toast = element.closest('.pointer-events-auto');
    }

    if (!toast) return;
    if (toast._timer) clearTimeout(toast._timer);

    toast.classList.add('translate-y-5', 'opacity-0');

    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 300);
}

// =========================================
//      Internet Connection Monitor
// =========================================
const networkConnectionMonitor = (() => {
    const STATUS = Object.freeze({
        OFFLINE: 'offline',
        SLOW: 'slow',
        OK: 'ok'
    });

    const CONFIG = Object.freeze({
        LOCAL_PING_URL: '/ping',
        FALLBACK_URLS: [
            'https://www.gstatic.com/generate_204',
            'https://www.google.com/generate_204',
            'https://1.1.1.1/cdn-cgi/trace'
        ],
        CHECK_INTERVAL_MS: 15000,
        REQUEST_TIMEOUT_MS: 2500,
        SLOW_THRESHOLD_MS: 1200,
        CONSECUTIVE_FAILURES_FOR_OFFLINE: 2,
        RECOVERED_HIDE_MS: 2200,
        SLOW_HIDE_MS: 2600,
        SLOW_RESHOW_COOLDOWN_MS: 45000,
        SLOW_SHOW_AFTER_CONSECUTIVE_HITS: 2,
        FAST_RECOVERY_HITS_FROM_SLOW: 2
    });

    const COPY = Object.freeze({
        offline: 'لا يوجد اتصال بالإنترنت',
        slow: 'الاتصال ضعيف',
        ok: 'تم استرجاع الاتصال'
    });

    const state = {
        initialized: false,
        isChecking: false,
        currentStatus: 'unknown',
        intervalId: null,
        hideTimerId: null,
        bannerEl: null,
        bannerTextEl: null,
        consecutiveHttpFailures: 0,
        consecutiveSlowHits: 0,
        consecutiveFastHits: 0,
        lastSlowBannerAt: 0,
        statusBadgeEl: null,
        statusBadgeIconEl: null
    };

    const connectionInfo = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;

    function isHttpProtocol() {
        return window.location.protocol === 'http:' || window.location.protocol === 'https:';
    }

    function isFileProtocol() {
        return window.location.protocol === 'file:';
    }

    function withNoCacheQuery(url) {
        const finalUrl = new URL(url, window.location.href);
        finalUrl.searchParams.set('t', Date.now().toString());
        return finalUrl.toString();
    }

    function ensureBanner() {
        if (state.bannerEl && document.body.contains(state.bannerEl)) {
            return state.bannerEl;
        }

        const banner = document.createElement('div');
        banner.id = 'networkConnectionBanner';
        banner.className = 'network-connection-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        banner.setAttribute('aria-atomic', 'true');
        banner.hidden = true;

        const dot = document.createElement('span');
        dot.className = 'network-connection-banner__dot';
        dot.setAttribute('aria-hidden', 'true');

        const text = document.createElement('span');
        text.id = 'networkConnectionBannerText';
        text.className = 'network-connection-banner__text';

        banner.appendChild(dot);
        banner.appendChild(text);
        document.body.appendChild(banner);

        state.bannerEl = banner;
        state.bannerTextEl = text;
        return banner;
    }

    function ensureStatusBadgeRefs() {
        if (!state.statusBadgeEl) {
            state.statusBadgeEl = document.getElementById('networkStatusBadge');
        }
        if (!state.statusBadgeIconEl) {
            state.statusBadgeIconEl = document.getElementById('networkStatusBadgeIcon');
        }
    }

    function setStatusBadge(status) {
        ensureStatusBadgeRefs();
        if (!state.statusBadgeEl || !state.statusBadgeIconEl) return;

        const statusMap = {
            unknown: { cls: 'is-checking', label: 'جاري فحص الاتصال', icon: ['fa-spinner', 'fa-spin'] },
            [STATUS.OK]: { cls: 'is-online', label: 'الاتصال جيد', icon: ['fa-wifi'] },
            [STATUS.SLOW]: { cls: 'is-slow', label: 'الاتصال ضعيف', icon: ['fa-hourglass-half'] },
            [STATUS.OFFLINE]: { cls: 'is-offline', label: 'لا يوجد اتصال بالإنترنت', icon: ['fa-triangle-exclamation'] }
        };

        const selected = statusMap[status] || statusMap.unknown;
        state.statusBadgeEl.classList.remove('is-checking', 'is-online', 'is-slow', 'is-offline');
        state.statusBadgeEl.classList.add(selected.cls);
        state.statusBadgeEl.setAttribute('title', selected.label);
        state.statusBadgeEl.setAttribute('aria-label', selected.label);

        state.statusBadgeIconEl.className = 'fas';
        selected.icon.forEach((iconClass) => {
            state.statusBadgeIconEl.classList.add(iconClass);
        });
    }

    function clearHideTimer() {
        if (!state.hideTimerId) return;
        clearTimeout(state.hideTimerId);
        state.hideTimerId = null;
    }

    function hideBanner() {
        if (!state.bannerEl) return;
        state.bannerEl.classList.remove('is-visible');
        setTimeout(() => {
            if (state.bannerEl && !state.bannerEl.classList.contains('is-visible')) {
                state.bannerEl.hidden = true;
            }
        }, 180);
    }

    function applyBannerTone(status) {
        if (!state.bannerEl) return;
        state.bannerEl.classList.remove(
            'network-connection-banner--offline',
            'network-connection-banner--slow',
            'network-connection-banner--ok'
        );
        state.bannerEl.classList.add(`network-connection-banner--${status}`);
    }

    function showBanner(message, status, autoHideMs = 0) {
        ensureBanner();
        clearHideTimer();

        if (state.bannerTextEl) {
            state.bannerTextEl.textContent = message;
        }
        applyBannerTone(status);
        state.bannerEl.hidden = false;
        requestAnimationFrame(() => {
            if (state.bannerEl) state.bannerEl.classList.add('is-visible');
        });

        if (autoHideMs > 0) {
            state.hideTimerId = setTimeout(() => {
                hideBanner();
            }, autoHideMs);
        }
    }

    function resetProbeStabilityCounters() {
        state.consecutiveSlowHits = 0;
        state.consecutiveFastHits = 0;
    }

    function applyStatus(nextStatus, options = {}) {
        if (nextStatus === state.currentStatus) return;
        const previousStatus = state.currentStatus;
        state.currentStatus = nextStatus;
        setStatusBadge(nextStatus);

        if (nextStatus === STATUS.OFFLINE) {
            resetProbeStabilityCounters();
            showBanner(COPY.offline, STATUS.OFFLINE);
            return;
        }

        if (nextStatus === STATUS.SLOW) {
            const now = Date.now();
            const isWithinSlowCooldown = (now - state.lastSlowBannerAt) < CONFIG.SLOW_RESHOW_COOLDOWN_MS;
            state.lastSlowBannerAt = now;
            if (isWithinSlowCooldown) {
                clearHideTimer();
                hideBanner();
                return;
            }
            showBanner(COPY.slow, STATUS.SLOW, CONFIG.SLOW_HIDE_MS);
            return;
        }

        const shouldShowRecovered = previousStatus === STATUS.OFFLINE;

        if (shouldShowRecovered) {
            showBanner(COPY.ok, STATUS.OK, CONFIG.RECOVERED_HIDE_MS);
        } else {
            clearHideTimer();
            hideBanner();
        }
    }

    function getConnectionSlowHint() {
        if (!connectionInfo) return null;

        const effectiveType = String(connectionInfo.effectiveType || '').toLowerCase();
        const downlink = typeof connectionInfo.downlink === 'number' ? connectionInfo.downlink : null;
        const rtt = typeof connectionInfo.rtt === 'number' ? connectionInfo.rtt : null;

        if (effectiveType === 'slow-2g' || effectiveType === '2g') {
            return true;
        }
        if (rtt !== null && rtt > CONFIG.SLOW_THRESHOLD_MS) {
            return true;
        }
        if (downlink !== null && downlink > 0 && downlink < 1) {
            return true;
        }

        return false;
    }

    async function probeUrl(url) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

        try {
            const startedAt = performance.now();
            const response = await fetch(withNoCacheQuery(url), {
                method: 'GET',
                cache: 'no-store',
                mode: 'no-cors',
                signal: controller.signal
            });

            const isSuccess = response.type === 'opaque' || response.ok;
            if (!isSuccess) {
                return { success: false, latencyMs: Infinity };
            }

            return {
                success: true,
                latencyMs: performance.now() - startedAt
            };
        } catch (error) {
            return { success: false, latencyMs: Infinity };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async function runHttpProbe() {
        const localResult = await probeUrl(CONFIG.LOCAL_PING_URL);
        if (localResult.success) return localResult;

        for (const fallbackUrl of CONFIG.FALLBACK_URLS) {
            const fallbackResult = await probeUrl(fallbackUrl);
            if (fallbackResult.success) return fallbackResult;
        }

        return { success: false, latencyMs: Infinity };
    }

    function handleFileProtocolStatus(options = {}) {
        if (navigator.onLine === false) {
            resetProbeStabilityCounters();
            applyStatus(STATUS.OFFLINE, options);
            return;
        }

        const slowHint = getConnectionSlowHint();
        if (slowHint === true) {
            state.consecutiveSlowHits += 1;
            state.consecutiveFastHits = 0;
            if (
                state.currentStatus === STATUS.OFFLINE ||
                state.currentStatus === STATUS.SLOW ||
                state.consecutiveSlowHits >= CONFIG.SLOW_SHOW_AFTER_CONSECUTIVE_HITS
            ) {
                applyStatus(STATUS.SLOW, options);
            }
            return;
        }

        // slowHint: false أو null (غير مدعوم) => لا تخمين إضافي
        state.consecutiveFastHits += 1;
        state.consecutiveSlowHits = 0;
        if (
            state.currentStatus === STATUS.SLOW &&
            state.consecutiveFastHits < CONFIG.FAST_RECOVERY_HITS_FROM_SLOW
        ) {
            return;
        }
        applyStatus(STATUS.OK, options);
    }

    async function handleHttpProtocolStatus(options = {}) {
        if (navigator.onLine === false) {
            state.consecutiveHttpFailures = CONFIG.CONSECUTIVE_FAILURES_FOR_OFFLINE;
            resetProbeStabilityCounters();
            applyStatus(STATUS.OFFLINE, options);
            return;
        }

        const probe = await runHttpProbe();
        if (!probe.success) {
            state.consecutiveHttpFailures += 1;
            resetProbeStabilityCounters();
            if (state.consecutiveHttpFailures >= CONFIG.CONSECUTIVE_FAILURES_FOR_OFFLINE) {
                applyStatus(STATUS.OFFLINE, options);
            }
            return;
        }

        state.consecutiveHttpFailures = 0;

        if (probe.latencyMs > CONFIG.SLOW_THRESHOLD_MS) {
            state.consecutiveSlowHits += 1;
            state.consecutiveFastHits = 0;
            if (
                state.currentStatus === STATUS.OFFLINE ||
                state.currentStatus === STATUS.SLOW ||
                state.consecutiveSlowHits >= CONFIG.SLOW_SHOW_AFTER_CONSECUTIVE_HITS
            ) {
                applyStatus(STATUS.SLOW, options);
            }
            return;
        }

        state.consecutiveFastHits += 1;
        state.consecutiveSlowHits = 0;
        if (
            state.currentStatus === STATUS.SLOW &&
            state.consecutiveFastHits < CONFIG.FAST_RECOVERY_HITS_FROM_SLOW
        ) {
            return;
        }
        applyStatus(STATUS.OK, options);
    }

    async function checkConnection(options = {}) {
        if (state.isChecking) return;
        state.isChecking = true;

        try {
            if (isFileProtocol()) {
                handleFileProtocolStatus({ forceRecovered: options.forceRecovered === true });
                return;
            }

            await handleHttpProtocolStatus({ forceRecovered: options.forceRecovered === true });
        } finally {
            state.isChecking = false;
        }
    }

    function init() {
        if (state.initialized) return;
        state.initialized = true;

        ensureBanner();
        ensureStatusBadgeRefs();
        setStatusBadge('unknown');

        window.addEventListener('offline', () => {
            state.consecutiveHttpFailures = CONFIG.CONSECUTIVE_FAILURES_FOR_OFFLINE;
            resetProbeStabilityCounters();
            applyStatus(STATUS.OFFLINE);
        });

        window.addEventListener('online', () => {
            state.consecutiveHttpFailures = 0;
            resetProbeStabilityCounters();
            checkConnection({ forceRecovered: true });
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                checkConnection({ forceRecovered: true });
            }
        });

        if (connectionInfo && typeof connectionInfo.addEventListener === 'function') {
            connectionInfo.addEventListener('change', () => {
                if (isFileProtocol()) {
                    checkConnection({ forceRecovered: true });
                }
            });
        }

        checkConnection({ forceRecovered: false });

        state.intervalId = setInterval(() => {
            checkConnection({ forceRecovered: true });
        }, CONFIG.CHECK_INTERVAL_MS);
    }

    return {
        init,
        checkNow: checkConnection
    };
})();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildConfirmBadgesMarkup(coins = [], maxVisible = 24) {
    const normalizedCoins = Array.from(
        new Set(
            (Array.isArray(coins) ? coins : [])
                .map((coin) => String(coin || '').trim().toUpperCase())
                .filter(Boolean)
        )
    );

    if (!normalizedCoins.length) return '';

    const visibleCount = Math.max(1, Number.parseInt(maxVisible, 10) || 24);
    const visibleCoins = normalizedCoins.slice(0, visibleCount);
    const hiddenCount = Math.max(0, normalizedCoins.length - visibleCoins.length);
    const badgesHtml = visibleCoins
        .map((coin) => `<span class="confirm-coin-badge">${escapeHtml(coin)}</span>`)
        .join('');

    const moreHtml = hiddenCount > 0
        ? `<span class="confirm-coin-badge confirm-coin-badge--more">+${hiddenCount}</span>`
        : '';

    return `
        <div class="confirm-coin-badges" role="list" aria-label="العملات المحددة للحذف">
            ${badgesHtml}
            ${moreHtml}
        </div>
    `;
}

function showConfirm(message, onConfirm, onCancel, options = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const messageEl = document.getElementById('confirm-message');
        const yesBtn = document.getElementById('confirm-yes');
        const noBtn = document.getElementById('confirm-no');

        const confirmOptions = options && typeof options === 'object' ? options : {};
        const introText = String(confirmOptions.introText || message || '').trim();
        const noteText = String(confirmOptions.noteText || '').trim();
        const badgesMarkup = buildConfirmBadgesMarkup(confirmOptions.coins, confirmOptions.maxBadges);

        messageEl.classList.toggle('confirm-message--with-badges', Boolean(badgesMarkup));
        if (badgesMarkup) {
            const introMarkup = introText
                ? `<div class="confirm-message-text">${escapeHtml(introText)}</div>`
                : '';
            const noteMarkup = noteText
                ? `<div class="confirm-message-note">${escapeHtml(noteText)}</div>`
                : '';
            messageEl.innerHTML = `${introMarkup}${badgesMarkup}${noteMarkup}`;
        } else {
            messageEl.textContent = message;
        }

        modal.classList.add('show');


        const newYesBtn = yesBtn.cloneNode(true);
        const newNoBtn = noBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
        noBtn.parentNode.replaceChild(newNoBtn, noBtn);

        let didResolve = false;
        const finish = (value) => {
            if (didResolve) return;
            didResolve = true;
            modal.classList.remove('show');
            modal.onclick = null;
            resolve(value);
            if (value) {
                if (typeof onConfirm === 'function') onConfirm();
                return;
            }
            if (typeof onCancel === 'function') onCancel();
        };

        newYesBtn.addEventListener('click', () => finish(true));

        newNoBtn.addEventListener('click', () => finish(false));


        modal.onclick = (e) => {
            if (e.target === modal) {
                finish(false);
            }
        };
    });
}


const originalAlert = window.alert;
window.alert = function (message) {

    let type = 'info';
    if (message.includes('نجح') || message.includes('تمت') || message.includes('[OK]')) {
        type = 'success';
    } else if (message.includes('خطأ') || message.includes('فشل') || message.includes('[ERROR]')) {
        type = 'error';
    } else if (message.includes('تحذير') || message.includes('يرجى') || message.includes('الرجاء')) {
        type = 'warning';
    }

    showToast(message, type);
};


const originalConfirm = window.confirm;
window.confirm = function (message) {


    return originalConfirm(message);
};


const repurchaseTableBody = document.getElementById('repurchaseRows');
const sellTableBody = document.getElementById('sellRows');
const marketPriceDisplay = document.getElementById('marketPriceDisplay');
const apiStatusDiv = document.getElementById('apiStatus');
const autoRefreshCheckbox = document.getElementById('autoRefreshCheckbox');
const coinSelector = document.getElementById('coinSelector');
const newCoinNameInput = document.getElementById('newCoinName');
const coinStatusDiv = document.getElementById('coinStatus');
const summaryTableBody = document.getElementById('summaryTableBody');
const totalBuyFeesDcaEl = document.getElementById('totalBuyFeesDca');
const totalSellFeesLedgerEl = document.getElementById('totalSellFeesLedger');
const totalInvestedSummaryEl = document.getElementById('totalInvestedSummary');
const totalPnlAmountSummaryEl = document.getElementById('totalPnlAmountSummary');
const totalCurrentValueSummaryEl = document.getElementById('totalCurrentValueSummary');
const totalPnlPercentSummaryEl = document.getElementById('totalPnlPercentSummary');
const currentCoinDisplayElements = [
    document.getElementById('currentCoinDisplay1'),
    document.getElementById('currentCoinDisplay2'),
    document.getElementById('currentCoinDisplay3')
];

const maxRepurchaseEntries = 30;
const REPURCHASE_VISIBLE_ROWS = 13;
const initialVisibleSells = 8;
const SUMMARY_TABLE_COLUMN_COUNT = 9;
let fetchTimeout, autoRefreshIntervalId = null;
const AUTO_REFRESH_INTERVAL = 30000;
const PRICE_FETCH_CONCURRENCY = 3;
const LS_KEY_DATA = 'cryptoTrackerUniversal_v9_data';
const LS_KEY_AUTO_REFRESH = 'cryptoTrackerUniversal_v9_autoRefresh';
const LS_KEY_HIDE_USDT = 'cryptoTrackerUniversal_v9_hideUsdtSuffix';
const LS_KEY_THEME = 'smcw_theme_preference';
const LS_KEY_BALANCE_STATE = 'cryptoTrackerUniversal_v9_balanceState';
const LS_KEY_FINANCIAL_PRIVACY = 'cryptoTrackerUniversal_v9_financialPrivacyMode';
const LS_KEY_PRICE_CACHE = 'cryptoTrackerUniversal_v9_priceCache';
const BRAND_ASSET_BY_THEME = Object.freeze({
    dark: '../assets/icons/Osoul Pro Dark Mode.png',
    light: '../assets/icons/Osoul Pro Light Mode.png'
});
let allCoinData = {};
let currentMarketPrices = {};
let previousPrices = {};
let activeCoinSymbol = null;
let selectCoinsMode = false;
let selectedCoins = new Set();
let hideUsdtSuffix = false;
let priceBadgesResizeDebounceTimer = null;
let repurchaseViewportResizeDebounceTimer = null;
let isPriceBadgesWidthSyncInitialized = false;
let financialPrivacyEnabled = false;
let financialPrivacyObserver = null;
let financialPrivacyRefreshScheduled = false;
let isApplyingFinancialPrivacyMask = false;
let activePriceFetchPromise = null;
let pendingManualRefreshRequest = false;
const financialPrivacyOriginalTextMap = new WeakMap();
const financialPrivacyOriginalHtmlMap = new WeakMap();
const FINANCIAL_PRIVACY_TEXT_TARGETS = [
    { selector: '.section-financial-overview .card-value', forceNumeric: true },
    { selector: '#totalInvestedSummary', forceNumeric: true },
    { selector: '#totalPnlAmountSummary', forceNumeric: true },
    { selector: '#totalCurrentValueSummary', forceNumeric: true },
    { selector: '#currentPrincipalInfo', forceNumeric: true },
    { selector: '#pnlAmount', forceNumeric: true },
    { selector: '#totalInvestedAmount', forceNumeric: true },
    { selector: '#currentPortfolioValue', forceNumeric: true },
    { selector: '#tpPrice1', forceNumeric: true },
    { selector: '#tpPrice2', forceNumeric: true },
    { selector: '#tpPrice3', forceNumeric: true },
    { selector: '#slPrice', forceNumeric: true },
    { selector: '#portfolioTotalValue', forceNumeric: true },
    { selector: '#repurchaseRows .repurchase-pnl', forceNumeric: true },
    { selector: '#totalBuyFeesDca', forceNumeric: true },
    { selector: '#totalSellFeesLedger', forceNumeric: true }
];
const FINANCIAL_PRIVACY_HTML_TARGETS = [
    { selector: '#summaryTableBody td.number-col:not(:nth-child(2)):not(:nth-child(4)):not(:nth-child(5)):not(:nth-child(8))', forceNumeric: true },
    { selector: '#repurchaseRows td:nth-child(8)', forceNumeric: true },
    { selector: '#sellRows td:nth-child(3), #sellRows td:nth-child(5), #sellRows td:nth-child(6), #sellRows td:nth-child(7), #sellRows td:nth-child(10)', forceNumeric: true },
    { selector: '#sellPreviewText', forceNumeric: true }
];

function setApiStatusColor(colorValue) {
    if (!apiStatusDiv) return;
    apiStatusDiv.style.setProperty('color', colorValue, 'important');
}

// =========================================
//    Principal Cash Balance Management
// =========================================
let balanceState = {
    currency: 'USD',
    principalCash: 0,
    profitWallet: 0,
    realizedLoss: 0
};


function getDefaultCoinDataStructure() {
    const repurchases = Array.from({ length: maxRepurchaseEntries }, () => ({ price: '', amount: '' }));
    return {
        initialEntryPrice: '', initialAmountDollars: '',
        repurchases: repurchases,
        sells: [],
        sellCycleStartIndex: 0,
        targets: { tp1: '', tp2: '', tp3: '', sl: '' }
    };
}


function saveAllDataToLocalStorage(showNotification = false, skipActiveSync = false) {
    if (!skipActiveSync && activeCoinSymbol && allCoinData[activeCoinSymbol]) {
        updateActiveCoinDataInMemory();
    }
    const dataToSave = { coins: allCoinData, active: activeCoinSymbol };
    try {
        localStorage.setItem(LS_KEY_DATA, JSON.stringify(dataToSave));
        if (showNotification) {
            const coinsCount = Object.keys(allCoinData).length;
            showToast(`تم حفظ بيانات ${coinsCount} عملة تلقائياً`, 'success', 2500);
        }
    } catch (error) {
        console.error("Error saving coin data:", error);
        apiStatusDiv.innerHTML = '<i class="fas fa-circle-exclamation" aria-hidden="true"></i> خطأ في حفظ البيانات!';
        setApiStatusColor('var(--negative-color)');
        showToast('فشل حفظ البيانات في المتصفح', 'error', 3000);
    }
}


function loadAllDataFromLocalStorage() {
    const savedData = localStorage.getItem(LS_KEY_DATA);
    const cachedPricesMap = readPriceCacheMap();
    if (savedData) {
        try {
            const parsedData = JSON.parse(savedData);
            if (parsedData && typeof parsedData.coins === 'object' && parsedData.coins !== null) {
                allCoinData = {};
                activeCoinSymbol = parsedData.active || null;
                const parsedCoins = parsedData.coins;
                Object.keys(parsedCoins).forEach(symbol => {
                    let coinData = parsedCoins[symbol];
                    if (!coinData || typeof coinData !== 'object' || Array.isArray(coinData)) {
                        coinData = getDefaultCoinDataStructure();
                    }
                    allCoinData[symbol] = coinData;

                    if (!coinData.repurchases || coinData.repurchases.length !== maxRepurchaseEntries) {
                        const existingRepurchases = coinData.repurchases || [];
                        coinData.repurchases = Array.from({ length: maxRepurchaseEntries }, (_, i) =>
                            existingRepurchases[i] || { price: '', amount: '', time: null }
                        );
                    }
                    if (!Array.isArray(coinData.sells)) {
                        coinData.sells = [];
                    }
                    if (!coinData.targets) {
                        coinData.targets = { tp1: '', tp2: '', tp3: '', sl: '' };
                    }

                    const hasSellCycleStartIndex = Object.prototype.hasOwnProperty.call(coinData, 'sellCycleStartIndex');
                    if (!hasSellCycleStartIndex && coinData.sells.length > 0) {
                        const epsilon = 0.00000001;
                        const initialEntryPrice = parseFloat(coinData.initialEntryPrice) || 0;
                        const initialAmountDollars = parseFloat(coinData.initialAmountDollars) || 0;
                        let totalBuyQty = (initialEntryPrice > 0) ? initialAmountDollars / initialEntryPrice : 0;
                        if (Array.isArray(coinData.repurchases)) {
                            coinData.repurchases.forEach((rp) => {
                                const rPrice = parseFloat(rp?.price) || 0;
                                const rAmount = parseFloat(rp?.amount) || 0;
                                if (rPrice > 0 && rAmount > 0) {
                                    totalBuyQty += rAmount / rPrice;
                                }
                            });
                        }
                        const totalSoldQty = coinData.sells.reduce((acc, sell) => acc + (parseFloat(sell?.qty) || 0), 0);
                        coinData.sellCycleStartIndex = (totalBuyQty <= epsilon || totalSoldQty >= totalBuyQty - epsilon)
                            ? coinData.sells.length
                            : 0;
                    } else {
                        coinData.sellCycleStartIndex = getSellCycleStartIndex(coinData);
                    }
                });

                Object.keys(allCoinData).forEach((symbol) => {
                    const cachedPrice = Number.parseFloat(cachedPricesMap[symbol]);
                    currentMarketPrices[symbol] = Number.isFinite(cachedPrice) ? cachedPrice : null;
                });
            } else {
                allCoinData = {}; activeCoinSymbol = null; currentMarketPrices = {};
            }
            return true;
        } catch (error) {
            console.error("Error loading or parsing coin data:", error);
            allCoinData = {}; activeCoinSymbol = null; currentMarketPrices = {};
            return false;
        }
    }
    allCoinData = {}; activeCoinSymbol = null; currentMarketPrices = {};
    return false;
}


function toggleTheme() {
    const body = document.body;
    const themeToggle = document.getElementById('theme-toggle');
    const root = document.documentElement;

    const currentTheme = root.getAttribute('data-theme') || 'dark';

    if (currentTheme === 'light') {
        // التبديل إلى الوضع الداكن
        body.classList.remove('light-mode');
        root.setAttribute('data-theme', 'dark');
        root.classList.add('dark');
        if (themeToggle) { themeToggle.innerHTML = '<i class="fas fa-moon"></i>'; themeToggle.title = 'تبديل إلى الوضع الفاتح'; }
        localStorage.setItem(LS_KEY_THEME, 'dark');
        applyThemeBrandAssets('dark');
    } else {
        // التبديل إلى الوضع الفاتح
        body.classList.add('light-mode');
        root.setAttribute('data-theme', 'light');
        root.classList.remove('dark');
        if (themeToggle) { themeToggle.innerHTML = '<i class="fas fa-sun"></i>'; themeToggle.title = 'تبديل إلى الوضع الداكن'; }
        localStorage.setItem(LS_KEY_THEME, 'light');
        applyThemeBrandAssets('light');
    }
}

function applyThemeBrandAssets(theme) {
    const normalizedTheme = theme === 'light' ? 'light' : 'dark';
    const brandAssetPath = BRAND_ASSET_BY_THEME[normalizedTheme];

    document.querySelectorAll('.theme-aware-logo').forEach((logoEl) => {
        if (!logoEl) return;
        if (logoEl.getAttribute('src') !== brandAssetPath) {
            logoEl.setAttribute('src', brandAssetPath);
        }
    });

    const faviconElements = [
        ...document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]'),
        document.getElementById('appFavicon'),
        document.getElementById('appFaviconShortcut')
    ];
    const visited = new Set();
    faviconElements.forEach((iconEl) => {
        if (!iconEl || visited.has(iconEl)) return;
        visited.add(iconEl);
        iconEl.setAttribute('href', brandAssetPath);
    });
}

function loadThemePreference() {
    const savedTheme = localStorage.getItem(LS_KEY_THEME) || 'dark';
    const body = document.body;
    const themeToggle = document.getElementById('theme-toggle');
    const root = document.documentElement;

    if (savedTheme === 'light') {
        body.classList.add('light-mode');
        root.setAttribute('data-theme', 'light');
        root.classList.remove('dark');
        if (themeToggle) {
            themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
            themeToggle.title = 'تبديل إلى الوضع الداكن';
        }
        applyThemeBrandAssets('light');
    } else {
        body.classList.remove('light-mode');
        root.setAttribute('data-theme', 'dark');
        root.classList.add('dark');
        if (themeToggle) {
            themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
            themeToggle.title = 'تبديل إلى الوضع الفاتح';
        }
        applyThemeBrandAssets('dark');
    }
}


function saveAutoRefreshPreference(isEnabled) {
    localStorage.setItem(LS_KEY_AUTO_REFRESH, isEnabled ? 'true' : 'false');
}
function loadAutoRefreshPreference() {
    const savedPreference = localStorage.getItem(LS_KEY_AUTO_REFRESH);
    return savedPreference === 'true';
}

function saveUsdtTogglePreference(isEnabled) {
    localStorage.setItem(LS_KEY_HIDE_USDT, isEnabled ? 'true' : 'false');
    hideUsdtSuffix = isEnabled;
}

function loadUsdtTogglePreference() {
    const saved = localStorage.getItem(LS_KEY_HIDE_USDT);
    hideUsdtSuffix = saved === 'true';
    const checkbox = document.getElementById('usdtToggleCheckbox');
    if (checkbox) {
        checkbox.checked = hideUsdtSuffix;
        checkbox.addEventListener('change', function () {
            saveUsdtTogglePreference(this.checked);
            updateSummaryTable();
        });
    }
}

function saveFinancialPrivacyPreference(isEnabled) {
    localStorage.setItem(LS_KEY_FINANCIAL_PRIVACY, isEnabled ? 'true' : 'false');
}

function updateFinancialPrivacyToggleUI() {
    const button = document.getElementById('financialPrivacyToggle');
    const icon = document.getElementById('financialPrivacyToggleIcon');
    const label = document.getElementById('financialPrivacyToggleLabel');
    if (!button || !icon || !label) return;

    if (financialPrivacyEnabled) {
        icon.innerHTML = '<i class="fas fa-eye"></i>';
        label.textContent = 'إظهار الأموال';
        button.classList.add('is-active');
        button.setAttribute('aria-pressed', 'true');
    } else {
        icon.innerHTML = '<i class="fas fa-eye-slash"></i>';
        label.textContent = 'إخفاء الأموال';
        button.classList.remove('is-active');
        button.setAttribute('aria-pressed', 'false');
    }
}

function startFinancialPrivacyObserver() {
    if (financialPrivacyObserver) return;

    financialPrivacyObserver = new MutationObserver(() => {
        if (!financialPrivacyEnabled || isApplyingFinancialPrivacyMask) return;
        scheduleFinancialPrivacyRefresh();
    });

    financialPrivacyObserver.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true
    });
}

function stopFinancialPrivacyObserver() {
    if (!financialPrivacyObserver) return;
    financialPrivacyObserver.disconnect();
    financialPrivacyObserver = null;
}

function scheduleFinancialPrivacyRefresh() {
    if (!financialPrivacyEnabled || financialPrivacyRefreshScheduled) return;
    financialPrivacyRefreshScheduled = true;
    requestAnimationFrame(() => {
        financialPrivacyRefreshScheduled = false;
        applyFinancialPrivacyMasking();
    });
}

function countDigitsInValue(value) {
    const digits = value.match(/\d/g);
    return digits ? digits.length : 0;
}

function buildMaskForNumericToken(token) {
    const starCount = Math.max(2, countDigitsInValue(token));
    return '*'.repeat(starCount);
}

function maskFinancialText(text, forceNumericMask = false) {
    if (typeof text !== 'string' || text.length === 0) return text;

    let masked = text;

    masked = masked.replace(/(\$\s*)([-+]?\d[\d,]*(?:\.\d+)?)/g, (_, prefix, amount) => {
        return `${prefix}${buildMaskForNumericToken(amount)}`;
    });

    masked = masked.replace(/([-+]?\d[\d,]*(?:\.\d+)?)(\s*\$)/g, (_, amount, suffix) => {
        return `${buildMaskForNumericToken(amount)}${suffix}`;
    });

    if (forceNumericMask) {
        masked = masked.replace(/[-+]?\d[\d,]*(?:\.\d+)?/g, (token) => buildMaskForNumericToken(token));
    }

    return masked;
}

function maskFinancialHtml(html, forceNumericMask = false) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const textNodes = [];

    while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
    }

    textNodes.forEach((node) => {
        node.nodeValue = maskFinancialText(node.nodeValue, forceNumericMask);
    });

    return template.innerHTML;
}

function collectFinancialPrivacyTargets(targetDefinitions) {
    const targetMap = new Map();

    targetDefinitions.forEach((definition) => {
        document.querySelectorAll(definition.selector).forEach((element) => {
            const existing = targetMap.get(element);
            if (existing) {
                existing.forceNumeric = existing.forceNumeric || !!definition.forceNumeric;
            } else {
                targetMap.set(element, {
                    element,
                    forceNumeric: !!definition.forceNumeric
                });
            }
        });
    });

    return Array.from(targetMap.values());
}

function applyMaskToTextTarget(target) {
    const { element, forceNumeric } = target;
    const currentText = element.textContent || '';
    const storedOriginal = financialPrivacyOriginalTextMap.get(element);

    if (storedOriginal === undefined) {
        financialPrivacyOriginalTextMap.set(element, currentText);
    } else {
        const expectedMasked = maskFinancialText(storedOriginal, forceNumeric);
        if (currentText !== expectedMasked) {
            financialPrivacyOriginalTextMap.set(element, currentText);
        }
    }

    const sourceText = financialPrivacyOriginalTextMap.get(element) || '';
    const maskedText = maskFinancialText(sourceText, forceNumeric);
    if (currentText !== maskedText) {
        element.textContent = maskedText;
    }
}

function restoreTextTarget(target) {
    const { element, forceNumeric } = target;
    const storedOriginal = financialPrivacyOriginalTextMap.get(element);
    if (storedOriginal === undefined) return;

    const expectedMasked = maskFinancialText(storedOriginal, forceNumeric);
    if ((element.textContent || '') === expectedMasked) {
        element.textContent = storedOriginal;
    }

    financialPrivacyOriginalTextMap.delete(element);
}

function applyMaskToHtmlTarget(target) {
    const { element, forceNumeric } = target;
    const currentHtml = element.innerHTML;
    const storedOriginal = financialPrivacyOriginalHtmlMap.get(element);

    if (storedOriginal === undefined) {
        financialPrivacyOriginalHtmlMap.set(element, currentHtml);
    } else {
        const expectedMasked = maskFinancialHtml(storedOriginal, forceNumeric);
        if (currentHtml !== expectedMasked) {
            financialPrivacyOriginalHtmlMap.set(element, currentHtml);
        }
    }

    const sourceHtml = financialPrivacyOriginalHtmlMap.get(element) || '';
    const maskedHtml = maskFinancialHtml(sourceHtml, forceNumeric);
    if (currentHtml !== maskedHtml) {
        element.innerHTML = maskedHtml;
    }
}

function restoreHtmlTarget(target) {
    const { element, forceNumeric } = target;
    const storedOriginal = financialPrivacyOriginalHtmlMap.get(element);
    if (storedOriginal === undefined) return;

    const expectedMasked = maskFinancialHtml(storedOriginal, forceNumeric);
    if (element.innerHTML === expectedMasked) {
        element.innerHTML = storedOriginal;
    }

    financialPrivacyOriginalHtmlMap.delete(element);
}

function applyFinancialPrivacyMasking() {
    const textTargets = collectFinancialPrivacyTargets(FINANCIAL_PRIVACY_TEXT_TARGETS);
    const htmlTargets = collectFinancialPrivacyTargets(FINANCIAL_PRIVACY_HTML_TARGETS);

    isApplyingFinancialPrivacyMask = true;
    try {
        if (financialPrivacyEnabled) {
            textTargets.forEach(applyMaskToTextTarget);
            htmlTargets.forEach(applyMaskToHtmlTarget);
        } else {
            textTargets.forEach(restoreTextTarget);
            htmlTargets.forEach(restoreHtmlTarget);
        }
    } finally {
        isApplyingFinancialPrivacyMask = false;
    }
}

function loadFinancialPrivacyPreference() {
    const savedPreference = localStorage.getItem(LS_KEY_FINANCIAL_PRIVACY);
    financialPrivacyEnabled = savedPreference === 'true';
    updateFinancialPrivacyToggleUI();

    if (financialPrivacyEnabled) {
        startFinancialPrivacyObserver();
        applyFinancialPrivacyMasking();
    } else {
        stopFinancialPrivacyObserver();
        applyFinancialPrivacyMasking();
    }
}

function toggleFinancialPrivacyMode() {
    financialPrivacyEnabled = !financialPrivacyEnabled;
    saveFinancialPrivacyPreference(financialPrivacyEnabled);
    updateFinancialPrivacyToggleUI();

    if (financialPrivacyEnabled) {
        startFinancialPrivacyObserver();
        applyFinancialPrivacyMasking();
        showToast('تم تفعيل Financial Privacy Mode', 'info', 2500);
    } else {
        stopFinancialPrivacyObserver();
        applyFinancialPrivacyMasking();
        showToast('تم إيقاف Financial Privacy Mode', 'info', 2500);
    }
}

// =========================================
//    Balance State Management Functions
// =========================================

function loadBalanceState() {
    try {
        const saved = localStorage.getItem(LS_KEY_BALANCE_STATE);
        if (saved) {
            const parsed = JSON.parse(saved);
            balanceState = {
                currency: parsed.currency || 'USD',
                principalCash: parseFloat(parsed.principalCash) || 0,
                profitWallet: parseFloat(parsed.profitWallet) || 0,
                realizedLoss: parseFloat(parsed.realizedLoss) || 0
            };
        } else {
            balanceState = {
                currency: 'USD',
                principalCash: 0,
                profitWallet: 0,
                realizedLoss: 0
            };
        }
    } catch (error) {
        console.error('Error loading balance state:', error);
        balanceState = {
            currency: 'USD',
            principalCash: 0,
            profitWallet: 0,
            realizedLoss: 0
        };
    }
    updateBalancesUI();
}

function saveBalanceState() {
    try {
        localStorage.setItem(LS_KEY_BALANCE_STATE, JSON.stringify(balanceState));
    } catch (error) {
        console.error('Error saving balance state:', error);
        showToast('فشل حفظ حالة الرصيد', 'error', 3000);
    }
}

function setPrincipalCash(value) {
    const amount = parseFloat(value);
    if (isNaN(amount) || amount < 0) {
        showToast('يجب إدخال قيمة صحيحة (>= 0)', 'warning', 3000);
        return false;
    }
    balanceState.principalCash = amount;
    saveBalanceState();
    updateBalancesUI();
    showToast(`تم تعيين رأس المال إلى $${formatNumber(amount, 2)}`, 'success', 3000);
    return true;
}

function resetPrincipal() {
    showConfirm(
        'هل أنت متأكد من إعادة تعيين رأس المال إلى صفر؟',
        () => {
            balanceState.principalCash = 0;
            saveBalanceState();
            updateBalancesUI();
            showToast('تم إعادة تعيين رأس المال إلى صفر', 'success', 3000);
            closePrincipalModal();
        }
    );
}

function refundPrincipal(amount) {
    const refundAmount = parseFloat(amount);
    if (isNaN(refundAmount) || refundAmount <= 0) {
        return false;
    }

    balanceState.principalCash += refundAmount;
    saveBalanceState();
    updateBalancesUI();
    return true;
}

function applyBuy(amount) {
    const buyAmount = parseFloat(amount);
    if (isNaN(buyAmount) || buyAmount <= 0) {
        return false;
    }

    if (balanceState.principalCash < buyAmount) {
        // Don't show toast here - let caller show detailed error
        return false;
    }

    balanceState.principalCash -= buyAmount;
    saveBalanceState();
    updateBalancesUI();
    return true;
}

function applySell(sellQty, sellPrice, averageCost) {
    const qty = parseFloat(sellQty);
    const price = parseFloat(sellPrice);
    const avgCost = parseFloat(averageCost);

    if (isNaN(qty) || isNaN(price) || isNaN(avgCost) || qty <= 0 || price <= 0 || avgCost <= 0) {
        return false;
    }

    const sellProceeds = qty * price;
    const costBasisSold = qty * avgCost;
    const realizedPnL = sellProceeds - costBasisSold;

    // CORRECT LOGIC: Only cost basis returns to principal, not full proceeds
    balanceState.principalCash += costBasisSold;

    // Update profit or loss buckets
    if (realizedPnL > 0) {
        balanceState.profitWallet += realizedPnL;
    } else if (realizedPnL < 0) {
        balanceState.realizedLoss += Math.abs(realizedPnL);
    }

    saveBalanceState();
    updateBalancesUI();
    return true;
}

function transferProfitsToCash() {
    if (balanceState.profitWallet <= 0) {
        showToast('لا توجد أرباح لنقلها', 'warning', 3000);
        return;
    }

    showConfirm(
        `هل تريد نقل $${formatNumber(balanceState.profitWallet, 2)} من الأرباح إلى رأس المال؟`,
        () => {
            balanceState.principalCash += balanceState.profitWallet;
            balanceState.profitWallet = 0;
            saveBalanceState();
            updateBalancesUI();
            showToast('تم نقل الأرباح إلى رأس المال بنجاح', 'success', 3000);
        }
    );
}

function resetRealizedLoss() {
    if (balanceState.realizedLoss <= 0) {
        showToast('لا توجد خسائر لإعادة تعيينها', 'warning', 3000);
        return;
    }

    showConfirm(
        `هل تريد إعادة تعيين الخسائر المحققة ($${formatNumber(balanceState.realizedLoss, 2)}) إلى صفر؟`,
        () => {
            balanceState.realizedLoss = 0;
            saveBalanceState();
            updateBalancesUI();
            showToast('تم إعادة تعيين الخسائر إلى صفر', 'success', 3000);
        }
    );
}

function updateBalancesUI() {
    const principalDisplay = document.getElementById('principalCashDisplay');
    const profitDisplay = document.getElementById('profitWalletDisplay');
    const lossDisplay = document.getElementById('realizedLossDisplay');
    const currentPrincipalInfo = document.getElementById('currentPrincipalInfo');
    const transferBtn = document.getElementById('transferProfitsBtn');
    const resetLossBtn = document.getElementById('resetLossBtn');
    const profitCents = Math.round((Number(balanceState.profitWallet) || 0) * 100);
    const realizedLossCents = Math.round((Number(balanceState.realizedLoss) || 0) * 100);

    if (principalDisplay) {
        principalDisplay.textContent = `$${formatNumber(balanceState.principalCash, 2)}`;
    }

    if (profitDisplay) {
        profitDisplay.textContent = `$${formatNumber(balanceState.profitWallet, 2)}`;
    }

    if (lossDisplay) {
        lossDisplay.textContent = `$${formatNumber(balanceState.realizedLoss, 2)}`;
    }

    if (currentPrincipalInfo) {
        currentPrincipalInfo.textContent = `$${formatNumber(balanceState.principalCash, 2)}`;
    }

    if (transferBtn) {
        transferBtn.disabled = profitCents <= 0;
    }

    if (resetLossBtn) {
        resetLossBtn.disabled = realizedLossCents <= 0;
    }
}

function openPrincipalModal() {
    const modal = document.getElementById('principalModal');
    const input = document.getElementById('principalInput');

    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';

        if (input) {
            input.value = balanceState.principalCash;
            setTimeout(() => input.focus(), 100);
        }

        updateBalancesUI();
    }
}

function closePrincipalModal() {
    const modal = document.getElementById('principalModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function savePrincipalInput() {
    const input = document.getElementById('principalInput');
    if (input) {
        const value = input.value;
        if (setPrincipalCash(value)) {
            closePrincipalModal();
        }
    }
}



function updateCoinSelector() {
    const previouslySelected = coinSelector.value;
    coinSelector.innerHTML = '<option value="">-- اختر عملة --</option>';
    const coinSymbols = Object.keys(allCoinData).sort();
    coinSymbols.forEach(symbol => {
        const option = document.createElement('option');
        option.value = symbol; option.textContent = symbol;
        coinSelector.appendChild(option);
    });
    if (activeCoinSymbol && allCoinData[activeCoinSymbol]) {
        coinSelector.value = activeCoinSymbol;
    } else if (previouslySelected && allCoinData[previouslySelected]) {
        coinSelector.value = previouslySelected; activeCoinSymbol = previouslySelected;
    } else if (coinSymbols.length > 0) {
        coinSelector.value = coinSymbols[0]; activeCoinSymbol = coinSymbols[0];
    } else {
        activeCoinSymbol = null; clearUIFields();
    }
    if (coinSelector.value) {
        displayCoinData(coinSelector.value);
    } else {
        updateCurrentCoinDisplay("لا عملة محددة");
    }
    updateCoinStatus();
}


function displayCoinData(symbol) {
    activeCoinSymbol = symbol;
    const data = allCoinData[symbol];
    if (!data) {
        console.warn(`No data for symbol: ${symbol}. Clearing UI.`);
        clearUIFields(); updateCurrentCoinDisplay(symbol || "خطأ"); calculateActiveCoinDetails(); return;
    }
    updateCurrentCoinDisplay(symbol);

    // Update Chart Button Label
    const chartCoinName = document.getElementById('chartCoinName');
    if (chartCoinName) chartCoinName.textContent = symbol;

    document.getElementById('initialEntryPrice').value = data.initialEntryPrice || '';
    document.getElementById('initialAmountDollars').value = data.initialAmountDollars || '';
    if (data.repurchases && data.repurchases.length === maxRepurchaseEntries) {
        for (let i = 0; i < maxRepurchaseEntries; i++) {
            const priceInput = document.getElementById(`repurchasePrice${i + 1}`);
            const amountInput = document.getElementById(`repurchaseAmount${i + 1}`);
            const dateTimeDiv = document.getElementById(`repurchaseDateTime${i + 1}`);

            if (priceInput) priceInput.value = data.repurchases[i]?.price || '';
            if (amountInput) amountInput.value = data.repurchases[i]?.amount || '';


            if (dateTimeDiv && data.repurchases[i]?.time) {
                const repurchaseDate = new Date(data.repurchases[i].time);
                dateTimeDiv.innerHTML = formatDateTime(repurchaseDate, i + 1);
            } else if (dateTimeDiv) {

                if (data.repurchases[i]?.price || data.repurchases[i]?.amount) {
                    dateTimeDiv.innerHTML = `<button onclick="editRepurchaseTime(${i + 1})" class="text-blue-600 hover:text-blue-700 font-medium text-xs underline decoration-2 underline-offset-4 dark:text-blue-400 dark:hover:text-blue-300 transition-all">تعديل الوقت</button>`;
                } else {
                    dateTimeDiv.innerHTML = '';
                }
            }
        }
    } else {
        for (let i = 1; i <= maxRepurchaseEntries; i++) {
            const pIn = document.getElementById(`repurchasePrice${i}`); if (pIn) pIn.value = '';
            const aIn = document.getElementById(`repurchaseAmount${i}`); if (aIn) aIn.value = '';
            const dtDiv = document.getElementById(`repurchaseDateTime${i}`); if (dtDiv) dtDiv.innerHTML = '';
        }
    }
    if (data.targets) {
        document.getElementById('tpPercent1').value = data.targets.tp1 || '';
        document.getElementById('tpPercent2').value = data.targets.tp2 || '';
        document.getElementById('tpPercent3').value = data.targets.tp3 || '';
        document.getElementById('slPercent').value = data.targets.sl || '';
    } else {
        document.getElementById('tpPercent1').value = ''; document.getElementById('tpPercent2').value = '';
        document.getElementById('tpPercent3').value = ''; document.getElementById('slPercent').value = '';
    }
    const activeCoinPrice = currentMarketPrices[symbol];
    if (activeCoinPrice !== null && activeCoinPrice !== undefined && !isNaN(activeCoinPrice)) {
        marketPriceDisplay.textContent = formatPriceWithZeroCount(activeCoinPrice);
        marketPriceDisplay.title = formatPriceFull(activeCoinPrice);
        marketPriceDisplay.classList.remove('error');
    } else {
        marketPriceDisplay.removeAttribute('title');
        marketPriceDisplay.textContent = '---'; marketPriceDisplay.classList.add('error');
    }
    calculateActiveCoinDetails(); updateCoinStatus();
}


function updateRepurchaseRowsVisibility() {
    if (!repurchaseTableBody) return;
    repurchaseTableBody.querySelectorAll('tr').forEach(row => {
        row.classList.remove('repurchase-row-hidden');
    });
}

function updateSellRowsVisibility() {
    if (!sellTableBody) return;
    sellTableBody.querySelectorAll('tr').forEach(row => {
        row.classList.remove('repurchase-row-hidden');
    });
}

function syncRepurchaseTableVisibleRows() {
    const wrapper = document.querySelector('.section-repurchase .repurchase-table-wrapper');
    if (!wrapper) return;

    const table = wrapper.querySelector('.repurchase-table');
    const headRow = table?.querySelector('thead tr');
    const bodyRows = table?.querySelectorAll('tbody tr');
    const sampleRow = bodyRows?.[0];

    if (!table || !headRow || !sampleRow) return;

    const headHeight = Math.ceil(headRow.getBoundingClientRect().height);
    const rowHeight = Math.ceil(sampleRow.getBoundingClientRect().height);
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;

    const horizontalScrollReserve = table.scrollWidth > wrapper.clientWidth ? 12 : 2;
    const targetHeight = headHeight + (rowHeight * REPURCHASE_VISIBLE_ROWS) + horizontalScrollReserve;

    wrapper.style.height = `${targetHeight}px`;
    wrapper.style.maxHeight = `${targetHeight}px`;
}

function scheduleRepurchaseTableVisibleRowsSync() {
    requestAnimationFrame(syncRepurchaseTableVisibleRows);
}

function handleRepurchaseTableViewportResize() {
    clearTimeout(repurchaseViewportResizeDebounceTimer);
    repurchaseViewportResizeDebounceTimer = setTimeout(() => {
        syncRepurchaseTableVisibleRows();
    }, 120);
}


function clearUIFields() {
    document.getElementById('initialEntryPrice').value = '';
    document.getElementById('initialAmountDollars').value = '';
    document.getElementById('tpPercent1').value = ''; document.getElementById('tpPercent2').value = '';
    document.getElementById('tpPercent3').value = ''; document.getElementById('slPercent').value = '';
    for (let i = 1; i <= maxRepurchaseEntries; i++) {
        const pIn = document.getElementById(`repurchasePrice${i}`); if (pIn) pIn.value = '';
        const aIn = document.getElementById(`repurchaseAmount${i}`); if (aIn) aIn.value = '';
        const dtDiv = document.getElementById(`repurchaseDateTime${i}`); if (dtDiv) dtDiv.innerHTML = '';
    }
    marketPriceDisplay.textContent = '---'; marketPriceDisplay.classList.remove('error');
    apiStatusDiv.innerHTML = '<i class="fas fa-circle-info" aria-hidden="true"></i> اختر عملة أو أضف واحدة جديدة'; setApiStatusColor('var(--text-muted)');
    updateCurrentCoinDisplay("لا عملة محددة"); calculateActiveCoinDetails();

    // Update Chart Button Label
    const chartCoinName = document.getElementById('chartCoinName');
    if (chartCoinName) chartCoinName.textContent = '';
}


function updateCurrentCoinDisplay(symbol) {
    const displayText = symbol || "---";
    currentCoinDisplayElements.forEach(el => { if (el) el.textContent = displayText; });
}


function updateCoinStatus() {
    const count = Object.keys(allCoinData).length;

    document.getElementById('deleteCoinBtn').disabled = !activeCoinSymbol;
    document.getElementById('chartBtn').disabled = !activeCoinSymbol;
}


function updateActiveCoinDataInMemory() {
    if (!activeCoinSymbol || !allCoinData[activeCoinSymbol]) return;
    const currentData = allCoinData[activeCoinSymbol];
    const cycleResetEpsilon = 0.00000001;

    if (!Array.isArray(currentData.sells)) {
        currentData.sells = [];
    }
    currentData.sellCycleStartIndex = getSellCycleStartIndex(currentData);
    const oldSellCycleStartIndex = currentData.sellCycleStartIndex;

    // Track old values to detect new purchases
    const oldInitialPrice = parseFloat(currentData.initialEntryPrice) || 0;
    const oldInitialAmount = parseFloat(currentData.initialAmountDollars) || 0;
    const oldInitialCost = oldInitialPrice > 0 ? oldInitialAmount : 0;

    // Get new values
    const newInitialPrice = parseFloat(document.getElementById('initialEntryPrice').value) || 0;
    const newInitialAmount = parseFloat(document.getElementById('initialAmountDollars').value) || 0;
    const newInitialCost = newInitialPrice > 0 ? newInitialAmount : 0;

    // Calculate initial entry difference
    const initialDiff = newInitialCost - oldInitialCost;

    // حفظ النسخة القديمة من المصفوفة للحفاظ على التواريخ
    const oldRepurchases = currentData.repurchases ? [...currentData.repurchases] : [];

    // Calculate old repurchases total
    let oldRepurchasesTotal = 0;
    oldRepurchases.forEach(rp => {
        const price = parseFloat(rp.price) || 0;
        const amount = parseFloat(rp.amount) || 0;
        if (price > 0 && amount > 0) {
            oldRepurchasesTotal += amount;
        }
    });
    const oldTotalActiveCost = oldInitialCost + oldRepurchasesTotal;

    currentData.repurchases = [];
    let newRepurchasesTotal = 0;
    let newRepurchasesQty = 0;

    for (let i = 1; i <= maxRepurchaseEntries; i++) {
        const priceInput = document.getElementById(`repurchasePrice${i}`);
        const amountInput = document.getElementById(`repurchaseAmount${i}`);
        const price = priceInput?.value || '';
        const amount = amountInput?.value || '';

        let repurchaseTime = null;

        // محاولة استرجاع الوقت المخزن سابقاً
        if (oldRepurchases[i - 1]?.time) {
            repurchaseTime = oldRepurchases[i - 1].time;
        }
        // إذا لم يوجد وقت سابق وتم إدخال بيانات جديدة، نضع الوقت الحالي
        else if (price || amount) {
            repurchaseTime = new Date().toISOString();
        }

        currentData.repurchases.push({
            price: price,
            amount: amount,
            time: repurchaseTime
        });

        // Calculate new repurchases total
        const priceNum = parseFloat(price) || 0;
        const amountNum = parseFloat(amount) || 0;
        if (priceNum > 0 && amountNum > 0) {
            newRepurchasesTotal += amountNum;
            newRepurchasesQty += amountNum / priceNum;
        }
    }

    const newTotalActiveCost = newInitialCost + newRepurchasesTotal;
    const newInitialQty = newInitialPrice > 0 ? (newInitialAmount / newInitialPrice) : 0;
    const newTotalBuyQty = newInitialQty + newRepurchasesQty;

    // If the previous position was closed and user starts a new buy cycle,
    // ignore historical sells from prior cycle in current holdings calculations.
    if (
        currentData.sells.length > 0 &&
        oldTotalActiveCost <= cycleResetEpsilon &&
        newTotalActiveCost > cycleResetEpsilon
    ) {
        currentData.sellCycleStartIndex = currentData.sells.length;
    }

    // Legacy data healing: when old sell ledger fully covers current buy qty,
    // treat it as a new cycle baseline to prevent "0 quantity" after re-buy.
    const allTimeSoldQty = currentData.sells.reduce((acc, sell) => acc + (parseFloat(sell?.qty) || 0), 0);
    if (
        currentData.sells.length > 0 &&
        currentData.sellCycleStartIndex === 0 &&
        newTotalBuyQty > cycleResetEpsilon &&
        allTimeSoldQty >= newTotalBuyQty - cycleResetEpsilon
    ) {
        currentData.sellCycleStartIndex = currentData.sells.length;
    }

    // Calculate repurchases difference
    const repurchasesDiff = newRepurchasesTotal - oldRepurchasesTotal;

    // Total purchase difference (can be positive or negative)
    const totalPurchaseDiff = initialDiff + repurchasesDiff;

    // Handle purchase changes
    if (totalPurchaseDiff > 0) {
        // New purchase - deduct from principal
        const success = applyBuy(totalPurchaseDiff);
        if (!success) {
            // Revert changes if insufficient balance
            showToast(`رصيد رأس المال غير كافٍ! تحتاج إلى $${totalPurchaseDiff.toFixed(2)} ولكن لديك فقط $${balanceState.principalCash.toFixed(2)}`, 'error', 5000);

            // Restore old values
            document.getElementById('initialEntryPrice').value = currentData.initialEntryPrice || '';
            document.getElementById('initialAmountDollars').value = currentData.initialAmountDollars || '';

            // Restore old repurchases
            for (let i = 1; i <= maxRepurchaseEntries; i++) {
                const oldRp = oldRepurchases[i - 1];
                if (oldRp) {
                    const priceInput = document.getElementById(`repurchasePrice${i}`);
                    const amountInput = document.getElementById(`repurchaseAmount${i}`);
                    if (priceInput) priceInput.value = oldRp.price || '';
                    if (amountInput) amountInput.value = oldRp.amount || '';
                }
            }

            currentData.repurchases = oldRepurchases;
            currentData.sellCycleStartIndex = oldSellCycleStartIndex;
            return; // Don't save changes
        }
    } else if (totalPurchaseDiff < 0) {
        // Deletion or reduction - refund to principal
        const refundAmount = Math.abs(totalPurchaseDiff);
        refundPrincipal(refundAmount);
    }
    // If totalPurchaseDiff === 0, no change needed

    // Update values only if purchase was successful or no new purchase
    currentData.initialEntryPrice = document.getElementById('initialEntryPrice').value;
    currentData.initialAmountDollars = document.getElementById('initialAmountDollars').value;

    currentData.targets = {
        tp1: document.getElementById('tpPercent1').value, tp2: document.getElementById('tpPercent2').value,
        tp3: document.getElementById('tpPercent3').value, sl: document.getElementById('slPercent').value
    };
}


function editRepurchaseTime(index) {
    const dateTimeDiv = document.getElementById(`repurchaseDateTime${index}`);
    if (!dateTimeDiv) return;

    const currentDateTime = allCoinData[activeCoinSymbol]?.repurchases[index - 1]?.time;
    const initialValue = currentDateTime ? new Date(currentDateTime).toISOString().slice(0, 16) : new Date().toISOString().slice(0, 16);

    dateTimeDiv.innerHTML = `
                <input type="datetime-local" id="manualTimeInput${index}" class="manual-time-input" value="${initialValue}">
                <button onclick="saveManualTime(${index})" class="add-time-btn" style="margin-top: 5px;">حفظ</button>
            `;
}

function saveManualTime(index) {
    const input = document.getElementById(`manualTimeInput${index}`);
    if (!input || !activeCoinSymbol || !allCoinData[activeCoinSymbol]) return;

    const newTime = new Date(input.value);
    if (!isNaN(newTime.getTime())) {
        allCoinData[activeCoinSymbol].repurchases[index - 1].time = newTime.toISOString();

        const dateTimeDiv = document.getElementById(`repurchaseDateTime${index}`);
        if (dateTimeDiv) {
            dateTimeDiv.innerHTML = formatDateTime(newTime);
        }
        saveAndCalculate();
    } else {
        alert('صيغة التاريخ والوقت غير صالحة.');
    }
}


function updateRepurchaseTime(index) {
    if (!activeCoinSymbol || !allCoinData[activeCoinSymbol]) return;


    if (allCoinData[activeCoinSymbol].repurchases[index - 1]?.time) {
        return;
    }

    const priceInput = document.getElementById(`repurchasePrice${index}`);
    const amountInput = document.getElementById(`repurchaseAmount${index}`);
    const dateTimeDiv = document.getElementById(`repurchaseDateTime${index}`);

    const price = priceInput?.value || '';
    const amount = amountInput?.value || '';

    if (price || amount) {
        const currentTime = new Date();
        allCoinData[activeCoinSymbol].repurchases[index - 1].time = currentTime.toISOString();
        if (dateTimeDiv) {
            dateTimeDiv.innerHTML = formatDateTime(currentTime, index);
        }
    } else {
        allCoinData[activeCoinSymbol].repurchases[index - 1].time = null;
        if (dateTimeDiv) {
            dateTimeDiv.innerHTML = '<button onclick="editRepurchaseTime(' + index + ')" class="add-time-btn">إضافة وقت</button>';
        }
    }
}

function saveAndCalculate() {
    calculateActiveCoinDetails();
    if (activeCoinSymbol) {
        updateActiveCoinDataInMemory(); saveAllDataToLocalStorage();
    }
    updateSummaryTable();
    updatePortfolioStats();
}


function createRepurchaseRows() {
    repurchaseTableBody.innerHTML = '';
    for (let i = 1; i <= maxRepurchaseEntries; i++) {
        const row = document.createElement('tr');
        row.innerHTML = `
                <td>${i}</td>
                <td><span class="down-percent" id="downPercent${i}">-%</span></td>
                <td><input type="number" id="repurchasePrice${i}" step="any" placeholder="السعر" oninput="updateRepurchaseTime(${i}); saveAndCalculate()"></td>
                <td><input type="number" id="repurchaseAmount${i}" step="any" placeholder="0.00" oninput="updateRepurchaseTime(${i}); saveAndCalculate()"></td>
                <td><div class="output-field" id="repurchaseQty${i}">0.00</div></td>
                <td><div class="output-field repurchase-pnl" id="repurchasePnl${i}">0.00</div></td>
                <td><div class="output-field repurchase-pnl-percent" id="repurchasePnlPercent${i}">0.00%</div></td>
                <td><div class="output-field repurchase-fee ltr-text" id="repurchaseBuyFee${i}">$ 0.0000</div></td>
                <td><div class="repurchase-datetime" id="repurchaseDateTime${i}"></div></td>

            `;
        repurchaseTableBody.appendChild(row);
    }

    updateRepurchaseRowsVisibility();
    scheduleRepurchaseTableVisibleRowsSync();
}

// =========================================
//           SELL SECTION LOGIC
// =========================================

function parseLooseNumber(value) {
    if (value === null || value === undefined) return NaN;
    const normalized = String(value).replace(/,/g, '').replace(/[^\d.+-]/g, '');
    if (!normalized || normalized === '+' || normalized === '-' || normalized === '.') return NaN;
    return parseFloat(normalized);
}

function getSellCycleStartIndex(data) {
    const sellsCount = Array.isArray(data?.sells) ? data.sells.length : 0;
    const rawIndex = Number.parseInt(data?.sellCycleStartIndex, 10);
    if (!Number.isFinite(rawIndex) || rawIndex < 0) return 0;
    return Math.min(rawIndex, sellsCount);
}

function getCurrentCycleSells(data) {
    const sells = Array.isArray(data?.sells) ? data.sells : [];
    const cycleStartIndex = getSellCycleStartIndex(data);
    if (cycleStartIndex <= 0) return sells;
    return sells.slice(cycleStartIndex);
}

function getCurrentCycleSoldQuantity(data) {
    const cycleSells = getCurrentCycleSells(data);
    return cycleSells.reduce((acc, sell) => acc + (parseFloat(sell?.qty) || 0), 0);
}

function getCoinSellContext(data) {
    if (!data || typeof data !== 'object') {
        return {
            totalBuyQty: 0,
            totalBuyInvested: 0,
            totalSoldQty: 0,
            remainingQty: 0
        };
    }

    const initialEntryPrice = parseFloat(data.initialEntryPrice) || 0;
    const initialAmountDollars = parseFloat(data.initialAmountDollars) || 0;
    let totalBuyQty = (initialEntryPrice > 0 && initialAmountDollars > 0)
        ? (initialAmountDollars / initialEntryPrice)
        : 0;
    let totalBuyInvested = (initialEntryPrice > 0 && initialAmountDollars > 0)
        ? initialAmountDollars
        : 0;

    if (Array.isArray(data.repurchases)) {
        data.repurchases.forEach((rp) => {
            const rPrice = parseFloat(rp?.price) || 0;
            const rAmount = parseFloat(rp?.amount) || 0;
            if (rPrice > 0 && rAmount > 0) {
                totalBuyQty += rAmount / rPrice;
                totalBuyInvested += rAmount;
            }
        });
    }

    const totalSoldQty = getCurrentCycleSoldQuantity(data);
    const remainingQty = Math.max(0, totalBuyQty - totalSoldQty);

    return {
        totalBuyQty,
        totalBuyInvested,
        totalSoldQty,
        remainingQty
    };
}

function getActiveSpotFeeRate() {
    const feeService = window.spotFeeCalculatorService;
    if (!feeService?.getActiveFeeProfile || !feeService?.getAppliedFeeRate) return 0;

    const profile = feeService.getActiveFeeProfile();
    const rate = feeService.getAppliedFeeRate(profile, 'taker');
    const numericRate = Number(rate);
    return Number.isFinite(numericRate) && numericRate > 0 ? numericRate : 0;
}

function setTableFeesSummaryValue(element, value) {
    if (!element) return;
    const numericValue = Number(value);
    const safeValue = Number.isFinite(numericValue) ? numericValue : 0;
    element.textContent = `$ ${formatNumber(safeValue, 4)}`;
}

function fillSellQtyWithRemaining() {
    const qtyInput = document.getElementById('newSellQty');
    if (!qtyInput) return;

    if (!activeCoinSymbol || !allCoinData[activeCoinSymbol]) {
        showToast('يرجى اختيار عملة أولاً.', 'warning', 2500);
        return;
    }

    const context = getCoinSellContext(allCoinData[activeCoinSymbol]);
    const remainingQty = context.remainingQty;

    if (!(remainingQty > 0)) {
        qtyInput.value = '';
        calculateSellPreview();
        showToast('لا توجد كمية متبقية للبيع.', 'info', 2200);
        return;
    }

    qtyInput.value = formatNumber(remainingQty, 8);
    calculateSellPreview();
}

function calculateCoinPositionSnapshot(symbol) {
    const data = allCoinData[symbol];
    if (!data) {
        return {
            remainingQty: 0,
            liquidationValue: 0,
            remainingCostBasis: 0,
            usedMarketPrice: false
        };
    }

    const initialEntryPrice = parseFloat(data.initialEntryPrice) || 0;
    const initialAmountDollars = parseFloat(data.initialAmountDollars) || 0;
    let totalBuyQty = (initialEntryPrice > 0 && initialAmountDollars > 0)
        ? (initialAmountDollars / initialEntryPrice)
        : 0;
    let totalBuyInvested = (initialEntryPrice > 0 && initialAmountDollars > 0)
        ? initialAmountDollars
        : 0;

    if (Array.isArray(data.repurchases)) {
        data.repurchases.forEach((rp) => {
            const rPrice = parseFloat(rp?.price) || 0;
            const rAmount = parseFloat(rp?.amount) || 0;
            if (rPrice > 0 && rAmount > 0) {
                totalBuyQty += rAmount / rPrice;
                totalBuyInvested += rAmount;
            }
        });
    }

    const soldQty = getCurrentCycleSoldQuantity(data);
    const remainingQty = Math.max(0, totalBuyQty - soldQty);
    if (remainingQty <= 0) {
        return {
            remainingQty: 0,
            liquidationValue: 0,
            remainingCostBasis: 0,
            usedMarketPrice: false
        };
    }

    const averageCost = totalBuyQty > 0 ? (totalBuyInvested / totalBuyQty) : 0;
    const remainingCostBasis = Math.max(0, remainingQty * averageCost);
    const marketPrice = Number.parseFloat(currentMarketPrices[symbol]);
    const canUseMarketPrice = Number.isFinite(marketPrice) && marketPrice > 0;
    const liquidationValue = canUseMarketPrice
        ? Math.max(0, remainingQty * marketPrice)
        : remainingCostBasis;

    return {
        remainingQty,
        liquidationValue,
        remainingCostBasis,
        usedMarketPrice: canUseMarketPrice
    };
}

function settleCoinsBeforeDeletion(symbols) {
    const uniqueSymbols = Array.from(new Set((symbols || []).filter(Boolean)));
    if (!uniqueSymbols.length) {
        return { settledAmount: 0, settledCoinsCount: 0 };
    }

    let settledAmount = 0;
    let settledCoinsCount = 0;

    uniqueSymbols.forEach((symbol) => {
        const snapshot = calculateCoinPositionSnapshot(symbol);
        if (snapshot.liquidationValue > 0) {
            settledAmount += snapshot.liquidationValue;
            settledCoinsCount += 1;
        }
    });

    if (settledAmount > 0) {
        balanceState.principalCash += settledAmount;
        saveBalanceState();
        updateBalancesUI();
    }

    return { settledAmount, settledCoinsCount };
}

function clearEntryAndRepurchaseData(symbol) {
    if (!symbol || !allCoinData[symbol]) return;

    const data = allCoinData[symbol];
    data.initialEntryPrice = '';
    data.initialAmountDollars = '';
    data.repurchases = Array.from({ length: maxRepurchaseEntries }, () => ({
        price: '',
        amount: '',
        time: null
    }));

    if (activeCoinSymbol !== symbol) return;

    const initialEntryInput = document.getElementById('initialEntryPrice');
    const initialAmountInput = document.getElementById('initialAmountDollars');
    if (initialEntryInput) initialEntryInput.value = '';
    if (initialAmountInput) initialAmountInput.value = '';

    for (let i = 1; i <= maxRepurchaseEntries; i++) {
        const priceInput = document.getElementById(`repurchasePrice${i}`);
        const amountInput = document.getElementById(`repurchaseAmount${i}`);
        const dateTimeDiv = document.getElementById(`repurchaseDateTime${i}`);
        if (priceInput) priceInput.value = '';
        if (amountInput) amountInput.value = '';
        if (dateTimeDiv) dateTimeDiv.innerHTML = '';
    }
}

function addNewSellRecord() {
    if (!activeCoinSymbol || !allCoinData[activeCoinSymbol]) return;

    // Ensure sells array exists
    if (!allCoinData[activeCoinSymbol].sells) {
        allCoinData[activeCoinSymbol].sells = [];
    }

    const qtyInput = document.getElementById('newSellQty');
    const priceInput = document.getElementById('newSellPrice');
    const dateInput = document.getElementById('newSellDate');

    const qty = parseFloat(qtyInput.value);
    const price = parseFloat(priceInput.value);
    const dateVal = dateInput.value;

    if (isNaN(qty) || qty <= 0) {
        showToast('يرجى إدخال كمية صحيحة (أكبر من صفر)', 'warning');
        return;
    }
    if (isNaN(price) || price <= 0) {
        showToast('يرجى إدخال سعر بيع صحيح', 'warning');
        return;
    }

    // Validation: Check against remaining quantity
    // We need to calculate current remaining quantity first
    const data = allCoinData[activeCoinSymbol];
    const sellContext = getCoinSellContext(data);
    const totalBuyQty = sellContext.totalBuyQty;
    const totalBuyInvested = sellContext.totalBuyInvested;
    const remainingQty = sellContext.remainingQty;

    const sellValidationEpsilon = 0.00000001;

    if (qty > remainingQty + sellValidationEpsilon) { // Small epsilon for float errors
        showToast(`لا يمكنك بيع أكثر من الكمية المتاحة (${formatNumber(remainingQty, 6)})`, 'error');
        return;
    }

    const avgCostFromData = totalBuyQty > 0 ? (totalBuyInvested / totalBuyQty) : NaN;
    const avgCostFromUi = parseLooseNumber(document.getElementById('averageEntryPrice')?.textContent);
    const avgCostAtSell = avgCostFromData > 0 ? avgCostFromData : avgCostFromUi;

    const isFullSell = remainingQty > 0 && (remainingQty - qty) <= sellValidationEpsilon;

    // Proceed to Add
    const sellRecord = {
        qty: qty,
        price: price,
        time: dateVal ? new Date(dateVal).toISOString() : new Date().toISOString(),
        ...(avgCostAtSell > 0 ? { avgCostAtSell } : {})
    };

    allCoinData[activeCoinSymbol].sells.push(sellRecord);

    // Update Balance State (Principal Cash, Profit/Loss)
    if (avgCostAtSell > 0) {
        applySell(qty, price, avgCostAtSell);
    }

    // Clear Inputs
    qtyInput.value = '';
    priceInput.value = '';
    dateInput.value = '';
    document.getElementById('sellPreviewText').innerHTML = '';

    if (isFullSell) {
        allCoinData[activeCoinSymbol].sellCycleStartIndex = allCoinData[activeCoinSymbol].sells.length;
        clearEntryAndRepurchaseData(activeCoinSymbol);
        calculateActiveCoinDetails();
        updateSummaryTable();
        updatePortfolioStats();
        saveAllDataToLocalStorage(false, true);
        showToast('تم بيع كامل الكمية: تمت تصفية بيانات الدخول والتعزيز لهذه العملة.', 'success', 3500);
        return;
    }

    saveAndCalculate();
    showToast('تم إضافة عملية البيع بنجاح', 'success');
}

function deleteSellRecord(index) {
    // IMMUTABLE LEDGER: Sell records cannot be deleted to maintain accounting integrity
    showToast('سجل البيع نهائي ولا يمكن حذفه. للتصحيح، قم بإضافة عملية جديدة.', 'warning', 5000);
    return false;
}

function calculateSellPreview() {
    const qty = parseFloat(document.getElementById('newSellQty').value) || 0;
    const price = parseFloat(document.getElementById('newSellPrice').value) || 0;
    const previewEl = document.getElementById('sellPreviewText');
    if (!previewEl) return;

    if (qty > 0 && price > 0) {
        const total = qty * price;
        // Calculate estimated PnL based on current average cost from raw data (privacy-mode safe)
        let avgCost = 0;
        const data = activeCoinSymbol ? allCoinData[activeCoinSymbol] : null;
        if (data) {
            const initialEntryPrice = parseFloat(data.initialEntryPrice) || 0;
            const initialAmountDollars = parseFloat(data.initialAmountDollars) || 0;
            let totalBuyQty = (initialEntryPrice > 0) ? initialAmountDollars / initialEntryPrice : 0;
            let totalBuyInvested = initialAmountDollars;
            if (Array.isArray(data.repurchases)) {
                data.repurchases.forEach(rp => {
                    const rPrice = parseFloat(rp.price) || 0;
                    const rAmount = parseFloat(rp.amount) || 0;
                    if (rPrice > 0 && rAmount > 0) {
                        totalBuyQty += rAmount / rPrice;
                        totalBuyInvested += rAmount;
                    }
                });
            }
            avgCost = totalBuyQty > 0 ? (totalBuyInvested / totalBuyQty) : 0;
        }
        if (!(avgCost > 0)) {
            avgCost = parseLooseNumber(document.getElementById('averageEntryPrice')?.textContent) || 0;
        }
        const chips = [
            {
                label: 'الإجمالي',
                value: `$ ${formatNumber(total, 2)}`,
                toneClass: 'is-total'
            }
        ];

        if (avgCost > 0) {
            const estimatedCost = qty * avgCost;
            const pnl = total - estimatedCost;
            const pnlPercent = estimatedCost > 0 ? (pnl / estimatedCost) * 100 : 0;
            const pnlClass = pnl > 0 ? 'pnl-preview-positive' : (pnl < 0 ? 'pnl-preview-negative' : '');
            const sign = pnl > 0 ? '+' : (pnl < 0 ? '-' : '');
            const absPnl = Math.abs(pnl);
            const absPnlPercent = Math.abs(pnlPercent);

            chips.push({
                label: 'التكلفة',
                value: `$ ${formatNumber(estimatedCost, 2)}`,
                toneClass: 'is-cost'
            });
            chips.push({
                label: 'الربح/الخسارة',
                value: `${sign}$ ${formatNumber(absPnl, 2)}`,
                toneClass: pnl > 0 ? 'is-positive' : (pnl < 0 ? 'is-negative' : 'is-neutral'),
                extraValueClass: pnlClass
            });
            chips.push({
                label: 'النسبة',
                value: `${sign}${formatNumber(absPnlPercent, 2)}%`,
                toneClass: pnl > 0 ? 'is-positive' : (pnl < 0 ? 'is-negative' : 'is-neutral'),
                extraValueClass: pnlClass
            });
        }

        previewEl.classList.add('sell-preview-ready');
        previewEl.innerHTML = chips.map((chip) => `
            <span class="sell-preview-chip ${chip.toneClass || ''}">
                <span class="sell-preview-chip-label">${chip.label}</span>
                <span class="sell-preview-chip-value ltr-text ${chip.extraValueClass || ''}">${chip.value}</span>
            </span>
        `).join('');
    } else {
        previewEl.classList.remove('sell-preview-ready');
        previewEl.innerHTML = '';
    }
}

function createSellRows() {
    if (!sellTableBody) return;
    const tableBody = sellTableBody;
    const data = allCoinData[activeCoinSymbol];
    const activeFeeRate = getActiveSpotFeeRate();
    let totalSellFeesLedger = 0;

    const appendSellEmptyRow = (rowNumber) => {
        const emptyRow = document.createElement('tr');
        emptyRow.className = 'sell-empty-row';
        emptyRow.innerHTML = `
            <td class="sell-empty-cell">${rowNumber}</td>
            <td class="sell-empty-cell"><div class="output-field ltr-text">0.000000</div></td>
            <td class="sell-empty-cell"><div class="output-field ltr-text">$ 0.00000</div></td>
            <td class="sell-empty-cell"><div class="output-field ltr-text">$ 0.00000</div></td>
            <td class="sell-empty-cell"><div class="output-field ltr-text">$ 0.00</div></td>
            <td class="sell-empty-cell"><div class="output-field ltr-text">$ 0.00</div></td>
            <td class="sell-empty-cell"><div class="output-field repurchase-pnl ltr-text pnl-neutral">$ 0.00</div></td>
            <td class="sell-empty-cell"><div class="output-field repurchase-pnl-percent ltr-text pnl-neutral">0.00 %</div></td>
            <td class="sell-empty-cell"><div class="output-field ltr-text">0.000000</div></td>
            <td class="sell-empty-cell"><div class="output-field repurchase-fee ltr-text">$ 0.0000</div></td>
            <td class="sell-empty-cell"><div class="repurchase-datetime"><span class="ltr-text">—</span></div></td>
        `;
        tableBody.appendChild(emptyRow);
    };

    tableBody.innerHTML = '';

    if (!data || !data.sells || data.sells.length === 0) {
        setTableFeesSummaryValue(totalSellFeesLedgerEl, 0);
        // Keep table height stable with placeholder rows
        for (let i = 0; i < initialVisibleSells; i++) {
            appendSellEmptyRow(i + 1);
        }
        updateSellRowsVisibility();
        return;
    }

    // Calculate Average Buy Price to verify Realized PnL
    const initialEntryPrice = parseFloat(data.initialEntryPrice) || 0;
    const initialAmountDollars = parseFloat(data.initialAmountDollars) || 0;
    let totalBuyQty = (initialEntryPrice > 0) ? initialAmountDollars / initialEntryPrice : 0;
    let totalBuyInvested = initialAmountDollars;

    if (data.repurchases) {
        data.repurchases.forEach(rp => {
            const rPrice = parseFloat(rp.price) || 0;
            const rAmount = parseFloat(rp.amount) || 0;
            if (rPrice > 0 && rAmount > 0) {
                totalBuyQty += rAmount / rPrice;
                totalBuyInvested += rAmount;
            }
        });
    }
    const avgBuyPrice = totalBuyQty > 0 ? totalBuyInvested / totalBuyQty : 0;
    let cumulativeSoldQty = 0;

    // Render rows in ledger order (oldest to newest)
    [...data.sells].forEach((sell, index) => {
        const originalIndex = index;

        const qty = parseFloat(sell.qty) || 0;
        const price = parseFloat(sell.price) || 0;
        const sellTotal = qty * price;
        const sellFee = sellTotal * activeFeeRate;
        const savedAvgCost = parseFloat(sell.avgCostAtSell) || 0;
        const avgCostAtSell = savedAvgCost > 0 ? savedAvgCost : avgBuyPrice;
        const costBasisTotal = qty * avgCostAtSell;
        const realizedPnL = sellTotal - costBasisTotal;
        const pnlPercent = costBasisTotal > 0 ? (realizedPnL / costBasisTotal) * 100 : 0;
        const pnlClass = realizedPnL > 0 ? 'pnl-positive' : (realizedPnL < 0 ? 'pnl-negative' : 'pnl-neutral');
        totalSellFeesLedger += sellFee;
        cumulativeSoldQty += qty;
        const remainingQtyAfterSell = Math.max(totalBuyQty - cumulativeSoldQty, 0);

        const dateObj = sell.time ? new Date(sell.time) : null;
        const dateTimeTitle = dateObj
            ? `${dateObj.toLocaleDateString('en-US')} ${dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
            : '-';

        const sellDateCellContent = dateObj
            ? formatDateTime(dateObj, originalIndex + 1, 'sell')
            : `<button onclick="editSellTime(${originalIndex + 1})" class="add-time-btn">إضافة وقت</button>`;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${originalIndex + 1}</td>
            <td><div class="output-field ltr-text">${formatNumber(qty, 6)}</div></td>
            <td><div class="output-field ltr-text">$ ${formatNumber(price, guessDecimalPlaces(price))}</div></td>
            <td><div class="output-field ltr-text">$ ${formatNumber(avgCostAtSell, guessDecimalPlaces(avgCostAtSell))}</div></td>
            <td><div class="output-field ltr-text">$ ${formatNumber(costBasisTotal, 2)}</div></td>
            <td><div class="output-field ltr-text">$ ${formatNumber(sellTotal, 2)}</div></td>
            <td><div class="output-field repurchase-pnl ltr-text ${pnlClass}">$ ${formatNumber(realizedPnL, 2)}</div></td>
            <td><div class="output-field repurchase-pnl-percent ltr-text ${pnlClass}">${formatNumber(pnlPercent, 2)} %</div></td>
            <td><div class="output-field ltr-text">${formatNumber(remainingQtyAfterSell, 6)}</div></td>
            <td><div class="output-field repurchase-fee ltr-text">$ ${formatNumber(sellFee, 4)}</div></td>
            <td><div class="repurchase-datetime" id="sellDateTime${originalIndex + 1}" title="${dateTimeTitle}">${sellDateCellContent}</div></td>
        `;
        tableBody.appendChild(row);
    });

    // Keep at least N visible rows even when sells are fewer.
    const rowsToFill = Math.max(initialVisibleSells - data.sells.length, 0);
    for (let i = 0; i < rowsToFill; i++) {
        appendSellEmptyRow(data.sells.length + i + 1);
    }

    // Add immutable ledger badge after table is populated
    addImmutableLedgerBadge();
    setTableFeesSummaryValue(totalSellFeesLedgerEl, totalSellFeesLedger);
    updateSellRowsVisibility();
}

function addImmutableLedgerBadge() {
    // Find the sell section header (h2 or h3 containing sell-related text)
    const headers = document.querySelectorAll('h2, h3');
    let sellHeader = null;

    headers.forEach(header => {
        const text = header.textContent;
        if (text.includes('البيع') || text.includes('جني الأرباح') || text.includes('Sell')) {
            sellHeader = header;
        }
    });

    if (!sellHeader) return;

    if (!sellHeader.querySelector('.immutable-badge')) {
        // Add badge to header
        const badge = document.createElement('span');
        badge.className = 'immutable-badge';
        badge.innerHTML = '<i class="fas fa-lock"></i> نهائي';
        badge.title = 'هذا السجل غير قابل للحذف أو التعديل للحفاظ على دقة الحسابات';
        sellHeader.appendChild(badge);
    }

    // Remove old immutable note if it exists
    const sellSection = sellHeader.closest('section');
    const immutableNotes = sellSection?.querySelectorAll('.immutable-note');
    if (immutableNotes && immutableNotes.length) {
        immutableNotes.forEach(note => note.remove());
    }
}

function setRefreshButtonLoading(isLoading) {
    const refreshPriceBtn = document.getElementById('refreshPriceBtn');
    if (!refreshPriceBtn) return;

    if (isLoading) {
        if (refreshPriceBtn.dataset.loading === '1') return;
        refreshPriceBtn.dataset.loading = '1';
        refreshPriceBtn.dataset.originalHtml = refreshPriceBtn.innerHTML;
        refreshPriceBtn.disabled = true;
        refreshPriceBtn.innerHTML = '<i class="fas fa-spinner fa-spin ml-2" aria-hidden="true"></i> جاري التحديث';
        return;
    }

    if (refreshPriceBtn.dataset.loading !== '1') return;
    refreshPriceBtn.innerHTML = refreshPriceBtn.dataset.originalHtml || '<i class="fas fa-sync-alt ml-2" aria-hidden="true"></i> تحديث';
    delete refreshPriceBtn.dataset.originalHtml;
    delete refreshPriceBtn.dataset.loading;
    refreshPriceBtn.disabled = !!selectCoinsMode;
}

async function runWithConcurrency(items, limit, worker) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const finalLimit = Math.max(1, Math.min(limit || 1, items.length));
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runner() {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= items.length) break;

            const item = items[currentIndex];
            try {
                const value = await worker(item);
                results[currentIndex] = { status: 'fulfilled', value, item };
            } catch (error) {
                results[currentIndex] = { status: 'rejected', reason: error, item };
            }
        }
    }

    const workers = Array.from({ length: finalLimit }, () => runner());
    await Promise.all(workers);
    return results;
}

function splitTradingPairSymbol(symbol) {
    const parsed = parsePair(symbol);
    return {
        base: parsed.base || '',
        quote: parsed.quote || ''
    };
}

function getDisplayTradingSymbol(symbol, hideQuoteSuffix = false) {
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!normalized || !hideQuoteSuffix) return normalized;

    const pair = splitTradingPairSymbol(normalized);
    if (pair.base && pair.quote) {
        return pair.base;
    }

    return normalized;
}

function normalizeInput(raw) {
    return String(raw || '')
        .trim()
        .replace(/\s+/g, '')
        .toUpperCase();
}

function parsePair(raw) {
    const normalizedInput = normalizeInput(raw);
    const parsed = {
        raw: String(raw || ''),
        normalizedInput,
        base: '',
        quote: '',
        exchangeSymbol: '',
        displayPair: ''
    };

    if (!normalizedInput) return parsed;

    if (normalizedInput.includes('/')) {
        const parts = normalizedInput.split('/');
        if (parts.length !== 2) return parsed;

        parsed.base = parts[0];
        parsed.quote = parts[1];
    } else {
        const matchedQuote = SUPPORTED_PAIR_QUOTES.find((quote) => (
            normalizedInput.endsWith(quote) && normalizedInput.length > quote.length
        ));

        if (!matchedQuote) {
            parsed.base = normalizedInput;
            return parsed;
        }

        parsed.base = normalizedInput.slice(0, -matchedQuote.length);
        parsed.quote = matchedQuote;
    }

    if (parsed.base && parsed.quote) {
        parsed.exchangeSymbol = `${parsed.base}${parsed.quote}`;
        parsed.displayPair = `${parsed.base}/${parsed.quote}`;
    }

    return parsed;
}

function validatePair(parsed) {
    const fullPairRequiredMessage = 'يجب إدخال زوج تداول كامل مثل XRP/USDT أو XRPUSDC أو BTC/ETH';
    if (!parsed || !parsed.normalizedInput) {
        return { valid: false, message: fullPairRequiredMessage, code: 'missing_input' };
    }

    if (!parsed.base || !parsed.quote || !parsed.exchangeSymbol) {
        return { valid: false, message: fullPairRequiredMessage, code: 'missing_parts' };
    }

    if (!/^[A-Z0-9]{2,20}$/.test(parsed.base) || !/^[A-Z0-9]{2,10}$/.test(parsed.quote)) {
        return { valid: false, message: `رمز الزوج "${parsed.normalizedInput}" غير صالح.`, code: 'invalid_format' };
    }

    if (!SUPPORTED_PAIR_QUOTES.includes(parsed.quote)) {
        return {
            valid: false,
            message: `عملة التسعير ${parsed.quote} غير مدعومة. المدعوم: ${SUPPORTED_PAIR_QUOTES.join(', ')}`,
            code: 'unsupported_quote'
        };
    }

    return { valid: true, message: '', code: 'ok' };
}

function getPairSuggestions(baseAsset, currentQuote) {
    if (!baseAsset) return [];

    const preferredQuotes = REQUIRED_PAIR_QUOTES.filter((quote) => SUPPORTED_PAIR_QUOTES.includes(quote));
    const candidateQuotes = preferredQuotes.length > 0 ? preferredQuotes : SUPPORTED_PAIR_QUOTES;

    return candidateQuotes
        .filter((quote) => quote !== currentQuote)
        .slice(0, 4)
        .map((quote) => `${baseAsset}/${quote}`);
}

function readPriceCacheMap() {
    try {
        const raw = localStorage.getItem(LS_KEY_PRICE_CACHE);
        if (!raw) return {};

        const parsed = JSON.parse(raw);
        const source = parsed?.prices && typeof parsed.prices === 'object'
            ? parsed.prices
            : (parsed && typeof parsed === 'object' ? parsed : {});

        const normalized = {};
        Object.keys(source).forEach((symbol) => {
            const price = Number.parseFloat(source[symbol]);
            if (Number.isFinite(price)) {
                normalized[symbol] = price;
            }
        });

        return normalized;
    } catch (error) {
        return {};
    }
}

function writePriceCacheMap() {
    try {
        const prices = {};
        Object.keys(currentMarketPrices).forEach((symbol) => {
            const price = Number.parseFloat(currentMarketPrices[symbol]);
            if (Number.isFinite(price)) {
                prices[symbol] = price;
            }
        });

        localStorage.setItem(LS_KEY_PRICE_CACHE, JSON.stringify({
            timestamp: Date.now(),
            prices
        }));
    } catch (error) {
        console.warn('Price cache save failed:', error);
    }
}

function restorePricesFromCacheForSymbols(symbols, cacheMap = null) {
    const source = cacheMap || readPriceCacheMap();
    if (!source || typeof source !== 'object') return 0;

    let restoredCount = 0;
    symbols.forEach((symbol) => {
        const current = Number.parseFloat(currentMarketPrices[symbol]);
        if (Number.isFinite(current)) return;

        const cached = Number.parseFloat(source[symbol]);
        if (!Number.isFinite(cached)) return;

        currentMarketPrices[symbol] = cached;
        restoredCount += 1;
    });

    return restoredCount;
}

async function fetchBinanceBulkPrices(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return {};

    const normalizedSymbols = Array.from(
        new Set(
            symbols
                .map((symbol) => String(symbol || '').trim().toUpperCase())
                .filter(Boolean)
        )
    );
    if (!normalizedSymbols.length) return {};

    const wanted = new Set(normalizedSymbols);
    const symbolsParam = encodeURIComponent(JSON.stringify(normalizedSymbols));
    const urlsToTry = [];

    BINANCE_SPOT_PRICE_ENDPOINTS.forEach((endpoint) => {
        urlsToTry.push(`${endpoint}?symbols=${symbolsParam}`);
        urlsToTry.push(endpoint);
    });

    const bulkTimeout = Math.max(RETRY_CONFIG.TIMEOUT, 9000);

    for (const url of urlsToTry) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const response = await fetch(url, {
                    signal: AbortSignal.timeout(bulkTimeout),
                    cache: 'no-store'
                });
                if (!response.ok) continue;

                const payload = await response.json();
                if (
                    payload &&
                    !Array.isArray(payload) &&
                    typeof payload === 'object' &&
                    payload.code &&
                    payload.msg
                ) {
                    break;
                }

                const entries = Array.isArray(payload) ? payload : [payload];
                if (!entries.length) continue;

                const priceMap = {};
                entries.forEach((entry) => {
                    const symbol = String(entry?.symbol || '').toUpperCase();
                    const numericPrice = Number.parseFloat(entry?.price);
                    if (!wanted.has(symbol) || !Number.isFinite(numericPrice)) return;
                    priceMap[symbol] = numericPrice;
                });

                if (Object.keys(priceMap).length > 0) {
                    return priceMap;
                }
            } catch (error) {
                // Move to a lightweight retry before switching endpoint.
            }

            if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, 140));
            }
        }
    }

    return {};
}



async function fetchSinglePrice(symbol) {
    const parsedInput = parsePair(symbol);
    const exchangeSymbol = parsedInput.exchangeSymbol || normalizeInput(symbol).replace(/\//g, '');

    if (!exchangeSymbol) {
        return { symbol: symbol, price: null, source: null, error: 'رمز غير صالح' };
    }

    let price = null;
    let source = '';
    let error = null;


    const fetchWithTimeout = (url, options = {}) =>
        fetch(url, { ...options, signal: AbortSignal.timeout(RETRY_CONFIG.TIMEOUT) });


    for (const endpoint of BINANCE_SPOT_PRICE_ENDPOINTS) {
        try {
            const binanceApiUrl = `${endpoint}?symbol=${exchangeSymbol}`;
            const response = await fetchWithTimeout(binanceApiUrl);
            if (response.ok) {
                const data = await response.json();
                if (data && data.price && !isNaN(parseFloat(data.price))) {
                    price = parseFloat(data.price);
                    source = 'Binance';
                    console.log(`[OK] Binance: ${exchangeSymbol} = ${price}`);
                    return { symbol: exchangeSymbol, price: price, source: source, error: null };
                }
            }
        } catch (e) { }
    }

    const pair = splitTradingPairSymbol(exchangeSymbol);
    const baseAsset = pair.base;
    const quoteAsset = pair.quote;


    if (price === null) {
        try {
            const kucoinSymbol = baseAsset && quoteAsset ? `${baseAsset}-${quoteAsset}` : exchangeSymbol;
            const kucoinApiUrl = `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${kucoinSymbol}`;
            const kucoinResponse = await fetchWithTimeout(kucoinApiUrl);
            if (kucoinResponse.ok) {
                const kucoinData = await kucoinResponse.json();
                if (kucoinData.code === '200000' && kucoinData.data && kucoinData.data.price && !isNaN(parseFloat(kucoinData.data.price))) {
                    price = parseFloat(kucoinData.data.price);
                    source = 'KuCoin';
                    console.log(`[OK] KuCoin: ${exchangeSymbol} = ${price}`);
                    return { symbol: exchangeSymbol, price: price, source: source, error: null };
                }
            }
        } catch (e) { }
    }


    if (price === null) {
        const symbolLower = exchangeSymbol.toLowerCase();
        const baseLower = (baseAsset || exchangeSymbol).toLowerCase();
        const coinGeckoIds = Array.from(new Set([
            symbolLower,
            baseLower,
            symbolLower.replace('usdt', ''),
            symbolLower.replace('usdc', ''),
            symbolLower.replace('busd', '')
        ]));

        for (const coinId of coinGeckoIds) {
            if (price !== null) break;
            try {
                const coinGeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
                const geckoResponse = await fetchWithTimeout(coinGeckoUrl);
                if (geckoResponse.ok) {
                    const geckoData = await geckoResponse.json();
                    const coinData = geckoData[coinId];
                    if (coinData && coinData.usd && !isNaN(parseFloat(coinData.usd))) {
                        price = parseFloat(coinData.usd);
                        source = 'CoinGecko';
                        console.log(`[OK] CoinGecko: ${exchangeSymbol} = ${price}`);
                        return { symbol: exchangeSymbol, price: price, source: source, error: null };
                    }
                }
            } catch (e) { }
        }
    }


    if (price === null) {
        try {
            const krakenSymbol = exchangeSymbol.replace('USDT', '').toUpperCase();
            const krakenUrl = `https://api.kraken.com/0/public/Ticker?pair=${krakenSymbol}USD`;
            const krakenResponse = await fetchWithTimeout(krakenUrl);
            if (krakenResponse.ok) {
                const krakenData = await krakenResponse.json();
                if (krakenData.result) {
                    const firstKey = Object.keys(krakenData.result)[0];
                    if (firstKey && krakenData.result[firstKey].c && krakenData.result[firstKey].c[0]) {
                        price = parseFloat(krakenData.result[firstKey].c[0]);
                        source = 'Kraken';
                        console.log(`[OK] Kraken: ${exchangeSymbol} = ${price}`);
                        return { symbol: exchangeSymbol, price: price, source: source, error: null };
                    }
                }
            }
        } catch (e) { }
    }


    if (price === null) {
        try {
            const bybitSymbol = baseAsset && quoteAsset ? `${baseAsset}${quoteAsset}` : exchangeSymbol;
            const bybitUrl = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${bybitSymbol}`;
            const bybitResponse = await fetchWithTimeout(bybitUrl);
            if (bybitResponse.ok) {
                const bybitData = await bybitResponse.json();
                if (bybitData.result && bybitData.result.list && bybitData.result.list[0]) {
                    const lastPrice = bybitData.result.list[0].lastPrice;
                    if (lastPrice && !isNaN(parseFloat(lastPrice))) {
                        price = parseFloat(lastPrice);
                        source = 'Bybit';
                        console.log(`[OK] Bybit: ${exchangeSymbol} = ${price}`);
                        return { symbol: exchangeSymbol, price: price, source: source, error: null };
                    }
                }
            }
        } catch (e) { }
    }


    if (price === null) {
        try {
            const okxInstId = baseAsset && quoteAsset ? `${baseAsset}-${quoteAsset}` : exchangeSymbol;
            const okxUrl = `https://www.okx.com/api/v5/market/ticker?instId=${okxInstId}`;
            const okxResponse = await fetchWithTimeout(okxUrl);
            if (okxResponse.ok) {
                const okxData = await okxResponse.json();
                if (okxData.data && okxData.data[0] && okxData.data[0].last) {
                    price = parseFloat(okxData.data[0].last);
                    source = 'OKX';
                    console.log(`[OK] OKX: ${exchangeSymbol} = ${price}`);
                    return { symbol: exchangeSymbol, price: price, source: source, error: null };
                }
            }
        } catch (e) { }
    }


    error = 'فشل جلب السعر من جميع المصادر';
    console.error(`[ERROR] Failed to fetch price for ${exchangeSymbol} from all sources.`);
    return { symbol: exchangeSymbol, price: null, source: null, error: error };
}


async function fetchAllPrices(isAutoRefresh = false) {
    if (activePriceFetchPromise) {
        if (!isAutoRefresh) {
            const firstQueueRequest = !pendingManualRefreshRequest;
            pendingManualRefreshRequest = true;
            if (firstQueueRequest) {
                apiStatusDiv.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> يوجد تحديث جارٍ... سيتم إعادة التحديث بعد الانتهاء';
                setApiStatusColor("var(--warning-color)");
                showToast('يوجد تحديث جارٍ، سيتم تنفيذ التحديث اليدوي بعد الانتهاء.', 'info', 2400);
            }
        }
        return activePriceFetchPromise;
    }

    const runFetch = (async () => {
        const trackedSymbols = Object.keys(allCoinData);
        if (trackedSymbols.length === 0) {
            if (!isAutoRefresh) {
                apiStatusDiv.textContent = "لا توجد عملات للمراقبة.";
                setApiStatusColor("var(--text-muted)");
                summaryTableBody.innerHTML =
                    `<tr><td colspan="${SUMMARY_TABLE_COLUMN_COUNT}" style="text-align:center; padding: 30px; font-weight: normal; color: var(--text-muted);"><i class="fas fa-plus-circle"></i> أضف عملة للبدء.</td></tr>`;
                resetTotals();
            }
            return;
        }

        const hadCachedPrices = trackedSymbols.some((symbol) => {
            const current = Number.parseFloat(currentMarketPrices[symbol]);
            return Number.isFinite(current);
        });

        if (!isAutoRefresh) {
            setRefreshButtonLoading(true);
            showUpdateModal();
            apiStatusDiv.textContent = `جاري جلب أسعار ${trackedSymbols.length} عملة...`;
            setApiStatusColor("var(--primary-color)");
        }

        try {
            let successCount = 0;
            let failCount = 0;
            let restoredFromCacheCount = 0;
            const priceCacheMap = readPriceCacheMap();
            const unresolvedSet = new Set();

            // Step 1: single bulk request to Binance (reduces request bursts and rate-limit issues)
            const bulkPrices = await fetchBinanceBulkPrices(trackedSymbols);
            trackedSymbols.forEach((symbol) => {
                const bulkPrice = Number.parseFloat(bulkPrices[symbol]);
                if (Number.isFinite(bulkPrice)) {
                    currentMarketPrices[symbol] = bulkPrice;
                } else {
                    unresolvedSet.add(symbol);
                }
            });

            const applyFallbackResults = (results) => {
                results.forEach((result) => {
                    if (result.status === 'fulfilled') {
                        const payload = result.value;
                        const symbol = payload?.symbol || result.item;
                        const price = Number.parseFloat(payload?.price);
                        if (payload?.error === null && Number.isFinite(price)) {
                            currentMarketPrices[symbol] = price;
                            unresolvedSet.delete(symbol);
                            return;
                        }

                        if (currentMarketPrices[symbol] === undefined) {
                            currentMarketPrices[symbol] = null;
                        }
                        console.error(`Price fetch logic error for ${symbol}: ${payload?.error || "No price"}`);
                        return;
                    }

                    const symbol = result.item;
                    if (currentMarketPrices[symbol] === undefined) {
                        currentMarketPrices[symbol] = null;
                    }
                    console.error(`Promise rejected for symbol fetch ${symbol}:`, result.reason);
                });
            };

            // Step 2: fallback per-symbol fetch with limited concurrency
            const retryBudget = isAutoRefresh ? 1 : 2;
            const firstPassSymbols = Array.from(unresolvedSet);
            const fallbackResults = await runWithConcurrency(
                firstPassSymbols,
                PRICE_FETCH_CONCURRENCY,
                (symbol) => retryWithBackoff(() => fetchSinglePrice(symbol), symbol, retryBudget)
            );
            applyFallbackResults(fallbackResults);

            // Step 3: extra manual pass for stubborn symbols after hard refresh
            if (!isAutoRefresh && unresolvedSet.size > 0) {
                await new Promise((resolve) => setTimeout(resolve, 220));
                const secondPassSymbols = Array.from(unresolvedSet);
                const secondPassResults = await runWithConcurrency(
                    secondPassSymbols,
                    Math.max(1, PRICE_FETCH_CONCURRENCY - 1),
                    (symbol) => retryWithBackoff(() => fetchSinglePrice(symbol), `${symbol}-pass2`, 1)
                );
                applyFallbackResults(secondPassResults);
            }

            // Step 4: restore any remaining failed symbols from persisted cache to avoid empty price cells
            if (unresolvedSet.size > 0) {
                const unresolvedSymbols = Array.from(unresolvedSet);
                restoredFromCacheCount = restorePricesFromCacheForSymbols(unresolvedSymbols, priceCacheMap);
                unresolvedSymbols.forEach((symbol) => {
                    const currentPrice = Number.parseFloat(currentMarketPrices[symbol]);
                    if (Number.isFinite(currentPrice)) {
                        unresolvedSet.delete(symbol);
                    } else if (currentMarketPrices[symbol] === undefined) {
                        currentMarketPrices[symbol] = null;
                    }
                });
            }

            successCount = trackedSymbols.reduce((count, symbol) => {
                const price = Number.parseFloat(currentMarketPrices[symbol]);
                return Number.isFinite(price) ? count + 1 : count;
            }, 0);
            failCount = Math.max(0, trackedSymbols.length - successCount);

            if (successCount > 0) {
                writePriceCacheMap();
            }

            if (activeCoinSymbol) {
                const price = currentMarketPrices[activeCoinSymbol];
                if (price !== null && price !== undefined && !isNaN(price)) {
                    marketPriceDisplay.textContent = '$ ' + formatPriceWithZeroCount(price);
                    marketPriceDisplay.title = '$ ' + formatPriceFull(price);
                    marketPriceDisplay.classList.remove("error");
                } else {
                    marketPriceDisplay.removeAttribute('title');
                    marketPriceDisplay.textContent = "غير متوفر";
                    marketPriceDisplay.classList.add("error");
                }
            }

            calculateActiveCoinDetails();
            updateSummaryTable();
            updatePortfolioStats();

            const totalCount = trackedSymbols.length;
            const cacheNote = restoredFromCacheCount > 0 ? ` | ${restoredFromCacheCount} من الكاش` : '';
            const statusMsg = `${successCount}/${totalCount} عملة (${failCount} فشل)${cacheNote}`;
            apiStatusDiv.innerHTML = isAutoRefresh
                ? `التحديث التلقائي مفعل: ${statusMsg}`
                : `<i class="fas fa-circle-check" aria-hidden="true"></i> تم تحديث: ${statusMsg}`;
            setApiStatusColor(
                failCount > 0 ? "var(--negative-color)" : "var(--positive-color)"
            );

            if (!isAutoRefresh) {
                if (failCount === 0) {
                    if (restoredFromCacheCount > 0) {
                        showToast(`تم استعادة ${restoredFromCacheCount} سعر من الكاش أثناء التحديث`, 'info', 3200);
                    } else {
                        showToast(`تم تحديث ${successCount} عملة بنجاح`, 'success', 3000);
                    }
                } else if (successCount > 0) {
                    if (restoredFromCacheCount > 0) {
                        showToast(`تم تحديث جزئيًا: ${successCount} متاحة، ${failCount} فشلت (${restoredFromCacheCount} من الكاش)`, 'warning', 4200);
                    } else {
                        showToast(`تم تحديث ${successCount} عملة بنجاح، ${failCount} فشلت مؤقتًا`, 'warning', 4000);
                    }
                } else if (hadCachedPrices) {
                    showToast('فشل التحديث الحالي، تم الاحتفاظ بآخر أسعار متاحة.', 'warning', 4200);
                } else {
                    showToast('فشل تحديث الأسعار حاليًا، حاول مرة أخرى خلال ثوانٍ.', 'error', 5000);
                }
            }

            if (!isAutoRefresh) hideUpdateModal();

            if (autoRefreshCheckbox.checked && !autoRefreshIntervalId) {
                startAutoRefresh();
            }

        } catch (error) {
            if (!isAutoRefresh) hideUpdateModal();
            console.error("Unexpected error during fetchAllPrices:", error);
            if (!isAutoRefresh) {
                apiStatusDiv.innerHTML = '<i class="fas fa-circle-exclamation" aria-hidden="true"></i> خطأ عام أثناء تحديث الأسعار.';
                setApiStatusColor("var(--negative-color)");
            }
            stopAutoRefresh();
            updateSummaryTable();
        } finally {
            if (!isAutoRefresh) {
                setRefreshButtonLoading(false);
            }
        }
    })();

    activePriceFetchPromise = runFetch;
    try {
        return await runFetch;
    } finally {
        activePriceFetchPromise = null;

        if (pendingManualRefreshRequest) {
            pendingManualRefreshRequest = false;
            setTimeout(() => {
                fetchAllPrices(false);
            }, 180);
        }
    }
}


function calculateSummaryData() {
    const summaryData = []; const coinSymbols = Object.keys(allCoinData);
    let grandTotalInvested = 0;
    let grandTotalCurrentValue = 0;
    let grandTotalPnlAmount = 0;
    let grandTotalFees = 0;

    coinSymbols.forEach(symbol => {
        const data = allCoinData[symbol]; if (!data) return;
        const marketPrice = currentMarketPrices[symbol];
        const initialEntryPrice = parseFloat(data.initialEntryPrice) || 0;
        const initialAmountDollars = parseFloat(data.initialAmountDollars) || 0;
        let totalCoinQty = 0; let totalInvestedAmount = 0; let errorMsg = null;
        if (initialEntryPrice > 0 && initialAmountDollars > 0) {
            totalCoinQty = initialAmountDollars / initialEntryPrice; totalInvestedAmount = initialAmountDollars;
        } else if (initialAmountDollars > 0 && initialEntryPrice <= 0) { errorMsg = "سعر الدخول الأولي مفقود"; }
        if (data.repurchases) {
            data.repurchases.forEach(rp => {
                const rpPrice = parseFloat(rp.price) || 0; const rpAmount = parseFloat(rp.amount) || 0;
                if (rpPrice > 0 && rpAmount > 0) {
                    totalCoinQty += rpAmount / rpPrice; totalInvestedAmount += rpAmount;
                } else if (rpAmount > 0 && rpPrice <= 0) { if (!errorMsg) errorMsg = "سعر تعزيز مفقود"; }
            });
        }
        const averageEntryPrice = totalCoinQty > 0 ? totalInvestedAmount / totalCoinQty : 0;

        // --- Calculate Sells ---
        const sells = getCurrentCycleSells(data);
        let totalSellQty = 0;
        let totalRealizedPnL = 0;
        let totalSellAmountUSD = 0;
        sells.forEach(s => {
            const sq = parseFloat(s.qty) || 0;
            const sp = parseFloat(s.price) || 0;
            if (sq > 0) {
                totalSellQty += sq;
                if (sp > 0) totalSellAmountUSD += sq * sp;
                if (sp > 0) totalRealizedPnL += (sp - averageEntryPrice) * sq;
            }
        });

        const remainingQty = Math.max(0, totalCoinQty - totalSellQty);
        const remainingInvestedAmount = remainingQty * averageEntryPrice;
        const totalBuyAmountUSD = totalInvestedAmount;

        let fees = {
            buyAmountUSD: totalBuyAmountUSD,
            sellAmountUSD: totalSellAmountUSD,
            feeRate: 0,
            buyFee: 0,
            sellFee: 0,
            totalFees: 0,
            makerRate: 0,
            takerRate: 0,
            rateType: 'taker',
            sourceUrl: '',
            verifiedAt: '',
            exchangeId: '',
            exchangeName: '',
            countryCode: ''
        };

        if (window.spotFeeCalculatorService?.calculateWithActiveProfile) {
            fees = window.spotFeeCalculatorService.calculateWithActiveProfile({
                buyAmountUSD: totalBuyAmountUSD,
                sellAmountUSD: totalSellAmountUSD
            });
        }

        let currentPortfolioValue = 0;
        let grossPnlAmount = 0;
        let pnlAmount = 0;
        let pnlPercent = 0;

        if (marketPrice === null || marketPrice === undefined) { if (!errorMsg) errorMsg = "لم يتم جلب السعر"; }
        else if (errorMsg) { grossPnlAmount = NaN; pnlAmount = NaN; pnlPercent = NaN; currentPortfolioValue = NaN; }
        else {
            currentPortfolioValue = remainingQty * marketPrice;
            grossPnlAmount = currentPortfolioValue - remainingInvestedAmount;
            pnlAmount = grossPnlAmount - (parseFloat(fees.totalFees) || 0);
            pnlPercent = remainingInvestedAmount > 0 ? (pnlAmount / remainingInvestedAmount) * 100 : 0;
        }

        if (!isNaN(pnlAmount) && remainingInvestedAmount >= 0 && !isNaN(currentPortfolioValue)) {
            grandTotalInvested += remainingInvestedAmount;
            grandTotalCurrentValue += currentPortfolioValue;
            grandTotalPnlAmount += pnlAmount;
            grandTotalFees += parseFloat(fees.totalFees) || 0;
        }

        summaryData.push({
            symbol,
            totalCoinQty: remainingQty, // Show Remaining
            totalInvestedAmount: remainingInvestedAmount, // Show Remaining Invested
            averageEntryPrice,
            marketPrice,
            currentPortfolioValue,
            pnlAmount,
            pnlPercent,
            grossPnlAmount,
            fees,
            error: errorMsg
        });
    });
    summaryData.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const grandTotalPnlPercent = grandTotalInvested > 0 ? (grandTotalPnlAmount / grandTotalInvested) * 100 : 0;
    return {
        summaryRows: summaryData,
        totals: {
            invested: grandTotalInvested,
            pnlAmount: grandTotalPnlAmount,
            currentValue: grandTotalCurrentValue,
            pnlPercent: grandTotalPnlPercent,
            fees: grandTotalFees
        }
    };
}


// Helper: Format display values for a coin
function syncPriceBadgesWidth() {
    const badges = Array.from(document.querySelectorAll('.price-badge'));
    if (!badges.length) return;

    badges.forEach((badge) => {
        badge.style.width = 'auto';
    });

    let maxWidth = 0;
    badges.forEach((badge) => {
        const badgeWidth = badge.getBoundingClientRect().width;
        if (badgeWidth > maxWidth) {
            maxWidth = badgeWidth;
        }
    });

    const normalizedWidth = Math.ceil(maxWidth);
    if (normalizedWidth <= 0) return;

    badges.forEach((badge) => {
        badge.style.width = `${normalizedWidth}px`;
    });
}

function schedulePriceBadgesWidthSync() {
    requestAnimationFrame(syncPriceBadgesWidth);
}

function handlePriceBadgesResize() {
    clearTimeout(priceBadgesResizeDebounceTimer);
    priceBadgesResizeDebounceTimer = setTimeout(() => {
        syncPriceBadgesWidth();
    }, 120);
}

function initPriceBadgesWidthSync() {
    if (isPriceBadgesWidthSyncInitialized) return;
    isPriceBadgesWidthSyncInitialized = true;

    syncPriceBadgesWidth();
    window.addEventListener('resize', handlePriceBadgesResize);
}

function formatCoinDisplayValues(item) {
    const marketPriceValid = isValidPriceValue(item.marketPrice);
    const avgPriceValid = !isNaN(item.averageEntryPrice) && item.averageEntryPrice > 0;
    const portfolioValueValid = !isNaN(item.currentPortfolioValue);
    const pnlAmountValid = !isNaN(item.pnlAmount);
    const pnlPercentValid = !isNaN(item.pnlPercent);
    const smartMarketPrice = marketPriceValid ? formatPriceWithZeroCount(item.marketPrice) : '--';
    const fullMarketPrice = marketPriceValid ? formatPriceFull(item.marketPrice) : '--';

    return {
        displayPrice: marketPriceValid ? `$ ${smartMarketPrice}` : '--',
        displayPriceTitle: marketPriceValid ? `$ ${fullMarketPrice}` : '--',
        displayAvgPrice: avgPriceValid ? '$ ' + formatNumber(item.averageEntryPrice, guessDecimalPlaces(item.averageEntryPrice)) : (item.totalInvestedAmount > 0 ? '<span class="error">خطأ</span>' : '0.00'),
        displayPortfolioValue: marketPriceValid && portfolioValueValid ? '$ ' + formatNumber(item.currentPortfolioValue, 2) : (item.error ? '-' : '0.00'),
        displayPnlAmount: marketPriceValid && pnlAmountValid ? '$ ' + formatNumber(item.pnlAmount, 2) : (item.error ? '-' : '0.00'),
        displayQuantity: !isNaN(item.totalCoinQty) ? formatNumber(item.totalCoinQty, 7) : '<span class="error">خطأ</span>',
        displayInvested: !isNaN(item.totalInvestedAmount) ? '$ ' + formatNumber(item.totalInvestedAmount, 2) : '<span class="error">خطأ</span>',
        marketPriceValid,
        pnlAmountValid,
        pnlPercentValid
    };
}

// Helper: Get PnL pill class and icon
function getPnlPillData(item, pnlPercentValid) {
    let pnlPillClass = 'neutral';
    let pnlIcon = '';

    if (pnlPercentValid && item.totalInvestedAmount > 0) {
        if (item.pnlPercent > 0) {
            pnlPillClass = 'positive';
            pnlIcon = '<i class="fas fa-caret-up"></i>';
        } else if (item.pnlPercent < 0) {
            pnlPillClass = 'negative';
            pnlIcon = '<i class="fas fa-caret-down"></i>';
        }
    }

    return { pnlPillClass, pnlIcon };
}

// Helper: Get price flash class and icon
function getPriceFlashData(item, marketPriceValid) {
    let priceClass = '';
    let priceIcon = '';

    if (marketPriceValid) {
        const current = parseFloat(item.marketPrice);
        const prev = previousPrices[item.symbol];

        if (prev !== undefined && prev !== null) {
            if (current > prev) {
                priceClass = 'price-up';
                priceIcon = '<i class="fas fa-caret-up"></i> ';
                console.log(`[UP] Price UP: ${item.symbol} (${prev} -> ${current})`);
            } else if (current < prev) {
                priceClass = 'price-down';
                priceIcon = '<i class="fas fa-caret-down"></i> ';
                console.log(`[DOWN] Price DOWN: ${item.symbol} (${prev} -> ${current})`);
            }
        }
        previousPrices[item.symbol] = current;
    }

    return { priceClass, priceIcon };
}

// Helper: Create table row HTML
function createSummaryTableRow(item) {
    const row = document.createElement('tr');
    const { displayPrice, displayPriceTitle, displayAvgPrice, displayPortfolioValue, displayPnlAmount,
        displayQuantity, displayInvested, marketPriceValid, pnlAmountValid, pnlPercentValid } = formatCoinDisplayValues(item);
    const displaySymbol = getDisplayTradingSymbol(item.symbol, hideUsdtSuffix);

    const { pnlPillClass, pnlIcon } = getPnlPillData(item, pnlPercentValid);
    const { priceClass, priceIcon } = getPriceFlashData(item, marketPriceValid);

    const pnlAmountClass = pnlAmountValid ? (item.pnlAmount > 0 ? 'pnl-positive' : (item.pnlAmount < 0 ? 'pnl-negative' : '')) : '';
    const displayPnlPercent = marketPriceValid && pnlPercentValid && item.totalInvestedAmount > 0
        ? `<span class="pnl-pill ${pnlPillClass}">${pnlIcon} ${formatNumber(Math.abs(item.pnlPercent), 2)} %</span>`
        : (item.error ? '-' : '<span class="pnl-pill neutral">0.00 %</span>');

    const isSelected = selectedCoins.has(item.symbol);
    const selectedClass = isSelected ? 'coin-selected' : '';
    const feesCellHtml = window.spotFeeTableRenderer?.renderFeesCell
        ? window.spotFeeTableRenderer.renderFeesCell(item)
        : `<div class="fees-cell"><span class="fees-total-badge"><em>Fees:</em><strong>$ 0.0000</strong></span></div>`;
    const priceBadgeTitleAttr = marketPriceValid && displayPriceTitle
        ? ` title="${escapeHtml(displayPriceTitle)}"`
        : '';

    row.setAttribute('data-symbol', item.symbol);

    row.innerHTML = `
        <td class="coin-symbol summary-coin-clickable ${selectedClass}" data-symbol="${item.symbol}" title="تنشيط عملة ${item.symbol}">
            <span class="coin-name-wrapper" id="coin-wrapper-${item.symbol}">
                <span class="coin-label">${displaySymbol}</span>
            </span>
        </td>
        <td class="number-col">${displayQuantity}</td>
        <td class="number-col">${displayInvested}</td>
        <td class="number-col">${displayAvgPrice}</td>
        <td class="number-col ${priceClass}" style="white-space: nowrap;"><span class="price-badge"${priceBadgeTitleAttr}>${priceIcon}${displayPrice}</span></td>
        <td class="number-col">${displayPortfolioValue}</td>
        <td class="number-col ${pnlAmountClass}">${displayPnlAmount}</td>
        <td class="number-col">${displayPnlPercent}</td>
        <td class="number-col fees-col">${feesCellHtml}</td>
    `;

    return row;
}

// Helper: Update totals display
function updateTotalsDisplay(totals) {
    totalInvestedSummaryEl.textContent = '$ ' + formatNumber(totals.invested, 2);
    totalPnlAmountSummaryEl.textContent = '$ ' + formatNumber(totals.pnlAmount, 2);
    totalCurrentValueSummaryEl.textContent = '$ ' + formatNumber(totals.currentValue, 2);
    totalInvestedSummaryEl.textContent = '$ ' + formatNumber(totals.invested, 2);
    totalPnlAmountSummaryEl.textContent = '$ ' + formatNumber(totals.pnlAmount, 2);
    totalCurrentValueSummaryEl.textContent = '$ ' + formatNumber(totals.currentValue, 2);
    totalPnlPercentSummaryEl.textContent = formatNumber(totals.pnlPercent, 2) + ' %';

    totalPnlAmountSummaryEl.className = (totals.pnlAmount > 0 ? 'totals-positive' : (totals.pnlAmount < 0 ? 'totals-negative' : '')) + ' ltr-text';
    totalPnlPercentSummaryEl.className = (totals.pnlPercent > 0 ? 'totals-positive' : (totals.pnlPercent < 0 ? 'totals-negative' : '')) + ' ltr-text';
    totalCurrentValueSummaryEl.className = (totals.pnlAmount >= 0 ? 'totals-positive' : 'totals-negative') + ' ltr-text';

    const totalFeesValue = parseFloat(totals.fees) || 0;
    const netPnlTitle = `صافي الربح بعد خصم رسوم التداول (إجمالي الرسوم: $${formatNumber(totalFeesValue, 4)})`;
    totalPnlAmountSummaryEl.title = netPnlTitle;
    totalPnlPercentSummaryEl.title = netPnlTitle;
}

// Main function - now much simpler and cleaner
function updateSummaryTable() {
    const { summaryRows, totals } = calculateSummaryData();
    summaryTableBody.innerHTML = '';

    if (summaryRows.length === 0) {
        summaryTableBody.innerHTML = `<tr><td colspan="${SUMMARY_TABLE_COLUMN_COUNT}" style="text-align:center; padding: 30px; font-weight: normal; color: var(--text-muted);">لا توجد عملات مضافة حالياً.</td></tr>`;
        resetTotals();
        schedulePriceBadgesWidthSync();
        return;
    }

    summaryRows.forEach(item => {
        const row = createSummaryTableRow(item);
        summaryTableBody.appendChild(row);

        // Add coin icon
        const wrapper = document.getElementById(`coin-wrapper-${item.symbol}`);
        if (wrapper) {
            const icon = createTradingPairIcon(item.symbol, 28, 18);
            wrapper.insertBefore(icon, wrapper.firstChild);
        }
    });

    updateTotalsDisplay(totals);
    schedulePriceBadgesWidthSync();
}



function resetTotals() {
    totalInvestedSummaryEl.textContent = `$ 0.00`; totalPnlAmountSummaryEl.textContent = `$ 0.00`;
    totalCurrentValueSummaryEl.textContent = `$ 0.00`; totalPnlPercentSummaryEl.textContent = `0.00 %`;
    totalPnlAmountSummaryEl.className = 'ltr-text'; totalPnlPercentSummaryEl.className = 'ltr-text'; totalCurrentValueSummaryEl.className = 'ltr-text';
    totalPnlAmountSummaryEl.removeAttribute('title');
    totalPnlPercentSummaryEl.removeAttribute('title');
}


function calculateActiveCoinDetails() {
    document.getElementById('initialCoinQty').textContent = formatNumber(0, 8);
    document.getElementById('totalCoinQty').textContent = formatNumber(0, 8);
    document.getElementById('totalInvestedAmount').textContent = '$ ' + formatNumber(0, 2);
    document.getElementById('averageEntryPrice').textContent = '$ ' + formatNumber(0, 8);
    const currentPortfolioValueElement = document.getElementById('currentPortfolioValue');
    currentPortfolioValueElement.textContent = '$ ' + formatNumber(0, 2);
    const pnlAmountElement = document.getElementById('pnlAmount');
    const pnlPercentElement = document.getElementById('pnlPercent');
    pnlAmountElement.textContent = '$ ' + formatNumber(0, 2); pnlPercentElement.textContent = formatNumber(0, 2) + ' %';
    pnlAmountElement.className = 'hero-value pnl-neutral ltr-text'; pnlPercentElement.className = 'hero-value pnl-neutral ltr-text';
    currentPortfolioValueElement.classList.remove('pnl-positive', 'pnl-negative', 'pnl-neutral');
    currentPortfolioValueElement.classList.add('pnl-neutral');
    document.getElementById('tpPrice1').textContent = formatNumber(0, 8);
    document.getElementById('tpPrice2').textContent = formatNumber(0, 8);
    document.getElementById('tpPrice3').textContent = formatNumber(0, 8);
    document.getElementById('slPrice').textContent = formatNumber(0, 8);
    setTableFeesSummaryValue(totalBuyFeesDcaEl, 0);
    setTableFeesSummaryValue(totalSellFeesLedgerEl, 0);

    for (let i = 1; i <= maxRepurchaseEntries; i++) {
        const dpSpan = document.getElementById(`downPercent${i}`);
        const rpQtyDiv = document.getElementById(`repurchaseQty${i}`);
        const rpPnlDiv = document.getElementById(`repurchasePnl${i}`);
        const rpPnlPercentDiv = document.getElementById(`repurchasePnlPercent${i}`);
        const rpBuyFeeDiv = document.getElementById(`repurchaseBuyFee${i}`);
        if (dpSpan) { dpSpan.textContent = '-'; dpSpan.className = 'down-percent'; }
        if (rpQtyDiv) rpQtyDiv.textContent = formatNumber(0, 8);
        if (rpPnlDiv) { rpPnlDiv.textContent = '$ ' + formatNumber(0, 2); rpPnlDiv.className = 'output-field repurchase-pnl ltr-text'; }
        if (rpPnlPercentDiv) { rpPnlPercentDiv.textContent = formatNumber(0, 2) + ' %'; rpPnlPercentDiv.className = 'output-field repurchase-pnl-percent ltr-text'; }
        if (rpBuyFeeDiv) { rpBuyFeeDiv.textContent = '$ ' + formatNumber(0, 4); rpBuyFeeDiv.className = 'output-field repurchase-fee ltr-text'; }
    }
    if (!activeCoinSymbol || !allCoinData[activeCoinSymbol]) return;

    const data = allCoinData[activeCoinSymbol];
    const marketPrice = currentMarketPrices[activeCoinSymbol] || 0;
    const initialEntryPrice = parseFloat(data.initialEntryPrice) || 0;
    const initialAmountDollars = parseFloat(data.initialAmountDollars) || 0;
    const initialCoinQty = initialEntryPrice > 0 ? initialAmountDollars / initialEntryPrice : 0;
    document.getElementById('initialCoinQty').textContent = formatNumber(initialCoinQty, 8);
    let totalCoinQty = initialCoinQty; let totalInvestedAmount = initialAmountDollars;
    const activeFeeRate = getActiveSpotFeeRate();
    let totalBuyFeesDca = 0;

    for (let i = 1; i <= maxRepurchaseEntries; i++) {
        const rpPriceInput = document.getElementById(`repurchasePrice${i}`);
        const rpAmountInput = document.getElementById(`repurchaseAmount${i}`);
        const repurchasePrice = parseFloat(rpPriceInput?.value) || 0;
        const repurchaseAmount = parseFloat(rpAmountInput?.value) || 0;
        let changePercent = 0; let repurchaseQty = 0;
        let pnlForThisRepurchase = 0; let pnlPercentForThisRepurchase = 0;
        let buyFeeForThisRepurchase = 0;

        if (repurchasePrice > 0 && repurchaseAmount > 0) {
            if (initialEntryPrice > 0) {
                changePercent = ((repurchasePrice - initialEntryPrice) / initialEntryPrice) * 100;
            }
            repurchaseQty = repurchaseAmount / repurchasePrice;
            totalCoinQty += repurchaseQty; totalInvestedAmount += repurchaseAmount;
            buyFeeForThisRepurchase = repurchaseAmount * activeFeeRate;
            totalBuyFeesDca += buyFeeForThisRepurchase;
            if (marketPrice > 0) {
                const currentValueOfRepurchase = repurchaseQty * marketPrice;
                pnlForThisRepurchase = currentValueOfRepurchase - repurchaseAmount;
                pnlPercentForThisRepurchase = repurchaseAmount > 0 ? (pnlForThisRepurchase / repurchaseAmount) * 100 : 0;
            }
        }
        const dpSpan = document.getElementById(`downPercent${i}`);
        const rpQtyDiv = document.getElementById(`repurchaseQty${i}`);
        const rpPnlDiv = document.getElementById(`repurchasePnl${i}`);
        const rpPnlPercentDiv = document.getElementById(`repurchasePnlPercent${i}`);
        const rpBuyFeeDiv = document.getElementById(`repurchaseBuyFee${i}`);

        if (dpSpan) {
            dpSpan.textContent = (changePercent !== 0 && isFinite(changePercent)) ? `${formatNumber(changePercent, 2)}` : '-';
            dpSpan.className = 'down-percent';
            if (changePercent < 0) dpSpan.classList.add('negative'); else if (changePercent > 0) dpSpan.classList.add('positive');
        }
        if (rpQtyDiv) rpQtyDiv.textContent = formatNumber(repurchaseQty, 8);
        if (rpPnlDiv) {
            rpPnlDiv.textContent = '$ ' + formatNumber(pnlForThisRepurchase, 2);
            rpPnlDiv.className = 'output-field repurchase-pnl ltr-text';
            if (pnlForThisRepurchase > 0) rpPnlDiv.classList.add('pnl-positive');
            else if (pnlForThisRepurchase < 0) rpPnlDiv.classList.add('pnl-negative');
        }
        if (rpPnlPercentDiv) {
            rpPnlPercentDiv.textContent = `${formatNumber(pnlPercentForThisRepurchase, 2)} %`;
            rpPnlPercentDiv.className = 'output-field repurchase-pnl-percent';
            if (pnlPercentForThisRepurchase > 0) rpPnlPercentDiv.classList.add('pnl-positive');
            else if (pnlPercentForThisRepurchase < 0) rpPnlPercentDiv.classList.add('pnl-negative');
        }
        if (rpBuyFeeDiv) {
            rpBuyFeeDiv.textContent = '$ ' + formatNumber(buyFeeForThisRepurchase, 4);
            rpBuyFeeDiv.className = 'output-field repurchase-fee ltr-text';
        }
    }

    setTableFeesSummaryValue(totalBuyFeesDcaEl, totalBuyFeesDca);

    const averageEntryPrice = totalCoinQty > 0 ? totalInvestedAmount / totalCoinQty : 0;

    // --- CALCULATE SELLS AND REMAINING QTY ---
    const sells = getCurrentCycleSells(data);
    let totalSellQty = 0;
    let totalRealizedPnL = 0;

    // We calculate realized PnL based on the Average Buy Price calculated above
    // (This matches user requirement: "Use the system’s existing Average Cost value")
    const averageBuyPrice = averageEntryPrice; // This is the avg of all buys

    sells.forEach(sell => {
        const sQty = parseFloat(sell.qty) || 0;
        const sPrice = parseFloat(sell.price) || 0;
        if (sQty > 0 && sPrice > 0) {
            totalSellQty += sQty;
            totalRealizedPnL += (sPrice - averageBuyPrice) * sQty;
        }
    });

    // --- UPDATE TOTALS WITH REMAINING QTY ---
    const remainingQty = Math.max(0, totalCoinQty - totalSellQty);

    // Pro-rated Invested Amount based on remaining quantity
    // If you sold 50% of coins, your technically "active invested" amount is 50% of original.
    // However, some prefer (Remaining Qty * Initial Avg Price).
    const remainingInvestedAmount = remainingQty * averageBuyPrice;

    const currentPortfolioValue = remainingQty * marketPrice;

    // PnL updates:
    // Unrealized PnL = (Current Value of Remaining) - (Invested Cost of Remaining)
    const unrealizedPnL = (remainingInvestedAmount > 0 || currentPortfolioValue > 0) ? currentPortfolioValue - remainingInvestedAmount : 0;
    const unrealizedPnLPercent = remainingInvestedAmount > 0 ? (unrealizedPnL / remainingInvestedAmount) * 100 : 0;

    // Update Display Elements with NEW values
    document.getElementById('totalCoinQty').textContent = formatNumber(remainingQty, 8);
    // document.getElementById('totalInvestedAmount').textContent = formatNumber(remainingInvestedAmount, 2); 
    // ^ Wait, user might want to see TOTAL invested historically vs Remaining Invested?
    // Standard portfolio logic: Invested Amount usually reflects the cost basis of currently held assets.
    document.getElementById('totalInvestedAmount').textContent = '$ ' + formatNumber(remainingInvestedAmount, 2);

    document.getElementById('averageEntryPrice').textContent = '$ ' + formatNumber(averageBuyPrice, guessDecimalPlaces(averageBuyPrice));
    currentPortfolioValueElement.textContent = '$ ' + formatNumber(currentPortfolioValue, 2);

    pnlAmountElement.textContent = '$ ' + formatNumber(unrealizedPnL, 2);
    pnlPercentElement.textContent = `${formatNumber(unrealizedPnLPercent, 2)} %`;

    // Use hero-value/hero-sub to maintain dashboard styling context + ltr-text
    pnlAmountElement.className = 'hero-value ltr-text';
    pnlPercentElement.className = 'hero-value ltr-text';
    currentPortfolioValueElement.classList.remove('pnl-positive', 'pnl-negative', 'pnl-neutral');

    if (unrealizedPnL > 0) {
        pnlAmountElement.classList.add('pnl-positive');
        pnlPercentElement.classList.add('pnl-positive');
        currentPortfolioValueElement.classList.add('pnl-positive');
    } else if (unrealizedPnL < 0) {
        pnlAmountElement.classList.add('pnl-negative');
        pnlPercentElement.classList.add('pnl-negative');
        currentPortfolioValueElement.classList.add('pnl-negative');
    } else {
        pnlAmountElement.classList.add('pnl-neutral');
        pnlPercentElement.classList.add('pnl-neutral');
        currentPortfolioValueElement.classList.add('pnl-neutral');
    }

    // Render Sells Table
    createSellRows();

    // Targets (Based on Avg Buy Price - unchanged)
    const tpP1 = parseFloat(document.getElementById('tpPercent1').value) || 0, tpP2 = parseFloat(document.getElementById('tpPercent2').value) || 0;
    const tpP3 = parseFloat(document.getElementById('tpPercent3').value) || 0, slP = parseFloat(document.getElementById('slPercent').value) || 0;
    const avgPriceDecimals = guessDecimalPlaces(averageEntryPrice);
    const tpPrice1 = averageEntryPrice > 0 ? averageEntryPrice * (1 + tpP1 / 100) : 0;
    const tpPrice2 = averageEntryPrice > 0 ? averageEntryPrice * (1 + tpP2 / 100) : 0;
    const tpPrice3 = averageEntryPrice > 0 ? averageEntryPrice * (1 + tpP3 / 100) : 0;
    const slPriceVal = averageEntryPrice > 0 && slP > 0 ? averageEntryPrice * (1 - slP / 100) : 0;
    document.getElementById('tpPrice1').textContent = '$ ' + formatNumber(tpPrice1, avgPriceDecimals);
    document.getElementById('tpPrice2').textContent = '$ ' + formatNumber(tpPrice2, avgPriceDecimals);
    document.getElementById('tpPrice3').textContent = '$ ' + formatNumber(tpPrice3, avgPriceDecimals);
    document.getElementById('slPrice').textContent = '$ ' + formatNumber(slPriceVal, avgPriceDecimals);

    updateRepurchaseRowsVisibility();
    scheduleRepurchaseTableVisibleRowsSync();
}


function formatNumber(num, decimalPlaces = 8) {
    const number = Number(num);
    if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimalPlaces);
    return number.toFixed(decimalPlaces);
}

function isValidPriceValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' && value.trim() === '') return false;
    return Number.isFinite(Number(value));
}

function trimTrailingZeros(valueStr) {
    const normalized = String(valueStr ?? '');
    if (!normalized.includes('.')) return normalized;
    return normalized
        .replace(/(\.\d*?[1-9])0+$/u, '$1')
        .replace(/\.0+$/u, '')
        .replace(/\.$/u, '');
}

function toPlainDecimalString(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    if (numeric === 0) return '0';

    const sign = numeric < 0 ? '-' : '';
    const absString = Math.abs(numeric).toString();
    if (!/[eE]/u.test(absString)) {
        return sign + absString;
    }

    const [mantissa, exponentPart] = absString.split(/[eE]/u);
    const exponent = Number.parseInt(exponentPart, 10);
    if (!Number.isFinite(exponent)) {
        return sign + absString;
    }

    const [intPart, fracPart = ''] = mantissa.split('.');
    const digits = `${intPart}${fracPart}`;
    if (!digits) return `${sign}0`;

    if (exponent >= 0) {
        const zeroCount = exponent - fracPart.length;
        if (zeroCount >= 0) {
            return sign + digits + '0'.repeat(zeroCount);
        }
        const decimalIndex = intPart.length + exponent;
        return sign + `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
    }

    const decimalIndex = intPart.length + exponent;
    if (decimalIndex > 0) {
        return sign + `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
    }

    return sign + `0.${'0'.repeat(Math.abs(decimalIndex))}${digits}`;
}

function formatPriceFull(value) {
    if (!isValidPriceValue(value)) return '--';
    const numeric = Number(value);
    return toPlainDecimalString(numeric);
}

function formatPriceWithZeroCount(value) {
    if (!isValidPriceValue(value)) return '--';
    const numeric = Number(value);
    if (numeric === 0) return '0';

    const sign = numeric < 0 ? '-' : '';
    const abs = Math.abs(numeric);
    const fullAbsString = toPlainDecimalString(abs);

    if (abs >= 1) {
        return sign + trimTrailingZeros(abs.toFixed(6));
    }

    const decimalPart = fullAbsString.split('.')[1] || '';
    const firstNonZeroIndex = decimalPart.search(/[1-9]/u);
    if (firstNonZeroIndex === -1) return `${sign}0`;

    if (firstNonZeroIndex >= 6) {
        const significantPartRaw = decimalPart.slice(firstNonZeroIndex).replace(/0+$/u, '');
        const significantPart = significantPartRaw || decimalPart.slice(firstNonZeroIndex);
        const significantLength = significantPart.length >= 5
            ? 5
            : (significantPart.length >= 4 ? 4 : 3);
        const visibleSignificant = significantPart.slice(0, significantLength);
        return `${sign}0.{${firstNonZeroIndex}}${visibleSignificant}`;
    }

    return sign + trimTrailingZeros(abs.toFixed(8));
}

function formatPriceSmart(value) {
    return formatPriceWithZeroCount(value);
}

function formatDateTime(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return '';
    const dateStr = date.toLocaleDateString('en-US');
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `${dateStr}<br>${timeStr}`;
}

function guessDecimalPlaces(price) {
    const num = Number(price); if (isNaN(num) || num === 0) return 2;
    if (num >= 1000) return 2; if (num >= 10) return 4; if (num >= 0.1) return 5;
    if (num >= 0.001) return 6; if (num >= 0.0001) return 7; return 8;
}


function startAutoRefresh() {
    if (autoRefreshIntervalId) clearInterval(autoRefreshIntervalId);
    const trackedSymbols = Object.keys(allCoinData);
    if (trackedSymbols.length > 0 && autoRefreshCheckbox.checked) {
        if (!apiStatusDiv.textContent.includes('( التحديث التلقائي مفعل)')) apiStatusDiv.textContent += ' ( التحديث التلقائي مفعل)';
        autoRefreshIntervalId = setInterval(() => fetchAllPrices(true), AUTO_REFRESH_INTERVAL);
    } else {
        autoRefreshCheckbox.checked = false;
        if (trackedSymbols.length === 0) {
            apiStatusDiv.textContent = 'أضف عملة للتحديث التلقائي.'; setApiStatusColor('var(--text-muted)');
        }
    }
}
function stopAutoRefresh() {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId); autoRefreshIntervalId = null;
        let currentStatus = apiStatusDiv.textContent;
        currentStatus = currentStatus.replace(/\( التحديث التلقائي مفعل\)|\(التحديث التلقائي متوقف\)/g, '').trim();
        if (currentStatus.startsWith('التحديث التلقائي:')) {
            const timePartIndex = currentStatus.indexOf('(');
            currentStatus = timePartIndex > -1 ? currentStatus.substring(currentStatus.indexOf(':') + 1, timePartIndex).trim() : currentStatus.substring(currentStatus.indexOf(':') + 1).trim();
        }
        apiStatusDiv.textContent = currentStatus + ' (تلقائي متوقف)';
    }
}
function handleAutoRefreshToggle() {
    if (autoRefreshCheckbox.checked) {
        if (Object.keys(allCoinData).length > 0) {
            fetchAllPrices();
            startAutoRefresh();
            saveAutoRefreshPreference(true);
            showToast('تم تفعيل التحديث التلقائي', 'success', 2500);
        }
        else {
            autoRefreshCheckbox.checked = false;
            saveAutoRefreshPreference(false);
            showToast("يرجى إضافة عملة أولاً لتفعيل التحديث التلقائي.", 'warning');
        }
    } else {
        stopAutoRefresh();
        saveAutoRefreshPreference(false);
        showToast('تم إيقاف التحديث التلقائي', 'info', 2500);
    }
}


function handleCoinSelectionChange() {
    const selectedSymbol = coinSelector.value;
    if (selectedSymbol && allCoinData[selectedSymbol]) {
        activeCoinSymbol = selectedSymbol; newCoinNameInput.value = '';
        displayCoinData(selectedSymbol); saveAllDataToLocalStorage();
        updatePortfolioStats();
    } else if (!selectedSymbol) {
        activeCoinSymbol = null; clearUIFields();
        saveAllDataToLocalStorage(); updateCoinStatus();
        updatePortfolioStats();
    } else {
        console.error(`Selected symbol ${selectedSymbol} not in data.`);
        activeCoinSymbol = null; clearUIFields(); saveAllDataToLocalStorage(); updateCoinStatus();
        updatePortfolioStats();
    }
}


async function openTradingViewChart() {
    if (!activeCoinSymbol) {
        showToast("الرجاء اختيار عملة أولاً.", 'warning');
        return;
    }


    const exchanges = ['BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'KRAKEN', 'KUCOIN', 'BITFINEX', 'GATEIO', 'HUOBI', 'MEXC'];


    const chartBtn = document.getElementById('chartBtn');
    const originalText = chartBtn.innerHTML;
    chartBtn.innerHTML = '<i class="fas fa-magnifying-glass" aria-hidden="true"></i> بحث...';
    chartBtn.disabled = true;

    try {
        let foundExchange = null;



        for (const exchange of exchanges) {
            try {

                if (exchange === 'BINANCE') {
                    const binanceResponse = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${activeCoinSymbol}`);
                    if (binanceResponse.ok) {
                        foundExchange = 'BINANCE';
                        break;
                    }
                }

                else if (exchange === 'BYBIT') {
                    const bybitResponse = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${activeCoinSymbol}`);
                    if (bybitResponse.ok) {
                        const data = await bybitResponse.json();
                        if (data.result && data.result.list && data.result.list.length > 0) {
                            foundExchange = 'BYBIT';
                            break;
                        }
                    }
                }

                else if (exchange === 'OKX') {

                    const okxSymbol = activeCoinSymbol.replace('USDT', '-USDT').replace('USDC', '-USDC');
                    const okxResponse = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${okxSymbol}`);
                    if (okxResponse.ok) {
                        const data = await okxResponse.json();
                        if (data.data && data.data.length > 0) {
                            foundExchange = 'OKX';
                            break;
                        }
                    }
                }
            } catch (e) {

                continue;
            }
        }


        const finalExchange = foundExchange || 'BINANCE';
        const tradingViewSymbol = `${finalExchange}:${activeCoinSymbol}`;
        const tradingViewUrl = `https://www.tradingview.com/chart/?symbol=${tradingViewSymbol}`;


        window.open(tradingViewUrl, '_blank');


        if (foundExchange) {
            apiStatusDiv.innerHTML = `<i class="fas fa-chart-line" aria-hidden="true"></i> تم فتح الشارت من ${finalExchange}`;
            setApiStatusColor('var(--positive-color)');
            showToast(`تم فتح شارت ${activeCoinSymbol} من ${finalExchange}`, 'success', 3000);
        } else {
            apiStatusDiv.innerHTML = `<i class="fas fa-chart-line" aria-hidden="true"></i> تم فتح الشارت (افتراضي: ${finalExchange})`;
            setApiStatusColor('var(--text-muted)');
            showToast(`تم فتح شارت ${activeCoinSymbol}`, 'info', 3000);
        }

    } catch (error) {
        console.error('خطأ في البحث عن العملة:', error);

        const tradingViewUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${activeCoinSymbol}`;
        window.open(tradingViewUrl, '_blank');
        apiStatusDiv.innerHTML = '<i class="fas fa-chart-line" aria-hidden="true"></i> تم فتح الشارت (Binance)';
        setApiStatusColor('var(--text-muted)');
        showToast(`تم فتح شارت ${activeCoinSymbol}`, 'info', 3000);
    } finally {

        chartBtn.innerHTML = originalText;
        chartBtn.disabled = false;
    }
}



function getModalElements() {
    return {
        vModal: document.getElementById('validationModal'),
        vBox: document.getElementById('validationBox'),
        vIcon: document.getElementById('validationIcon'),
        vTitle: document.getElementById('validationTitle'),
        vStatus: document.getElementById('validationStatus'),
        vProgress: document.getElementById('validationProgress')
    };
}

function showValidationModal(symbol) {
    const { vModal, vBox, vIcon, vTitle, vStatus, vProgress } = getModalElements();
    if (!vModal) return;

    vModal.classList.remove('hidden');
    vModal.classList.add('flex');
    vModal.classList.add('active');
    document.body.classList.add('modal-open');
    document.documentElement.classList.add('modal-open');

    vBox.className = 'validation-box';
    vIcon.className = 'fas fa-search';
    vTitle.textContent = `جاري البحث عن ${symbol}...`;
    vStatus.textContent = 'يتم التحقق من الرمز في المنصات...';
    vProgress.style.width = '30%';
}

function updateValidationModal(type, title, message) {
    const { vBox, vIcon, vTitle, vStatus, vProgress } = getModalElements();
    if (!vBox) return;

    if (type === 'success') {
        vBox.classList.add('success');
        vIcon.className = 'fas fa-check-circle';
        vProgress.style.width = '100%';
    } else if (type === 'error') {
        vBox.classList.add('error');
        vIcon.className = 'fas fa-times-circle';
        vProgress.style.width = '100%';
    } else {
        vProgress.style.width = '70%';
    }
    vTitle.textContent = title;
    vStatus.textContent = message;
}

function hideValidationModal(delay = 0) {
    const { vModal } = getModalElements();
    if (!vModal) return;

    setTimeout(() => {
        vModal.classList.remove('active');
        vModal.classList.remove('flex');
        vModal.classList.add('hidden');
        document.body.classList.remove('modal-open');
        document.documentElement.classList.remove('modal-open');
    }, delay);
}


async function addOrSwitchCoin() {
    const parsed = parsePair(newCoinNameInput.value);
    const validation = validatePair(parsed);

    if (!validation.valid) {
        showToast(validation.message, 'warning', 4200);
        return;
    }

    const symbol = parsed.exchangeSymbol;
    const displayPair = parsed.displayPair || symbol;


    if (allCoinData[symbol]) {
        coinSelector.value = symbol; activeCoinSymbol = symbol;
        displayCoinData(symbol); saveAllDataToLocalStorage(); newCoinNameInput.value = '';
        updatePortfolioStats();
        apiStatusDiv.textContent = `تم التبديل إلى ${displayPair}.`; setApiStatusColor('var(--text-muted)');
        showToast(`تم التبديل إلى ${displayPair}`, 'info', 2500);
        return;
    }


    showValidationModal(displayPair);

    try {

        await new Promise(r => setTimeout(r, 600));
        updateValidationModal('searching', `جاري فحص ${displayPair}...`, 'الاتصال بـ Binance, CoinGecko...');


        const result = await fetchSinglePrice(symbol);

        if (result.price !== null) {

            updateValidationModal('success', 'تم العثور على العملة!', `السعر الحالي: $ ${formatPriceSmart(result.price)}`);


            allCoinData[symbol] = getDefaultCoinDataStructure();
            currentMarketPrices[symbol] = result.price;
            activeCoinSymbol = symbol;
            updateCoinSelector();
            newCoinNameInput.value = '';
            saveAllDataToLocalStorage();
            updateCoinStatus();
            updateSummaryTable();
            updatePortfolioStats();
            if (activeCoinSymbol === symbol) displayCoinData(symbol);

            apiStatusDiv.innerHTML = `<i class="fas fa-circle-check" aria-hidden="true"></i> تمت إضافة ${displayPair}.`;
            setApiStatusColor('var(--positive-color)');


            hideValidationModal(1500);

        } else {
            const suggestions = getPairSuggestions(parsed.base, parsed.quote);
            const suggestionSuffix = suggestions.length > 0 ? ` جرب: ${suggestions.join(' أو ')}.` : '';
            const unavailableMessage = `هذا الزوج غير متوفر للتداول على المصدر الحالي.${suggestionSuffix}`;

            updateValidationModal('error', 'الزوج غير متوفر', unavailableMessage);
            apiStatusDiv.innerHTML = `<i class="fas fa-circle-xmark" aria-hidden="true"></i> فشل إضافة ${displayPair}.`;
            setApiStatusColor('var(--negative-color)');
            showToast(unavailableMessage, 'error', 5200);


            hideValidationModal(2000);
        }

    } catch (error) {
        console.error("Error validating coin:", error);
        updateValidationModal('error', 'خطأ غير متوقع', 'حدث خطأ أثناء الاتصال بالخادم.');
        hideValidationModal(2000);
    }
}


async function deleteCurrentCoin() {
    if (!activeCoinSymbol) {
        showToast("لا توجد عملة محددة لحذفها.", 'warning');
        return;
    }
    const symbolToDelete = activeCoinSymbol;

    const confirmed = await showConfirm(
        'تأكيد حذف العملة',
        null,
        null,
        {
            introText: 'هل أنت متأكد أنك تريد حذف بيانات العملة التالية؟',
            coins: [symbolToDelete],
            maxBadges: 8
        }
    );
    if (confirmed) {
        const settlement = settleCoinsBeforeDeletion([symbolToDelete]);
        delete allCoinData[symbolToDelete];
        delete currentMarketPrices[symbolToDelete];
        activeCoinSymbol = null;
        updateCoinSelector();
        saveAllDataToLocalStorage();
        if (!coinSelector.value) clearUIFields();
        updateSummaryTable();
        updateCoinStatus();
        if (settlement.settledAmount > 0) {
            showToast(`تم حذف ${symbolToDelete} وإرجاع $${formatNumber(settlement.settledAmount, 2)} إلى رأس المال.`, 'success', 4200);
        } else {
            showToast(`تم حذف العملة ${symbolToDelete} بنجاح.`, 'success');
        }
        apiStatusDiv.textContent = `تم حذف ${symbolToDelete}.`;
        setApiStatusColor('var(--text-muted)');
    }
}


function updateControlsActionsLayout() {
    const actionsContainer = document.querySelector('.controls-bar.controls-main .controls-actions');
    if (!actionsContainer) return;

    const isCompactScreen = window.matchMedia('(max-width: 768px)').matches;
    const actionItems = Array.from(
        actionsContainer.querySelectorAll(':scope > button, :scope > .controls-toggle')
    );

    actionItems.forEach(item => item.classList.remove('controls-action--span'));
    if (!isCompactScreen) return;

    const visibleItems = actionItems.filter(item => {
        const computedDisplay = window.getComputedStyle(item).display;
        return computedDisplay !== 'none' && !item.classList.contains('hidden');
    });

    if (visibleItems.length % 2 === 1) {
        visibleItems[visibleItems.length - 1].classList.add('controls-action--span');
    }
}

function toggleSelectCoinsMode() {
    selectCoinsMode = !selectCoinsMode;
    selectedCoins.clear();
    const selectBtn = document.getElementById('selectCoinsBtn');
    const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
    const cancelBtn = document.getElementById('cancelSelectBtn');
    const deleteCoinBtn = document.getElementById('deleteCoinBtn');
    const chartBtn = document.getElementById('chartBtn');
    const deleteAllBtn = document.getElementById('deleteAllBtn');
    const refreshPriceBtn = document.getElementById('refreshPriceBtn');
    const addCoinBtn = document.querySelector('button[onclick="addOrSwitchCoin()"]');
    const importBtn = document.querySelector('button[onclick="document.getElementById(\'importTxtFile\').click()"]');
    const downloadBtn = document.querySelector('button[onclick="downloadAllDataAsTxt()"]');

    if (selectCoinsMode) {
        selectBtn.style.display = 'none';
        deleteCoinBtn.style.display = 'none';
        cancelBtn.style.display = 'inline-block';
        deleteSelectedBtn.style.display = 'inline-block';
        deleteAllBtn.style.display = 'inline-block';


        deleteCoinBtn.disabled = true;
        chartBtn.disabled = true;
        refreshPriceBtn.disabled = true;
        addCoinBtn.disabled = false;
        importBtn.disabled = true;
        downloadBtn.disabled = true;


        cancelBtn.disabled = false;
        deleteAllBtn.disabled = false;

        apiStatusDiv.innerHTML = '<i class="fas fa-hand-pointer" aria-hidden="true"></i> اختر العملات المراد حذفها';
        setApiStatusColor('var(--secondary-color)');
    } else {
        cancelSelectCoinsMode();
    }
    updateSummaryTable();
    updateControlsActionsLayout();
}


function cancelSelectCoinsMode() {
    selectCoinsMode = false;
    selectedCoins.clear();
    const selectBtn = document.getElementById('selectCoinsBtn');
    const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
    const cancelBtn = document.getElementById('cancelSelectBtn');
    const deleteCoinBtn = document.getElementById('deleteCoinBtn');
    const chartBtn = document.getElementById('chartBtn');
    const deleteAllBtn = document.getElementById('deleteAllBtn');
    const refreshPriceBtn = document.getElementById('refreshPriceBtn');
    const addCoinBtn = document.querySelector('button[onclick="addOrSwitchCoin()"]');
    const importBtn = document.querySelector('button[onclick="document.getElementById(\'importTxtFile\').click()"]');
    const downloadBtn = document.querySelector('button[onclick="downloadAllDataAsTxt()"]');

    selectBtn.style.display = 'inline-block';
    deleteCoinBtn.style.display = 'inline-block';
    deleteSelectedBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    deleteAllBtn.style.display = 'none';
    deleteSelectedBtn.disabled = true;


    deleteCoinBtn.disabled = !activeCoinSymbol;
    chartBtn.disabled = !activeCoinSymbol;
    refreshPriceBtn.disabled = false;
    addCoinBtn.disabled = false;
    importBtn.disabled = false;
    downloadBtn.disabled = false;

    apiStatusDiv.innerHTML = '<i class="fas fa-circle-check" aria-hidden="true"></i> تم إلغاء الاختيار';
    setApiStatusColor('var(--text-muted)');
    updateSummaryTable();
    updateControlsActionsLayout();
}


async function deleteSelectedCoins() {
    if (selectedCoins.size === 0) {
        showToast("لم تختر أي عملات للحذف.", 'warning');
        return;
    }

    const coinsCount = selectedCoins.size;
    const coinsList = Array.from(selectedCoins).sort();
    const confirmed = await showConfirm(
        'تأكيد حذف العملات',
        null,
        null,
        {
            introText: 'هل أنت متأكد من حذف العملات التالية؟',
            coins: coinsList,
            maxBadges: 20
        }
    );
    if (confirmed) {
        const settlement = settleCoinsBeforeDeletion(coinsList);
        selectedCoins.forEach(symbol => {
            delete allCoinData[symbol];
            delete currentMarketPrices[symbol];
        });

        activeCoinSymbol = null;
        updateCoinSelector();
        saveAllDataToLocalStorage();
        clearUIFields();
        updateSummaryTable();
        updateCoinStatus();
        cancelSelectCoinsMode();
        if (settlement.settledAmount > 0) {
            showToast(`تم حذف ${coinsCount} عملة وإرجاع $${formatNumber(settlement.settledAmount, 2)} إلى رأس المال.`, 'success', 4200);
        } else {
            showToast(`تم حذف ${coinsCount} عملة بنجاح.`, 'success');
        }
    }
}


async function deleteAllCoins() {
    if (Object.keys(allCoinData).length === 0) {
        showToast("لا توجد عملات للحذف.", 'warning');
        return;
    }

    const allSymbols = Object.keys(allCoinData).sort();
    const confirmed = await showConfirm(
        'تأكيد حذف جميع العملات',
        null,
        null,
        {
            introText: `هل أنت متأكد من حذف جميع العملات (${allSymbols.length} عملة)؟`,
            coins: allSymbols,
            maxBadges: 24,
            noteText: 'هذا الإجراء لا يمكن التراجع عنه!'
        }
    );
    if (confirmed) {
        const settlement = settleCoinsBeforeDeletion(allSymbols);
        allCoinData = {};
        currentMarketPrices = {};
        activeCoinSymbol = null;
        selectedCoins.clear();
        selectCoinsMode = false;
        updateCoinSelector();
        saveAllDataToLocalStorage();
        clearUIFields();
        updateSummaryTable();
        updateCoinStatus();
        cancelSelectCoinsMode();
        if (settlement.settledAmount > 0) {
            showToast(`تم حذف جميع العملات وإرجاع $${formatNumber(settlement.settledAmount, 2)} إلى رأس المال.`, 'success', 4500);
        } else {
            showToast('تم حذف جميع العملات بنجاح.', 'success');
        }
        apiStatusDiv.innerHTML = '<i class="fas fa-circle-check" aria-hidden="true"></i> تم حذف جميع العملات';
        setApiStatusColor('var(--positive-color)');
    }
}


document.addEventListener('DOMContentLoaded', () => {

    console.log('%cنظام متابعة الصفقات الشاملة', 'font-size: 20px; font-weight: bold; color: #3B82F6;');
    console.log('%cنظام البحث الذكي عن أيقونات العملات مفعّل', 'font-size: 14px; color: #10B981;');
    console.log('%cالأوامر المتاحة:', 'font-size: 13px; font-weight: bold; color: #8B5CF6;');
    console.log('%c  • smartSearchAllCoins() - بحث ذكي عن جميع الأيقونات', 'font-size: 12px; color: #F59E0B;');
    console.log('%c  • showIconReport() - عرض تقرير الأيقونات المحملة', 'font-size: 12px; color: #F59E0B;');
    console.log('');

    bindAppUpdatePopupEvents();
    registerAppServiceWorker();
    bindFooterUpdateCheckButton();
    setTimeout(() => {
        checkForUpdates();
    }, 1400);

    loadThemePreference();
    createRepurchaseRows();
    initPriceBadgesWidthSync();
    loadFinancialPrivacyPreference();
    loadAllDataFromLocalStorage();
    updateCoinSelector();
    if (window.spotExchangeSettingsUI?.init) {
        window.spotExchangeSettingsUI.init();
    }
    scheduleRepurchaseTableVisibleRowsSync();

    window.addEventListener('spot-fees:selection-changed', () => {
        updateSummaryTable();
        calculateActiveCoinDetails();
        if (window.spotExchangeSettingsUI?.render) {
            window.spotExchangeSettingsUI.render();
        }
    });


    const cancelBtn = document.getElementById('cancelSelectBtn');
    if (cancelBtn) {
        cancelBtn.style.display = 'none';
    }

    updateControlsActionsLayout();
    window.addEventListener('resize', updateControlsActionsLayout);
    window.addEventListener('resize', handleRepurchaseTableViewportResize);


    const savedAutoRefresh = loadAutoRefreshPreference();
    autoRefreshCheckbox.checked = savedAutoRefresh;


    updatePortfolioStats();

    setTimeout(() => {
        if (window.spotOnboardingModalUI?.maybeOpenOnFirstVisit) {
            window.spotOnboardingModalUI.maybeOpenOnFirstVisit();
        }
    }, 320);

    fetchAllPrices().then(() => {
        if (activeCoinSymbol) displayCoinData(activeCoinSymbol);
        else if (coinSelector.value && allCoinData[coinSelector.value]) {
            handleCoinSelectionChange();
        }
        else clearUIFields();
        if (autoRefreshCheckbox.checked) startAutoRefresh();


        updatePortfolioStats();
    });

    const inputsToSave = ['initialEntryPrice', 'initialAmountDollars', 'tpPercent1', 'tpPercent2', 'tpPercent3', 'slPercent'];
    inputsToSave.forEach(id => {
        const el = document.getElementById(id); if (el) el.addEventListener('input', saveAndCalculate);
    });
    repurchaseTableBody.addEventListener('input', (event) => {
        if (event.target && (event.target.id.startsWith('repurchasePrice') || event.target.id.startsWith('repurchaseAmount'))) {
            saveAndCalculate();
        }
    });
    autoRefreshCheckbox.addEventListener('change', handleAutoRefreshToggle);
    if (newCoinNameInput && !newCoinNameInput.disabled) { newCoinNameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOrSwitchCoin(); } }); }
    coinSelector.addEventListener('change', () => { if (coinSelector.value) newCoinNameInput.value = ''; });

    summaryTableBody.addEventListener('click', (event) => {
        let targetCell = event.target;

        while (targetCell && targetCell.tagName !== 'TD' && targetCell !== summaryTableBody) {
            targetCell = targetCell.parentElement;
        }

        if (targetCell && targetCell.classList.contains('summary-coin-clickable')) {
            const symbolToActivate = targetCell.dataset.symbol;
            if (symbolToActivate && allCoinData[symbolToActivate]) {

                if (selectCoinsMode) {
                    if (selectedCoins.has(symbolToActivate)) {
                        selectedCoins.delete(symbolToActivate);
                        targetCell.classList.remove('coin-selected');
                    } else {
                        selectedCoins.add(symbolToActivate);
                        targetCell.classList.add('coin-selected');
                    }

                    const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
                    deleteSelectedBtn.disabled = selectedCoins.size === 0;
                    apiStatusDiv.innerHTML = `<i class="fas fa-circle-check" aria-hidden="true"></i> تم اختيار ${selectedCoins.size} عملة`;
                } else {

                    coinSelector.value = symbolToActivate;
                    handleCoinSelectionChange();

                    const controlsBar = document.querySelector('.controls-bar');
                    if (controlsBar) controlsBar.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        }
    });
});

function generateFullBackup() {
    const now = new Date();

    // تنسيق التاريخ والوقت لاسم الملف
    const dateStr = now.toISOString().split('T')[0];
    const filename = `CryptoPortfolio_Backup_${dateStr}.json`;

    // تنسيق التاريخ للعرض
    const formattedDate = now.toLocaleString('ar-EG', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });

    // تجميع الإحصائيات العامة
    const globalStats = {
        totalInvested: document.getElementById('totalInvestedSummary')?.textContent || "0",
        totalCurrentValue: document.getElementById('totalCurrentValueSummary')?.textContent || "0",
        totalPnl: document.getElementById('totalPnlAmountSummary')?.textContent || "0",
        pnlPercent: document.getElementById('totalPnlPercentSummary')?.textContent || "0"
    };

    // إعدادات التطبيق
    const appSettings = {
        theme: localStorage.getItem('smcw_theme_preference') || 'dark',
        usdtHidden: document.getElementById('usdtToggleCheckbox')?.checked || false,
        autoRefresh: document.getElementById('autoRefreshCheckbox')?.checked || false
    };

    // تنظيف البيانات من الحقول الفارغة لتقليل حجم الملف
    const cleanHoldings = {};
    for (const [symbol, data] of Object.entries(allCoinData)) {
        const cleanData = { ...data };

        // تنظيف مصفوفة التعزيز (حذف الصفوف الفارغة)
        if (cleanData.repurchases && Array.isArray(cleanData.repurchases)) {
            cleanData.repurchases = cleanData.repurchases.filter(rp => {
                return (rp.price && rp.price !== '') || (rp.amount && rp.amount !== '') || (rp.time);
            });
        }

        // تنظيف الأهداف الفارغة
        if (cleanData.targets) {
            const cleanTargets = {};
            let hasTargets = false;
            for (const [key, val] of Object.entries(cleanData.targets)) {
                if (val && val !== '') {
                    cleanTargets[key] = val;
                    hasTargets = true;
                }
            }
            cleanData.targets = hasTargets ? cleanTargets : {};
        }

        cleanHoldings[symbol] = cleanData;
    }

    // هيكل الملف الكامل
    const backupData = {
        version: "2.0",
        exportDate: now.toISOString(),
        formattedDate: formattedDate,
        summary: globalStats,
        settings: appSettings,
        holdings: cleanHoldings
    };

    return { filename, data: JSON.stringify(backupData, null, 4) };
}

function downloadAllDataAsTxt() {
    if (!allCoinData || Object.keys(allCoinData).length === 0) {
        showToast("لا توجد بيانات لحفظها.", 'warning');
        return;
    }

    const coinsCount = Object.keys(allCoinData).length;
    showToast(`جاري تحضير ملف النسخة الاحتياطية...`, 'info', 2000);

    try {
        const { filename, data } = generateFullBackup();

        const blob = new Blob([data], { type: 'application/json' });
        const link = document.createElement('a');
        link.download = filename;
        link.href = URL.createObjectURL(blob);
        link.click();

        setTimeout(() => {
            showToast(`تم حفظ النسخة الاحتياطية بنجاح\nعدد العملات: ${coinsCount}`, 'success', 4000);
        }, 500);
    } catch (error) {
        console.error("خطأ في تصدير البيانات:", error);
        showToast("حدث خطأ أثناء حفظ الملف", "error");
    }
}

function handleImportTxtFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    showToast('جاري قراءة الملف...', 'info', 2000);

    const parseContent = (content) => {

        const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

        let symbol = null;
        let coinData = getDefaultCoinDataStructure();
        let repIndex = 0;
        let importedCount = 0;

        lines.forEach(line => {
            line = line.trim();
            if (!line) return;


            if (line.startsWith('رمز:')) {

                if (symbol && coinData) {
                    allCoinData[symbol] = coinData;
                    importedCount++;
                }

                symbol = line.split('رمز:')[1].trim();
                coinData = getDefaultCoinDataStructure();
                repIndex = 0;
            } else if (line.startsWith('سعر الدخول:')) {
                coinData.initialEntryPrice = line.split(':')[1].trim();
            } else if (line.startsWith('المبلغ:')) {
                coinData.initialAmountDollars = line.split(':')[1].trim();
            } else if (line.startsWith('تعزيز')) {

                const parts = line.split(':')[1].split(',');
                if (parts.length >= 2 && repIndex < coinData.repurchases.length) {
                    coinData.repurchases[repIndex].price = parts[0].trim();
                    coinData.repurchases[repIndex].amount = parts[1].trim();
                    repIndex++;
                }
            } else if (line.startsWith('هدف1:')) {
                coinData.targets.tp1 = line.split(':')[1].trim();
            } else if (line.startsWith('هدف2:')) {
                coinData.targets.tp2 = line.split(':')[1].trim();
            } else if (line.startsWith('هدف3:')) {
                coinData.targets.tp3 = line.split(':')[1].trim();
            } else if (line.startsWith('وقف:')) {
                coinData.targets.sl = line.split(':')[1].trim();
            }
        });


        if (symbol && coinData) {
            allCoinData[symbol] = coinData;
            importedCount++;
        }

        return importedCount;
    };



    const readFile = (encoding) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file, encoding);
        });
    };


    readFile('UTF-8')
        .then(content => {
            try {
                // محاولة قراءة الملف كـ JSON (النظام الجديد)
                const jsonData = JSON.parse(content);

                if (jsonData.version && jsonData.holdings) {
                    console.log("تم اكتشاف ملف نسخ احتياطي من الإصدار 2.0");

                    // استعادة الإعدادات إذا وجدت
                    if (jsonData.settings) {
                        if (jsonData.settings.theme) {
                            // يمكن تطبيق الثيم هنا إذا لزم الأمر، لكننا نركز على البيانات
                        }
                    }

                    // استبدال البيانات بالكامل
                    allCoinData = jsonData.holdings;
                    parseContentCount = Object.keys(allCoinData).length;
                    return parseContentCount;
                } else {
                    // قد يكون JSON لكن ليس الهيكل المتوقع، نحاول قراءته كملف نصي عادي إذا فشل التحقق
                    throw new Error("Not a valid backup file structure");
                }
            } catch (e) {
                // الفشل في تحليل JSON يعني أنه قد يكون الملف النصي القديم
                console.log("ليس ملف JSON صالح، جاري المحاولة كملف نصي قديم...");

                if (content.includes('رمز')) {
                    return parseContent(content); // الدالة القديمة الموجودة بالداخل
                } else {
                    console.log('UTF-8 text mismatch, trying windows-1256...');
                    return readFile('windows-1256').then(content2 => parseContent(content2));
                }
            }
        })
        .then(count => {
            if (count > 0) {
                saveAllDataToLocalStorage();
                updateCoinSelector();
                showToast(`تم استيراد ${count} عملة بنجاح - سيتم تحديث الصفحة...`, 'success', 3500);

                // تحديث تلقائي للصفحة لضمان تطبيق البيانات بشكل كامل
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            } else {
                showToast('لم يتم العثور على بيانات صالحة في الملف. تأكد من الصيغة.', 'warning', 4000);
            }
            event.target.value = '';
        })
        .catch(error => {
            console.error('Text Import Error:', error);
            showToast('خطأ غير متوقع أثناء القراءة', 'error', 3000);
            event.target.value = '';
        });
}



let coinsDistributionChart = null;

function updatePortfolioStats() {

    updateCoinsDistribution();
}

function updateCoinsDistribution() {
    const chartCanvas = document.getElementById('coinsDistributionChart');
    const legendContainer = document.getElementById('coinsDistributionLegend');

    if (!chartCanvas || !legendContainer) {
        console.log('Chart canvas or legend container not found');
        return;
    }

    legendContainer.innerHTML = '';

    if (!allCoinData || Object.keys(allCoinData).length === 0) {
        legendContainer.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 20px;">لا توجد عملات لعرض التوزيع</p>';


        if (coinsDistributionChart) {
            coinsDistributionChart.destroy();
        }

        const ctx = chartCanvas.getContext('2d');
        coinsDistributionChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['لا توجد بيانات'],
                datasets: [{
                    data: [1],
                    backgroundColor: ['rgba(100, 116, 139, 0.3)'],
                    borderWidth: 0,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                }
            }
        });

        return;
    }


    const coinValues = {};
    let totalValue = 0;

    for (const [symbol, data] of Object.entries(allCoinData)) {
        const marketPrice = Number.parseFloat(currentMarketPrices[symbol]) || 0;
        const totalQty = Number(calculateTotalQuantity(data)) || 0;
        const currentValue = Math.max(0, totalQty * marketPrice);

        // Keep coin visible in legend even when value is zero.
        coinValues[symbol] = currentValue;
        totalValue += currentValue;
    }


    const portfolioTotalValueEl = document.getElementById('portfolioTotalValue');
    if (portfolioTotalValueEl) {
        portfolioTotalValueEl.textContent = '$' + formatNumber(totalValue, 2);
    }


    const sortedCoins = Object.entries(coinValues).sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
    });


    const colors = [
        '#3B82F6',
        '#EF4444',
        '#8B5CF6',
        '#10B981',
        '#F59E0B',
        '#EC4899',
        '#14B8A6',
        '#F97316',
        '#6366F1',
        '#84CC16',
    ];

    const labels = [];
    const data = [];
    const backgroundColors = [];

    sortedCoins.forEach(([symbol, value], index) => {
        const percentage = totalValue > 0 ? (value / totalValue * 100).toFixed(2) : '0.00';
        labels.push(symbol);
        data.push(parseFloat(percentage));
        backgroundColors.push(colors[index % colors.length]);


        const legendItem = document.createElement('div');
        legendItem.className = 'legend-item';
        legendItem.id = `legend-${symbol}`;

        legendItem.innerHTML = `
            <div class="legend-color" style="background-color: ${colors[index % colors.length]}; color: ${colors[index % colors.length]}"></div>
            <div class="legend-content">
                <span class="legend-name">${symbol}</span>
                <span class="legend-percent">${percentage}%</span>
            </div>
        `;
        legendContainer.appendChild(legendItem);


        const icon = createTradingPairIcon(symbol, 26, 14);
        const colorDiv = legendItem.querySelector('.legend-color');
        colorDiv.after(icon);
    });

    // Fill remaining legend space with neutral skeleton cards to keep a strict 4-row grid.
    const gridTemplateColumns = window.getComputedStyle(legendContainer).gridTemplateColumns || '';
    const resolvedTracks = gridTemplateColumns
        .split(' ')
        .map(track => track.trim())
        .filter(track => track && track !== 'none');
    const estimatedColumns = Math.max(1, resolvedTracks.length || 0);
    const targetRows = 4;
    const targetLegendCards = Math.max(sortedCoins.length, estimatedColumns * targetRows);
    const skeletonCardsCount = Math.max(0, targetLegendCards - sortedCoins.length);

    for (let i = 0; i < skeletonCardsCount; i++) {
        const skeletonItem = document.createElement('div');
        skeletonItem.className = 'legend-item legend-item--skeleton';
        skeletonItem.setAttribute('aria-hidden', 'true');
        skeletonItem.innerHTML = `
            <div class="legend-color legend-skeleton-dot"></div>
            <div class="legend-content">
                <span class="legend-skeleton-line legend-skeleton-line--name"></span>
                <span class="legend-skeleton-line legend-skeleton-line--value"></span>
            </div>
        `;
        legendContainer.appendChild(skeletonItem);
    }


    if (coinsDistributionChart) {
        coinsDistributionChart.destroy();
    }


    const ctx = chartCanvas.getContext('2d');
    const hasDistributionValue = totalValue > 0;
    const chartLabels = hasDistributionValue ? labels : ['لا توجد قيمة حالية'];
    const chartData = hasDistributionValue ? data : [1];
    const chartBackgroundColors = hasDistributionValue
        ? backgroundColors
        : ['rgba(100, 116, 139, 0.3)'];

    coinsDistributionChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: chartLabels,
            datasets: [{
                data: chartData,
                backgroundColor: chartBackgroundColors,
                borderWidth: 0,
                hoverBorderWidth: 0,
                hoverOffset: 10,
                spacing: 6,
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            layout: {
                padding: 20
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    enabled: hasDistributionValue,
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#ffffff',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
                    boxPadding: 6,
                    cornerRadius: 8,
                    caretSize: 6,
                    caretPadding: 10,
                    titleFont: {
                        size: 13,
                        weight: 'bold',
                        family: 'Segoe UI'
                    },
                    bodyFont: {
                        size: 12,
                        family: 'Segoe UI',
                        weight: '500'
                    },
                    callbacks: {
                        label: function (context) {
                            return ' ' + context.label + ': ' + context.parsed.toFixed(2) + '%';
                        }
                    }
                }
            },
            cutout: '70%',
            animation: {
                animateRotate: true,
                animateScale: true,
                duration: 1000,
                easing: 'easeInOutQuart'
            },
            interaction: {
                intersect: true,
                mode: 'nearest'
            },
            onHover: (event, activeElements) => {
                event.native.target.style.cursor = activeElements.length > 0 ? 'pointer' : 'default';
            }
        }
    });
}

function calculateTotalQuantity(data) {
    let total = 0;


    const initialPrice = parseFloat(data.initialEntryPrice) || 0;
    const initialAmount = parseFloat(data.initialAmountDollars) || 0;
    if (initialPrice > 0) {
        total += initialAmount / initialPrice;
    }


    if (data.repurchases && Array.isArray(data.repurchases)) {
        data.repurchases.forEach(rp => {
            const price = parseFloat(rp.price) || 0;
            const amount = parseFloat(rp.amount) || 0;
            if (price > 0) {
                total += amount / price;
            }
        });
    }

    return total;
}


// ========================================

// ========================================
function filterTableCoins() {
    const input = document.getElementById('tableSearchInput');
    const filter = input.value.trim().toUpperCase();
    const tableBody = document.getElementById('summaryTableBody');
    const rows = tableBody.getElementsByTagName('tr');
    let found = false;


    if (filter === "") {
        for (let i = 0; i < rows.length; i++) {
            rows[i].style.display = "";
            rows[i].classList.remove('glow-effect');
        }
        return;
    }


    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        if (row.cells.length === 1 && row.cells[0].colSpan === SUMMARY_TABLE_COLUMN_COUNT) {
            continue;
        }


        let symbol = row.getAttribute('data-symbol');
        if (!symbol) {

            const symbolCell = row.querySelector('.coin-symbol');
            if (symbolCell) {
                symbol = symbolCell.textContent.trim();
            } else {

                symbol = row.cells[0]?.textContent.trim();
            }
        }

        if (symbol) {


            const txtValue = symbol.toUpperCase();

            if (txtValue.indexOf(filter) > -1) {
                row.style.display = "";


                if (filter.length >= 2) {

                    row.classList.remove('glow-effect');
                    void row.offsetWidth;
                    row.classList.add('glow-effect');


                    setTimeout(() => {
                        row.classList.remove('glow-effect');
                    }, 2000);
                }
                found = true;
            } else {
                row.style.display = "none";
                row.classList.remove('glow-effect');
            }
        }
    }
}


window.addEventListener('load', function () {
    loadUsdtTogglePreference();
    loadFinancialPrivacyPreference();
    loadAllDataFromLocalStorage(); // Ensure data is loaded
    updateCoinSelector(); // Ensure selector is populated
    updateSummaryTable(); // Force render with correct preference
    setTimeout(updatePortfolioStats, 500);
    if (typeof initializeDragAndDrop === 'function') {
        initializeDragAndDrop();
    }
    bindFooterUpdateCheckButton();
});





let currentRepurchaseIndex = null;
let currentSellIndex = null;
let currentDateEditMode = 'repurchase';
let selectedDate = new Date();
let displayedMonth = new Date().getMonth();
let displayedYear = new Date().getFullYear();


const arabicMonths = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
];


function editRepurchaseTime(index) {
    currentDateEditMode = 'repurchase';
    currentRepurchaseIndex = index;
    currentSellIndex = null;
    const modal = document.getElementById('datetimeModal');


    if (activeCoinSymbol && allCoinData[activeCoinSymbol]) {
        const repurchase = allCoinData[activeCoinSymbol].repurchases[index - 1];
        if (repurchase && repurchase.time) {
            selectedDate = new Date(repurchase.time);
        } else {
            selectedDate = new Date();
        }
    } else {
        selectedDate = new Date();
    }

    displayedMonth = selectedDate.getMonth();
    displayedYear = selectedDate.getFullYear();





    // Generate calendar first
    generateCalendar(displayedYear, displayedMonth);

    // Show modal with animation
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        // Use timeout to ensure transition plays
        setTimeout(() => {
            const modalContent = modal.querySelector('.relative');
            if (modalContent) {
                modalContent.classList.remove('opacity-0', 'scale-95');
                modalContent.classList.add('opacity-100', 'scale-100');
            }
        }, 10);

        document.body.style.overflow = 'hidden';
    }
}

function editSellTime(index) {
    currentDateEditMode = 'sell';
    currentSellIndex = index;
    currentRepurchaseIndex = null;
    const modal = document.getElementById('datetimeModal');

    if (activeCoinSymbol && allCoinData[activeCoinSymbol]) {
        const sellRecord = allCoinData[activeCoinSymbol].sells?.[index - 1];
        if (sellRecord && sellRecord.time) {
            selectedDate = new Date(sellRecord.time);
        } else {
            selectedDate = new Date();
        }
    } else {
        selectedDate = new Date();
    }

    displayedMonth = selectedDate.getMonth();
    displayedYear = selectedDate.getFullYear();

    generateCalendar(displayedYear, displayedMonth);

    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        setTimeout(() => {
            const modalContent = modal.querySelector('.relative');
            if (modalContent) {
                modalContent.classList.remove('opacity-0', 'scale-95');
                modalContent.classList.add('opacity-100', 'scale-100');
            }
        }, 10);

        document.body.style.overflow = 'hidden';
    }
}


function closeDateTimeModal() {
    const modal = document.getElementById('datetimeModal');
    if (modal) {
        const modalContent = modal.querySelector('.relative');
        if (modalContent) {
            modalContent.classList.remove('opacity-100', 'scale-100');
            modalContent.classList.add('opacity-0', 'scale-95');
        }

        setTimeout(() => {
            modal.classList.remove('flex');
            modal.classList.add('hidden');
            document.body.style.overflow = '';
            currentRepurchaseIndex = null;
            currentSellIndex = null;
            currentDateEditMode = 'repurchase';
        }, 300); // Match transition duration
    }
}


function generateCalendar(year, month) {
    const daysContainer = document.getElementById('datePickerDays');
    const monthYearDisplay = document.getElementById('currentMonthYear');


    monthYearDisplay.textContent = `${arabicMonths[month]} ${year}`;


    daysContainer.innerHTML = '';


    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const prevLastDay = new Date(year, month, 0);


    const firstDayOfWeek = firstDay.getDay();


    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
        const day = prevLastDay.getDate() - i;
        const dayEl = createDayElement(day, true, year, month - 1);
        daysContainer.appendChild(dayEl);
    }


    for (let day = 1; day <= lastDay.getDate(); day++) {
        const dayEl = createDayElement(day, false, year, month);
        daysContainer.appendChild(dayEl);
    }


    const totalCells = daysContainer.children.length;
    const remainingCells = 42 - totalCells;
    for (let day = 1; day <= remainingCells; day++) {
        const dayEl = createDayElement(day, true, year, month + 1);
        daysContainer.appendChild(dayEl);
    }
}


function createDayElement(day, isOtherMonth, year, month) {
    const dayEl = document.createElement('div');
    dayEl.className = 'date-picker-day';
    dayEl.textContent = day;

    if (isOtherMonth) {
        dayEl.classList.add('other-month');
    }


    const today = new Date();
    const dayDate = new Date(year, month, day);
    if (dayDate.toDateString() === today.toDateString()) {
        dayEl.classList.add('today');
    }


    if (dayDate.toDateString() === selectedDate.toDateString()) {
        dayEl.classList.add('selected');
    }


    dayEl.addEventListener('click', () => {
        selectedDate = new Date(year, month, day, selectedDate.getHours(), selectedDate.getMinutes());
        generateCalendar(year, month);
    });

    return dayEl;
}


function changeMonth(direction) {
    displayedMonth += direction;

    if (displayedMonth > 11) {
        displayedMonth = 0;
        displayedYear++;
    } else if (displayedMonth < 0) {
        displayedMonth = 11;
        displayedYear--;
    }

    generateCalendar(displayedYear, displayedMonth);
}


function setQuickTime(option) {
    const now = new Date();

    switch (option) {
        case 'now':
            selectedDate = now;
            break;
        case 'today':
            selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            break;
        case 'yesterday':
            selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0);
            break;
    }

    displayedMonth = selectedDate.getMonth();
    displayedYear = selectedDate.getFullYear();

    generateCalendar(displayedYear, displayedMonth);
}


function saveDateTimeSelection() {
    if (!activeCoinSymbol) {
        showToast('خطأ في حفظ التاريخ والوقت', 'error');
        closeDateTimeModal();
        return;
    }


    // Defaulting to noon to avoid timezone edge cases on date display
    selectedDate.setHours(12);
    selectedDate.setMinutes(0);

    if (currentDateEditMode === 'sell') {
        if (!currentSellIndex || !allCoinData[activeCoinSymbol].sells?.[currentSellIndex - 1]) {
            showToast('خطأ في حفظ تاريخ البيع', 'error');
            closeDateTimeModal();
            return;
        }

        allCoinData[activeCoinSymbol].sells[currentSellIndex - 1].time = selectedDate.toISOString();
        saveAllDataToLocalStorage(false);
        showToast('تم حفظ تاريخ البيع بنجاح', 'success', 2000);
        closeDateTimeModal();
        calculateActiveCoinDetails();
        return;
    }

    if (!currentRepurchaseIndex) {
        showToast('خطأ في حفظ التاريخ والوقت', 'error');
        closeDateTimeModal();
        return;
    }


    if (!allCoinData[activeCoinSymbol].repurchases[currentRepurchaseIndex - 1]) {
        allCoinData[activeCoinSymbol].repurchases[currentRepurchaseIndex - 1] = { price: '', amount: '' };
    }

    allCoinData[activeCoinSymbol].repurchases[currentRepurchaseIndex - 1].time = selectedDate.toISOString();


    saveAllDataToLocalStorage(false);


    const dateTimeDiv = document.getElementById(`repurchaseDateTime${currentRepurchaseIndex}`);
    if (dateTimeDiv) {
        dateTimeDiv.innerHTML = formatDateTime(selectedDate, currentRepurchaseIndex);
    }


    showToast('تم حفظ التاريخ والوقت بنجاح', 'success', 2000);


    closeDateTimeModal();


    calculateActiveCoinDetails();
}


function formatDateTime(date, index, mode = 'repurchase') {
    if (!date) return '';

    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const clickHandler = mode === 'sell' ? `editSellTime(${index})` : `editRepurchaseTime(${index})`;

    return `
                <div style="display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; padding: 4px;" onclick="${clickHandler}" class="group hover:bg-slate-100 dark:hover:bg-slate-700/50 rounded transition-colors" title="تعديل التاريخ">
                    <div style="font-size: 0.85em; color: var(--text-color); font-weight: 600;">
                        ${year}-${month}-${day}
                    </div>
                    <i class="fas fa-pencil-alt" style="font-size: 0.75rem; color: #94a3b8; transition: color 0.2s;" onmouseover="this.style.color='#3b82f6'" onmouseout="this.style.color='#94a3b8'"></i>
                </div>
            `;
}


document.getElementById('datetimeModal').addEventListener('click', function (e) {
    if (e.target === this) {
        closeDateTimeModal();
    }
});








let tickerInterval;
const TICKER_CACHE_KEY = 'smcw_ticker_data';

function loadTickerFromCache() {
    const cached = localStorage.getItem(TICKER_CACHE_KEY);
    if (cached) {
        try {
            const { data, timestamp } = JSON.parse(cached);

            if (data && Array.isArray(data)) {
                renderTicker(data);
                if (window.checkAudioAlerts) window.checkAudioAlerts(data);
                return true;
            }
        } catch (e) {
            console.error('Ticker Cache Error:', e);
        }
    }
    return false;
}

async function fetchCryptoPrices() {
    const tickerContainer = document.getElementById('cryptoTicker');
    if (!tickerContainer) return;

    try {

        try {
            const response = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&sparkline=false', {
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) throw new Error('CG API Error');
            const data = await response.json();


            localStorage.setItem(TICKER_CACHE_KEY, JSON.stringify({
                data: data,
                timestamp: Date.now()
            }));
            renderTicker(data);

            return;
        } catch (e) {
            console.warn('CoinGecko failed, switching to Binance...', e);
        }


        const response = await fetch('https://api.binance.com/api/v3/ticker/24hr', {
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) throw new Error('Binance API Error');

        const rawData = await response.json();


        const topCoins = rawData
            .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('DOWN') && !t.symbol.includes('UP'))
            .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
            .slice(0, 30)
            .map(t => {
                const symbol = t.symbol.replace('USDT', '');
                return {
                    id: symbol.toLowerCase(),
                    name: symbol,
                    symbol: symbol.toLowerCase(),
                    current_price: parseFloat(t.lastPrice),
                    price_change_percentage_24h: parseFloat(t.priceChangePercent),

                    image: `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${symbol.toLowerCase()}.png`
                };
            });

        renderTicker(topCoins);

    } catch (error) {
        console.error('All Ticker APIs Failed:', error);
        if (tickerContainer.innerHTML.includes('جاري تحميل') || tickerContainer.innerHTML.includes('فشل')) {
            tickerContainer.innerHTML = '<div style="padding: 0 20px; color: var(--negative-color); line-height: 48px;">فشل تحديث الأسعار (تحقق من الإنترنت).</div>';
        }
    }
}

function renderTicker(data) {
    const tickerContainer = document.getElementById('cryptoTicker');
    if (!tickerContainer) return;


    if (window.checkAudioAlerts) window.checkAudioAlerts(data);


    const itemsHtml = data.map(coin => {
        const change = coin.price_change_percentage_24h || 0;
        const isPositive = change >= 0;
        const colorClass = isPositive ? 'positive' : 'negative';
        const sign = isPositive ? '+' : '';
        const arrow = isPositive ? '<i class="fas fa-caret-up"></i>' : '<i class="fas fa-caret-down"></i>';
        const smartTickerPrice = formatPriceSmart(coin.current_price);
        const fullTickerPrice = formatPriceFull(coin.current_price);

        return `
        <div class="ticker-item ${colorClass}" onclick="window.open('https://www.coingecko.com/en/coins/${coin.id}', '_blank')" title="${coin.name}: $${fullTickerPrice} (${sign}${change}%)">
            <img src="${coin.image}" alt="${coin.symbol}" width="20" height="20" loading="lazy" style="will-change: transform" onerror="this.onerror=null; this.src='https://assets.coincap.io/assets/icons/'+this.alt.toLowerCase()+'@2x.png';">
            <span class="coin-symbol">${coin.symbol.toUpperCase()}</span>
            <span class="coin-price price" dir="ltr">$${smartTickerPrice}</span>
            <span class="coin-change change" dir="ltr">${arrow} ${Math.abs(change).toFixed(2)}%</span>
        </div>
        `;
    }).join('');


    const totalOriginalItems = data.length;
    const generateItems = (count) => {
        let html = '';
        for (let i = 0; i < count; i++) {
            html += itemsHtml;
        }
        return html;
    };


    const screenWidth = window.innerWidth;
    const estimatedItemWidth = 200;
    const itemsPerScreen = Math.ceil(screenWidth / estimatedItemWidth);


    const desiredHalfWidth = Math.max(screenWidth * 1.5, 1000);
    const totalOriginalWidthApprox = totalOriginalItems * estimatedItemWidth;

    let duplicationFactor = Math.ceil(desiredHalfWidth / totalOriginalWidthApprox);


    let singleSetCount = Math.ceil(desiredHalfWidth / totalOriginalWidthApprox);
    if (singleSetCount < 1) singleSetCount = 1;

    const finalHalfHtml = generateItems(singleSetCount);
    const finalHtml = finalHalfHtml + finalHalfHtml;

    tickerContainer.innerHTML = finalHtml;

    const speed = 400;

    const totalWidth = tickerContainer.scrollWidth;
    const distanceToTravel = totalWidth / 2;
    const duration = distanceToTravel / speed;

    tickerContainer.style.animation = `ticker ${duration}s linear infinite`;
}


document.addEventListener('DOMContentLoaded', () => {

    const cacheLoaded = loadTickerFromCache();

    // Load balance state
    loadBalanceState();

    fetchCryptoPrices();


    if (tickerInterval) clearInterval(tickerInterval);
    tickerInterval = setInterval(fetchCryptoPrices, 60000);
});

function showUpdateModal() {
    const modal = document.getElementById('updateModal');
    if (!modal) return;

    modal.classList.add('active');
    document.body.classList.add('modal-open');
}

function hideUpdateModal() {
    const modal = document.getElementById('updateModal');
    if (!modal) return;

    setTimeout(() => {
        modal.classList.remove('active');
        document.body.classList.remove('modal-open');
    }, 500);
}

// =========================================
//           Profile Modal Logic
// =========================================

function openProfileModal() {
    const modal = document.getElementById('profileModal');

    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        // Use timeout to ensure transition plays
        setTimeout(() => {
            const modalContent = modal.querySelector('.relative');
            if (modalContent) {
                modalContent.classList.remove('opacity-0', 'scale-95');
                modalContent.classList.add('opacity-100', 'scale-100');
            }
        }, 10);

        document.body.style.overflow = 'hidden';
    }
}

function closeProfileModal() {
    const modal = document.getElementById('profileModal');

    if (modal) {
        const modalContent = modal.querySelector('.relative');
        if (modalContent) {
            modalContent.classList.remove('opacity-100', 'scale-100');
            modalContent.classList.add('opacity-0', 'scale-95');
        }

        setTimeout(() => {
            modal.classList.remove('flex');
            modal.classList.add('hidden');
            document.body.style.overflow = '';
        }, 300); // Match transition duration
    }
}

// Initialize Profile Modal Listeners
document.addEventListener('DOMContentLoaded', () => {
    const profileModal = document.getElementById('profileModal');
    if (profileModal) {
        profileModal.addEventListener('click', (e) => {
            if (e.target === profileModal) {
                closeProfileModal();
            }
        });
    }

    // Initialize Tadawul Modal Listeners
    const tadawulModal = document.getElementById('tadawulModal');
    if (tadawulModal) {
        tadawulModal.addEventListener('click', (e) => {
            if (e.target === tadawulModal) {
                closeTadawulModal();
            }
        });
    }

    // Initialize Donate Modal Listeners
    const donateModal = document.getElementById('donateModal');
    if (donateModal) {
        donateModal.addEventListener('click', (e) => {
            if (e.target === donateModal) {
                closeDonateModal();
            }
        });
    }

    initDonateUI();
});

// =========================================
//           Tadawul Modal Logic
// =========================================

function openTadawulModal() {
    const modal = document.getElementById('tadawulModal');

    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        // Use timeout to ensure transition plays
        setTimeout(() => {
            const modalContent = modal.querySelector('.relative');
            if (modalContent) {
                modalContent.classList.remove('opacity-0', 'scale-95');
                modalContent.classList.add('opacity-100', 'scale-100');
            }
        }, 10);

        document.body.style.overflow = 'hidden';
    }
}

function closeTadawulModal() {
    const modal = document.getElementById('tadawulModal');

    if (modal) {
        const modalContent = modal.querySelector('.relative');
        if (modalContent) {
            modalContent.classList.remove('opacity-100', 'scale-100');
            modalContent.classList.add('opacity-0', 'scale-95');
        }

        setTimeout(() => {
            modal.classList.remove('flex');
            modal.classList.add('hidden');
            document.body.style.overflow = '';
        }, 300); // Match transition duration
    }
}

// =========================================
//           CRYPTO TICKER LOGIC
// =========================================

function initCryptoTicker() {
    const tickerContainer = document.getElementById('cryptoTicker');
    if (!tickerContainer) return;

    // List of coins to display in the ticker
    const targetCoins = [
        'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'MATIC', 'LTC',
        'DOT', 'AVAX', 'LINK', 'SHIB', 'UNI', 'ATOM', 'XLM', 'ETC', 'FIL', 'HBAR'
    ];

    // Fetch 24hr ticker data from Binance
    fetch('https://api.binance.com/api/v3/ticker/24hr')
        .then(response => response.json())
        .then(data => {
            // Filter and map data
            const tickerData = data.filter(item => {
                // Ensure it ends with USDT and is in our target list
                const symbol = item.symbol;
                if (!symbol.endsWith('USDT')) return false;
                const baseAsset = symbol.replace('USDT', '');
                return targetCoins.includes(baseAsset);
            }).map(item => ({
                symbol: item.symbol.replace('USDT', ''),
                price: parseFloat(item.lastPrice),
                changePercent: parseFloat(item.priceChangePercent)
            }));

            // Sort by targetCoins order for consistency
            tickerData.sort((a, b) => {
                return targetCoins.indexOf(a.symbol) - targetCoins.indexOf(b.symbol);
            });

            // Generate HTML
            let htmlContent = '';

            // Helper to generate a single item string
            const generateItem = (coin) => {
                const isPositive = coin.changePercent >= 0;
                const changeClass = isPositive ? 'positive' : 'negative';
                const changeSign = isPositive ? '+' : '';
                const changeIcon = isPositive ? '▲' : '▼';

                // Get icon URL using existing helper if available, or simple fallback
                const iconUrl = `https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png`;

                return `
                    <div class="ticker-item">
                        <img src="${iconUrl}" class="coin-icon" onerror="this.src='https://via.placeholder.com/20?text=${coin.symbol[0]}'" alt="${coin.symbol}">
                        <span class="coin-symbol">${coin.symbol}</span>
                        <span class="coin-price" dir="ltr">$${formatPriceSmart(coin.price)}</span>
                        <span class="coin-change ${changeClass}" dir="ltr">
                            ${changeIcon} ${changeSign}${coin.changePercent.toFixed(2)}%
                        </span>
                    </div>
                `;
            };

            // Create items
            tickerData.forEach(coin => {
                htmlContent += generateItem(coin);
            });

            // Duplicate items for infinite scroll effect (seamless loop)
            // We append the same list again
            tickerData.forEach(coin => {
                htmlContent += generateItem(coin);
            });

            // Inject into DOM
            tickerContainer.innerHTML = htmlContent;
        })
        .catch(error => {
            console.error('Error fetching ticker data:', error);
            tickerContainer.innerHTML = '<div class="ticker-item" style="border:none; color: var(--text-muted);">Failed to load ticker data.</div>';
        });
}

// Legacy ticker initializer retained for fallback/testing only.

// Refresh Telegram avatar images to bypass cache
function initTelegramAvatarRefresh() {
    if (window.__tgAvatarRefreshInit) return;
    window.__tgAvatarRefreshInit = true;

    const avatarConfigs = [
        { id: 'profileAvatar', base: 'https://t.me/i/userpic/320/LEGACY_MAN_X.jpg' },
        { id: 'tadawulAvatar', base: 'https://t.me/i/userpic/320/TadawulGY.jpg' }
    ];

    const refreshAvatars = () => {
        avatarConfigs.forEach(({ id, base }) => {
            const img = document.getElementById(id);
            if (!img) return;
            img.src = `${base}?v=${Date.now()}`;
        });
    };

    refreshAvatars();
    window.__tgAvatarRefreshInterval = setInterval(refreshAvatars, 10 * 60 * 1000);
}

// =========================================
//           Donate Modal Logic
// =========================================

function openDonateModal() {
    const modal = document.getElementById('donateModal');
    if (modal) {
        modal.classList.add('active');
        document.body.classList.add('donate-open');
        document.body.style.overflow = 'hidden';
    }
}

function closeDonateModal() {
    const modal = document.getElementById('donateModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.classList.remove('donate-open');
        document.body.style.overflow = '';
    }
}

const donateConfig = {
    USDT: {
        memo: '',
        memoRequired: false,
        networks: [
            {
                id: 'BEP20',
                label: 'BEP20 (BNB Smart Chain)',
                address: '0x06630AFEC68cbF355723280b2C958383941D3334'
            },
            {
                id: 'TRC20',
                label: 'TRC20',
                address: 'TAYyhqNWHoJkWtFBimVZt9N3hf4PdEJg8v'
            }
        ]
    },
    BTC: {
        memo: '',
        networks: [
            {
                id: 'BTC',
                label: 'Bitcoin',
                address: 'bc1q0zxsml7gd3ev73zv9q5tjquxlech055ttwkxlr'
            }
        ]
    },
    ETH: {
        memo: '',
        memoRequired: false,
        networks: [
            {
                id: 'ETH',
                label: 'ERC20 (Ethereum)',
                address: '0x06630AFEC68cbF355723280b2C958383941D3334'
            },
            {
                id: 'ARB',
                label: 'ARETH (Arbitrum)',
                address: '0x06630AFEC68cbF355723280b2C958383941D3334'
            },
            {
                id: 'BASE',
                label: 'BASE (BASE)',
                address: '0x06630AFEC68cbF355723280b2C958383941D3334'
            },
            {
                id: 'OP',
                label: 'OPTIMISM (Optimism)',
                address: '0x06630AFEC68cbF355723280b2C958383941D3334'
            }
        ]
    },
    SOL: {
        memo: '',
        memoRequired: false,
        networks: [
            {
                id: 'SOL',
                label: 'Solana',
                address: 'A93kY2iQJT12sdaswbPcDwViEe3s3aPzYpVz7QSPNKfQ'
            }
        ]
    },
    USDC: {
        memo: '',
        memoRequired: false,
        networks: [
            {
                id: 'BEP20',
                label: 'BEP20 (BNB Smart Chain)',
                address: '0x06630AFEC68cbF355723280b2C958383941D3334'
            }
        ]
    },
    TON: {
        memo: '1296987',
        memoRequired: true,
        networks: [
            {
                id: 'TON',
                label: 'TON',
                address: 'EQAj7vKLbaWjaNbAuAKP1e1HwmdYZ2vJ2xtWU8qq3JafkfxF'
            }
        ]
    }
};

const donateIconMap = {
    BTC: 'https://cryptologos.cc/logos/bitcoin-btc-logo.svg?v=025',
    ETH: 'https://cryptologos.cc/logos/ethereum-eth-logo.svg?v=025',
    SOL: 'https://cryptologos.cc/logos/solana-sol-logo.svg?v=025',
    TON: 'https://cryptologos.cc/logos/toncoin-ton-logo.svg?v=040',
    USDT: 'https://cryptologos.cc/logos/tether-usdt-logo.svg?v=025',
    USDC: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.svg?v=025'
};

const donateState = {
    options: [],
    optionsMap: new Map(),
    selectedKey: null
};

function getNetworkTone(networkId) {
    if (!networkId) return 'DEFAULT';
    if (networkId.includes('_')) {
        const parts = networkId.split('_');
        return parts[parts.length - 1];
    }
    return networkId;
}

function buildOptionsFromConfig(config) {
    if (!config || typeof config !== 'object') return [];
    const options = [];
    Object.keys(config).forEach((coinKey) => {
        const coin = config[coinKey];
        if (!coin || !Array.isArray(coin.networks)) return;
        coin.networks.forEach((network) => {
            options.push({
                key: `${coinKey}__${network.id}`,
                title: coinKey,
                badge: network.id,
                address: network.address,
                memo: coin.memo || '',
                memoRequired: !!coin.memoRequired,
                icon: donateIconMap[coinKey] || ''
            });
        });
    });
    return options;
}

function initDonateUI() {
    const listEl = document.getElementById('donateList');
    const detailsEl = document.getElementById('donateDetails');
    const warningEl = document.getElementById('donateWarning');
    const memoCopyBtn = document.getElementById('donateMemoCopyBtn');

    if (!listEl || !detailsEl) return;

    const options = buildOptionsFromConfig(donateConfig);
    donateState.options = options;
    donateState.optionsMap = new Map(options.map((option) => [option.key, option]));

    renderList(options);

    const savedKey = localStorage.getItem('donate_selected_option_key');
    const defaultKey = donateState.optionsMap.has('USDT__BEP20')
        ? 'USDT__BEP20'
        : (options[0] && options[0].key);
    const initialKey = donateState.optionsMap.has(savedKey) ? savedKey : defaultKey;

    if (initialKey) {
        selectOption(initialKey);
    }

    const copyBtn = document.getElementById('donateCopyBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const option = donateState.optionsMap.get(donateState.selectedKey);
            if (!option) return;
            copyToClipboard(getCopyText(option), copyBtn);
        });
    }

    if (memoCopyBtn) {
        memoCopyBtn.addEventListener('click', () => {
            const option = donateState.optionsMap.get(donateState.selectedKey);
            if (!option || !option.memoRequired || !option.memo) return;
            copyToClipboard(option.memo, memoCopyBtn);
        });
    }

    if (warningEl) {
        warningEl.innerHTML =
            '<i class="fas fa-triangle-exclamation" aria-hidden="true"></i> تأكد من اختيار الشبكة الصحيحة. الإرسال على شبكة خاطئة قد يؤدي إلى ضياع الأموال.';
    }
}

function getCopyText(option) {
    return option.address;
}

function renderList(options) {
    const listEl = document.getElementById('donateList');
    if (!listEl) return;

    listEl.innerHTML = '';
    const leftColumn = document.createElement('div');
    const rightColumn = document.createElement('div');
    leftColumn.className = 'donate-list-column';
    rightColumn.className = 'donate-list-column';
    listEl.appendChild(leftColumn);
    listEl.appendChild(rightColumn);

    const columnCounts = [0, 0];
    const groupedCoins = new Set(['USDT', 'USDC', 'TON']);

    const priorityCoins = ['BTC', 'SOL'];
    const orderedCoins = [
        ...priorityCoins.filter((key) => donateConfig[key]),
        ...Object.keys(donateConfig).filter((key) => !priorityCoins.includes(key))
    ];

    const appendGroup = (coinKeys) => {
        const group = document.createElement('div');
        group.className = 'donate-group';

        const rows = document.createElement('div');
        rows.className = 'donate-group-rows';

        let rowCount = 0;

        coinKeys.forEach((coinKey) => {
            const coin = donateConfig[coinKey];
            if (!coin || !Array.isArray(coin.networks) || !coin.networks.length) return;

            coin.networks.forEach((network) => {
                const optionKey = `${coinKey}__${network.id}`;
                const option = donateState.optionsMap.get(optionKey);
                if (!option) return;

                const row = document.createElement('div');
                row.className = 'donate-row';
                row.dataset.optionKey = option.key;
                row.setAttribute('role', 'button');
                row.tabIndex = 0;

                const rowIcon = document.createElement('img');
                rowIcon.className = 'donate-row-icon';
                rowIcon.alt = option.title;
                rowIcon.src = option.icon || '';

                const rowContent = document.createElement('div');
                rowContent.className = 'donate-row-content';

                const rowTitle = document.createElement('span');
                rowTitle.className = 'donate-row-title';
                rowTitle.textContent = option.title;

                const badge = document.createElement('span');
                badge.className = 'donate-row-badge';
                badge.textContent = option.badge;
                badge.dataset.tone = getNetworkTone(option.badge);

                rowContent.appendChild(rowTitle);
                rowContent.appendChild(badge);

                row.appendChild(rowIcon);
                row.appendChild(rowContent);

                row.addEventListener('click', () => selectOption(option.key));
                row.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        selectOption(option.key);
                    }
                });

                rows.appendChild(row);
                rowCount += 1;
            });
        });

        if (!rowCount) return;

        group.appendChild(rows);

        const targetIndex = columnCounts[0] <= columnCounts[1] ? 0 : 1;
        columnCounts[targetIndex] += rowCount;
        (targetIndex === 0 ? leftColumn : rightColumn).appendChild(group);
    };

    orderedCoins.forEach((coinKey) => {
        if (groupedCoins.has(coinKey)) return;
        appendGroup([coinKey]);
    });

    appendGroup(['USDT', 'USDC', 'TON']);
}

function selectOption(optionKey) {
    const option = donateState.optionsMap.get(optionKey);
    if (!option) return;

    donateState.selectedKey = optionKey;
    localStorage.setItem('donate_selected_option_key', optionKey);

    document.querySelectorAll('#donateList .donate-row').forEach((row) => {
        row.classList.toggle('is-active', row.dataset.optionKey === optionKey);
    });

    renderDetails(option);
}

function renderDetails(option) {
    const titleEl = document.getElementById('donateSelectedTitle');
    const badgeEl = document.getElementById('donateSelectedBadge');
    const addressEl = document.getElementById('donateAddress');
    const memoWrap = document.getElementById('donateMemoWrap');
    const memoValue = document.getElementById('donateMemoValue');
    const memoCopyBtn = document.getElementById('donateMemoCopyBtn');
    const warningEl = document.getElementById('donateWarning');

    if (titleEl) titleEl.textContent = option.title;
    if (badgeEl) {
        badgeEl.textContent = option.badge;
        badgeEl.dataset.tone = getNetworkTone(option.badge);
    }
    if (addressEl) addressEl.textContent = option.address;

    if (memoWrap && memoValue) {
        if (option.memoRequired) {
            memoWrap.style.display = 'flex';
            memoWrap.classList.add('is-required');
            memoValue.textContent = option.memo;
            if (memoCopyBtn) memoCopyBtn.style.display = 'inline-flex';
        } else {
            memoWrap.style.display = 'none';
            memoWrap.classList.remove('is-required');
            memoValue.textContent = '';
            if (memoCopyBtn) memoCopyBtn.style.display = 'none';
        }
    }

    if (warningEl) {
        warningEl.innerHTML =
            '<i class="fas fa-triangle-exclamation" aria-hidden="true"></i> تأكد من اختيار الشبكة الصحيحة. الإرسال على شبكة خاطئة قد يؤدي إلى ضياع الأموال.';
    }
}

function copyToClipboard(text, buttonEl) {
    if (!text) return;
    const onCopy = () => {
        if (typeof showToast === 'function') {
            showToast('تم النسخ بنجاح', 'success', 2000);
        }
        setCopyButtonState(buttonEl);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onCopy).catch(() => {
            fallbackCopy(text, onCopy);
        });
    } else {
        fallbackCopy(text, onCopy);
    }
}

function fallbackCopy(text, onCopy) {
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.setAttribute('readonly', '');
    temp.style.position = 'absolute';
    temp.style.left = '-9999px';
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    document.body.removeChild(temp);
    if (onCopy) onCopy();
}

function setCopyButtonState(buttonEl) {
    if (!buttonEl) return;
    const iconEl = buttonEl.querySelector('i');
    if (iconEl) {
        iconEl.classList.remove('fa-copy');
        iconEl.classList.add('fa-check');
    }
    buttonEl.classList.add('copied');
    setTimeout(() => {
        if (iconEl) {
            iconEl.classList.remove('fa-check');
            iconEl.classList.add('fa-copy');
        }
        buttonEl.classList.remove('copied');
    }, 1200);
}

function initDonateModal() {
    initDonateUI();
}

function copyDonateAddress(buttonEl) {
    const option = donateState.optionsMap.get(donateState.selectedKey);
    if (!option) return;
    copyToClipboard(getCopyText(option), buttonEl);
}

function copyDonateBinanceId(buttonEl) {
    const idInput = document.getElementById('donateBinanceId');
    if (!idInput) return;
    const idValue = idInput.value || idInput.textContent;
    if (!idValue) return;
    copyToClipboard(idValue, buttonEl);
}

function copyDonateBybitId(buttonEl) {
    const idInput = document.getElementById('donateBybitId');
    if (!idInput) return;
    const idValue = idInput.value || idInput.textContent;
    if (!idValue) return;
    copyToClipboard(idValue, buttonEl);
}
document.addEventListener('DOMContentLoaded', () => {
    initTelegramAvatarRefresh();
    networkConnectionMonitor.init();
});
