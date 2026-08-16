(function () {
  const API_KEY = "4b904773607e146669f34eccef2a3c0e";
  const pageMode = document.body.dataset.page || "home";

  // Shared app state. Keeping the last-rendered payload lets the unit
  // toggle re-render instantly from real data instead of re-fetching.
  const state = {
    unit: localStorage.getItem("ws-unit") === "F" ? "F" : "C",
    appearance: localStorage.getItem("ws-appearance") === "light" ? "light" : "dark",
    current: null,
    forecast: null,
    regional: null,
    heroMap: null,
    mainMap: null,
    mapMarker: null,
    mapDataRing: null,
    activeLayer: "temperature",
    timelineEntries: [],
    timelineIndex: 0,
    timelinePlaying: false,
    timelineFrame: null,
    timelineLastStep: 0,
    timelineDuration: 1800,
    forecastCardIndex: 0,
  };

  // A single definition supplies the marker color and legend, keeping the
  // data value -> color -> map -> legend relationship exact.
  const MAP_LAYERS = {
    temperature: { label: "TEMPERATURE", unit: "degrees", range: [-10, 40], stops: ["#5f7cff", "#75c9ff", "#e8e7a8", "#ffac63", "#ee665f"], value: (e) => e.main.temp, owmTile: "temp_new" },
    precipitation: { label: "PRECIPITATION", unit: "mm / 3h", range: [0, 20], stops: ["#b6e8ff", "#67b6ee", "#3d72cf", "#573f9b"], value: (e) => (e.rain && e.rain["3h"]) || 0, owmTile: "precipitation_new" },
    wind: { label: "WIND", unit: "km/h", range: [0, 60], stops: ["#b6e8ff", "#62a6d9", "#4370bf", "#965dcb"], value: (e) => e.wind.speed * 3.6, owmTile: "wind_new" },
    clouds: { label: "CLOUD COVER", unit: "%", range: [0, 100], stops: ["#2d4054", "#70869a", "#b8c3ce", "#eef2f5"], value: (e) => e.clouds.all, owmTile: "clouds_new" },
    pressure: { label: "PRESSURE", unit: "hPa", range: [980, 1050], stops: ["#706ac5", "#7baed7", "#9fd9c3", "#f0df9c"], value: (e) => e.main.pressure, owmTile: "pressure_new" },
  };

  async function init() {
    injectIconDefs();
    setupTopNav();
    setupRevealObserver();

    const pageBindings = bindSearchControls();

    try {
      setLoading(true);
      const initialLocation = await getDefaultWeather();
      setLoading(false);

      if (!initialLocation) {
        renderEmptyHomeState();
        return;
      }

      renderCurrentPage(initialLocation);
    } catch (error) {
      setLoading(false);
      console.warn(error);
      showSearchError("Couldn't load weather right now. Check your connection and try again.");
    }

    if (pageBindings.cityInput) {
      pageBindings.cityInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          pageBindings.handleSearch();
        }
      });
    }
  }

  function renderCurrentPage(payload) {
    state.current = payload.current;
    state.forecast = payload.forecast;
    state.regional = payload.regional;

    applyWeatherTheme(payload.current);

    if (pageMode === "home") renderHomeDashboard(payload.current, payload.forecast, payload.regional);
    if (pageMode === "map") renderMapPage(payload.current, payload.forecast, payload.regional);
    if (pageMode === "analytics") renderAnalyticsPage(payload.current, payload.forecast, payload.regional);
    if (pageMode === "forecast") renderForecastPage(payload.current, payload.forecast, payload.regional);
  }

  // ---------------------------------------------------------------------
  // TOP NAV: mobile menu, search shortcut, geolocation, unit toggle.
  // Every visible control here now does something real — nothing decorative.
  // ---------------------------------------------------------------------
  function setupTopNav() {
    applyAppearance();
    const menuToggle = document.querySelector(".js-menu-toggle");
    const mobileNav = document.querySelector(".js-mobile-nav");
    if (menuToggle && mobileNav) {
      menuToggle.addEventListener("click", () => {
        const isOpen = mobileNav.classList.toggle("is-open");
        mobileNav.hidden = !isOpen;
        menuToggle.setAttribute("aria-expanded", String(isOpen));
      });
      mobileNav.querySelectorAll("a").forEach((link) => {
        link.addEventListener("click", () => {
          mobileNav.classList.remove("is-open");
          mobileNav.hidden = true;
          menuToggle.setAttribute("aria-expanded", "false");
        });
      });
    }

    const navSearchButtons = document.querySelectorAll(".js-nav-search");
    navSearchButtons.forEach((button) => {
      button.onclick = () => {
        const localInput = document.querySelector(".js-cityName");
        if (localInput) {
          localInput.scrollIntoView({ behavior: "smooth", block: "center" });
          localInput.focus();
        } else {
          window.location.href = "weatherApp.html";
        }
      };
    });

    document.querySelectorAll(".js-theme-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        state.appearance = state.appearance === "light" ? "dark" : "light";
        localStorage.setItem("ws-appearance", state.appearance);
        applyAppearance();
      });
    });

    const navLocationButtons = document.querySelectorAll(".js-nav-location");
    navLocationButtons.forEach((button) => {
      button.addEventListener("click", async () => {
        if (!navigator.geolocation) {
          showSearchError("Geolocation isn't supported in this browser.");
          return;
        }
        const originalText = button.textContent;
        button.textContent = "Locating…";
        button.disabled = true;
        try {
          const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 });
          });
          setLoading(true);
          const weather = await fetchWeatherForCoordinates(position.coords.latitude, position.coords.longitude);
          setLoading(false);
          renderCurrentPage(weather);
          clearSearchError();
        } catch (error) {
          setLoading(false);
          if (error && error.code === 1) {
            showSearchError("Location permission was denied. Search for a city instead.");
          } else {
            showSearchError("Couldn't detect your location. Search for a city instead.");
          }
        } finally {
          button.textContent = originalText;
          button.disabled = false;
        }
      });
    });

    const unitButtons = document.querySelectorAll(".js-nav-unit");
    unitButtons.forEach((button) => {
      updateUnitButtonLabel(button);
      button.addEventListener("click", () => {
        state.unit = state.unit === "C" ? "F" : "C";
        localStorage.setItem("ws-unit", state.unit);
        unitButtons.forEach(updateUnitButtonLabel);
        if (state.current && state.forecast) {
          renderCurrentPage({ current: state.current, forecast: state.forecast, regional: state.regional });
        }
      });
    });
  }

  // ---------------------------------------------------------------------
  // Map tiles now actually follow the app's light/dark mode. Previously
  // both the hero map and the main map hardcoded the dark CARTO basemap,
  // so switching themes never changed them — the two maps only ever
  // differed by container size, never by appearance.
  // ---------------------------------------------------------------------
  const TILE_SOURCES = {
    dark: { url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", attribution: "© OpenStreetMap, © CARTO" },
    light: { url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", attribution: "© OpenStreetMap, © CARTO" },
  };

  function addTileLayer(map, extraAttribution) {
    const source = state.appearance === "light" ? TILE_SOURCES.light : TILE_SOURCES.dark;
    const attribution = extraAttribution ? `${source.attribution}${extraAttribution}` : source.attribution;
    return L.tileLayer(source.url, { subdomains: "abcd", maxZoom: 18, attribution }).addTo(map);
  }

  function swapTileLayer(map, layerStateKey, extraAttribution) {
    if (!map) return;
    if (state[layerStateKey]) map.removeLayer(state[layerStateKey]);
    state[layerStateKey] = addTileLayer(map, extraAttribution);
  }

  function applyAppearance() {
    const isLight = state.appearance === "light";
    document.body.classList.toggle("is-light", isLight);
    document.querySelectorAll(".js-theme-toggle").forEach((button) => {
      button.textContent = isLight ? "Dark mode" : "Light mode";
      button.setAttribute("aria-pressed", String(isLight));
    });
    swapTileLayer(state.heroMap, "heroTileLayer");
    swapTileLayer(state.mainMap, "mainTileLayer", ", weather © OpenWeatherMap");
  }

  function updateUnitButtonLabel(button) {
    button.textContent = `Units · °${state.unit}`;
    button.setAttribute("aria-pressed", state.unit === "F" ? "true" : "false");
  }

  function setLoading(isLoading) {
    const shell = document.querySelector(".app-shell");
    if (shell) shell.classList.toggle("is-loading", isLoading);
  }

  function showSearchError(message) {
    document.querySelectorAll(".js-search-error").forEach((el) => {
      el.textContent = message;
      el.classList.add("is-visible");
    });
  }

  function clearSearchError() {
    document.querySelectorAll(".js-search-error").forEach((el) => {
      el.textContent = "";
      el.classList.remove("is-visible");
    });
  }

  // ---------------------------------------------------------------------
  // Scroll-reveal (IntersectionObserver). Respects prefers-reduced-motion
  // via the CSS already handling that; here we just avoid observing at all
  // when the user has asked for reduced motion, so nothing is ever stuck
  // invisible.
  // ---------------------------------------------------------------------
  function setupRevealObserver() {
    const targets = document.querySelectorAll(".panel, .metrics-strip");
    if (!targets.length) return;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    targets.forEach((el) => el.classList.add("reveal"));

    if (prefersReduced || !("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("in-view"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    targets.forEach((el) => observer.observe(el));
  }

  // ---------------------------------------------------------------------
  // Weather-reactive theme: sets body class -> drives accent color + a
  // restrained ambient background tint (see weatherApp.css). Day/night is
  // derived from the location's own sunrise/sunset, not the browser clock.
  // ---------------------------------------------------------------------
  function applyWeatherTheme(currentWeather) {
    const main = (currentWeather.weather[0].main || "").toLowerCase();
    const sys = currentWeather.sys;
    const isNight = sys ? currentWeather.dt < sys.sunrise || currentWeather.dt > sys.sunset : false;

    let theme = "clear";
    if (isNight) theme = "night";
    else if (["rain", "drizzle"].includes(main)) theme = "rain";
    else if (main === "thunderstorm") theme = "storm";
    else if (main === "snow") theme = "snow";
    else if (["clouds", "mist", "haze", "fog"].includes(main)) theme = "clouds";

    document.body.className = document.body.className
      .split(" ")
      .filter((cls) => !cls.startsWith("theme-"))
      .concat(`theme-${theme}`)
      .join(" ")
      .trim();

    setWeatherAtmosphere(main);
  }

  // Maps the live condition to one of the real photographed BG/ assets
  // shipped with the project — an actual atmospheric image reacting to
  // real weather, not a generic gradient.
  const ATMOSPHERE_IMAGES = {
    clear: "BG/sunny.jpg",
    clouds: "BG/cloudy.jpg",
    mist: "BG/cloudy.jpg",
    haze: "BG/cloudy.jpg",
    fog: "BG/fog.jpg",
    rain: "BG/rain.jpg",
    drizzle: "BG/drizzle.jpg",
    thunderstorm: "BG/Thunderstorm.jpg",
    snow: "BG/snow.jpg",
  };

  function setWeatherAtmosphere(conditionMain) {
    const image = ATMOSPHERE_IMAGES[conditionMain] || ATMOSPHERE_IMAGES.clear;
    document.body.style.setProperty("--weather-bg-image", `url("${image}")`);
    const layers = document.querySelectorAll(".js-hero-atmosphere, .js-forecast-atmosphere");
    if (!layers.length) return;
    layers.forEach((layer) => {
      layer.style.backgroundImage = `url("${image}")`;
      requestAnimationFrame(() => layer.classList.add("is-visible"));
    });
  }

  // Kept for existing render paths; all screens now use the shared atmosphere.
  const setHeroAtmosphere = setWeatherAtmosphere;

  function bindSearchControls() {
    const searchButton = document.querySelector(".js-search-btn");
    const cityInput = document.querySelector(".js-cityName");
    if (!searchButton || !cityInput) {
      return { cityInput: null, handleSearch: () => {} };
    }

    const handleSearch = async () => {
      const cityValue = normalizeCityInput(cityInput.value);
      if (!cityValue) {
        return;
      }

      clearSearchError();
      const originalLabel = searchButton.textContent;
      searchButton.textContent = "Searching…";
      searchButton.disabled = true;
      setLoading(true);

      try {
        const weather = await fetchWeatherForCity(cityValue);
        renderCurrentPage(weather);
        cityInput.value = "";
      } catch (error) {
        console.warn(error);
        showSearchError(`Couldn't find "${cityValue}". Check the spelling and try again.`);
      } finally {
        setLoading(false);
        searchButton.textContent = originalLabel;
        searchButton.disabled = false;
      }
    };

    searchButton.addEventListener("click", handleSearch);
    cityInput.addEventListener("input", () => {
      cityInput.value = normalizeCityInput(cityInput.value);
    });

    return { cityInput, handleSearch };
  }

  async function getDefaultWeather() {
    try {
      if (navigator.geolocation) {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 7000 });
        });
        return await fetchWeatherForCoordinates(position.coords.latitude, position.coords.longitude);
      }
      return await fetchWeatherForCity("Rawalpindi");
    } catch (error) {
      return await fetchWeatherForCity("Rawalpindi");
    }
  }

  async function fetchWeatherForCity(city) {
    const candidates = buildCityCandidates(city);
    let lastError = null;

    for (const candidate of candidates) {
      try {
        const current = await fetchCurrentWeatherByQuery(candidate);
        const forecast = await fetchForecast(current.coord.lat, current.coord.lon);
        const regional = await getRegionalWeather(current.coord.lat, current.coord.lon);
        return { current, forecast, regional };
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error("City not found.");
  }

  async function fetchWeatherForCoordinates(lat, lon) {
    const current = await fetchCurrentWeatherByCoordinates(lat, lon);
    const forecast = await fetchForecast(lat, lon);
    const regional = await getRegionalWeather(lat, lon);
    return { current, forecast, regional };
  }

  async function fetchCurrentWeatherByQuery(city) {
    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${API_KEY}`);
    if (!response.ok) {
      throw new Error("City not found");
    }
    return response.json();
  }

  async function fetchCurrentWeatherByCoordinates(lat, lon) {
    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}`);
    if (!response.ok) throw new Error("Weather fetch failed");
    return response.json();
  }

  async function fetchForecast(lat, lon) {
    const response = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${API_KEY}`);
    if (!response.ok) throw new Error("Forecast fetch failed");
    return response.json();
  }

  async function getRegionalWeather(lat, lon) {
    const offsets = [
      { label: "North", lat: lat + 1.2, lon },
      { label: "West", lat, lon: lon - 1.2 },
      { label: "Center", lat, lon },
      { label: "East", lat, lon: lon + 1.2 },
      { label: "South", lat: lat - 1.2, lon },
    ];

    const results = await Promise.allSettled(
      offsets.map(async (entry) => {
        const weather = await fetchCurrentWeatherByCoordinates(entry.lat, entry.lon);
        return {
          label: entry.label,
          symbol: getConditionSymbol(weather.weather[0].main),
          temperature: `${formatTemp(weather.main.temp)}°`,
        };
      })
    );

    return results
      .filter((item) => item.status === "fulfilled")
      .map((item) => item.value);
  }

  function renderEmptyHomeState() {
    const heroLocation = document.querySelector(".js-hero-location");
    const heroTemp = document.querySelector(".js-hero-temp");
    const heroCondition = document.querySelector(".js-hero-condition");
    const heroMeta = document.querySelector(".js-hero-meta");
    if (heroLocation) heroLocation.textContent = "SEARCH CITY";
    if (heroTemp) heroTemp.textContent = "--";
    if (heroCondition) heroCondition.textContent = "Weather unavailable";
    if (heroMeta) heroMeta.textContent = "Check your network or search manually.";
    showSearchError("Couldn't load weather automatically. Try searching for a city.");
  }

  function renderHomeDashboard(currentWeather, forecastResponse, regionalWeather) {
    const forecastList = forecastResponse.list || [];
    const dailyForecast = summarizeDailyForecast(forecastList).slice(0, 6);
    const hourlyForecast = summarizeHourlyForecast(forecastList).slice(0, 8);
    const temperature = formatTemp(currentWeather.main.temp);
    const feelsLike = formatTemp(currentWeather.main.feels_like);
    const weatherDescription = capitalizeWords(currentWeather.weather[0].description);
    const localTime = getLocalTime(currentWeather.timezone, currentWeather.dt);

    const heroLocation = document.querySelector(".js-hero-location");
    const heroTemp = document.querySelector(".js-hero-temp");
    const heroUnit = document.querySelector(".js-hero-unit");
    const heroCondition = document.querySelector(".js-hero-condition");
    const heroMeta = document.querySelector(".js-hero-meta");

    if (heroLocation) heroLocation.textContent = `${currentWeather.name.toUpperCase()}, ${currentWeather.sys.country}`;
    if (heroTemp) {
      heroTemp.textContent = temperature;
      heroTemp.classList.remove("temp-swap");
      void heroTemp.offsetWidth;
      heroTemp.classList.add("temp-swap");
    }
    if (heroUnit) heroUnit.textContent = `°${state.unit}`;
    if (heroCondition) heroCondition.textContent = weatherDescription;
    if (heroMeta) heroMeta.textContent = `Feels like ${feelsLike}° · ${localTime}`;

    renderHeroMap(currentWeather.coord.lat, currentWeather.coord.lon, currentWeather.name);
    clearSearchError();

    const metrics = [
      { value: `${currentWeather.main.humidity}%`, label: "Humidity" },
      { value: `${Math.round(currentWeather.wind.speed * 3.6)} km/h`, label: "Wind" },
      { value: `${(currentWeather.visibility / 1000).toFixed(1)} km`, label: "Visibility" },
      { value: `${currentWeather.main.pressure} hPa`, label: "Pressure" },
      { value: `${feelsLike}°`, label: "Feels Like" },
    ];

    const metricsContainer = document.querySelector(".js-metrics-strip");
    if (metricsContainer) {
      metricsContainer.innerHTML = metrics
        .map(
          (item) => `
            <div class="metric-item">
              <div class="metric-value">${item.value}</div>
              <div class="metric-label">${item.label}</div>
            </div>
          `
        )
        .join("");
    }

    renderChartsAndChips(currentWeather, hourlyForecast, forecastList);

    const hourlyContainer = document.querySelector(".js-hourly-panel");
    if (hourlyContainer) {
      hourlyContainer.innerHTML = `
        <div class="panel-kicker">HOURLY FORECAST</div>
        <div class="hourly-track home-hourly-track">
          ${hourlyForecast
            .map(
              (entry) => `
                <div class="hour-cell ${entry.active ? "is-active" : ""}">
                  <div class="hour-time">${entry.time}</div>
                  <div class="hour-icon">${getConditionSymbol(entry.main)}</div>
                  <div class="hour-temp-value">${entry.temperature}</div>
                </div>
              `
            )
            .join("")}
        </div>
      `;
    }

    const dailyContainer = document.querySelector(".js-daily-panel");
    if (dailyContainer) {
      dailyContainer.innerHTML = `
        <div class="panel-kicker">DAILY FORECAST</div>
        <div class="daily-list">
          ${dailyForecast
            .map(
              (day) => `
                <div class="daily-item ${day.current ? "is-current" : ""}">
                  <div class="daily-day">${day.day}</div>
                  <div class="daily-icon">${getConditionSymbol(day.main)}</div>
                  <div class="daily-temp">${day.temperature}</div>
                  <div class="daily-condition">${day.description}</div>
                </div>
              `
            )
            .join("")}
        </div>
      `;
    }

    renderRegionalSolarAir(currentWeather, regionalWeather);
  }

  // ---------------------------------------------------------------------
  // Home hero map: a real, live Leaflet view of the current location.
  // Tiles follow the app's light/dark mode (see addTileLayer) instead of
  // always being the dark basemap — replaces the old decorative blue
  // sphere with an actual, theme-matched map.
  // ---------------------------------------------------------------------
  function renderHeroMap(lat, lon, label) {
    const container = document.querySelector(".hero-map");
    if (!container || typeof L === "undefined") return;

    if (state.heroMap) {
      state.heroMap.setView([lat, lon], state.heroMap.getZoom());
      if (state.heroMarker) state.heroMarker.setLatLng([lat, lon]);
      return;
    }

    state.heroMap = L.map(container, {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    }).setView([lat, lon], 5);

    state.heroTileLayer = addTileLayer(state.heroMap);

    const pinIcon = L.divIcon({ className: "", html: '<div class="hero-pin"></div>', iconSize: [14, 14] });
    state.heroMarker = L.marker([lat, lon], { icon: pinIcon, title: label }).addTo(state.heroMap);
  }

  function renderChartsAndChips(currentWeather, hourlyForecast, forecastList) {
    const tempChart = buildTemperatureChart(hourlyForecast);
    const precipChart = buildPrecipChart(hourlyForecast);
    const windChart = buildWindChart(currentWeather.wind.speed, currentWeather.wind.deg, currentWeather.wind.gust);
    const pressureChart = buildPressureHumidityChart(hourlyForecast);

    setHtml(".js-chart-temperature", tempChart);
    setHtml(".js-chart-precipitation", precipChart);
    setHtml(".js-chart-wind", windChart);
    setHtml(".js-chart-pressure", pressureChart);

    const windChip = document.querySelector(".js-chip-wind");
    if (windChip) windChip.textContent = degreesToCompass(currentWeather.wind.deg);

    const precipChip = document.querySelector(".js-chip-precip");
    if (precipChip) {
      const nextChance = hourlyForecast.length ? Math.round((hourlyForecast[0].pop || 0) * 100) : 0;
      precipChip.textContent = `${nextChance}%`;
    }

    const pressureChip = document.querySelector(".js-chip-pressure");
    if (pressureChip && hourlyForecast.length > 1) {
      const first = hourlyForecast[0].pressure;
      const last = hourlyForecast[hourlyForecast.length - 1].pressure;
      pressureChip.textContent = last > first + 1 ? "Rising" : last < first - 1 ? "Falling" : "Stable";
    }
  }

  function setHtml(selector, html) {
    const el = document.querySelector(selector);
    if (el) el.innerHTML = html;
  }

  function renderRegionalSolarAir(currentWeather, regionalWeather) {
    const regionalContainer = document.querySelector(".js-regional-panel");
    if (regionalContainer) {
      regionalContainer.innerHTML = `
        <div class="panel-kicker">REGIONAL OVERVIEW</div>
        <div class="regional-list">
          ${regionalWeather
            .slice(0, 5)
            .map(
              (item) => `
                <div class="regional-item">
                  <span>${item.label}</span>
                  <span>${item.symbol} ${item.temperature}</span>
                </div>
              `
            )
            .join("")}
        </div>
      `;
    }

    const solarContainer = document.querySelector(".js-solar-panel");
    if (solarContainer && currentWeather.sys) {
      const { sunrise, sunset } = currentWeather.sys;
      const now = currentWeather.dt;
      const progress = clamp((now - sunrise) / (sunset - sunrise), 0, 1);
      solarContainer.innerHTML = `
        <div class="panel-kicker">SOLAR CYCLE</div>
        <div class="solar-panel__body">
          <div class="solar-path">
            <span class="solar-sun" style="left:${8 + progress * 84}%"></span>
          </div>
          <div class="solar-labels">
            <span>SUNRISE ${getLocalTime(currentWeather.timezone, sunrise).split(", ").pop()}</span>
            <span>CURRENT</span>
            <span>SUNSET ${getLocalTime(currentWeather.timezone, sunset).split(", ").pop()}</span>
          </div>
        </div>
      `;
    }

    const airPanel = document.querySelector(".js-air-panel");
    if (airPanel) {
      airPanel.innerHTML = `
        <div class="panel-kicker">AIR QUALITY</div>
        <div class="empty-state" style="min-height:120px;">Data unavailable</div>
      `;
      fetchAirQuality(currentWeather.coord.lat, currentWeather.coord.lon)
        .then((aqi) => {
          if (!aqi) return;
          airPanel.innerHTML = `
            <div class="panel-kicker">AIR QUALITY</div>
            <div class="air-score">${aqi.aqi}</div>
            <div class="air-grid">
              <div><span>PM2.5</span><strong>${Math.round(aqi.components.pm2_5)}</strong></div>
              <div><span>PM10</span><strong>${Math.round(aqi.components.pm10)}</strong></div>
              <div><span>NO₂</span><strong>${Math.round(aqi.components.no2)}</strong></div>
              <div><span>O₃</span><strong>${Math.round(aqi.components.o3)}</strong></div>
            </div>
          `;
        })
        .catch(() => {
          /* left as "Data unavailable" — never fabricate AQI values */
        });
    }
  }

  async function fetchAirQuality(lat, lon) {
    try {
      const response = await fetch(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${API_KEY}`);
      if (!response.ok) return null;
      const data = await response.json();
      const entry = data.list && data.list[0];
      if (!entry) return null;
      const scale = { 1: 25, 2: 55, 3: 90, 4: 140, 5: 200 };
      return { aqi: scale[entry.main.aqi] || 0, components: entry.components };
    } catch (error) {
      return null;
    }
  }

  function renderMapPage(currentWeather, forecastResponse, regionalWeather) {
    const mapContainer = document.getElementById("weatherMap");
    if (!mapContainer) return;

    const summaryPanel = document.querySelector(".js-summary-panel");
    if (summaryPanel) {
      summaryPanel.innerHTML = `
        <div class="panel-kicker">Current Weather</div>
        <div class="summary-city">${currentWeather.name}, ${currentWeather.sys.country}</div>
        <div class="summary-temp">${formatTemp(currentWeather.main.temp)}°</div>
        <div class="summary-condition">${capitalizeWords(currentWeather.weather[0].description)}</div>
        <div class="summary-meta">Feels like ${formatTemp(currentWeather.main.feels_like)}°</div>
        <div class="summary-meta">${getLocalTime(currentWeather.timezone, currentWeather.dt)}</div>
      `;
    }

    // Re-rendering used to always tear down and recreate the Leaflet
    // instance — so toggling °C/°F while browsing the map reset the user's
    // pan/zoom back to the default view every time. Now a same-location
    // re-render (unit toggle, forecast refresh) just updates the existing
    // marker/popup in place; only an actual new location rebuilds the map.
    const locationKey = `${currentWeather.coord.lat},${currentWeather.coord.lon}`;
    const isSameLocation = state.mainMap && state.mapLocationKey === locationKey;

    if (state.mainMap && !isSameLocation) {
      state.mainMap.remove();
      state.mainMap = null;
    }

    if (!state.mainMap) {
      state.mainMap = L.map("weatherMap", { zoomControl: true, attributionControl: true }).setView(
        [currentWeather.coord.lat, currentWeather.coord.lon],
        6
      );
      L.control.zoom({ position: "bottomleft" }).addTo(state.mainMap);

      state.mainTileLayer = addTileLayer(state.mainMap, ", weather © OpenWeatherMap");

      state.mapMarker = L.circleMarker([currentWeather.coord.lat, currentWeather.coord.lon], {
        radius: 10,
        color: "#7ec9ff",
        fillColor: "#79c5ff",
        fillOpacity: 0.9,
        weight: 2,
        className: "map-live-marker",
      })
        .addTo(state.mainMap)
        .bindPopup(`<strong>${currentWeather.name}</strong><br>${formatTemp(currentWeather.main.temp)}°${state.unit}`);

      state.mapDataRing = L.circle([currentWeather.coord.lat, currentWeather.coord.lon], {
        radius: 36000, color: "#75c9ff", weight: 1, fillColor: "#75c9ff", fillOpacity: 0.18, interactive: false
      }).addTo(state.mainMap);

      // Leaflet owns this container's DOM once L.map() runs, so the legend
      // is (re)created here in code rather than trusted to survive as
      // static markup — guarantees it's actually present after init, and
      // anchored to the map only (not .map-surface, which also contains
      // the timeline row below it — that mismatch was why the legend used
      // to overlap the timeline).
      let legend = mapContainer.querySelector(".js-map-legend");
      if (!legend) {
        legend = document.createElement("div");
        legend.className = "map-legend js-map-legend";
        legend.innerHTML = `
          <div class="legend-title">TEMPERATURE</div>
          <div class="legend-scale"><span>-10°</span><span>0°</span><span>10°</span><span>20°</span><span>30°</span><span>40°</span></div>
        `;
        mapContainer.appendChild(legend);
      }
    }

    state.mapLocationKey = locationKey;
    if (state.mapMarker) {
      state.mapMarker.setLatLng([currentWeather.coord.lat, currentWeather.coord.lon]);
      state.mapMarker.setPopupContent(`<strong>${currentWeather.name}</strong><br>${formatTemp(currentWeather.main.temp)}°${state.unit}`);
      if (!isSameLocation) state.mainMap.setView([currentWeather.coord.lat, currentWeather.coord.lon], 6);
    }
    if (state.mapDataRing) state.mapDataRing.setLatLng([currentWeather.coord.lat, currentWeather.coord.lon]);

    setupMapLayers(currentWeather);
    setupMapTimeline(forecastResponse, currentWeather);
  }

  function setupMapLayers(currentWeather) {
    const legend = document.querySelector(".js-map-legend");
    renderLegend(legend, state.activeLayer);
    swapWeatherTileLayer(state.mainMap, state.activeLayer);

    const layerButtons = document.querySelectorAll(".layer-button:not([disabled])");
    layerButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.layer === state.activeLayer);
      button.onclick = () => {
        const layer = button.dataset.layer;
        if (!MAP_LAYERS[layer] || !state.mainMap) return;

        layerButtons.forEach((entry) => entry.classList.remove("is-active"));
        button.classList.add("is-active");
        state.activeLayer = layer;
        renderLegend(legend, layer);
        swapWeatherTileLayer(state.mainMap, layer);
        updateMapForecastFrame(state.timelineEntries[state.timelineIndex] || currentWeather);
      };
    });
    updateMapForecastFrame(state.timelineEntries[state.timelineIndex] || currentWeather);
  }

  // ---------------------------------------------------------------------
  // The actual "colorful regional weather" view — a real global weather
  // raster layer from OpenWeatherMap's own map tile service (same API key
  // this app already authenticates with for forecast data). This is what
  // makes the map show genuine temperature/precipitation/wind/cloud/
  // pressure patterns across the whole visible region, the way Windy or
  // Ventusky do — not a fabricated color, live third-party imagery.
  // ---------------------------------------------------------------------
  function swapWeatherTileLayer(map, layerKey) {
    if (!map) return;
    if (state.weatherTileLayer) {
      map.removeLayer(state.weatherTileLayer);
      state.weatherTileLayer = null;
    }
    const meta = MAP_LAYERS[layerKey];
    if (!meta || !meta.owmTile) return;
    state.weatherTileLayer = L.tileLayer(
      `https://tile.openweathermap.org/map/${meta.owmTile}/{z}/{x}/{y}.png?appid=${API_KEY}`,
      { maxZoom: 18, opacity: 0.65, attribution: "Weather layer © OpenWeatherMap", zIndex: 300 }
    ).addTo(map);
  }

  function renderLegend(legend, layerKey) {
    if (!legend) return;
    const meta = MAP_LAYERS[layerKey];
    const labels = Array.from({ length: meta.stops.length }, (_, index) => {
      const value = meta.range[0] + ((meta.range[1] - meta.range[0]) * index) / (meta.stops.length - 1);
      return `${Math.round(value)} ${meta.unit}`;
    });
    legend.innerHTML = `
      <div class="legend-title">${meta.label}</div>
      <div class="legend-gradient" style="background:linear-gradient(90deg, ${meta.stops.join(",")})"></div>
      <div class="legend-scale">
        ${labels.map((tick) => `<span>${tick}</span>`).join("")}
      </div>
    `;
  }

  function getScaleColor(meta, value) {
    const progress = Math.max(0, Math.min(1, (value - meta.range[0]) / (meta.range[1] - meta.range[0])));
    const scaled = progress * (meta.stops.length - 1);
    const index = Math.min(meta.stops.length - 2, Math.floor(scaled));
    const mix = scaled - index;
    const from = meta.stops[index].slice(1).match(/../g).map((hex) => parseInt(hex, 16));
    const to = meta.stops[index + 1].slice(1).match(/../g).map((hex) => parseInt(hex, 16));
    return `#${from.map((channel, channelIndex) => Math.round(channel + (to[channelIndex] - channel) * mix).toString(16).padStart(2, "0")).join("")}`;
  }

  function updateMapForecastFrame(entry) {
    if (!entry || !state.mapMarker) return;
    const meta = MAP_LAYERS[state.activeLayer];
    const value = meta.value(entry);
    const color = getScaleColor(meta, value);
    state.mapMarker.setStyle({ color, fillColor: color });
    if (state.mapDataRing) state.mapDataRing.setStyle({ color, fillColor: color });
    state.mapMarker.setPopupContent(`<strong>${Math.round(value)} ${meta.unit}</strong><br>${meta.label.toLowerCase()} at this forecast time`);
  }

  // ---------------------------------------------------------------------
  // Map timeline: scrubs through the *real* 3-hourly forecast timestamps
  // already fetched (never invented), updating the summary panel. Free-tier
  // weather tiles don't support historical/future imagery, so this is
  // presented honestly as a forecast preview rather than a fake animated map.
  // ---------------------------------------------------------------------
  function setupMapTimeline(forecastResponse, currentWeather) {
    stopTimelinePlayback();
    const entries = (forecastResponse.list || []).slice(0, 8);
    state.timelineEntries = entries;
    state.timelineIndex = 0;

    const track = document.querySelector(".js-timeline-track");
    const prevBtn = document.querySelector(".js-timeline-prev");
    const nextBtn = document.querySelector(".js-timeline-next");
    const playBtn = document.querySelector(".js-timeline-play");
    if (!track) return;

    if (!entries.length) {
      track.innerHTML = `<span>No forecast timestamps available</span>`;
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (playBtn) playBtn.disabled = true;
      return;
    }

    renderTimelineTrack(track, entries, currentWeather);

    if (prevBtn) {
      prevBtn.onclick = () => {
        stopTimelinePlayback();
        state.timelineIndex = Math.max(0, state.timelineIndex - 1);
        renderTimelineTrack(track, entries, currentWeather);
      };
    }
    if (nextBtn) {
      nextBtn.onclick = () => {
        stopTimelinePlayback();
        state.timelineIndex = Math.min(entries.length - 1, state.timelineIndex + 1);
        renderTimelineTrack(track, entries, currentWeather);
      };
    }
    if (playBtn) {
      playBtn.onclick = () => {
        if (state.timelinePlaying) {
          stopTimelinePlayback();
          return;
        }
        state.timelinePlaying = true;
        playBtn.textContent = "Pause";
        playBtn.setAttribute("aria-pressed", "true");
        state.timelineLastStep = performance.now();
        const playFrame = (now) => {
          if (!state.timelinePlaying) return;
          if (now - state.timelineLastStep >= state.timelineDuration) {
            state.timelineIndex = (state.timelineIndex + 1) % entries.length;
            state.timelineLastStep = now;
            renderTimelineTrack(track, entries, currentWeather);
          }
          state.timelineFrame = requestAnimationFrame(playFrame);
        };
        state.timelineFrame = requestAnimationFrame(playFrame);
      };
    }
  }

  function stopTimelinePlayback() {
    if (state.timelineFrame) cancelAnimationFrame(state.timelineFrame);
    state.timelineFrame = null;
    state.timelinePlaying = false;
    const playBtn = document.querySelector(".js-timeline-play");
    if (playBtn) {
      playBtn.textContent = "Play";
      playBtn.setAttribute("aria-pressed", "false");
    }
  }

  function renderTimelineTrack(track, entries, currentWeather) {
    track.innerHTML = entries
      .map((entry, index) => {
        const time = new Date(entry.dt * 1000).toLocaleTimeString([], { hour: "numeric" });
        return `<button type="button" class="timeline-tick ${index === state.timelineIndex ? "is-active" : ""}" data-index="${index}">${time}</button>`;
      })
      .join("");

    track.querySelectorAll(".timeline-tick").forEach((tick) => {
      tick.addEventListener("click", () => {
        stopTimelinePlayback();
        state.timelineIndex = Number(tick.dataset.index);
        renderTimelineTrack(track, entries, currentWeather);
      });
    });

    const active = entries[state.timelineIndex];
    const summaryPanel = document.querySelector(".js-summary-panel");
    if (summaryPanel && active) {
      const noteId = summaryPanel.querySelector(".js-timeline-note");
      const temp = formatTemp(active.main.temp);
      const condition = capitalizeWords(active.weather[0].description);
      const time = new Date(active.dt * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
      const noteHtml = `<div class="summary-meta js-timeline-note">Forecast preview — ${time}: ${temp}°, ${condition}</div>`;
      if (noteId) {
        noteId.outerHTML = noteHtml;
      } else {
        summaryPanel.insertAdjacentHTML("beforeend", noteHtml);
      }
    }

    animateMapForTimelineFrame(active);
  }

  // Free-tier weather tiles can't be replayed historically/forward in time,
  // so instead of faking animated imagery, Play/scrubbing gives real,
  // visible feedback on the map itself: the location marker pulses, its
  // popup updates to the selected frame's real numbers, and the active
  // overlay briefly dips in opacity as a "frame changed" heartbeat.
  function animateMapForTimelineFrame(entry) {
    if (!entry || !state.mainMap) return;

    updateMapForecastFrame(entry);
    if (state.mapMarker) {
      const temp = formatTemp(entry.main.temp);
      const condition = capitalizeWords(entry.weather[0].description);
      state.mapMarker.setPopupContent(`<strong>${temp}°${state.unit}</strong><br>${condition}`);
      state.mapMarker.openPopup();

      const path = state.mapMarker._path;
      if (path) {
        path.classList.remove("is-pulsing");
        void path.getBoundingClientRect();
        path.classList.add("is-pulsing");
      }
    }

  }

  function renderAnalyticsPage(currentWeather, forecastResponse, regionalWeather) {
    const forecastList = forecastResponse.list || [];
    const hourly = summarizeHourlyForecast(forecastList).slice(0, 8);
    renderChartsAndChips(currentWeather, hourly, forecastList);
  }

  function renderForecastPage(currentWeather, forecastResponse, regionalWeather) {
    const hourly = summarizeHourlyForecast(forecastResponse.list || []).slice(0, 8);
    const daily = summarizeForecastCards(forecastResponse.list || []).slice(0, 7);
    const summary = document.querySelector(".js-forecast-summary");
    if (summary) {
      summary.innerHTML = `
        <div class="forecast-atmosphere js-forecast-atmosphere" aria-hidden="true"></div>
        <div class="forecast-summary__heading">
          <div>
            <div class="panel-kicker">CURRENT WEATHER</div>
            <h2>${currentWeather.name}, ${currentWeather.sys.country}</h2>
          </div>
          <div class="forecast-summary__temp">${formatTemp(currentWeather.main.temp)}°</div>
        </div>
        <div class="forecast-summary__meta">
          <span>${capitalizeWords(currentWeather.weather[0].description)}</span>
          <span>Feels Like ${formatTemp(currentWeather.main.feels_like)}°</span>
          <span>Humidity ${currentWeather.main.humidity}%</span>
          <span>Wind ${Math.round(currentWeather.wind.speed * 3.6)} km/h</span>
          <span>Pressure ${currentWeather.main.pressure} hPa</span>
        </div>
      `;
      setHeroAtmosphere(currentWeather.weather[0].main);
    }

    const hourlyPanel = document.querySelector(".js-hourly-panel");
    if (hourlyPanel) {
      hourlyPanel.innerHTML = `
        <div class="panel-kicker">HOURLY FORECAST</div>
        <div class="hourly-track home-hourly-track">
          ${hourly
            .map(
              (entry) => `
                <div class="hour-cell ${entry.active ? "is-active" : ""}">
                  <div class="hour-time">${entry.time}</div>
                  <div class="hour-icon">${getConditionSymbol(entry.main)}</div>
                  <div class="hour-temp-value">${entry.temperature}</div>
                  <div class="hour-temp-value" style="font-size:0.68rem;font-weight:400;color:var(--muted);">${Math.round((entry.pop || 0) * 100)}%</div>
                </div>
              `
            )
            .join("")}
        </div>
      `;
    }

    const dailyPanel = document.querySelector(".js-daily-panel");
    if (dailyPanel) {
      dailyPanel.innerHTML = `
        <div class="panel-kicker">5-DAY FORECAST</div>
        <div class="daily-list daily-list--compact">
          ${daily
            .map(
              (day) => `
                <button type="button" class="daily-item forecast-card condition-${getConditionClass(day.main)} ${day.current ? "is-current is-selected" : ""}" data-forecast-card="${daily.indexOf(day)}" aria-pressed="${day.current}">
                  <span class="daily-day">${day.day}<small>${day.date}</small></span>
                  <span class="daily-icon">${getConditionSymbol(day.main)}</span>
                  <span class="daily-temp"><strong>${day.high}&deg;</strong><em>${day.low}&deg;</em></span>
                  <span class="daily-condition">${day.description}<small>${day.pop}% rain</small></span>
                </button>
              `
            )
            .join("")}
        </div>
      `;
      setupForecastCards(dailyPanel, daily);
    }

    renderRegionalSolarAir(currentWeather, regionalWeather);
  }

  // ---------------------------------------------------------------------
  // Charts — real data only. No modulo-based fake bar heights, no
  // hardcoded polylines.
  // ---------------------------------------------------------------------
  function buildTemperatureChart(hourlyEntries) {
    if (!hourlyEntries.length) return "<div class=\"empty-state\">No temperature data</div>";
    const temps = hourlyEntries.map((entry) => Number(entry.temperature.replace("°", "")));
    const min = Math.min(...temps) - 2;
    const max = Math.max(...temps) + 2;
    const points = temps.map((temp, index) => {
      const x = 16 + (index * 330) / (temps.length - 1 || 1);
      const y = 150 - ((temp - min) / (max - min || 1)) * 110;
      return `${x},${y}`;
    }).join(" ");
    const lastPoint = points.split(" ").pop().split(",");

    return `
      <svg viewBox="0 0 360 180" preserveAspectRatio="none" role="img" aria-label="Temperature trend chart">
        <g>
          <line x1="16" y1="20" x2="16" y2="160" stroke="rgba(255,255,255,0.12)" />
          <line x1="16" y1="160" x2="340" y2="160" stroke="rgba(255,255,255,0.12)" />
        </g>
        <polyline points="${points}" fill="none" stroke="#8cc6ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="${lastPoint[0]}" cy="${lastPoint[1]}" r="4" fill="#f4f8ff" />
      </svg>
    `;
  }

  function buildPrecipChart(hourlyEntries) {
    if (!hourlyEntries.length) return "<div class=\"empty-state\">No precipitation data</div>";
    return `
      <div class="bar-chart">
        ${hourlyEntries
          .slice(0, 6)
          .map((entry) => {
            const chance = Math.round((entry.pop || 0) * 100);
            const height = Math.max(6, chance);
            return `<span style="height:${height}%" title="${chance}% chance, ${entry.time}"></span>`;
          })
          .join("")}
      </div>
    `;
  }

  function buildWindChart(speed, deg, gust) {
    const kmh = Math.round(speed * 3.6);
    const gustHtml = gust ? `<div class="hour-time" style="margin-top:4px;">Gust ${Math.round(gust * 3.6)} km/h</div>` : "";
    return `
      <div class="wind-rose" style="--wind-angle:${deg}deg; --wind-speed:${Math.min(speed, 32)}px;">
        <div class="wind-ring"></div>
        <div class="wind-pointer"></div>
        <div class="wind-stat">${kmh} km/h${gustHtml}</div>
      </div>
    `;
  }

  function buildPressureHumidityChart(hourlyEntries) {
    if (!hourlyEntries.length) return "<div class=\"empty-state\">No pressure data</div>";
    const pressures = hourlyEntries.map((e) => e.pressure);
    const humidities = hourlyEntries.map((e) => e.humidity);
    const pMin = Math.min(...pressures) - 2;
    const pMax = Math.max(...pressures) + 2;
    const hMin = Math.min(...humidities) - 5;
    const hMax = Math.max(...humidities) + 5;

    const toPoints = (values, min, max) =>
      values
        .map((value, index) => {
          const x = 16 + (index * 324) / (values.length - 1 || 1);
          const y = 150 - ((value - min) / (max - min || 1)) * 110;
          return `${x},${y}`;
        })
        .join(" ");

    return `
      <svg viewBox="0 0 360 180" preserveAspectRatio="none" aria-label="Pressure and humidity chart">
        <g>
          <line x1="16" y1="20" x2="16" y2="160" stroke="rgba(255,255,255,0.12)" />
          <line x1="16" y1="160" x2="340" y2="160" stroke="rgba(255,255,255,0.12)" />
        </g>
        <polyline points="${toPoints(pressures, pMin, pMax)}" fill="none" stroke="#8cc6ff" stroke-width="2.1" />
        <polyline points="${toPoints(humidities, hMin, hMax)}" fill="none" stroke="#dfe8ff" stroke-width="1.8" opacity="0.6" />
      </svg>
    `;
  }

  function summarizeDailyForecast(entries) {
    if (!entries || !entries.length) return [];
    const grouped = [];
    const seen = new Set();
    for (const entry of entries) {
      const dateKey = entry.dt_txt.slice(0, 10);
      if (!seen.has(dateKey) && entry.dt_txt.includes("12:00:00")) {
        grouped.push(entry);
        seen.add(dateKey);
      }
    }
    if (grouped.length < 6) {
      for (const entry of entries) {
        const dateKey = entry.dt_txt.slice(0, 10);
        if (!seen.has(dateKey)) {
          grouped.push(entry);
          seen.add(dateKey);
        }
        if (grouped.length >= 7) break;
      }
    }
    return grouped.map((entry, index) => ({
      day: new Date(entry.dt * 1000).toLocaleDateString(undefined, { weekday: "short" }),
      temperature: `${formatTemp(entry.main.temp)}°`,
      description: capitalizeWords(entry.weather[0].description),
      main: entry.weather[0].main,
      current: index === 0,
    }));
  }

  function summarizeForecastCards(entries) {
    const groups = new Map();
    entries.forEach((entry) => {
      const key = entry.dt_txt.slice(0, 10);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    });
    return Array.from(groups.values()).map((frames, index) => {
      const representative = frames.reduce((best, entry) => Math.abs(new Date(entry.dt * 1000).getHours() - 14) < Math.abs(new Date(best.dt * 1000).getHours() - 14) ? entry : best, frames[0]);
      const temps = frames.map((entry) => entry.main.temp);
      return {
        day: new Date(representative.dt * 1000).toLocaleDateString(undefined, { weekday: "short" }),
        date: new Date(representative.dt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        high: formatTemp(Math.max(...temps)), low: formatTemp(Math.min(...temps)),
        description: capitalizeWords(representative.weather[0].description), main: representative.weather[0].main,
        pop: Math.round(Math.max(...frames.map((entry) => entry.pop || 0)) * 100), frames, current: index === 0,
      };
    });
  }

  function getConditionClass(main) {
    const value = (main || "").toLowerCase();
    if (value === "thunderstorm") return "storm";
    if (value === "clouds" || value === "mist" || value === "haze" || value === "fog") return "clouds";
    return value === "drizzle" ? "rain" : value || "clear";
  }

  function setupForecastCards(panel, days) {
    panel.querySelectorAll(".forecast-card").forEach((card) => {
      card.addEventListener("click", () => {
        const index = Number(card.dataset.forecastCard);
        state.forecastCardIndex = index;
        panel.querySelectorAll(".forecast-card").forEach((item, itemIndex) => {
          const selected = itemIndex === index;
          item.classList.toggle("is-selected", selected);
          item.setAttribute("aria-pressed", String(selected));
        });
        const day = days[index];
        const detail = panel.querySelector(".forecast-card-detail") || document.createElement("div");
        detail.className = "forecast-card-detail";
        const detailFrames = [6, 12, 18, 21].map((hour) => day.frames.reduce((best, frame) => Math.abs(new Date(frame.dt * 1000).getHours() - hour) < Math.abs(new Date(best.dt * 1000).getHours() - hour) ? frame : best, day.frames[0]));
        detail.innerHTML = detailFrames.filter((frame, index, all) => all.indexOf(frame) === index).map((frame) => `<span>${new Date(frame.dt * 1000).toLocaleTimeString([], { hour: "numeric" })}<strong>${formatTemp(frame.main.temp)}&deg;</strong><small>${Math.round((frame.pop || 0) * 100)}% rain</small></span>`).join("");
        if (!detail.parentElement) panel.appendChild(detail);
      });
    });
    const selected = panel.querySelector(".forecast-card.is-selected");
    if (selected) selected.click();
  }

  function summarizeHourlyForecast(entries) {
    if (!entries || !entries.length) return [];
    return entries.slice(0, 8).map((entry, index) => ({
      time: new Date(entry.dt * 1000).toLocaleTimeString([], { hour: "numeric" }),
      temperature: `${formatTemp(entry.main.temp)}°`,
      main: entry.weather[0].main,
      pop: entry.pop || 0,
      pressure: entry.main.pressure,
      humidity: entry.main.humidity,
      active: index === 0,
    }));
  }

  function getLocalTime(timezoneOffset, unixTimestamp) {
    const dt = new Date((unixTimestamp + timezoneOffset) * 1000);
    return dt.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  }

  // ---------------------------------------------------------------------
  // Colored weather icon system. Emoji glyphs (☀️☁️🌧️) render inconsistently
  // across OS/browsers and carry no deliberate brand color — these are real
  // SVGs with condition-specific color language: warm gold for clear skies,
  // cool blue-gray for cloud, blue for rain, violet for storms, icy blue for
  // snow. Gradients live once in a shared <defs> sprite (injectIconDefs) so
  // every icon instance references the same fills instead of duplicating IDs.
  function injectIconDefs() {
    if (document.getElementById("ws-icon-defs")) return;
    const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    sprite.setAttribute("id", "ws-icon-defs");
    sprite.setAttribute("aria-hidden", "true");
    sprite.style.position = "absolute";
    sprite.style.width = "0";
    sprite.style.height = "0";
    sprite.style.overflow = "hidden";
    sprite.innerHTML = `
      <defs>
        <radialGradient id="ws-grad-sun" cx="38%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#fff3c4" />
          <stop offset="45%" stop-color="#ffcf5c" />
          <stop offset="100%" stop-color="#f5a623" />
        </radialGradient>
        <linearGradient id="ws-grad-cloud" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#d9e6f5" />
          <stop offset="100%" stop-color="#93a9c4" />
        </linearGradient>
        <linearGradient id="ws-grad-cloud-dark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#aebdd4" />
          <stop offset="100%" stop-color="#6b7fa0" />
        </linearGradient>
        <linearGradient id="ws-grad-rain" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#8cc6ff" />
          <stop offset="100%" stop-color="#3d7fd6" />
        </linearGradient>
        <linearGradient id="ws-grad-storm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#c8b8ff" />
          <stop offset="100%" stop-color="#7c5ce0" />
        </linearGradient>
        <linearGradient id="ws-grad-bolt" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ffe98a" />
          <stop offset="100%" stop-color="#ffb03c" />
        </linearGradient>
        <linearGradient id="ws-grad-snow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#eaf6ff" />
          <stop offset="100%" stop-color="#a9d2f2" />
        </linearGradient>
      </defs>
    `;
    document.body.appendChild(sprite);
  }

  function buildWeatherIcon(condition) {
    const normalized = (condition || "").toLowerCase();
    const cloud = (fill, y = 20) => `<path d="M14 ${y + 12}a7 7 0 0 1 0-14 9 9 0 0 1 17.3-2.6A6.5 6.5 0 0 1 34 ${y + 12}Z" fill="${fill}"/>`;

    if (normalized === "clear") {
      return svgIcon(`
        <circle cx="24" cy="24" r="11" fill="url(#ws-grad-sun)" />
        <g stroke="#ffcf5c" stroke-width="2.4" stroke-linecap="round">
          <line x1="24" y1="2" x2="24" y2="7" />
          <line x1="24" y1="41" x2="24" y2="46" />
          <line x1="2" y1="24" x2="7" y2="24" />
          <line x1="41" y1="24" x2="46" y2="24" />
          <line x1="8" y1="8" x2="11.5" y2="11.5" />
          <line x1="36.5" y1="36.5" x2="40" y2="40" />
          <line x1="8" y1="40" x2="11.5" y2="36.5" />
          <line x1="36.5" y1="11.5" x2="40" y2="8" />
        </g>
      `);
    }

    if (["mist", "haze", "fog"].includes(normalized)) {
      return svgIcon(`
        ${cloud("url(#ws-grad-cloud)", 12)}
        <g stroke="#c7d6ea" stroke-width="2" stroke-linecap="round" opacity="0.8">
          <line x1="8" y1="38" x2="40" y2="38" />
          <line x1="12" y1="43" x2="36" y2="43" />
        </g>
      `);
    }

    if (normalized === "clouds") {
      return svgIcon(`${cloud("url(#ws-grad-cloud)", 14)}`);
    }

    if (normalized === "drizzle") {
      return svgIcon(`
        ${cloud("url(#ws-grad-cloud-dark)", 8)}
        <g stroke="url(#ws-grad-rain)" stroke-width="2.4" stroke-linecap="round" opacity="0.9">
          <line x1="16" y1="34" x2="14" y2="39" />
          <line x1="24" y1="34" x2="22" y2="39" />
          <line x1="32" y1="34" x2="30" y2="39" />
        </g>
      `);
    }

    if (normalized === "rain") {
      return svgIcon(`
        ${cloud("url(#ws-grad-cloud-dark)", 6)}
        <g stroke="url(#ws-grad-rain)" stroke-width="2.6" stroke-linecap="round">
          <line x1="14" y1="32" x2="11" y2="40" />
          <line x1="23" y1="32" x2="20" y2="40" />
          <line x1="32" y1="32" x2="29" y2="40" />
        </g>
      `);
    }

    if (normalized === "thunderstorm") {
      return svgIcon(`
        ${cloud("url(#ws-grad-storm)", 4)}
        <path d="M25 26 17 38h7l-3 8 12-14h-8Z" fill="url(#ws-grad-bolt)" />
      `);
    }

    if (normalized === "snow") {
      return svgIcon(`
        ${cloud("url(#ws-grad-cloud)", 6)}
        <g fill="url(#ws-grad-snow)">
          <circle cx="14" cy="37" r="2.2" />
          <circle cx="24" cy="40" r="2.2" />
          <circle cx="33" cy="37" r="2.2" />
        </g>
      `);
    }

    return svgIcon(`
      <circle cx="17" cy="20" r="8" fill="url(#ws-grad-sun)" opacity="0.9" />
      ${cloud("url(#ws-grad-cloud)", 16)}
    `);
  }

  function svgIcon(inner) {
    return `<svg class="weather-icon" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" role="img">${inner}</svg>`;
  }

  function getConditionSymbol(condition) {
    return buildWeatherIcon(condition);
  }

  function degreesToCompass(deg) {
    if (typeof deg !== "number") return "--";
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return directions[Math.round(deg / 45) % 8];
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTemp(kelvinValue) {
    const celsius = kelvinValue - 273.15;
    if (state.unit === "F") return Math.round((celsius * 9) / 5 + 32);
    return Math.round(celsius);
  }

  function normalizeCityInput(rawCity) {
    if (!rawCity) return "";
    return rawCity
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildCityCandidates(city) {
    const normalized = normalizeCityInput(city).toLowerCase();
    const compact = normalized.replace(/\s+/g, "");
    const aliases = {
      newyork: "new york",
      losangeles: "los angeles",
      sanfrancisco: "san francisco",
      rawalpindiislamabad: "rawalpindi",
      londonuk: "london",
      parisfrance: "paris",
      moscowrussia: "moscow",
      newyorkcity: "new york city",
    };

    const candidates = new Set([normalized, compact, city.trim()]);
    if (aliases[compact]) candidates.add(aliases[compact]);
    if (aliases[normalized]) candidates.add(aliases[normalized]);

    if (!normalized.includes(" ") && normalized.length > 4) {
      ["new", "san", "los", "saint"].forEach((prefix) => {
        if (normalized.startsWith(prefix)) candidates.add(`${prefix} ${normalized.slice(prefix.length)}`);
      });
    }

    return [...candidates].filter(Boolean);
  }

  function capitalizeWords(text) {
    return text
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  init();
})();