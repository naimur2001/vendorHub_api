# test-security.ps1
# Run while "npm run dev" is running. For the rate-limit part, add RATE_LIMIT_ENABLED=true to .env and restart.
$root = 'http://localhost:4000'
$api = "$root/api/v1"
$script:pass = 0
$script:fail = 0

function Raw($method, $url, $body, $headers) {
    $p = @{ Method = $method; Uri = $url; UseBasicParsing = $true }
    if ($null -ne $body) { $p.Body = $body; $p.ContentType = 'application/json' }
    if ($null -ne $headers) { $p.Headers = $headers }
    try {
        $r = Invoke-WebRequest @p
        return @{ status = [int]$r.StatusCode; headers = $r.Headers; body = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; headers = @{}; body = '' } }
        # Windows PowerShell 5.1 has already read the response stream; the body is in ErrorDetails
        $text = $_.ErrorDetails.Message
        if (-not $text) {
            try { $text = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { $text = '' }
        }
        return @{ status = [int]$resp.StatusCode; headers = $resp.Headers; body = $text }
    }
}

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) {
        Write-Host "PASS  $name" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red
        $script:fail++
    }
}

$h = Raw 'GET' "$root/health" $null $null
if ($h.status -ne 200) {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

# ---- headers ----
Check 'nosniff header is set' $h.headers['X-Content-Type-Options'] 'nosniff'
Check 'X-Powered-By is hidden' ([string]::IsNullOrEmpty($h.headers['X-Powered-By'])) $true

# ---- bad input ----
$r = Raw 'POST' "$api/auth/login" '{bad json' $null
Check 'malformed JSON is a 400' $r.status 400
Check 'the message explains it' ($r.body -like '*Malformed JSON*') $true
$big = '{"email":"' + ('a' * 200000) + '"}'
$r = Raw 'POST' "$api/auth/login" $big $null
Check 'an oversized body is a 413' $r.status 413
$r = Raw 'GET' "$api/does-not-exist" $null $null
Check 'an unknown API path is a 404 (not 401)' $r.status 404

# ---- protected routes ----
$r = Raw 'GET' "$api/cart" $null $null
Check 'cart without a token is 401' $r.status 401
$r = Raw 'GET' "$api/admin/verifications" $null $null
Check 'admin queue without a token is 401' $r.status 401

# ---- CORS (informational) ----
$r = Raw 'GET' "$api/categories" $null @{ Origin = 'http://example.com' }
Write-Host "INFO  CORS header for origin http://example.com: '$($r.headers['Access-Control-Allow-Origin'])' (empty means CORS_ORIGINS blocks it)"

# ---- rate limiting (only when RATE_LIMIT_ENABLED=true) ----
$blocked = $false
$msg = ''
$login = '{"email":"nobody@example.com","password":"wrong-password"}'
for ($i = 1; $i -le 14; $i++) {
    $r = Raw 'POST' "$api/auth/login" $login $null
    if ($r.status -eq 429) { $blocked = $true; $msg = $r.body; break }
}
if ($blocked) {
    Check 'repeated failed logins are blocked with 429' $true $true
    Check 'the 429 body is in our error format' ($msg -like '*Too many requests*') $true
    Write-Host 'Restart the server now to clear the rate-limit counters.' -ForegroundColor Yellow
} else {
    Write-Host 'SKIP  rate limiting is off. Add RATE_LIMIT_ENABLED=true to .env, restart, and run this again.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"