# Grading for os-db-backup-job: the gap is closed, the routine is back, and the
# database can answer a point-in-time request — whichever door the student used
# (the Agent job, a scheduled task, or an honest manual close with a routine
# behind it).
. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$database = 'TrainingDB'
$jobLog = ($database + ' Log Backup')
$serviceName = 'SQLSERVERAGENT'

# --- objective: log-backup-exists (critical) ---------------------------------
# The backup history is the auditor's evidence: a row with type 'L' is a log
# backup that exists, whatever produced it. The report is not the evidence —
# that is the whole point of the ticket.
$logOk = $false
$logDetail = 'no log backup of ' + $database + ' could be found'
try {
    $rows = Invoke-OnTrakSql -Query ('SELECT COUNT(*) AS n, MAX(backup_finish_date) AS last_one FROM msdb.dbo.backupset WHERE database_name = ''' + $database + ''' AND type = ''L''')
    $logOk = ([int] $rows[0].n) -gt 0
    $logDetail = ('log backups of ' + $database + ': ' + ([int] $rows[0].n) + '; most recent: ' + ('' + $rows[0].last_one))
} catch {
    $logDetail = ('the backup history could not be read: ' + $_.Exception.Message)
}
Add-OnTrakCheck -Objective 'log-backup-exists' -Passed $logOk -Detail $logDetail

# --- objective: routine-will-run (critical) ----------------------------------
# "Somebody took one today" is not the ticket. The recurring routine is either
# the Agent job (enabled, scheduled, with a BACKUP LOG step, behind an Agent
# that runs) or an equivalent scheduled task — grading reads both doors.
$routineOk = $false
$routineDetail = 'nothing recurring will take the next log backup'
try {
    $jobRows = Invoke-OnTrakSql -Query @"
SELECT
    (SELECT COUNT(*) FROM msdb.dbo.sysjobs WHERE name = '$jobLog' AND enabled = 1) AS job_enabled,
    (SELECT COUNT(*) FROM msdb.dbo.sysjobs j
        JOIN msdb.dbo.sysjobschedules js ON j.job_id = js.job_id
        JOIN msdb.dbo.sysschedules s ON js.schedule_id = s.schedule_id
     WHERE j.name = '$jobLog' AND s.enabled = 1) AS schedules,
    (SELECT COUNT(*) FROM msdb.dbo.sysjobsteps st
        JOIN msdb.dbo.sysjobs j ON st.job_id = j.job_id
     WHERE j.name = '$jobLog' AND st.command LIKE '%BACKUP LOG%') AS log_steps
"@
    $startType = 'Missing'
    try { $startType = '' + (Get-Service -Name $serviceName -ErrorAction Stop).StartType } catch { }
    $agentHappy = ((Get-OnTrakServiceState $serviceName) -eq 'Running') -and ($startType -ne 'Disabled')
    $jobHappy = (([int] $jobRows[0].job_enabled) -gt 0) -and (([int] $jobRows[0].schedules) -gt 0) -and (([int] $jobRows[0].log_steps) -gt 0)
    if ($jobHappy -and $agentHappy) {
        $routineOk = $true
        $routineDetail = 'the Agent job is enabled and scheduled with a log-backup step, and the Agent runs'
    } else {
        # Routing the backups through Task Scheduler instead of the Agent is a
        # legitimate fix; an enabled task that backs up this database counts as
        # the routine being back.
        $altTasks = @()
        try {
            $altTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
                $actionText = (($_.Actions | ForEach-Object { ('' + $_.Execute + ' ' + $_.Arguments) }) -join ' ')
                ($actionText -match 'TrainingDB') -and ($actionText -match 'BACKUP')
            } | Where-Object { $_.State -ne 'Disabled' })
        } catch { }
        if ($altTasks.Count -gt 0) {
            $routineOk = $true
            $routineDetail = ('a scheduled task runs the backups: ' + (($altTasks | ForEach-Object { $_.TaskName }) -join ', '))
        } else {
            $routineDetail = ('job enabled: ' + ([int] $jobRows[0].job_enabled) + ', enabled schedules: ' + ([int] $jobRows[0].schedules) + ', log-backup steps: ' + ([int] $jobRows[0].log_steps) + '; ' + $serviceName + ' is ' + (Get-OnTrakServiceState $serviceName) + ' (' + $startType + ')')
        }
    }
} catch {
    $routineDetail = ('the routine could not be inspected: ' + $_.Exception.Message)
}
Add-OnTrakCheck -Objective 'routine-will-run' -Passed $routineOk -Detail $routineDetail

# --- objective: restore-ready ------------------------------------------------
# Full recovery plus a full backup plus a log backup is the floor a point-in-time
# restore stands on. This objective is what fails the "switch it to simple and
# take a full backup" fix — which repairs saving and quietly surrenders exactly
# what audit asked for.
$restoreOk = $false
$restoreDetail = ''
try {
    $recoveryRows = Invoke-OnTrakSql -Query ('SELECT recovery_model_desc FROM sys.databases WHERE name = ''' + $database + '''')
    $coverage = Invoke-OnTrakSql -Query ('SELECT SUM(CASE WHEN type = ''D'' THEN 1 ELSE 0 END) AS fulls, SUM(CASE WHEN type = ''L'' THEN 1 ELSE 0 END) AS logs FROM msdb.dbo.backupset WHERE database_name = ''' + $database + '''')
    $recovery = '' + $recoveryRows[0].recovery_model_desc
    $fulls = [int] $coverage[0].fulls
    $logs = [int] $coverage[0].logs
    $restoreOk = ($recovery -eq 'FULL') -and ($fulls -gt 0) -and ($logs -gt 0)
    $restoreDetail = ('recovery model ' + $recovery + '; full backups: ' + $fulls + '; log backups: ' + $logs)
} catch {
    $restoreDetail = ('recovery state could not be read: ' + $_.Exception.Message)
}
Add-OnTrakCheck -Objective 'restore-ready' -Passed $restoreOk -Detail $restoreDetail

Write-OnTrakReport
