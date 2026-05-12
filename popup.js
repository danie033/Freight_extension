const STORAGE_AREA = chrome.storage.local;
const SETTINGS_KEY = "datHelperSettings";
const DEFAULT_SETTINGS = {
  enabled: false,
  minPrice: null,
  maxPrice: null,
  minRpm: null,
  maxRpm: null,
  minTripMiles: null,
  maxTripMiles: null,
  strictMode: false
};

const FIELD_IDS = [
  "minPrice",
  "maxPrice",
  "minRpm",
  "maxRpm",
  "minTripMiles",
  "maxTripMiles"
];

document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    enabled: document.getElementById("enabled"),
    toggleStatus: document.getElementById("toggleStatus"),
    strictMode: document.getElementById("strictMode"),
    applyButton: document.getElementById("applyButton"),
    clearButton: document.getElementById("clearButton"),
    debugButton: document.getElementById("debugButton"),
    copyButton: document.getElementById("copyButton"),
    statusMessage: document.getElementById("statusMessage")
  };

  const fields = Object.fromEntries(
    FIELD_IDS.map((id) => [id, document.getElementById(id)])
  );

  function setStatus(message, isError = false) {
    elements.statusMessage.textContent = message;
    elements.statusMessage.classList.toggle("error", isError);
  }

  function updateToggleLabel(enabled) {
    elements.toggleStatus.textContent = enabled
      ? "ON and watching DAT One"
      : "OFF and leaving DAT unchanged";
  }

  function parseNumericInput(input) {
    const value = input.value.trim();
    if (!value) {
      return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  function readForm() {
    return {
      enabled: elements.enabled.checked,
      strictMode: elements.strictMode.checked,
      minPrice: parseNumericInput(fields.minPrice),
      maxPrice: parseNumericInput(fields.maxPrice),
      minRpm: parseNumericInput(fields.minRpm),
      maxRpm: parseNumericInput(fields.maxRpm),
      minTripMiles: parseNumericInput(fields.minTripMiles),
      maxTripMiles: parseNumericInput(fields.maxTripMiles)
    };
  }

  function populateForm(settings) {
    elements.enabled.checked = Boolean(settings.enabled);
    elements.strictMode.checked = Boolean(settings.strictMode);
    updateToggleLabel(Boolean(settings.enabled));

    FIELD_IDS.forEach((id) => {
      const value = settings[id];
      fields[id].value = value == null ? "" : String(value);
    });
  }

  async function getActiveDatTab() {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    return tabs[0] || null;
  }

  async function sendToActiveDatTab(message) {
    const tab = await getActiveDatTab();
    if (!tab?.id) {
      throw new Error("Open a DAT One tab first.");
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      throw new Error("Open the popup while the active tab is on DAT One search results.");
    }
  }

  async function saveSettings(nextSettings, successMessage) {
    await STORAGE_AREA.set({ [SETTINGS_KEY]: nextSettings });
    populateForm(nextSettings);
    setStatus(successMessage);
  }

  const stored = await STORAGE_AREA.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  populateForm({ ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) });
  setStatus("Ready.");

  elements.enabled.addEventListener("change", async () => {
    try {
      const nextSettings = { ...readForm(), enabled: elements.enabled.checked };
      await saveSettings(
        nextSettings,
        nextSettings.enabled
          ? "Extension enabled."
          : "Extension disabled. DAT page will restore."
      );

      if (nextSettings.enabled) {
        await sendToActiveDatTab({ type: "DAT_HELPER_APPLY_NOW" });
      }
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Could not update extension state.", true);
    }
  });

  elements.applyButton.addEventListener("click", async () => {
    try {
      const nextSettings = readForm();
      await saveSettings(nextSettings, "Filters saved.");
      if (nextSettings.enabled) {
        await sendToActiveDatTab({ type: "DAT_HELPER_APPLY_NOW" });
      }
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Could not apply filters.", true);
    }
  });

  elements.clearButton.addEventListener("click", async () => {
    try {
      FIELD_IDS.forEach((id) => {
        fields[id].value = "";
      });
      elements.strictMode.checked = false;

      const existing = readForm();
      const clearedSettings = {
        ...existing,
        minPrice: null,
        maxPrice: null,
        minRpm: null,
        maxRpm: null,
        minTripMiles: null,
        maxTripMiles: null,
        strictMode: false
      };

      await saveSettings(clearedSettings, "Filters cleared.");
      if (clearedSettings.enabled) {
        await sendToActiveDatTab({ type: "DAT_HELPER_APPLY_NOW" });
      }
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Could not clear filters.", true);
    }
  });

  elements.debugButton.addEventListener("click", async () => {
    try {
      const response = await sendToActiveDatTab({ type: "DAT_HELPER_RUN_DEBUG_SCAN" });
      if (!response?.ok) {
        throw new Error(response?.error || "Debug scan failed.");
      }

      setStatus(
        `Debug scan complete. Strategy: ${response.report.selectedStrategyName}. Candidates: ${response.report.candidateCount}.`
      );
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Could not run debug scan.", true);
    }
  });

  elements.copyButton.addEventListener("click", async () => {
    try {
      const response = await sendToActiveDatTab({ type: "DAT_HELPER_GET_DEBUG_REPORT" });
      if (!response?.ok || !response.reportText) {
        throw new Error(response?.error || "No debug report available.");
      }

      await navigator.clipboard.writeText(response.reportText);
      console.log(response.reportText);
      setStatus("Debug report copied to clipboard.");
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Could not copy debug report.", true);
    }
  });
});
