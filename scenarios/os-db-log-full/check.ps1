# Grading for os-db-log-full: the application can save, the log can grow, and the
# standing volume of log is gone. Three different fixes (autogrowth, a bigger
# cap, a log backup, a recovery-model change) all reach a passing machine, which
# is the point: the grading is on outcomes, not on which door the student used.

. "$PSScriptRoot\..\..\lib\OnTrak.Common.ps1"

$database = 'TrainingDB'

# --- objective: app-can-save ---------------------------------------------------
# The checkpoint first is fairness to one legitimate fix: switching to simple
# recovery frees the log at the next checkpoint, and the application would not
# run one by hand before saving. It changes nothing in full recovery — a
# checkpoint cannot clear a log there, which is half the lesson.
try { Invoke-OnTrakSql -Database $database -Query 'CHECKPOINT' | Out-Null } catch { }
$saveOk = $false
$saveDetail = 'not tried'
try {
    Invoke-OnTrakSql -Database $database -Query "INSERT INTO dbo.payload (filler) VALUES (REPLICATE('c', 7000))" | Out-Null
    Invoke-OnTrakSql -Database $database -Query 'DELETE FROM dbo.payload WHERE filler = REPLICATE(''c'', 7000)' | Out-Null
    $saveOk = $true
    $saveDetail = 'a row was written to TrainingDB and removed again'
} catch {
    $saveDetail = 'the write failed: ' + $_.Exception.Message
}
Add-OnTrakCheck -Objective 'app-can-save' -Passed $saveOk -Detail $saveDetail

# --- objective: log-can-grow ---------------------------------------------------
# The lid: size caps are 8 KB pages, so the 4 MB cap is 512, and -1 is "no cap".
$growOk = $false
$growDetail = 'the log file could not be read'
try {
    $rows = Invoke-OnTrakSql -Database $database -Query 'SELECT size, max_size, growth FROM sys.master_files WHERE database_id = DB_ID() AND type = 1'
    $growth = [int] $rows[0].growth
    $maxSize = [int] $rows[0].max_size
    $growOk = ($growth -gt 0) -or ($maxSize -eq -1)
    $growDetail = ('log: ' + [int] $rows[0].size + ' pages; cap: ' + $maxSize + '; growth: ' + $growth)
} catch {
    $growDetail = 'the log file could not be read: ' + $_.Exception.Message
}
Add-OnTrakCheck -Objective 'log-can-grow' -Passed $growOk -Detail $growDetail

# --- objective: log-has-room ---------------------------------------------------
$roomOk = $false
$roomDetail = 'log usage could not be read'
try {
    $rows = Invoke-OnTrakSql -Database $database -Query 'SELECT used_log_space_in_percent AS used FROM sys.dm_db_log_space_usage'
    $used = [math]::Round([double] $rows[0].used, 1)
    $roomOk = $used -lt 90
    $roomDetail = ('transaction log ' + $used + '% full')
} catch {
    $roomDetail = 'log usage could not be read: ' + $_.Exception.Message
}
Add-OnTrakCheck -Objective 'log-has-room' -Passed $roomOk -Detail $roomDetail

Write-OnTrakReport
