/**
 * Analytics Module - DuckDB-WASM Integration
 *
 * Features:
 * - Load Parquet data file
 * - Execute SQL queries via DuckDB-WASM (AsyncDuckDB)
 * - Display results in Tabulator
 * - Simple mode for predefined queries
 * - Advanced mode for custom SQL
 *
 * Note: Uses AsyncDuckDB with Web Worker architecture via jsDelivr CDN
 */

// Import DuckDB-WASM from jsDelivr CDN
//（唯一保留的 CDN 依賴：WASM bundle 數 MB，self-host 吃 S3 流量不划算）
import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

// dayjs 復用 tool.js bundle 掛的全域（UTC plugin 已 extend），不再走 CDN
const dayjs = window.dayjs;

// Import API config for Worker URL
import { API_CONFIG } from '../../config.js';

// ============ Configuration ============
const PARQUET_FILE_URL = 'https://sqldata.m-b.win/berry-data.parquet';

// ============ Global State ============
let db = null;           // AsyncDuckDB instance
let conn = null;         // Connection instance
let worker = null;       // Web Worker instance
let resultsTable = null;
let dataLoaded = false;

// ============ UI Elements ============
const UI = {
  // Mode Toggle
  modeSimple: null,
  modeAdvanced: null,
  simpleModePanel: null,
  advancedModePanel: null,

  // Simple Mode
  queryType: null,
  queryParams: null,
  btnRunQuery: null,
  queryErrorAlert: null,
  queryErrorMessage: null,

  // Advanced Mode
  sqlEditor: null,
  btnRunSQL: null,
  exampleQueries: null,

  // Results
  resultsTableDiv: null,
  loadingIndicator: null,
  errorMessage: null,
  resultInfo: null,
  resultCount: null,
  queryTime: null,
  emptyState: null,

  // Actions
  btnExportXLSX: null,
  btnSaveQuery: null,

  // Messages
  messageAlert: null,
  messageIcon: null,
  messageText: null,

  // Saved Queries
  savedQueriesPanel: null,
  savedQueriesList: null,

  // AI Helper
  aiHelperModal: null,
  aiQueryInput: null,
  btnSubmitAiQuery: null,
  aiHelperError: null,
  aiHelperLoading: null,
};

// ============ Query Definitions ============
const QUERY_DEFINITIONS = {
  'song-frequency': {
    name: 'Song Performance Frequency',
    description: 'List all songs with their performance counts',
    params: [
      {
        id: 'dateRange',
        label: 'Date Range / 日期範圍（選填）',
        type: 'daterange',
        required: false,
      },
    ],
    buildSQL: (params) => {
      let sql = `
        SELECT
          songID,
          songName,
          artist,
          COUNT(*) as performanceCount,
          MIN(time) as firstPerformance,
          MAX(time) as lastPerformance
        FROM berry_data
      `;

      const conditions = [];

      console.log('[BuildSQL] params.dateRange:', params.dateRange);

      if (params.dateRange) {
        // params.dateRange format: { start: '2025-12-03', end: '2025-12-04' }
        // berry_data.time 已於建表時轉為本地時區，日期直接比對、不再轉 UTC
        const start = dayjs(params.dateRange.start).startOf('day').format('YYYY-MM-DD HH:mm:ss');
        const end = dayjs(params.dateRange.end).endOf('day').format('YYYY-MM-DD HH:mm:ss');
        console.log('[BuildSQL] Date range (local):', { start, end });
        conditions.push(`time >= '${start}' AND time <= '${end}'`);
      } else {
        console.log('[BuildSQL] No date range provided, skipping WHERE condition');
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      sql += `
        GROUP BY songID, songName, artist
        ORDER BY performanceCount DESC
      `;

      return sql;
    },
    columns: [
      { title: 'Song ID', field: 'songID', width: 100 },
      { title: 'Song Name', field: 'songName', width: 250 },
      { title: 'Artist', field: 'artist', width: 200 },
      { title: 'Performance Count', field: 'performanceCount', width: 150, sorter: 'number' },
      {
        title: `First Performance (${dayjs().format('Z')})`,
        field: 'firstPerformance',
        width: 180,
        mutator: (value) => formatTimestamp(value)
      },
      {
        title: `Last Performance (${dayjs().format('Z')})`,
        field: 'lastPerformance',
        width: 180,
        mutator: (value) => formatTimestamp(value)
      },
    ],
  },

  'top-songs': {
    name: 'Top Songs by Days',
    description: 'Find most popular songs in recent days',
    params: [
      {
        id: 'days',
        label: 'Number of Days',
        type: 'number',
        required: true,
        default: 30,
        min: 1,
        max: 365,
      },
      {
        id: 'limit',
        label: 'Top N Songs',
        type: 'number',
        required: false,
        default: 20,
        min: 1,
        max: 100,
      },
    ],
    buildSQL: (params) => {
      const days = params.days || 30;
      const limit = params.limit || 20;

      // Calculate date range automatically (recent N days)
      // berry_data.time 已是本地時區，直接用本地日期
      const start = dayjs().subtract(days, 'days').startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const end = dayjs().endOf('day').format('YYYY-MM-DD HH:mm:ss');

      return `
        SELECT
          songID,
          songName,
          artist,
          COUNT(*) as performanceCount,
          MAX(time) as lastPerformance
        FROM berry_data
        WHERE time >= '${start}' AND time <= '${end}'
        GROUP BY songID, songName, artist
        ORDER BY performanceCount DESC
        LIMIT ${limit}
      `;
    },
    columns: [
      { title: 'Rank', formatter: 'rownum', width: 80 },
      { title: 'Song Name', field: 'songName', width: 250 },
      { title: 'Artist', field: 'artist', width: 200 },
      { title: 'Performance Count', field: 'performanceCount', width: 150, sorter: 'number' },
      {
        title: `Last Performance (${dayjs().format('Z')})`,
        field: 'lastPerformance',
        width: 180,
        mutator: (value) => formatTimestamp(value)
      },
    ],
  },
};

// ============ Initialization ============

export async function initAnalytics() {
  console.log('[Analytics] Initializing...');

  // Tabulator 已改動態 chunk（tool.js code splitting），結果表建立前先確保載入
  await window.loadTabulator();

  // Initialize UI elements
  initUIElements();

  // Set up event listeners
  setupEventListeners();

  // Initialize DuckDB-WASM
  try {
    await initDuckDB();
    console.log('[Analytics] DuckDB initialized');

    // Load Parquet data
    await loadParquetData();
    console.log('[Analytics] Parquet data loaded');

    dataLoaded = true;
    showMessage('Data loaded successfully!', 'success');
    // Fetch data update time from GitHub
    fetchDataUpdateTime();
  } catch (error) {
    console.error('[Analytics] Initialization failed:', error);
    showError(`Failed to initialize: ${error.message}`);
  }
}

function initUIElements() {
  // Mode Toggle
  UI.modeSimple = document.getElementById('modeSimple');
  UI.modeAdvanced = document.getElementById('modeAdvanced');
  UI.simpleModePanel = document.getElementById('simpleModePanel');
  UI.advancedModePanel = document.getElementById('advancedModePanel');

  // Simple Mode
  UI.queryType = document.getElementById('queryType');
  UI.queryParams = document.getElementById('queryParams');
  UI.btnRunQuery = document.getElementById('btnRunQuery');
  UI.queryErrorAlert = document.getElementById('queryErrorAlert');
  UI.queryErrorMessage = document.getElementById('queryErrorMessage');

  // Advanced Mode
  UI.sqlEditor = document.getElementById('sqlEditor');
  UI.btnRunSQL = document.getElementById('btnRunSQL');
  UI.exampleQueries = document.querySelectorAll('.example-query');

  // Results
  UI.resultsTableDiv = document.getElementById('resultsTable');
  UI.loadingIndicator = document.getElementById('loadingIndicator');
  UI.errorMessage = document.getElementById('errorMessage');
  UI.resultInfo = document.getElementById('resultInfo');
  UI.resultCount = document.getElementById('resultCount');
  UI.queryTime = document.getElementById('queryTime');
  UI.emptyState = document.getElementById('emptyState');

  // Actions
  UI.btnExportXLSX = document.getElementById('btnExportXLSX');
  UI.btnSaveQuery = document.getElementById('btnSaveQuery');

  // Messages
  UI.messageAlert = document.getElementById('messageAlert');
  UI.messageIcon = document.getElementById('messageIcon');
  UI.messageText = document.getElementById('messageText');

  // Saved Queries
  UI.savedQueriesPanel = document.getElementById('savedQueriesPanel');
  UI.savedQueriesList = document.getElementById('savedQueriesList');

  // AI Helper
  UI.aiHelperModal = document.getElementById('aiHelperModal');
  UI.aiQueryInput = document.getElementById('aiQueryInput');
  UI.btnSubmitAiQuery = document.getElementById('btnSubmitAiQuery');
  UI.aiHelperError = document.getElementById('aiHelperError');
  UI.aiHelperLoading = document.getElementById('aiHelperLoading');

  // Timezone Converter
  UI.userTimezone = document.getElementById('userTimezone');
  UI.userTimezoneOffset = document.getElementById('userTimezoneOffset');
  UI.startDateInput = document.getElementById('startDateInput');
  UI.endDateInput = document.getElementById('endDateInput');
  UI.utcRangeOutput = document.getElementById('utcRangeOutput');
  UI.btnInsertRange = document.getElementById('btnInsertRange');
  // Data Update Time
  UI.dataUpdateTime = document.getElementById('dataUpdateTime');

  // Initialize timezone display
  initTimezoneDisplay();

  // Load saved queries
  renderSavedQueries();
}

function setupEventListeners() {
  // Mode Toggle
  UI.modeSimple.addEventListener('change', handleModeChange);
  UI.modeAdvanced.addEventListener('change', handleModeChange);

  // Simple Mode
  UI.queryType.addEventListener('change', handleQueryTypeChange);
  UI.btnRunQuery.addEventListener('click', handleRunQuery);

  // Advanced Mode
  UI.btnRunSQL.addEventListener('click', handleRunSQL);

  // 活範例：帶字面本地日期（time 已是當地時區），使用者點開即見可模仿的日期寫法
  const thisYearBtn = document.getElementById('exampleThisYear');
  if (thisYearBtn) {
    thisYearBtn.dataset.query = `SELECT songName, artist, COUNT(*) as c FROM berry_data WHERE time >= '${dayjs().startOf('year').format('YYYY-MM-DD')}' GROUP BY songName, artist ORDER BY c DESC LIMIT 10`;
  }
  const last30dBtn = document.getElementById('exampleLast30d');
  if (last30dBtn) {
    last30dBtn.dataset.query = `SELECT songName, artist, time FROM berry_data WHERE time >= '${dayjs().subtract(30, 'days').format('YYYY-MM-DD')}' ORDER BY time DESC`;
  }

  UI.exampleQueries.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const query = e.currentTarget.dataset.query;
      UI.sqlEditor.value = query;
    });
  });

  // Export
  UI.btnExportXLSX.addEventListener('click', handleExportXLSX);
  UI.btnSaveQuery.addEventListener('click', handleSaveQuery);

  // AI Helper
  if (UI.btnSubmitAiQuery) {
    UI.btnSubmitAiQuery.addEventListener('click', handleAiQuery);
    UI.aiQueryInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAiQuery();
    });
    // Clear error when modal is shown
    UI.aiHelperModal?.addEventListener('shown.bs.modal', () => {
      UI.aiHelperError.classList.add('d-none');
      UI.aiQueryInput.value = '';
      UI.aiQueryInput.focus();
    });
  }

  // Timezone Converter (Date Range)
  UI.startDateInput.addEventListener('input', handleDateRangeChange);
  UI.endDateInput.addEventListener('input', handleDateRangeChange);
  UI.btnInsertRange.addEventListener('click', handleInsertRange);

  // Column Insert Buttons (clickable column names)
  document.querySelectorAll('.column-insert').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const columnName = e.currentTarget.dataset.column;
      insertAtCursor(UI.sqlEditor, columnName);
      console.log('[Column] Inserted column name:', columnName);
    });
  });

  // Initialize Bootstrap tooltips (use window.bootstrap for ES module scope)
  // container: 'body' ensures proper positioning
  const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
  tooltipTriggerList.forEach(el => new window.bootstrap.Tooltip(el, { container: 'body' }));
}

// ============ DuckDB-WASM Initialization ============

async function initDuckDB() {
  console.log('[DuckDB] Initializing...');

  try {
    // Select appropriate bundle (MVP, EH, or COI based on browser capabilities)
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    console.log('[DuckDB] Selected bundle:', bundle.mainModule);

    // Create Web Worker
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );
    worker = new Worker(workerUrl);

    // Create logger (optional - can use console logger)
    const logger = new duckdb.ConsoleLogger();

    // Create AsyncDuckDB instance
    db = new duckdb.AsyncDuckDB(logger, worker);

    // Instantiate the database with the selected bundle
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    // Create a connection
    conn = await db.connect();

    console.log('[DuckDB] Initialized successfully (AsyncDuckDB)');
  } catch (error) {
    console.error('[DuckDB] Initialization failed:', error);
    throw new Error(`DuckDB initialization failed: ${error.message}`);
  }
}

// ============ Data Loading ============

async function loadParquetData() {
  console.log('[Data] Loading Parquet file:', PARQUET_FILE_URL);

  try {
    showLoading(true);

    // Fetch Parquet file
    const response = await fetch(PARQUET_FILE_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch Parquet file: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    console.log(`[Data] Fetched ${arrayBuffer.byteLength} bytes`);

    // Register the Parquet file in DuckDB (AsyncDuckDB API)
    await db.registerFileBuffer('berry-data.parquet', new Uint8Array(arrayBuffer));

    // Create a table from the Parquet file (async query)
    // Parquet 的 time 為 UTC（MariaDB UTC+0）。建表時直接 shift 成瀏覽器時區，
    // 讓使用者與 AI 寫 SQL 時 time 就是當地時間（WHERE time >= '2026-01-01' 即本地 1/1），
    // 不再需要任何 UTC 轉換。註：位移量取「現在」的 offset，台灣/日本無 DST 完全準確。
    const tzOffsetMinutes = -new Date().getTimezoneOffset(); // 台灣 = +480
    await conn.query(`
      CREATE OR REPLACE TABLE berry_data AS
      SELECT * REPLACE (time + INTERVAL '${tzOffsetMinutes}' MINUTE AS time)
      FROM read_parquet('berry-data.parquet')
    `);

    // Verify data loaded (async query)
    const result = await conn.query('SELECT COUNT(*) as count FROM berry_data');
    const count = result.toArray()[0].count;
    console.log(`[Data] Loaded ${count} records`);

    // Log column names for debugging
    const schema = await conn.query('DESCRIBE berry_data');
    console.log('[Data] Columns:', schema.toArray().map(r => r.column_name));

    showLoading(false);
  } catch (error) {
    showLoading(false);
    console.error('[Data] Loading failed:', error);
    throw new Error(`Failed to load Parquet data: ${error.message}`);
  }
}

// ============ UI Handlers ============

function handleModeChange(e) {
  const mode = e.target.value;

  if (mode === 'simple') {
    UI.simpleModePanel.style.display = 'block';
    UI.advancedModePanel.style.display = 'none';
  } else {
    UI.simpleModePanel.style.display = 'none';
    UI.advancedModePanel.style.display = 'block';

    // Pre-fill SQL editor with default query if empty
    if (!UI.sqlEditor.value.trim()) {
      UI.sqlEditor.value = 'SELECT * FROM berry_data';
    }
  }
}

function handleQueryTypeChange(e) {
  const queryType = e.target.value;

  if (!queryType) {
    UI.queryParams.innerHTML = '';
    UI.btnRunQuery.disabled = true;
    return;
  }

  const queryDef = QUERY_DEFINITIONS[queryType];
  if (!queryDef) {
    console.error('Unknown query type:', queryType);
    return;
  }

  // Build parameter inputs
  let paramsHTML = '';
  queryDef.params.forEach(param => {
    if (param.type === 'daterange') {
      // Special handling for date range
      paramsHTML += `
        <div class="mb-3">
          <label class="form-label">
            ${param.label}
            ${param.required ? '<span class="text-danger">*</span>' : ''}
          </label>
          <div class="row g-2">
            <div class="col-6">
              <input type="date"
                     id="param_${param.id}_start"
                     class="form-control query-param-daterange"
                     data-param-id="${param.id}"
                     data-range-part="start"
                     placeholder="Start date"
                     ${param.required ? 'required' : ''}>
            </div>
            <div class="col-6">
              <input type="date"
                     id="param_${param.id}_end"
                     class="form-control query-param-daterange"
                     data-param-id="${param.id}"
                     data-range-part="end"
                     placeholder="End date"
                     ${param.required ? 'required' : ''}>
            </div>
          </div>
        </div>
      `;
    } else {
      // Standard input types
      paramsHTML += `
        <div class="mb-3">
          <label for="param_${param.id}" class="form-label">
            ${param.label}
            ${param.required ? '<span class="text-danger">*</span>' : ''}
          </label>
          <input type="${param.type}"
                 id="param_${param.id}"
                 class="form-control query-param"
                 ${param.required ? 'required' : ''}
                 ${param.default !== undefined ? `value="${param.default}"` : ''}
                 ${param.min !== undefined ? `min="${param.min}"` : ''}
                 ${param.max !== undefined ? `max="${param.max}"` : ''}>
        </div>
      `;
    }
  });

  UI.queryParams.innerHTML = paramsHTML;
  UI.btnRunQuery.disabled = false;
}

async function handleRunQuery() {
  const queryType = UI.queryType.value;
  if (!queryType || !dataLoaded) return;

  const queryDef = QUERY_DEFINITIONS[queryType];

  // Hide previous error
  hideQueryError();

  // Collect parameters and validate
  const params = {};
  const validationErrors = [];

  for (const param of queryDef.params) {
    if (param.type === 'daterange') {
      // Special handling for date range parameters
      const startInput = document.getElementById(`param_${param.id}_start`);
      const endInput = document.getElementById(`param_${param.id}_end`);
      console.log('[Query] Date range inputs:', {
        paramId: param.id,
        startValue: startInput?.value,
        endValue: endInput?.value,
        startExists: !!startInput,
        endExists: !!endInput,
        startValid: startInput?.validity.valid,
        endValid: endInput?.validity.valid
      });

      // Accumulate all validation errors instead of stopping at first error

      // Check input validity first (detect invalid input even if value is empty)
      if (startInput && !startInput.validity.valid) {
        validationErrors.push('開始日期格式無效 / Start date format is invalid');
      }
      if (endInput && !endInput.validity.valid) {
        validationErrors.push('結束日期格式無效 / End date format is invalid');
      }

      // Check if both dates are provided
      if (startInput && startInput.value && endInput && endInput.value) {
        // Validate date logic: start date should not be after end date
        const startDate = new Date(startInput.value);
        const endDate = new Date(endInput.value);

        if (startDate > endDate) {
          validationErrors.push('開始日期不能晚於結束日期 / Start date cannot be after end date');
        }

        // Only set params if no errors so far
        if (validationErrors.length === 0) {
          params[param.id] = {
            start: startInput.value,
            end: endInput.value,
          };
          console.log('[Query] Date range params set:', params[param.id]);
        }
      } else if (startInput && startInput.value && endInput && !endInput.value) {
        // Start date filled but end date empty (possibly invalid date)
        if (!validationErrors.some(err => err.includes('結束日期'))) {
          validationErrors.push('結束日期無效或未填寫 / End date is empty or invalid');
        }
      } else if (startInput && !startInput.value && endInput && endInput.value) {
        // End date filled but start date empty
        if (!validationErrors.some(err => err.includes('開始日期'))) {
          validationErrors.push('開始日期無效或未填寫 / Start date is empty or invalid');
        }
      } else {
        console.log('[Query] Date range params NOT set (both empty, optional)');
      }
    } else {
      // Standard parameters
      const input = document.getElementById(`param_${param.id}`);
      if (input && input.value) {
        params[param.id] = input.value;
      }
    }
  }

  // Stop if validation failed - show all errors at once
  if (validationErrors.length > 0) {
    console.warn('[Query] Validation failed:', validationErrors);
    const errorMessage = validationErrors.map((err, index) => `${index + 1}. ${err}`).join('<br>');
    showQueryError(errorMessage);
    return;
  }

  // Build SQL
  const sql = queryDef.buildSQL(params);
  console.log('[Query] Executing:', sql);

  // Execute query
  await executeQuery(sql, queryDef.columns);
}

// 呼叫 text-to-sql API（retryContext 帶上一次失敗的 SQL 與錯誤訊息時，AI 會修正重出）
async function fetchAiSQL(query, retryContext = null) {
  const response = await fetch(`${API_CONFIG.BASE_URL}/api/text-to-sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      localDate: dayjs().format('YYYY-MM-DD'),  // 使用者本地日期，供 AI 計算「今年/上個月」等相對時間
      ...(retryContext ? { failedSql: retryContext.sql, errorMessage: retryContext.error } : {})
    })
  });
  return response.json();
}

async function handleAiQuery() {
  const query = UI.aiQueryInput.value.trim();
  if (!query) return;

  // 資料未載入完成時 conn 尚為 null，直接執行會誤判為 SQL 錯誤並白燒一次 AI 修復
  if (!dataLoaded) {
    UI.aiHelperError.textContent = '資料載入中，請稍候再試';
    UI.aiHelperError.classList.remove('d-none');
    return;
  }

  // Show loading, hide error
  UI.aiHelperLoading.classList.remove('d-none');
  UI.aiHelperError.classList.add('d-none');
  UI.btnSubmitAiQuery.disabled = true;

  try {
    let data = await fetchAiSQL(query);
    if (!data.success) {
      UI.aiHelperError.textContent = data.error || '生成失敗';
      UI.aiHelperError.classList.remove('d-none');
      return;
    }

    let sql = data.sql;
    // Fill SQL editor with generated SQL
    UI.sqlEditor.value = sql;
    // Close modal
    const modal = window.bootstrap.Modal.getInstance(UI.aiHelperModal);
    modal?.hide();

    // 直接執行並顯示（單次執行）；失敗時帶錯誤請 AI 修一次再執行
    let run = await executeQuery(sql, null);
    if (!run.ok) {
      console.warn('[AI] 生成的 SQL 執行失敗，自動修復中:', run.error);
      const retryData = await fetchAiSQL(query, { sql, error: run.error });
      // AI 回傳相同 SQL 時重跑注定同錯，直接跳過
      if (retryData.success && retryData.sql !== sql) {
        const retryRun = await executeQuery(retryData.sql, null);
        if (retryRun.ok) {
          sql = retryData.sql;
          UI.sqlEditor.value = sql;
          run = retryRun;
          console.log('[AI] 修復成功');
        }
      }
    }

    if (run.ok) {
      showMessage('SQL 已生成並執行完成', 'success');
    } else {
      // 兩次都失敗：SQL 已在編輯器中（executeQuery 已顯示錯誤詳情），提示使用者手動調整
      showMessage(`AI 生成的 SQL 執行失敗（已嘗試自動修復）：${run.error}`, 'warning');
    }
    console.log('[AI] Generated SQL:', sql);
  } catch (error) {
    console.error('[AI] Error:', error);
    UI.aiHelperError.textContent = '連線失敗，請稍後再試';
    UI.aiHelperError.classList.remove('d-none');
  } finally {
    UI.aiHelperLoading.classList.add('d-none');
    UI.btnSubmitAiQuery.disabled = false;
  }
}

async function handleRunSQL() {
  const sql = UI.sqlEditor.value.trim();
  if (!sql || !dataLoaded) return;

  console.log('[Query] Executing custom SQL:', sql);

  // Execute query with auto-detected columns
  await executeQuery(sql, null);
}

// ============ Query Execution ============

async function executeQuery(sql, predefinedColumns = null) {
  try {
    showLoading(true);
    hideError();
    UI.emptyState.style.display = 'none';

    const startTime = performance.now();

    // Execute query (async API returns Apache Arrow Table)
    const arrowTable = await conn.query(sql);

    // Convert Arrow Table to JavaScript array of objects
    const data = arrowTable.toArray().map(row => {
      const obj = {};
      arrowTable.schema.fields.forEach((field) => {
        obj[field.name] = row[field.name];
      });
      return obj;
    });

    const endTime = performance.now();
    const queryTime = Math.round(endTime - startTime);

    console.log(`[Query] Returned ${data.length} rows in ${queryTime}ms`);

    // Debug: Log first row's time value for timezone debugging
    if (data.length > 0 && data[0].time !== undefined) {
      console.log('[Query] First row time value:', {
        raw: data[0].time,
        type: typeof data[0].time,
        formatted: formatTimestamp(data[0].time)
      });
    }

    // Define columns
    let columns;
    if (predefinedColumns) {
      columns = predefinedColumns;
    } else {
      // Auto-detect columns from Arrow schema
      if (arrowTable.schema.fields.length > 0) {
        columns = arrowTable.schema.fields.map(field => {
          const column = {
            title: field.name,
            field: field.name,
          };

          // Auto-format timestamp columns (using mutator for proper timezone conversion)
          if (field.name === 'time' || field.name.toLowerCase().includes('time') ||
              field.name.toLowerCase().includes('performance') ||
              field.name.toLowerCase().includes('date')) {
            column.title = `${field.name} (${dayjs().format('Z')})`;
            column.mutator = (value) => formatTimestamp(value);
          }

          return column;
        });
      } else {
        columns = [];
      }
    }

    // Display results
    displayResults(data, columns, queryTime);

    showLoading(false);
    return { ok: true };
  } catch (error) {
    showLoading(false);
    console.error('[Query] Execution failed:', error);
    showError(`Query failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

function displayResults(data, columns, queryTime) {
  // Destroy existing table
  if (resultsTable) {
    resultsTable.destroy();
    resultsTable = null;
  }

  // Update result info
  UI.resultCount.textContent = data.length;
  UI.queryTime.textContent = queryTime;
  UI.resultInfo.style.display = 'block';

  // Enable export buttons
  UI.btnExportXLSX.disabled = data.length === 0;
  UI.btnSaveQuery.disabled = false;

  // Create new Tabulator table
  resultsTable = new Tabulator(UI.resultsTableDiv, {
    data: data,
    columns: columns,
    layout: 'fitData',  // Fit to data for better visibility with many columns
    pagination: true,
    paginationSize: 50,
    paginationSizeSelector: [20, 50, 100, 200],
    movableColumns: true,
    resizableColumns: true,
    initialSort: [],  // No default sorting - respect SQL ORDER BY
  });
}

// ============ Helper: Format Timestamp ============
// Time Zone Handling:
// - berry_data.time 已於建表時 shift 成瀏覽器時區（見 loadParquetData），
//   查詢結果的 timestamp 即本地牆鐘時間
// - 因此這裡用 dayjs.utc() 解析（不再 .local() 位移），format 輸出的就是本地時間

function formatTimestamp(value) {
  if (!value) return '';

  try {
    let timestamp;

    // Handle BigInt (Apache Arrow TIMESTAMP in microseconds since Unix epoch)
    if (typeof value === 'bigint') {
      // DuckDB/Apache Arrow TIMESTAMP is in microseconds
      // Convert microseconds to milliseconds for dayjs
      const ms = Number(value) / 1000;
      timestamp = dayjs.utc(ms);

      // Debug: log if timestamp seems wrong (year < 1970 or > 2100)
      if (timestamp.year() < 1970 || timestamp.year() > 2100) {
        console.warn('[Format] Suspicious timestamp:', value, 'Converted to:', timestamp.format());
      }
    }
    // Handle number (milliseconds or seconds)
    else if (typeof value === 'number') {
      // Check if this looks like seconds or milliseconds
      if (value < 10000000000) {
        // Likely seconds, convert to milliseconds
        timestamp = dayjs.utc(value * 1000);
      } else {
        // Likely milliseconds
        timestamp = dayjs.utc(value);
      }
    }
    // Handle string or Date object - parse as UTC then convert to local
    else {
      timestamp = dayjs.utc(value);
    }

    // Verify timestamp is valid
    if (!timestamp.isValid()) {
      console.error('[Format] Invalid timestamp from value:', value);
      return String(value);
    }

    // Format using dayjs (now in local timezone)
    // Same format as streamlist: YYYY/MM/DD HH:mm
    return timestamp.format('YYYY/MM/DD HH:mm');
  } catch (error) {
    console.error('[Format] Timestamp formatting failed:', error, 'Value:', value, 'Type:', typeof value);
    return String(value);
  }
}

// ============ Export ============

function handleExportXLSX() {
  if (!resultsTable) return;

  try {
    // Get data from Tabulator
    const data = resultsTable.getData();

    if (data.length === 0) {
      showMessage('沒有資料可匯出<br>No data to export', 'warning');
      return;
    }

    // Create worksheet from data
    const ws = window.XLSX.utils.json_to_sheet(data);

    // Create workbook
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Query Results');

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `berry-analytics-${timestamp}.xlsx`;

    // Download file
    window.XLSX.writeFile(wb, filename);

    console.log('[Export] XLSX exported successfully:', filename);
    showMessage(`成功匯出檔案：<code>${filename}</code><br>File exported successfully`, 'success');
  } catch (error) {
    console.error('[Export] XLSX export failed:', error);
    showMessage(`匯出失敗 / Export failed<br><small>${error.message}</small>`, 'error');
  }
}

function handleSaveQuery() {
  try {
    // 判斷當前模式
    const isSimpleMode = UI.modeSimple.checked;

    // 收集查詢資料
    let queryData = {
      id: Date.now(),
      mode: isSimpleMode ? 'simple' : 'advanced',
      createdAt: new Date().toISOString(),
    };

    if (isSimpleMode) {
      // Simple Mode: 儲存查詢類型和參數
      const queryType = UI.queryType.value;
      if (!queryType) {
        showMessage('請先選擇查詢類型<br>Please select a query type first', 'warning');
        return;
      }

      queryData.queryType = queryType;
      queryData.queryName = QUERY_DEFINITIONS[queryType].name;

      // 收集參數
      const queryDef = QUERY_DEFINITIONS[queryType];
      const params = {};

      for (const param of queryDef.params) {
        if (param.type === 'daterange') {
          const startInput = document.getElementById(`param_${param.id}_start`);
          const endInput = document.getElementById(`param_${param.id}_end`);
          if (startInput?.value && endInput?.value) {
            params[param.id] = {
              start: startInput.value,
              end: endInput.value,
            };
          }
        } else {
          const input = document.getElementById(`param_${param.id}`);
          if (input?.value) {
            params[param.id] = input.value;
          }
        }
      }

      queryData.params = params;
    } else {
      // Advanced Mode: 儲存 SQL
      const sql = UI.sqlEditor.value.trim();
      if (!sql) {
        showMessage('請先輸入 SQL 查詢<br>Please enter a SQL query first', 'warning');
        return;
      }

      queryData.sql = sql;
      queryData.queryName = sql.substring(0, 50) + (sql.length > 50 ? '...' : '');
    }

    // 提示使用者輸入查詢名稱
    const customName = prompt('輸入查詢名稱 / Enter query name:', queryData.queryName);
    if (customName === null) {
      // 使用者取消
      return;
    }

    if (customName.trim()) {
      queryData.name = customName.trim();
    } else {
      queryData.name = queryData.queryName;
    }

    // 儲存到 localStorage
    const savedQueries = getSavedQueries();
    savedQueries.push(queryData);
    localStorage.setItem('berry_analytics_queries', JSON.stringify(savedQueries));

    console.log('[Save] Query saved:', queryData);
    showMessage(`成功儲存查詢：<strong>${queryData.name}</strong><br>Query saved successfully`, 'success');

    // 更新已儲存查詢列表
    renderSavedQueries();
  } catch (error) {
    console.error('[Save] Failed to save query:', error);
    showMessage(`儲存失敗 / Save failed<br><small>${error.message}</small>`, 'error');
  }
}

/**
 * 從 localStorage 載入已儲存的查詢
 */
function getSavedQueries() {
  try {
    const saved = localStorage.getItem('berry_analytics_queries');
    return saved ? JSON.parse(saved) : [];
  } catch (error) {
    console.error('[Save] Failed to load saved queries:', error);
    return [];
  }
}

/**
 * 渲染已儲存的查詢列表
 */
function renderSavedQueries() {
  if (!UI.savedQueriesPanel || !UI.savedQueriesList) return;

  const savedQueries = getSavedQueries();

  if (savedQueries.length === 0) {
    // 沒有已儲存的查詢，隱藏面板
    UI.savedQueriesPanel.style.display = 'none';
    return;
  }

  // 顯示面板
  UI.savedQueriesPanel.style.display = 'block';

  // 渲染查詢列表
  let html = '';
  savedQueries.forEach((query, index) => {
    const createdDate = new Date(query.createdAt).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    html += `
      <div class="list-group-item">
        <div class="d-flex justify-content-between align-items-start">
          <div class="flex-grow-1">
            <h6 class="mb-1">
              <i class="bi ${query.mode === 'simple' ? 'bi-lightning-fill' : 'bi-code-slash'} me-2"></i>
              ${query.name}
            </h6>
            <small class="text-muted">
              ${createdDate}
              ${query.mode === 'simple' ? `· ${query.queryName}` : ''}
            </small>
          </div>
          <div class="btn-group">
            <button class="btn btn-sm btn-outline-primary load-query" data-index="${index}" title="載入查詢">
              <i class="bi bi-play-circle"></i>
            </button>
            <button class="btn btn-sm btn-outline-danger delete-query" data-index="${index}" title="刪除查詢">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  });

  UI.savedQueriesList.innerHTML = html;

  // 綁定事件監聽器
  document.querySelectorAll('.load-query').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.currentTarget.dataset.index);
      loadSavedQuery(index);
    });
  });

  document.querySelectorAll('.delete-query').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.currentTarget.dataset.index);
      deleteSavedQuery(index);
    });
  });
}

/**
 * 載入已儲存的查詢
 */
function loadSavedQuery(index) {
  try {
    const savedQueries = getSavedQueries();
    const query = savedQueries[index];

    if (!query) {
      showMessage('查詢不存在<br>Query not found', 'error');
      return;
    }

    console.log('[Load] Loading saved query:', query);

    if (query.mode === 'simple') {
      // 切換到 Simple Mode
      UI.modeSimple.checked = true;
      handleModeChange({ target: UI.modeSimple });

      // 設定查詢類型
      UI.queryType.value = query.queryType;
      handleQueryTypeChange({ target: UI.queryType });

      // 等待參數表單渲染後，填入參數並執行查詢
      setTimeout(() => {
        for (const [paramId, paramValue] of Object.entries(query.params || {})) {
          if (typeof paramValue === 'object' && paramValue.start && paramValue.end) {
            // Date range parameter
            const startInput = document.getElementById(`param_${paramId}_start`);
            const endInput = document.getElementById(`param_${paramId}_end`);
            if (startInput) startInput.value = paramValue.start;
            if (endInput) endInput.value = paramValue.end;
          } else {
            // Standard parameter
            const input = document.getElementById(`param_${paramId}`);
            if (input) input.value = paramValue;
          }
        }

        // 自動執行查詢
        showMessage(`成功載入查詢：<strong>${query.name}</strong><br>正在執行查詢...<br>Query loaded successfully, executing...`, 'info');
        setTimeout(() => handleRunQuery(), 100);
      }, 100);
    } else {
      // 切換到 Advanced Mode
      UI.modeAdvanced.checked = true;
      handleModeChange({ target: UI.modeAdvanced });

      // 設定 SQL
      UI.sqlEditor.value = query.sql;

      // 自動執行查詢
      showMessage(`成功載入查詢：<strong>${query.name}</strong><br>正在執行查詢...<br>Query loaded successfully, executing...`, 'info');
      setTimeout(() => handleRunSQL(), 100);
    }
  } catch (error) {
    console.error('[Load] Failed to load query:', error);
    showMessage(`載入失敗 / Load failed<br><small>${error.message}</small>`, 'error');
  }
}

/**
 * 刪除已儲存的查詢
 */
function deleteSavedQuery(index) {
  try {
    const savedQueries = getSavedQueries();
    const query = savedQueries[index];

    if (!query) {
      showMessage('查詢不存在<br>Query not found', 'error');
      return;
    }

    // 確認刪除
    if (!confirm(`確定要刪除查詢「${query.name}」嗎？\n\nDelete query "${query.name}"?`)) {
      return;
    }

    // 從陣列中移除
    savedQueries.splice(index, 1);

    // 更新 localStorage
    localStorage.setItem('berry_analytics_queries', JSON.stringify(savedQueries));

    console.log('[Delete] Query deleted:', query);
    showMessage(`成功刪除查詢：<strong>${query.name}</strong><br>Query deleted successfully`, 'success');

    // 重新渲染列表
    renderSavedQueries();
  } catch (error) {
    console.error('[Delete] Failed to delete query:', error);
    showMessage(`刪除失敗 / Delete failed<br><small>${error.message}</small>`, 'error');
  }
}

// ============ Data Update Time ============

async function fetchDataUpdateTime() {
  try {
    // Use HEAD request to get Last-Modified from R2
    const response = await fetch(PARQUET_FILE_URL, { method: 'HEAD' });
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }
    const lastModified = response.headers.get('Last-Modified');
    if (lastModified) {
      const localDate = dayjs(lastModified).format('YYYY-MM-DD HH:mm');
      UI.dataUpdateTime.textContent = localDate;
      console.log('[Analytics] Data last updated:', localDate);
    } else {
      UI.dataUpdateTime.textContent = '無資料';
    }
  } catch (error) {
    console.warn('[Analytics] Failed to fetch data update time:', error);
    UI.dataUpdateTime.textContent = '載入失敗';
  }
}


// ============ Timezone Converter ============

function initTimezoneDisplay() {
  try {
    // Get user's timezone
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    UI.userTimezone.textContent = timezone || 'Unknown';

    // Get UTC offset
    const offset = dayjs().format('Z');
    const offsetHours = dayjs().utcOffset() / 60;
    const offsetString = `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`;
    UI.userTimezoneOffset.textContent = `${offsetString} (${offset})`;

    console.log('[Timezone] User timezone:', timezone, offset);
  } catch (error) {
    console.error('[Timezone] Failed to detect timezone:', error);
    UI.userTimezone.textContent = 'Unknown';
    UI.userTimezoneOffset.textContent = 'Unknown';
  }
}

function handleDateRangeChange() {
  const startDate = UI.startDateInput.value;
  const endDate = UI.endDateInput.value;

  if (!startDate || !endDate) {
    UI.utcRangeOutput.value = '';
    UI.btnInsertRange.disabled = true;
    return;
  }

  try {
    // berry_data.time 已是本地時區：選什麼時間就插什麼時間，所見即所得、無轉換
    const start = dayjs(startDate).format('YYYY-MM-DD HH:mm:ss');
    const end = dayjs(endDate).format('YYYY-MM-DD HH:mm:ss');

    UI.utcRangeOutput.value = `time >= '${start}' AND time < '${end}'`;
    UI.btnInsertRange.disabled = false;

    console.log('[DateRange] Local range:', start, '~', end);
  } catch (error) {
    console.error('[Timezone] Date range conversion error:', error);
    UI.utcRangeOutput.value = 'Invalid date range';
    UI.btnInsertRange.disabled = true;
  }
}

function handleInsertRange() {
  const rangeCondition = UI.utcRangeOutput.value;

  if (!rangeCondition || rangeCondition === 'Invalid date range') {
    showQueryError('請先選擇開始和結束日期<br>Please select start and end dates first');
    return;
  }

  insertAtCursor(UI.sqlEditor, rangeCondition);
  console.log('[Timezone] Inserted date range condition:', rangeCondition);
}

// ============ UI Helpers ============

function showQueryError(message) {
  if (UI.queryErrorMessage && UI.queryErrorAlert) {
    UI.queryErrorMessage.innerHTML = message;
    UI.queryErrorAlert.style.display = 'block';
    UI.queryErrorAlert.classList.add('show');

    // Scroll to error message
    UI.queryErrorAlert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function hideQueryError() {
  if (UI.queryErrorAlert) {
    UI.queryErrorAlert.style.display = 'none';
    UI.queryErrorAlert.classList.remove('show');
  }
}

/**
 * 顯示通用訊息（成功或錯誤）
 * @param {string} message - 訊息內容
 * @param {string} type - 訊息類型：'success', 'error', 'warning', 'info'
 */
function showMessage(message, type = 'info') {
  if (!UI.messageAlert || !UI.messageIcon || !UI.messageText) return;

  // 清除之前的樣式
  UI.messageAlert.className = 'alert alert-dismissible fade';

  // 設定圖示和樣式
  let iconClass = '';
  let alertClass = '';

  switch (type) {
    case 'success':
      iconClass = 'bi bi-check-circle-fill';
      alertClass = 'alert-success';
      break;
    case 'error':
      iconClass = 'bi bi-exclamation-triangle-fill';
      alertClass = 'alert-danger';
      break;
    case 'warning':
      iconClass = 'bi bi-exclamation-circle-fill';
      alertClass = 'alert-warning';
      break;
    case 'info':
    default:
      iconClass = 'bi bi-info-circle-fill';
      alertClass = 'alert-info';
      break;
  }

  UI.messageAlert.classList.add(alertClass);
  UI.messageIcon.className = iconClass + ' me-2';
  UI.messageText.innerHTML = message;

  // 顯示訊息
  UI.messageAlert.style.display = 'block';
  UI.messageAlert.classList.add('show');

  // 自動捲動到訊息位置
  UI.messageAlert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // 3 秒後自動隱藏（僅成功訊息）
  if (type === 'success') {
    setTimeout(() => {
      hideMessage();
    }, 3000);
  }
}

/**
 * 隱藏通用訊息
 */
function hideMessage() {
  if (UI.messageAlert) {
    UI.messageAlert.style.display = 'none';
    UI.messageAlert.classList.remove('show');
  }
}

function insertAtCursor(textarea, text) {
  const startPos = textarea.selectionStart;
  const endPos = textarea.selectionEnd;
  const textBefore = textarea.value.substring(0, startPos);
  const textAfter = textarea.value.substring(endPos);

  textarea.value = textBefore + text + textAfter;

  // Move cursor after inserted text
  const newPos = startPos + text.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.focus();
}

function showLoading(show) {
  UI.loadingIndicator.style.display = show ? 'block' : 'none';
}

function showError(message) {
  UI.errorMessage.textContent = message;
  UI.errorMessage.style.display = 'block';
}

function hideError() {
  UI.errorMessage.style.display = 'none';
}

// ============ Module Export ============
// Note: initAnalytics is exported and called by tool.js when analytics.htm is loaded
// This is because jQuery doesn't execute <script type="module"> tags in dynamic content
