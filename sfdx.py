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
    """Query ApexClass to find Schedulable or Batchable classes."""
    # We query all active, non-namespaced classes and filter by body locally.
    # Tooling API restricts large body queries without limits sometimes, but usually fine.
    # Let's try regular data query on Tooling API.
    query = "SELECT Id, Name, Body FROM ApexClass WHERE NamespacePrefix = null AND Status = 'Active'"
    cmd = ["sf", "data", "query", "-o", target_org, "-q", query, "--json", "-t"]
    data = run_sfdx_cmd(cmd)
    
    records = data.get("result", {}).get("records", [])
    valid_classes = []
    
    batchable_regex = re.compile(r'implements\s+.*Database\.Batchable', re.IGNORECASE)
    schedulable_regex = re.compile(r'implements\s+.*Schedulable', re.IGNORECASE)
    
    for record in records:
        body = record.get("Body", "")
        if not body:
            continue
            
        is_batchable = bool(batchable_regex.search(body))
        is_schedulable = bool(schedulable_regex.search(body))
        
        if is_batchable or is_schedulable:
            valid_classes.append({
                "Id": record.get("Id"),
                "Name": record.get("Name"),
                "isBatchable": is_batchable,
                "isSchedulable": is_schedulable
            })
            
    # Sort alphabetically by Name
    valid_classes.sort(key=lambda x: x["Name"])
    return valid_classes

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
