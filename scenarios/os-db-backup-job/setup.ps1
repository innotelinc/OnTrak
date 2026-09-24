# os-db-backup-job — the log-backup routine knocked out and the gap it left.
#
# What a point-in-time restore actually needs: a full backup plus *every* log
# backup since it — an unbroken chain. A database in full recovery keeps
# committed transactions in its log until a log backup clears them, so a
# routine that stopped means the log only grows and the chain never starts.
#
# The trap is the backup report: the nightly *full* backup job is healthy and
# green, and monitoring that watches for a full backup is satisfied — while the
# log-backup job is disabled and SQL Server Agent, the thing that runs both
# jobs, is stopped and set to manual. Nobody checked for log backups because
# the report says backups are fine.
#
# The story: last week's incident response left things "quiet" — the log-backup
# job was disabled while its target share was decommissioned, and the Agent was
# stopped "until things calm down". Neither state is loud; both are deliberate.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$database = 'TrainingDB'
$backupDir = Join-Path $env:ProgramData 'OnTrak\backups'
$fullPath = Join-Path $backupDir ($database + '_full.bak')
$logPath = Join-Path $backupDir ($database + '_log.trn')
$jobLog = ($database + ' Log Backup')
$serviceName = 'SQLSERVERAGENT'

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

# ------------------------------------------- a clean starting point ---------
# Idempotent across template rebuilds: sp_delete_backuphistory is the documented
# way to clear one database's backup history, so a re-run cannot discover log
# backups a previous run seeded and then assert there are none.
Invoke-OnTrakSql -Query ('IF DB_ID(''' + $database + ''') IS NULL EXEC(''CREATE DATABASE ' + $database + '')') | Out-Null
Invoke-OnTrakSql -Query ('ALTER DATABASE ' + $database + ' SET RECOVERY FULL') | Out-Null
Invoke-OnTrakSql -Query ('EXEC msdb.dbo.sp_delete_backuphistory @database_name = N''' + $database + '''') | Out-Null

# A little trading history — the gap should hold real committed transactions,
# not an idle log.
Invoke-OnTrakSql -Database $database -Query @'
IF OBJECT_ID('dbo.invoice', 'U') IS NULL
    CREATE TABLE dbo.invoice (id INT IDENTITY PRIMARY KEY, raised DATETIME2 NOT NULL, amount DECIMAL(10,2) NOT NULL, status VARCHAR(12) NOT NULL);
IF NOT EXISTS (SELECT 1 FROM dbo.invoice)
BEGIN
    DECLARE @i INT = 0;
    WHILE @i < 200
    BEGIN
        INSERT INTO dbo.invoice (raised, amount, status)
            VALUES (DATEADD(MINUTE, -@i, SYSDATETIME()), 25.00 + @i, 'open');
        SET @i += 1;
    END
END
'@ | Out-Null

# --------------------------------------------------- the estate's routine ---
# Two SQL Agent jobs exactly as deployed: a nightly full that works (and is the
# report's green tick) and the log backup every 15 minutes the ticket is about.
# Both are created enabled and on schedule — the fault below is the only thing
# wrong with them.
Write-OnTrakStep 'deploying the backup jobs as they were before the incident'
Invoke-OnTrakSql -Query @"
USE msdb;
IF EXISTS (SELECT 1 FROM dbo.sysjobs WHERE name = N'$jobLog')
    EXEC dbo.sp_delete_job @job_name = N'$jobLog', @delete_unused_schedule = 1;
IF EXISTS (SELECT 1 FROM dbo.sysjobs WHERE name = N'Full Backup of $database')
    EXEC dbo.sp_delete_job @job_name = N'Full Backup of $database', @delete_unused_schedule = 1;
EXEC dbo.sp_add_job @job_name = N'Full Backup of $database', @enabled = 1,
     @description = N'Nightly full backup of $database (the estate routine).';
EXEC dbo.sp_add_jobstep @job_name = N'Full Backup of $database', @step_name = N'Full backup',
     @subsystem = N'TSQL', @database_name = N'master',
     @command = N'BACKUP DATABASE [$database] TO DISK = N''$fullPath'' WITH INIT;';
EXEC dbo.sp_add_schedule @schedule_name = N'$database nightly full', @freq_type = 4, @freq_interval = 1, @active_start_time = 20000;
EXEC dbo.sp_attach_schedule @job_name = N'Full Backup of $database', @schedule_name = N'$database nightly full';
EXEC dbo.sp_add_job @job_name = N'$jobLog', @enabled = 1,
     @description = N'Transaction-log backup of $database every 15 minutes.';
EXEC dbo.sp_add_jobstep @job_name = N'$jobLog', @step_name = N'Log backup',
     @subsystem = N'TSQL', @database_name = N'master',
     @command = N'BACKUP LOG [$database] TO DISK = N''$logPath'' WITH INIT;';
EXEC dbo.sp_add_schedule @schedule_name = N'$database log every 15 minutes', @freq_type = 4, @freq_interval = 1, @freq_subday_type = 4, @freq_subday_interval = 15, @active_start_time = 0;
EXEC dbo.sp_attach_schedule @job_name = N'$jobLog', @schedule_name = N'$database log every 15 minutes';
"@ | Out-Null

# The weekend's full backup ran — the report's green tick, and the ticket's red
# herring. The log backup has never run: that is the gap audit fell into.
Invoke-OnTrakSql -Query ('BACKUP DATABASE ' + $database + ' TO DISK = ''' + $fullPath + ''' WITH INIT') | Out-Null

# ------------------------------------------------------------- the fault ----
Invoke-OnTrakSql -Query ('USE msdb; EXEC dbo.sp_update_job @job_name = N''' + $jobLog + ''', @enabled = 0;') | Out-Null
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
Set-Service -Name $serviceName -StartupType Manual -ErrorAction SilentlyContinue
Write-OnTrakStep 'the log-backup job is disabled and SQL Server Agent is stopped on manual'

# ---------------------------------------------------------- assertions ------
Require-OnTrak 'the gap is real: TrainingDB has no log backup anywhere' {
    $rows = Invoke-OnTrakSql -Query ('SELECT COUNT(*) AS n FROM msdb.dbo.backupset WHERE database_name = ''' + $database + ''' AND type = ''L''')
    ([int] $rows[0].n) -eq 0
}
Require-OnTrak 'the trap is in place: the full backup makes the report look healthy' {
    $rows = Invoke-OnTrakSql -Query ('SELECT COUNT(*) AS n FROM msdb.dbo.backupset WHERE database_name = ''' + $database + ''' AND type = ''D''')
    ([int] $rows[0].n) -gt 0
}
Require-OnTrak 'the routine is knocked out: the job is disabled and its runner is stopped' {
    $rows = Invoke-OnTrakSql -Query ('SELECT enabled FROM msdb.dbo.sysjobs WHERE name = ''' + $jobLog + '''')
    (([int] $rows[0].enabled) -eq 0) -and ((Get-OnTrakServiceState $serviceName) -ne 'Running')
}

Write-OnTrakSetupOk -Note 'log backups never taken: job disabled and SQL Server Agent stopped'
