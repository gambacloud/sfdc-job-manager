// State
let currentOrg = '';
let availableClasses = [];
let selectedClasses = new Set();
let jobHistory = [];
let currentTab = 'batch'; // 'batch' or 'scheduled'
let selectedJobIds = new Set();

document.addEventListener('DOMContentLoaded', () => {
    initUI();
    initCronBuilder();
    fetchOrgs();
});

function initUI() {
    // Add Org - open modal
    const modal = document.getElementById('add-org-modal');
    document.getElementById('btn-add-org').addEventListener('click', () => {
        modal.style.display = 'flex';
    });
    document.getElementById('modal-cancel').addEventListener('click', () => {
        modal.style.display = 'none';
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });
    document.getElementById('modal-login').addEventListener('click', async () => {
        const loginUrl = document.getElementById('modal-login-url').value;
        const alias = document.getElementById('modal-alias').value.trim();
        const loginBtn = document.getElementById('modal-login');
        loginBtn.disabled = true;
        loginBtn.innerText = 'Opening...';
        try {
            const res = await fetch('/api/orgs/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ login_url: loginUrl, alias: alias || null })
            });
            const data = await res.json();
            if (data.status === 'success') {
                modal.style.display = 'none';
                alert('Complete login in the browser window that opened, then click OK to refresh orgs.');
                fetchOrgs();
            } else {
                alert('Error: ' + (data.detail || 'Unknown error'));
            }
        } catch (e) {
            alert('Failed to start org login.');
        } finally {
            loginBtn.disabled = false;
            loginBtn.innerText = 'Login';
        }
    });

    // Tabs
    const tabButtons = document.querySelectorAll('.tab-button');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            tabButtons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentTab = e.target.getAttribute('data-tab');
            renderTable();
        });
    });

    // Run Now
    document.getElementById('btn-run-now').addEventListener('click', async () => {
        if (!currentOrg || selectedClasses.size !== 1) {
            alert("Please select exactly one class to run.");
            return;
        }
        const className = Array.from(selectedClasses)[0];
        const batchSizeStr = document.getElementById('input-batch-size').value;
        const batchSize = batchSizeStr ? parseInt(batchSizeStr) : null;
        
        await executeJob(className, batchSize, null);
    });

    // Schedule
    document.getElementById('btn-schedule').addEventListener('click', async () => {
        if (!currentOrg || selectedClasses.size !== 1) {
            alert("Please select exactly one class to schedule.");
            return;
        }
        const className = Array.from(selectedClasses)[0];
        const cron = document.getElementById('input-cron').value;
        if (!cron) {
            alert("Please provide a cron string.");
            return;
        }
        
        await executeJob(className, null, cron);
    });

    // Abort
    document.getElementById('btn-abort').addEventListener('click', async () => {
        if (!currentOrg || selectedJobIds.size === 0) return;
        
        const confirmAbort = confirm(`Are you sure you want to abort ${selectedJobIds.size} jobs?`);
        if (!confirmAbort) return;
        
        try {
            const btn = document.getElementById('btn-abort');
            btn.innerText = 'Aborting...';
            btn.disabled = true;
            
            const res = await fetch('/api/jobs/abort', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ target_org: currentOrg, job_ids: Array.from(selectedJobIds) })
            });
            const data = await res.json();
            if (data.status === 'success') {
                alert("Jobs abort requested successfully.");
                selectedJobIds.clear();
                refreshJobs();
            } else {
                alert("Error: " + data.detail);
                updateAbortButton();
            }
        } catch (e) {
            alert("Error aborting jobs.");
            updateAbortButton();
        }
    });

    // Table Filter
    document.getElementById('input-table-filter').addEventListener('input', renderTable);
    
    // Select All Checkbox
    document.getElementById('selectAllJobs').addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const checkboxes = document.querySelectorAll('.job-checkbox');
        selectedJobIds.clear();
        checkboxes.forEach(cb => {
            cb.checked = isChecked;
            if (isChecked) selectedJobIds.add(cb.value);
        });
        updateAbortButton();
    });
}

async function fetchOrgs() {
    try {
        const res = await fetch('/api/orgs');
        const data = await res.json();
        const container = document.getElementById('org-selector-container');
        
        if (data.status === 'success') {
            // Remove old select if exists
            const oldSelect = document.getElementById('org-select');
            if (oldSelect) oldSelect.remove();

            const select = document.createElement('select');
            select.id = 'org-select';
            select.innerHTML = '<option value="">-- Select Org --</option>';
            data.orgs.forEach(org => {
                select.innerHTML += `<option value="${org.username}">${org.alias} (${org.username})</option>`;
            });
            select.addEventListener('change', (e) => {
                currentOrg = e.target.value;
                if (currentOrg) fetchClasses();
                else clearData();
            });
            // Insert before the Add Org button
            const addBtn = document.getElementById('btn-add-org');
            container.insertBefore(select, addBtn);
        }
    } catch (e) {
        console.error("Failed to fetch orgs", e);
    }
}

async function fetchClasses() {
    clearData();
    const container = document.getElementById('class-multiselect-container');
    container.innerHTML = 'Loading classes...';
    try {
        const res = await fetch(`/api/classes?target_org=${encodeURIComponent(currentOrg)}`);
        const data = await res.json();
        if (data.status === 'success') {
            availableClasses = data.classes;
            renderClassSelector();
        } else {
            container.innerHTML = `Error: ${data.detail}`;
        }
    } catch (e) {
        container.innerHTML = 'Error loading classes.';
    }
}

function renderClassSelector() {
    const container = document.getElementById('class-multiselect-container');
    container.innerHTML = `
        <div style="display:flex; gap:10px; align-items:center;">
            <input type="text" id="class-search" placeholder="Search classes...">
            <button class="action-btn" id="btn-refresh-jobs" style="padding: 0.5rem">Refresh Jobs</button>
        </div>
        <div class="class-list" id="class-list"></div>
    `;
    
    document.getElementById('class-search').addEventListener('input', (e) => {
        renderClassList(e.target.value);
    });
    
    document.getElementById('btn-refresh-jobs').addEventListener('click', refreshJobs);
    
    renderClassList('');
}

function renderClassList(filterText) {
    const list = document.getElementById('class-list');
    list.innerHTML = '';
    const lowerFilter = filterText.toLowerCase();
    
    availableClasses.forEach(cls => {
        if (cls.Name.toLowerCase().includes(lowerFilter)) {
            const div = document.createElement('div');
            div.className = 'class-item';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = cls.Name;
            checkbox.checked = selectedClasses.has(cls.Name);
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) selectedClasses.add(cls.Name);
                else selectedClasses.delete(cls.Name);
                refreshJobs();
                updateActionPanelVisibility();
            });
            
            const label = document.createElement('label');
            label.innerText = `${cls.Name} ${cls.isBatchable ? '(Batch)' : ''} ${cls.isSchedulable ? '(Sched)' : ''}`;
            
            div.appendChild(checkbox);
            div.appendChild(label);
            list.appendChild(div);
        }
    });
}

function updateActionPanelVisibility() {
    const btnRunNow = document.getElementById('btn-run-now');
    const inputBatchSize = document.getElementById('input-batch-size');
    const btnSchedule = document.getElementById('btn-schedule');
    const inputCron = document.getElementById('input-cron');
    
    if (selectedClasses.size === 1) {
        const className = Array.from(selectedClasses)[0];
        const clsInfo = availableClasses.find(c => c.Name === className);
        
        // Show Run Now if class is batchable (regardless of tab)
        const showBatch = clsInfo && clsInfo.isBatchable;
        btnRunNow.style.display = showBatch ? 'inline-block' : 'none';
        inputBatchSize.style.display = showBatch ? 'inline-block' : 'none';
        
        // Show Schedule if class is schedulable (regardless of tab)
        const showSched = clsInfo && clsInfo.isSchedulable;
        btnSchedule.style.display = showSched ? 'inline-block' : 'none';
        inputCron.style.display = showSched ? 'inline-block' : 'none';
    } else {
        // Multi-select or no selection: hide execution buttons
        btnRunNow.style.display = 'none';
        inputBatchSize.style.display = 'none';
        btnSchedule.style.display = 'none';
        inputCron.style.display = 'none';
    }
}

async function refreshJobs() {
    if (!currentOrg || selectedClasses.size === 0) {
        jobHistory = [];
        renderTable();
        return;
    }
    
    document.getElementById('job-table-body').innerHTML = '<tr><td colspan="9">Loading jobs...</td></tr>';
    
    try {
        const res = await fetch('/api/jobs', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                target_org: currentOrg,
                class_names: Array.from(selectedClasses)
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            jobHistory = data.jobs;
            renderTable();
        } else {
             document.getElementById('job-table-body').innerHTML = `<tr><td colspan="9">Error loading jobs: ${data.detail}</td></tr>`;
        }
    } catch (e) {
        console.error("Failed to fetch jobs");
        document.getElementById('job-table-body').innerHTML = '<tr><td colspan="9">Failed to connect to backend.</td></tr>';
    }
}

function renderTable() {
    const tbody = document.getElementById('job-table-body');
    tbody.innerHTML = '';
    selectedJobIds.clear();
    updateAbortButton();
    document.getElementById('selectAllJobs').checked = false;
    
    const filterText = document.getElementById('input-table-filter').value.toLowerCase();
    
    // Client-side sort if needed? Standard sorting by createdDate handled in backend.
    
    jobHistory.forEach(job => {
        // Filter by tab
        if (currentTab === 'batch' && job.type !== 'Batch') return;
        if (currentTab === 'scheduled' && job.type !== 'Scheduled') return;
        
        // Filter by search
        const rowText = `${job.className} ${job.status} ${job.id}`.toLowerCase();
        if (filterText && !rowText.includes(filterText)) return;
        
        const tr = document.createElement('tr');
        
        const tdCheck = document.createElement('td');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'job-checkbox';
        check.value = job.id;
        check.addEventListener('change', (e) => {
            if (e.target.checked) selectedJobIds.add(job.id);
            else selectedJobIds.delete(job.id);
            updateAbortButton();
        });
        tdCheck.appendChild(check);
        
        const statusBadgeClass = `status-${(job.status || 'unknown').toLowerCase().replace(/\s+/g, '-')}`;
        
        tr.innerHTML = `
            <td></td>
            <td>${job.className}</td>
            <td>${job.type}</td>
            <td><span class="status-badge ${statusBadgeClass}">${job.status}</span></td>
            <td>${job.totalBatches}</td>
            <td>${job.processed}</td>
            <td>${job.errors > 0 ? `<strong style="color:var(--danger-color)">${job.errors}</strong>` : job.errors}</td>
            <td>${new Date(job.createdDate).toLocaleString()}</td>
            <td><small style="opacity: 0.7">${job.id}</small></td>
        `;
        tr.firstElementChild.appendChild(check);
        
        tbody.appendChild(tr);
    });
    
    if (tbody.children.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9">No jobs found for selected classes in this category.</td></tr>';
    }
}

function updateAbortButton() {
    const btn = document.getElementById('btn-abort');
    if (selectedJobIds.size > 0) {
        btn.disabled = false;
        btn.innerText = `Abort Selected (${selectedJobIds.size})`;
    } else {
        btn.disabled = true;
        btn.innerText = 'Abort Selected Jobs';
    }
}

async function executeJob(className, batchSize, cron) {
    try {
        const payload = { target_org: currentOrg, class_name: className };
        if (batchSize) payload.batch_size = batchSize;
        if (cron) payload.cron_string = cron;
        
        const res = await fetch('/api/jobs/execute', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data.status === 'success') {
            alert("Job execution requested successfully!");
            setTimeout(refreshJobs, 2000); // Give Salesforce a moment
        } else {
            alert("Failed to execute:\n" + data.detail);
        }
    } catch (e) {
        alert("Execution error occurred.");
    }
}

function clearData() {
    availableClasses = [];
    selectedClasses.clear();
    jobHistory = [];
    selectedJobIds.clear();
    const container = document.getElementById('class-multiselect-container');
    if(container) container.innerHTML = '';
    renderTable();
    updateActionPanelVisibility();
}

// ---- Cron Builder ----
function initCronBuilder() {
    const cronModal = document.getElementById('cron-modal');
    const freq = document.getElementById('cron-frequency');
    const minute = document.getElementById('cron-minute');
    const hour = document.getElementById('cron-hour');
    const dom = document.getElementById('cron-dom');
    const preview = document.getElementById('cron-preview-text');

    // Populate minute (0-59)
    for (let i = 0; i < 60; i++) {
        const opt = document.createElement('option');
        opt.value = i; opt.text = String(i).padStart(2, '0');
        minute.appendChild(opt);
    }
    // Populate hour (0-23)
    for (let i = 0; i < 24; i++) {
        const opt = document.createElement('option');
        opt.value = i; opt.text = String(i).padStart(2, '0');
        hour.appendChild(opt);
    }
    hour.value = '12'; // Default noon
    // Populate day of month (1-31)
    for (let i = 1; i <= 31; i++) {
        const opt = document.createElement('option');
        opt.value = i; opt.text = String(i);
        dom.appendChild(opt);
    }

    // Open modal
    document.getElementById('btn-cron-builder').addEventListener('click', () => {
        cronModal.style.display = 'flex';
        updateCronPreview();
    });
    // Close modal
    document.getElementById('cron-cancel').addEventListener('click', () => {
        cronModal.style.display = 'none';
    });
    cronModal.addEventListener('click', (e) => {
        if (e.target === cronModal) cronModal.style.display = 'none';
    });

    // Frequency change — show/hide fields
    freq.addEventListener('change', () => {
        const v = freq.value;
        document.getElementById('cron-dow-field').style.display = (v === 'weekly') ? 'block' : 'none';
        document.getElementById('cron-dom-field').style.display = (v === 'monthly') ? 'block' : 'none';
        document.getElementById('cron-custom-field').style.display = (v === 'custom') ? 'block' : 'none';

        // Show/hide time fields
        const showTime = ['once', 'daily', 'weekly', 'monthly'].includes(v);
        minute.closest('.modal-field').style.display = showTime ? 'block' : (v === 'hourly' ? 'block' : 'none');
        hour.closest('.modal-field').style.display = (showTime ? 'block' : 'none');
        updateCronPreview();
    });

    // Live preview on any change
    [minute, hour, dom, document.getElementById('cron-dow'), freq, document.getElementById('cron-custom')].forEach(el => {
        el.addEventListener('change', updateCronPreview);
        el.addEventListener('input', updateCronPreview);
    });

    // Apply
    document.getElementById('cron-apply').addEventListener('click', () => {
        document.getElementById('input-cron').value = preview.innerText;
        cronModal.style.display = 'none';
    });

    function updateCronPreview() {
        const v = freq.value;
        let expr = '';

        if (v === 'custom') {
            expr = document.getElementById('cron-custom').value || '0 0 12 * * ?';
        } else if (v === 'hourly') {
            expr = `0 ${minute.value} * * * ?`;
        } else if (v === 'daily') {
            expr = `0 ${minute.value} ${hour.value} * * ?`;
        } else if (v === 'weekly') {
            const dow = document.getElementById('cron-dow').value;
            expr = `0 ${minute.value} ${hour.value} ? * ${dow}`;
        } else if (v === 'monthly') {
            expr = `0 ${minute.value} ${hour.value} ${dom.value} * ?`;
        } else { // once
            expr = `0 ${minute.value} ${hour.value} * * ?`;
        }
        preview.innerText = expr;
    }
}
