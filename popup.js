const STORAGE_AREA = chrome.storage.local;
const SETTINGS_KEY = "datHelperSettings";
const DEFAULT_SETTINGS = {
  enabled: false,
  minPrice: null,
  maxPrice: null,
  minRpm: null,
  maxRpm: null,
  minTripMiles: null,
  maxTripMiles: null
};

const FIELD_IDS = [
  "minPrice",
  "maxPrice",
  "minRpm",
  "maxRpm",
  "minTripMiles",
  "maxTripMiles"
];

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

document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    enabled: document.getElementById("enabled"),
    toggleStatus: document.getElementById("toggleStatus"),
    applyButton: document.getElementById("applyButton"),
    clearButton: document.getElementById("clearButton"),
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

  function isDatPageUrl(url) {
    return typeof url === "string" && (
      url.includes("one.dat.com/search-loads") ||
      url.startsWith("https://one.dat.com/")
    );
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
    const normalizedSettings = normalizeSettings(nextSettings);
    await STORAGE_AREA.set({ [SETTINGS_KEY]: normalizedSettings });
    populateForm(normalizedSettings);
    setStatus(successMessage);
    return normalizedSettings;
  }

  const stored = await STORAGE_AREA.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  populateForm(normalizeSettings(stored[SETTINGS_KEY] || DEFAULT_SETTINGS));
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
      const nextSettings = {
        ...readForm(),
        enabled: true
      };
      const savedSettings = await saveSettings(nextSettings, "Filters saved. Refreshing DAT...");
      const tab = await getActiveDatTab();

      if (!tab?.id || !isDatPageUrl(tab.url)) {
        setStatus("Filters saved. Open DAT to apply.");
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "DAT_HELPER_SETTINGS_UPDATED",
          settings: savedSettings
        });
      } catch (error) {
        console.debug("DAT settings update message skipped before reload.", error);
      }

      await chrome.tabs.reload(tab.id);
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

      const existing = readForm();
      const clearedSettings = {
        ...existing,
        minPrice: null,
        maxPrice: null,
        minRpm: null,
        maxRpm: null,
        minTripMiles: null,
        maxTripMiles: null
      };

      const savedSettings = await saveSettings(clearedSettings, "Filters cleared. Refreshing DAT...");
      const tab = await getActiveDatTab();

      if (!tab?.id || !isDatPageUrl(tab.url)) {
        setStatus("Filters cleared. Open DAT to apply.");
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "DAT_HELPER_SETTINGS_UPDATED",
          settings: savedSettings
        });
      } catch (error) {
        console.debug("DAT settings update message skipped before reload.", error);
      }

      await chrome.tabs.reload(tab.id);
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Could not clear filters.", true);
    }
  });
});
