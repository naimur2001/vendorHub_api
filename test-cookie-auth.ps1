# test-cookie-auth.ps1 (cookie-based session for the website; JSON mode must keep working)
# Run from the project root while "npm run dev" is running in another terminal.
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''

function Req($method, $path, $session, $headers, $body) {
    $script:lastMsg = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($session) { $params.WebSession = $session }
    if ($headers) { $params.Headers = $headers }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json); setCookie = [string]$r.Headers['Set-Cookie']; headers = $r.Headers }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null; setCookie = ''; headers = $null } }
        $text = $_.ErrorDetails.Message
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
        return @{ status = [int]$resp.StatusCode; json = $json; setCookie = [string]$resp.Headers['Set-Cookie']; headers = $resp.Headers }
    }
}

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) {
        Write-Host "PASS  $name" -ForegroundColor Green
        $script:pass++
    } else {
        $extra = ''
        if ($script:lastMsg) { $extra = " | server said: $($script:lastMsg)" }
        Write-Host "FAIL  $name (got '$actual', expected '$expected')$extra" -ForegroundColor Red
        $script:fail++
    }
}

function NewSession { return New-Object Microsoft.PowerShell.Commands.WebRequestSession }
# A fresh session that holds ONLY the given cookie (no remembered headers).
# Windows PowerShell drops a hand-made "Cookie" header, so the cookie must go into the session's cookie jar.
function SessionWithCookie($value) {
    $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $s.Cookies.Add((New-Object System.Net.Cookie('vh_refresh', $value, '/api/v1/auth', 'localhost')))
    return $s
}
function CookieValue($session) {
    $c = $session.Cookies.GetCookies('http://localhost:4000/api/v1/auth/refresh')['vh_refresh']
    if ($c) { return $c.Value }
    return $null
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}

$ck = @{ 'X-Auth-Mode' = 'cookie' }
$creds = @{ email = 'customer@vendorshub.test'; password = 'Password123!' }

# ---- 1. JSON mode still works exactly as before (native apps, scripts) ----
$r = Req 'POST' '/auth/login' $null $null $creds
Check 'JSON mode: login works' $r.status 200
Check 'JSON mode: the refresh token is in the body' ([bool]$r.json.data.refreshToken) $true
Check 'JSON mode: no cookie is set' ($r.setCookie -like '*vh_refresh*') $false
$r = Req 'POST' '/auth/refresh' $null $null @{ refreshToken = $r.json.data.refreshToken }
Check 'JSON mode: refresh with the body token works' $r.status 200

# ---- 2. cookie mode login ----
$web = NewSession
$r = Req 'POST' '/auth/login' $web $ck $creds
Check 'cookie mode: login works' $r.status 200
Check 'cookie mode: an access token is returned' ([bool]$r.json.data.accessToken) $true
Check 'cookie mode: the refresh token is NOT in the body' ($null -eq $r.json.data.refreshToken) $true
Check 'the cookie is set' ($r.setCookie -like '*vh_refresh=*') $true
Check 'the cookie is HttpOnly' ($r.setCookie -like '*HttpOnly*') $true
Check 'the cookie is only for the auth endpoints' ($r.setCookie -like '*Path=/api/v1/auth*') $true
Check 'the cookie is SameSite=Lax' ($r.setCookie -like '*SameSite=Lax*') $true
$access = $r.json.data.accessToken
$me = Req 'GET' '/auth/me' $null @{ Authorization = "Bearer $access" } $null
Check 'the access token works' $me.status 200

# ---- 3. refreshing with the cookie ----
$old = CookieValue $web
# a fresh session with only the cookie: no X-Auth-Mode header is sent
$r = Req 'POST' '/auth/refresh' (SessionWithCookie $old) $null $null
Check 'the cookie alone (without the header) is refused' $r.status 403
$r = Req 'POST' '/auth/refresh' $web $ck $null
Check 'cookie + header refresh works' $r.status 200
Check 'a new access token is returned' ([bool]$r.json.data.accessToken) $true
Check 'the refresh token stays out of the body' ($null -eq $r.json.data.refreshToken) $true
$new = CookieValue $web
Check 'the cookie was rotated' ($new -and $new -ne $old) $true
$r = Req 'POST' '/auth/refresh' (SessionWithCookie $old) $ck $null
Check 'a stolen old cookie no longer works' $r.status 401

# ---- 4. logout ----
$r = Req 'POST' '/auth/logout' $web $ck $null
Check 'logout works' $r.status 200
Check 'logout clears the cookie' ($r.setCookie -like '*vh_refresh=;*') $true
$r = Req 'POST' '/auth/refresh' (SessionWithCookie $new) $ck $null
Check 'the logged-out session is dead' $r.status 401
$r = Req 'POST' '/auth/refresh' (NewSession) $ck $null
Check 'refresh without any token is 401' $r.status 401

# ---- 5. register in cookie mode ----
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$web2 = NewSession
$r = Req 'POST' '/auth/register' $web2 $ck @{ name = 'Cookie Tester'; email = "cookie$stamp@vendorshub.test"; password = 'Password123!'; role = 'CUSTOMER' }
Check 'cookie mode: register works' $r.status 201
Check 'register sets the cookie' ([bool](CookieValue $web2)) $true
Check 'register keeps the refresh token out of the body' ($null -eq $r.json.data.refreshToken) $true

# ---- 6. CORS lets the website send the cookie ----
$pre = Req 'OPTIONS' '/auth/refresh' $null @{ Origin = 'http://localhost:3000'; 'Access-Control-Request-Method' = 'POST'; 'Access-Control-Request-Headers' = 'x-auth-mode,content-type' } $null
Check 'CORS allows credentials' ([string]$pre.headers['Access-Control-Allow-Credentials']) 'true'
Check 'CORS allows the X-Auth-Mode header' (([string]$pre.headers['Access-Control-Allow-Headers']) -like '*x-auth-mode*') $true

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"