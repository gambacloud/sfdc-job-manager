import subprocess
import json
import logging
import re
import tempfile
import os

logger = logging.getLogger(__name__)

def run_sfdx_cmd(cmd_list):
    try:
        result = subprocess.run(
            cmd_list,
            capture_output=True,
            text=True,
            check=False, # We handle non-zero exit codes manually to extract SFDX json errors
            shell=(os.name == 'nt') # Important for Windows since `sf` is a .cmd script
        )
        data = json.loads(result.stdout)
        if result.returncode != 0 and data.get("status") != 0:
            error_msg = data.get("message", result.stderr)
            raise Exception(f"SFDX Error: {error_msg}")
        return data
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse SFDX output. Code: {result.returncode}, Stdout: {result.stdout}, Stderr: {result.stderr}")
        raise Exception(f"Error executing command: {result.stderr or result.stdout}")

def get_orgs():
    """Retrieve list of orgs authenticated with SFDX."""
    cmd = ["sf", "org", "list", "--json"]
    data = run_sfdx_cmd(cmd)
    
    orgs = []
    # Parse non-scratch orgs, other orgs, and scratch orgs
    result = data.get("result", {})
    
    # Combine nonScratchOrgs and other (some CLI version differences)
    all_standard_orgs = result.get("nonScratchOrgs", []) + result.get("other", [])
    
    for org in all_standard_orgs:
        if org.get("connectedStatus") == "Connected":
            orgs.append({"alias": org.get("alias", org.get("username")), "username": org.get("username"), "isScratch": False})
    
    for org in result.get("scratchOrgs", []):
        if not org.get("isExpired"):
            orgs.append({"alias": org.get("alias", org.get("username")), "username": org.get("username"), "isScratch": True})
            
    return orgs

def login_org(login_url: str = "https://login.salesforce.com", alias: str = None):
    """Open browser for sf org login web."""
    cmd = ["sf", "org", "login", "web", "--instance-url", login_url]
    if alias:
        cmd.extend(["-a", alias])
    cmd.append("--json")
    data = run_sfdx_cmd(cmd)
    return data.get("result", {})

def get_job_classes(target_org: str):
    """Query ApexClass names via standard API, then detect interfaces via anonymous Apex."""
    # Step 1: Get all class names (standard API - works without Tooling API access)
    query = "SELECT Id, Name FROM ApexClass WHERE NamespacePrefix = null AND Status = 'Active'"
    cmd = ["sf", "data", "query", "-o", target_org, "-q", query, "--json"]
    data = run_sfdx_cmd(cmd)
    
    records = data.get("result", {}).get("records", [])
    if not records:
        return []
    
    # Step 2: Use anonymous Apex to check which classes implement Batchable/Schedulable
    # We batch class names in groups to avoid hitting string limits
    class_names = [r.get("Name") for r in records if r.get("Name")]
    class_id_map = {r.get("Name"): r.get("Id") for r in records}
    
    # Build anonymous Apex that checks interfaces using Type.forName
    # and outputs results as JSON-like lines we can parse
    batch_size = 100
    valid_classes = []
    
    for i in range(0, len(class_names), batch_size):
        chunk = class_names[i:i + batch_size]
        
        apex_lines = ["List<String> results = new List<String>();"]
        for name in chunk:
            safe_name = name.replace("'", "\\'")
            apex_lines.append(f"try {{ Object o = Type.forName('{safe_name}').newInstance();")
            apex_lines.append(f"  Boolean b = o instanceof Database.Batchable;")
            apex_lines.append(f"  Boolean s = o instanceof Schedulable;")
            apex_lines.append(f"  if (b || s) results.add('{safe_name}|' + b + '|' + s);")
            apex_lines.append(f"}} catch(Exception e) {{}}")
        
        apex_lines.append("System.debug('CLASSINFO:' + String.join(results, ';;'));")
        apex_code = "\n".join(apex_lines)
        
        result = _run_anonymous_apex(target_org, apex_code)
        
        # Parse output from debug log
        if result:
            log = result.get("logs", "") or ""
            for line in log.split("\n"):
                if "CLASSINFO:" in line:
                    info_str = line.split("CLASSINFO:")[1].strip()
                    if info_str:
                        entries = info_str.split(";;")
                        for entry in entries:
                            parts = entry.strip().split("|")
                            if len(parts) == 3:
                                cls_name = parts[0]
                                is_batch = parts[1].lower() == "true"
                                is_sched = parts[2].lower() == "true"
                                valid_classes.append({
                                    "Id": class_id_map.get(cls_name, ""),
                                    "Name": cls_name,
                                    "isBatchable": is_batch,
                                    "isSchedulable": is_sched
                                })
    
    valid_classes.sort(key=lambda x: x["Name"])
    return valid_classes

def _run_anonymous_apex(target_org: str, apex_code: str):
    """Execute anonymous Apex and return the result including logs."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.apex', delete=False, encoding='utf-8') as f:
        f.write(apex_code)
        temp_path = f.name
    try:
        cmd = ["sf", "apex", "run", "-o", target_org, "-f", temp_path, "--json"]
        data = run_sfdx_cmd(cmd)
        return data.get("result", {})
    finally:
        os.unlink(temp_path)

def get_job_history(target_org: str, class_names: list):
    """Retrieve AsyncApexJob and CronTrigger history for specific classes."""
    if not class_names:
        return []
        
    class_names_str = ",".join([f"'{name}'" for name in class_names])
    
    # 1. Query AsyncApexJob for Batch jobs
    batch_query = f"SELECT Id, ApexClass.Name, Status, ExtendedStatus, MethodName, TotalJobItems, JobItemsProcessed, NumberOfErrors, CreatedDate, CompletedDate, CreatedBy.Name FROM AsyncApexJob WHERE JobType = 'BatchApex' AND ApexClass.Name IN ({class_names_str}) ORDER BY CreatedDate DESC LIMIT 200"
    batch_cmd = ["sf", "data", "query", "-o", target_org, "-q", batch_query, "--json"]
    batch_data = run_sfdx_cmd(batch_cmd)
    batch_records = batch_data.get("result", {}).get("records", [])
    
    # 2. Query CronTrigger/CronJobDetail for Scheduled jobs
    # We match the class name with CronJobDetail.Name or query AsyncApexJob for ScheduledApex
    sched_query = f"SELECT Id, ApexClass.Name, Status, ExtendedStatus, MethodName, TotalJobItems, JobItemsProcessed, NumberOfErrors, CreatedDate, CompletedDate, CreatedBy.Name FROM AsyncApexJob WHERE JobType = 'ScheduledApex' AND ApexClass.Name IN ({class_names_str}) ORDER BY CreatedDate DESC LIMIT 200"
    sched_cmd = ["sf", "data", "query", "-o", target_org, "-q", sched_query, "--json"]
    sched_data = run_sfdx_cmd(sched_cmd)
    sched_records = sched_data.get("result", {}).get("records", [])
    
    # Also fetch active CronTriggers to see actively scheduled jobs
    # Since CronTrigger doesn't have a direct link to ApexClass in SOQL easily, 
    # we have to rely on CronJobDetail.JobType = '7' (Scheduled Apex) and AsyncApexJob.
    # Actually, CronTrigger has CronJobDetailId. CronJobDetail has Name.
    # By convention, job name might not be class name, but AsyncApexJob tracks executions.
    
    # Combine results
    all_jobs = []
    
    for r in batch_records:
        all_jobs.append({
            "id": r.get("Id"),
            "className": r.get("ApexClass", {}).get("Name"),
            "type": "Batch",
            "status": r.get("Status"),
            "extendedStatus": r.get("ExtendedStatus") or "",
            "methodName": r.get("MethodName") or "",
            "totalBatches": r.get("TotalJobItems"),
            "processed": r.get("JobItemsProcessed"),
            "errors": r.get("NumberOfErrors"),
            "createdDate": r.get("CreatedDate"),
            "completedDate": r.get("CompletedDate") or "",
            "createdBy": r.get("CreatedBy", {}).get("Name", "")
        })
        
    for r in sched_records:
         all_jobs.append({
            "id": r.get("Id"),
            "className": r.get("ApexClass", {}).get("Name"),
            "type": "Scheduled",
            "status": r.get("Status"),
            "extendedStatus": r.get("ExtendedStatus") or "",
            "methodName": r.get("MethodName") or "",
            "totalBatches": r.get("TotalJobItems", 0),
            "processed": r.get("JobItemsProcessed", 0),
            "errors": r.get("NumberOfErrors", 0),
            "createdDate": r.get("CreatedDate"),
            "completedDate": r.get("CompletedDate") or "",
            "createdBy": r.get("CreatedBy", {}).get("Name", "")
        })
        
    # Sort globally by createdDate descending
    all_jobs.sort(key=lambda x: x["createdDate"], reverse=True)
    return all_jobs

def execute_apex_code(target_org: str, apex_code: str):
    """Execute Anonymous Apex and return result."""
    with tempfile.NamedTemporaryFile(delete=False, suffix=".apex", mode='w') as temp_file:
        temp_file.write(apex_code)
        temp_file_path = temp_file.name

    try:
        cmd = ["sf", "apex", "run", "-o", target_org, "-f", temp_file_path, "--json"]
        data = run_sfdx_cmd(cmd)
        return data.get("result", {})
    finally:
        os.remove(temp_file_path)

def execute_job(target_org: str, class_name: str, batch_size: int = None, cron_string: str = None):
    """Generate anonymous apex to run or schedule a job."""
    if cron_string:
        # Schedule Job
        job_name = f"{class_name}_{os.urandom(4).hex()}"
        apex_code = f"System.schedule('{job_name}', '{cron_string}', new {class_name}());"
    else:
        # Batch Job
        if batch_size:
            apex_code = f"Database.executeBatch(new {class_name}(), {batch_size});"
        else:
            apex_code = f"Database.executeBatch(new {class_name}());"
            
    return execute_apex_code(target_org, apex_code)

def abort_jobs(target_org: str, job_ids: list):
    """Generate anonymous apex to abort a list of jobs."""
    if not job_ids:
        return {"success": True}
        
    # Apex requires System.abortJob(jobId)
    apex_code = ""
    for jid in job_ids:
        apex_code += f"try {{ System.abortJob('{jid}'); }} catch (Exception e) {{ System.debug('Failed to abort: ' + e.getMessage()); }}\n"
        
    return execute_apex_code(target_org, apex_code)
