# DAT One Load Helper

Manifest V3 browser extension for Microsoft Edge and other Chromium browsers. It runs only on the visible, logged-in DAT One page and filters only the load cards or rows already rendered in the browser.

Files in this folder:

- `manifest.json`
- `popup.html`
- `popup.js`
- `content.js`
- `styles.css`
- `README.md`

## Load The Extension In Edge

1. Open `edge://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select `D:\DISPATCH\Z_ADDS_EZ_CARGO\Extension`.

## Why This Version Uses Debug Scan

DAT One is a logged-in React app at [https://one.dat.com/search-loads](https://one.dat.com/search-loads). Public HTML is not enough to identify the real load row/card layout reliably. This extension includes an in-page layout scanner that runs inside the authenticated browser session and tries to find the smallest repeated load result elements safely.

The scanner:

- looks for repeated sibling elements
- checks for freight-like text such as price, miles, RPM, origin/destination, or deadhead labels
- rejects obvious page wrappers and large containers
- blocks filtering if the selected candidate set looks unsafe

## How To Use ON/OFF

1. Open DAT One to `https://one.dat.com/search-loads`.
2. Open the extension popup.
3. Turn the main toggle ON to start scanning visible load results, calculating values, and applying saved filters.
4. Turn the toggle OFF to stop observing the page, remove helper UI, and restore hidden rows.

The ON/OFF state is saved in `chrome.storage.local`, so it persists across page refreshes.

## Filters

The extension filters only by:

- price
- calculated RPM
- trip miles

The popup fields are:

- `minPrice`
- `maxPrice`
- `minRpm`
- `maxRpm`
- `minTripMiles`
- `maxTripMiles`
Trip-mile filters are based on trip miles only.

## Displayed Calculations

The extension calculates and shows:

- trip miles
- empty or deadhead miles
- total miles
- RPM
- all-in RPM

Formulas:

- `totalMiles = tripMiles + emptyMiles`
- `rpm = price / tripMiles`
- `allInRpm = price / (tripMiles + emptyMiles)`

Important:

- empty or deadhead miles are only for display and total-mile calculation
- total miles are not used for filtering
- all-in RPM is not used for filtering
- calculated RPM is used for filtering when `price` and `tripMiles` can be parsed

## Debug Scan

Use Debug Scan when DAT changes layout or when filtering looks unsafe.

1. Open the extension popup on the DAT One search results page.
2. Click `Debug Scan`.
3. The page will outline the selected candidate load cards or rows with `.dat-helper-debug-outline`.
4. A small debug panel will appear on the page with the chosen strategy and candidate count.

The debug report includes:

- current URL
- number of candidate elements found
- selected strategy name
- sample text from the first candidates
- parsed values from the first candidates
- diagnostics for accepted or rejected strategies
- warnings when candidates seem too large or unsafe

## Copy Debug Report

1. Run `Debug Scan` first.
2. Click `Copy Debug Report`.
3. The popup will request the latest report from the page, copy it to the clipboard, and the page-side script will also log the report to the browser console.

## If All Results Disappear

1. Turn the extension OFF.
2. Reload the DAT One page.
3. Turn the extension ON only after the results list is visible again.
4. Run `Debug Scan`.
5. Inspect the candidate outlines.
6. If the outlined elements are wrappers instead of individual loads, refine `getCandidateLoadElements()` and the candidate scoring rules in [content.js](D:\DISPATCH\Z_ADDS_EZ_CARGO\Extension\content.js).

This version includes a safety guard. If candidate detection looks unsafe, it will not hide anything and the status badge will show:

`DAT Helper: selector unsafe, run Debug Scan`

## Cleanup And Reversibility

When the extension is OFF it:

- stops the `MutationObserver`
- removes inline badges
- removes debug outlines
- removes missing-data styling
- restores hidden rows
- removes the status badge

All extension-created nodes include:

`data-dat-helper="true"`

Cleanup removes them with:

```js
document.querySelectorAll('[data-dat-helper="true"]').forEach((el) => el.remove());
```

The extension never hides with direct inline style changes. It only hides loads with:

```js
element.classList.add("dat-helper-hidden");
```

and only after `isSafeCandidateSet(elements)` returns `true`.

## Privacy And Scope

- no scraping
- no exporting
- no background querying
- no auto-refreshing
- no auto-clicking
- no auto-booking
- no automation of DAT actions
- no external APIs
- no persistence of load data

All logic runs locally in the browser against visible page content only.
