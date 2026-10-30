# test-openapi.ps1 (the API documentation)
# Run from the project root while "npm run dev" is running in another terminal.
$root = 'http://localhost:4000'
$script:pass = 0
$script:fail = 0

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) {
        Write-Host "PASS  $name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red
        $script:fail++
    }
}

try { Invoke-WebRequest -Uri "$root/health" -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

# ---- 1. the validity check (OpenAPI rules plus our own) ----
$out = & node scripts/check-openapi.mjs 2>&1
Check 'the spec is valid' $LASTEXITCODE 0
if ($LASTEXITCODE -ne 0) { Write-Host ($out | Out-String) -ForegroundColor Red }

# ---- 2. the JSON for code generators ----
$r = Invoke-WebRequest -Uri "$root/api/openapi.json" -UseBasicParsing
Check 'openapi.json is served' ([int]$r.StatusCode) 200
$spec = $r.Content | ConvertFrom-Json
Check 'it is OpenAPI 3.0' ($spec.openapi -like '3.0*') $true
Check 'it has the right title' $spec.info.title 'Vendors Hub API'

$ops = @()
foreach ($p in $spec.paths.PSObject.Properties) {
    foreach ($m in $p.Value.PSObject.Properties) {
        if (@('get', 'post', 'put', 'patch', 'delete') -contains $m.Name) { $ops += "$($m.Name.ToUpper()) $($p.Name)" }
    }
}
Write-Host "INFO  $($ops.Count) operations documented"
Check 'at least the 25 part-1 operations are documented' ($ops.Count -ge 25) $true
Check 'the login endpoint is documented' ($ops -contains 'POST /api/v1/auth/login') $true
Check 'the product page is documented' ($ops -contains 'GET /api/v1/products/{slug}') $true
Check 'the bearer login method is defined' ([bool]$spec.components.securitySchemes.bearerAuth) $true
Check 'the cookie login method is defined' ([bool]$spec.components.securitySchemes.sessionCookie) $true

# ---- 3. the docs page ----
$d = Invoke-WebRequest -Uri "$root/api/docs/" -UseBasicParsing
Check 'the docs page is served' ([int]$d.StatusCode) 200
Check 'it is Swagger UI' ($d.Content -like '*swagger-ui*') $true

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"