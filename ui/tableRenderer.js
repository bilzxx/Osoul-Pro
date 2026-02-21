(function initSpotFeeTableRenderer(global) {
  'use strict';

  const SUMMARY_TABLE_COLUMN_COUNT = 9;

  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  function formatNumber(value, decimals) {
    const numeric = toNumber(value);
    if (typeof global.formatNumber === 'function') {
      return global.formatNumber(numeric, decimals);
    }
    return numeric.toFixed(decimals);
  }

  function formatUsd(value) {
    return `$ ${formatNumber(value, 4)}`;
  }

  function formatPercent(value) {
    return `${formatNumber(value * 100, 3)}%`;
  }

  function escapeHtml(input) {
    return String(input ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderFeesCell(summaryRow) {
    const fees = summaryRow?.fees || {};
    const buyFee = toNumber(fees.buyFee);
    const sellFee = toNumber(fees.sellFee);
    const totalFees = toNumber(fees.totalFees);
    const feeRate = toNumber(fees.feeRate);
    const exchangeName = escapeHtml(fees.exchangeName || '');
    const countryCode = escapeHtml(fees.countryCode || '');

    const tooltipParts = [
      exchangeName ? `المنصة: ${exchangeName}` : '',
      countryCode ? `البلد: ${countryCode}` : '',
      `النسبة المطبقة: ${formatPercent(feeRate)}`,
      `الإجمالي: ${formatUsd(totalFees)}`
    ].filter(Boolean);

    return `
      <div class="fees-cell" title="${escapeHtml(tooltipParts.join(' | '))}">
        <span class="fees-total-badge">
          <em>Fees:</em>
          <strong>${formatUsd(totalFees)}</strong>
        </span>
      </div>
    `;
  }

  global.spotFeeTableRenderer = Object.freeze({
    SUMMARY_TABLE_COLUMN_COUNT,
    renderFeesCell
  });
})(window);
