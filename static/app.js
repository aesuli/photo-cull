'use strict';

/* ── State ──────────────────────────────────────────────────── */
let imageList  = [];   // [{name, path}, …]
let cols       = 4;
let fitMode    = 'fill';
let infoOverlayVisible = false;
let ratingsOverlayVisible = true;
let exifOverlayVisible = true;
let groupSeparatorsVisible = true;
let dateGroupingInterval = 'day';
let nameGroupingPrefixLength = 1;
let sortMode = 'datetime-asc';
let secondarySortMode = 'name-asc';
let selectedIndexes = new Set();
let activeIndex = -1;
let anchorIndex = -1;
let fullPageIndex = -1;
let fullPageCounterVisible = true;
let keyboardTarget = 'grid';
let imageLoadRequestId = 0;
let imageLoadController = null;
let currentDir = '';
let ratingSelector = null;
let ratingSelectorBackdrop = null;
let ratingSelectorSourceElement = null;

/* ── DOM refs ───────────────────────────────────────────────── */
const grid        = document.getElementById('grid');
const gallery     = document.getElementById('gallery');
const colsInput   = document.getElementById('cols-input');
const fitBtn      = document.getElementById('fit-toggle');
const photoStats  = document.getElementById('photo-stats');
const statsTotal  = document.getElementById('stats-total');
const statsBar    = document.getElementById('stats-bar');
const statsBarWrap = document.getElementById('stats-bar-wrap');
const sortBtn     = document.getElementById('sort-toggle');
const sort2Btn    = document.getElementById('sort2-toggle');
const infoBtn     = document.getElementById('info-toggle');
const ratingBtn   = document.getElementById('rating-toggle');
const groupBtn    = document.getElementById('group-toggle');
const groupDateWrap = document.getElementById('group-date-wrap');
const groupDateIntervalSelect = document.getElementById('group-date-interval');
const groupNameWrap = document.getElementById('group-name-wrap');
const groupNamePrefixInput = document.getElementById('group-name-prefix');
const downloadBtn = document.getElementById('download-btn');
const helpBtn     = document.getElementById('help-toggle');
const sidebarBtn  = document.getElementById('sidebar-toggle');
const themeBtn    = document.getElementById('theme-toggle');
const sidebar     = document.getElementById('sidebar');
const treeRoot    = document.getElementById('tree');
const helpModal   = document.getElementById('help-modal');
const helpCloseBtn = document.getElementById('help-close');
const downloadModal = document.getElementById('download-modal');
const downloadMessage = document.getElementById('download-message');
const downloadKeepWrap = document.getElementById('download-keep-wrap');
const downloadKeepCheckbox = document.getElementById('download-keep-structure');
const downloadCancelBtn = document.getElementById('download-cancel');
const downloadConfirmBtn = document.getElementById('download-confirm');
const fullPageEl      = document.getElementById('fullpage');
const fullPageImg     = document.getElementById('fullpage-img');
const fullPageName    = document.getElementById('fullpage-name');
const fullPageDateTime = document.getElementById('fullpage-datetime');
const fullPageExif    = document.getElementById('fullpage-exif');
const fullPageRating  = document.getElementById('fullpage-rating');
const fullPageCounter = document.getElementById('fullpage-counter');
const fullPageInfo    = document.getElementById('fullpage-info');

const SORT_SEQUENCE = ['name-asc', 'name-desc', 'datetime-asc', 'datetime-desc', 'rating-asc', 'rating-desc'];
const SECONDARY_SORT_SEQUENCE = [...SORT_SEQUENCE];

function updateSortButton() {
  const labelByMode = {
    'name-asc': 'Sort: Name ↑',
    'name-desc': 'Sort: Name ↓',
    'datetime-asc': 'Sort: Date ↑',
    'datetime-desc': 'Sort: Date ↓',
    'rating-asc': 'Sort: Rating ↑',
    'rating-desc': 'Sort: Rating ↓',
  };
  sortBtn.textContent = labelByMode[sortMode] || 'Sort: Name ↑';
}

function updateSecondarySortButton() {
  const labelByMode = {
    'name-asc': 'Then: Name ↑',
    'name-desc': 'Then: Name ↓',
    'datetime-asc': 'Then: Date ↑',
    'datetime-desc': 'Then: Date ↓',
    'rating-asc': 'Then: Rating ↑',
    'rating-desc': 'Then: Rating ↓',
  };
  sort2Btn.textContent = labelByMode[secondarySortMode] || 'Then: Name ↑';
}

function getDateTimeValue(item) {
  if (!item.date || !item.time) return -1;
  const ts = Date.parse(`${item.date}T${item.time}:00`);
  return Number.isNaN(ts) ? -1 : ts;
}

function getRatingValue(item) {
  const n = Number(item.rating);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
}

function compareByName(a, b) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function compareBySortMode(a, b, mode) {
  if (mode === 'name-desc') {
    return compareByName(b, a);
  }

  if (mode === 'datetime-asc') {
    const delta = getDateTimeValue(a) - getDateTimeValue(b);
    if (delta !== 0) return delta;
    return compareByName(a, b);
  }

  if (mode === 'datetime-desc') {
    const delta = getDateTimeValue(b) - getDateTimeValue(a);
    if (delta !== 0) return delta;
    return compareByName(a, b);
  }

  if (mode === 'rating-asc') {
    const delta = getRatingValue(a) - getRatingValue(b);
    if (delta !== 0) return delta;
    return compareByName(a, b);
  }

  if (mode === 'rating-desc') {
    const delta = getRatingValue(b) - getRatingValue(a);
    if (delta !== 0) return delta;
    return compareByName(a, b);
  }

  return compareByName(a, b);
}

function applyCurrentSort() {
  imageList.sort((a, b) => {
    const primary = compareBySortMode(a, b, sortMode);
    if (primary !== 0) return primary;

    const secondary = compareBySortMode(a, b, secondarySortMode);
    if (secondary !== 0) return secondary;

    return compareByName(a, b);
  });
}

function remapSelectionByPaths(selectedPaths, activePath, anchorPath) {
  selectedIndexes.clear();
  imageList.forEach((item, index) => {
    if (selectedPaths.has(item.path)) {
      selectedIndexes.add(index);
    }
  });

  activeIndex = imageList.findIndex((item) => item.path === activePath);
  anchorIndex = imageList.findIndex((item) => item.path === anchorPath);

  if (selectedIndexes.size === 0 && imageList.length > 0) {
    selectedIndexes.add(0);
    activeIndex = 0;
    anchorIndex = 0;
  }
}

function cycleSortMode() {
  const selectedPaths = new Set(getSelectedPaths());
  const activePath = activeIndex >= 0 && activeIndex < imageList.length ? imageList[activeIndex].path : '';
  const anchorPath = anchorIndex >= 0 && anchorIndex < imageList.length ? imageList[anchorIndex].path : '';

  const idx = SORT_SEQUENCE.indexOf(sortMode);
  sortMode = idx === -1 ? SORT_SEQUENCE[0] : SORT_SEQUENCE[(idx + 1) % SORT_SEQUENCE.length];
  updateSortButton();
  updateGroupingOptionControls();

  applyCurrentSort();
  remapSelectionByPaths(selectedPaths, activePath, anchorPath);
  renderGrid();
  if (activeIndex !== -1) keepCellVisible(activeIndex);
}

function cycleSecondarySortMode() {
  const selectedPaths = new Set(getSelectedPaths());
  const activePath = activeIndex >= 0 && activeIndex < imageList.length ? imageList[activeIndex].path : '';
  const anchorPath = anchorIndex >= 0 && anchorIndex < imageList.length ? imageList[anchorIndex].path : '';

  const idx = SECONDARY_SORT_SEQUENCE.indexOf(secondarySortMode);
  secondarySortMode = idx === -1
    ? SECONDARY_SORT_SEQUENCE[0]
    : SECONDARY_SORT_SEQUENCE[(idx + 1) % SECONDARY_SORT_SEQUENCE.length];
  updateSecondarySortButton();

  applyCurrentSort();
  remapSelectionByPaths(selectedPaths, activePath, anchorPath);
  renderGrid();
  if (activeIndex !== -1) keepCellVisible(activeIndex);
}

function setInfoOverlayVisible(visible) {
  infoOverlayVisible = Boolean(visible);
  grid.dataset.showInfo = infoOverlayVisible ? 'true' : 'false';
  infoBtn.textContent = infoOverlayVisible ? 'No Info' : 'Show Info';
  applyFullPageOverlayVisibility();
}

function initInfoOverlay() {
  const saved = localStorage.getItem('showInfoOverlay');
  setInfoOverlayVisible(saved === 'true');
}

function setRatingsOverlayVisible(visible) {
  ratingsOverlayVisible = Boolean(visible);
  grid.dataset.showRatings = ratingsOverlayVisible ? 'true' : 'false';
  ratingBtn.textContent = ratingsOverlayVisible ? 'Hide Ratings' : 'Show Ratings';
  applyFullPageOverlayVisibility();
}

function setExifOverlayVisible(visible) {
  exifOverlayVisible = Boolean(visible);
  grid.dataset.showExif = exifOverlayVisible ? 'true' : 'false';
  applyFullPageOverlayVisibility();
}

function setGroupSeparatorsVisible(visible) {
  groupSeparatorsVisible = Boolean(visible);
  if (groupBtn) {
    groupBtn.textContent = groupSeparatorsVisible ? 'Hide Groups' : 'Show Groups';
  }
}

function initGroupSeparators() {
  const saved = localStorage.getItem('showGroupSeparators');
  setGroupSeparatorsVisible(saved !== 'false');
}

function getPrimarySortKind(mode) {
  if (mode.startsWith('name-')) return 'name';
  if (mode.startsWith('datetime-')) return 'datetime';
  if (mode.startsWith('rating-')) return 'rating';
  return 'name';
}

function setDateGroupingInterval(interval) {
  const allowed = new Set(['year', 'month', 'day', 'hour']);
  dateGroupingInterval = allowed.has(interval) ? interval : 'day';
  if (groupDateIntervalSelect) {
    groupDateIntervalSelect.value = dateGroupingInterval;
  }
}

function setNameGroupingPrefixLength(length) {
  const n = Number.parseInt(length, 10);
  const safe = Number.isInteger(n) ? Math.max(1, Math.min(20, n)) : 1;
  nameGroupingPrefixLength = safe;
  if (groupNamePrefixInput) {
    groupNamePrefixInput.value = String(nameGroupingPrefixLength);
  }
}

function updateGroupingOptionControls() {
  const primaryKind = getPrimarySortKind(sortMode);
  if (groupDateWrap) {
    groupDateWrap.style.display = primaryKind === 'datetime' ? '' : 'none';
  }
  if (groupNameWrap) {
    groupNameWrap.style.display = primaryKind === 'name' ? '' : 'none';
  }
}

function initGroupingOptions() {
  setDateGroupingInterval(localStorage.getItem('dateGroupingInterval') || 'day');
  setNameGroupingPrefixLength(localStorage.getItem('nameGroupingPrefixLength') || '1');
  updateGroupingOptionControls();
}

function applyFullPageOverlayVisibility() {
  const top = fullPageInfo?.querySelector('.cell-info-top');
  const bottom = fullPageInfo?.querySelector('.cell-info-bottom');
  if (top) top.style.display = infoOverlayVisible ? '' : 'none';
  if (bottom) bottom.style.display = ratingsOverlayVisible ? '' : 'none';
  if (fullPageExif) fullPageExif.style.display = exifOverlayVisible ? '' : 'none';
  fullPageCounter.classList.toggle('hidden', !fullPageCounterVisible);
}

function initRatingsOverlay() {
  const saved = localStorage.getItem('showRatingsOverlay');
  setRatingsOverlayVisible(saved === 'true');
}

function initExifOverlay() {
  const saved = localStorage.getItem('showExifOverlay');
  setExifOverlayVisible(saved !== 'false');
}

function setFitMode(mode) {
  fitMode = mode === 'fit' ? 'fit' : 'fill';
  fitBtn.textContent = fitMode === 'fill' ? 'Fit' : 'Fill';
  grid.dataset.fitMode = fitMode;
}

function initFitMode() {
  const savedMode = localStorage.getItem('fitMode');
  setFitMode(savedMode || 'fill');
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  themeBtn.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (systemDark ? 'dark' : 'light');
  applyTheme(theme);
}

function setHelpVisible(visible) {
  helpModal.classList.toggle('hidden', !visible);
}

function toggleHelp() {
  setHelpVisible(helpModal.classList.contains('hidden'));
}

/* ── Intersection Observer – lazy image loading ─────────────── */
const imgObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    img.src     = img.dataset.src;
    img.onload  = () => img.classList.remove('lazy');
    img.onerror = () => img.classList.remove('lazy');
    imgObserver.unobserve(img);
  }
}, { root: gallery, rootMargin: '400px' });

/* ── Grid ───────────────────────────────────────────────────── */
function setColumns(n) {
  cols = Math.max(1, Math.min(20, n));
  colsInput.value = cols;
  grid.style.setProperty('--cols', cols);
}

function fitStatsBarToWidth() {
  if (!statsBar || !statsBarWrap) return;

  statsBar.style.transform = 'none';
  const available = statsBarWrap.clientWidth;
  const needed = statsBar.offsetWidth;
  if (available <= 0 || needed <= 0) return;

  const scale = Math.min(1, available / needed);
  statsBar.style.transform = scale < 0.999 ? `scaleX(${scale})` : 'none';
}

function updatePhotoStats() {
  if (!photoStats) return;

  const counts = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, unrated: 0 };
  for (const item of imageList) {
    const rating = String(item.rating || '').trim();
    if (rating >= '1' && rating <= '5') {
      counts[rating] += 1;
    } else {
      counts.unrated += 1;
    }
  }

  if (statsTotal) statsTotal.textContent = `Total: ${imageList.length}`;

  if (!statsBar) return;
  statsBar.innerHTML = '';

  if (imageList.length === 0) return;

  const segments = [
    { key: 'unrated', label: '∅', className: 'unrated' },
    { key: '1', label: '⭐', className: 'r1' },
    { key: '2', label: '⭐⭐', className: 'r2' },
    { key: '3', label: '⭐⭐⭐', className: 'r3' },
    { key: '4', label: '⭐⭐⭐⭐', className: 'r4' },
    { key: '5', label: '⭐⭐⭐⭐⭐', className: 'r5' },
  ];

  for (const segment of segments) {
    const value = counts[segment.key];
    if (!value) continue;

    const part = document.createElement('span');
    part.className = `stats-segment ${segment.className}`;
    const proportionalWidth = (value / imageList.length) * 100;
    const minChars = `${segment.label} ${value}`.length*2 + 1;
    part.style.flexGrow = String(value);
    part.style.flexShrink = '0';
    part.style.flexBasis = '0';
    part.style.minWidth = `${minChars}ch`;
    part.title = `${segment.label}: ${value}`;
    part.textContent = `${segment.label} ${value}`;
    statsBar.appendChild(part);
  }

  fitStatsBarToWidth();
  window.requestAnimationFrame(fitStatsBarToWidth);
}

function setGridLoading(isLoading) {
  grid.dataset.loading = isLoading ? 'true' : 'false';
}

function renderGrid() {
  imgObserver.disconnect();
  grid.innerHTML = '';
  grid.style.setProperty('--cols', cols);
  grid.dataset.fitMode = fitMode;
  updatePhotoStats();
  setInfoOverlayVisible(infoOverlayVisible);
  setRatingsOverlayVisible(ratingsOverlayVisible);

  if (imageList.length === 0) {
    const msg = document.createElement('p');
    msg.id = 'empty-msg';
    msg.textContent = 'No images in this folder.';
    grid.appendChild(msg);
    return;
  }

  const frag = document.createDocumentFragment();
  const primarySortKind = getPrimarySortKind(sortMode);
  const showGroupSeparators = groupSeparatorsVisible;
  let previousGroupKey = null;

  imageList.forEach((item, index) => {
    const groupInfo = getGroupInfoForItem(item, primarySortKind);
    const currentGroupKey = groupInfo.key;

    if (showGroupSeparators && currentGroupKey !== previousGroupKey) {
      const separator = document.createElement('div');
      separator.className = 'rating-group-separator';

      const label = document.createElement('span');
      label.className = 'rating-group-label';
      label.textContent = groupInfo.label;

      separator.appendChild(label);
      frag.appendChild(separator);
      previousGroupKey = currentGroupKey;
    }

    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.index = String(index);

    const img = document.createElement('img');
    img.dataset.src = `/thumb?path=${encodeURIComponent(item.path)}`;
    img.alt = item.name;
    img.classList.add('lazy');

    const info = document.createElement('div');
    info.className = 'cell-info';

    const top = document.createElement('div');
    top.className = 'cell-info-top';

    const name = document.createElement('span');
    name.className = 'cell-info-chip name';
    name.textContent = item.name;

    const datetime = document.createElement('span');
    datetime.className = 'cell-info-chip datetime';
    datetime.textContent = item.date && item.time ? `${item.date} ${item.time}` : item.date || item.time || '';

    const exif = document.createElement('span');
    exif.className = 'cell-info-chip exif';
    exif.textContent = item.exif || 'no exif info';

    const meta = document.createElement('span');
    meta.className = 'cell-info-meta';
    meta.appendChild(datetime);
    meta.appendChild(exif);

    top.appendChild(name);
    top.appendChild(meta);

    const bottom = document.createElement('div');
    bottom.className = 'cell-info-bottom';

    const stars = document.createElement('span');
    stars.className = 'cell-info-chip rating';
    stars.textContent = ratingToStars(item.rating);
    stars.style.cursor = 'pointer';

    stars.addEventListener('click', (event) => {
      event.stopPropagation();
      openRatingSelector(stars, index);
    });

    bottom.appendChild(stars);
    info.appendChild(top);
    info.appendChild(bottom);

    cell.addEventListener('click', (event) => {
      handleCellSelection(index, event);
    });

    cell.appendChild(img);
    cell.appendChild(info);
    frag.appendChild(cell);
    imgObserver.observe(img);
  });
  grid.appendChild(frag);
  updateSelectionStyles();
}

function ratingToStars(rating) {
  const n = Number(rating);
  if (!Number.isInteger(n) || n < 1 || n > 5) return '🤔';
  return `${'⭐'.repeat(n)}`;
}

function ratingGroupLabelFromValue(value) {
  if (value >= 1 && value <= 5) {
    return `Rating ${'⭐'.repeat(value)}`;
  }
  return 'Rating Unrated';
}

function datetimeGroupInfoFromItem(item) {
  const date = String(item.date || '').trim();
  const time = String(item.time || '').trim();
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const hourMatch = time.match(/^(\d{2})/);

  if (!dateMatch) {
    return { key: `datetime-unknown-${dateGroupingInterval}`, label: 'Date Unknown' };
  }

  const year = dateMatch[1];
  const month = dateMatch[2];
  const day = dateMatch[3];

  if (dateGroupingInterval === 'year') {
    return { key: `datetime-year-${year}`, label: `Date ${year}` };
  }

  if (dateGroupingInterval === 'month') {
    return { key: `datetime-month-${year}-${month}`, label: `Date ${year}-${month}` };
  }

  if (dateGroupingInterval === 'hour') {
    if (!hourMatch) {
      return { key: `datetime-hour-${year}-${month}-${day}-unknown`, label: `Date ${year}-${month}-${day} (hour unknown)` };
    }
    const hour = hourMatch[1];
    return {
      key: `datetime-hour-${year}-${month}-${day}-${hour}`,
      label: `Date ${year}-${month}-${day} ${hour}:00`,
    };
  }

  return { key: `datetime-day-${year}-${month}-${day}`, label: `Date ${year}-${month}-${day}` };
}

function nameGroupInfoFromItem(item) {
  const rawName = String(item.name || '').trim();
  if (!rawName) {
    return { key: 'name-empty', label: 'Name (empty)' };
  }

  const prefix = rawName.slice(0, nameGroupingPrefixLength);
  return {
    key: `name-${prefix.toLocaleLowerCase()}`,
    label: `Name ${prefix}`,
  };
}

function getGroupInfoForItem(item, primarySortKind) {
  if (primarySortKind === 'rating') {
    const rating = getRatingValue(item);
    return {
      key: `rating-${rating}`,
      label: ratingGroupLabelFromValue(rating),
    };
  }

  if (primarySortKind === 'datetime') {
    return datetimeGroupInfoFromItem(item);
  }

  return nameGroupInfoFromItem(item);
}

function getSelectedPaths() {
  return Array.from(selectedIndexes)
    .filter((index) => index >= 0 && index < imageList.length)
    .map((index) => imageList[index].path);
}

function parseDownloadFilename(contentDisposition, fallback) {
  if (!contentDisposition) return fallback;

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      // Ignore malformed encoding and continue with fallback parsing.
    }
  }

  const quotedMatch = contentDisposition.match(/filename="([^"]+)"/i);
  if (quotedMatch && quotedMatch[1]) return quotedMatch[1];

  const plainMatch = contentDisposition.match(/filename=([^;]+)/i);
  if (plainMatch && plainMatch[1]) return plainMatch[1].trim();

  return fallback;
}

async function downloadSelection(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;

  const fallbackName = paths.length === 1
    ? imageList.find((item) => item.path === paths[0])?.name || 'photo'
    : (currentDir && currentDir !== '/'
      ? `files_${currentDir.replace(/^\/+|\/+$/g, '').replace(/[\\/]+/g, '_')}.zip`
      : 'files.zip');

  downloadConfirmBtn.disabled = true;
  downloadConfirmBtn.textContent = 'Downloading...';
  downloadBtn.disabled = true;

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths,
        dir: currentDir,
        keepStructure: paths.length > 1 ? Boolean(downloadKeepCheckbox?.checked) : true,
      }),
    });
    if (!res.ok) throw new Error(res.statusText || 'Download failed');

    const blob = await res.blob();
    const name = parseDownloadFilename(res.headers.get('Content-Disposition'), fallbackName);
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Failed to download selection:', error);
  } finally {
    downloadConfirmBtn.disabled = false;
    downloadConfirmBtn.textContent = 'Download';
    downloadBtn.disabled = false;
  }
}

function setDownloadConfirmVisible(visible) {
  downloadModal.classList.toggle('hidden', !visible);
  if (visible) {
    downloadConfirmBtn.focus();
  }
}

function openDownloadConfirm() {
  const paths = getSelectedPaths();
  if (paths.length === 0) return;

  if (paths.length === 1) {
    const item = imageList.find((img) => img.path === paths[0]);
    const label = item?.name || 'this image';
    downloadMessage.textContent = `Download "${label}"?`;
    if (downloadKeepWrap) downloadKeepWrap.classList.add('hidden');
  } else {
    downloadMessage.textContent = `Download ${paths.length} selected images as ZIP?`;
    if (downloadKeepWrap) downloadKeepWrap.classList.remove('hidden');
    if (downloadKeepCheckbox) downloadKeepCheckbox.checked = true;
  }

  setDownloadConfirmVisible(true);
}

function closeDownloadConfirm() {
  setDownloadConfirmVisible(false);
}

async function confirmDownloadFromModal() {
  const paths = getSelectedPaths();
  closeDownloadConfirm();
  await downloadSelection(paths);
}

async function setRatingForSelection(rating) {
  const paths = getSelectedPaths();
  if (paths.length === 0) return;

  try {
    const res = await fetch('/api/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, rating }),
    });
    if (!res.ok) throw new Error(res.statusText);

    selectedIndexes.forEach((index) => {
      if (index >= 0 && index < imageList.length) {
        imageList[index].rating = rating;
      }
    });

    updatePhotoStats();

    if (sortMode === 'rating-asc' || sortMode === 'rating-desc') {
      const selectedPaths = new Set(getSelectedPaths());
      const activePath = activeIndex >= 0 && activeIndex < imageList.length ? imageList[activeIndex].path : '';
      const anchorPath = anchorIndex >= 0 && anchorIndex < imageList.length ? imageList[anchorIndex].path : '';
      applyCurrentSort();
      remapSelectionByPaths(selectedPaths, activePath, anchorPath);
      renderGrid();
      if (activeIndex !== -1) keepCellVisible(activeIndex);
      return;
    }

    const selectedCells = grid.querySelectorAll('.cell.selected');
    selectedCells.forEach((cell) => {
      const index = Number(cell.dataset.index);
      const ratingNode = cell.querySelector('.cell-info-chip.rating');
      if (!ratingNode || index < 0 || index >= imageList.length) return;
      ratingNode.textContent = ratingToStars(imageList[index].rating);
    });
  } catch (error) {
    console.error('Failed to set rating:', error);
  }
}

/* ── Rating selector popup ──────────────────────────────────── */
function closeRatingSelector() {
  if (ratingSelector && ratingSelector.parentElement) {
    ratingSelector.remove();
  }
  if (ratingSelectorBackdrop && ratingSelectorBackdrop.parentElement) {
    ratingSelectorBackdrop.remove();
  }
  ratingSelector = null;
  ratingSelectorBackdrop = null;
  ratingSelectorSourceElement = null;
}

function openRatingSelector(sourceElement, imageIndex) {
  closeRatingSelector();

  const ratingOptions = [
    { rating: '', label: '🤔 Unrated', key: 'unrated' },
    { rating: '1', label: '⭐ 1 star', key: 'r1' },
    { rating: '2', label: '⭐⭐ 2 stars', key: 'r2' },
    { rating: '3', label: '⭐⭐⭐ 3 stars', key: 'r3' },
    { rating: '4', label: '⭐⭐⭐⭐ 4 stars', key: 'r4' },
    { rating: '5', label: '⭐⭐⭐⭐⭐ 5 stars', key: 'r5' },
  ];

  ratingSelector = document.createElement('div');
  ratingSelector.className = 'rating-selector';

  ratingOptions.forEach((option) => {
    const optionEl = document.createElement('div');
    optionEl.className = 'rating-selector-option';
    optionEl.textContent = option.label;
    optionEl.addEventListener('click', (e) => {
      e.stopPropagation();
      setRatingForIndex(imageIndex, option.rating);
      closeRatingSelector();
    });
    ratingSelector.appendChild(optionEl);
  });

  ratingSelectorBackdrop = document.createElement('div');
  ratingSelectorBackdrop.className = 'rating-selector-backdrop';
  ratingSelectorBackdrop.addEventListener('click', closeRatingSelector);

  document.body.appendChild(ratingSelectorBackdrop);
  document.body.appendChild(ratingSelector);
  ratingSelectorSourceElement = sourceElement;

  // Position the selector with viewport awareness
  const rect = sourceElement.getBoundingClientRect();
  const selectorRect = ratingSelector.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const gap = 4;
  const padding = 8;

  let top = rect.bottom + gap;
  let left = rect.left;

  // If popup would go off-screen bottom, position above instead
  if (top + selectorRect.height > viewportHeight - padding) {
    top = rect.top - selectorRect.height - gap;
  }

  // Keep top within viewport bounds
  if (top < padding) {
    top = padding;
  }

  // Center horizontally on the rating element, but keep within viewport
  left = rect.left + rect.width / 2 - selectorRect.width / 2;
  if (left < padding) {
    left = padding;
  }
  if (left + selectorRect.width > viewportWidth - padding) {
    left = viewportWidth - selectorRect.width - padding;
  }

  ratingSelector.style.left = `${left}px`;
  ratingSelector.style.top = `${top}px`;
}

async function setRatingForIndex(imageIndex, rating) {
  if (imageIndex < 0 || imageIndex >= imageList.length) return;

  const item = imageList[imageIndex];
  const paths = [item.path];

  try {
    const res = await fetch('/api/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, rating }),
    });
    if (!res.ok) throw new Error(res.statusText);

    imageList[imageIndex].rating = rating;
    updatePhotoStats();

    const ratingNode = grid.querySelector(`.cell[data-index="${imageIndex}"] .cell-info-chip.rating`);
    if (ratingNode) {
      ratingNode.textContent = ratingToStars(rating);
    }

    if (fullPageIndex === imageIndex) {
      fullPageRating.textContent = ratingToStars(rating);
    }
  } catch (error) {
    console.error('Failed to set rating for image:', error);
  }
}

function selectOnly(index) {
  selectedIndexes.clear();
  selectedIndexes.add(index);
}

function toggleOrAddSelection(index) {
  if (selectedIndexes.has(index)) {
    selectedIndexes.delete(index);
  } else {
    selectedIndexes.add(index);
  }
}

function addRangeSelection(fromIndex, toIndex) {
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  for (let i = start; i <= end; i += 1) {
    selectedIndexes.add(i);
  }
}

function updateSelectionStyles() {
  const cells = grid.querySelectorAll('.cell');
  cells.forEach((cell) => {
    const index = Number(cell.dataset.index);
    cell.classList.toggle('selected', selectedIndexes.has(index));
    cell.classList.toggle('active', index === activeIndex);
  });
}

function handleCellSelection(index, event) {
  setKeyboardTarget('grid');
  const isCtrlLike = event.ctrlKey || event.metaKey;
  if (event.shiftKey && anchorIndex !== -1) {
    addRangeSelection(anchorIndex, index);
  } else if (isCtrlLike) {
    toggleOrAddSelection(index);
  } else {
    selectOnly(index);
  }

  activeIndex = index;
  anchorIndex = index;
  updateSelectionStyles();
}

function setDefaultSelection() {
  selectedIndexes.clear();
  if (imageList.length > 0) {
    selectedIndexes.add(0);
    activeIndex = 0;
    anchorIndex = 0;
  } else {
    activeIndex = -1;
    anchorIndex = -1;
  }
}

function getArrowTargetIndex(key) {
  if (imageList.length === 0) return -1;
  const base = activeIndex >= 0 ? activeIndex : 0;

  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return imageList.length - 1;
    case 'ArrowLeft':
      return base > 0 ? base - 1 : -1;
    case 'ArrowRight':
      return base < imageList.length - 1 ? base + 1 : -1;
    case 'ArrowUp': {
      const target = base - cols;
      return target >= 0 ? target : -1;
    }
    case 'ArrowDown': {
      const target = base + cols;
      return target < imageList.length ? target : -1;
    }
    default:
      return -1;
  }
}

function keepCellVisible(index) {
  const cell = grid.querySelector(`.cell[data-index="${index}"]`);
  if (!cell) return;
  cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setKeyboardTarget(target) {
  keyboardTarget = target === 'tree' ? 'tree' : 'grid';
  document.body.dataset.keyboardTarget = keyboardTarget;

  if (keyboardTarget === 'tree') {
    const activeRow = treeRoot.querySelector('.tree-row.active') || treeRoot.querySelector('.tree-row');
    if (activeRow) {
      setActiveRow(activeRow);
      activeRow.scrollIntoView({ block: 'nearest' });
    }
    return;
  }

  if (activeIndex !== -1) {
    keepCellVisible(activeIndex);
  }
}

function getVisibleTreeRows() {
  return Array.from(treeRoot.querySelectorAll('.tree-row'))
    .filter((row) => row.getClientRects().length > 0);
}

function getParentTreeRow(row) {
  const node = row.closest('.tree-node');
  if (!node) return null;
  const parentChildren = node.parentElement;
  if (!parentChildren || !parentChildren.classList.contains('tree-children')) return null;
  const parentNode = parentChildren.parentElement;
  if (!parentNode || !parentNode.classList.contains('tree-node')) return null;
  return parentNode.querySelector(':scope > .tree-row');
}

function handleTreeArrowNavigation(key) {
  const visibleRows = getVisibleTreeRows();
  if (visibleRows.length === 0) return false;

  let activeRow = treeRoot.querySelector('.tree-row.active');
  if (!activeRow || !visibleRows.includes(activeRow)) {
    activeRow = visibleRows[0];
    setActiveRow(activeRow);
  }

  const currentIndex = visibleRows.indexOf(activeRow);

  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End') {
    let nextIndex = currentIndex;
    if (key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    if (key === 'ArrowDown') nextIndex = Math.min(visibleRows.length - 1, currentIndex + 1);
    if (key === 'Home') nextIndex = 0;
    if (key === 'End') nextIndex = visibleRows.length - 1;

    const nextRow = visibleRows[nextIndex];
    if (!nextRow) return false;
    setActiveRow(nextRow);
    nextRow.scrollIntoView({ block: 'nearest' });
    nextRow.click();
    return true;
  }

  const toggle = activeRow.querySelector(':scope > .tree-toggle:not(.leaf)');
  if (key === 'ArrowRight') {
    if (toggle && !toggle.classList.contains('open')) {
      toggle.click();
      return true;
    }
    return false;
  }

  if (key === 'ArrowLeft') {
    if (toggle && toggle.classList.contains('open')) {
      toggle.click();
      return true;
    }

    const parentRow = getParentTreeRow(activeRow);
    if (parentRow) {
      setActiveRow(parentRow);
      parentRow.scrollIntoView({ block: 'nearest' });
      parentRow.click();
      return true;
    }
  }

  return false;
}

/* ── Full-page view ─────────────────────────────────────────── */
function updateFullPageBar() {
  if (fullPageIndex < 0 || fullPageIndex >= imageList.length) return;
  const item = imageList[fullPageIndex];
  fullPageName.textContent = item.name;
  fullPageDateTime.textContent = item.date && item.time ? `${item.date} ${item.time}` : item.date || item.time || '';
  fullPageExif.textContent = item.exif || 'no exif info';
  fullPageRating.textContent = ratingToStars(item.rating);
  fullPageCounter.textContent = `${fullPageIndex + 1} / ${imageList.length}`;
}

function openFullPage(index) {
  if (index < 0 || index >= imageList.length) return;
  fullPageIndex = index;
  const item = imageList[index];
  fullPageImg.src = `/photo?path=${encodeURIComponent(item.path)}`;
  fullPageImg.alt = item.name;
  updateFullPageBar();
  applyFullPageOverlayVisibility();
  fullPageEl.classList.remove('hidden');
}

function closeFullPage() {
  closeRatingSelector();
  fullPageEl.classList.add('hidden');
  const returnIndex = fullPageIndex;
  fullPageIndex = -1;
  fullPageImg.src = '';
  if (returnIndex >= 0 && returnIndex < imageList.length) {
    selectedIndexes.clear();
    selectedIndexes.add(returnIndex);
    activeIndex = returnIndex;
    anchorIndex = returnIndex;
    renderGrid();
    keepCellVisible(returnIndex);
  }
}

function fullPageNavigate(delta) {
  const next = fullPageIndex + delta;
  if (next < 0 || next >= imageList.length) return;
  openFullPage(next);
}

async function setRatingForPhoto(index, rating) {
  if (index < 0 || index >= imageList.length) return;
  const item = imageList[index];

  try {
    const res = await fetch('/api/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [item.path], rating }),
    });
    if (!res.ok) throw new Error(res.statusText);

    imageList[index].rating = rating;
    updatePhotoStats();

    if (fullPageIndex === index) {
      updateFullPageBar();
    }

    if (sortMode === 'rating-asc' || sortMode === 'rating-desc') {
      const currentPath = item.path;
      const selectedPaths = new Set(getSelectedPaths());
      const activePath = activeIndex >= 0 && activeIndex < imageList.length ? imageList[activeIndex].path : '';
      const anchorPath = anchorIndex >= 0 && anchorIndex < imageList.length ? imageList[anchorIndex].path : '';
      applyCurrentSort();
      remapSelectionByPaths(selectedPaths, activePath, anchorPath);
      fullPageIndex = imageList.findIndex((i) => i.path === currentPath);
      renderGrid();
      if (activeIndex !== -1) keepCellVisible(activeIndex);
      return;
    }

    const cell = grid.querySelector(`.cell[data-index="${index}"]`);
    if (cell) {
      const ratingNode = cell.querySelector('.cell-info-chip.rating');
      if (ratingNode) ratingNode.textContent = ratingToStars(rating);
    }
  } catch (error) {
    console.error('Failed to set rating:', error);
  }
}

function isNoModifier(event) {
  return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

function isCtrlLikeOnly(event) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

function isShiftOnly(event) {
  return event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function isDownloadModalOpen() {
  return downloadModal && !downloadModal.classList.contains('hidden');
}

document.addEventListener('keydown', (event) => {
  if (isDownloadModalOpen()) return;

  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) return;
  if (event.altKey) return;

  // In full-page view only Left/Right navigate; other keys fall through to grid
  if (fullPageIndex >= 0) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      fullPageNavigate(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      fullPageNavigate(1);
    }
    return;
  }

  if (keyboardTarget === 'tree') {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (handleTreeArrowNavigation(event.key)) {
      event.preventDefault();
    }
    return;
  }

  const nextIndex = getArrowTargetIndex(event.key);
  if (nextIndex === -1) return;

  event.preventDefault();

  const isCtrlLike = event.ctrlKey || event.metaKey;
  if (event.shiftKey && anchorIndex !== -1) {
    addRangeSelection(anchorIndex, nextIndex);
  } else if (isCtrlLike) {
    selectedIndexes.add(nextIndex);
  } else {
    selectOnly(nextIndex);
  }

  activeIndex = nextIndex;
  anchorIndex = nextIndex;
  updateSelectionStyles();
  keepCellVisible(nextIndex);
});

document.addEventListener('keydown', (event) => {
  const editable = event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA');
  if (editable && !isDownloadModalOpen()) return;

  if (isDownloadModalOpen()) {
    if (event.key === 'Escape' && isNoModifier(event)) {
      event.preventDefault();
      closeDownloadConfirm();
      return;
    }

    if (event.key === 'Enter' && isNoModifier(event)) {
      event.preventDefault();
      confirmDownloadFromModal();
      return;
    }

    if (isNoModifier(event) && event.key.toLowerCase() === 'k') {
      if (downloadKeepWrap && !downloadKeepWrap.classList.contains('hidden') && downloadKeepCheckbox) {
        event.preventDefault();
        downloadKeepCheckbox.checked = !downloadKeepCheckbox.checked;
      }
      return;
    }

    // Ignore all unrelated shortcuts while modal is open.
    return;
  }

  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (fullPageIndex >= 0 || !helpModal.classList.contains('hidden')) return;
    event.preventDefault();
    const hasTreeRows = !sidebar.classList.contains('hidden') && treeRoot.querySelector('.tree-row');
    if (!hasTreeRows) {
      setKeyboardTarget('grid');
      return;
    }
    setKeyboardTarget(keyboardTarget === 'grid' ? 'tree' : 'grid');
    return;
  }

  if (event.key === '?' && isShiftOnly(event)) {
    event.preventDefault();
    toggleHelp();
    return;
  }

  if (event.key === 'Escape' && isNoModifier(event)) {
    if (!downloadModal.classList.contains('hidden')) {
      event.preventDefault();
      closeDownloadConfirm();
      return;
    }

    if (fullPageIndex >= 0) {
      event.preventDefault();
      closeFullPage();
      return;
    }
    if (!helpModal.classList.contains('hidden')) {
      event.preventDefault();
      setHelpVisible(false);
    }
    return;
  }

  if (event.key === 'Enter' && isNoModifier(event) && !downloadModal.classList.contains('hidden')) {
    event.preventDefault();
    confirmDownloadFromModal();
    return;
  }

  if (event.key === ' ' && isNoModifier(event)) {
    event.preventDefault();
    if (fullPageIndex >= 0) {
      closeFullPage();
    } else if (activeIndex >= 0) {
      openFullPage(activeIndex);
    }
    return;
  }

  // '+' reduces column count to enlarge thumbnails; '-' increases columns.
  if ((event.key === '+' || event.code === 'NumpadAdd') && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    setColumns(cols - 1);
    return;
  }

  if ((event.key === '-' || event.code === 'NumpadSubtract') && isNoModifier(event)) {
    event.preventDefault();
    setColumns(cols + 1);
    return;
  }

  if (isCtrlLikeOnly(event) && event.key.toLowerCase() === 'a') {
    if (imageList.length === 0) return;
    event.preventDefault();
    selectedIndexes = new Set(imageList.map((_, index) => index));
    if (activeIndex < 0 || activeIndex >= imageList.length) {
      activeIndex = 0;
    }
    anchorIndex = activeIndex;
    updateSelectionStyles();
    keepCellVisible(activeIndex);
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 'i') {
    event.preventDefault();
    setInfoOverlayVisible(!infoOverlayVisible);
    localStorage.setItem('showInfoOverlay', infoOverlayVisible ? 'true' : 'false');
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    setRatingsOverlayVisible(!ratingsOverlayVisible);
    localStorage.setItem('showRatingsOverlay', ratingsOverlayVisible ? 'true' : 'false');
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    setGroupSeparatorsVisible(!groupSeparatorsVisible);
    localStorage.setItem('showGroupSeparators', groupSeparatorsVisible ? 'true' : 'false');
    renderGrid();
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 'x') {
    event.preventDefault();
    setExifOverlayVisible(!exifOverlayVisible);
    localStorage.setItem('showExifOverlay', exifOverlayVisible ? 'true' : 'false');
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 'c') {
    if (fullPageIndex < 0) return;
    event.preventDefault();
    fullPageCounterVisible = !fullPageCounterVisible;
    applyFullPageOverlayVisibility();
    return;
  }

  if (isShiftOnly(event) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    cycleSecondarySortMode();
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    cycleSortMode();
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    const nextMode = fitMode === 'fill' ? 'fit' : 'fill';
    setFitMode(nextMode);
    localStorage.setItem('fitMode', fitMode);
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 't') {
    event.preventDefault();
    const current = document.body.dataset.theme === 'light' ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    toggleSidebarVisibility();
    return;
  }

  if (isNoModifier(event) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    openDownloadConfirm();
    return;
  }

  if (isNoModifier(event) && event.key >= '1' && event.key <= '5') {
    event.preventDefault();
    if (fullPageIndex >= 0) {
      setRatingForPhoto(fullPageIndex, event.key);
    } else {
      setRatingForSelection(event.key);
    }
    return;
  }

  if (isNoModifier(event) && event.key === '6') {
    event.preventDefault();
    if (fullPageIndex >= 0) {
      setRatingForPhoto(fullPageIndex, '');
    } else {
      setRatingForSelection('');
    }
  }
});

infoBtn.addEventListener('click', () => {
  setInfoOverlayVisible(!infoOverlayVisible);
  localStorage.setItem('showInfoOverlay', infoOverlayVisible ? 'true' : 'false');
});

ratingBtn.addEventListener('click', () => {
  setRatingsOverlayVisible(!ratingsOverlayVisible);
  localStorage.setItem('showRatingsOverlay', ratingsOverlayVisible ? 'true' : 'false');
});

groupBtn.addEventListener('click', () => {
  setGroupSeparatorsVisible(!groupSeparatorsVisible);
  localStorage.setItem('showGroupSeparators', groupSeparatorsVisible ? 'true' : 'false');
  renderGrid();
});

groupDateIntervalSelect.addEventListener('change', () => {
  setDateGroupingInterval(groupDateIntervalSelect.value);
  localStorage.setItem('dateGroupingInterval', dateGroupingInterval);
  renderGrid();
});

groupNamePrefixInput.addEventListener('change', () => {
  setNameGroupingPrefixLength(groupNamePrefixInput.value);
  localStorage.setItem('nameGroupingPrefixLength', String(nameGroupingPrefixLength));
  renderGrid();
});

groupNamePrefixInput.addEventListener('input', () => {
  setNameGroupingPrefixLength(groupNamePrefixInput.value);
  localStorage.setItem('nameGroupingPrefixLength', String(nameGroupingPrefixLength));
  renderGrid();
});

downloadBtn.addEventListener('click', () => {
  openDownloadConfirm();
});

downloadCancelBtn.addEventListener('click', () => {
  closeDownloadConfirm();
});

downloadConfirmBtn.addEventListener('click', () => {
  confirmDownloadFromModal();
});

downloadModal.addEventListener('click', (event) => {
  if (event.target === downloadModal) {
    closeDownloadConfirm();
  }
});

sortBtn.addEventListener('click', () => {
  cycleSortMode();
});

sort2Btn.addEventListener('click', () => {
  cycleSecondarySortMode();
});

helpBtn.addEventListener('click', () => {
  toggleHelp();
});

helpCloseBtn.addEventListener('click', () => {
  setHelpVisible(false);
});

helpModal.addEventListener('click', (event) => {
  if (event.target === helpModal) {
    setHelpVisible(false);
  }
});

fullPageRating.addEventListener('click', (event) => {
  if (fullPageIndex >= 0 && fullPageIndex < imageList.length) {
    event.stopPropagation();
    openRatingSelector(fullPageRating, fullPageIndex);
  }
});

/* ── Image loading ──────────────────────────────────────────── */
async function loadImages(dir) {
  currentDir = dir || '';
  imageLoadRequestId += 1;
  const requestId = imageLoadRequestId;
  setGridLoading(true);

  if (imageLoadController) {
    imageLoadController.abort();
  }
  imageLoadController = new AbortController();

  try {
    const res = await fetch(`/api/images?dir=${encodeURIComponent(dir)}`, {
      signal: imageLoadController.signal,
    });
    if (!res.ok) throw new Error(res.statusText);
    if (requestId !== imageLoadRequestId) return;
    imageList = await res.json();
    if (requestId !== imageLoadRequestId) return;
    applyCurrentSort();
  } catch (e) {
    if (requestId !== imageLoadRequestId) return;
    if (e.name === 'AbortError') return;
    imageList = [];
    console.error('Failed to load images:', e);
  }
  if (requestId !== imageLoadRequestId) return;
  setDefaultSelection();
  renderGrid();
  gallery.scrollTop = 0;
  setGridLoading(false);
}

/* ── Directory tree ─────────────────────────────────────────── */
async function fetchTreeChildren(dir) {
  const res = await fetch(`/api/tree?dir=${encodeURIComponent(dir)}`);
  if (!res.ok) return [];
  return res.json();
}

function setActiveRow(row) {
  document.querySelectorAll('.tree-row.active').forEach(r => r.classList.remove('active'));
  row.classList.add('active');
}

function buildTreeNode(item) {
  const node = document.createElement('div');
  node.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle' + (item.hasChildren ? '' : ' leaf');
  toggle.textContent = '\u25b6';   // ▶

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = item.name;

  row.appendChild(toggle);
  row.appendChild(name);
  node.appendChild(row);

  const children = document.createElement('div');
  children.className = 'tree-children';
  node.appendChild(children);

  let loaded = false;

  async function toggleExpand() {
    if (!item.hasChildren) return;
    if (!loaded) {
      loaded = true;
      try {
        const sub = await fetchTreeChildren(item.path);
        for (const child of sub) {
          children.appendChild(buildTreeNode(child));
        }
      } catch (e) {
        console.error('Failed to load tree children:', e);
      }
    }
    const open = children.classList.toggle('open');
    toggle.classList.toggle('open', open);
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExpand();
  });

  row.addEventListener('click', () => {
    setKeyboardTarget('tree');
    setActiveRow(row);
    loadImages(item.path);
  });

  row.addEventListener('dblclick', () => {
    if (!item.hasChildren) return;
    toggleExpand();
  });

  return node;
}

async function initTree() {
  // Root entry (always visible, loads images from base dir)
  const rootRow = document.createElement('div');
  rootRow.className = 'tree-row active';

  const rootIcon = document.createElement('span');
  rootIcon.className = 'tree-toggle leaf';
  rootIcon.textContent = '\u25b6';

  const rootName = document.createElement('span');
  rootName.className = 'tree-name';
  rootName.textContent = '/ (root)';

  rootRow.appendChild(rootIcon);
  rootRow.appendChild(rootName);
  treeRoot.appendChild(rootRow);

  rootRow.addEventListener('click', () => {
    setKeyboardTarget('tree');
    setActiveRow(rootRow);
    loadImages('');
  });

  try {
    const items = await fetchTreeChildren('');
    for (const item of items) {
      treeRoot.appendChild(buildTreeNode(item));
    }
  } catch (e) {
    console.error('Failed to load tree:', e);
  }

  // Load root images on startup
  loadImages('');
}

/* ── Sidebar resize ──────────────────────────────────────────── */
const resizeHandle = document.getElementById('sidebar-resize-handle');
let isResizing = false;
let startX = 0;
let startWidth = 0;
let sidebarWidth = sidebar.offsetWidth || 260;

function applySidebarWidth(width) {
  const maxWidth = Math.floor(window.innerWidth * 0.7);
  const clamped = Math.max(200, Math.min(width, maxWidth));
  sidebarWidth = clamped;
  if (!sidebar.classList.contains('hidden')) {
    sidebar.style.width = clamped + 'px';
  }
}

function toggleSidebarVisibility() {
  const willHide = !sidebar.classList.contains('hidden');
  if (willHide) {
    sidebarWidth = sidebar.offsetWidth || sidebarWidth;
    sidebar.classList.add('hidden');
    sidebar.style.width = '0px';
    if (keyboardTarget === 'tree') {
      setKeyboardTarget('grid');
    }
    return;
  }

  sidebar.classList.remove('hidden');
  applySidebarWidth(sidebarWidth);
}

sidebarBtn.addEventListener('click', () => {
  toggleSidebarVisibility();
});

resizeHandle.addEventListener('mousedown', (e) => {
  if (sidebar.classList.contains('hidden')) return;
  isResizing = true;
  startX = e.clientX;
  startWidth = sidebar.offsetWidth;
  resizeHandle.classList.add('resizing');
  document.body.style.cursor = 'ew-resize';
  document.body.style.userSelect = 'none';
  sidebar.style.transition = 'none';
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const diff = e.clientX - startX;
  applySidebarWidth(startWidth - diff);
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizeHandle.classList.remove('resizing');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  sidebar.style.transition = '';
});

window.addEventListener('resize', () => {
  if (!sidebar.classList.contains('hidden')) {
    applySidebarWidth(sidebarWidth);
  }
});

gallery.addEventListener('click', () => {
  setKeyboardTarget('grid');
});

sidebar.addEventListener('click', () => {
  if (!sidebar.classList.contains('hidden')) {
    setKeyboardTarget('tree');
  }
});

/* ── Theme toggle ───────────────────────────────────────────── */
themeBtn.addEventListener('click', () => {
  const current = document.body.dataset.theme === 'light' ? 'light' : 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('theme', next);
});

/* ── Columns control ────────────────────────────────────────── */
colsInput.addEventListener('change', () => setColumns(parseInt(colsInput.value, 10) || 4));
colsInput.addEventListener('input',  () => setColumns(parseInt(colsInput.value, 10) || 4));

/* ── Fill/Fit control ───────────────────────────────────────── */
fitBtn.addEventListener('click', () => {
  const nextMode = fitMode === 'fill' ? 'fit' : 'fill';
  setFitMode(nextMode);
  localStorage.setItem('fitMode', fitMode);
});

/* ── Init ───────────────────────────────────────────────────── */
initTheme();
initFitMode();
initInfoOverlay();
initRatingsOverlay();
initExifOverlay();
initGroupSeparators();
initGroupingOptions();
updateSortButton();
updateSecondarySortButton();
initTree();
setKeyboardTarget('grid');

window.addEventListener('resize', () => {
  fitStatsBarToWidth();
});
