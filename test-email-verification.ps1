# test-email-verification.ps1 (register -> unverified -> blocked -> link from the outbox -> verified)
# Needs MAIL_MODE=log. New users use @mailcheck.example (NOT in AUTO_VERIFY_EMAIL_DOMAINS).
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
$script:lastMsg = ''
$script:lastCode = ''

function Check($name, $actual, $expected) {
    if ($actual -eq $expected) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red; $script:fail++ }
}
function Call($method, $path, $token, $body) {
    $script:lastMsg = ''; $script:lastCode = ''
    $p = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $p.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) { $p.ContentType = 'application/json'; $p.Body = ($body | ConvertTo-Json -Depth 6 -Compress) }
    try { $r = Invoke-WebRequest @p; return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) } }
    catch {
        if (-not $_.Exception.Response) { return @{ status = 0 } }
        $j = $null; try { $j = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
        if ($j -and $j.error) { $script:lastMsg = $j.error.message; $script:lastCode = $j.error.details.code }
        return @{ status = [int]$_.Exception.Response.StatusCode; json = $j }
    }
}
try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing | Out-Null } catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
function Register($n) {
    $email = "ev$n$stamp@mailcheck.example"
    $r = Call 'POST' '/auth/register' $null @{ name = "Verify $n"; email = $email; password = 'Password123!' }
    return @{ email = $email; token = $r.json.data.accessToken; user = $r.json.data.user; status = $r.status }
}
# the newest verification link for an address, from logs/outbox.jsonl
function LinkToken($email) {
    $mail = @(Get-Content 'logs\outbox.jsonl' | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.to -eq $email }) | Select-Object -Last 1
    if ($mail -and $mail.text -match 'token=([0-9a-f]{64})') { return $Matches[1] }
    return $null
}
function Sha256($s) {
    $b = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s))
    return ([BitConverter]::ToString($b) -replace '-', '').ToLower()
}
$dummy = '00000000-0000-4000-8000-000000000000'
$sel = (Call 'GET' '/products/galaxy-a55-5g-8-128gb' $null $null).json.data.selectedListing
$checkoutBody = @{ shops = @(@{ shopId = $sel.shop.id; deliveryMethod = 'STORE_PICKUP'; paymentMethod = 'PAY_AT_STORE' }) }

# ---- 1. a new user starts unverified ----
$u = Register 1
Check 'registration works' $u.status 201
Check 'the new user is not verified' $u.user.emailVerified $false
Check 'GET /auth/me says the same' (Call 'GET' '/auth/me' $u.token $null).json.data.emailVerified $false
Check 'the cart stays open' (Call 'POST' '/cart/items' $u.token @{ listingId = $sel.id; quantity = 1 }).status 200

# ---- 2. important actions are blocked ----
Check 'checkout: 403' (Call 'POST' '/checkout' $u.token $checkoutBody).status 403
Check 'with the code EMAIL_NOT_VERIFIED' $script:lastCode 'EMAIL_NOT_VERIFIED'
Check 'and the message' $script:lastMsg 'Please verify your email first'
Check 'a bargain offer: 403' (Call 'POST' '/bargains' $u.token @{ listingId = $dummy; offer = 1 }).status 403
Check 'a review: 403' (Call 'POST' '/reviews' $u.token @{ orderId = $dummy; type = 'SHOP_TRUST'; rating = 5 }).status 403

# ---- 3. the link ----
$tok = LinkToken $u.email
Check 'the verification email is in the outbox' ([bool]$tok) $true
Check 'a wrong token: 400' (Call 'POST' '/auth/verify-email' $null @{ token = ('0' * 64) }).status 400
Check 'with the neutral message' $script:lastMsg 'This link is invalid or has expired'
Check 'the right token verifies' (Call 'POST' '/auth/verify-email' $null @{ token = $tok }).status 200
Check 'now the user is verified' (Call 'GET' '/auth/me' $u.token $null).json.data.emailVerified $true
Check 'the same link again: 400' (Call 'POST' '/auth/verify-email' $null @{ token = $tok }).status 400
Check 'checkout now works' (Call 'POST' '/checkout' $u.token $checkoutBody).status 201
Check 'resend for a verified user says so' (Call 'POST' '/auth/resend-verification' $u.token $null).json.data.alreadyVerified $true

# ---- 4. an expired link ----
$u2 = Register 2
$tok2 = LinkToken $u2.email
"UPDATE `"EmailVerificationToken`" SET `"expiresAt`" = now() - interval '1 hour' WHERE `"tokenHash`" = '$(Sha256 $tok2)';" | docker exec -i vendors-hub-db psql -U vendors -d vendors_hub | Out-Null
Check 'an expired link: 400' (Call 'POST' '/auth/verify-email' $null @{ token = $tok2 }).status 400
Check 'the user stays unverified' (Call 'GET' '/auth/me' $u2.token $null).json.data.emailVerified $false

# ---- 5. resend: 3 emails per hour (the first one included); a new link replaces the old one ----
$u3 = Register 3
$first = LinkToken $u3.email
Check 'resend 1 (2nd email) works' (Call 'POST' '/auth/resend-verification' $u3.token $null).status 200
Check 'resend 2 (3rd email) works' (Call 'POST' '/auth/resend-verification' $u3.token $null).status 200
Check 'resend 3 (4th email): 429' (Call 'POST' '/auth/resend-verification' $u3.token $null).status 429
Check 'the first link no longer works' (Call 'POST' '/auth/verify-email' $null @{ token = $first }).status 400
Check 'the newest link works' (Call 'POST' '/auth/verify-email' $null @{ token = (LinkToken $u3.email) }).status 200
Check 'resend needs a login' (Call 'POST' '/auth/resend-verification' $null $null).status 401

# ---- 6. seed users are verified and not blocked ----
$cust = (Call 'POST' '/auth/login' $null @{ email = 'customer@vendorshub.test'; password = 'Password123!' }).json.data
Check 'a seed user is verified' $cust.user.emailVerified $true
$b = Call 'POST' '/bargains' $cust.accessToken @{ listingId = $dummy; offer = 1 }
Check 'a seed user is not blocked (404 for the unknown listing, not 403)' $b.status 404

Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"