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

  // Share Load Card lifecycle hooks. The real implementations are wired up
  // in the SHARE LOAD CARD section near the bottom of the IIFE; reinit and
  // cleanup invoke whatever is bound here at call time, so forward
  // references work without monkey-patching.
  const shareLoad = {
    start: function () {},
    stop: function () {}
  };

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
    // Stop the Share Load observer so it can't re-inject Share Load
    // buttons after the user turns the extension off. The buttons
    // themselves are removed by clearExtensionNodes() below.
    shareLoad.stop();
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

    // Step 7 — Activate the Share Load feature. Starts its own (separate)
    // observer + injects buttons into any already-expanded load panel.
    shareLoad.start();
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


  // =========================================================================
  // SHARE LOAD CARD FEATURE
  // =========================================================================

  var SHARE_BTN_CLASS   = "dat-helper-share-load-btn";
  var SHARE_TOAST_CLASS = "dat-helper-share-toast";
  var SHARE_BTN_ROLE    = "share-load-btn";
  var SHARE_LOG         = "[DAT Helper Share]";

  // ------------------------------------------------------------------
  // DETECTION
  // Use TreeWalker to find actual text nodes containing "VIEW ROUTE".
  // This works regardless of element type, class names, or React version.
  // ------------------------------------------------------------------
  // Normalised text of an element, ignoring children we own (so a
  // button we've already wrapped doesn't appear to have "Share Load"
  // text bleeding in).
  function normalizedOwnText(el) {
    if (!(el instanceof HTMLElement)) return "";
    // Use a clone so we can strip our own injected nodes without
    // touching the live DOM.
    var clone = el.cloneNode(true);
    var ours = clone.querySelectorAll("[" + EXTENSION_ATTRIBUTE + "='true']");
    for (var i = 0; i < ours.length; i++) {
      ours[i].parentNode && ours[i].parentNode.removeChild(ours[i]);
    }
    return (clone.innerText || clone.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findAllViewRouteElements() {
    var seen = [];
    var add = function(el) {
      if (!(el instanceof HTMLElement)) return;
      if (el === document.body) return;
      if (!el.parentElement) return;
      if (el.getAttribute(EXTENSION_ATTRIBUTE) === "true") return;
      // If the element is already inside one of our action stacks,
      // skip — we'd just re-wrap it and end up with nested stacks.
      if (el.closest && el.closest("." + ACTION_STACK_CLASS)) return;
      if (seen.indexOf(el) !== -1) return;
      seen.push(el);
    };

    // -------- PRIMARY: explicit interactive ancestors with the right text
    // Look at every button / link / role=button / role=link in the page
    // and keep the ones whose visible text is essentially just "VIEW
    // ROUTE" (allowing for an icon character before/after). This is by
    // far the most reliable detector and avoids the cursor:pointer
    // inheritance pitfall (cursor is an inherited CSS property, so
    // walking up the tree and stopping on cursor === "pointer" matches
    // inner label spans too).
    var BUTTON_LIKE = 'button, a, [role="button"], [role="link"]';
    var candidates = document.querySelectorAll(BUTTON_LIKE);
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var t = normalizedOwnText(el);
      // Allow short prefixes / suffixes around the label (icon glyphs,
      // chevrons, etc.) but reject anything with substantial extra text.
      if (/^[\W_]{0,4}view\s*route[\W_]{0,4}$/i.test(t)) {
        add(el);
      }
    }

    // -------- FALLBACK: TreeWalker for cases where DAT renders the pill
    // as a non-button element (e.g. a clickable <div> without role).
    // We pick the LARGEST ancestor whose own text is still essentially
    // just "VIEW ROUTE" (≤ 40 chars). Using "largest" rather than
    // "first" prevents wrapping an inner label span and accidentally
    // injecting the share button INSIDE the pill.
    if (seen.length === 0) {
      var walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT, null, false
      );
      var node;
      while ((node = walker.nextNode())) {
        if (!/VIEW\s*ROUTE/i.test(node.nodeValue)) continue;
        var fb = node.parentElement;
        var lastSmall = null;
        var depth = 0;
        while (fb && fb !== document.body && depth < 8) {
          if (fb.getAttribute(EXTENSION_ATTRIBUTE) === "true") break;
          var ft = normalizedOwnText(fb);
          if (ft.length === 0 || ft.length > 40) break;
          lastSmall = fb;
          fb = fb.parentElement;
          depth++;
        }
        if (lastSmall) add(lastSmall);
      }
    }

    return seen;
  }

  // Walk UP from a VIEW ROUTE element to find the expanded panel container
  // (the div that holds all load details: rate, equipment, broker, comments)
  function findExpandedPanel(vrEl) {
    var SIGNALS = ["COMMENTS", "MARKET RATES", "LOAD RESOURCES", "CONTACT INFORMATION", "EQUIPMENT"];
    var el = vrEl ? vrEl.parentElement : null;
    while (el && el !== document.body) {
      var text = (el.innerText || el.textContent || "").toUpperCase();
      var hasSignal = false;
      for (var s = 0; s < SIGNALS.length; s++) {
        if (text.indexOf(SIGNALS[s]) !== -1) { hasSignal = true; break; }
      }
      if (hasSignal) {
        var rect = el.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 80) return el;
      }
      el = el.parentElement;
    }
    // Fallback: return a wide ancestor
    el = vrEl ? vrEl.parentElement : null;
    while (el && el !== document.body) {
      var rect = el.getBoundingClientRect();
      if (rect.width > 400 && rect.height > 100) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  // ------------------------------------------------------------------
  // ACTION STACK
  //
  // DAT lays out the VIEW ROUTE button in a horizontal row that also
  // contains the trip timeline / pickup text. Dropping the Share Load
  // button as a sibling in that row visually overlaps everything to its
  // left. To avoid any positioning hacks (no absolute / translate /
  // negative margins), we wrap the VIEW ROUTE button in a vertical
  // flex column. The wrapper takes the slot DAT originally allocated to
  // the button, and the Share Load button gets appended below it in
  // normal flow.
  //
  // The stack is NOT tagged with data-dat-helper="true" — we don't want
  // clearExtensionNodes() to delete it, because that would also remove
  // DAT's own VIEW ROUTE button. Instead we use a custom role attribute
  // and a dedicated unwrap step in stopShareLoadFeature().
  // ------------------------------------------------------------------
  var ACTION_STACK_CLASS = "dat-helper-action-stack";
  var ACTION_STACK_ROLE  = "action-stack";

  function ensureActionStack(vrEl) {
    if (!(vrEl instanceof HTMLElement) || !vrEl.parentElement) {
      return null;
    }
    var parent = vrEl.parentElement;
    // Already wrapped? Reuse the existing stack so we never end up with
    // two columns around the same VIEW ROUTE button.
    if (parent.classList && parent.classList.contains(ACTION_STACK_CLASS)) {
      return parent;
    }
    var stack = document.createElement("div");
    stack.className = ACTION_STACK_CLASS;
    stack.setAttribute("data-dat-helper-role", ACTION_STACK_ROLE);
    // Insert the stack in vrEl's place, then move vrEl into it. DAT's
    // button stays untouched — we just re-parent it.
    parent.insertBefore(stack, vrEl);
    stack.appendChild(vrEl);
    return stack;
  }

  function unwrapActionStacks() {
    var stacks = document.querySelectorAll("." + ACTION_STACK_CLASS);
    for (var i = 0; i < stacks.length; i++) {
      var stack = stacks[i];
      var parent = stack.parentElement;
      if (!parent) {
        continue;
      }
      // Move non-helper children (i.e. DAT's VIEW ROUTE button) back to
      // the original parent, in their original order, right where the
      // stack sits. Any helper-owned children (the Share Load button)
      // are dropped — clearExtensionNodes() would have removed them
      // anyway.
      while (stack.firstChild) {
        var child = stack.firstChild;
        if (child instanceof Element &&
            child.getAttribute(EXTENSION_ATTRIBUTE) === "true") {
          child.parentNode.removeChild(child);
        } else {
          parent.insertBefore(child, stack);
        }
      }
      parent.removeChild(stack);
    }
  }

  // ------------------------------------------------------------------
  // INJECTION
  // ------------------------------------------------------------------
  function injectShareButtons() {
    // Share Load is part of the helper UI — when the extension is OFF the
    // user expects everything we own to be gone. Bail before doing any
    // scanning so the share observer can't keep re-injecting buttons after
    // toggle OFF.
    if (!currentSettings.enabled) {
      return;
    }
    if (!document.body) {
      return;
    }

    var vrEls = findAllViewRouteElements();

    for (var i = 0; i < vrEls.length; i++) {
      var vrEl = vrEls[i];

      // Wrap VIEW ROUTE in our vertical action stack (idempotent — reuses
      // the existing stack if vrEl is already inside one). This is what
      // moves the Share Load button BELOW VIEW ROUTE instead of next to
      // it, so it no longer overlaps the trip timeline / pickup text.
      var stack = ensureActionStack(vrEl);
      if (!stack) {
        continue;
      }

      // Idempotency: already have a share button in this stack?
      if (stack.querySelector('[data-dat-helper-role="' + SHARE_BTN_ROLE + '"]')) {
        continue;
      }

      // Find the expanded panel for data extraction
      var panel = findExpandedPanel(vrEl);

      // Create the button
      var btn = document.createElement("button");
      btn.type      = "button";
      btn.className = SHARE_BTN_CLASS;
      btn.setAttribute(EXTENSION_ATTRIBUTE, "true");
      btn.setAttribute("data-dat-helper-role", SHARE_BTN_ROLE);
      btn.title = "Copy a clean load card to clipboard — paste into WhatsApp, iMessage, email, Slack, etc.";
      // Two-span layout matches the spec's "📋 Share Load" pattern: the
      // emoji is decorative-only (aria-hidden) and the label is the
      // accessible text screen readers and DAT's UI both see.
      btn.innerHTML =
        '<span aria-hidden="true" style="font-size:14px;line-height:1">\u{1F4CB}</span>' +
        '<span>Share Load</span>';

      // Closure to capture panel + btn correctly
      (function(capturedPanel, capturedBtn) {
        capturedBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          e.preventDefault();
          var data = extractExpandedLoadDetails(capturedPanel);
          generateAndCopyLoadCard(data, capturedBtn).catch(function(err) {
            warn(SHARE_LOG, "click error:", err);
          });
        });
      })(panel, btn);

      // Place the Share Load button BELOW the VIEW ROUTE button. The
      // stack's column layout + gap takes care of spacing; no margins
      // or absolute positioning on the button itself.
      stack.appendChild(btn);
    }
  }

  // ------------------------------------------------------------------
  // DATA EXTRACTION — direct DOM selectors on the real DAT panel
  //
  // The previous extractor parsed innerText with regex and heuristic
  // heading walks. That failed because DAT renders Equipment and Rate
  // as TWO PARALLEL COLUMNS (all labels in one .equipment-label flex
  // child, all values in a sibling .equipment-data child), which when
  // serialised via innerText puts every label first, then every value.
  // "Next non-empty line after 'Load'" is "Truck" — another label —
  // never "Full". The same trap exists for the Rate column.
  //
  // We now read DAT's actual elements directly:
  //   * <dat-details-header> .trip-place / .trip-miles       — header
  //   * <dat-route>          .details-header .label "Trip"   — trip
  //                          .route-origin .date / .city
  //                          [data-test=load-dho-cell] etc.
  //   * <dat-equipment>      .equipment-label .data-label    — pair
  //                          .equipment-data  .data-item     —   by
  //                                                           index
  //   * <dat-rate>           .rate-detail-label / .rate-data — pair
  //                                                           by index
  //   * <dat-company>        [data-test=company-details-container]
  //                          .company-details / a[href^=tel:] / MC#text
  //   * <dat-contacts>       .contacts__phone / .contacts__email
  //   * <dat-notes>          [data-test=comments-container]
  //                          .notes-contents
  //
  // After DOM lookups, any field still null falls through to the
  // original text-pattern fallbacks so we don't regress on layouts
  // we haven't seen yet. Derived totalMiles / totalRpm are still
  // computed from the numeric values we resolved.
  // ------------------------------------------------------------------
  function extractExpandedLoadDetails(panel) {
    var qt = function(s) { return (s || "").replace(/\s+/g, " ").trim(); };
    var txt = function(el) { return el ? qt(el.textContent || "") : null; };
    if (!(panel instanceof HTMLElement)) panel = document.body;

    // ===== Locate the full expanded body =====
    // findExpandedPanel walks UP from the VIEW ROUTE button looking for
    // section signals (EQUIPMENT, COMMENTS, CONTACT INFORMATION). Those
    // all live in the LEFT details-column, so the panel it returns is
    // typically just the left column — and the right-column
    // <dat-company> for the broker is NOT a descendant of that. We
    // need a wider scope. Walk UP from `panel` to find the full
    // <dat-load-details> (or .table-row-detail) container, which holds
    // all three columns (left / center / right) of the expanded body.
    var loadRoot =
      (panel.closest && (panel.closest("dat-load-details")
                      || panel.closest(".table-row-detail")))
      || panel.querySelector("dat-load-details")
      || panel;

    // ===== Authoritative row parser data =====
    // The extension already has a working row parser (extractLoadData)
    // that powers filtering, the T/R helper, and eligibility checks.
    // Reuse its numeric output for price / miles / RPM so the share
    // card matches exactly what the dispatcher sees on the row badge
    // — no re-parsing the expanded panel for values that already
    // exist. The collapsed row + expanded detail are siblings inside
    // the same <div class="row-container">, so the panel's row-
    // container ancestor IS the row the panel belongs to.
    var rowEl = null;
    var rowData = null;
    try {
      rowEl = panel.closest('.row-container')
           || panel.closest('[id^="table-row-"]');
      if (!rowEl && panel.parentElement) {
        rowEl = panel.parentElement.closest('.row-container')
             || panel.parentElement.closest('[id^="table-row-"]');
      }
      if (rowEl && typeof extractLoadData === "function") {
        rowData = extractLoadData(rowEl);
      }
    } catch (rowErr) {
      rowData = null;
    }
    // Use rowEl as an even wider fallback scope if we still couldn't
    // find dat-load-details (e.g. DAT changed wrapper classes).
    if (loadRoot === panel && rowEl) {
      var betterRoot = rowEl.querySelector("dat-load-details")
                    || rowEl.querySelector(".table-row-detail");
      if (betterRoot) loadRoot = betterRoot;
    }

    // ===== HEADER: origin / destination / trip miles =====
    var origin = null, destination = null;
    var hdrTripMiles = null;
    var detailsHeader = loadRoot.querySelector("dat-details-header");
    if (detailsHeader) {
      var tripPlace = detailsHeader.querySelector(".trip-place");
      if (tripPlace) {
        // .trip-place contains: <div>City, ST</div> <mat-icon arrow/> <div>City, ST</div>
        var placeDivs = [];
        for (var pi = 0; pi < tripPlace.children.length; pi++) {
          var ch = tripPlace.children[pi];
          if (ch.tagName && ch.tagName.toLowerCase() === "div") {
            var t = txt(ch);
            if (t) placeDivs.push(t);
          }
        }
        if (placeDivs.length >= 1) origin = placeDivs[0];
        if (placeDivs.length >= 2) destination = placeDivs[placeDivs.length - 1];
      }
      var tripMiEl = detailsHeader.querySelector(".trip-miles");
      if (tripMiEl) hdrTripMiles = txt(tripMiEl);
    }

    // ===== TRIP SECTION: pickup date, empty miles =====
    var pickupDate = null;
    var dhOriginRaw = null, dhDropRaw = null;
    var routeSection = null;
    var routeNodes = loadRoot.querySelectorAll("dat-route");
    for (var rsi = 0; rsi < routeNodes.length; rsi++) {
      var lbl = routeNodes[rsi].querySelector(".details-header .label");
      if (lbl && /^Trip$/i.test(qt(lbl.textContent))) {
        routeSection = routeNodes[rsi];
        break;
      }
    }
    if (routeSection) {
      // Pickup date: <div class="date">May 15 - May 16</div>
      var dateEl = routeSection.querySelector(".route-origin .date")
                || routeSection.querySelector(".date");
      if (dateEl) {
        var dateText = txt(dateEl);
        var dm = dateText.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+(?:19|20)\d{2})?)/i)
              || dateText.match(/(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/);
        pickupDate = dm ? dm[1] : dateText;
      }
      // Empty miles: city text often "Buford, GA (108)"
      var cityEls = routeSection.querySelectorAll(".city");
      if (cityEls.length >= 1) {
        var om = txt(cityEls[0]).match(/\((\d+)\)/);
        if (om) dhOriginRaw = om[1];
      }
      if (cityEls.length >= 2) {
        var dmCity = txt(cityEls[cityEls.length - 1]).match(/\((\d+)\)/);
        if (dmCity) dhDropRaw = dmCity[1];
      }
    }
    // Backup: row-cell deadhead elements (always present for visible row).
    if (dhOriginRaw == null) {
      var dhoEl = panel.querySelector('[data-test="load-dho-cell"]')
               || panel.querySelector('.dho .deadhead');
      if (dhoEl) {
        var dhom = txt(dhoEl).match(/(\d+)/);
        if (dhom) dhOriginRaw = dhom[1];
      }
    }
    if (dhDropRaw == null) {
      var dhdEl = panel.querySelector('[data-test="load-dhd-cell"]')
               || panel.querySelector('.dhd .deadhead');
      if (dhdEl) {
        var dhdT = txt(dhdEl);
        if (dhdT) {
          var dhdm = dhdT.match(/(\d+)/);
          if (dhdm) dhDropRaw = dhdm[1];
        }
      }
    }

    // ===== EQUIPMENT: parallel columns paired by index =====
    var loadType = null, truck = null, length = null, weight = null;
    var commodity = null, referenceId = null;
    var eqMap = {};
    var eqSection = null;
    var eqNodes = loadRoot.querySelectorAll("dat-equipment");
    for (var eqi = 0; eqi < eqNodes.length; eqi++) {
      // The expanded version has both .equipment-label AND .equipment-data
      // — the collapsed row-cell version does not.
      if (eqNodes[eqi].querySelector(".equipment-label") &&
          eqNodes[eqi].querySelector(".equipment-data")) {
        eqSection = eqNodes[eqi];
        break;
      }
    }
    if (eqSection) {
      var eqLabels = eqSection.querySelectorAll(".equipment-label .data-label");
      var eqValues = eqSection.querySelectorAll(".equipment-data .data-item");
      var en = Math.min(eqLabels.length, eqValues.length);
      for (var eqj = 0; eqj < en; eqj++) {
        var eLab = txt(eqLabels[eqj]);
        var eVal = txt(eqValues[eqj]);
        if (eLab) eqMap[eLab.toLowerCase()] = eVal;
      }
      loadType    = eqMap["load"];
      truck       = eqMap["truck"];
      length      = eqMap["length"];
      weight      = eqMap["weight"];
      commodity   = eqMap["commodity"];
      referenceId = eqMap["reference id"] || eqMap["reference"];
    }

    // ===== RATE: Total / Trip / Rate per mile (parallel columns) =====
    var rate = null, tripMiles = null, ratePerMile = null;
    var rateSection = null;
    var rateNodes = loadRoot.querySelectorAll("dat-rate");
    for (var rti = 0; rti < rateNodes.length; rti++) {
      // Expanded dat-rate has .rate-details-container; row-cell doesn't.
      if (rateNodes[rti].querySelector(".rate-details-container") ||
          rateNodes[rti].querySelector('[data-test="rate-details-container"]')) {
        rateSection = rateNodes[rti];
        break;
      }
    }
    if (rateSection) {
      var rLabelsCol = rateSection.querySelector(".rate-detail-label");
      var rValuesCol = rateSection.querySelector(".rate-data");
      if (rLabelsCol && rValuesCol) {
        var rLabelEls = rLabelsCol.querySelectorAll(".data-label");
        // Direct children of .rate-data (each wraps one value).
        var rValueChildren = [];
        for (var rci = 0; rci < rValuesCol.children.length; rci++) {
          rValueChildren.push(rValuesCol.children[rci]);
        }
        var rn = Math.min(rLabelEls.length, rValueChildren.length);
        for (var rk = 0; rk < rn; rk++) {
          var rLab = txt(rLabelEls[rk]);
          var rValEl = rValueChildren[rk];
          // For .data-item-ratemiles, prefer the first inner div (the
          // text node "$4.02") — skips the trailing info mat-icon.
          if (rValEl.classList && rValEl.classList.contains("data-item-ratemiles")) {
            var firstInner = rValEl.querySelector("div");
            if (firstInner) rValEl = firstInner;
          }
          var rVal = txt(rValEl);
          if (!rLab || !rVal) continue;
          if (/^total$/i.test(rLab)) {
            var rateMm = rVal.match(/\$?([\d,]+(?:\.\d+)?)/);
            if (rateMm) rate = "$" + rateMm[1];
          } else if (/^trip$/i.test(rLab)) {
            var tripMm = rVal.match(/([\d,]+)/);
            if (tripMm) tripMiles = tripMm[1].replace(/,/g, "") + " mi";
          } else if (/rate\s*\/\s*mile/i.test(rLab) || /per\s*mile/i.test(rLab)) {
            var rpmMm = rVal.match(/\$?([\d.]+)/);
            if (rpmMm) ratePerMile = "$" + rpmMm[1] + "/mi";
          }
        }
      }
    }

    // ===== COMPANY: broker name, MC#, phone, email =====
    // The expanded Company section lives on the RIGHT side of the
    // load body. To make sure we never accidentally read the LEFT
    // Contact Information section as a broker source, we search
    // explicitly for <dat-company> with [data-test="company-details-container"]
    // (only the expanded version has that attribute — the row-cell
    // <dat-company> uses .info-container instead). We try loadRoot
    // first, then fall back to the whole row element, so we still
    // resolve the company even when findExpandedPanel returned just
    // the left column.
    var company = null, mc = null, phone = null, email = null;
    var companySection =
         loadRoot.querySelector('dat-company [data-test="company-details-container"]')
      || loadRoot.querySelector('[data-test="company-details-container"]')
      || loadRoot.querySelector('dat-company .company-data-container');
    if (!companySection && rowEl) {
      companySection =
           rowEl.querySelector('dat-company [data-test="company-details-container"]')
        || rowEl.querySelector('[data-test="company-details-container"]')
        || rowEl.querySelector('dat-company .company-data-container');
    }
    // As a last resort, walk all dat-company elements and pick the one
    // whose own text contains the heading "Company" — this is the
    // expanded one regardless of attribute changes.
    if (!companySection) {
      var allCompanies = (rowEl || loadRoot).querySelectorAll
                       ? (rowEl || loadRoot).querySelectorAll("dat-company")
                       : [];
      for (var dci = 0; dci < allCompanies.length; dci++) {
        var dc = allCompanies[dci];
        var dcLabel = dc.querySelector(".details-header .label, .label");
        if (dcLabel && /^company$/i.test(qt(dcLabel.textContent))) {
          companySection = dc.querySelector(".details-container")
                        || dc.querySelector(".data-container")
                        || dc;
          break;
        }
      }
    }
    if (companySection) {
      // ---- Broker name ----
      // DAT renders it inside .company-details (textContent decodes &amp;).
      // Some variants put the name in .company-name directly without a
      // child .company-details, so try a few selectors in order.
      var nameEl = companySection.querySelector(".company-name .company-details")
                || companySection.querySelector(".company-details")
                || companySection.querySelector(".company-header .company-name")
                || companySection.querySelector(".company-name");
      if (nameEl) {
        var rawName = txt(nameEl);
        if (rawName && !/^company$/i.test(rawName) && rawName.length < 160) {
          company = rawName;
        }
      }
      // ---- Phone ----
      // First <a href="tel:..."> inside the section.
      var telA = companySection.querySelector('a[href^="tel:"]');
      if (telA) {
        var phT = qt(telA.textContent);
        var pm = phT.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
        phone = pm ? pm[0] : phT;
      }
      // ---- Email ----
      // First <a href="mailto:..."> inside the section, or pattern match.
      var mailA = companySection.querySelector('a[href^="mailto:"]');
      if (mailA) {
        var emT = qt(mailA.textContent);
        if (/@/.test(emT)) email = emT;
      }
      // ---- MC# / Email backstops ----
      var compText = companySection.innerText || companySection.textContent || "";
      if (!mc) {
        var mcM = compText.match(/\bMC\s*#?\s*(\d{4,})/i);
        if (mcM) mc = mcM[1];
      }
      if (!email) {
        var emM = compText.match(/[\w.+\-]+@[\w\-]+\.[\w.]{2,}/i);
        if (emM) email = emM[0];
      }
    }

    // ---- Broker diagnostic log ----
    try {
      log("[DAT Share Broker] Company section found:", !!companySection);
      log("[DAT Share Broker] Extracted broker:", {
        brokerName: company,
        mcNumber:   mc,
        phone:      phone,
        email:      email
      });
    } catch (brokerLogErr) {}

    // ===== CONTACT INFORMATION: backfill phone / email =====
    var contactSection = loadRoot.querySelector('[data-test="contact-information-container"]')
                      || loadRoot.querySelector('dat-contacts');
    if (contactSection) {
      if (!phone) {
        var phEl = contactSection.querySelector(".contacts__phone")
                || contactSection.querySelector('a[href^="tel:"]');
        if (phEl) {
          var phT2 = qt(phEl.textContent);
          var pm2 = phT2.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
          phone = pm2 ? pm2[0] : phT2;
        }
      }
      if (!email) {
        var emEl = contactSection.querySelector(".contacts__email")
                || contactSection.querySelector('a[href^="mailto:"]');
        if (emEl) {
          var emT = qt(emEl.textContent);
          if (/@/.test(emT)) email = emT;
        }
      }
    }

    // ===== COMMENTS =====
    var comments = null;
    var commentsSection = loadRoot.querySelector('[data-test="comments-container"]')
                       || loadRoot.querySelector('dat-notes');
    if (commentsSection) {
      var notesContents = commentsSection.querySelector(".notes-contents");
      if (notesContents) comments = txt(notesContents);
    }

    // ===== Last-resort text fallbacks for anything still null =====
    var allText = (loadRoot.innerText || loadRoot.textContent || "").replace(/\r\n/g, "\n");

    var KNOWN_LABEL_RE = /^(?:Load|Truck|Length|Weight|Commodity|Reference(?:\s*ID)?|Equipment|Broker|Company|Comments?|Phone|Email|MC#?|Trip|Rate|Total|Pickup|Delivery|Origin|Destination|Date|Empty|DH-?O|DH-?D|Drop|View\s*Route|Market\s*Rates?|Spot\s*Rate|Contract\s*Rate|Days?\s*to\s*Pay|Credit\s*Score|Tracking\s*Required|Load\s*Resources|Insurance|DAT\s*Assurance|Per\s*Load\s*Insurance|Mark\s*As|Rate\s*\/\s*mile|Contact\s*Information)$/i;
    function clean(v) {
      if (v == null) return null;
      var t = qt(String(v));
      if (!t) return null;
      if (/^[\-–—\s]+$/.test(t)) return null;
      if (KNOWN_LABEL_RE.test(t)) return null;
      return t;
    }

    if (!origin || !destination) {
      var glb = /([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+)*,\s*[A-Z]{2})\b/g;
      var allLocs = [];
      var glbM;
      while ((glbM = glb.exec(allText)) !== null) {
        var l = qt(glbM[1]);
        if (l && allLocs.indexOf(l) === -1) allLocs.push(l);
        if (allLocs.length >= 2) break;
      }
      if (!origin)      origin      = allLocs[0] || null;
      if (!destination) destination = allLocs[1] || null;
    }
    if (!pickupDate) {
      var gd = allText.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+(?:19|20)\d{2})?)\b/i)
            || allText.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
      if (gd) pickupDate = qt(gd[1]);
    }
    if (!tripMiles && hdrTripMiles) {
      var hm = hdrTripMiles.match(/([\d,]+)/);
      if (hm) tripMiles = hm[1].replace(/,/g, "") + " mi";
    }
    if (!rate) {
      var totalRateM = allText.match(/\bTotal\s+\$([\d,]+(?:\.\d+)?)/i);
      if (totalRateM) rate = "$" + totalRateM[1];
    }
    if (!tripMiles) {
      var tripM = allText.match(/\bTrip\s+([\d,]+)\s*mi\b/i);
      if (tripM) tripMiles = tripM[1] + " mi";
    }
    if (!ratePerMile) {
      var rpmM = allText.match(/\$([\d.]+)\s*\*?\s*\/\s*mi\b/i);
      if (rpmM) ratePerMile = "$" + rpmM[1] + "/mi";
    }
    if (!mc) {
      var mcM = allText.match(/\bMC\s*#?\s*(\d{4,})/i);
      if (mcM) mc = mcM[1];
    }
    if (!phone) {
      var phM = allText.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
      if (phM) phone = phM[0];
    }
    if (!email) {
      var emM = allText.match(/[\w.+\-]+@[\w\-]+\.[\w.]{2,}/i);
      if (emM) email = emM[0];
    }

    // ===== Override price / miles / RPM with row parser data =====
    // Row parser is the canonical source — same data that powers the
    // T/R helper, filtering and eligibility. The share card MUST show
    // the same numbers the dispatcher sees on the row badge.
    if (rowData) {
      if (Number.isFinite(rowData.price)) {
        rate = "$" + rowData.price.toLocaleString("en-US");
      }
      if (Number.isFinite(rowData.tripMiles)) {
        tripMiles = rowData.tripMiles + " mi";
      }
      if (Number.isFinite(rowData.rpm)) {
        ratePerMile = "$" + rowData.rpm.toFixed(2) + "/mi";
      }
      if (Number.isFinite(rowData.emptyPickMiles)) {
        dhOriginRaw = String(rowData.emptyPickMiles);
      }
      if (Number.isFinite(rowData.dropEmptyMiles)) {
        dhDropRaw = String(rowData.dropEmptyMiles);
      }
    }

    // ===== Derived: total miles, total RPM =====
    function toNum(v) {
      if (v == null) return null;
      var m = String(v).match(/[\d.,]+/);
      if (!m) return null;
      var n = parseFloat(m[0].replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    var tripMilesNum = toNum(tripMiles);
    var dhOriginNum  = toNum(dhOriginRaw);
    var dhDropNum    = toNum(dhDropRaw);
    var rateNum      = toNum(rate);
    var totalMilesNum = null;
    if (Number.isFinite(tripMilesNum) && tripMilesNum > 0) {
      totalMilesNum = tripMilesNum
        + (Number.isFinite(dhOriginNum) ? dhOriginNum : 0)
        + (Number.isFinite(dhDropNum)   ? dhDropNum   : 0);
    }
    var totalMiles = Number.isFinite(totalMilesNum) ? (totalMilesNum + " mi") : null;
    var totalRpm   = (Number.isFinite(rateNum) && Number.isFinite(totalMilesNum) && totalMilesNum > 0)
      ? ("$" + (rateNum / totalMilesNum).toFixed(2) + "/mi")
      : null;

    // Prefer the row parser's pre-computed totals so the share card
    // displays exactly what the T/R helper shows — single source of truth.
    if (rowData) {
      if (Number.isFinite(rowData.totalMiles)) {
        totalMiles = rowData.totalMiles + " mi";
      }
      if (Number.isFinite(rowData.totalRpm)) {
        totalRpm = "$" + rowData.totalRpm.toFixed(2) + "/mi";
      }
    }

    // ===== Assemble result =====
    var result = {
      origin:      clean(origin),
      destination: clean(destination),
      pickupDate:  clean(pickupDate),
      rate:        clean(rate),
      ratePerMile: clean(ratePerMile),
      tripMiles:   clean(tripMiles),
      dhOrigin:    dhOriginRaw != null ? (dhOriginRaw + " mi") : null,
      dhDrop:      dhDropRaw   != null ? (dhDropRaw   + " mi") : null,
      totalMiles:  totalMiles,
      totalRpm:    totalRpm,
      loadType:    clean(loadType),
      truck:       clean(truck),
      length:      clean(length),
      weight:      clean(weight),
      commodity:   clean(commodity),
      referenceId: clean(referenceId),
      company:     clean(company),
      mc:          clean(mc),
      phone:       clean(phone),
      email:       clean(email),
      comments:    clean(comments)
    };

    // ===== Diagnostic logs =====
    try {
      log("[DAT Share Card] Using shared row parser values:", rowData ? {
        price:           rowData.price,
        tripMiles:       rowData.tripMiles,
        emptyPickMiles:  rowData.emptyPickMiles,
        emptyDropMiles:  rowData.dropEmptyMiles,
        totalMiles:      rowData.totalMiles,
        rpm:             rowData.rpm,
        totalRpm:        rowData.totalRpm
      } : "(row parser unavailable — using panel extraction only)");
      log("[DAT Share Card] Using expanded panel values:", {
        truck:       truck,
        length:      length,
        weight:      weight,
        loadType:    loadType,
        commodity:   commodity,
        referenceId: referenceId,
        company:     company,
        mc:          mc,
        phone:       phone,
        email:       email,
        comments:    comments
      });
      log("[DAT Share Extract] sections located:", {
        header:    !!detailsHeader,
        route:     !!routeSection,
        equipment: !!eqSection,
        rate:      !!rateSection,
        company:   !!companySection,
        contact:   !!contactSection,
        comments:  !!commentsSection
      });
      log("[DAT Share Extract] equipment map:", eqMap);
      log("[DAT Share Extract] final:", result);
    } catch (e) {}

    return result;
  }

  // ------------------------------------------------------------------
  // SHARE CARD — PRESENCE CHECK
  //
  // Bail with a friendly toast if extraction couldn't find any of the
  // load fields a dispatcher would actually want to share.
  // ------------------------------------------------------------------
  function hasUsefulLoadData(d) {
    if (!d) return false;
    return !!(d.origin || d.destination || d.rate || d.tripMiles ||
              d.totalMiles || d.company || d.truck || d.length ||
              d.weight || d.commodity || d.phone || d.email || d.comments);
  }

  // ------------------------------------------------------------------
  // SHARE CARD — DIRECT CANVAS RENDERER
  //
  // Earlier revisions of this feature built a real DOM element and
  // rasterised it via an inline <svg><foreignObject>HTML</foreignObject></svg>
  // Image. That approach worked in isolation but failed on one.dat.com:
  // Chromium taints any canvas that draws a foreignObject SVG
  // containing HTML, so canvas.toBlob() throws a SecurityError and the
  // clipboard write never fires.
  //
  // Direct canvas drawing sidesteps the whole problem — no SVG, no
  // blob: URL, no Image load, no taint, no CSP exposure. Everything
  // is laid out by walking a list of blocks twice (measure → paint).
  //
  // Output: a Promise<Blob> of an image/png ready for ClipboardItem.
  // ------------------------------------------------------------------
  function renderShareCardBlob(d) {
    return new Promise(function(resolve, reject) {
      try {
        // ================ Visual constants ================
        var DPR    = 2;     // pixel ratio for crisp output on retina/mobile
        var W      = 820;   // logical width — fits comfortably in WhatsApp
        var PADX   = 36;
        var PADTOP = 28;
        var PADBOT = 28;

        // Combined family puts system UI fonts first and a chain of
        // color-emoji fonts after. Canvas picks the first family that
        // has a glyph for each character, so latin glyphs come from
        // the UI font and emoji glyphs from the installed emoji font.
        var FAMILY =
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', " +
          "'Helvetica Neue', Arial, " +
          "'Segoe UI Emoji', 'Apple Color Emoji', " +
          "'Noto Color Emoji', sans-serif";

        var ROW_H               = 28;
        var SECTION_TOP_GAP     = 16;
        var SECTION_DIVIDER_GAP = 16;
        var SECTION_TITLE_H     = 14;
        var SECTION_TITLE_BOT   = 12;
        var HEADER_ROUTE_H      = 34;
        var HEADER_SUB_H        = 22;
        var HEADER_BOT_GAP      = 4;
        var COMMENTS_BOX_PADX   = 16;
        var COMMENTS_BOX_PADY   = 12;
        var COMMENTS_LINE_H     = 21;
        var CARD_RADIUS         = 14;

        // Palette — modern flat dispatch look.
        var COLOR_BG          = "#ffffff";
        var COLOR_BORDER      = "#e2e8f0";
        var COLOR_TEXT_STRONG = "#0f172a";
        var COLOR_TEXT_BODY   = "#334155";
        var COLOR_TEXT_MUTED  = "#64748b";
        var COLOR_TEXT_SUB    = "#475569";
        var COLOR_COMMENTS_BG = "#f8fafc";
        var COLOR_ACCENT      = "#3b82f6";

        // ================ Formatting helpers ================
        // Every extracted field goes through these so the card has a
        // consistent shape. Missing values become "N/A" except for
        // empty-pickup / empty-drop miles, which default to "0 mi"
        // (a load with zero deadhead is meaningful — "N/A" would be
        // wrong). RPM / Total / Total RPM are gated on whether trip
        // and price look valid: if either is missing we force N/A so
        // the dispatcher never reads a derived number we can't trust.
        function isBlank(v) {
          if (v === undefined || v === null) return true;
          var s = String(v).trim();
          if (!s) return true;
          if (/^[\-–—\s]+$/.test(s)) return true; // dashes only
          return false;
        }
        function formatMoney(v) {
          if (isBlank(v)) return null;
          var m = String(v).match(/[\d.,]+/);
          if (!m) return null;
          var n = parseFloat(m[0].replace(/,/g, ""));
          if (!Number.isFinite(n)) return null;
          return "$" + Math.round(n).toLocaleString("en-US");
        }
        function formatMiles(v) {
          if (isBlank(v)) return null;
          var m = String(v).match(/[\d.,]+/);
          if (!m) return null;
          var n = parseFloat(m[0].replace(/,/g, ""));
          if (!Number.isFinite(n)) return null;
          return Math.round(n).toLocaleString("en-US") + " mi";
        }
        function formatRate(v) {
          if (isBlank(v)) return null;
          var m = String(v).match(/[\d.]+/);
          if (!m) return null;
          var n = parseFloat(m[0]);
          if (!Number.isFinite(n)) return null;
          return n.toFixed(2);
        }
        function plain(v) {
          return isBlank(v) ? null : String(v).trim();
        }
        function fallback(v, fb) {
          return v == null ? (fb == null ? "N/A" : fb) : v;
        }

        // ================ Normalised values ================
        var origin       = plain(d.origin);
        var destination  = plain(d.destination);
        var route;
        if (origin && destination) {
          route = origin + "  →  " + destination;
        } else if (origin) {
          route = origin + "  →  N/A";
        } else if (destination) {
          route = "N/A  →  " + destination;
        } else {
          route = "N/A";
        }

        var pickup       = fallback(plain(d.pickupDate));
        var rateFmt      = formatMoney(d.rate);
        var tripFmt      = formatMiles(d.tripMiles);
        var emptyPkFmt   = fallback(formatMiles(d.dhOrigin),   "0 mi");
        var emptyDrFmt   = fallback(formatMiles(d.dhDrop),     "0 mi");

        // Derived values — gate on the inputs being trustworthy.
        var tripOk  = tripFmt != null;
        var priceOk = rateFmt != null;
        var totalFmt    = tripOk            ? fallback(formatMiles(d.totalMiles))   : "N/A";
        var rpmFmt      = (tripOk && priceOk) ? fallback(formatRate(d.ratePerMile)) : "N/A";
        var totalRpmFmt = (tripOk && priceOk) ? fallback(formatRate(d.totalRpm))    : "N/A";

        // Apply the rate / trip fallbacks AFTER the derived gating so
        // the gating sees the raw availability, not the "N/A" string.
        var rateDisp     = fallback(rateFmt);
        var tripDisp     = fallback(tripFmt);

        var truckFmt     = fallback(plain(d.truck));
        var lengthFmt    = fallback(plain(d.length));
        var weightFmt    = fallback(plain(d.weight));
        var loadFmt      = fallback(plain(d.loadType));
        var commodFmt    = fallback(plain(d.commodity));
        var refIdFmt     = fallback(plain(d.referenceId));
        var brokerFmt    = fallback(plain(d.company));
        var mcFmt        = fallback(plain(d.mc));
        var phoneFmt     = fallback(plain(d.phone));
        var emailFmt     = fallback(plain(d.email));
        var commentsRaw  = plain(d.comments);

        function row(label, value, emoji) {
          return { label: label, value: value, emoji: emoji || "" };
        }

        // ================ Build blocks — every section ALWAYS emits ================
        var blocks = [];

        // Header — route + pickup, always present.
        blocks.push({ kind: "header", route: route, pickup: pickup });

        // Load Details — 7 rows, always present.
        blocks.push({ kind: "section", title: "LOAD DETAILS", rows: [
          row("Rate",         rateDisp,    "\u{1F4B5}"),
          row("Trip",         tripDisp,    "\u{1F69A}"),
          row("Empty Pickup", emptyPkFmt,  "\u{1F4CD}"),
          row("Empty Drop",   emptyDrFmt,  "\u{1F4CD}"),
          row("Total",        totalFmt,    "\u{1F6E3}"),
          row("RPM",          rpmFmt,      "\u{1F4C8}"),
          row("Total RPM",    totalRpmFmt, "\u{1F4C8}")
        ]});

        // Equipment — 6 rows, always present.
        blocks.push({ kind: "section", title: "EQUIPMENT", rows: [
          row("Truck",        truckFmt),
          row("Length",       lengthFmt),
          row("Weight",       weightFmt),
          row("Load",         loadFmt),
          row("Commodity",    commodFmt),
          row("Reference ID", refIdFmt)
        ]});

        // Broker — 4 rows, always present.
        blocks.push({ kind: "section", title: "BROKER", rows: [
          row("Broker", brokerFmt),
          row("MC",     mcFmt),
          row("Phone",  phoneFmt),
          row("Email",  emailFmt)
        ]});

        // Comments — word-wrap pre-computed with a measuring canvas
        // so the total card height is known before we allocate the
        // bitmap. Embedded newlines are preserved as paragraph breaks.
        // The section is always emitted; "N/A" fills in when missing.
        var measure = document.createElement("canvas").getContext("2d");
        function wrapText(text, font, maxWidth) {
          measure.font = font;
          var paragraphs = String(text).split(/\r?\n/);
          var out = [];
          for (var pi = 0; pi < paragraphs.length; pi++) {
            var words = paragraphs[pi].split(/\s+/).filter(Boolean);
            if (!words.length) { out.push(""); continue; }
            var cur = words[0];
            for (var wi = 1; wi < words.length; wi++) {
              var trial = cur + " " + words[wi];
              if (measure.measureText(trial).width <= maxWidth) {
                cur = trial;
              } else {
                out.push(cur);
                cur = words[wi];
              }
            }
            out.push(cur);
          }
          return out;
        }

        var commentsFont = "400 14px " + FAMILY;
        var commentsMaxW = W - PADX * 2 - COMMENTS_BOX_PADX * 2;
        var commentsLines = wrapText(
          commentsRaw == null ? "N/A" : commentsRaw,
          commentsFont,
          commentsMaxW
        );
        if (!commentsLines.length) commentsLines = ["N/A"];
        blocks.push({ kind: "comments", lines: commentsLines });

        // ================ Layout pass: total height ================
        function blockHeight(b) {
          if (b.kind === "header") {
            var h = 0;
            if (b.route)  h += HEADER_ROUTE_H;
            if (b.pickup) h += HEADER_SUB_H;
            h += HEADER_BOT_GAP;
            return h;
          }
          if (b.kind === "section") {
            return SECTION_TOP_GAP + SECTION_DIVIDER_GAP +
                   SECTION_TITLE_H + SECTION_TITLE_BOT +
                   b.rows.length * ROW_H;
          }
          if (b.kind === "comments") {
            var boxH = COMMENTS_BOX_PADY * 2 + b.lines.length * COMMENTS_LINE_H;
            return SECTION_TOP_GAP + SECTION_DIVIDER_GAP +
                   SECTION_TITLE_H + SECTION_TITLE_BOT + boxH;
          }
          return 0;
        }

        var H = PADTOP;
        for (var bi = 0; bi < blocks.length; bi++) H += blockHeight(blocks[bi]);
        H += PADBOT;

        // ================ Allocate canvas ================
        var canvas = document.createElement("canvas");
        canvas.width  = Math.round(W * DPR);
        canvas.height = Math.round(H * DPR);
        var ctx = canvas.getContext("2d");
        ctx.scale(DPR, DPR);
        ctx.textBaseline = "top";

        function roundRect(x, y, w, h, r) {
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, w, h, r);
            return;
          }
          ctx.moveTo(x + r, y);
          ctx.arcTo(x + w, y,     x + w, y + h, r);
          ctx.arcTo(x + w, y + h, x,     y + h, r);
          ctx.arcTo(x,     y + h, x,     y,     r);
          ctx.arcTo(x,     y,     x + w, y,     r);
          ctx.closePath();
        }

        // ================ Paint ================
        // Solid white outer fill so the corners read intentionally
        // when the PNG is pasted onto dark-mode messaging apps.
        ctx.fillStyle = COLOR_BG;
        ctx.fillRect(0, 0, W, H);

        // Card border — half-pixel offset keeps the 1px stroke sharp.
        roundRect(0.5, 0.5, W - 1, H - 1, CARD_RADIUS);
        ctx.strokeStyle = COLOR_BORDER;
        ctx.lineWidth   = 1;
        ctx.stroke();

        function drawDivider(yy) {
          ctx.strokeStyle = COLOR_BORDER;
          ctx.lineWidth   = 1;
          ctx.beginPath();
          var yLine = Math.round(yy) + 0.5;
          ctx.moveTo(PADX, yLine);
          ctx.lineTo(W - PADX, yLine);
          ctx.stroke();
        }

        var y = PADTOP;

        for (var bj = 0; bj < blocks.length; bj++) {
          var blk = blocks[bj];

          if (blk.kind === "header") {
            if (blk.route) {
              ctx.font      = "700 24px " + FAMILY;
              ctx.fillStyle = COLOR_TEXT_STRONG;
              ctx.textAlign = "left";
              ctx.fillText("\u{1F4CD}  " + blk.route, PADX, y);
              y += HEADER_ROUTE_H;
            }
            if (blk.pickup) {
              ctx.font      = "500 14px " + FAMILY;
              ctx.fillStyle = COLOR_TEXT_SUB;
              ctx.textAlign = "left";
              ctx.fillText("Pickup: " + blk.pickup, PADX, y);
              y += HEADER_SUB_H;
            }
            y += HEADER_BOT_GAP;
            continue;
          }

          // Section header (used for both 'section' and 'comments')
          y += SECTION_TOP_GAP;
          drawDivider(y);
          y += SECTION_DIVIDER_GAP;
          ctx.font      = "700 11px " + FAMILY;
          ctx.fillStyle = COLOR_TEXT_MUTED;
          ctx.textAlign = "left";
          var title = blk.kind === "comments" ? "COMMENTS" : blk.title;
          ctx.fillText(title, PADX, y);
          y += SECTION_TITLE_H + SECTION_TITLE_BOT;

          if (blk.kind === "section") {
            for (var ri = 0; ri < blk.rows.length; ri++) {
              var rowItem = blk.rows[ri];
              // Left: optional emoji + label
              ctx.font      = "500 15px " + FAMILY;
              ctx.fillStyle = COLOR_TEXT_BODY;
              ctx.textAlign = "left";
              var leftText = rowItem.emoji
                ? (rowItem.emoji + "  " + rowItem.label)
                : rowItem.label;
              ctx.fillText(leftText, PADX, y);
              // Right: value, right-aligned
              ctx.font      = "600 15px " + FAMILY;
              ctx.fillStyle = COLOR_TEXT_STRONG;
              ctx.textAlign = "right";
              ctx.fillText(rowItem.value, W - PADX, y);
              y += ROW_H;
            }
          } else {
            // Comments box — soft slate background with blue accent.
            var boxX = PADX;
            var boxY = y;
            var boxW = W - PADX * 2;
            var boxH = COMMENTS_BOX_PADY * 2 + blk.lines.length * COMMENTS_LINE_H;
            roundRect(boxX, boxY, boxW, boxH, 8);
            ctx.fillStyle = COLOR_COMMENTS_BG;
            ctx.fill();
            // Left accent stripe, clipped to the round-rect so it
            // follows the box's left corners cleanly.
            ctx.save();
            roundRect(boxX, boxY, boxW, boxH, 8);
            ctx.clip();
            ctx.fillStyle = COLOR_ACCENT;
            ctx.fillRect(boxX, boxY, 4, boxH);
            ctx.restore();
            // Text
            ctx.font      = "400 14px " + FAMILY;
            ctx.fillStyle = COLOR_TEXT_BODY;
            ctx.textAlign = "left";
            for (var cli = 0; cli < blk.lines.length; cli++) {
              ctx.fillText(
                blk.lines[cli],
                boxX + COMMENTS_BOX_PADX,
                boxY + COMMENTS_BOX_PADY + cli * COMMENTS_LINE_H
              );
            }
            y += boxH;
          }
        }

        // ================ Export ================
        canvas.toBlob(function(blob) {
          if (blob) resolve(blob);
          else reject(new Error("canvas.toBlob returned null"));
        }, "image/png");
      } catch (err) {
        reject(err);
      }
    });
  }

  function showShareToast(message, isError) {
    try {
      // Reuse a single toast node so rapid clicks don't pile up.
      var toast = document.querySelector("." + SHARE_TOAST_CLASS);
      if (!toast) {
        toast = document.createElement("div");
        toast.className = "dat-helper-toast " + SHARE_TOAST_CLASS;
        toast.setAttribute(EXTENSION_ATTRIBUTE, "true");
        document.body.appendChild(toast);
      }
      toast.classList.toggle("dat-helper-toast-error", !!isError);
      toast.textContent = message;
      // Force a reflow so the entry transition runs even when reusing.
      void toast.offsetWidth;
      toast.classList.add("dat-helper-toast-visible");
      window.clearTimeout(toast._datHelperHideTimer);
      toast._datHelperHideTimer = window.setTimeout(function() {
        toast.classList.remove("dat-helper-toast-visible");
      }, 2400);
    } catch (e) {
      warn(SHARE_LOG, "toast failed:", e);
    }
  }

  // ------------------------------------------------------------------
  // SHARE CARD — ORCHESTRATION
  //
  // Click handler entry point. Renders the card to a PNG via direct
  // canvas drawing (no DOM mount, no SVG, no taint risk) and copies
  // the PNG to the clipboard as image/png. The user then pastes the
  // image into WhatsApp / iMessage / Telegram / Slack / email /
  // Discord via Ctrl+V.
  //
  // Clipboard nuance: navigator.clipboard.write() is gated on user
  // activation. We call it synchronously inside the click handler
  // with a ClipboardItem whose value is a Promise<Blob>; the browser
  // awaits the blob itself while the permission grant stays anchored
  // to the original click. Browsers that don't accept a Promise-
  // valued ClipboardItem throw synchronously, in which case we fall
  // back to awaiting the blob first and writing it directly (same
  // user gesture, just less robust under strict activation rules).
  // ------------------------------------------------------------------
  function generateAndCopyLoadCard(data, btn) {
    if (!hasUsefulLoadData(data)) {
      showShareToast("Couldn't read load details", true);
      return Promise.resolve();
    }
    if (!window.ClipboardItem ||
        !navigator.clipboard ||
        typeof navigator.clipboard.write !== "function") {
      warn(SHARE_LOG, "Clipboard image API not available in this browser");
      showShareToast("Clipboard image copy not supported here", true);
      return Promise.resolve();
    }

    log(SHARE_LOG, "Building share card");

    // ---- Diagnostic logs ----
    // Lets the dispatcher inspect exactly what extraction surfaced
    // from the expanded panel, plus a quick "missing fields" list so
    // it's obvious which DAT rows didn't yield a value this run.
    try {
      log("[DAT Share Card] Extracted load details:", data);
      var DATA_KEYS = [
        "origin", "destination", "pickupDate",
        "rate", "ratePerMile", "tripMiles",
        "dhOrigin", "dhDrop", "totalMiles", "totalRpm",
        "loadType", "truck", "length", "weight",
        "commodity", "referenceId",
        "company", "mc", "phone", "email", "comments"
      ];
      var missingFields = [];
      for (var dk = 0; dk < DATA_KEYS.length; dk++) {
        var k = DATA_KEYS[dk];
        var v = data && data[k];
        if (v === undefined || v === null ||
            (typeof v === "string" && v.trim() === "")) {
          missingFields.push(k);
        }
      }
      if (missingFields.length) {
        log("[DAT Share Card] Missing fields:", missingFields.join(", "));
      }
    } catch (logErr) {
      // Logging must never break the share flow.
      warn(SHARE_LOG, "diagnostic log failed:", logErr);
    }

    function flashSuccess() {
      showShareToast("✅ Load card copied");
      if (btn instanceof HTMLElement) {
        var labelSpan = btn.querySelector("span:last-child");
        var orig = labelSpan ? labelSpan.textContent : null;
        if (labelSpan) labelSpan.textContent = "Copied!";
        window.setTimeout(function() {
          if (labelSpan && orig != null) labelSpan.textContent = orig;
        }, 1400);
      }
    }

    var blobPromise = renderShareCardBlob(data).then(function(blob) {
      log(SHARE_LOG, "Canvas rendered");
      return blob;
    });

    // Primary path: pass the Promise<Blob> straight into ClipboardItem
    // so the browser preserves user activation across the async render.
    var writePromise;
    try {
      writePromise = navigator.clipboard.write([
        new ClipboardItem({ "image/png": blobPromise })
      ]);
    } catch (ctorErr) {
      // Fallback: await the blob ourselves, then write. Same user
      // gesture, just less robust on browsers with strict activation.
      writePromise = blobPromise.then(function(blob) {
        return navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob })
        ]);
      });
    }

    return writePromise
      .then(function() {
        log(SHARE_LOG, "Clipboard image copied");
        flashSuccess();
      })
      .catch(function(err) {
        warn(SHARE_LOG, "image copy failed:", err);
        showShareToast("Clipboard image copy failed", true);
      });
  }

  // ------------------------------------------------------------------
  // LIFECYCLE — observer that injects share buttons into expanded panels
  // ------------------------------------------------------------------
  var shareObserver = null;
  var shareInjectScheduled = false;
  function scheduleShareInject() {
    if (shareInjectScheduled) return;
    shareInjectScheduled = true;
    // Coalesce DOM-mutation bursts into a single injection pass per
    // animation frame. This keeps the observer cheap during DAT's own
    // re-renders while still updating before the next paint.
    var run = function() {
      shareInjectScheduled = false;
      try {
        injectShareButtons();
      } catch (e) {
        warn(SHARE_LOG, "inject failed:", e);
      }
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 16);
    }
  }

  function startShareLoadFeature() {
    if (!document.body) {
      // Body isn't ready yet — wait for DOMContentLoaded then retry.
      document.addEventListener(
        "DOMContentLoaded",
        function once() {
          document.removeEventListener("DOMContentLoaded", once);
          startShareLoadFeature();
        },
        { once: true }
      );
      return;
    }
    // Idempotent: never start a second observer.
    if (shareObserver) {
      scheduleShareInject();
      return;
    }
    shareObserver = new MutationObserver(function(mutations) {
      // Cheap filter: only react when nodes are added/removed. Attribute
      // mutations on existing nodes don't expand/collapse panels.
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) {
          scheduleShareInject();
          return;
        }
      }
    });
    shareObserver.observe(document.body, { childList: true, subtree: true });
    // Initial pass for any panels already expanded when the feature starts.
    scheduleShareInject();
    log(SHARE_LOG, "started");
  }

  function stopShareLoadFeature() {
    if (shareObserver) {
      try { shareObserver.disconnect(); } catch (_) {}
      shareObserver = null;
    }
    shareInjectScheduled = false;
    // Remove any of our buttons + unwrap action stacks. DAT's own VIEW
    // ROUTE button is preserved inside unwrapActionStacks().
    try {
      var buttons = document.querySelectorAll(
        '[' + EXTENSION_ATTRIBUTE + '="true"][data-dat-helper-role="' + SHARE_BTN_ROLE + '"]'
      );
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].parentNode) buttons[i].parentNode.removeChild(buttons[i]);
      }
    } catch (e) {
      warn(SHARE_LOG, "button cleanup failed:", e);
    }
    try { unwrapActionStacks(); } catch (e) { warn(SHARE_LOG, "unwrap failed:", e); }
    // Drop any toast we left behind so the page is fully restored.
    try {
      var toast = document.querySelector("." + SHARE_TOAST_CLASS);
      if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    } catch (_) {}
    log(SHARE_LOG, "stopped");
  }

  // Wire up the lifecycle placeholders defined near the top of the IIFE
  // so applyCurrentState() / cleanup actually drive this feature.
  shareLoad.start = startShareLoadFeature;
  shareLoad.stop  = stopShareLoadFeature;
})();