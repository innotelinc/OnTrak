# os-db-log-full — the transaction log that cannot grow and cannot clear.
#
# The ticket's shape is capacity and its costume is a database: "the database is
# full" on a server with empty disks. The mechanism is SQL Server's transaction
# log. In FULL recovery a committed transaction stays in the log until a log
# backup clears it, so a log with no autogrowth and no backup job fills up and
# then refuses every write — with disk space to spare.
#
# So: a small database, a 4 MB log lid with FILEGROWTH=0, full recovery, and
# enough committed rows to hit the lid.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$database = 'TrainingDB'

# ------------------------------------------------- a clean starting point -----
# Idempotent across template rebuilds: SIMPLE recovery plus a checkpoint
# reclaims whatever the log was holding, so a re-run starts from empty whatever
# state the last run left behind.
Invoke-OnTrakSql -Query ('IF DB_ID(''' + $database + ''') IS NULL CREATE DATABASE ' + $database) | Out-Null
Invoke-OnTrakSql -Query ('ALTER DATABASE ' + $database + ' SET RECOVERY SIMPLE') | Out-Null
Invoke-OnTrakSql -Database $database -Query 'CHECKPOINT' | Out-Null

$logRows = Invoke-OnTrakSql -Database $database -Query 'SELECT name FROM sys.master_files WHERE type = 1'
$logFile = [string] $logRows[0].name
Invoke-OnTrakSql -Database $database -Query ('DBCC SHRINKFILE (' + $logFile + ', 4)') | Out-Null

# ----------------------------------------------------------- the lid ----------
# 4 MB, no autogrowth, full recovery: everything else about the database is
# healthy, which is what makes the disk counters such a good red herring.
Invoke-OnTrakSql -Query ('ALTER DATABASE ' + $database + ' MODIFY FILE (NAME = ' + $logFile + ', SIZE = 4MB, MAXSIZE = 4MB, FILEGROWTH = 0)') | Out-Null
Invoke-OnTrakSql -Query ('ALTER DATABASE ' + $database + ' SET RECOVERY FULL') | Out-Null

# ----------------------------------------------------------- the fill ---------
# Committed rows of a size that guarantees a page each. Committed on purpose:
# with no log backup they cannot be cleared, so the log stays full for good
# rather than emptying when the filler disconnects. The loop stops early when
# the log refuses the write — that refusal is the fault, not a failure of setup.
$fill = @'
SET NOCOUNT ON;
IF OBJECT_ID('dbo.payload') IS NULL
    CREATE TABLE dbo.payload (id INT IDENTITY(1,1) PRIMARY KEY, filler CHAR(7000) NOT NULL);
DECLARE @i INT = 0;
WHILE @i < 2000
BEGIN
    INSERT INTO dbo.payload (filler) VALUES (REPLICATE('x', 7000));
    SET @i = @i + 1;
END
'@

$blocked = $false
try {
    Invoke-OnTrakSql -Database $database -Query $fill | Out-Null
} catch {
    $blocked = $_.Exception.Message -match 'full'
}
$note = 'the log never filled, which means the lid did not land'
if ($blocked) { $note = 'every write is now refused: the log is full' }
Write-OnTrakStep ('filling the log: ' + $note)

# ------------------------------------------------------------- assertions -----
Require-OnTrak 'the log is capped small with no autogrowth' {
    $rows = Invoke-OnTrakSql -Database $database -Query 'SELECT size, max_size, growth FROM sys.master_files WHERE database_id = DB_ID() AND type = 1'
    (([int] $rows[0].growth) -eq 0) -and (([int] $rows[0].max_size) -le 512)
}
Require-OnTrak 'the fault is observable: a write to TrainingDB is refused' {
    $refused = $false
    try {
        Invoke-OnTrakSql -Database $database -Query "INSERT INTO dbo.payload (filler) VALUES (REPLICATE('z', 7000))" | Out-Null
    } catch {
        $refused = $_.Exception.Message -match 'full'
    }
    $refused
}

Write-OnTrakSetupOk -Note ('the ' + $database + ' transaction log is capped at 4 MB and full')
