# run-all-tests.ps1
# Resets the demo data, then runs every test suite and prints one summary.
# Run from the project root while "npm run dev" is running in another terminal.
# Keep rate limiting OFF (the development default): the suites together send more requests than the limit allows.
try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

if (-not (Test-Path 'prisma/seed.js')) {
    Write-Host 'prisma/seed.js was not found. Run this from the project root.' -ForegroundColor Red
    exit 1
}

Write-Host 'Resetting the demo data (prisma/seed.js) ...'
& node --env-file=.env prisma/seed.js | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Seeding failed. Run "node --env-file=.env prisma/seed.js" by hand to see the error.' -ForegroundColor Red
    exit 1
}

$suites = @(
    'test-cart.ps1',
    'test-checkout.ps1',
    'test-split-orders.ps1',
    'test-bargain.ps1',
    'test-orders-reviews.ps1',
    'test-verification.ps1',
    'test-dashboards.ps1',
    'test-catalog-admin.ps1',
    'test-users-staff.ps1',
    'test-password-reset.ps1',
    'test-uploads.ps1',
    'test-returns.ps1',
    'test-disputes.ps1',
    'test-notifications.ps1',
    'test-security.ps1'
)
$results = @()
foreach ($s in $suites) {
    if (-not (Test-Path ".\$s")) {
        $results += [pscustomobject]@{ Suite = $s; Passed = '-'; Failed = '-'; Result = 'MISSING' }
        continue
    }
    Write-Host "Running $s ..." -NoNewline
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File ".\$s" 2>&1 | Out-String
    if ($out -match 'Passed: (\d+)\s+Failed: (\d+)') {
        $p = [int]$Matches[1]
        $f = [int]$Matches[2]
        if ($f -eq 0) { $res = 'OK' } else { $res = 'FAILED' }
        $results += [pscustomobject]@{ Suite = $s; Passed = $p; Failed = $f; Result = $res }
        Write-Host " $res"
        if ($f -gt 0) {
            $out -split "`n" | Where-Object { $_ -match '^FAIL' } | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
        }
    } else {
        $results += [pscustomobject]@{ Suite = $s; Passed = '-'; Failed = '-'; Result = 'NO SUMMARY' }
        Write-Host ' NO SUMMARY (the script stopped early)' -ForegroundColor Red
        $out.Trim().Split("`n") | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" }
    }
}

Write-Host ''
$results | Format-Table -AutoSize
$bad = @($results | Where-Object { $_.Result -ne 'OK' }).Count
if ($bad -eq 0) {
    Write-Host 'ALL SUITES PASSED' -ForegroundColor Green
} else {
    Write-Host "$bad suite(s) need attention" -ForegroundColor Red
    exit 1
}