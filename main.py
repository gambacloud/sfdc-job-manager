import os
import sys
from fastapi import FastAPI, HTTPException, Body
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional

import sfdx

# Resolve base dir for PyInstaller bundled exe
if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(title="SFDC Job Manager")

# Mount static files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.get("/api/orgs")
async def get_orgs():
    try:
        orgs = sfdx.get_orgs()
        return {"status": "success", "orgs": orgs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class OrgLoginRequest(BaseModel):
    login_url: Optional[str] = "https://login.salesforce.com"
    alias: Optional[str] = None

@app.post("/api/orgs/login")
async def login_org(request: OrgLoginRequest):
    try:
        result = sfdx.login_org(login_url=request.login_url, alias=request.alias)
        return {"status": "success", "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/classes")
async def get_classes(target_org: str):
    try:
        classes = sfdx.get_job_classes(target_org)
        return {"status": "success", "classes": classes}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class JobHistoryRequest(BaseModel):
    target_org: str
    class_names: List[str]

@app.post("/api/jobs")
async def get_job_history(request: JobHistoryRequest):
    try:
        jobs = sfdx.get_job_history(request.target_org, request.class_names)
        return {"status": "success", "jobs": jobs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class ExecuteJobRequest(BaseModel):
    target_org: str
    class_name: str
    batch_size: Optional[int] = None
    cron_string: Optional[str] = None

@app.post("/api/jobs/execute")
async def execute_job(request: ExecuteJobRequest):
    try:
        result = sfdx.execute_job(
            target_org=request.target_org,
            class_name=request.class_name,
            batch_size=request.batch_size,
            cron_string=request.cron_string
        )
        if result and not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("compileProblem") or result.get("exceptionMessage"))
        return {"status": "success", "result": result}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class AbortJobRequest(BaseModel):
    target_org: str
    job_ids: List[str]

@app.post("/api/jobs/abort")
async def abort_jobs(request: AbortJobRequest):
    try:
        result = sfdx.abort_jobs(request.target_org, request.job_ids)
        return {"status": "success", "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    import webbrowser
    import socket
    import logging
    import traceback

    # Set up crash log file next to the exe / script
    if getattr(sys, 'frozen', False):
        log_dir = os.path.dirname(sys.executable)
    else:
        log_dir = os.path.dirname(os.path.abspath(__file__))
    log_file = os.path.join(log_dir, "sfdc_job_manager.log")

    logging.basicConfig(
        filename=log_file,
        level=logging.DEBUG,
        format="%(asctime)s %(levelname)s %(message)s"
    )
    logging.info("=== SFDC Job Manager starting ===")
    logging.info(f"Python: {sys.version}")
    logging.info(f"Frozen: {getattr(sys, 'frozen', False)}")
    logging.info(f"Base dir: {BASE_DIR}")
    logging.info(f"Static dir: {STATIC_DIR}")
    logging.info(f"Static exists: {os.path.isdir(STATIC_DIR)}")

    def find_free_port(start=8000, end=8010):
        for p in range(start, end + 1):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                try:
                    s.bind(("0.0.0.0", p))
                    return p
                except OSError:
                    continue
        return start

    try:
        port = int(os.environ.get("PORT", 0)) or find_free_port()
        logging.info(f"Using port: {port}")
        is_frozen = getattr(sys, 'frozen', False)

        print(f"Starting SFDC Job Manager on http://localhost:{port}")
        print(f"Log file: {log_file}")
        print("Press Ctrl+C to stop.\n")

        if is_frozen:
            webbrowser.open(f"http://localhost:{port}")
            uvicorn.run(app, host="0.0.0.0", port=port)
        else:
            uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
    except Exception as e:
        error_msg = traceback.format_exc()
        logging.error(f"CRASH:\n{error_msg}")
        print(f"\n\nERROR: {e}")
        print(f"Full log saved to: {log_file}")
        input("\nPress Enter to exit...")
