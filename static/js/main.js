// State
let currentOrg = '';
let availableClasses = [];
let selectedClasses = new Set();
let jobHistory = [];
let currentTab = 'batch'; // 'batch' or 'scheduled'
let selectedJobIds = new Set();

document.addEventListener('DOMContentLoaded', () => {
    initUI();
    fetchOrgs();
});

function initUI() {
    // Add Org
    document.getElementById('btn-add-org').addEventListener('click', async () => {
        const loginUrl = prompt('Login URL:', 'https://login.salesforce.com');
        if (!loginUrl) return;
        const alias = prompt('Alias for this org (optional):', '');
        try {
            const res = await fetch('/api/orgs/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ login_url: loginUrl, alias: alias || null })
            });
            const data = await res.json();
            if (data.status === 'success') {
                alert('Browser login opened. Complete login in the browser, then click OK here to refresh orgs.');
                fetchOrgs();
            } else {
                alert('Error: ' + (data.detail || 'Unknown error'));
            }
        } catch (e) {
            alert('Failed to start org login.');
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
