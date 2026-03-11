# SFDC Job Manager

A stateless web tool for monitoring, executing, scheduling, and aborting Salesforce Batch and Scheduled Apex jobs. Uses your local Salesforce CLI (`sf`) authentication — no credentials are stored.

## Features

- **Org Selector**: Auto-detects your authenticated SF CLI orgs.
- **Add Org**: Authenticate new orgs directly from the UI (opens `sf org login web`).
- **Class Discovery**: Finds all Apex classes implementing `Database.Batchable` or `Schedulable`.
- **Searchable Multi-Select**: Filter and select multiple classes to monitor, with Select All / Clear All.
- **Job History Table**: View `AsyncApexJob` history with status badges, filterable and sortable.
- **Status Filter**: Filter by Queued, Processing, Completed, Completed with Errors, Aborted, Failed, etc.
- **Job Details Drawer**: Click any job row to see extended details (duration, errors, method, created by).
- **Run Now**: Execute a batch class on-demand with optional batch size (`Database.executeBatch`).
- **Schedule**: Schedule a class with a cron expression (`System.schedule`).
- **Cron Builder**: Built-in cron expression generator with frequency presets and live preview.
- **Abort Jobs**: Multi-select and abort running/queued jobs.
- **Tabs**: Separate views for Batch Jobs and Scheduled Jobs.
- **Permission Warnings**: Helpful error messages when Tooling API access fails.

## Getting Started

### 1. Download Executable (Easiest)
1. Go to the [Actions tab](../../actions) in this repository.
2. Click on the latest successful `Build Executables` workflow run.
3. Download the artifact for your OS (Windows, Mac, or Linux).

### 2. Run Locally from Source
```bash
git clone https://github.com/gambacloud/sfdc-job-manager.git
cd sfdc-job-manager
pip install -r requirements.txt
python main.py
```
Open `http://localhost:8000` in your browser.

### 3. Run Scripts
- **Windows**: `run.bat`
- **Mac/Linux**: `./run.sh`

> **Prerequisite**: Salesforce CLI (`sf`) must be installed and at least one org authenticated via `sf org login web`.
