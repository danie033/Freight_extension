(function () {
  const STORAGE_AREA = chrome.storage.local;
  const SETTINGS_KEY = "datHelperSettings";
  const SELECTOR_KEY = "datHelperSelectorStrategy";
  const EXTENSION_ATTRIBUTE = "data-dat-helper";
  const LOG_PREFIX = "[DAT Helper]";
  const OBSERVER_DEBOUNCE_MS = 250;
  const HIDDEN_CLASS = "dat-helper-hidden";
  const MISSING_CLASS = "dat-helper-missing-data";
  const INLINE_BADGE_CLASS = "dat-helper-inline-badge";
  const STATUS_CLASS = "dat-helper-status";
  const DEBUG_OUTLINE_CLASS = "dat-helper-debug-outline";
  const DEBUG_PANEL_CLASS = "dat-helper-debug-panel";
  // Pre-hide pipeline classes:
  //   - PENDING_CLASS  : row has been seen by the observer but has not yet
  //                      cleared the eligible/filter checks.
  //   - PASSED_CLASS   : row has been verified to pass every filter and is the
  //                      only state in which the page-wide CSS guard allows it
  //                      to paint.
  //   - ACTIVE_CLASS   : set on <html> while the extension is enabled, which
  //                      activates the CSS guard rule in styles.css.
  const PENDING_CLASS = "dat-helper-pending";
  const PASSED_CLASS = "dat-helper-passed";
  const ACTIVE_CLASS = "dat-helper-active";
  const HELPER_CLASSES = [
    HIDDEN_CLASS,
    MISSING_CLASS,
    DEBUG_OUTLINE_CLASS,
    PENDING_CLASS,
    PASSED_CLASS
  ];
  const ROW_SUMMARY_CLASS = "dat-helper-row-summary";
  const ROW_SUMMARY_ROLE = "row-summary";

  const DEFAULT_SETTINGS = {
    enabled: false,
    minPrice: null,
    maxPrice: null,
    minRpm: null,
    maxRpm: null,
    minTripMiles: null,
    maxTripMiles: null
  };

  const PAGE_ROOT_BLOCKLIST = [
    "html",
    "body",
    "#root",
    "#app",
    "main",
    '[role="main"]',
    '[data-testid*="layout"]',
    '[data-testid*="page"]',
    '[data-testid*="search"]'
  ];

  const STABLE_SELECTOR_CANDIDATES = [
    '[data-testid]',
    '[aria-label]',
    '[role="row"]',
    '[role="gridcell"]',
    "article",
    "li",
    "tr"
  ];

  // These selectors come directly from template.html, which mirrors the DAT One results table.
  // If the live DAT layout changes, update these template selectors before widening fallback scans.
  const TEMPLATE_RESULTS_VIEWPORT_SELECTOR = '[data-test="results-table-body"]';
  const TEMPLATE_ROW_SELECTOR =
    '[data-test="results-table-body"] .cdk-virtual-scroll-content-wrapper > [id^="table-row-"].row-container';
  const TEMPLATE_FIELD_SELECTORS = {
    rateCell: '[data-test="load-rate-cell"]',
    tripCell: '[data-test="load-trip-cell"]',
    originCell: '[data-test="load-origin-cell"]',
    destinationCell: '[data-test="load-destination-cell"]',
    deadheadOriginCell: '[data-test="load-dho-cell"]',
    deadheadDestinationCell: '[data-test="load-dhd-cell"]',
    pickupCell: '[data-test="load-pick-up-cell"]'
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let currentSelectorStrategy = null;
  let observer = null;
  let observerActive = false;
  let debounceTimer = null;
  let isApplyingDomChanges = false;
  let lastDebugReport = null;
  let debugModeActive = false;
  let lastApplyTime = 0;
  let applyInProgress = false;
  let applyAgainRequested = false;
  let lastFilterHash = "";
  let lastCandidateSignature = "";
  let lastStatusText = "";
  let lastEnabledState = null;
  let displayDebugRowsLogged = 0;
  let milesDebugRowsLogged = 0;
  let rateDebugRowsLogged = 0;
  let noRateCheckRowsLogged = 0;
  let milesValidationLogged = false;
  const MIN_APPLY_INTERVAL_MS = 500;
  // `let` (not `const`) so the toggle pipeline can replace it with a fresh
  // WeakMap on every ON cycle — otherwise a row that was hidden in the
  // previous run would carry its stale "hidden" decision into the next run
  // and never get re-evaluated.
  let rowStateCache = new WeakMap();
  const rowSummaryMap = new WeakMap();
  // Tracks rows that have already been pushed through the per-row pipeline so
  // the observer can early-return on duplicate notifications without redoing
  // any DOM reads. The set is reset when filter settings change (the rows
  // need to be re-evaluated against the new filters).
  let processedRows = new WeakSet();

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function getPageText(element) {
    return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function getCleanRowText(row) {
    if (!(row instanceof HTMLElement)) {
      return "";
    }

    const clone = row.cloneNode(true);
    clone.querySelectorAll(`[${EXTENSION_ATTRIBUTE}="true"]`).forEach((element) => element.remove());
    return getPageText(clone);
  }

  function getCleanElementText(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    const clone = element.cloneNode(true);
    clone.querySelectorAll(`[${EXTENSION_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    return getPageText(clone);
  }

  function getCellText(cell) {
    return getCleanElementText(cell);
  }

  function getRowCells(row) {
    if (!(row instanceof HTMLElement)) {
      return [];
    }

    const explicitContainer = row.querySelector(".row-cells");
    const container =
      explicitContainer instanceof HTMLElement
        ? explicitContainer
        : [...row.children].find(
            (child) =>
              child instanceof HTMLElement &&
              child.children.length >= 3 &&
              [...child.children].some(
                (grandchild) =>
                  grandchild instanceof HTMLElement &&
                  (grandchild.classList.contains("table-cell") ||
                    grandchild.getAttribute("role") === "gridcell")
              )
          );
    const source = container instanceof HTMLElement ? container : row;

    return [...source.children].filter(
      (child) =>
        child instanceof HTMLElement &&
        isElementVisible(child) &&
        (child.classList.contains("table-cell") ||
          child.getAttribute("role") === "gridcell" ||
          Boolean(
            child.querySelector(
              [
                TEMPLATE_FIELD_SELECTORS.rateCell,
                TEMPLATE_FIELD_SELECTORS.tripCell,
                TEMPLATE_FIELD_SELECTORS.deadheadOriginCell,
                TEMPLATE_FIELD_SELECTORS.deadheadDestinationCell,
                TEMPLATE_FIELD_SELECTORS.pickupCell
              ].join(",")
            )
          ))
    );
  }

  function findCellBySelector(row, selector) {
    if (!(row instanceof HTMLElement) || !selector) {
      return null;
    }

    const directMatch = row.querySelector(selector);
    if (directMatch instanceof HTMLElement) {
      return directMatch;
    }

    return getRowCells(row).find((cell) => cell.querySelector(selector) instanceof HTMLElement) || null;
  }

  function findTripCell(row) {
    const explicitTripCell = findCellBySelector(row, TEMPLATE_FIELD_SELECTORS.tripCell);
    if (explicitTripCell) {
      return explicitTripCell;
    }

    const rowCells = getRowCells(row);
    const pickupIndex = rowCells.findIndex(
      (cell) => cell.querySelector(TEMPLATE_FIELD_SELECTORS.pickupCell) instanceof HTMLElement
    );
    const routeIndex = rowCells.findIndex((cell) => {
      const text = getCellText(cell);
      return (
        cell.querySelector(TEMPLATE_FIELD_SELECTORS.originCell) instanceof HTMLElement ||
        cell.querySelector(TEMPLATE_FIELD_SELECTORS.destinationCell) instanceof HTMLElement ||
        /\btrip\b/i.test(text)
      );
    });

    if (routeIndex >= 0) {
      return rowCells[routeIndex];
    }

    if (pickupIndex > 0) {
      return rowCells[pickupIndex - 1] || null;
    }

    return null;
  }

  function findHeaderCellByText(label) {
    const normalizedLabel = String(label || "").trim().toLowerCase();
    if (!normalizedLabel) {
      return null;
    }

    const headerCandidates = [
      ...document.querySelectorAll(
        '.header-cell, [role="columnheader"], [data-test$="-column-button"], [data-test$="-column-label"], [data-test*="column-button"], [data-test*="column-label"]'
      )
    ].filter((element) => element instanceof HTMLElement && isElementVisible(element));

    return (
      headerCandidates.find((element) => {
        const text = getCleanElementText(element).trim().toLowerCase();
        return text === normalizedLabel || text.startsWith(normalizedLabel);
      }) || null
    );
  }

  function findCellUnderHeader(row, headerLabel) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const header = findHeaderCellByText(headerLabel);
    if (!(header instanceof HTMLElement)) {
      return null;
    }

    const headerRect = header.getBoundingClientRect();
    const headerCenter = headerRect.left + headerRect.width / 2;
    const rowCells = getRowCells(row);

    let bestCell = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    rowCells.forEach((cell) => {
      const rect = cell.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return;
      }

      const center = rect.left + rect.width / 2;
      const distance = Math.abs(center - headerCenter);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCell = cell;
      }
    });

    return bestCell;
  }

  function findRateCell(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const explicitRateContent = row.querySelector(TEMPLATE_FIELD_SELECTORS.rateCell);
    if (explicitRateContent instanceof HTMLElement) {
      const rowCell =
        getRowCells(row).find(
          (cell) => cell === explicitRateContent || cell.contains(explicitRateContent)
        ) || explicitRateContent;
      return rowCell;
    }

    return findCellUnderHeader(row, "Rate");
  }

  function getRateCellText(row) {
    const rateCell = findRateCell(row);
    if (!(rateCell instanceof HTMLElement)) {
      return "";
    }

    return getCleanElementText(rateCell).trim();
  }

  function getVisibleRateColumnText(row) {
    const rateCell = findRateCell(row);
    if (rateCell) {
      return getCleanElementText(rateCell);
    }

    const rateHeader = findHeaderCellByText("Rate");
    if (!(rateHeader instanceof HTMLElement)) {
      return "";
    }

    const headerRect = rateHeader.getBoundingClientRect();
    const headerCenterX = headerRect.left + headerRect.width / 2;

    const cells = getRowCells(row)
      .filter((element) => element instanceof Element)
      .filter((element) => !element.matches(`[${EXTENSION_ATTRIBUTE}="true"]`))
      .filter((element) => !element.closest(`[${EXTENSION_ATTRIBUTE}="true"]`));

    let bestCell = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        continue;
      }

      const centerX = rect.left + rect.width / 2;
      const distance = Math.abs(centerX - headerCenterX);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCell = cell;
      }
    }

    return bestCell ? getCleanElementText(bestCell) : "";
  }

  function hasPostedRateInVisibleRateColumn(row) {
    const rateText = getVisibleRateColumnText(row);

    if (!rateText) {
      return false;
    }

    const cleaned = rateText.replace(/\s+/g, " ").trim();
    if (!cleaned) {
      return false;
    }

    if (/^[\-\u2013\u2014]+$/.test(cleaned)) {
      return false;
    }

    return /\$\s*\d{1,3}(?:,\d{3})+(?!\s*[*]?\s*\/\s*mi)|\$\s*\d{3,6}(?!\s*[*]?\s*\/\s*mi)/i.test(
      cleaned
    );
  }

  function findDhOriginCell(row) {
    const explicitDhOriginCell = findCellBySelector(row, TEMPLATE_FIELD_SELECTORS.deadheadOriginCell);
    if (explicitDhOriginCell) {
      return explicitDhOriginCell;
    }

    const rowCells = getRowCells(row);
    const tripCell = findTripCell(row);
    const tripIndex = rowCells.findIndex((cell) => cell === tripCell);
    const pickupIndex = rowCells.findIndex(
      (cell) => cell.querySelector(TEMPLATE_FIELD_SELECTORS.pickupCell) instanceof HTMLElement
    );

    if (tripIndex >= 0 && pickupIndex > tripIndex + 1) {
      return rowCells[tripIndex + 1] || null;
    }

    return null;
  }

  function findDhDropCell(row) {
    const explicitDhDropCell = findCellBySelector(row, TEMPLATE_FIELD_SELECTORS.deadheadDestinationCell);
    if (explicitDhDropCell) {
      return explicitDhDropCell;
    }

    const rowCells = getRowCells(row);
    const pickupIndex = rowCells.findIndex(
      (cell) => cell.querySelector(TEMPLATE_FIELD_SELECTORS.pickupCell) instanceof HTMLElement
    );

    if (pickupIndex > 0) {
      const tripCell = findTripCell(row);
      const originDhCell = findDhOriginCell(row);
      const candidate = rowCells[pickupIndex - 1];
      if (candidate && candidate !== tripCell && candidate !== originDhCell) {
        return candidate;
      }
    }

    return null;
  }

  function sampleText(text, limit = 220) {
    if (!text) {
      return "";
    }

    return text.length <= limit ? text : `${text.slice(0, limit)}...`;
  }

  function toNumber(value) {
    const numericValue = Number(String(value).replace(/[^\d.]/g, ""));
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDatHelperNode(node) {
    return Boolean(
      node instanceof Element &&
        (node.matches(`[${EXTENSION_ATTRIBUTE}="true"]`) ||
          node.closest(`[${EXTENSION_ATTRIBUTE}="true"]`))
    );
  }

  function isLikelyHelperNode(node) {
    return isDatHelperNode(node);
  }

  function mutationIsOnlyDatHelperChanges(mutation) {
    if (!mutation) {
      return false;
    }

    if (isDatHelperNode(mutation.target)) {
      return true;
    }

    const nodes = [...mutation.addedNodes, ...mutation.removedNodes].filter(
      (node) => node.nodeType === Node.ELEMENT_NODE
    );

    if (nodes.length && nodes.every((node) => isDatHelperNode(node))) {
      return true;
    }

    if (mutation.type === "attributes") {
      const attributeName = mutation.attributeName || "";
      if (mutation.target instanceof Element && attributeName.startsWith("data-dat-helper")) {
        return true;
      }

      if (mutation.target instanceof Element && attributeName === "class") {
        const before = new Set(String(mutation.oldValue || "").split(/\s+/).filter(Boolean));
        const after = new Set([...mutation.target.classList]);
        const changed = new Set(
          [...before, ...after].filter((className) => before.has(className) !== after.has(className))
        );
        return [...changed].every((className) => HELPER_CLASSES.includes(className));
      }
    }

    return false;
  }

  function normalizeStrategyName(name) {
    return String(name || "").replace(/^(saved:)+/, "");
  }

  function getFilterHash(settings) {
    return JSON.stringify({
      minPrice: settings.minPrice,
      maxPrice: settings.maxPrice,
      minRpm: settings.minRpm,
      maxRpm: settings.maxRpm,
      minTripMiles: settings.minTripMiles,
      maxTripMiles: settings.maxTripMiles
    });
  }

  function normalizeSettings(rawSettings) {
    return {
      enabled: Boolean(rawSettings?.enabled),
      minPrice: rawSettings?.minPrice ?? null,
      maxPrice: rawSettings?.maxPrice ?? null,
      minRpm: rawSettings?.minRpm ?? null,
      maxRpm: rawSettings?.maxRpm ?? null,
      minTripMiles: rawSettings?.minTripMiles ?? null,
      maxTripMiles: rawSettings?.maxTripMiles ?? null
    };
  }

  function getCandidateSignature(elements) {
    return elements
      .map((element) => element.id || buildDomPath(element))
      .join("|");
  }

  function logEnabledStateIfChanged(enabled) {
    if (lastEnabledState === enabled) {
      return;
    }

    lastEnabledState = enabled;
    log(enabled ? "extension enabled" : "extension disabled");
  }

  async function applyWithObserverPaused(fn) {
    const wasObserving = observerActive;
    if (wasObserving) {
      stopObserver();
    }

    try {
      return await fn();
    } finally {
      if (wasObserving && currentSettings.enabled) {
        startObserver();
      }
    }
  }

  function updateClassIfNeeded(element, className, shouldHaveClass) {
    if (!(element instanceof Element)) {
      return;
    }

    if (shouldHaveClass && !element.classList.contains(className)) {
      element.classList.add(className);
    }

    if (!shouldHaveClass && element.classList.contains(className)) {
      element.classList.remove(className);
    }
  }

  function hasEnoughSpace(element, minWidth = 220) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return Boolean(rect && rect.width >= minWidth);
  }

  function isBadPlacementTarget(element) {
    if (!(element instanceof HTMLElement)) {
      return true;
    }

    const text = getCleanElementText(element);
    if (/^\s*[–-]\s*$/.test(text)) {
      return false;
    }

    if (
      element.querySelector(TEMPLATE_FIELD_SELECTORS.rateCell) ||
      element.querySelector(TEMPLATE_FIELD_SELECTORS.tripCell) ||
      element.querySelector(TEMPLATE_FIELD_SELECTORS.deadheadOriginCell) ||
      element.querySelector(TEMPLATE_FIELD_SELECTORS.deadheadDestinationCell) ||
      element.querySelector(TEMPLATE_FIELD_SELECTORS.pickupCell) ||
      element.querySelector(TEMPLATE_FIELD_SELECTORS.originCell) ||
      element.querySelector(TEMPLATE_FIELD_SELECTORS.destinationCell)
    ) {
      return true;
    }

    return (
      /\$[\d,]+/.test(text) ||
      /\b\d+\s*(mi|miles)\b/i.test(text) ||
      /\bDH\b|Deadhead|Empty/i.test(text) ||
      /\d{1,2}\/\d{1,2}/.test(text)
    );
  }

  function isBlockedRootElement(element) {
    if (!(element instanceof HTMLElement)) {
      return true;
    }

    return PAGE_ROOT_BLOCKLIST.some((selector) => {
      try {
        return element.matches(selector);
      } catch (error) {
        return false;
      }
    });
  }

  function getElementDepth(element) {
    let depth = 0;
    let current = element;
    while (current && current.parentElement) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function getStructureSignature(element) {
    const classCount = element.classList?.length || 0;
    const childTags = [...element.children]
      .slice(0, 6)
      .map((child) => child.tagName)
      .join(",");
    return `${element.tagName}|${classCount}|${childTags}|${element.children.length}`;
  }

  function parsePrice(text) {
    if (!text) {
      return null;
    }

    const currencyMatches = [...text.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
      .map((match) => Number(match[1].replace(/,/g, "")))
      .filter((value) => Number.isFinite(value));

    if (currencyMatches.length) {
      return Math.max(...currencyMatches);
    }

    const labeledMatches = [
      /\brate\b[^\d]{0,16}([\d,]{3,})\b/i,
      /\b(?:offer|price|pay)\b[^\d]{0,16}([\d,]{3,})\b/i
    ];

    for (const pattern of labeledMatches) {
      const match = text.match(pattern);
      if (match) {
        return toNumber(match[1]);
      }
    }

    return null;
  }

  function parseRatePerMile(text) {
    if (!text) {
      return null;
    }

    const match = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)\s*\*?\s*\/\s*(?:mi|mile)\b/i);
    return match ? toNumber(match[1]) : null;
  }

  function parsePostedRateFromRateCell(row) {
    return parsePostedRateFromText(getVisibleRateColumnText(row));
  }

  function parsePostedRateFromText(text) {
    if (!text) {
      return null;
    }

    const cleaned = String(text).replace(/\s+/g, " ").trim();
    if (!cleaned || /^[\-\u2013\u2014]+$/.test(cleaned)) {
      return null;
    }

    const matches = [
      ...cleaned.matchAll(/\$\s*(\d{1,3}(?:,\d{3})+|\d{3,6})(?!\s*[*]?\s*\/\s*mi)/gi)
    ];
    if (!matches.length) {
      return null;
    }

    const parsed = Number(matches[0][1].replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parsePriceFromRateCell(row) {
    return parsePostedRateFromRateCell(row);
  }

  function parseMilesFromText(text, prioritizedPatterns) {
    if (!text) {
      return null;
    }

    for (const pattern of prioritizedPatterns) {
      const match = text.match(pattern);
      if (match) {
        const parsedValue = toNumber(match[1]);
        if (parsedValue != null) {
          return parsedValue;
        }
      }
    }

    const genericMiles = [...text.matchAll(/(\d[\d,]*)\s*(?:mi|miles)\b/gi)]
      .map((match) => toNumber(match[1]))
      .filter((value) => value != null);

    if (!genericMiles.length) {
      return null;
    }

    return Math.max(...genericMiles);
  }

  function parseTripMiles(text) {
    const compactMiles = String(text || "").trim().match(/^\(?\s*(\d[\d,]*)\s*\)?$/);
    if (compactMiles) {
      return toNumber(compactMiles[1]);
    }

    return parseMilesFromText(text, [
      /\btrip\b[^\d]{0,20}(\d[\d,]*)\s*(?:mi|miles)\b/i,
      /\bloaded\b[^\d]{0,20}(\d[\d,]*)\s*(?:mi|miles)\b/i,
      /\blength of haul\b[^\d]{0,20}(\d[\d,]*)\s*(?:mi|miles)\b/i,
      /\bhaul\b[^\d]{0,20}(\d[\d,]*)\s*(?:mi|miles)\b/i,
      /\broute\b[^\d]{0,20}(\d[\d,]*)\s*(?:mi|miles)\b/i
    ]);
  }

  function parseDhMilesFromCellText(text) {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) {
      return null;
    }

    const compactMiles = normalizedText.match(/^\(?\s*(\d[\d,]*)\s*(?:mi|miles)?\s*\)?$/i);
    if (compactMiles) {
      return toNumber(compactMiles[1]);
    }

    return null;
  }

  function parseOriginEmptyMiles(text, options = {}) {
    const { allowCompact = false } = options;
    const normalizedText = String(text || "").trim();

    if (allowCompact) {
      const compactMiles = parseDhMilesFromCellText(normalizedText);
      if (compactMiles != null) {
        return compactMiles;
      }
    }

    for (const pattern of [
      /\bDH-O\b[^\d]{0,12}(\d[\d,]*)\b/i,
      /\borigin\s+(?:dh|deadhead)\b[^\d]{0,20}(\d[\d,]*)\b/i,
      /\bpick(?:up)?\s+dh\b[^\d]{0,20}(\d[\d,]*)\b/i,
      /\bpickup\s+deadhead\b[^\d]{0,20}(\d[\d,]*)\b/i,
      /\bempty\s+pick\b[^\d]{0,20}(\d[\d,]*)\b/i
    ]) {
      const match = normalizedText.match(pattern);
      if (match) {
        return toNumber(match[1]);
      }
    }

    return null;
  }

  function parseDropEmptyMiles(text, options = {}) {
    const { allowCompact = false } = options;
    const normalizedText = String(text || "").trim();

    if (allowCompact) {
      const compactMiles = parseDhMilesFromCellText(normalizedText);
      if (compactMiles != null) {
        return compactMiles;
      }
    }

    for (const pattern of [
      /\bDH-D\b[^\d]{0,12}(\d[\d,]*)\b/i,
      /\bdestination\s+(?:dh|deadhead)\b[^\d]{0,20}(\d[\d,]*)\b/i,
      /\bdelivery\s+(?:dh|deadhead)\b[^\d]{0,20}(\d[\d,]*)\b/i,
      /\bdrop\s+(?:dh|deadhead|empty)\b[^\d]{0,20}(\d[\d,]*)\b/i
    ]) {
      const match = normalizedText.match(pattern);
      if (match) {
        return toNumber(match[1]);
      }
    }

    return null;
  }

  function parseEmptyMiles(text) {
    const originEmptyMiles = parseOriginEmptyMiles(text);
    return Number.isFinite(originEmptyMiles) ? originEmptyMiles : 0;
  }

  function calculateTotalMiles(tripMiles, originEmptyMiles, dropEmptyMiles) {
    if (!Number.isFinite(tripMiles) || tripMiles <= 0) {
      return null;
    }

    const origin = Number.isFinite(originEmptyMiles) ? originEmptyMiles : 0;
    const drop = Number.isFinite(dropEmptyMiles) ? dropEmptyMiles : 0;

    return tripMiles + origin + drop;
  }

  function logMilesDebugRow(loadData) {
    if (milesDebugRowsLogged >= 5) {
      return;
    }

    milesDebugRowsLogged += 1;
    console.log("[DAT Helper Miles]", `row ${milesDebugRowsLogged}`, {
      tripCellText: loadData.tripCellText || "",
      dhOriginCellText: loadData.dhOriginCellText || "",
      dhDropCellText: loadData.dhDropCellText || "",
      parsedTripMiles: loadData.tripMiles,
      parsedEmptyPickMiles: loadData.emptyPickMiles,
      parsedDropEmptyMiles: loadData.dropEmptyMiles,
      totalMiles: loadData.totalMiles
    });

    if (
      loadData.emptyPickMiles === 0 &&
      loadData.dropEmptyMiles === 0 &&
      Number.isFinite(loadData.tripMiles) &&
      Number.isFinite(loadData.totalMiles) &&
      loadData.totalMiles !== loadData.tripMiles
    ) {
      console.error("[DAT Helper Miles] ERROR total mismatch when empty miles are zero", {
        tripMiles: loadData.tripMiles,
        emptyPickMiles: loadData.emptyPickMiles,
        dropEmptyMiles: loadData.dropEmptyMiles,
        totalMiles: loadData.totalMiles,
        tripCellText: loadData.tripCellText || "",
        dhOriginCellText: loadData.dhOriginCellText || "",
        dhDropCellText: loadData.dhDropCellText || ""
      });
    }
  }

  function logRateDebugRow(loadData, filterResult) {
    if (rateDebugRowsLogged >= 10) {
      return;
    }

    rateDebugRowsLogged += 1;
    console.log("[DAT Helper Rate]", `row ${rateDebugRowsLogged}`, {
      rateCellText: loadData.rateCellText || "",
      parsedPrice: loadData.price,
      tripMiles: loadData.tripMiles,
      rpm: loadData.rpm,
      baseEligible: Boolean(filterResult?.baseEligible),
      hiddenReason: filterResult?.hiddenReason || ""
    });
  }

  function logNoRateCheckRow(rowIndex, rateText, hasPostedRate, parsedPrice, action, reason) {
    if (noRateCheckRowsLogged >= 20) {
      return;
    }

    noRateCheckRowsLogged += 1;
    console.log("[DAT Helper No Rate Check]", {
      rowIndex,
      rateText,
      hasPostedRate,
      parsedPrice,
      action,
      reason
    });
  }

  function runMilesParsingValidationOnce() {
    if (milesValidationLogged) {
      return;
    }

    milesValidationLogged = true;

    const cases = [
      {
        name: "Case 1",
        tripMiles: 471,
        dhOriginCellText: "",
        dhDropCellText: "",
        expected: { emptyPickMiles: 0, dropEmptyMiles: 0, totalMiles: 471 }
      },
      {
        name: "Case 2",
        tripMiles: 471,
        dhOriginCellText: "(350)",
        dhDropCellText: "",
        expected: { emptyPickMiles: 350, dropEmptyMiles: 0, totalMiles: 821 }
      },
      {
        name: "Case 3",
        tripMiles: 471,
        dhOriginCellText: "350",
        dhDropCellText: "150",
        expected: { emptyPickMiles: 350, dropEmptyMiles: 150, totalMiles: 971 }
      },
      {
        name: "Case 4",
        tripMiles: 471,
        dhOriginCellText: "",
        dhDropCellText: "",
        rowText: "(205) 617-1288",
        expected: { emptyPickMiles: 0, dropEmptyMiles: 0, totalMiles: 471 }
      },
      {
        name: "Case 5",
        tripMiles: 471,
        dhOriginCellText: "",
        dhDropCellText: "",
        rowText: "97 CS 18 DTP",
        expected: { emptyPickMiles: 0, dropEmptyMiles: 0, totalMiles: 471 }
      }
    ];

    const results = cases.map((testCase) => {
      const emptyPickMiles =
        parseOriginEmptyMiles(testCase.dhOriginCellText, { allowCompact: true }) ??
        parseOriginEmptyMiles(testCase.rowText || "") ??
        0;
      const dropEmptyMiles =
        parseDropEmptyMiles(testCase.dhDropCellText, { allowCompact: true }) ??
        parseDropEmptyMiles(testCase.rowText || "") ??
        0;
      const totalMiles = calculateTotalMiles(testCase.tripMiles, emptyPickMiles, dropEmptyMiles);

      return {
        name: testCase.name,
        pass:
          emptyPickMiles === testCase.expected.emptyPickMiles &&
          dropEmptyMiles === testCase.expected.dropEmptyMiles &&
          totalMiles === testCase.expected.totalMiles,
        expected: testCase.expected,
        actual: { emptyPickMiles, dropEmptyMiles, totalMiles }
      };
    });

    log("miles parsing validation", results);
  }

  function calculateRpm(price, tripMiles) {
    if (!Number.isFinite(price) || !Number.isFinite(tripMiles) || tripMiles <= 0) {
      return null;
    }

    return price / tripMiles;
  }

  function calculateAllInRpm(price, totalMiles) {
    if (!Number.isFinite(price) || !Number.isFinite(totalMiles) || totalMiles <= 0) {
      return null;
    }

    return price / totalMiles;
  }

  function calculateTotalRpm(price, totalMiles) {
    return calculateAllInRpm(price, totalMiles);
  }

  function extractLoadData(element) {
    const rawText = getCleanRowText(element);
    const rateCell = findRateCell(element);
    const tripCell = findTripCell(element);
    const deadheadOriginCell = findDhOriginCell(element);
    const deadheadDestinationCell = findDhDropCell(element);
    const originCell = element.querySelector(TEMPLATE_FIELD_SELECTORS.originCell);
    const destinationCell = element.querySelector(TEMPLATE_FIELD_SELECTORS.destinationCell);

    const rateText = getRateCellText(element);
    const tripText = getCellText(tripCell);
    const deadheadOriginText = getCellText(deadheadOriginCell);
    const deadheadDestinationText = getCellText(deadheadDestinationCell);
    const price = parsePriceFromRateCell(element);
    const tripMiles = parseTripMiles(tripText) ?? parseTripMiles(rawText);
    const originEmptyMilesRaw =
      parseOriginEmptyMiles(deadheadOriginText, { allowCompact: true }) ??
      (!deadheadOriginCell ? parseOriginEmptyMiles(rawText) : null);
    const dropEmptyMilesRaw =
      parseDropEmptyMiles(deadheadDestinationText, { allowCompact: true }) ??
      (!deadheadDestinationCell ? parseDropEmptyMiles(rawText) : null);
    const originEmptyMiles = Number.isFinite(originEmptyMilesRaw) ? originEmptyMilesRaw : 0;
    const dropEmptyMiles = Number.isFinite(dropEmptyMilesRaw) ? dropEmptyMilesRaw : 0;
    const emptyMiles = originEmptyMiles;
    const totalMiles = calculateTotalMiles(tripMiles, originEmptyMiles, dropEmptyMiles);
    const rpm = calculateRpm(price, tripMiles);
    const totalRpm = calculateTotalRpm(price, totalMiles);
    const allInRpm = totalRpm;
    const displayedRpm = parseRatePerMile(rateText);

    const loadData = {
      element,
      price,
      tripMiles,
      emptyPickMiles: originEmptyMiles,
      originEmptyMiles,
      dropEmptyMiles,
      emptyMiles,
      totalMiles,
      rpm,
      totalRpm,
      allInRpm,
      rawText,
      rateCellText: rateText,
      tripCellText: tripText,
      dhOriginCellText: deadheadOriginText,
      dhDropCellText: deadheadDestinationText,
      displayedRpm,
      origin: getPageText(originCell),
      destination: getPageText(destinationCell)
    };

    logMilesDebugRow(loadData);
    return loadData;
  }

  function hasPriceLikeText(text) {
    return /\$\s*[\d,]+/.test(text) || /\b(?:rate|offer|pay)\b/i.test(text);
  }

  function hasMilesLikeText(text) {
    return (
      /\b\d[\d,]*\s*(?:mi|miles)\b/i.test(text) ||
      /\(\s*\d[\d,]*\s*\)/.test(text)
    );
  }

  function hasFreightLikeText(text) {
    return /\b(?:deadhead|empty|dh|pickup|origin|destination|length of haul|rpm)\b/i.test(text);
  }

  function analyzeCandidateElement(element) {
    const text = getCleanRowText(element);
    const textLength = text.length;
    const nestedLikelyLoads = [...element.querySelectorAll("article, li, tr, [role='row'], [data-testid], [aria-label]")]
      .filter((node) => node !== element && node instanceof HTMLElement && hasPriceLikeText(getPageText(node)) && hasMilesLikeText(getPageText(node)))
      .length;
    const clickableChildren = element.querySelectorAll("button,a,[role='button']").length;
    const hasTemplateRateCell = Boolean(element.querySelector(TEMPLATE_FIELD_SELECTORS.rateCell));
    const hasTemplateTripCell = Boolean(element.querySelector(TEMPLATE_FIELD_SELECTORS.tripCell));
    const hasTemplateOriginCell = Boolean(element.querySelector(TEMPLATE_FIELD_SELECTORS.originCell));
    const priceLike = hasPriceLikeText(text);
    const milesLike = hasMilesLikeText(text) || hasTemplateTripCell;
    const freightLike = hasFreightLikeText(text);

    const reasons = [];
    let score = 0;

    if (!isElementVisible(element)) {
      reasons.push("rejected: not visible");
      return { accepted: false, score, reasons, textLength, nestedLikelyLoads };
    }

    if (isBlockedRootElement(element)) {
      reasons.push("rejected: blocked root element");
      return { accepted: false, score, reasons, textLength, nestedLikelyLoads };
    }

    if (textLength <= 40) {
      reasons.push("rejected: text too short");
      return { accepted: false, score, reasons, textLength, nestedLikelyLoads };
    }

    if (textLength >= 2500) {
      reasons.push("rejected: text too large");
      return { accepted: false, score, reasons, textLength, nestedLikelyLoads };
    }

    if (!priceLike && !/\$\d+\.\d{2}\s*\/\s*(?:mi|mile)/i.test(text)) {
      reasons.push("rejected: no price-like or rate-like text");
      return { accepted: false, score, reasons, textLength, nestedLikelyLoads };
    }

    if (!milesLike) {
      reasons.push("rejected: no miles-like text");
      return { accepted: false, score, reasons, textLength, nestedLikelyLoads };
    }

    if (nestedLikelyLoads > 3) {
      reasons.push(`rejected: contains ${nestedLikelyLoads} nested likely load elements`);
      return { accepted: false, score, reasons, textLength, nestedLikelyLoads };
    }

    score += 4;
    reasons.push("accepted: has price-like text");

    score += 4;
    reasons.push("accepted: has miles-like text");

    if (hasTemplateRateCell && hasTemplateTripCell) {
      score += 6;
      reasons.push("accepted: matches template rate/trip cell layout");
    }

    if (hasTemplateOriginCell) {
      score += 2;
      reasons.push("accepted: matches template origin/destination cell layout");
    }

    if (freightLike) {
      score += 2;
      reasons.push("accepted: freight-like labels detected");
    }

    if (clickableChildren > 0 && clickableChildren < 10) {
      score += 1;
      reasons.push("accepted: has local interactive controls");
    }

    if (textLength > 80 && textLength < 900) {
      score += 2;
      reasons.push("accepted: text length in expected card range");
    }

    score += Math.max(0, 4 - nestedLikelyLoads);

    return {
      accepted: true,
      score,
      reasons,
      textLength,
      nestedLikelyLoads
    };
  }

  function getTemplateRowStrategyCandidates() {
    const elements = [...document.querySelectorAll(TEMPLATE_ROW_SELECTOR)].filter(
      (element) =>
        element instanceof HTMLElement &&
        element.closest(TEMPLATE_RESULTS_VIEWPORT_SELECTOR) &&
        analyzeCandidateElement(element).accepted
    );

    if (elements.length >= 2) {
      return [
        {
          name: "template-results-row",
          strategySource: "template",
          type: "template-row",
          selector: TEMPLATE_ROW_SELECTOR,
          // This uses DAT One's row id pattern and row container class seen in template.html.
          // If DAT changes the markup, update TEMPLATE_ROW_SELECTOR first before broadening the scan.
          elements: dedupeToSmallestElements(elements),
          score: elements.length * 20
        }
      ];
    }

    return [];
  }

  function dedupeToSmallestElements(elements) {
    const unique = [...new Set(elements)].filter((element) => element instanceof HTMLElement);
    return unique.filter((element) => {
      return !unique.some(
        (other) =>
          other !== element &&
          other.contains(element) &&
          getCleanRowText(other).length >= getCleanRowText(element).length
      );
    });
  }

  function getStableSelectorStrategyCandidates() {
    const strategies = [];

    for (const selector of STABLE_SELECTOR_CANDIDATES) {
      const matches = [...document.querySelectorAll(selector)].filter(
        (element) => element instanceof HTMLElement && !isBlockedRootElement(element)
      );

      const accepted = matches.filter((element) => analyzeCandidateElement(element).accepted);
      if (accepted.length >= 2) {
        const score = accepted.reduce((sum, element) => sum + analyzeCandidateElement(element).score, 0);
        strategies.push({
          name: `stable-selector:${selector}`,
          strategySource: "scan",
          type: "selector",
          selector,
          elements: dedupeToSmallestElements(accepted),
          score
        });
      }
    }

    return strategies;
  }

  function getRepeatedSiblingStrategies() {
    const strategies = [];
    const containers = [...document.querySelectorAll("main, section, div, ul, ol, tbody")]
      .filter((element) => element instanceof HTMLElement && isElementVisible(element));

    containers.forEach((container, containerIndex) => {
      const children = [...container.children].filter(
        (child) => child instanceof HTMLElement && isElementVisible(child) && !isLikelyHelperNode(child)
      );

      if (children.length < 2 || children.length > 120) {
        return;
      }

      const groups = new Map();

      children.forEach((child) => {
        const signature = getStructureSignature(child);
        const group = groups.get(signature) || [];
        group.push(child);
        groups.set(signature, group);
      });

      groups.forEach((group, signature) => {
        if (group.length < 2) {
          return;
        }

        const accepted = group.filter((element) => analyzeCandidateElement(element).accepted);
        if (accepted.length < 2) {
          return;
        }

        const score =
          accepted.reduce((sum, element) => sum + analyzeCandidateElement(element).score, 0) +
          Math.min(accepted.length, 8) * 2;

        strategies.push({
          name: `repeated-siblings:${container.tagName.toLowerCase()}:${signature}:${containerIndex}`,
          strategySource: "scan",
          type: "repeated-siblings",
          parentTag: container.tagName.toLowerCase(),
          parentPath: buildDomPath(container),
          elements: dedupeToSmallestElements(accepted),
          score
        });
      });
    });

    return strategies;
  }

  function buildDomPath(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    const parts = [];
    let current = element;

    while (current && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }

      const dataTestId = current.getAttribute("data-testid");
      const role = current.getAttribute("role");
      if (dataTestId) {
        part += `[data-testid="${dataTestId}"]`;
      } else if (role) {
        part += `[role="${role}"]`;
      } else if (current.classList.length) {
        part += `.${[...current.classList].slice(0, 2).join(".")}`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function applyStrategyObject(strategy) {
    if (!strategy) {
      return [];
    }

    if (strategy.type === "selector" && strategy.selector) {
      const elements = [...document.querySelectorAll(strategy.selector)].filter(
        (element) => element instanceof HTMLElement && analyzeCandidateElement(element).accepted
      );
      return dedupeToSmallestElements(elements);
    }

    if (strategy.type === "template-row" && strategy.selector) {
      const elements = [...document.querySelectorAll(strategy.selector)].filter(
        (element) =>
          element instanceof HTMLElement &&
          element.closest(TEMPLATE_RESULTS_VIEWPORT_SELECTOR) &&
          analyzeCandidateElement(element).accepted
      );
      return dedupeToSmallestElements(elements);
    }

    if (strategy.type === "repeated-siblings" && strategy.parentPath) {
      const parents = [...document.querySelectorAll(strategy.parentTag || "div")].filter(
        (element) => buildDomPath(element) === strategy.parentPath
      );

      if (parents.length) {
        const elements = parents.flatMap((parent) =>
          [...parent.children].filter(
            (child) => child instanceof HTMLElement && analyzeCandidateElement(child).accepted
          )
        );
        return dedupeToSmallestElements(elements);
      }
    }

    return [];
  }

  function compareStrategy(a, b) {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    const aAverageText = getAverageTextLength(a.elements);
    const bAverageText = getAverageTextLength(b.elements);
    if (aAverageText !== bAverageText) {
      return aAverageText - bAverageText;
    }

    return getAverageDepth(b.elements) - getAverageDepth(a.elements);
  }

  function getAverageTextLength(elements) {
    if (!elements.length) {
      return 0;
    }

    return Math.round(
      elements.reduce((sum, element) => sum + getCleanRowText(element).length, 0) / elements.length
    );
  }

  function getAverageDepth(elements) {
    if (!elements.length) {
      return 0;
    }

    return Math.round(
      elements.reduce((sum, element) => sum + getElementDepth(element), 0) / elements.length
    );
  }

  function isSafeCandidateSet(elements) {
    const unique = dedupeToSmallestElements(elements);
    const diagnostics = [];

    if (!unique.length) {
      diagnostics.push("unsafe: no candidates found");
      return { safe: false, diagnostics };
    }

    if (
      unique.some(
        (element) =>
          isBlockedRootElement(element) ||
          element === document.body ||
          element === document.documentElement
      )
    ) {
      diagnostics.push("unsafe: blocked root element present in candidate set");
      return { safe: false, diagnostics };
    }

    const textLengths = unique.map((element) => getPageText(element).length);
    const averageTextLength = getAverageTextLength(unique);
    const maxTextLength = Math.max(...textLengths);
    const nestedCounts = unique.map((element) =>
      unique.filter((other) => other !== element && element.contains(other)).length
    );
    const nestedTooHigh = nestedCounts.some((count) => count > 2);

    if (unique.length === 1 && maxTextLength > 900) {
      diagnostics.push("unsafe: only one huge candidate found");
      return { safe: false, diagnostics };
    }

    if (averageTextLength > 1000) {
      diagnostics.push(`unsafe: average text length too high (${averageTextLength})`);
      return { safe: false, diagnostics };
    }

    if (nestedTooHigh) {
      diagnostics.push("unsafe: candidates contain many nested candidates");
      return { safe: false, diagnostics };
    }

    if (unique.length <= 2 && averageTextLength > 700) {
      diagnostics.push("unsafe: candidate set resembles a results wrapper");
      return { safe: false, diagnostics };
    }

    diagnostics.push("safe: candidate set passed wrapper checks");
    return { safe: true, diagnostics };
  }

  async function getCandidateLoadElements(options = {}) {
    const { allowFullScan = false } = options;
    const candidateStrategies = [];
    const rejectionNotes = [];

    if (currentSelectorStrategy) {
      const savedElements = applyStrategyObject(currentSelectorStrategy);
      if (savedElements.length >= 2) {
        candidateStrategies.push({
          ...currentSelectorStrategy,
          name: normalizeStrategyName(currentSelectorStrategy.name),
          strategySource: "saved",
          elements: savedElements,
          score: currentSelectorStrategy.score || savedElements.length * 8
        });
      } else {
        rejectionNotes.push("saved strategy found but did not produce enough candidates");
      }
    }

    candidateStrategies.push(...getTemplateRowStrategyCandidates());
    if (allowFullScan || (!currentSelectorStrategy && candidateStrategies.length === 0)) {
      candidateStrategies.push(...getStableSelectorStrategyCandidates());
      candidateStrategies.push(...getRepeatedSiblingStrategies());
    }

    const filteredStrategies = candidateStrategies
      .map((strategy) => {
        const uniqueElements = dedupeToSmallestElements(strategy.elements);
        return {
          ...strategy,
          elements: uniqueElements,
          safety: isSafeCandidateSet(uniqueElements)
        };
      })
      .filter((strategy) => strategy.elements.length >= 2);

    filteredStrategies.sort(compareStrategy);

    const selectedStrategy =
      filteredStrategies.find((strategy) => strategy.safety.safe) || filteredStrategies[0] || null;

    if (!selectedStrategy) {
      return {
        elements: [],
        strategyName: "none",
        strategy: null,
        diagnostics: rejectionNotes.concat("no candidate strategy produced a usable set"),
        safeResult: { safe: false, diagnostics: ["unsafe: no candidate strategy selected"] },
        alternatives: []
      };
    }

    return {
      elements: selectedStrategy.elements,
      strategyName: normalizeStrategyName(selectedStrategy.name),
      strategySource: selectedStrategy.strategySource || "detected",
      strategy: selectedStrategy,
      diagnostics: rejectionNotes,
      safeResult: selectedStrategy.safety,
      alternatives: filteredStrategies.slice(0, 5)
    };
  }

  function getActiveFilterDefinitions(settings) {
    return [
      { key: "price", min: settings.minPrice, max: settings.maxPrice, label: "price" },
      { key: "rpm", min: settings.minRpm, max: settings.maxRpm, label: "RPM" },
      { key: "tripMiles", min: settings.minTripMiles, max: settings.maxTripMiles, label: "trip miles" }
    ].filter((filter) => filter.min != null || filter.max != null);
  }

  function isBaseEligibleLoad(loadData) {
    return (
      Number.isFinite(loadData.price) &&
      loadData.price > 0 &&
      Number.isFinite(loadData.tripMiles) &&
      loadData.tripMiles > 0 &&
      Number.isFinite(loadData.rpm) &&
      loadData.rpm > 0
    );
  }

  function evaluateFilters(loadData, settings) {
    if (!isBaseEligibleLoad(loadData)) {
      return { visible: false, missingFields: [], hiddenReason: "missing-rate-or-rpm", baseEligible: false };
    }

    const activeFilters = getActiveFilterDefinitions(settings);

    for (const filter of activeFilters) {
      const value = loadData[filter.key];
      if (filter.min != null && value < filter.min) {
        return {
          visible: false,
          missingFields: [],
          hiddenReason:
            filter.key === "price"
              ? "failed-price-filter"
              : filter.key === "rpm"
                ? "failed-rpm-filter"
                : "failed-trip-filter",
          baseEligible: true
        };
      }

      if (filter.max != null && value > filter.max) {
        return {
          visible: false,
          missingFields: [],
          hiddenReason:
            filter.key === "price"
              ? "failed-price-filter"
              : filter.key === "rpm"
                ? "failed-rpm-filter"
                : "failed-trip-filter",
          baseEligible: true
        };
      }
    }

    return { visible: true, missingFields: [], hiddenReason: "", baseEligible: true };
  }

  function formatMiles(value) {
    return Number.isFinite(value) ? `${Math.round(value)} mi` : "n/a";
  }

  function formatRpm(value) {
    return Number.isFinite(value) ? `$${value.toFixed(2)}/mi` : "n/a";
  }

  function clearExtensionClasses() {
    document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((element) => {
      updateClassIfNeeded(element, HIDDEN_CLASS, false);
    });

    document.querySelectorAll(`.${MISSING_CLASS}`).forEach((element) => {
      updateClassIfNeeded(element, MISSING_CLASS, false);
    });

    document.querySelectorAll(`.${DEBUG_OUTLINE_CLASS}`).forEach((element) => {
      updateClassIfNeeded(element, DEBUG_OUTLINE_CLASS, false);
    });

    document.querySelectorAll(`.${PENDING_CLASS}`).forEach((element) => {
      updateClassIfNeeded(element, PENDING_CLASS, false);
    });

    document.querySelectorAll(`.${PASSED_CLASS}`).forEach((element) => {
      updateClassIfNeeded(element, PASSED_CLASS, false);
    });

    document.querySelectorAll(".dat-helper-company-cell").forEach((element) => {
      updateClassIfNeeded(element, "dat-helper-company-cell", false);
    });
  }

  function clearExtensionNodes() {
    document
      .querySelectorAll(`[${EXTENSION_ATTRIBUTE}="true"]`)
      .forEach((element) => element.remove());
  }

  function cleanupExtensionDom() {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    debugModeActive = false;
    const wasObserving = observerActive;
    if (wasObserving) {
      stopObserver();
    }
    try {
      clearExtensionClasses();
      clearExtensionNodes();
      document.querySelectorAll("[data-dat-helper-original-position]").forEach((row) => {
        if (row instanceof HTMLElement) {
          row.style.position = row.dataset.datHelperOriginalPosition || "";
          delete row.dataset.datHelperOriginalPosition;
        }
      });
      // Drop the page-wide CSS guard so DAT renders normally when the
      // extension is OFF. Also reset every per-row tracker — next enable
      // must see every row as fresh and re-run the full pipeline against
      // it, instead of reusing cached "this row was hidden last time"
      // state from before the toggle.
      setHelperActive(false);
      processedRows = new WeakSet();
      rowStateCache = new WeakMap();
      // The clearExtensionNodes() call above removed the previous badge along
      // with every other extension-owned node. Re-render so the user sees
      // the OFF state instead of a missing badge.
      renderStatus();
    } finally {
      if (wasObserving && currentSettings.enabled) {
        startObserver();
      }
    }
  }

  function findAnchor(element, patterns) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
    const matches = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof HTMLElement) || isLikelyHelperNode(node)) {
        continue;
      }

      const text = getPageText(node);
      if (!text || text.length > 120) {
        continue;
      }

      if (patterns.some((pattern) => pattern.test(text))) {
        matches.push(node);
      }
    }

    return matches.sort((left, right) => getPageText(left).length - getPageText(right).length)[0] || null;
  }

  function createHelperNode(tagName, className) {
    const node = document.createElement(tagName);
    node.className = className;
    node.setAttribute(EXTENSION_ATTRIBUTE, "true");
    return node;
  }

  function removeLegacyInlineBadges(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    row
      .querySelectorAll(
        [
          '[data-dat-helper-role="inline-badge"]',
          '[data-dat-helper-role="rate-badge"]',
          '[data-dat-helper-role="trip-badge"]',
          '[data-dat-helper-role="miles-badge"]'
        ].join(",")
      )
      .forEach((node) => node.remove());
  }

  function findRowSummaryPlacementTarget(row) {
    if (!(row instanceof HTMLElement)) {
      return { target: null, mode: "none" };
    }

    const cells = [...row.querySelectorAll(".table-cell")].filter((cell) => cell instanceof HTMLElement);
    const trailingCell = [...cells]
      .reverse()
      .find((cell) => /^\s*[–-]\s*$/.test(getCleanElementText(cell)) && hasEnoughSpace(cell, 120));
    if (trailingCell) {
      return { target: trailingCell, mode: "trailing-dash" };
    }

    const safeTrailingCell = [...cells]
      .reverse()
      .find((cell) => !isBadPlacementTarget(cell) && hasEnoughSpace(cell, 220));
    if (safeTrailingCell) {
      return { target: safeTrailingCell, mode: "trailing-cell" };
    }

    const companyCell = row
      .querySelector('[data-test="load-company-cell"]')
      ?.closest(".table-cell");
    if (companyCell instanceof HTMLElement && !isBadPlacementTarget(companyCell) && hasEnoughSpace(companyCell, 220)) {
      return { target: companyCell, mode: "company-cell" };
    }

    const rowCells = row.querySelector(".row-cells");
    if (rowCells instanceof HTMLElement && hasEnoughSpace(rowCells, 280)) {
      return { target: rowCells, mode: "row-end" };
    }

    return { target: row, mode: "floating" };
  }

  function buildRowSummaryText(loadData, compactLevel) {
    const totalText = Number.isFinite(loadData.totalMiles)
      ? String(Math.round(loadData.totalMiles))
      : "n/a";
    const rpmText = Number.isFinite(loadData.rpm) ? loadData.rpm.toFixed(2) : "n/a";
    const allInText = Number.isFinite(loadData.allInRpm) ? loadData.allInRpm.toFixed(2) : "n/a";

    if (compactLevel >= 2) {
      return `T ${totalText} | R ${rpmText} | AI ${allInText}`;
    }

    if (compactLevel === 1) {
      return `Total ${totalText} | RPM ${rpmText} | All-in ${allInText}`;
    }

    return `Total ${totalText} mi | RPM $${rpmText}/mi | All-in $${allInText}/mi`;
  }

  function renderRowSummaryIdempotently(row, loadData) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    removeLegacyInlineBadges(row);

    const shouldShow =
      Number.isFinite(loadData.totalMiles) ||
      Number.isFinite(loadData.rpm) ||
      Number.isFinite(loadData.allInRpm);
    const existing = row.querySelector(
      `[${EXTENSION_ATTRIBUTE}="true"][data-dat-helper-role="${ROW_SUMMARY_ROLE}"]`
    );

    if (!shouldShow) {
      existing?.remove();
      return;
    }

    const nextHash = [
      loadData.totalMiles ?? "",
      Number.isFinite(loadData.rpm) ? loadData.rpm.toFixed(2) : "",
      Number.isFinite(loadData.allInRpm) ? loadData.allInRpm.toFixed(2) : ""
    ].join("|");
    const placement = findRowSummaryPlacementTarget(row);
    const target = placement.target;
    if (!(target instanceof HTMLElement)) {
      existing?.remove();
      return;
    }

    const compactLevel = placement.mode === "floating" ? 2 : hasEnoughSpace(target, 240) ? 0 : 1;
    const nextText = buildRowSummaryText(loadData, compactLevel);
    let summary = existing;

    if (!summary) {
      summary = createHelperNode("span", `${INLINE_BADGE_CLASS} ${ROW_SUMMARY_CLASS}`);
      summary.dataset.datHelperRole = ROW_SUMMARY_ROLE;
    }

    if (summary.parentElement !== target) {
      target.appendChild(summary);
    }

    updateClassIfNeeded(summary, "dat-helper-compact", compactLevel > 0);
    updateClassIfNeeded(summary, "dat-helper-floating", placement.mode === "floating");

    if (placement.mode === "floating" && row instanceof HTMLElement) {
      if (window.getComputedStyle(row).position === "static") {
        row.dataset.datHelperOriginalPosition = row.style.position || "";
        row.style.position = "relative";
      }
    }

    if (summary.dataset.datHelperValueHash === nextHash && summary.textContent === nextText) {
      return;
    }

    summary.textContent = nextText;
    summary.dataset.datHelperValueHash = nextHash;
  }

  function addBadgesToLoad(loadData, missingFields) {
    void missingFields;
    if (loadData?.element instanceof HTMLElement && loadData.element.classList.contains(HIDDEN_CLASS)) {
      getExistingRowSummary(loadData.element)?.remove();
      rowSummaryMap.delete(loadData.element);
      return;
    }
    renderRowSummaryIdempotently(loadData.element, loadData);
  }

  function getExistingRowSummary(row) {
    if (!(row instanceof Element)) {
      return null;
    }

    const staleSibling = row.nextElementSibling;
    if (
      staleSibling instanceof HTMLElement &&
      staleSibling.matches(`[${EXTENSION_ATTRIBUTE}="true"][data-dat-helper-role="${ROW_SUMMARY_ROLE}"]`)
    ) {
      staleSibling.remove();
    }

    const mapped = rowSummaryMap.get(row);
    if (mapped?.isConnected) {
      return mapped;
    }

    const existing = row.querySelector(
      `[${EXTENSION_ATTRIBUTE}="true"][data-dat-helper-role="${ROW_SUMMARY_ROLE}"]`
    );
    if (existing instanceof HTMLElement) {
      rowSummaryMap.set(row, existing);
      return existing;
    }

    return null;
  }

  function buildRowSummaryHash(loadData) {
    return [
      Number.isFinite(loadData.totalMiles) ? Math.round(loadData.totalMiles) : "",
      Number.isFinite(loadData.allInRpm) ? loadData.allInRpm.toFixed(2) : ""
    ].join("|");
  }

  function formatDisplayMiles(value) {
    return Number.isFinite(value) && value > 0 ? Math.round(value).toLocaleString("en-US") : "N/A";
  }

  function formatDisplayRate(value) {
    return Number.isFinite(value) && value > 0 ? value.toFixed(2) : "N/A";
  }

  function getAvailableInlineSpace(target) {
    if (!(target instanceof HTMLElement)) {
      return 0;
    }

    const rect = target.getBoundingClientRect();
    return rect ? rect.width : 0;
  }

  function chooseBadgeTextAndClass(target, loadData) {
    const available = getAvailableInlineSpace(target);
    const totalMiles = Number.isFinite(loadData.totalMiles) ? String(Math.round(loadData.totalMiles)) : null;
    const rpm = Number.isFinite(loadData.rpm) ? loadData.rpm.toFixed(2) : null;
    const allInRpm = Number.isFinite(loadData.allInRpm) ? loadData.allInRpm.toFixed(2) : null;

    if (available >= 240) {
      return {
        available,
        className: "",
        mode: "full",
        values: { totalMiles, rpm, allInRpm }
      };
    }

    if (available >= 185) {
      return {
        available,
        className: "dat-helper-compact",
        mode: "compact",
        values: { totalMiles, rpm, allInRpm }
      };
    }

    return {
      available,
      className: "dat-helper-compact dat-helper-two-line",
      mode: "two-line",
      values: { totalMiles, rpm, allInRpm }
    };
  }

  function buildSummaryItemMarkup(label, value) {
    return `<span class="dat-helper-item"><span class="dat-helper-muted">${label}</span><strong class="dat-helper-value">${value}</strong></span>`;
  }

  function buildRowSummaryMarkup(loadData, displayMode) {
    const totalMiles = Number.isFinite(loadData.totalMiles) ? String(Math.round(loadData.totalMiles)) : null;
    const allInRpm = Number.isFinite(loadData.allInRpm) ? loadData.allInRpm.toFixed(2) : null;
    const items = [];

    if (displayMode !== "ai-only" && totalMiles) {
      items.push(buildSummaryItemMarkup(displayMode === "full" ? "Total" : "T", totalMiles));
    }

    if (allInRpm) {
      items.push(buildSummaryItemMarkup(displayMode === "full" ? "All-in" : "AI", allInRpm));
    }

    if (!items.length) {
      return "";
    }

    return items.join(`<span class="dat-helper-separator">|</span>`);
  }

  function findInlineSummaryPlacementTarget(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const cells = [...row.querySelectorAll(".table-cell")].filter((cell) => cell instanceof HTMLElement);
    const trailingDashCell = [...cells]
      .reverse()
      .find((cell) => /^\s*[–-]\s*$/.test(getCleanElementText(cell)) && hasEnoughSpace(cell, 165));
    if (trailingDashCell) {
      return { target: trailingDashCell, floating: false };
    }

    const safeTrailingCell = [...cells]
      .reverse()
      .find((cell) => !isBadPlacementTarget(cell) && hasEnoughSpace(cell, 165));
    if (safeTrailingCell) {
      return { target: safeTrailingCell, floating: false };
    }

    const companyCell = row
      .querySelector('[data-test="load-company-cell"]')
      ?.closest(".table-cell");
    if (companyCell instanceof HTMLElement && !isBadPlacementTarget(companyCell) && hasEnoughSpace(companyCell, 190)) {
      return { target: companyCell, floating: false };
    }

    const creditCell = row
      .querySelector('[data-test="load-cs-dtp-cell"]')
      ?.closest(".table-cell");
    if (creditCell instanceof HTMLElement && !isBadPlacementTarget(creditCell) && hasEnoughSpace(creditCell, 180)) {
      return { target: creditCell, floating: false };
    }

    return { target: row, floating: true };
  }

  function findReadableInlineSummaryPlacementTarget(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const cells = [...row.querySelectorAll(".table-cell")].filter((cell) => cell instanceof HTMLElement);
    const seenTargets = new Set();
    const preferredCandidates = [];
    const addCandidate = (target, floating = false) => {
      if (!(target instanceof HTMLElement) || seenTargets.has(target) || isBadPlacementTarget(target)) {
        return;
      }

      seenTargets.add(target);
      preferredCandidates.push({
        target,
        floating,
        available: getAvailableInlineSpace(target)
      });
    };

    const trailingDashCell = [...cells].reverse().find((cell) => /^\s*[â€“-]\s*$/.test(getCleanElementText(cell)));
    addCandidate(trailingDashCell);

    [...cells].reverse().forEach((cell) => {
      addCandidate(cell);
    });

    addCandidate(
      row.querySelector('[data-test="load-company-cell"]')?.closest(".table-cell")
    );
    addCandidate(
      row.querySelector('[data-test="load-cs-dtp-cell"]')?.closest(".table-cell")
    );
    addCandidate(row.querySelector(".row-cells"));

    const roomyCandidate = preferredCandidates.find((candidate) => candidate.available >= 185);
    if (roomyCandidate) {
      return roomyCandidate;
    }

    const wrapCandidate = preferredCandidates.find((candidate) => candidate.available >= 145);
    if (wrapCandidate) {
      return wrapCandidate;
    }

    const widestCandidate = preferredCandidates.sort((left, right) => right.available - left.available)[0];
    if (widestCandidate && widestCandidate.available >= 120) {
      return widestCandidate;
    }

    const rowAvailable = getAvailableInlineSpace(row);
    if (rowAvailable >= 240) {
      return { target: row, floating: true, available: rowAvailable };
    }

    return null;
  }

  function findCompanyCell(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const looksLikeCompanyCell = (cell) => {
      if (!(cell instanceof HTMLElement)) {
        return false;
      }

      const text = getCleanElementText(cell);
      if (!text) {
        return false;
      }

      if (/\b\d{2,3}\s*CS\b/i.test(text) || /\b\d{1,3}\s*DTP\b/i.test(text)) {
        return false;
      }

      return (
        /\(\d{3}\)\s*\d{3}-\d{4}/.test(text) ||
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
      );
    };

    const explicitCell = row.querySelector('[data-test="load-company-cell"]')?.closest(".table-cell");
    if (looksLikeCompanyCell(explicitCell)) {
      return explicitCell;
    }

    return [...row.querySelectorAll(".table-cell")].find((cell) => looksLikeCompanyCell(cell)) || null;
  }

  function findScoreCell(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const explicitScore = row.querySelector('[data-test="load-cs-dtp-cell"]')?.closest(".table-cell");
    if (explicitScore instanceof HTMLElement) {
      return explicitScore;
    }

    return [...row.querySelectorAll(".table-cell")].find((cell) => {
      if (!(cell instanceof HTMLElement)) {
        return false;
      }

      const text = getCleanElementText(cell);
      return /\b\d{2,3}\s*CS\b/i.test(text) || /\b\d{1,3}\s*DTP\b/i.test(text);
    }) || null;
  }

  function findHelperGap(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const companyCell = findCompanyCell(row);
    const scoreCell = findScoreCell(row);
    if (!(companyCell instanceof HTMLElement) || !(scoreCell instanceof HTMLElement)) {
      return null;
    }

    const rowRect = row.getBoundingClientRect();
    const companyRect = companyCell.getBoundingClientRect();
    const scoreRect = scoreCell.getBoundingClientRect();
    const gapLeft = companyRect.right;
    const gapRight = scoreRect.left;
    const gapWidth = Math.floor(gapRight - gapLeft);
    if (!rowRect || !companyRect || !scoreRect || gapWidth <= 0) {
      return null;
    }

    return {
      row,
      rowRect,
      companyCell,
      companyRect,
      scoreCell,
      scoreRect,
      gapLeft,
      gapRight,
      gapWidth
    };
  }

  function findCompanyWrapper(companyCell) {
    if (!(companyCell instanceof HTMLElement)) {
      return null;
    }

    const wrapper =
      companyCell.querySelector(".info-container") ||
      companyCell.querySelector(".cell-container") ||
      companyCell;
    if (wrapper instanceof HTMLElement) {
      wrapper.classList.add("dat-helper-company-wrapper");
      return wrapper;
    }

    return companyCell;
  }

  function findCompanyContactContainer(companyCell) {
    if (!(companyCell instanceof HTMLElement)) {
      return null;
    }

    const explicitContact =
      companyCell.querySelector('[data-test="load-contact-cell"]')?.closest(".contact-state") ||
      companyCell.querySelector('[data-test="load-contact-cell"]')?.parentElement;
    if (explicitContact instanceof HTMLElement) {
      return explicitContact;
    }

    const contactLike = [...companyCell.querySelectorAll("a, span, div")].find((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const text = getCleanElementText(element);
      return (
        /\(\d{3}\)\s*\d{3}-\d{4}/.test(text) ||
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
      );
    });

    return contactLike instanceof HTMLElement ? contactLike : null;
  }

  function findCompanyNameContainer(companyCell) {
    if (!(companyCell instanceof HTMLElement)) {
      return null;
    }

    const explicitName =
      companyCell.querySelector('[data-test="load-company-cell"]') ||
      companyCell.querySelector(".company-prefer-or-blocked .anchor") ||
      companyCell.querySelector(".company-prefer-or-blocked");
    if (explicitName instanceof HTMLElement) {
      return explicitName;
    }

    const nameLike = [...companyCell.querySelectorAll("a, span, div")].find((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const text = getCleanElementText(element);
      if (!text) {
        return false;
      }

      return !/\(\d{3}\)\s*\d{3}-\d{4}/.test(text) && !/@/.test(text);
    });

    return nameLike instanceof HTMLElement ? nameLike : null;
  }

  function findTrailingDashBadgeCell(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    return [...row.querySelectorAll(".table-cell")]
      .filter((cell) => cell instanceof HTMLElement)
      .reverse()
      .find((cell) => {
        const text = getCleanElementText(cell);
        return /^\s*[â€“-]\s*$/.test(text) && !cell.querySelector('[data-test="load-cs-dtp-cell"]');
      }) || null;
  }

  function getInlineSpaceAfterContact(companyCell, contactContainer) {
    if (!(companyCell instanceof HTMLElement) || !(contactContainer instanceof HTMLElement)) {
      return 0;
    }

    const cellRect = companyCell.getBoundingClientRect();
    const contactRect = contactContainer.getBoundingClientRect();
    if (!cellRect || !contactRect) {
      return 0;
    }

    return Math.max(0, Math.floor(cellRect.right - contactRect.right - 8));
  }

  function badgeFitsWithinCell(badge, cell) {
    if (!(badge instanceof HTMLElement) || !(cell instanceof HTMLElement)) {
      return false;
    }

    const b = badge.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    return b.right <= c.right && b.left >= c.left;
  }

  function hasInlineRoom(target, badgeWidth) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const targetRect = target.getBoundingClientRect();
    const parentRect = target.parentElement?.getBoundingClientRect();
    if (!targetRect || !parentRect) {
      return false;
    }

    return parentRect.right - targetRect.right >= badgeWidth + 8;
  }

  function isSingleLineElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const computed = window.getComputedStyle(element);
    const parsedLineHeight = Number.parseFloat(computed.lineHeight);
    const fallbackLineHeight = Number.parseFloat(computed.fontSize) * 1.4;
    const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fallbackLineHeight;
    return rect.height <= lineHeight + 3;
  }

  function rectsIntersect(left, right) {
    return !(
      left.right <= right.left ||
      left.left >= right.right ||
      left.bottom <= right.top ||
      left.top >= right.bottom
    );
  }

  function rectsOverlap(left, right) {
    return rectsIntersect(left, right);
  }

  function badgeOverlapsExistingText(badge, row) {
    if (!(badge instanceof HTMLElement) || !(row instanceof HTMLElement)) {
      return true;
    }

    const badgeRect = badge.getBoundingClientRect();
    const protectedSelectors = [
      '[data-test="load-company-cell"]',
      '[data-test="load-contact-cell"]',
      '[data-test="load-cs-dtp-cell"]',
      TEMPLATE_FIELD_SELECTORS.rateCell,
      TEMPLATE_FIELD_SELECTORS.tripCell,
      TEMPLATE_FIELD_SELECTORS.deadheadOriginCell,
      TEMPLATE_FIELD_SELECTORS.deadheadDestinationCell,
      TEMPLATE_FIELD_SELECTORS.pickupCell
    ];

    return protectedSelectors.some((selector) => {
      return [...row.querySelectorAll(selector)].some((element) => {
        if (!(element instanceof HTMLElement) || badge.contains(element) || element.contains(badge)) {
          return false;
        }

        const text = getCleanElementText(element);
        if (!text) {
          return false;
        }

        return rectsIntersect(badgeRect, element.getBoundingClientRect());
      });
    });
  }

  function buildTwoLineTotalRpmMarkup(loadData) {
    const totalMiles = formatDisplayMiles(loadData.totalMiles);
    const totalRpm = formatDisplayRate(loadData.totalRpm ?? loadData.allInRpm);

    return [
      `<div class="dat-helper-line"><span class="dat-helper-label">T</span><span class="dat-helper-value">${totalMiles}</span></div>`,
      `<div class="dat-helper-line"><span class="dat-helper-label">R</span><span class="dat-helper-value">${totalRpm}</span></div>`
    ].join("");
  }

  function logDisplayDebugRow(loadData, result) {
    if (displayDebugRowsLogged >= 5) {
      return;
    }

    displayDebugRowsLogged += 1;
    console.log("[DAT Helper Display]", `row ${displayDebugRowsLogged}`, {
      price: loadData.price,
      tripMiles: loadData.tripMiles,
      emptyPickMiles: loadData.emptyPickMiles,
      originEmptyMiles: loadData.originEmptyMiles,
      dropEmptyMiles: loadData.dropEmptyMiles,
      totalMiles: loadData.totalMiles,
      totalRpm: loadData.totalRpm ?? loadData.allInRpm,
      tripCellText: loadData.tripCellText || "",
      dhOriginCellText: loadData.dhOriginCellText || "",
      dhDropCellText: loadData.dhDropCellText || "",
      renderAttempted: result.renderAttempted,
      placement: result.placement || null,
      skippedReason: result.skippedReason || null
    });
  }

  function renderTotalRpmHelper(row, loadData) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const existing = getExistingRowSummary(row);
    const clearSummary = (noSafeHash = "") => {
      if (noSafeHash) {
        row.dataset.datHelperNoSafeBadgeHash = noSafeHash;
      } else {
        delete row.dataset.datHelperNoSafeBadgeHash;
      }
      row
        .querySelectorAll(`[${EXTENSION_ATTRIBUTE}="true"][data-dat-helper-role="${ROW_SUMMARY_ROLE}"]`)
        .forEach((node) => node.remove());
      rowSummaryMap.delete(row);
      if (row.dataset.datHelperOriginalPosition !== undefined) {
        row.style.position = row.dataset.datHelperOriginalPosition || "";
        delete row.dataset.datHelperOriginalPosition;
      }
    };

    const formattedMiles = formatDisplayMiles(loadData.totalMiles);
    const formattedRate = formatDisplayRate(loadData.totalRpm ?? loadData.allInRpm);
    const baseHash = [formattedMiles, formattedRate].join("|");
    const gap = findHelperGap(row);
    let summary = existing;
    if (!(summary instanceof HTMLElement)) {
      summary = createHelperNode("div", ROW_SUMMARY_CLASS);
      summary.dataset.datHelperRole = ROW_SUMMARY_ROLE;
    }

    const markup = buildTwoLineTotalRpmMarkup(loadData);
    const companyCell = findCompanyCell(row);
    const scoreCell = findScoreCell(row);
    if (!(companyCell instanceof HTMLElement)) {
      clearSummary();
      logDisplayDebugRow(loadData, {
        renderAttempted: true,
        skippedReason: "no-company-cell"
      });
      return null;
    }

    updateClassIfNeeded(companyCell, "dat-helper-company-cell", true);
    if (window.getComputedStyle(companyCell).position === "static") {
      companyCell.dataset.datHelperOriginalPosition = companyCell.style.position || "";
      companyCell.style.position = "relative";
    }

    if (summary.parentElement !== companyCell) {
      companyCell.appendChild(summary);
    }

    updateClassIfNeeded(summary, "dat-helper-inline", false);
    updateClassIfNeeded(summary, "dat-helper-stacked", false);
    updateClassIfNeeded(summary, "dat-helper-compact", false);
    updateClassIfNeeded(summary, "dat-helper-two-line", false);
    updateClassIfNeeded(summary, "dat-helper-floating", false);
    summary.style.position = "absolute";
    summary.style.right = "6px";
    summary.style.left = "auto";
    summary.style.top = "50%";
    summary.style.transform = "translateY(-50%)";
    summary.style.maxWidth = "none";
    summary.innerHTML = markup;

    let placement = "company-cell-right";
    let placementCoordinate = 0;
    const helperWidth = 64;
    const helperGap = 8;

    if (gap && scoreCell instanceof HTMLElement) {
      const minGapWidth = formattedMiles.length >= 5 || formattedRate.length >= 5 ? 66 : 54;
      if (gap.gapWidth >= minGapWidth) {
        if (summary.parentElement !== row) {
          row.appendChild(summary);
        }
        if (window.getComputedStyle(row).position === "static") {
          row.dataset.datHelperOriginalPosition = row.style.position || "";
          row.style.position = "relative";
        }
        const scoreRect = scoreCell.getBoundingClientRect();
        const left = Math.round(scoreRect.left - gap.rowRect.left - helperWidth - helperGap);
        summary.style.left = `${left}px`;
        summary.style.right = "auto";
        placement = "gap-between-company-score";
        placementCoordinate = left;
      }
    }

    const helperRect = summary.getBoundingClientRect();
    const companyRect = companyCell.getBoundingClientRect();
    const scoreRect = scoreCell?.getBoundingClientRect() || null;
    const safe =
      (placement !== "gap-between-company-score" || !badgeOverlapsExistingText(summary, row)) &&
      (!scoreRect || !rectsOverlap(helperRect, scoreRect)) &&
      (placement === "company-cell-right" || !rectsOverlap(helperRect, companyRect));

    if (!safe) {
      if (placement !== "company-cell-right") {
        if (summary.parentElement !== companyCell) {
          companyCell.appendChild(summary);
        }
        summary.style.right = "6px";
        summary.style.left = "auto";
        placement = "company-cell-right";
        placementCoordinate = 0;
      }
    }

    const finalRect = summary.getBoundingClientRect();
    const finalSafe =
      (placement !== "gap-between-company-score" || !badgeOverlapsExistingText(summary, row)) &&
      (!scoreRect || !rectsOverlap(finalRect, scoreRect)) &&
      finalRect.right <= companyRect.right + 1;

    if (!finalSafe) {
      clearSummary();
      logDisplayDebugRow(loadData, {
        renderAttempted: true,
        placement,
        skippedReason: "placement-overlap"
      });
      return null;
    }

    delete row.dataset.datHelperNoSafeBadgeHash;
    rowSummaryMap.set(row, summary);
    logDisplayDebugRow(loadData, {
      renderAttempted: true,
      placement
    });
    return {
      node: summary,
      hash: [baseHash, placement, placementCoordinate].join("|"),
      markup
    };
  }

  function buildMinimalBadgeText(loadData, tight = false) {
    const parts = [];
    if (Number.isFinite(loadData.totalMiles)) {
      const miles = Math.round(loadData.totalMiles).toLocaleString("en-US");
      parts.push(
        buildSummaryItemMarkup(tight ? "T" : "T", tight ? miles.replace(/,/g, ",") : miles)
      );
    }

    if (Number.isFinite(loadData.allInRpm)) {
      parts.push(buildSummaryItemMarkup("AI", loadData.allInRpm.toFixed(2)));
    }

    if (!parts.length) {
      return "";
    }

    return parts.join(`<span class="dat-helper-separator"> </span>`);
  }

  function findSafeInlineBadgeTarget(row) {
    if (!(row instanceof HTMLElement)) {
      return [];
    }

    const companyCell = findCompanyCell(row);
    const targets = [];
    const contact = findCompanyContactContainer(companyCell);
    if (contact instanceof HTMLElement && isSingleLineElement(contact)) {
      targets.push({
        key: "company-contact",
        target: contact,
        cell: companyCell
      });
    }

    const companyName = findCompanyNameContainer(companyCell);
    if (companyName instanceof HTMLElement && isSingleLineElement(companyName)) {
      targets.push({
        key: "company-name",
        target: companyName,
        cell: companyCell
      });
    }

    const dashCell = findTrailingDashBadgeCell(row);
    if (dashCell instanceof HTMLElement && !isBadPlacementTarget(dashCell)) {
      targets.push({
        key: "trailing-dash",
        target: dashCell,
        cell: dashCell
      });
    }

    return targets.filter((candidate) => candidate.cell instanceof HTMLElement);
  }

  function renderMinimalBadge(row, loadData) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const existing = getExistingRowSummary(row);
    const baseHash = buildRowSummaryHash(loadData);
    const candidates = findSafeInlineBadgeTarget(row);
    if (!candidates.length) {
      row.dataset.datHelperNoSafeBadgeHash = baseHash;
      existing?.remove();
      rowSummaryMap.delete(row);
      return null;
    }

    let summary = existing;
    if (!(summary instanceof HTMLElement)) {
      summary = createHelperNode("span", ROW_SUMMARY_CLASS);
      summary.dataset.datHelperRole = ROW_SUMMARY_ROLE;
    }

    const markUnsafe = (baseHash) => {
      row.dataset.datHelperNoSafeBadgeHash = baseHash;
      summary.remove();
      rowSummaryMap.delete(row);
    };

    if (row.dataset.datHelperNoSafeBadgeHash === baseHash) {
      existing?.remove();
      rowSummaryMap.delete(row);
      return null;
    }

    const variants = [
      { key: "standard", markup: buildMinimalBadgeText(loadData, false) },
      { key: "tight", markup: buildMinimalBadgeText(loadData, true) }
    ].filter((variant) => Boolean(variant.markup));

    for (const candidate of candidates) {
      for (const variant of variants) {
        const beforeHeight = row.getBoundingClientRect().height;

        if (summary.parentElement !== candidate.target) {
          candidate.target.appendChild(summary);
        }

        updateClassIfNeeded(summary, "dat-helper-inline", true);
        updateClassIfNeeded(summary, "dat-helper-stacked", false);
        updateClassIfNeeded(summary, "dat-helper-compact", false);
        updateClassIfNeeded(summary, "dat-helper-two-line", false);
        updateClassIfNeeded(summary, "dat-helper-floating", false);
        summary.style.maxWidth = "max-content";
        summary.innerHTML = variant.markup;

        const badgeWidth = summary.getBoundingClientRect().width;
        const companyCell = candidate.cell;
        const creditRect = row
          .querySelector('[data-test="load-cs-dtp-cell"]')
          ?.getBoundingClientRect();
        const badgeRect = summary.getBoundingClientRect();
        const afterHeight = row.getBoundingClientRect().height;

        const safe =
          hasInlineRoom(candidate.target, badgeWidth) &&
          badgeFitsWithinCell(summary, companyCell) &&
          afterHeight <= beforeHeight + 4 &&
          (!creditRect || !rectsIntersect(badgeRect, creditRect)) &&
          !badgeOverlapsExistingText(summary, row);

        if (safe) {
          delete row.dataset.datHelperNoSafeBadgeHash;
          rowSummaryMap.set(row, summary);
          return {
            node: summary,
            hash: [baseHash, variant.key, candidate.key].join("|"),
            markup: variant.markup
          };
        }
      }
    }

    markUnsafe(baseHash);
    return null;
  }

  // -------------------------------------------------------------------------
  // Pre-hide pipeline helpers
  //
  // The core flow is:
  //   1. The page-wide CSS rule (see styles.css) hides every candidate row by
  //      default whenever <html> has the `dat-helper-active` class.
  //   2. The MutationObserver marks newly added rows with the explicit
  //      `dat-helper-pending` class so even if the page-wide rule misses
  //      them, they stay invisible.
  //   3. `processSingleRow` runs extract -> isBaseEligibleLoad -> passesFilters
  //      -> renderHelper. Only rows that pass every check are tagged with
  //      `dat-helper-passed`, which is the only state that lets a row paint.
  //   4. Rows that fail keep `display: none` via `hideRow` so they never
  //      appear, even for a single frame.
  // -------------------------------------------------------------------------

  function setHelperActive(active) {
    const root = document.documentElement;
    if (!(root instanceof Element)) {
      return;
    }
    if (active) {
      root.classList.add(ACTIVE_CLASS);
    } else {
      root.classList.remove(ACTIVE_CLASS);
    }
  }

  function markRowPending(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }
    updateClassIfNeeded(row, PASSED_CLASS, false);
    updateClassIfNeeded(row, PENDING_CLASS, true);
  }

  function markRowPassed(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }
    updateClassIfNeeded(row, PENDING_CLASS, false);
    updateClassIfNeeded(row, PASSED_CLASS, true);
  }

  function clearRowPipelineMarks(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }
    updateClassIfNeeded(row, PENDING_CLASS, false);
    updateClassIfNeeded(row, PASSED_CLASS, false);
  }

  function isCandidateRow(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    try {
      return (
        node.matches(TEMPLATE_ROW_SELECTOR) &&
        Boolean(node.closest(TEMPLATE_RESULTS_VIEWPORT_SELECTOR))
      );
    } catch (error) {
      return false;
    }
  }

  function extractRowsFromNode(node) {
    if (!(node instanceof Element)) {
      return [];
    }

    const rows = [];
    if (isCandidateRow(node)) {
      rows.push(node);
    }

    try {
      node.querySelectorAll(TEMPLATE_ROW_SELECTOR).forEach((candidate) => {
        if (
          candidate instanceof HTMLElement &&
          candidate.closest(TEMPLATE_RESULTS_VIEWPORT_SELECTOR)
        ) {
          rows.push(candidate);
        }
      });
    } catch (error) {
      // ignore — selector is hard-coded but `node` may be a detached subtree
    }

    return rows;
  }

  function collectInitialCandidateRows() {
    try {
      return [...document.querySelectorAll(TEMPLATE_ROW_SELECTOR)].filter(
        (node) =>
          node instanceof HTMLElement &&
          node.closest(TEMPLATE_RESULTS_VIEWPORT_SELECTOR)
      );
    } catch (error) {
      return [];
    }
  }

  // Pure per-row pipeline. Returns the filter result for callers that need
  // bookkeeping (counts, status badge); side effects are limited to:
  //   - marking the row pending / passed / hidden,
  //   - rendering the T/R helper for visible rows,
  //   - cleaning up any helper nodes on rows that turn out to be ineligible.
  function processSingleRow(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }
    if (!currentSettings.enabled) {
      return null;
    }

    // Step 1: hide first — never reveal until proven valid.
    markRowPending(row);

    // Step 2: no-rate / no-RPM rows are dropped without rendering anything.
    const rateText = getVisibleRateColumnText(row);
    const hasPostedRate = hasPostedRateInVisibleRateColumn(row);

    if (!hasPostedRate) {
      const hiddenReason = "no-posted-rate";
      hideRow(row, hiddenReason);
      updateClassIfNeeded(row, MISSING_CLASS, false);
      getExistingRowSummary(row)?.remove();
      rowSummaryMap.delete(row);
      clearRowPipelineMarks(row);
      processedRows.add(row);
      return { visible: false, missingFields: [], hiddenReason, baseEligible: false };
    }

    // Step 3: extract + evaluate. Both functions stay untouched so the actual
    // filtering, RPM math, and T/R helper behavior are exactly the same.
    const loadData = extractLoadData(row);
    const filterResult = evaluateFilters(loadData, currentSettings);

    if (!filterResult.visible) {
      hideRow(row, filterResult.hiddenReason || "");
      updateClassIfNeeded(row, MISSING_CLASS, false);
      clearRowPipelineMarks(row);
      processedRows.add(row);
      return filterResult;
    }

    // Step 4: row passed everything. Reveal and render the T/R helper.
    showRow(row);
    updateClassIfNeeded(
      row,
      MISSING_CLASS,
      filterResult.missingFields.length > 0
    );
    addBadgesToLoad(loadData, filterResult.missingFields);
    markRowPassed(row);
    processedRows.add(row);
    return filterResult;
  }

  function processNewRowsFromMutation(node) {
    if (!currentSettings.enabled) {
      return;
    }
    const rows = extractRowsFromNode(node);
    if (!rows.length) {
      return;
    }
    // Mark every row pending in one pass before doing any expensive parsing,
    // so the user never sees a partially evaluated batch.
    for (const row of rows) {
      markRowPending(row);
    }
    for (const row of rows) {
      processSingleRow(row);
    }
    // Recompute the badge once per batch — querySelectorAll is cheap and
    // running it once per row would be wasteful.
    renderStatus();
  }

  function setRowAndSummaryVisibility(row, hidden) {
    updateClassIfNeeded(row, HIDDEN_CLASS, hidden);
    const summary = getExistingRowSummary(row);
    if (summary) {
      updateClassIfNeeded(summary, HIDDEN_CLASS, hidden);
    }
  }

  function hideRow(row, reason) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    row.dataset.datHelperHiddenReason = reason || "";
    setRowAndSummaryVisibility(row, true);
    updateClassIfNeeded(row, HIDDEN_CLASS, true);
  }

  function showRow(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    delete row.dataset.datHelperHiddenReason;
    setRowAndSummaryVisibility(row, false);
  }

  function renderRowSummaryIdempotently(row, loadData) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    removeLegacyInlineBadges(row);

    if (!Number.isFinite(loadData.originEmptyMiles)) {
      loadData.originEmptyMiles = Number.isFinite(loadData.emptyMiles) ? loadData.emptyMiles : 0;
    }

    if (!Number.isFinite(loadData.dropEmptyMiles)) {
      loadData.dropEmptyMiles = 0;
    }

    loadData.emptyMiles = loadData.originEmptyMiles;

    if (!Number.isFinite(loadData.totalMiles)) {
      loadData.totalMiles = calculateTotalMiles(
        loadData.tripMiles,
        loadData.originEmptyMiles,
        loadData.dropEmptyMiles
      );
    }

    if (!Number.isFinite(loadData.totalRpm)) {
      loadData.totalRpm = calculateTotalRpm(loadData.price, loadData.totalMiles);
    }

    if (!Number.isFinite(loadData.allInRpm)) {
      loadData.allInRpm = loadData.totalRpm;
    }

    const existing = getExistingRowSummary(row);

    if (!(findCompanyCell(row) instanceof HTMLElement || findScoreCell(row) instanceof HTMLElement)) {
      existing?.remove();
      rowSummaryMap.delete(row);
      delete row.dataset.datHelperNoSafeBadgeHash;
      if (row.dataset.datHelperOriginalPosition !== undefined) {
        row.style.position = row.dataset.datHelperOriginalPosition || "";
        delete row.dataset.datHelperOriginalPosition;
      }
      return;
    }

    const rendered = renderTotalRpmHelper(row, loadData);
    if (!rendered?.node) {
      return;
    }

    const summary = rendered.node;
    if (summary.dataset.datHelperValueHash === rendered.hash && summary.innerHTML === rendered.markup) {
      return;
    }

    summary.innerHTML = rendered.markup;
    summary.dataset.datHelperValueHash = rendered.hash;
    rowSummaryMap.set(row, summary);
  }

  // Count loads the user is actually looking at. We read this from the DOM
  // (instead of an internal counter) so the number is guaranteed to match
  // what is visible: a row is "shown" only if our pipeline has neither hidden
  // it (`dat-helper-hidden` -> display:none) nor left it pre-hidden
  // (`dat-helper-pending` -> visibility:hidden).
  function getVisibleLoadCount() {
    try {
      const selector =
        `${TEMPLATE_ROW_SELECTOR}:not(.${HIDDEN_CLASS}):not(.${PENDING_CLASS})`;
      return document.querySelectorAll(selector).length;
    } catch (error) {
      return 0;
    }
  }

  // Single source of truth for the status badge.
  //
  // Contract:
  //   - When the extension is ON  -> "DAT Helper ON | Loads: X"
  //   - When the extension is OFF -> "DAT Helper OFF"
  //
  // No debug text, no candidate / hidden / missing counts, no "selector
  // unsafe" warnings. Anything diagnostic goes to console.warn only.
  function renderStatus() {
    const text = currentSettings.enabled
      ? `DAT Helper ON | Loads: ${getVisibleLoadCount()}`
      : "DAT Helper OFF";

    let badge = document.querySelector(
      `.${STATUS_CLASS}[${EXTENSION_ATTRIBUTE}="true"]`
    );

    if (!badge) {
      if (!document.body) {
        return;
      }
      badge = createHelperNode("div", STATUS_CLASS);
      document.body.appendChild(badge);
    }

    if (badge.textContent !== text) {
      badge.textContent = text;
    }
    lastStatusText = text;
  }

  function removeStatusBadge() {
    document.querySelectorAll(`.${STATUS_CLASS}[${EXTENSION_ATTRIBUTE}="true"]`).forEach((node) => {
      node.remove();
    });
    lastStatusText = "";
  }

  function removeDebugOutlines() {
    document.querySelectorAll(`.${DEBUG_OUTLINE_CLASS}`).forEach((element) => {
      updateClassIfNeeded(element, DEBUG_OUTLINE_CLASS, false);
    });
  }

  function renderDebugPanel(report) {
    const existing = document.querySelector(`.${DEBUG_PANEL_CLASS}[${EXTENSION_ATTRIBUTE}="true"]`);
    const nextText =
      `DAT Helper Debug Scan\nStrategy: ${report.selectedStrategyName}\nSource: ${report.strategySource}\n` +
      `Candidates: ${report.candidateCount}\nSafe: ${report.safe ? "yes" : "no"}\n${report.warning || "No warnings."}`;
    if (existing && existing.textContent === nextText) {
      return;
    }

    if (existing) {
      existing.remove();
    }

    const panel = createHelperNode("div", DEBUG_PANEL_CLASS);
    panel.textContent = nextText;
    document.body.appendChild(panel);
  }

  async function scanDatLayout() {
    debugModeActive = true;
    await applyWithObserverPaused(async () => {
      removeDebugOutlines();
      document
        .querySelectorAll(`.${DEBUG_PANEL_CLASS}[${EXTENSION_ATTRIBUTE}="true"]`)
        .forEach((node) => node.remove());
    });

    const result = await getCandidateLoadElements({ allowFullScan: true });
    const sampleLoads = result.elements.slice(0, 3).map((element) => {
      const parsed = extractLoadData(element);
      const analysis = analyzeCandidateElement(element);
      const filterResult = evaluateFilters(parsed, currentSettings);
      return {
        text: sampleText(parsed.rawText),
        reasons: analysis.reasons,
        parsed: {
          price: parsed.price,
          parsedPrice: parsed.price,
          rateCellText: parsed.rateCellText,
          tripMiles: parsed.tripMiles,
          emptyPickMiles: parsed.emptyPickMiles,
          dropEmptyMiles: parsed.dropEmptyMiles,
          rpm: parsed.rpm,
          totalMiles: parsed.totalMiles,
          totalRpm: parsed.totalRpm,
          tripCellText: parsed.tripCellText,
          dhOriginCellText: parsed.dhOriginCellText,
          dhDropCellText: parsed.dhDropCellText,
          baseEligible: filterResult.baseEligible,
          hiddenReason: filterResult.hiddenReason || ""
        }
      };
    });

    const averageTextLength = getAverageTextLength(result.elements);
    let warning = "";
    if (!result.safeResult.safe) {
      warning = "Unsafe selector set. Run with outlines and refine strategy.";
    } else if (result.elements.length === 1 && averageTextLength > 900) {
      warning = "Only one huge candidate found.";
    } else if (averageTextLength > 900) {
      warning = "Candidates seem too large.";
    }

    const report = {
      currentUrl: window.location.href,
      candidateCount: result.elements.length,
      selectedStrategyName: result.strategyName,
      strategySource: result.strategySource,
      safe: result.safeResult.safe,
      warning,
      diagnostics: [...result.diagnostics, ...result.safeResult.diagnostics],
      samples: sampleLoads,
      alternatives: result.alternatives.map((strategy) => ({
        name: strategy.name,
        count: strategy.elements.length,
        score: strategy.score,
        safe: strategy.safety.safe,
        averageTextLength: getAverageTextLength(strategy.elements)
      }))
    };

    log("debug scan completed", {
      candidateCount: report.candidateCount,
      selectedStrategyName: report.selectedStrategyName,
      strategySource: report.strategySource,
      samples: report.samples
    });

    await applyWithObserverPaused(async () => {
      result.elements.forEach((element) => {
        updateClassIfNeeded(element, DEBUG_OUTLINE_CLASS, true);
      });
      renderDebugPanel(report);
    });
    lastDebugReport = report;
    return report;
  }

  async function copyDebugReportText() {
    if (!lastDebugReport) {
      await scanDatLayout();
    }

    const reportText = JSON.stringify(lastDebugReport, null, 2);
    log("debug report", lastDebugReport);
    return reportText;
  }

  function buildParsedDataHash(loadData) {
    return [
      loadData.price ?? "",
      loadData.tripMiles ?? "",
      loadData.emptyPickMiles ?? "",
      loadData.originEmptyMiles ?? "",
      loadData.dropEmptyMiles ?? "",
      loadData.totalMiles ?? "",
      loadData.rpm?.toFixed(2) ?? "",
      loadData.totalRpm?.toFixed(2) ?? "",
      loadData.allInRpm?.toFixed(2) ?? ""
    ].join("|");
  }

  function buildRenderHash(loadData, missingFields) {
    return [
      loadData.emptyPickMiles ?? "",
      loadData.originEmptyMiles ?? "",
      loadData.dropEmptyMiles ?? "",
      loadData.totalMiles ?? "",
      loadData.rpm?.toFixed(2) ?? "",
      loadData.totalRpm?.toFixed(2) ?? "",
      loadData.allInRpm?.toFixed(2) ?? "",
      missingFields.join(",")
    ].join("|");
  }

  async function processLoads(reason = "manual") {
    if (!currentSettings.enabled) {
      return;
    }

    displayDebugRowsLogged = 0;
    milesDebugRowsLogged = 0;
    rateDebugRowsLogged = 0;
    noRateCheckRowsLogged = 0;

    const result =
      (await getCandidateLoadElements({ allowFullScan: false })) ||
      (await getCandidateLoadElements({ allowFullScan: true }));
    const safety = result.safeResult;

    if (!safety.safe) {
      await applyWithObserverPaused(async () => {
        clearExtensionClasses();
        clearExtensionNodes();
        // Keep the UI clean: just refresh the badge with the standard
        // "DAT Helper ON | Loads: X" text. The unsafe-selector situation is
        // a developer concern and stays in the console only — it must never
        // appear in the user-facing badge.
        renderStatus();
      });
      warn("[DAT Helper] selector unsafe", {
        strategy: result.strategyName,
        diagnostics: safety.diagnostics,
        candidateCount: result.elements.length
      });
      return;
    }

    const candidateElements = result.elements;
    const filterHash = getFilterHash(currentSettings);
    const candidateSignature = getCandidateSignature(candidateElements);
    const summary = {
      totalCount: candidateElements.length,
      visibleCount: 0,
      hiddenCount: 0,
      missingCount: 0,
      warning: ""
    };

    // CRITICAL: hide every candidate before doing any per-row work. The
    // page-wide CSS guard already covers template-row matches, but explicitly
    // setting `.dat-helper-pending` covers strategy-detected candidates that
    // don't match the template row selector. No row can paint until the
    // pipeline below decides it deserves to.
    for (const element of candidateElements) {
      markRowPending(element);
    }

    const previousStrategySerialized = JSON.stringify(currentSelectorStrategy || null);
    currentSelectorStrategy = result.strategy
      ? {
          name: normalizeStrategyName(result.strategy.name),
          type: result.strategy.type,
          selector: result.strategy.selector || null,
          parentTag: result.strategy.parentTag || null,
          parentPath: result.strategy.parentPath || null,
          score: result.strategy.score || 0
        }
      : null;

    if (
      currentSelectorStrategy &&
      JSON.stringify(currentSelectorStrategy) !== previousStrategySerialized
    ) {
      STORAGE_AREA.set({ [SELECTOR_KEY]: currentSelectorStrategy }).catch(() => {});
    }

    isApplyingDomChanges = true;
    try {
      await applyWithObserverPaused(async () => {
        candidateElements.forEach((element, index) => {
          const cleanText = getCleanRowText(element);
          const cleanTextHash = cleanText;
          const cachedState = rowStateCache.get(element);
          const shouldReuse =
            cachedState &&
            cachedState.cleanTextHash === cleanTextHash &&
            cachedState.filterHash === filterHash &&
            cachedState.candidateSignature === candidateSignature;

          let loadData;
          let filterResult;
          let parsedDataHash;
          let renderHash;
          const rowIndex = index + 1;
          const rateText = getVisibleRateColumnText(element);
          const parsedPrice = parsePostedRateFromText(rateText);
          const hasPostedRate = hasPostedRateInVisibleRateColumn(element);

          if (!hasPostedRate) {
            const hiddenReason = "no-posted-rate";
            logNoRateCheckRow(rowIndex, rateText, false, parsedPrice, "hide", hiddenReason);

            loadData = {
              element,
              price: null,
              parsedPrice: null,
              tripMiles: null,
              emptyPickMiles: 0,
              originEmptyMiles: 0,
              dropEmptyMiles: 0,
              emptyMiles: 0,
              totalMiles: null,
              rpm: null,
              totalRpm: null,
              allInRpm: null,
              rawText: cleanText,
              rateCellText: rateText,
              tripCellText: "",
              dhOriginCellText: "",
              dhDropCellText: "",
              displayedRpm: null,
              origin: "",
              destination: ""
            };
            filterResult = {
              visible: false,
              missingFields: [],
              hiddenReason,
              baseEligible: false
            };
            parsedDataHash = buildParsedDataHash(loadData);
            renderHash = buildRenderHash(loadData, []);

            summary.hiddenCount += 1;
            hideRow(element, hiddenReason);
            updateClassIfNeeded(element, MISSING_CLASS, false);
            getExistingRowSummary(element)?.remove();
            rowSummaryMap.delete(element);
            clearRowPipelineMarks(element);
            processedRows.add(element);
            rowStateCache.set(element, {
              cleanTextHash,
              parsedDataHash,
              renderHash,
              hidden: true,
              missingData: false,
              loadData,
              filterResult,
              filterHash,
              candidateSignature
            });

            if (debugModeActive) {
              updateClassIfNeeded(element, DEBUG_OUTLINE_CLASS, true);
            }
            return;
          }

          logNoRateCheckRow(rowIndex, rateText, true, parsedPrice, "continue", "");

          if (shouldReuse) {
            loadData = cachedState.loadData;
            filterResult = cachedState.filterResult;
            parsedDataHash = cachedState.parsedDataHash;
            renderHash = cachedState.renderHash;
          } else {
            loadData = extractLoadData(element);
            filterResult = evaluateFilters(loadData, currentSettings);
            parsedDataHash = buildParsedDataHash(loadData);
            renderHash = buildRenderHash(loadData, filterResult.visible ? filterResult.missingFields : []);
          }

          logRateDebugRow(loadData, filterResult);

          if (filterResult.missingFields.length) {
            summary.missingCount += 1;
          }

          if (filterResult.visible) {
            summary.visibleCount += 1;
          } else {
            summary.hiddenCount += 1;
          }

          if (filterResult.visible) {
            showRow(element);
            // Reveal the row only after every check passed. This is the
            // counterpart to the pre-hide step at the top of processLoads.
            markRowPassed(element);
          } else {
            hideRow(element, filterResult.hiddenReason || "");
            clearRowPipelineMarks(element);
          }
          updateClassIfNeeded(
            element,
            MISSING_CLASS,
            filterResult.visible && filterResult.missingFields.length > 0
          );

          if (!cachedState || cachedState.renderHash !== renderHash || !shouldReuse) {
            addBadgesToLoad(loadData, filterResult.visible ? filterResult.missingFields : []);
          }

          processedRows.add(element);

          if (debugModeActive) {
            updateClassIfNeeded(element, DEBUG_OUTLINE_CLASS, true);
          }

          rowStateCache.set(element, {
            cleanTextHash,
            parsedDataHash,
            renderHash,
            hidden: !filterResult.visible,
            missingData: filterResult.visible && filterResult.missingFields.length > 0,
            loadData,
            filterResult,
            filterHash,
            candidateSignature
          });
        });

        // Render the badge AFTER all per-row class updates are committed so
        // the DOM-based count reflects the post-filter state exactly. The
        // `summary` object is intentionally not passed — the badge derives
        // its number from the DOM, not from internal counters that could
        // drift out of sync (e.g. when virtualized rows leave the
        // candidate set between scans).
        renderStatus();
        if (debugModeActive && lastDebugReport) {
          renderDebugPanel(lastDebugReport);
        }
      });

      lastFilterHash = filterHash;
      lastCandidateSignature = candidateSignature;
      log("filter applied summary", {
        reason,
        candidates: summary.totalCount,
        shown: summary.visibleCount,
        hidden: summary.hiddenCount,
        missing: summary.missingCount,
        strategy: result.strategyName
      });
    } finally {
      isApplyingDomChanges = false;
    }
  }

  function shouldIgnoreMutationRecords(records) {
    return records.every((record) => mutationIsOnlyDatHelperChanges(record));
  }

  function scheduleApply(reason = "scheduled") {
    if (!currentSettings.enabled) {
      return;
    }

    const elapsed = Date.now() - lastApplyTime;
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      const delay = Math.max(0, MIN_APPLY_INTERVAL_MS - (Date.now() - lastApplyTime));
      if (delay > 0) {
        window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          applyNow(reason).catch((error) => warn("process failed", error));
        }, delay);
        return;
      }

      applyNow(reason).catch((error) => warn("process failed", error));
    }, elapsed < MIN_APPLY_INTERVAL_MS ? MIN_APPLY_INTERVAL_MS : OBSERVER_DEBOUNCE_MS);
  }

  async function applyNow(reason = "manual") {
    if (applyInProgress) {
      applyAgainRequested = true;
      return;
    }

    applyInProgress = true;
    try {
      await processLoads(reason);
      lastApplyTime = Date.now();
    } finally {
      applyInProgress = false;
      if (applyAgainRequested) {
        applyAgainRequested = false;
        scheduleApply("queued");
      }
    }
  }

  // -------------------------------------------------------------------------
  // reinitializeFiltering(reason)
  //
  // The single source-of-truth path for turning the extension ON, whether
  // that happens on initial page load or via a toggle. The toggle bug we
  // were chasing came from two things:
  //   1. `rowStateCache` and `processedRows` survived across toggles, so a
  //      row that was hidden in the previous session was reused as "hidden"
  //      again before the new filters ever ran against it.
  //   2. We marked rows pending and then waited for the debounced
  //      `scheduleApply` to run processLoads. The page-wide CSS guard hid
  //      everything in the meantime — visually identical to "nothing
  //      matches the filters".
  //
  // This function does the work synchronously (well, awaited), without
  // touching caches from the previous run and without ever using the
  // debounce.
  // -------------------------------------------------------------------------
  async function reinitializeFiltering(reason) {
    // Step 1 — Wipe every per-row cache. Toggle ON is, by definition,
    // a fresh filter pass against current DOM. No reuse.
    processedRows = new WeakSet();
    rowStateCache = new WeakMap();

    // Step 2 — Force-reset visibility on each candidate row. The page-wide
    // CSS guard relies on `.dat-helper-passed` to reveal rows; the per-row
    // pipeline relies on `.dat-helper-hidden` to permanently hide them.
    // Clear both, plus any leftover inline display style, so the only
    // thing keeping a row out of view is the pending marker we add next.
    const rows = collectInitialCandidateRows();
    for (const row of rows) {
      row.classList.remove(HIDDEN_CLASS);
      row.classList.remove(PASSED_CLASS);
      if (row.style && row.style.display) {
        row.style.display = "";
      }
      delete row.dataset.datHelperHiddenReason;
      markRowPending(row);
    }

    // Step 3 — Activate the page-wide CSS guard and the observer BEFORE
    // running the heavy pass, so any row DAT inserts mid-process is
    // automatically held in the pending state and picked up by the
    // observer's per-row pipeline.
    setHelperActive(true);
    startObserver();

    // Step 4 — Run the full filter pass immediately (no debounce). When
    // this resolves, every existing candidate has a final decision:
    //   - passing rows have `.dat-helper-passed` and the T/R helper,
    //   - failing rows have `.dat-helper-hidden`.
    await applyNow(reason);

    // Step 5 — Safety net. If processing somehow ended with zero visible
    // rows despite candidates in the DOM, run one more pass. This guards
    // against the worst-case "everything hidden" bug the user reported,
    // even if its root cause was already addressed by steps 1–4.
    if (rows.length > 0 && getVisibleLoadCount() === 0) {
      processedRows = new WeakSet();
      rowStateCache = new WeakMap();
      await applyNow(`${reason}-retry`);
    }

    // Step 6 — Now that every row has a final state, render the badge.
    // This is the only place the count is computed for the toggle-ON
    // transition, so it cannot show a stale 0.
    renderStatus();
  }

  function startObserver() {
    if (observer || !document.body) {
      return;
    }

    observer = new MutationObserver((records) => {
      if (!currentSettings.enabled || isApplyingDomChanges) {
        return;
      }

      if (shouldIgnoreMutationRecords(records)) {
        return;
      }

      // Pre-hide-first strategy:
      //   For every mutation that adds a node we synchronously mark any
      //   candidate rows pending and immediately run them through the
      //   per-row pipeline. There is no debounce and no global rescan, so
      //   a row goes "appear in DOM -> hidden by CSS guard -> evaluated ->
      //   either stays hidden (display:none) or becomes visible" in a
      //   single microtask. This is what removes the unfiltered flash.
      let sawAddedNodes = false;
      for (const record of records) {
        if (!record.addedNodes || !record.addedNodes.length) {
          continue;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }
          sawAddedNodes = true;
          processNewRowsFromMutation(node);
        }
      }

      // Attribute-only mutations (class flips DAT does on its own rows when
      // recycling virtual scroll slots) can leave a row in a stale state.
      // ALWAYS re-run the pipeline against the current DOM for any candidate
      // row whose attributes changed — never skip based on a previous
      // "processed" flag, because that flag is the very source of the stale
      // state we want to avoid (see FIX 3 / FIX 8 in the spec). The
      // per-row pipeline is idempotent, so running it twice on the same
      // row is safe.
      let processedAnyAttributeRow = false;
      if (!sawAddedNodes) {
        for (const record of records) {
          if (record.type !== "attributes") {
            continue;
          }
          const target = record.target;
          if (!(target instanceof HTMLElement)) {
            continue;
          }
          if (!isCandidateRow(target)) {
            continue;
          }
          markRowPending(target);
          processSingleRow(target);
          processedAnyAttributeRow = true;
        }
      }

      // Refresh the badge if this mutation actually changed the visible set.
      if (processedAnyAttributeRow) {
        renderStatus();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["class", EXTENSION_ATTRIBUTE]
    });
    observerActive = true;
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    observerActive = false;
  }

  async function loadState() {
    const stored = await STORAGE_AREA.get({
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [SELECTOR_KEY]: null
    });

    currentSettings = normalizeSettings(stored[SETTINGS_KEY] || DEFAULT_SETTINGS);
    currentSelectorStrategy = stored[SELECTOR_KEY]
      ? {
          ...stored[SELECTOR_KEY],
          name: normalizeStrategyName(stored[SELECTOR_KEY].name)
        }
      : null;
  }

  async function applyCurrentState() {
    runMilesParsingValidationOnce();
    await loadState();

    if (!currentSettings.enabled) {
      cleanupExtensionDom();
      logEnabledStateIfChanged(false);
      return;
    }

    logEnabledStateIfChanged(true);
    // Route startup through the same path used by toggle-ON. This keeps
    // both code paths in sync: fresh caches, force-reset visibility,
    // immediate (non-debounced) processing, retry safety net, then status.
    await reinitializeFiltering("startup");
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "DAT_HELPER_RUN_DEBUG_SCAN") {
      scanDatLayout()
        .then((report) => sendResponse({ ok: true, report }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message.type === "DAT_HELPER_GET_DEBUG_REPORT") {
      copyDebugReportText()
        .then((reportText) => sendResponse({ ok: true, reportText }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message.type === "DAT_HELPER_APPLY_NOW") {
      applyNow("popup")
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const settingsChanged = Boolean(changes[SETTINGS_KEY]);
    if (settingsChanged) {
      currentSettings = normalizeSettings(changes[SETTINGS_KEY].newValue || DEFAULT_SETTINGS);
    }

    if (changes[SELECTOR_KEY]) {
      currentSelectorStrategy = changes[SELECTOR_KEY].newValue
        ? {
            ...changes[SELECTOR_KEY].newValue,
            name: normalizeStrategyName(changes[SELECTOR_KEY].newValue.name)
          }
        : null;
    }

    if (!currentSettings.enabled) {
      cleanupExtensionDom();
      removeDebugOutlines();
      logEnabledStateIfChanged(false);
      return;
    }

    logEnabledStateIfChanged(true);
    if (settingsChanged) {
      // User toggled the extension or edited filters in the popup. Do a
      // full fresh filter run: reinitializeFiltering wipes the caches,
      // force-clears stale visibility state, processes immediately (no
      // debounce), and renders the badge last. This is the fix for the
      // "toggle ON hides everything" bug — there is no longer a window in
      // which the page-wide CSS guard is on but processLoads hasn't run.
      reinitializeFiltering("toggle-on").catch((error) =>
        warn("reinit failed", error)
      );
    } else {
      // Selector-strategy-only update (saved by our own processLoads after
      // discovering a new layout). Refreshing through reinitializeFiltering
      // here would loop: reinit -> processLoads -> save strategy ->
      // storage event -> reinit. Just keep the observer alive and let the
      // normal debounced apply pick it up.
      setHelperActive(true);
      startObserver();
      scheduleApply("storage");
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      applyCurrentState().catch((error) => warn("startup failed", error));
    }, { once: true });
  } else {
    applyCurrentState().catch((error) => warn("startup failed", error));
  }
})();
