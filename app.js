const DATA_URL = './data/projects_web.geojson';
const META_URL = './data/metadata.json';
const ORG_URL = './data/org_index.json';
const LIST_RENDER_LIMIT = 200;
const ORG_SUGGEST_LIMIT = 12;
const POLYGON_ZOOM = 15;
const INDIVIDUAL_POINT_ZOOM = 13;
const VIEW_PADDING_RATIO = 0.35;
const map = L.map('map', {
  zoomControl: false,
  preferCanvas: true,
  minZoom: 8,
}).setView([55.75, 37.62], 10);
window.stroimMap = map;

L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  tileSize: 256,
  zoomOffset: 0,
  maxZoom: 20,
  maxNativeZoom: 20,
  keepBuffer: 5,
  updateWhenIdle: true,
  attribution: '&copy; OpenStreetMap &copy; CARTO',
}).addTo(map);

const canvasRenderer = L.canvas({ padding: 0.45 });
const modeControl = L.control({ position: 'bottomleft' });
modeControl.onAdd = () => {
  const node = L.DomUtil.create('div', 'mode-badge');
  node.textContent = 'Загрузка слоя';
  return node;
};
modeControl.addTo(map);

const legendControl = L.control({ position: 'bottomright' });
legendControl.onAdd = () => {
  const node = L.DomUtil.create('div', 'legend-control');
  L.DomEvent.disableClickPropagation(node);
  L.DomEvent.disableScrollPropagation(node);
  return node;
};
legendControl.addTo(map);

const refs = {
  summary: document.getElementById('summary'),
  resultCount: document.getElementById('resultCount'),
  resultLimit: document.getElementById('resultLimit'),
  resultList: document.getElementById('resultList'),
  details: document.getElementById('details'),
  search: document.getElementById('searchInput'),
  area: document.getElementById('areaSelect'),
  district: document.getElementById('districtSelect'),
  state: document.getElementById('stateSelect'),
  organization: document.getElementById('organizationInput'),
  organizationSuggestions: document.getElementById('organizationSuggestions'),
  organizationSelected: document.getElementById('organizationSelected'),
  reset: document.getElementById('resetButton'),
  sidebar: document.getElementById('sidebar'),
  sidebarToggle: document.getElementById('sidebarToggle'),
};

let allFeatures = [];
let organizationIndex = [];
let selectedOrganization = null;
let selectedOrganizationUins = null;
let currentFeatures = [];
let currentVisibleFeatures = [];
let currentLayer = null;
let selectedLayer = null;
let selectedId = null;
let filterTimer = null;
let renderTimer = null;
let lastMapMode = null;

init().catch((error) => {
  refs.summary.textContent = 'Ошибка загрузки данных';
  console.error(error);
});

async function init() {
  const [metadata, geojson, organizations] = await Promise.all([
    fetch(META_URL).then((response) => response.json()),
    fetch(DATA_URL).then((response) => response.json()),
    fetch(ORG_URL).then((response) => response.json()),
  ]);

  allFeatures = (geojson.features || []).map(prepareFeature);
  organizationIndex = (organizations || []).map(prepareOrganization);
  fillSelect(refs.area, metadata.areas);
  fillSelect(refs.district, metadata.districts);
  fillSelect(refs.state, metadata.states);
  renderLegend(allFeatures);
  initDxfExportTool();

  refs.summary.textContent = `${formatNumber(metadata.project_count)} проектов, ${formatNumber(metadata.polygon_count)} полигонов`;
  refs.search.addEventListener('input', scheduleFilter);
  refs.area.addEventListener('change', applyFilters);
  refs.district.addEventListener('change', applyFilters);
  refs.state.addEventListener('change', applyFilters);
  refs.organization.addEventListener('input', onOrganizationInput);
  refs.organization.addEventListener('focus', () => renderOrganizationSuggestions(refs.organization.value));
  refs.organization.addEventListener('keydown', onOrganizationKeydown);
  refs.organizationSuggestions.addEventListener('mousedown', (event) => event.preventDefault());
  refs.organizationSuggestions.addEventListener('click', onOrganizationSuggestionClick);
  refs.organizationSelected.addEventListener('click', onOrganizationSelectedClick);
  refs.reset.addEventListener('click', resetFilters);
  refs.sidebarToggle.addEventListener('click', () => refs.sidebar.classList.toggle('sidebar_open'));
  map.on('click', () => closeDetails());
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.org-field')) hideOrganizationSuggestions();
  });
  map.on('zoomend moveend', scheduleMapRender);
  window.addEventListener('resize', () => {
    map.invalidateSize();
    scheduleMapRender();
  });

  requestAnimationFrame(() => {
    map.invalidateSize();
    applyFilters({ fit: true });
  });
}

function fillSelect(select, values) {
  select.innerHTML = '';
  select.append(new Option('Все', ''));
  values.forEach((value) => select.append(new Option(value, value)));
}

function prepareOrganization(org) {
  return {
    ...org,
    key: org.key || normalize(org.name),
    searchKey: org.searchKey || organizationSearchKey(org.name),
  };
}

function onOrganizationInput() {
  const value = refs.organization.value;
  if (selectedOrganization && value !== selectedOrganization.name) {
    selectedOrganization = null;
    selectedOrganizationUins = null;
    renderSelectedOrganization();
    applyFilters();
  }
  renderOrganizationSuggestions(value);
}

function onOrganizationKeydown(event) {
  if (event.key === 'Escape') {
    hideOrganizationSuggestions();
    return;
  }
  if (event.key !== 'Enter') return;
  const first = refs.organizationSuggestions.querySelector('[data-org-key]');
  if (!first) return;
  event.preventDefault();
  selectOrganization(first.dataset.orgKey);
}

function onOrganizationSuggestionClick(event) {
  const item = event.target.closest('[data-org-key]');
  if (!item) return;
  selectOrganization(item.dataset.orgKey);
}

function onOrganizationSelectedClick(event) {
  if (event.target.closest('[data-clear-org]')) {
    clearOrganizationFilter();
  }
}

function renderOrganizationSuggestions(value) {
  const query = organizationSearchKey(value);
  if (!query) {
    hideOrganizationSuggestions();
    return;
  }
  const matches = organizationIndex
    .filter((org) => organizationMatchesQuery(org, query))
    .slice(0, ORG_SUGGEST_LIMIT);
  if (!matches.length) {
    refs.organizationSuggestions.innerHTML = '<div class="org-suggestions__empty">Нет совпадений</div>';
    refs.organizationSuggestions.hidden = false;
    return;
  }
  refs.organizationSuggestions.innerHTML = matches.map((org) => `
    <button type="button" class="org-suggestion" data-org-key="${escapeHtml(org.key)}" role="option">
      <span class="org-suggestion__name">${escapeHtml(org.name)}</span>
      <span class="org-suggestion__count">${formatNumber(org.count)}</span>
    </button>
  `).join('');
  refs.organizationSuggestions.hidden = false;
}

function hideOrganizationSuggestions() {
  refs.organizationSuggestions.hidden = true;
  refs.organizationSuggestions.innerHTML = '';
}

function organizationMatchesQuery(org, query) {
  return org.searchKey.startsWith(query)
    || org.key.startsWith(query)
    || org.key.includes(` ${query}`);
}

function selectOrganization(key) {
  const org = organizationIndex.find((item) => item.key === key);
  if (!org) return;
  selectedOrganization = org;
  selectedOrganizationUins = new Set(org.uins || []);
  refs.organization.value = org.name;
  hideOrganizationSuggestions();
  renderSelectedOrganization();
  applyFilters();
}

function clearOrganizationFilter(options = {}) {
  selectedOrganization = null;
  selectedOrganizationUins = null;
  refs.organization.value = '';
  hideOrganizationSuggestions();
  renderSelectedOrganization();
  if (options.apply !== false) applyFilters();
}

function renderSelectedOrganization() {
  if (!selectedOrganization) {
    refs.organizationSelected.hidden = true;
    refs.organizationSelected.innerHTML = '';
    return;
  }
  refs.organizationSelected.innerHTML = `
    <span>${escapeHtml(selectedOrganization.name)}</span>
    <span class="org-selected__count">${formatNumber(selectedOrganization.count)}</span>
    <button type="button" data-clear-org aria-label="Убрать организацию">×</button>
  `;
  refs.organizationSelected.hidden = false;
}

function organizationSearchKey(value) {
  return normalize(value)
    .replace(/^["'«»\s]+|["'«»\s]+$/g, '')
    .replace(/^(ооо|ао|пао|зао|оао|нко|ано|фгбу|гбу|гау|гку|мку|фку|ип)\s+/u, '')
    .replace(/^["'«»\s]+|["'«»\s]+$/g, '');
}

function scheduleFilter() {
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => applyFilters(), 180);
}

function resetFilters() {
  refs.search.value = '';
  refs.area.value = '';
  refs.district.value = '';
  refs.state.value = '';
  clearOrganizationFilter({ apply: false });
  selectedId = null;
  lastMapMode = null;
  applyFilters({ fit: true });
}

function applyFilters(options = {}) {
  const query = normalize(refs.search.value);
  const area = refs.area.value;
  const district = refs.district.value;
  const state = refs.state.value;

  const filtered = allFeatures.filter((feature) => {
    const props = feature.properties || {};
    if (area && props.area !== area) return false;
    if (district && props.district !== district) return false;
    if (state && props.state !== state) return false;
    if (selectedOrganizationUins && !selectedOrganizationUins.has(props.uin)) return false;
    if (!query) return true;
    return searchableText(props).includes(query);
  });

  currentFeatures = filtered;
  if (options.fit && filtered.length) {
    map.fitBounds(dataBounds(filtered), { padding: [28, 28], maxZoom: 14, animate: false });
  }
  renderLayer(currentFeatures);
  updateVisibleResults();

  if (options.fit && filtered.length) {
    window.setTimeout(() => {
      map.invalidateSize();
      renderLayer(currentFeatures);
      updateVisibleResults();
    }, 40);
  }
}

function renderLayer(features) {
  selectedLayer = null;
  if (currentLayer) map.removeLayer(currentLayer);
  const mode = map.getZoom() >= POLYGON_ZOOM ? 'polygons' : 'points';
  lastMapMode = mode;
  currentLayer = mode === 'polygons'
    ? renderPolygonLayer(featuresInView(features))
    : renderAggregateLayer(features);
  window.stroimCurrentLayer = currentLayer;
  renderModeBadge(mode, currentLayer);
}

function renderPolygonLayer(features) {
  currentLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
    renderer: canvasRenderer,
    smoothFactor: 1.8,
    style: featureStyle,
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, pointStyle(feature)),
    onEachFeature: (feature, layer) => {
      layer.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        selectFeature(feature, layer, { zoom: false, popup: true, latlng: event.latlng });
      });
      const props = feature.properties || {};
      const label = [props.uin, props.address].filter(Boolean).join(' · ');
      if (label) {
        layer.bindTooltip(escapeHtml(label), {
          className: 'project-tooltip',
          sticky: true,
          direction: 'top',
          opacity: 0.94,
        });
      }
    },
  }).addTo(map);
  return currentLayer;
}

function renderAggregateLayer(features) {
  const layerGroup = L.featureGroup();
  const groups = clusterFeatures(features);
  groups.forEach((group) => {
    const count = group.features.length;
    let layer;
    if (count === 1 && map.getZoom() >= INDIVIDUAL_POINT_ZOOM) {
      const feature = group.features[0];
      layer = L.circleMarker(group.latlng, pointStyle(feature));
      layer.feature = feature;
      layer.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        selectFeature(feature, layer, { zoom: true, popup: true, latlng: event.latlng });
      });
      const props = feature.properties || {};
      const label = [props.uin, props.address].filter(Boolean).join(' В· ');
      if (label) bindProjectTooltip(layer, label);
    } else {
      layer = L.marker(group.latlng, {
        icon: aggregateIcon(count),
        keyboard: false,
      });
      layer.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        const targetZoom = count === 1 ? POLYGON_ZOOM : Math.min(POLYGON_ZOOM, map.getZoom() + 2);
        map.fitBounds(group.bounds.pad(0.2), { maxZoom: targetZoom, padding: [36, 36] });
      });
      layer.bindTooltip(`${formatNumber(count)} объектов`, {
        className: 'project-tooltip',
        direction: 'top',
        opacity: 0.94,
      });
    }
    layerGroup.addLayer(layer);
  });
  layerGroup.addTo(map);
  return layerGroup;
}

function renderModeBadge(mode, layer) {
  const node = document.querySelector('.mode-badge');
  if (!node) return;
  const count = layer?.getLayers ? layer.getLayers().length : 0;
  node.textContent = mode === 'polygons'
    ? `Полигоны в окне: ${formatNumber(count)}`
    : `Агрегаты: ${formatNumber(count)}`;
}

function scheduleMapRender() {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    if (!currentFeatures.length) return;
    const mode = map.getZoom() >= POLYGON_ZOOM ? 'polygons' : 'points';
    renderLayer(currentFeatures);
    updateVisibleResults();
    if (mode !== lastMapMode) lastMapMode = mode;
  }, 80);
}

function dataBounds(features) {
  const bounds = L.latLngBounds([]);
  features.forEach((feature) => {
    const latlng = featureLatLng(feature);
    if (latlng) bounds.extend(latlng);
  });
  return bounds.isValid() ? bounds : map.getBounds();
}

function prepareFeature(feature) {
  feature._bbox = geometryBbox(feature.geometry);
  return feature;
}

function geometryBbox(geometry) {
  if (!geometry?.coordinates) return null;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  visitCoordinates(geometry.coordinates, bbox);
  return Number.isFinite(bbox[0]) ? bbox : null;
}

function visitCoordinates(coords, bbox) {
  if (!Array.isArray(coords)) return;
  if (coords.length >= 2 && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
    const lng = coords[0];
    const lat = coords[1];
    if (lng < bbox[0]) bbox[0] = lng;
    if (lat < bbox[1]) bbox[1] = lat;
    if (lng > bbox[2]) bbox[2] = lng;
    if (lat > bbox[3]) bbox[3] = lat;
    return;
  }
  coords.forEach((item) => visitCoordinates(item, bbox));
}

function featureIntersectsBounds(feature, bounds) {
  const bbox = feature._bbox;
  if (!bbox) {
    const latlng = featureLatLng(feature);
    return Boolean(latlng && bounds.contains(latlng));
  }
  return bbox[2] >= bounds.getWest()
    && bbox[0] <= bounds.getEast()
    && bbox[3] >= bounds.getSouth()
    && bbox[1] <= bounds.getNorth();
}

function featuresInView(features) {
  const bounds = map.getBounds().pad(VIEW_PADDING_RATIO);
  return features.filter((feature) =>
    featureIntersectsBounds(feature, bounds) || feature.properties?.id === selectedId
  );
}

function featuresOnScreen(features) {
  const bounds = map.getBounds();
  return features.filter((feature) => featureIntersectsBounds(feature, bounds));
}

function updateVisibleResults() {
  currentVisibleFeatures = featuresOnScreen(currentFeatures);
  window.stroimCurrentVisibleFeatures = currentVisibleFeatures;
  renderList(currentVisibleFeatures);
  refs.resultCount.textContent = `${formatNumber(currentVisibleFeatures.length)} на экране`;
  refs.resultLimit.textContent = currentVisibleFeatures.length > LIST_RENDER_LIMIT
    ? `${formatNumber(currentFeatures.length)} по фильтру · список от ${LIST_RENDER_LIMIT} и меньше`
    : `${formatNumber(currentFeatures.length)} по фильтру`;
}


function renderList(features) {
  refs.resultList.innerHTML = '';
  if (features.length > LIST_RENDER_LIMIT) {
    const notice = document.createElement('div');
    notice.className = 'results-empty';
    notice.textContent = `На экране ${formatNumber(features.length)} объектов. Приблизьте карту или уточните фильтр, чтобы показать список.`;
    refs.resultList.append(notice);
    return;
  }
  const fragment = document.createDocumentFragment();
  features.forEach((feature) => {
    const props = feature.properties || {};
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `result-item${selectedId === props.id ? ' result-item_active' : ''}`;
    item.dataset.id = props.id;
    item.innerHTML = `
      <span class="result-item__title">${escapeHtml(props.name || props.address || props.uin || 'Без названия')}</span>
      <span class="result-item__meta">
        ${props.uin ? `<span class="pill">${escapeHtml(props.uin)}</span>` : ''}
        ${props.state ? `<span class="pill">${escapeHtml(props.state)}</span>` : ''}
        ${props.district ? `<span class="pill">${escapeHtml(props.district)}</span>` : ''}
      </span>
    `;
    item.addEventListener('click', () => selectFromList(feature));
    fragment.append(item);
  });
  refs.resultList.append(fragment);
}

function selectFromList(feature) {
  const id = feature.properties?.id;
  const foundLayer = findFeatureLayer(id);
  selectFeature(feature, foundLayer, { zoom: true, popup: true });
  refs.sidebar.classList.remove('sidebar_open');
}

function selectFeature(feature, layer, options = {}) {
  selectedId = feature.properties?.id;
  if (selectedLayer && selectedLayer.setStyle) {
    selectedLayer.setStyle(featureStyle(selectedLayer.feature));
  }
  selectedLayer = layer || null;
  if (selectedLayer && selectedLayer.setStyle) {
    selectedLayer.setStyle({
      color: '#111827',
      weight: 3,
      fillOpacity: 0.55,
    });
    selectedLayer.bringToFront();
  }

  if (options.zoom) {
    if (layer?.getBounds) map.fitBounds(layer.getBounds(), { padding: [44, 44], maxZoom: 17 });
    else if (layer?.getLatLng) map.setView(layer.getLatLng(), Math.max(map.getZoom(), 17));
    else {
      const latlng = featureLatLng(feature);
      if (latlng) map.setView(latlng, Math.max(map.getZoom(), POLYGON_ZOOM));
    }
  }
  if (options.popup) {
    openProjectPopup(feature, layer, options.latlng);
  } else {
    closeDetails();
  }
  updateVisibleResults();
}

function findFeatureLayer(id) {
  let foundLayer = null;
  if (currentLayer) {
    currentLayer.eachLayer((layer) => {
      if (layer.feature?.properties?.id === id) foundLayer = layer;
    });
  }
  return foundLayer;
}

const PS_BASE = './data/ps/';
const psCache = new Map(); // uin -> trimmed PS data | null (нет данных)

function openProjectPopup(feature, layer, latlng) {
  const props = feature.properties || {};
  const uin = props.uin || '';
  const anchor = latlng || popupLatLngForFeature(feature, layer);
  if (!anchor) return;

  const popup = L.popup({
    className: 'attribute-popup',
    maxWidth: 430,
    minWidth: 300,
    autoPan: true,
    keepInView: true,
  })
    .setLatLng(anchor)
    .setContent(featureDetailsHtml(feature))
    .openOn(map);

  const node = popup.getElement()?.querySelector('.attr-popup');
  if (node) loadPsSections(uin, node);
}

function popupLatLngForFeature(feature, layer) {
  if (layer?.getBounds) return layer.getBounds().getCenter();
  if (layer?.getLatLng) return layer.getLatLng();
  return featureLatLng(feature);
}

function featureDetailsHtml(feature) {
  const props = feature.properties || {};
  const uin = props.uin || '';
  const title = props.name || props.address || uin || 'Объект';
  return `
    <div class="attr-popup" data-uin="${escapeHtml(uin)}">
      <div class="attr-popup__title">${escapeHtml(title)}</div>
      ${props.state ? `<span class="status-pill" style="background:${colorByState(props.state)}">${escapeHtml(props.state)}</span>` : ''}
      <dl class="details__grid">
        ${detailRow('УИН', props.uin)}
        ${detailRow('Округ', props.area)}
        ${detailRow('Район', props.district)}
        ${detailRow('Адрес', props.address)}
        ${detailRow('Жилой комплекс', props.res_complex)}
        ${detailRow('Тип работ', props.job_type)}
        ${detailRow('Функционал', props.fno_name)}
        ${detailRow('Финансирование', props.fin_source)}
        <span class="ps-extra-anchor" hidden></span>
        ${detailRow('План ввода', dateOnly(props.input_plan))}
        ${detailRow('Факт ввода', dateOnly(props.input_fact))}
      </dl>
      <div class="ps-sections"><div class="ps-loading">Загрузка сведений…</div></div>
    </div>
  `;
}

function openDetailsCard(feature) {
  const props = feature.properties || {};
  const uin = props.uin || '';
  const title = props.name || props.address || uin || 'Объект';
  refs.details.classList.add('details_open');
  setLegendHidden(true);
  refs.details.dataset.uin = uin;
  refs.details.scrollTop = 0;
  refs.details.innerHTML = `
    <div class="details__top">
      <h2>${escapeHtml(title)}</h2>
      <button class="details__close" type="button" aria-label="Закрыть">×</button>
    </div>
    ${props.state ? `<span class="status-pill" style="background:${colorByState(props.state)}">${escapeHtml(props.state)}</span>` : ''}
    <dl class="details__grid">
      ${detailRow('УИН', props.uin)}
      ${detailRow('Округ', props.area)}
      ${detailRow('Район', props.district)}
      ${detailRow('Адрес', props.address)}
      ${detailRow('Жилой комплекс', props.res_complex)}
      ${detailRow('Тип работ', props.job_type)}
      ${detailRow('Функционал', props.fno_name)}
      ${detailRow('Финансирование', props.fin_source)}
      <span class="ps-extra-anchor" hidden></span>
      ${detailRow('План ввода', dateOnly(props.input_plan))}
      ${detailRow('Факт ввода', dateOnly(props.input_fact))}
    </dl>
    <div class="ps-sections"><div class="ps-loading">Загрузка сведений…</div></div>
  `;
  refs.details.querySelector('.details__close').addEventListener('click', closeDetails);
  loadPsSections(uin, refs.details);
}

async function loadPsSections(uin, root = refs.details) {
  const sections = () => root.querySelector('.ps-sections');
  if (!uin) {
    const node = sections();
    if (node) node.innerHTML = '';
    return;
  }
  let data = psCache.get(uin);
  if (data === undefined) {
    try {
      const response = await fetch(PS_BASE + encodeURIComponent(uin) + '.json');
      data = response.ok ? await response.json() : null;
    } catch {
      data = null;
    }
    psCache.set(uin, data);
  }
  // Пользователь мог переключиться на другой объект, пока шла загрузка.
  if (root.dataset.uin !== uin) return;
  renderPsSections(data, root);
}

function renderPsSections(data, root = refs.details) {
  const node = root.querySelector('.ps-sections');
  if (!node) return;

  // Кадастр и плановое начало — в основную таблицу, перед «План ввода».
  const anchor = root.querySelector('.ps-extra-anchor');
  if (anchor && data) {
    const extras = [];
    if (Array.isArray(data.cadastr) && data.cadastr.length) {
      extras.push(rawDetailRow('Кадастр', data.cadastr.map(escapeHtml).join('<br>')));
    }
    const startPlan = data.schedule?.startPlan;
    if (startPlan) extras.push(detailRow('Начало (план)', dateOnly(startPlan)));
    if (extras.length) anchor.insertAdjacentHTML('beforebegin', extras.join(''));
  }

  if (!data || !(data.orgs?.length || data.tep?.length || data.docs?.length)) {
    node.innerHTML = '';
    return;
  }

  const blocks = [];
  if (data.orgs?.length) {
    blocks.push(psAccordion('Застройщик / организации', data.orgs.length, data.orgs.map(orgRow).join('')));
  }
  if (data.tep?.length) {
    blocks.push(psAccordion('Технико-экономические показатели', data.tep.length, data.tep.map(tepRow).join('')));
  }
  if (data.docs?.length) {
    blocks.push(psAccordion('Документы', data.docs.length, data.docs.map(docRow).join('')));
  }
  node.innerHTML = blocks.join('');
}

function psAccordion(title, count, bodyHtml) {
  return `<details class="ps-acc">
    <summary class="ps-acc__head">
      <span class="ps-acc__title">${escapeHtml(title)}</span>
      <span class="ps-acc__count">${formatNumber(count)}</span>
    </summary>
    <div class="ps-acc__body">${bodyHtml}</div>
  </details>`;
}

function orgRow(org) {
  const meta = [
    org.inn ? `ИНН ${escapeHtml(org.inn)}` : '',
    org.ogrn ? `ОГРН ${escapeHtml(org.ogrn)}` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="ps-org">
    <div class="ps-org__role">${escapeHtml(org.role || 'Организация')}</div>
    <div class="ps-org__name">${escapeHtml(org.name || '—')}</div>
    ${meta ? `<div class="ps-org__meta">${meta}</div>` : ''}
    ${org.address ? `<div class="ps-org__addr">${escapeHtml(org.address)}</div>` : ''}
  </div>`;
}

function tepRow(item) {
  const value = [item.val, item.unit].filter(Boolean).map(escapeHtml).join(' ');
  return `<div class="ps-tep">
    <span class="ps-tep__name">${escapeHtml(item.name || '')}</span>
    <span class="ps-tep__val">${value}</span>
  </div>`;
}

function docRow(doc) {
  const id = doc.docRasporNum || doc.docParentId || '';
  const head = `${escapeHtml(doc.docType || 'Документ')}${id ? ` · ${escapeHtml(id)}` : ''}`;
  const meta = [dateOnly(doc.docRasporDate) || doc.docYear, doc.docState]
    .filter(Boolean).map(escapeHtml).join(' · ');
  const title = doc.documentLink
    ? `<a href="${escapeHtml(doc.documentLink)}" target="_blank" rel="noopener">${head}</a>`
    : head;
  return `<div class="ps-doc">
    <div class="ps-doc__head">${title}</div>
    ${meta ? `<div class="ps-doc__meta">${meta}</div>` : ''}
  </div>`;
}

function rawDetailRow(label, html) {
  return `<dt>${escapeHtml(label)}</dt><dd>${html}</dd>`;
}

function closeDetails() {
  map.closePopup();
  refs.details.classList.remove('details_open');
  refs.details.dataset.uin = '';
  refs.details.innerHTML = '';
  setLegendHidden(false);
}

function setLegendHidden(hidden) {
  const node = document.querySelector('.legend-control');
  if (node) node.classList.toggle('legend-control_hidden', hidden);
}

function isFeatureVisibleByCurrentFilters(feature) {
  const props = feature.properties || {};
  const query = normalize(refs.search.value);
  return (!refs.area.value || props.area === refs.area.value)
    && (!refs.district.value || props.district === refs.district.value)
    && (!refs.state.value || props.state === refs.state.value)
    && (!selectedOrganizationUins || selectedOrganizationUins.has(props.uin))
    && (!query || searchableText(props).includes(query));
}

function searchableText(props) {
  return normalize([
    props.id,
    props.uin,
    props.name,
    props.address,
    props.res_complex,
    props.area,
    props.district,
    props.state,
    props.fno_name,
    props.job_type,
    props.fin_source,
  ].filter(Boolean).join(' '));
}

function normalize(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
}

function featureStyle(feature) {
  const color = colorByState(feature?.properties?.state);
  const selected = feature?.properties?.id === selectedId;
  return {
    color: selected ? '#111827' : color,
    weight: selected ? 3 : 1.4,
    opacity: 0.95,
    fillColor: color,
    fillOpacity: selected ? 0.55 : 0.28,
  };
}

function pointStyle(feature) {
  const color = colorByState(feature?.properties?.state);
  const selected = feature?.properties?.id === selectedId;
  return {
    radius: selected ? 8 : 6,
    color: '#ffffff',
    weight: selected ? 2.5 : 1.5,
    fillColor: color,
    fillOpacity: 0.95,
  };
}

function bindProjectTooltip(layer, label) {
  layer.bindTooltip(escapeHtml(label), {
    className: 'project-tooltip',
    sticky: true,
    direction: 'top',
    opacity: 0.94,
  });
}

function renderLegend(features) {
  const node = document.querySelector('.legend-control');
  if (!node) return;
  const counts = new Map();
  features.forEach((feature) => {
    const state = feature.properties?.state || 'Без статуса';
    counts.set(state, (counts.get(state) || 0) + 1);
  });
  const rows = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `
      <div class="legend-row">
        <span class="legend-swatch" style="background:${colorByState(state)}"></span>
        <span class="legend-label">${escapeHtml(state)}</span>
        <span class="legend-count">${formatNumber(count)}</span>
      </div>
    `).join('');
  node.innerHTML = `
    <div class="legend-title">Легенда</div>
    <div class="legend-subtitle">Цвет по статусу</div>
    ${rows}
  `;
}

function clusterFeatures(features) {
  const zoom = map.getZoom();
  const cellSize = clusterCellSize(zoom);
  const buckets = new Map();
  features.forEach((feature) => {
    const latlng = featureLatLng(feature);
    if (!latlng) return;
    const projected = map.project(latlng, zoom);
    const key = `${Math.floor(projected.x / cellSize)}:${Math.floor(projected.y / cellSize)}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        features: [],
        sumLat: 0,
        sumLng: 0,
        bounds: L.latLngBounds(latlng, latlng),
      });
    }
    const bucket = buckets.get(key);
    bucket.features.push(feature);
    bucket.sumLat += latlng.lat;
    bucket.sumLng += latlng.lng;
    bucket.bounds.extend(latlng);
  });
  return Array.from(buckets.values()).map((bucket) => ({
    ...bucket,
    latlng: L.latLng(
      bucket.sumLat / bucket.features.length,
      bucket.sumLng / bucket.features.length,
    ),
  }));
}

function clusterCellSize(zoom) {
  if (zoom <= 9) return 108;
  if (zoom <= 11) return 86;
  if (zoom <= 13) return 66;
  return 48;
}

function aggregateIcon(count) {
  const size = count < 10 ? 34 : count < 100 ? 42 : count < 1000 ? 50 : 58;
  return L.divIcon({
    className: 'aggregate-cluster',
    html: `<span>${formatNumber(count)}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function featureLatLng(feature) {
  const props = feature.properties || {};
  if (Number.isFinite(props.lat) && Number.isFinite(props.lng)) {
    return L.latLng(props.lat, props.lng);
  }
  if (feature.geometry?.type === 'Point') {
    const [lng, lat] = feature.geometry.coordinates;
    return L.latLng(lat, lng);
  }
  return null;
}

function colorByState(state) {
  const value = normalize(state);
  if (value.includes('сдан') || value.includes('введ')) return '#18815f';
  if (value.includes('стро')) return '#0b63ce';
  if (value.includes('проект')) return '#b96214';
  if (value.includes('соглас')) return '#7256c8';
  if (value.includes('отмен') || value.includes('приост')) return '#b42318';
  return '#46546a';
}

function detailRow(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function dateOnly(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

/* ============================================================
   Выгрузка полигонов домов по нарисованной области
   ============================================================ */

const MOSCOW_CRS_NAME = 'Moscow_MGGT';
const MOSCOW_CRS_PROJ4 = '+proj=tmerc +lat_0=55.66666666667 +lon_0=37.5 +k=1 +x_0=16.098 +y_0=14.512 +ellps=bessel +towgs84=316.151,78.924,589.650,-1.57273,2.69209,2.34693,8.4507 +units=m +no_defs';
const MOSCOW_CRS_WKT = 'PROJCS["Moscow_MGGT",GEOGCS["GCS_Bessel_1841",DATUM["D_Bessel_1841",'
  + 'SPHEROID["Bessel_1841",6377397.155,299.1528128],'
  + 'TOWGS84[316.151,78.924,589.650,-1.57273,2.69209,2.34693,8.4507]],'
  + 'PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],'
  + 'PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",55.66666666667],'
  + 'PARAMETER["central_meridian",37.5],PARAMETER["scale_factor",1],'
  + 'PARAMETER["false_easting",16.098],PARAMETER["false_northing",14.512],UNIT["Meter",1]]';
const EXPORT_LAYER = 'DOMA';
const textEncoder = new TextEncoder();

const dxf = {
  mode: false,
  points: [],
  vertexLayer: null,
  line: null,
  rubber: null,
  polygon: null,
  selected: [],
  control: null,
  els: {},
  project: null,
};

const DBF_FIELDS = [
  { name: 'ID', type: 'N', length: 12, decimals: 0, value: (props) => props.id },
  { name: 'UIN', type: 'C', length: 20, value: (props) => props.uin },
  { name: 'NAME', type: 'C', length: 140, value: (props) => props.name },
  { name: 'AREA', type: 'C', length: 20, value: (props) => props.area },
  { name: 'DISTRICT', type: 'C', length: 80, value: (props) => props.district },
  { name: 'STATE', type: 'C', length: 64, value: (props) => props.state },
  { name: 'ADDRESS', type: 'C', length: 180, value: (props) => props.address },
];

function initDxfExportTool() {
  if (!window.proj4) {
    console.warn('proj4 не загружен — выгрузка недоступна');
    return;
  }
  dxf.project = (lng, lat) => window.proj4(MOSCOW_CRS_PROJ4, [lng, lat]);

  const control = L.control({ position: 'topright' });
  control.onAdd = () => {
    const node = L.DomUtil.create('div', 'dxf-tool leaflet-bar');
    node.innerHTML = `
      <button type="button" class="dxf-btn" data-act="draw" title="Нарисовать область выделения">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <polygon points="4,3 16,6 17,15 8,17 3,11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="4" cy="3" r="1.7" fill="currentColor"/><circle cx="16" cy="6" r="1.7" fill="currentColor"/>
          <circle cx="17" cy="15" r="1.7" fill="currentColor"/><circle cx="8" cy="17" r="1.7" fill="currentColor"/>
          <circle cx="3" cy="11" r="1.7" fill="currentColor"/>
        </svg>
      </button>
      <button type="button" class="dxf-btn" data-act="finish" title="Завершить контур" disabled>✓</button>
      <button type="button" class="dxf-btn dxf-btn_text" data-act="download-dxf" title="Скачать дома в DXF" disabled>DXF</button>
      <button type="button" class="dxf-btn dxf-btn_text" data-act="download-geojson" title="Скачать дома в GeoJSON" disabled>GeoJSON</button>
      <button type="button" class="dxf-btn dxf-btn_text" data-act="download-shp" title="Скачать дома в SHP" disabled>SHP</button>
      <button type="button" class="dxf-btn" data-act="clear" title="Очистить выделение" disabled>✕</button>
      <div class="dxf-hint" hidden></div>
    `;
    L.DomEvent.disableClickPropagation(node);
    L.DomEvent.disableScrollPropagation(node);
    return node;
  };
  control.addTo(map);
  dxf.control = control;

  const root = control.getContainer();
  dxf.els = {
    draw: root.querySelector('[data-act="draw"]'),
    finish: root.querySelector('[data-act="finish"]'),
    dxf: root.querySelector('[data-act="download-dxf"]'),
    geojson: root.querySelector('[data-act="download-geojson"]'),
    shp: root.querySelector('[data-act="download-shp"]'),
    clear: root.querySelector('[data-act="clear"]'),
    hint: root.querySelector('.dxf-hint'),
  };

  dxf.els.draw.addEventListener('click', () => (dxf.mode ? finishDxfDraw() : startDxfDraw()));
  dxf.els.finish.addEventListener('click', finishDxfDraw);
  dxf.els.dxf.addEventListener('click', downloadDxf);
  dxf.els.geojson.addEventListener('click', downloadGeoJson);
  dxf.els.shp.addEventListener('click', downloadShp);
  dxf.els.clear.addEventListener('click', clearDxfSelection);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dxf.mode) clearDxfSelection();
  });
}

function startDxfDraw() {
  clearDxfSelection();
  dxf.mode = true;
  map.getContainer().classList.add('dxf-drawing');
  map.doubleClickZoom.disable();
  dxf.els.draw.classList.add('dxf-btn_active');
  dxf.vertexLayer = L.layerGroup().addTo(map);
  map.on('click', onDxfMapClick);
  map.on('mousemove', onDxfMouseMove);
  map.on('dblclick', onDxfDblClick);
  setDxfHint('Кликайте по карте, чтобы задать вершины. Двойной клик или ✓ — завершить.');
  refreshDxfButtons();
}

function onDxfMapClick(event) {
  dxf.points.push(event.latlng);
  L.circleMarker(event.latlng, {
    radius: 4, color: '#0b63ce', weight: 2, fillColor: '#ffffff', fillOpacity: 1,
  }).addTo(dxf.vertexLayer);
  updateDxfPreview();
  refreshDxfButtons();
}

function onDxfMouseMove(event) {
  if (!dxf.points.length) return;
  const last = dxf.points[dxf.points.length - 1];
  const path = [last, event.latlng];
  if (dxf.points.length >= 2) path.push(dxf.points[0]);
  if (dxf.rubber) dxf.rubber.setLatLngs(path);
  else dxf.rubber = L.polyline(path, { color: '#0b63ce', weight: 1, dashArray: '4 4', opacity: 0.7 }).addTo(map);
}

function onDxfDblClick(event) {
  L.DomEvent.stop(event);
  finishDxfDraw();
}

function updateDxfPreview() {
  if (dxf.line) dxf.line.setLatLngs(dxf.points);
  else dxf.line = L.polyline(dxf.points, { color: '#0b63ce', weight: 2 }).addTo(map);
}

function finishDxfDraw() {
  if (!dxf.mode) return;
  stopDxfDrawListeners();
  dxf.mode = false;
  map.getContainer().classList.remove('dxf-drawing');
  map.doubleClickZoom.enable();
  dxf.els.draw.classList.remove('dxf-btn_active');

  if (dxf.points.length < 3) {
    setDxfHint('Нужно минимум 3 точки.');
    refreshDxfButtons();
    return;
  }
  dxf.polygon = L.polygon(dxf.points, {
    color: '#0b63ce', weight: 2, fillColor: '#0b63ce', fillOpacity: 0.08, dashArray: '6 4',
  }).addTo(map);

  const ring = dxf.points.map((ll) => [ll.lng, ll.lat]);
  dxf.selected = selectFeaturesInRing(ring);
  const polygonCount = exportPolygonFeatures().length;
  setDxfHint(polygonCount
    ? `В выделении: ${formatNumber(polygonCount)} объектов. Экспорт в МГГТ для QGIS.`
    : 'В выделении нет объектов с полигонами.');
  refreshDxfButtons();
}

function stopDxfDrawListeners() {
  map.off('click', onDxfMapClick);
  map.off('mousemove', onDxfMouseMove);
  map.off('dblclick', onDxfDblClick);
  if (dxf.rubber) { map.removeLayer(dxf.rubber); dxf.rubber = null; }
  if (dxf.line) { map.removeLayer(dxf.line); dxf.line = null; }
}

function clearDxfSelection() {
  stopDxfDrawListeners();
  dxf.mode = false;
  map.getContainer().classList.remove('dxf-drawing');
  map.doubleClickZoom.enable();
  if (dxf.vertexLayer) { map.removeLayer(dxf.vertexLayer); dxf.vertexLayer = null; }
  if (dxf.polygon) { map.removeLayer(dxf.polygon); dxf.polygon = null; }
  dxf.points = [];
  dxf.selected = [];
  dxf.els.draw.classList.remove('dxf-btn_active');
  setDxfHint('');
  refreshDxfButtons();
}

function refreshDxfButtons() {
  const { draw, finish, dxf: dxfButton, geojson, shp, clear } = dxf.els;
  const hasPolygons = exportPolygonFeatures().length > 0;
  draw.classList.toggle('dxf-btn_active', dxf.mode);
  finish.disabled = !(dxf.mode && dxf.points.length >= 3);
  dxfButton.disabled = !hasPolygons;
  geojson.disabled = !hasPolygons;
  shp.disabled = !hasPolygons;
  clear.disabled = !(dxf.mode || dxf.points.length || dxf.polygon);
}

function setDxfHint(text) {
  if (!dxf.els.hint) return;
  dxf.els.hint.textContent = text;
  dxf.els.hint.hidden = !text;
}

function selectFeaturesInRing(ring) {
  return allFeatures.filter((feature) => featureHitsRing(feature, ring));
}

function featureHitsRing(feature, ring) {
  const geom = feature.geometry;
  if (!geom) return false;
  let anyVertexInside = false;
  let centroidSum = [0, 0];
  let centroidCount = 0;
  forEachPolygonRing(geom, (coords) => {
    for (const pt of coords) {
      centroidSum[0] += pt[0];
      centroidSum[1] += pt[1];
      centroidCount += 1;
      if (pointInRing(pt, ring)) anyVertexInside = true;
    }
  });
  if (anyVertexInside) return true;
  let drawnInsideFeature = false;
  forEachPolygon(geom, (rings) => {
    if (drawnInsideFeature || !rings.length) return;
    const exterior = rings[0];
    if (ring.some((pt) => pointInRing(pt, exterior))) drawnInsideFeature = true;
  });
  if (drawnInsideFeature) return true;
  if (centroidCount) {
    return pointInRing([centroidSum[0] / centroidCount, centroidSum[1] / centroidCount], ring);
  }
  return false;
}

function pointInRing(point, ring) {
  const x = point[0];
  const y = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function forEachPolygonRing(geometry, cb) {
  forEachPolygon(geometry, (rings) => rings.forEach((ring) => cb(ring)));
}

function forEachPolygon(geometry, cb) {
  if (geometry?.type === 'Polygon') {
    cb(geometry.coordinates);
  } else if (geometry?.type === 'MultiPolygon') {
    geometry.coordinates.forEach((poly) => cb(poly));
  }
}

function exportPolygonFeatures() {
  return dxf.selected.filter((feature) => isPolygonGeometry(feature.geometry));
}

function isPolygonGeometry(geometry) {
  return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
}

function downloadDxf() {
  const features = exportPolygonFeatures();
  if (!features.length) return;
  const text = buildDxf(features);
  downloadBlob(new Blob([text], { type: 'application/dxf' }), `doma_${exportStamp()}_mggt.dxf`);
  setDxfHint(`DXF скачан: ${formatNumber(features.length)} объектов, ${formatNumber(countDxfPolylines(features))} полилиний.`);
}

function downloadGeoJson() {
  const features = exportPolygonFeatures();
  if (!features.length) return;
  const text = JSON.stringify(buildProjectedGeoJson(features), null, 2);
  downloadBlob(new Blob([text], { type: 'application/geo+json' }), `doma_${exportStamp()}_mggt.geojson`);
  setDxfHint(`GeoJSON скачан: ${formatNumber(features.length)} объектов в МГГТ с PROJ.4 для QGIS.`);
}

function downloadShp() {
  const features = exportPolygonFeatures();
  if (!features.length) return;
  const stamp = exportStamp();
  const zip = buildShpZip(features, `doma_${stamp}_mggt`);
  downloadBlob(new Blob([zip], { type: 'application/zip' }), `doma_${stamp}_mggt_shp.zip`);
  setDxfHint(`SHP скачан: ${formatNumber(features.length)} объектов; в ZIP есть .prj, .qpj и .proj4.txt.`);
}

function exportStamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function countDxfPolylines(features) {
  let count = 0;
  features.forEach((feature) => forEachPolygonRing(feature.geometry, () => { count += 1; }));
  return count;
}

function buildDxf(features) {
  const out = [];
  const push = (code, value) => { out.push(String(code)); out.push(String(value)); };
  const projectedRings = collectProjectedRings(features);
  const bbox = projectedRingsBounds(projectedRings);

  push(999, `CRS PROJ4: ${MOSCOW_CRS_PROJ4}`);
  push(0, 'SECTION'); push(2, 'HEADER');
  push(9, '$ACADVER'); push(1, 'AC1009');
  push(9, '$EXTMIN'); push(10, bbox[0].toFixed(4)); push(20, bbox[1].toFixed(4)); push(30, 0);
  push(9, '$EXTMAX'); push(10, bbox[2].toFixed(4)); push(20, bbox[3].toFixed(4)); push(30, 0);
  push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'TABLES');
  push(0, 'TABLE'); push(2, 'LAYER'); push(70, 1);
  push(0, 'LAYER');
  push(2, EXPORT_LAYER); push(70, 0); push(62, 7); push(6, 'CONTINUOUS');
  push(0, 'ENDTAB');
  push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'ENTITIES');
  projectedRings.forEach((pts) => {
    push(0, 'POLYLINE');
    push(8, EXPORT_LAYER);
    push(66, 1);
    push(70, 1);
    push(10, 0); push(20, 0); push(30, 0);
    pts.forEach((pt) => {
      push(0, 'VERTEX');
      push(8, EXPORT_LAYER);
      push(10, pt[0].toFixed(4));
      push(20, pt[1].toFixed(4));
      push(30, 0);
    });
    push(0, 'SEQEND');
    push(8, EXPORT_LAYER);
  });
  push(0, 'ENDSEC');
  push(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

function collectProjectedRings(features) {
  const rings = [];
  features.forEach((feature) => {
    forEachPolygonRing(feature.geometry, (coords) => {
      const pts = ringToProjected(coords);
      if (pts.length >= 3) rings.push(pts);
    });
  });
  return rings;
}

function projectedRingsBounds(rings) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  rings.forEach((ring) => ring.forEach((point) => extendBounds(bbox, point)));
  return Number.isFinite(bbox[0]) ? bbox : [0, 0, 0, 0];
}

function buildProjectedGeoJson(features) {
  return {
    type: 'FeatureCollection',
    name: 'doma_mggt',
    crs: {
      type: 'name',
      properties: {
        name: MOSCOW_CRS_PROJ4,
      },
    },
    properties: {
      projection: 'Московская СК (МГГТ)',
      proj4: MOSCOW_CRS_PROJ4,
    },
    features: features.map((feature) => ({
      type: 'Feature',
      properties: { ...(feature.properties || {}) },
      geometry: projectGeometry(feature.geometry),
    })),
  };
}

function projectGeometry(geometry) {
  if (geometry.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map(projectRing) };
  }
  if (geometry.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((poly) => poly.map(projectRing)) };
  }
  return geometry;
}

function ringToProjected(coords) {
  const pts = coords.map(projectCoordinate);
  if (pts.length >= 2) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
      pts.pop();
    }
  }
  return pts;
}

function projectRing(coords) {
  return coords.map(projectCoordinate);
}

function projectCoordinate(coord) {
  const [x, y] = dxf.project(coord[0], coord[1]);
  return [roundCoord(x), roundCoord(y)];
}

function roundCoord(value) {
  return Math.round(value * 10000) / 10000;
}

function buildShpZip(features, baseName) {
  const shapes = features.map(featureToShapeRecord).filter(Boolean);
  const files = [
    { name: `${baseName}.shp`, data: buildShp(shapes) },
    { name: `${baseName}.shx`, data: buildShx(shapes) },
    { name: `${baseName}.dbf`, data: buildDbf(shapes) },
    { name: `${baseName}.prj`, data: asBytes(`${MOSCOW_CRS_WKT}\n`) },
    { name: `${baseName}.qpj`, data: asBytes(`${MOSCOW_CRS_WKT}\n`) },
    { name: `${baseName}.proj4.txt`, data: asBytes(`${MOSCOW_CRS_PROJ4}\n`) },
    { name: `${baseName}.cpg`, data: asBytes('UTF-8\n') },
  ];
  return buildZip(files);
}

function featureToShapeRecord(feature) {
  const parts = [];
  forEachPolygon(feature.geometry, (rings) => {
    rings.forEach((ring, index) => {
      const projected = closeRing(projectRing(ring));
      if (projected.length < 4) return;
      parts.push(orientRing(projected, index === 0));
    });
  });
  if (!parts.length) return null;
  return { feature, parts, bbox: partsBounds(parts) };
}

function closeRing(points) {
  if (!points.length) return points;
  const closed = points.slice();
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) {
    closed.push([first[0], first[1]]);
  }
  return closed;
}

function orientRing(points, exterior) {
  const area = ringArea(points);
  const shouldReverse = exterior ? area > 0 : area < 0;
  return shouldReverse ? points.slice().reverse() : points;
}

function ringArea(points) {
  let area = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    area += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
  }
  return area / 2;
}

function partsBounds(parts) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  parts.forEach((part) => part.forEach((point) => extendBounds(bbox, point)));
  return bbox;
}

function shapesBounds(shapes) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  shapes.forEach((shape) => {
    extendBounds(bbox, [shape.bbox[0], shape.bbox[1]]);
    extendBounds(bbox, [shape.bbox[2], shape.bbox[3]]);
  });
  return Number.isFinite(bbox[0]) ? bbox : [0, 0, 0, 0];
}

function extendBounds(bbox, point) {
  if (point[0] < bbox[0]) bbox[0] = point[0];
  if (point[1] < bbox[1]) bbox[1] = point[1];
  if (point[0] > bbox[2]) bbox[2] = point[0];
  if (point[1] > bbox[3]) bbox[3] = point[1];
}

function shapeContentByteLength(shape) {
  const pointCount = shape.parts.reduce((sum, part) => sum + part.length, 0);
  return 4 + 32 + 4 + 4 + shape.parts.length * 4 + pointCount * 16;
}

function buildShp(shapes) {
  const contentLengths = shapes.map(shapeContentByteLength);
  const totalBytes = 100 + contentLengths.reduce((sum, length) => sum + 8 + length, 0);
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  writeShapeHeader(view, totalBytes, 5, shapesBounds(shapes));
  let offset = 100;
  shapes.forEach((shape, index) => {
    const contentLength = contentLengths[index];
    view.setInt32(offset, index + 1, false);
    view.setInt32(offset + 4, contentLength / 2, false);
    writeShapeContent(view, offset + 8, shape);
    offset += 8 + contentLength;
  });
  return new Uint8Array(buffer);
}

function buildShx(shapes) {
  const contentLengths = shapes.map(shapeContentByteLength);
  const totalBytes = 100 + shapes.length * 8;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  writeShapeHeader(view, totalBytes, 5, shapesBounds(shapes));
  let offsetWords = 50;
  let byteOffset = 100;
  shapes.forEach((shape, index) => {
    const contentLengthWords = contentLengths[index] / 2;
    view.setInt32(byteOffset, offsetWords, false);
    view.setInt32(byteOffset + 4, contentLengthWords, false);
    offsetWords += 4 + contentLengthWords;
    byteOffset += 8;
  });
  return new Uint8Array(buffer);
}

function writeShapeHeader(view, byteLength, shapeType, bbox) {
  view.setInt32(0, 9994, false);
  view.setInt32(24, byteLength / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, shapeType, true);
  view.setFloat64(36, bbox[0], true);
  view.setFloat64(44, bbox[1], true);
  view.setFloat64(52, bbox[2], true);
  view.setFloat64(60, bbox[3], true);
}

function writeShapeContent(view, offset, shape) {
  const points = shape.parts.flat();
  view.setInt32(offset, 5, true);
  view.setFloat64(offset + 4, shape.bbox[0], true);
  view.setFloat64(offset + 12, shape.bbox[1], true);
  view.setFloat64(offset + 20, shape.bbox[2], true);
  view.setFloat64(offset + 28, shape.bbox[3], true);
  view.setInt32(offset + 36, shape.parts.length, true);
  view.setInt32(offset + 40, points.length, true);
  let cursor = offset + 44;
  let partStart = 0;
  shape.parts.forEach((part) => {
    view.setInt32(cursor, partStart, true);
    cursor += 4;
    partStart += part.length;
  });
  points.forEach((point) => {
    view.setFloat64(cursor, point[0], true);
    view.setFloat64(cursor + 8, point[1], true);
    cursor += 16;
  });
}

function buildDbf(shapes) {
  const now = new Date();
  const recordCount = shapes.length;
  const headerLength = 32 + DBF_FIELDS.length * 32 + 1;
  const recordLength = 1 + DBF_FIELDS.reduce((sum, field) => sum + field.length, 0);
  const buffer = new ArrayBuffer(headerLength + recordLength * recordCount + 1);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint8(0, 0x03);
  view.setUint8(1, now.getFullYear() - 1900);
  view.setUint8(2, now.getMonth() + 1);
  view.setUint8(3, now.getDate());
  view.setUint32(4, recordCount, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  DBF_FIELDS.forEach((field, index) => writeDbfFieldDescriptor(bytes, 32 + index * 32, field));
  bytes[headerLength - 1] = 0x0D;
  let offset = headerLength;
  shapes.forEach((shape) => {
    bytes[offset] = 0x20;
    let cursor = offset + 1;
    DBF_FIELDS.forEach((field) => {
      bytes.set(dbfFieldBytes(field.value(shape.feature.properties || {}), field), cursor);
      cursor += field.length;
    });
    offset += recordLength;
  });
  bytes[bytes.length - 1] = 0x1A;
  return bytes;
}

function writeDbfFieldDescriptor(bytes, offset, field) {
  const name = textEncoder.encode(field.name.slice(0, 10));
  bytes.set(name, offset);
  bytes[offset + 11] = field.type.charCodeAt(0);
  bytes[offset + 16] = field.length;
  bytes[offset + 17] = field.decimals || 0;
}

function dbfFieldBytes(value, field) {
  if (field.type === 'N') {
    const text = Number.isFinite(Number(value)) ? String(Number(value).toFixed(field.decimals || 0)) : '';
    const bytes = new Uint8Array(field.length).fill(0x20);
    bytes.set(textEncoder.encode(text).slice(0, field.length), Math.max(0, field.length - text.length));
    return bytes;
  }
  return utf8FieldBytes(value, field.length);
}

function utf8FieldBytes(value, length) {
  const out = new Uint8Array(length).fill(0x20);
  let offset = 0;
  for (const char of String(value || '')) {
    const bytes = textEncoder.encode(char);
    if (offset + bytes.length > length) break;
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  files.forEach((file) => {
    const data = file.data instanceof Uint8Array ? file.data : asBytes(file.data);
    const name = asBytes(file.name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime(now), true);
    localView.setUint16(12, dosDate(now), true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime(now), true);
    centralView.setUint16(14, dosDate(now), true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  });
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return concatBytes([...localParts, ...centralParts, end]);
}

function asBytes(value) {
  return value instanceof Uint8Array ? value : textEncoder.encode(String(value));
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

function dosTime(date) {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
}

function dosDate(date) {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();
