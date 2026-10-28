# test-password-reset.ps1
# Run from the project root while "npm run dev" is running in another terminal (started from the same folder).
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''

function Call($method, $path, $token, $body) {
    $script:lastMsg = ''
    $params = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $params.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) {
        $params.ContentType = 'application/json'
        $params.Body = ($body | ConvertTo-Json -Depth 6 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) }
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { return @{ status = 0; json = $null } }
        $text = $_.ErrorDetails.Message
        if (-not $text) {
            try { $text = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() } catch { $text = '' }
        }
        $json = $null
        try { $json = $text | ConvertFrom-Json } catch { }
        if ($null -ne $json -and $null -ne $json.error) { $script:lastMsg = $json.error.message }
        return @{ status = [int]$resp.StatusCode; json = $json }
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

function Login($email) {
    $r = Call 'POST' '/auth/login' $null @{ email = $email; password = 'Password123!' }
    if ($r.status -ne 200) {
        Write-Host "Login failed for $email (status $($r.status))" -ForegroundColor Red
        exit 1
    }
    return $r.json.data.accessToken
}

function Need($value, $what) {
    if (-not $value) {
        Write-Host "Cannot continue: $what failed. Server said: $($script:lastMsg)" -ForegroundColor Red
        exit 1
    }
}

# the "mailbox": the server appends every mail to logs/outbox.jsonl (outside production)
function MailsTo($email) {
    if (-not (Test-Path 'logs/outbox.jsonl')) { return @() }
    $lines = @(Get-Content 'logs/outbox.jsonl' | Where-Object { $_.Trim() })
    return @($lines | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.to -eq $email })
}
function LastToken($email) {
    # $mails = @(MailsTo $email)
    $mails = @(MailsTo $email)
    if ($mails.Count -eq 0) { return $null }
    if ($mails[-1].text -match 'token=([a-f0-9]+)') { return $Matches[1] }
    return $null
}

try { Invoke-WebRequest -Uri 'http://localhost:4000/health' -UseBasicParsing | Out-Null }
catch {
    Write-Host 'The API is not running. Start it with "npm run dev" in another terminal first.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path 'scripts/expire-reset-token.mjs')) {
    Write-Host 'Missing scripts/expire-reset-token.mjs - create it first, then run this again.' -ForegroundColor Red
    exit 1
}

$admin = Login 'admin@vendorshub.test'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$email = "reset$stamp@vendorshub.test"
$oldPw = 'Password123!'
$newPw = 'BrandNew789!'
$reg = Call 'POST' '/auth/register' $null @{ name = 'Reset Tester'; email = $email; password = $oldPw; role = 'CUSTOMER' }
Need ($reg.status -eq 201) 'registering the test user'
$userId = $reg.json.data.user.id

# ---- 1. forgot password: the same answer for everyone ----
$r = Call 'POST' '/auth/forgot-password' $null @{ email = 'not-an-email' }
Check 'a malformed email is rejected' $r.status 400
$unknown = Call 'POST' '/auth/forgot-password' $null @{ email = "nobody$stamp@vendorshub.test" }
Check 'an unknown email gets 200' $unknown.status 200
Check 'no mail is written for an unknown email' (@(MailsTo "nobody$stamp@vendorshub.test").Count) 0
$known = Call 'POST' '/auth/forgot-password' $null @{ email = $email }
Check 'a known email gets 200' $known.status 200
Check 'the answer is identical for known and unknown emails' $known.json.data.message $unknown.json.data.message
$mails = @(MailsTo $email)
Check 'one mail was written for the known email' $mails.Count 1
Need ($mails.Count -ge 1) 'the reset mail'
Check 'the mail contains a reset link' ($mails[-1].text -like '*/reset-password?token=*') $true
$t1 = LastToken $email
Need $t1 'the reset token'
Check 'the token is 96 hex characters (48 random bytes)' $t1.Length 96

# ---- 2. resetting ----
$r = Call 'POST' '/auth/reset-password' $null @{ token = ('a' * 40); newPassword = $newPw }
Check 'an unknown token is rejected' $r.status 400
Check 'with the generic message' $r.json.error.message 'Invalid or expired reset link'
$r = Call 'POST' '/auth/reset-password' $null @{ token = $t1; newPassword = 'short' }
Check 'a weak new password is rejected' $r.status 400

$login = Call 'POST' '/auth/login' $null @{ email = $email; password = $oldPw }
Check 'the old password works before the reset' $login.status 200
$oldRefresh = $login.json.data.refreshToken

$r = Call 'POST' '/auth/reset-password' $null @{ token = $t1; newPassword = $newPw }
Check 'the reset works' $r.status 200
$r = Call 'POST' '/auth/login' $null @{ email = $email; password = $oldPw }
Check 'the old password no longer works' $r.status 401
$r = Call 'POST' '/auth/login' $null @{ email = $email; password = $newPw }
Check 'the new password works' $r.status 200
$r = Call 'POST' '/auth/refresh' $null @{ refreshToken = $oldRefresh }
Check 'sessions from before the reset are logged out' $r.status 401
$r = Call 'POST' '/auth/reset-password' $null @{ token = $t1; newPassword = 'AnotherOne456!' }
Check 'a link works only once' $r.status 400

# ---- 3. a new request replaces the old link ----
Call 'POST' '/auth/forgot-password' $null @{ email = $email } | Out-Null
$ta = LastToken $email
Call 'POST' '/auth/forgot-password' $null @{ email = $email } | Out-Null
$tb = LastToken $email
Check 'every request creates a different token' ($ta -ne $tb) $true
$r = Call 'POST' '/auth/reset-password' $null @{ token = $ta; newPassword = 'ReplacedLink123!' }
Check 'the older link stops working' $r.status 400
$r = Call 'POST' '/auth/reset-password' $null @{ token = $tb; newPassword = 'ReplacedLink123!' }
Check 'the newest link works' $r.status 200

# ---- 4. expiry ----
Call 'POST' '/auth/forgot-password' $null @{ email = $email } | Out-Null
$tc = LastToken $email
& node --env-file=.env scripts/expire-reset-token.mjs $email | Out-Null
$r = Call 'POST' '/auth/reset-password' $null @{ token = $tc; newPassword = 'TooLate12345!' }
Check 'an expired link is rejected' $r.status 400

# ---- 5. a blocked user gets no mail ----
$r = Call 'PATCH' "/admin/users/$userId/status" $admin @{ isActive = $false; reason = 'Testing the reset flow.' }
Check 'admin blocks the user' $r.status 200
# $before = (@(MailsTo $email)).Count
$before = @(MailsTo $email).Count
$r = Call 'POST' '/auth/forgot-password' $null @{ email = $email }
Check 'a blocked user still gets the same answer' $r.status 200
# Check 'but no mail is written' (@(MailsTo $email)).Count $before
Check 'but no mail is written' @(MailsTo $email).Count $before
Call 'PATCH' "/admin/users/$userId/status" $admin @{ isActive = $true; reason = 'Test finished.' } | Out-Null

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"
Write-Host 'A test user was created. Run "node --env-file=.env prisma/seed.js" to reset the demo data.'
