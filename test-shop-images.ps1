# test-shop-images.ps1 (shop logo and banner uploads through the secure image pipeline)
$base = 'http://localhost:4000/api/v1'
$script:pass = 0
$script:fail = 0
function Check($name, $actual, $expected) {
    if ($actual -eq $expected) { Write-Host "PASS  $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "FAIL  $name (got '$actual', expected '$expected')" -ForegroundColor Red; $script:fail++ }
}
function Call($method, $path, $token, $body) {
    $p = @{ Method = $method; Uri = "$base$path"; UseBasicParsing = $true }
    if ($token) { $p.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $body) { $p.ContentType = 'application/json'; $p.Body = ($body | ConvertTo-Json -Compress) }
    try { $r = Invoke-WebRequest @p; return @{ status = [int]$r.StatusCode; json = ($r.Content | ConvertFrom-Json) } }
    catch { if ($_.Exception.Response) { return @{ status = [int]$_.Exception.Response.StatusCode } } return @{ status = 0 } }
}
function Status($url) {
    try { return [int](Invoke-WebRequest $url -UseBasicParsing).StatusCode }
    catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } return 0 }
}
function Login($email) { return (Call 'POST' '/auth/login' $null @{ email = $email; password = 'Password123!' }).json.data.accessToken }
try { Invoke-WebRequest 'http://localhost:4000/health' -UseBasicParsing | Out-Null } catch { Write-Host 'The API is not running.' -ForegroundColor Red; exit 1 }

$tmp = Join-Path $env:TEMP 'vh-shop-images'
node scripts/make-image-fixtures.mjs $tmp | Out-Null
function Put($kind, $shopId, $token, $file, $type) {
    $out = Join-Path $tmp 'resp.json'; if (Test-Path $out) { Remove-Item $out }
    $cargs = @('-s', '-o', $out, '-w', '%{http_code}', '-X', 'PUT', '-F', "image=@$(Join-Path $tmp $file);type=$type")
    if ($token) { $cargs += @('-H', "Authorization: Bearer $token") }
    $code = & curl.exe @cargs "$base/shops/$shopId/$kind"
    $json = $null; if (Test-Path $out) { try { $json = Get-Content $out -Raw | ConvertFrom-Json } catch { } }
    return @{ status = [int]$code; json = $json }
}

$owner = Login 'owner1@vendorshub.test'
$other = Login 'owner3@vendorshub.test'
$customer = Login 'customer@vendorshub.test'
$admin = Login 'admin@vendorshub.test'
$shop = (Call 'GET' '/shops/techzone-electronics' $null $null).json.data.id
function Front { return (Call 'GET' '/shops/techzone-electronics' $null $null).json.data }

# ---- 1. logo ----
$l = Put 'logo' $shop $owner 'valid.jpg' 'image/jpeg'
Check 'the owner sets a logo' $l.status 200
Check 'the logo is cropped to 512 x 512' "$($l.json.data.width)x$($l.json.data.height)" '512x512'
Check 'the storefront shows the new logo' (Front).logoUrl $l.json.data.url
Check 'the logo file is served' (Status $l.json.data.url) 200
Check 'the logo thumbnail is served' (Status $l.json.data.thumbUrl) 200
$l2 = Put 'logo' $shop $owner 'valid.png' 'image/png'
Check 'the owner replaces the logo' $l2.status 200
Check 'the old logo file is gone' (Status $l.json.data.url) 404
Check 'the old logo thumbnail is gone' (Status $l.json.data.thumbUrl) 404

# ---- 2. banner ----
$b = Put 'banner' $shop $owner 'replace.jpg' 'image/jpeg'
Check 'the owner sets a banner' $b.status 200
Check 'the banner is 1600 wide' $b.json.data.width 1600
Check 'the storefront shows the banner' (Front).bannerUrl $b.json.data.url
Check 'an admin may set a banner too' (Put 'banner' $shop $admin 'valid.jpg' 'image/jpeg').status 200
Check 'the replaced banner file is gone' (Status $b.json.data.url) 404

# ---- 3. rejected files ----
Check 'an SVG logo: 400' (Put 'logo' $shop $owner 'script.svg' 'image/svg+xml').status 400
Check 'a fake JPG banner: 400' (Put 'banner' $shop $owner 'code.jpg' 'image/jpeg').status 400
Check 'a 6 MB logo: 413' (Put 'logo' $shop $owner 'huge.jpg' 'image/jpeg').status 413
Check 'a 150 x 150 logo: 422' (Put 'logo' $shop $owner 'tiny.jpg' 'image/jpeg').status 422
Check 'a 400 x 200 banner: 422' (Put 'banner' $shop $owner 'small.jpg' 'image/jpeg').status 422

# ---- 4. access ----
Check 'logged out: 401' (Put 'logo' $shop $null 'valid.jpg' 'image/jpeg').status 401
Check 'another shop owner: 403' (Put 'logo' $shop $other 'valid.jpg' 'image/jpeg').status 403
Check 'a customer: 403' (Put 'logo' $shop $customer 'valid.jpg' 'image/jpeg').status 403
Check 'an unknown shop: 404' (Put 'logo' '00000000-0000-4000-8000-000000000000' $admin 'valid.jpg' 'image/jpeg').status 404
Check 'typed links are no longer accepted' (Call 'PATCH' "/shops/$shop" $owner @{ logoUrl = 'https://evil.example/x.png' }).status 400

# ---- 5. remove ----
$logoUrl = (Front).logoUrl
Check 'the owner removes the logo' (Call 'DELETE' "/shops/$shop/logo" $owner $null).status 200
Check 'the storefront logo is null' ($null -eq (Front).logoUrl) $true
Check 'the logo file is gone' (Status $logoUrl) 404
Check 'removing again: 404' (Call 'DELETE' "/shops/$shop/logo" $owner $null).status 404
Check 'another owner cannot remove the banner' (Call 'DELETE' "/shops/$shop/banner" $other $null).status 403
Check 'the owner removes the banner' (Call 'DELETE' "/shops/$shop/banner" $owner $null).status 200

# ---- 6. audit ----
$acts = @((Call 'GET' "/admin/audit-logs?entityType=Shop&entityId=$shop&limit=50" $admin $null).json.data | ForEach-Object { $_.action })
foreach ($a in @('shop.logo_set', 'shop.logo_removed', 'shop.banner_set', 'shop.banner_removed')) { Check "audit log has $a" ($acts -contains $a) $true }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host "Passed: $($script:pass)   Failed: $($script:fail)"