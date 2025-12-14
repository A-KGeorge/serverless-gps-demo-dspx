/**
 * GPS Visualization Client
 * Real-time map visualization with raw/filtered trace toggle
 */

import L from "leaflet";
import type { ProcessedGPS } from "../shared/gps-pipeline.js";

// Map and layers
let map: L.Map;
let darkTileLayer: L.TileLayer;
let lightTileLayer: L.TileLayer;
let isDarkMode = true;
const rawTraces = new Map<string, L.Polyline>();
const filteredTraces = new Map<string, L.Polyline>();
const markers = new Map<string, L.CircleMarker>();

// State
let pointsProcessed = 0;
let velocitySum = 0;
let velocityCount = 0;
let currentSensor: string | null = null;
let eventSource: EventSource | null = null;

// UI elements
const statusIndicator = document.getElementById("status") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const showRawCheckbox = document.getElementById("show-raw") as HTMLInputElement;
const showFilteredCheckbox = document.getElementById(
  "show-filtered"
) as HTMLInputElement;
const sensorSelect = document.getElementById(
  "sensor-select"
) as HTMLSelectElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const pointsCountEl = document.getElementById("points-count") as HTMLElement;
const avgVelocityEl = document.getElementById("avg-velocity") as HTMLElement;
const movementStatusEl = document.getElementById(
  "movement-status"
) as HTMLElement;
const themeToggleBtn = document.getElementById(
  "theme-toggle"
) as HTMLButtonElement;

/**
 * Initialize Leaflet map
 */
function initMap() {
  map = L.map("map").setView([39.9, 116.4], 12); // Beijing center (Geolife dataset)

  // Create tile layers with English-only labels
  darkTileLayer = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 19,
    }
  );

  // Use Thunderforest Transport for English labels (or CARTO light with Latin script)
  lightTileLayer = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 19,
    }
  );

  // Start with dark theme
  darkTileLayer.addTo(map);
}

/**
 * Connect to Redis pub/sub for processed GPS data
 */
function connectToPubSub() {
  // Check if we should filter by sensor (from URL params or dropdown)
  const urlParams = new URLSearchParams(window.location.search);
  const sensorFilter = urlParams.get("sensorId") || currentSensor;

  // Build EventSource URL with optional filter
  const streamUrl = sensorFilter
    ? `/api/gps-stream?sensorId=${encodeURIComponent(sensorFilter)}`
    : "/api/gps-stream";

  console.log(`🔌 Connecting to SSE: ${streamUrl}`);
  const eventSource = new EventSource(streamUrl);

  eventSource.onopen = () => {
    statusIndicator.classList.add("connected");
    statusIndicator.classList.remove("disconnected");
    statusText.textContent = sensorFilter
      ? `Connected (${sensorFilter})`
      : "Connected (All)";
  };

  eventSource.onerror = () => {
    statusIndicator.classList.remove("connected");
    statusIndicator.classList.add("disconnected");
    statusText.textContent = "Disconnected";
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as ProcessedGPS & {
        sensorId: string;
      };
      handleGPSData(data);
    } catch (err) {
      console.error("Failed to parse GPS data:", err);
    }
  };

  return eventSource;
}

/**
 * Handle incoming GPS data point
 */
function handleGPSData(data: ProcessedGPS & { sensorId: string }) {
  const { sensorId } = data;

  // Filter by selected sensor
  if (currentSensor && currentSensor !== sensorId) {
    return;
  }

  // Add sensor to dropdown if new
  if (
    !Array.from(sensorSelect.options).some(
      (opt: HTMLOptionElement) => opt.value === sensorId
    )
  ) {
    const option = document.createElement("option");
    option.value = sensorId;
    option.textContent = sensorId;
    sensorSelect.appendChild(option);
  }

  // Update raw trace
  if (showRawCheckbox.checked) {
    updateTrace(sensorId, "raw", data.lat, data.lon);
  }

  // Update filtered trace
  if (showFilteredCheckbox.checked) {
    updateTrace(sensorId, "filtered", data.smoothedLat, data.smoothedLon);
  }

  // Update current position marker
  updateMarker(sensorId, data.smoothedLat, data.smoothedLon, data.isMoving);

  // Update statistics
  pointsProcessed++;
  velocitySum += data.smoothedVelocity;
  velocityCount++;

  pointsCountEl.textContent = pointsProcessed.toString();
  avgVelocityEl.textContent = `${(velocitySum / velocityCount).toFixed(2)} m/s`;
  movementStatusEl.textContent = data.isMoving ? "🚗 Moving" : "🅿️ Stopped";
}

/**
 * Update trace polyline for sensor
 */
function updateTrace(
  sensorId: string,
  type: "raw" | "filtered",
  lat: number,
  lon: number
) {
  const traces = type === "raw" ? rawTraces : filteredTraces;
  let trace = traces.get(sensorId);

  if (!trace) {
    // Create new polyline
    const color = type === "raw" ? "#cc3333" : "#33cc33";
    trace = L.polyline([], {
      color,
      weight: 3,
      opacity: 0.8,
      smoothFactor: 1,
    }).addTo(map);
    traces.set(sensorId, trace);
  }

  // Add point to trace
  trace.addLatLng([lat, lon]);

  // Auto-fit map bounds if first point
  if (trace.getLatLngs().length === 1) {
    map.setView([lat, lon], 15);
  }
}

/**
 * Update current position marker
 */
function updateMarker(
  sensorId: string,
  lat: number,
  lon: number,
  isMoving: boolean
) {
  let marker = markers.get(sensorId);

  if (!marker) {
    // Create new marker
    marker = L.circleMarker([lat, lon], {
      radius: 8,
      fillColor: "#0066cc",
      color: "#fff",
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8,
    }).addTo(map);

    marker.bindPopup(`Sensor: ${sensorId}`);
    markers.set(sensorId, marker);
  }

  // Update position
  marker.setLatLng([lat, lon]);

  // Update color based on movement
  marker.setStyle({
    fillColor: isMoving ? "#33cc33" : "#cc9933",
  });
}

/**
 * Clear all traces from map
 */
function clearMap() {
  // Clear raw traces
  rawTraces.forEach((trace) => trace.remove());
  rawTraces.clear();

  // Clear filtered traces
  filteredTraces.forEach((trace) => trace.remove());
  filteredTraces.clear();

  // Clear markers
  markers.forEach((marker) => marker.remove());
  markers.clear();

  // Clear sensor dropdown (except "All Sensors")
  while (sensorSelect.options.length > 1) {
    sensorSelect.remove(1);
  }

  // Reset statistics
  pointsProcessed = 0;
  velocitySum = 0;
  velocityCount = 0;
  pointsCountEl.textContent = "0";
  avgVelocityEl.textContent = "0.0 m/s";
  movementStatusEl.textContent = "—";
}

/**
 * Toggle trace visibility
 */
function updateTraceVisibility() {
  const showRaw = showRawCheckbox.checked;
  const showFiltered = showFilteredCheckbox.checked;

  rawTraces.forEach((trace) => {
    if (showRaw) {
      trace.addTo(map);
    } else {
      trace.remove();
    }
  });

  filteredTraces.forEach((trace) => {
    if (showFiltered) {
      trace.addTo(map);
    } else {
      trace.remove();
    }
  });
}

/**
 * Filter by sensor
 */
function updateSensorFilter() {
  currentSensor = sensorSelect.value || null;

  // Reconnect with new filter
  if (eventSource) {
    console.log("🔄 Reconnecting with new filter...");
    eventSource.close();
    eventSource = connectToPubSub();
  }
}

/**
 * Toggle map theme
 */
function toggleTheme() {
  isDarkMode = !isDarkMode;

  if (isDarkMode) {
    // Switch to dark mode
    document.body.classList.remove("light-mode");
    lightTileLayer.remove();
    darkTileLayer.addTo(map);
    themeToggleBtn.textContent = "🌙 Dark Mode";
  } else {
    // Switch to light mode
    document.body.classList.add("light-mode");
    darkTileLayer.remove();
    lightTileLayer.addTo(map);
    themeToggleBtn.textContent = "☀️ Light Mode";
  }
}

// Event listeners
showRawCheckbox.addEventListener("change", updateTraceVisibility);
showFilteredCheckbox.addEventListener("change", updateTraceVisibility);
sensorSelect.addEventListener("change", updateSensorFilter);
clearBtn.addEventListener("click", clearMap);
themeToggleBtn.addEventListener("click", toggleTheme);

// Initialize
initMap();
eventSource = connectToPubSub();

console.log("🗺️ GPS Visualization Client ready");
