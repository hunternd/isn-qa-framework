// ==========================================================================
// ISN QA Dashboard Frontend Application
// ==========================================================================

// Global state
let state = {
  reports: [],
  activeReport: null,
  activeTab: 'content',
  filterType: 'all',
  searchQuery: '',
  showLatestOnly: true,
  eventSource: null,
};

// Initialize Mermaid with dark theme configurations
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    background: '#0d111c',
    primaryColor: '#1e293b',
    primaryTextColor: '#f3f5fa',
    primaryBorderColor: '#334155',
    lineColor: '#64748b',
    secondaryColor: '#0f172a',
    tertiaryColor: '#1e1b4b',
  }
});

// Configure Marked options
marked.setOptions({
  gfm: true,
  breaks: true,
  sanitize: false,
});

// Run once DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadReports();
});

// Setup DOM Event Listeners
function setupEventListeners() {
  // Refresh reports
  document.getElementById('refresh-btn').addEventListener('click', loadReports);

  // Search filter
  document.getElementById('report-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase();
    renderReportList();
  });

  // Latest-only filter
  document.getElementById('latest-only-checkbox').addEventListener('change', (e) => {
    state.showLatestOnly = e.target.checked;
    renderReportList();
  });

  // Filter tabs
  const filterTabs = document.querySelectorAll('.filter-tab');
  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.filterType = tab.dataset.filter;
      renderReportList();
    });
  });

  // Run suite trigger
  document.getElementById('run-btn').addEventListener('click', triggerTestRun);

  // Tab controls
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // Clear console log
  document.getElementById('clear-console-btn').addEventListener('click', () => {
    const logs = document.getElementById('console-output-logs');
    logs.innerHTML = '<div class="system-line">[SYSTEM] Console logs cleared.</div>';
  });
}

// Fetch report runs metadata list from the server API
async function loadReports() {
  const container = document.getElementById('report-list-container');
  container.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading historical audits...</p>
    </div>
  `;

  try {
    const response = await fetch('/api/reports');
    if (!response.ok) throw new Error('API server returned error');
    state.reports = await response.json();
    
    renderReportList();
    updateGlobalMetrics();
    
    // Auto-select the first report if available and none selected
    if (state.reports.length > 0 && !state.activeReport) {
      selectReport(state.reports[0].filename);
    }
  } catch (error) {
    console.error('Error fetching reports:', error);
    container.innerHTML = `
      <div class="loading-state">
        <p style="color:var(--accent-red)">❌ Failed to load reports.</p>
        <button class="btn btn-small" onclick="loadReports()" style="margin-top:0.8rem">Retry</button>
      </div>
    `;
  }
}

// Calculate and render global metrics in the header
function updateGlobalMetrics() {
  const totalRuns = state.reports.length;
  let totalBugs = 0;
  
  state.reports.forEach(r => {
    totalBugs += r.bugsCount;
  });

  document.getElementById('metric-runs').querySelector('.metric-value').textContent = totalRuns;
  document.getElementById('metric-bugs').querySelector('.metric-value').textContent = totalBugs;
}

// Render the sidebar report history list based on search/filters
function renderReportList() {
  const container = document.getElementById('report-list-container');
  
  const seenTypes = new Set();
  const filtered = state.reports.filter(r => {
    // 1. Filter by report type
    if (state.filterType !== 'all') {
      if (state.filterType !== r.type) return false;
    }
    
    // 2. Filter by search query
    if (state.searchQuery) {
      const dateText = r.dateStr.toLowerCase();
      const siteText = r.targetSite.toLowerCase();
      const typeText = r.type.toLowerCase();
      const filenameText = r.filename.toLowerCase();
      
      const match = dateText.includes(state.searchQuery) || 
                    siteText.includes(state.searchQuery) ||
                    typeText.includes(state.searchQuery) ||
                    filenameText.includes(state.searchQuery);
      if (!match) return false;
    }
    
    // 3. Filter by "latest of each type"
    if (state.showLatestOnly) {
      if (seenTypes.has(r.type)) return false;
      seenTypes.add(r.type);
    }
    
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="loading-state">
        <p style="color:var(--text-muted)">No reports found matching criteria.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  filtered.forEach(report => {
    const card = document.createElement('div');
    card.className = `report-card ${state.activeReport && state.activeReport.filename === report.filename ? 'active' : ''}`;
    card.dataset.filename = report.filename;
    
    const displayType = report.type === 'ui_ux' ? 'UI/UX' : report.type === 'scenario' ? 'Scenario' : report.type;
    const statusText = report.bugsCount > 0 ? `${report.bugsCount} defects` : 'clean';
    const statusClass = report.bugsCount > 0 ? 'defects' : 'clean';
    const cleanSite = report.targetSite.replace(/^https?:\/\/(www\.)?/, '');
    
    card.innerHTML = `
      <div class="card-header">
        <span class="report-type-badge ${report.type}">
          ${getReportIcon(report.type)} ${displayType}
        </span>
        <span class="card-status ${statusClass}">${statusText}</span>
      </div>
      <div class="card-site" title="${report.targetSite}">${cleanSite}</div>
      <div class="card-date">${report.dateStr}</div>
    `;

    card.addEventListener('click', () => {
      // Remove active states
      document.querySelectorAll('.report-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      selectReport(report.filename);
    });

    container.appendChild(card);
  });
}

// Map report type to custom inline SVG icons or emoji
function getReportIcon(type) {
  switch (type) {
    case 'executive': return '📊';
    case 'content': return '📜';
    case 'ui_ux': return '🎨';
    case 'security': return '🛡️';
    case 'navigation': return '🌐';
    case 'scenario': return '🎯';
    default: return '📄';
  }
}

// Select a report and fetch its full markdown text to populate views
async function selectReport(filename) {
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(filename)}`);
    if (!response.ok) throw new Error('Failed to load report details');
    const content = await response.text();
    
    // Find the report metadata in list
    const meta = state.reports.find(r => r.filename === filename) || {
      filename,
      type: 'unknown',
      dateStr: 'Unknown Date',
      targetSite: 'https://www.independentsponsor.news/',
      bugsCount: 0
    };

    state.activeReport = {
      ...meta,
      content
    };

    // Render report contents
    document.querySelector('.no-selection-state').style.display = 'none';
    document.querySelector('.report-details-wrapper').style.display = 'flex';
    
    document.getElementById('detail-report-title').textContent = getReportTitleText(meta.type);
    document.getElementById('detail-target-site').querySelector('span').textContent = meta.targetSite;
    document.getElementById('detail-report-date').querySelector('span').textContent = meta.dateStr;

    // Render defects count badge
    const badgeContainer = document.getElementById('detail-badge-container');
    badgeContainer.innerHTML = '';
    const statusBadge = document.createElement('span');
    statusBadge.className = `card-status ${meta.bugsCount > 0 ? 'defects' : 'clean'}`;
    statusBadge.style.fontSize = '0.9rem';
    statusBadge.style.padding = '0.35rem 0.85rem';
    statusBadge.textContent = meta.bugsCount > 0 
      ? `🚨 ${meta.bugsCount} DEFECTS LOGGED` 
      : '✅ AUDIT RUN CLEAN';
    badgeContainer.appendChild(statusBadge);

    // Parse out sitemap and screenshots
    const screenshots = extractScreenshots(content);
    const mermaidCode = extractMermaid(content);

    // Update screenshot tab counter
    document.getElementById('detail-screenshot-count').textContent = screenshots.length;

    // Rerender tab views
    renderMarkdownContent(content);
    renderScreenshotsGrid(screenshots);
    
    // Sitemap Tab logic
    const sitemapTabBtn = document.getElementById('tab-sitemap-btn');
    if (mermaidCode) {
      sitemapTabBtn.style.display = 'inline-flex';
      drawSitemap(mermaidCode);
    } else {
      sitemapTabBtn.style.display = 'none';
      if (state.activeTab === 'sitemap') {
        switchTab('content');
      }
    }

    // Default to report summary tab
    if (state.activeTab !== 'console') {
      switchTab('content');
    }
  } catch (error) {
    console.error('Error selecting report:', error);
    alert('Failed to load report contents.');
  }
}

function getReportTitleText(type) {
  switch (type) {
    case 'executive': return 'Coordinated QA Executive Report';
    case 'content': return 'Content Context & Integrity Report';
    case 'ui_ux': return 'UI/UX & Formatting Audit Report';
    case 'security': return 'Input Security & Validation Report';
    case 'navigation': return 'Exploration QA Navigation Report';
    default: return 'QA Test Run Report';
  }
}

// Convert absolute screenshots paths in Markdown to server-local URL paths
function renderMarkdownContent(content) {
  const viewer = document.getElementById('markdown-viewer');
  
  // Replace absolute filesystem paths with relative server paths
  // Path to match: /Users/exonix/github/isn-qa-framework/reports/screenshots/some_name.png
  // Output format: /screenshots/some_name.png
  let rewrittenContent = content.replace(
    /\/Users\/exonix\/github\/isn-qa-framework\/reports\/screenshots\//g,
    '/screenshots/'
  );

  // Render markdown to HTML
  viewer.innerHTML = marked.parse(rewrittenContent);
}

// Parse screenshot links out of the Markdown report
function extractScreenshots(content) {
  const screenshots = [];
  // Matches markdown image references and standard links to .png files
  const regex = /(?:!\[|\[)([^\]]*?)(?:\])\(([^)]+?\.png)\)/g;
  let match;
  
  while ((match = regex.exec(content)) !== null) {
    const label = match[1] || 'Screenshot';
    const filePath = match[2];
    const filename = filePath.substring(filePath.lastIndexOf('/') + 1);
    
    // Avoid duplicates
    if (!screenshots.some(s => s.filename === filename)) {
      screenshots.push({
        label: label.replace('View ', '').replace('Screenshot', '').trim() || 'Step Capture',
        url: `/screenshots/${filename}`,
        filename: filename
      });
    }
  }
  return screenshots;
}

// Parse Mermaid block out of Markdown report
function extractMermaid(content) {
  const regex = /```mermaid([\s\S]*?)```/g;
  const match = regex.exec(content);
  return match ? match[1].trim() : null;
}

// Render screenshots list into a photo gallery tab
function renderScreenshotsGrid(screenshots) {
  const container = document.getElementById('screenshots-grid-container');
  
  if (screenshots.length === 0) {
    container.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-secondary)">
        <p>No screenshot captures are linked to this report run.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  screenshots.forEach(shot => {
    const card = document.createElement('div');
    card.className = 'screenshot-thumbnail';
    card.addEventListener('click', () => openLightbox(shot.url, shot.label));
    
    // Extract viewport or step number if present in label
    const resolution = shot.filename.match(/_(\d+x\d+)\.png$/);
    const resText = resolution ? resolution[1] : 'Full Viewport';
    
    card.innerHTML = `
      <div class="screenshot-img-wrapper">
        <img src="${shot.url}" alt="${shot.label}" loading="lazy">
      </div>
      <div class="screenshot-info">
        <div class="screenshot-label" title="${shot.label}">${shot.label}</div>
        <div class="screenshot-resolution">${resText}</div>
      </div>
    `;
    
    container.appendChild(card);
  });
}

// Clean raw Mermaid sitemap strings containing double quotes as node IDs
function cleanMermaidCode(mermaidCode) {
  if (!mermaidCode.includes('"')) {
    return mermaidCode;
  }

  // Find all unique quoted strings
  const quotedRegex = /"([^"]+)"/g;
  const uniqueQuoted = new Set();
  let match;
  while ((match = quotedRegex.exec(mermaidCode)) !== null) {
    uniqueQuoted.add(match[1]);
  }

  // Create mapping of path -> safe alphanumeric ID
  const pathMap = {};
  let index = 0;
  uniqueQuoted.forEach(path => {
    let safeId = 'node_' + index++;
    if (path === '/') {
      safeId = 'node_root';
    } else {
      const clean = path.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '');
      if (clean) safeId = 'node_' + clean;
    }
    pathMap[path] = { id: safeId, label: path };
  });

  const lines = mermaidCode.split('\n');
  const headerLine = lines[0]; // e.g. "graph TD"
  const transitions = [];

  for (let i = 1; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim()) continue;

    let newLine = line;
    for (const [path, info] of Object.entries(pathMap)) {
      const quotedPath = `"${path}"`;
      if (newLine.includes(quotedPath)) {
        newLine = newLine.split(quotedPath).join(info.id);
      }
    }
    transitions.push(newLine);
  }

  const definitions = Object.entries(pathMap).map(([path, info]) => {
    return `    ${info.id}["${path}"]`;
  });

  return [
    headerLine,
    ...definitions,
    ...transitions
  ].join('\n');
}

// Render Mermaid navigation chart
async function drawSitemap(mermaidCode) {
  const viewer = document.getElementById('mermaid-sitemap-viewer');
  
  // Reset mermaid element
  viewer.removeAttribute('data-processed');
  viewer.innerHTML = '';
  
  const cleanCode = cleanMermaidCode(mermaidCode);
  
  try {
    // Generate clean diagram ID to avoid collisions
    const id = `sitemap_svg_${Date.now()}`;
    const { svg } = await mermaid.render(id, cleanCode);
    viewer.innerHTML = svg;
  } catch (err) {
    console.error('Mermaid render error:', err);
    viewer.innerHTML = `
      <div class="mermaid-error">
        <h4>Sitemap Render Failure</h4>
        <p>The flow chart syntax couldn't be parsed automatically. Review raw markdown structure.</p>
        <pre style="margin-top:0.8rem; background:rgba(0,0,0,0.4); padding:0.5rem; font-family:var(--font-mono); font-size:0.75rem">${err.message}</pre>
      </div>
    `;
  }
}

// Switch detail tabs
function switchTab(tabName) {
  state.activeTab = tabName;
  
  // Update buttons
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    if (btn.dataset.tab === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Update panels
  const panels = document.querySelectorAll('.tab-panel');
  panels.forEach(panel => {
    if (panel.id === `panel-${tabName}`) {
      panel.classList.add('active');
    } else {
      panel.classList.remove('active');
    }
  });
}

// Trigger running Playwright runner via EventSource (SSE)
function triggerTestRun() {
  if (state.eventSource) {
    alert('A test suite run is already in progress. Wait for it to complete or reload the page.');
    return;
  }

  const suite = document.getElementById('suite-selector').value;
  
  // Switch to terminal console immediately
  switchTab('console');
  
  const consoleLogs = document.getElementById('console-output-logs');
  consoleLogs.innerHTML = `<div class="system-line">[SYSTEM] Connecting to runner server...</div>`;
  
  const runBtn = document.getElementById('run-btn');
  const originalHtml = runBtn.innerHTML;
  
  // Disable button and add spinner/animation
  runBtn.disabled = true;
  runBtn.innerHTML = `
    <span class="spinner" style="width:12px; height:12px; border-width:2px; display:inline-block; margin-right:5px"></span>
    Running...
  `;
  
  // Set terminal status
  const indicator = document.getElementById('console-status-indicator');
  indicator.className = 'status-indicator running';
  indicator.querySelector('.status-text').textContent = 'RUNNING';

  // Open SSE channel
  const sseUrl = `/api/run-test?suite=${encodeURIComponent(suite)}`;
  state.eventSource = new EventSource(sseUrl);

  state.eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'start') {
        appendConsoleLine(data.message, 'system-line');
      } 
      else if (data.type === 'log') {
        appendConsoleLine(ansiToHtml(data.message));
      } 
      else if (data.type === 'error') {
        appendConsoleLine(ansiToHtml(data.message), 'error-line');
      } 
      else if (data.type === 'end') {
        appendConsoleLine(`\n[SYSTEM] Run complete: ${data.message}`, 'success-line');
        
        // Terminate EventSource
        state.eventSource.close();
        state.eventSource = null;
        
        // Re-enable button
        runBtn.disabled = false;
        runBtn.innerHTML = originalHtml;
        
        // Update indicator
        indicator.className = data.code === 0 ? 'status-indicator success' : 'status-indicator failed';
        indicator.querySelector('.status-text').textContent = data.code === 0 ? 'SUCCESS' : 'FAILED';
        
        // Reload reports list to display the new run findings
        loadReports();
      }
    } catch (e) {
      console.error('Error parsing SSE event:', e);
    }
  };

  state.eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    appendConsoleLine('[SYSTEM] EventSource connection encountered an error or was closed.', 'error-line');
    
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    
    runBtn.disabled = false;
    runBtn.innerHTML = originalHtml;
    
    indicator.className = 'status-indicator failed';
    indicator.querySelector('.status-text').textContent = 'ERROR';
  };
}

// Append a formatted text line into the Terminal simulation panel
function appendConsoleLine(htmlText, className = '') {
  const container = document.getElementById('console-output-logs');
  const div = document.createElement('div');
  if (className) div.className = className;
  div.innerHTML = htmlText;
  container.appendChild(div);
  
  // Auto-scroll to bottom of logs
  container.scrollTop = container.scrollHeight;
}

// Convert Terminal ANSI code sequences to semantic HTML color tags
function ansiToHtml(text) {
  let formatted = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Reset tag
  formatted = formatted.replace(/\x1B\[0m/g, '</span>');

  // ANSI color maps
  const colors = {
    '31': 'var(--accent-red)',
    '32': 'var(--accent-green)',
    '33': 'var(--accent-yellow)',
    '34': '#3b82f6',
    '35': 'var(--accent-violet)',
    '36': 'var(--accent-cyan)',
    '37': 'var(--text-primary)',
    '90': 'var(--text-muted)'
  };

  for (const [code, color] of Object.entries(colors)) {
    const regex = new RegExp(`\\x1B\\[(?:0;)?${code}m`, 'g');
    formatted = formatted.replace(regex, `<span style="color:${color}">`);
  }

  // Strip other styling sequences (bold, italic, underlines, compound colors)
  formatted = formatted.replace(/\x1B\[\d+m/g, '');
  formatted = formatted.replace(/\x1B\[\d+;\d+m/g, '');

  return formatted;
}

// Screenshot Lightbox Viewer actions
function openLightbox(url, title) {
  const lightbox = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const caption = document.getElementById('lightbox-caption');

  img.src = url;
  caption.textContent = title;
  lightbox.style.display = 'flex';
}

function closeLightbox() {
  document.getElementById('lightbox').style.display = 'none';
  document.getElementById('lightbox-img').src = '';
}
